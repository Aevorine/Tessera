import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { ProgressEvent, VaultMethodName, VaultMethods, VaultPushEvent } from '../src/shared/ipcTypes'
import { markStartup } from './startupTiming'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  onProgress?: (p: ProgressEvent) => void
  /** 空闲超时的计时器句柄；见 call() 里对"静默超时"的说明。 */
  timer?: ReturnType<typeof setTimeout>
  /** 收到 progress 时重新计时。没有超时预算的请求上是 undefined。 */
  rearmTimer?: () => void
}

/**
 * 崩溃重启的指数退避 + 上限次数。
 * 原先固定 500ms 无限重试：必然崩溃的后端会无限刷日志、堆叠错误提示，
 * 还把「起不来」伪装成「偶尔抖一下」；
 * 现在偶发崩溃能快速恢复，必然崩溃则撞上限后停下并明确提示。
 */
const RESTART_DELAY_BASE_MS = 500
const RESTART_DELAY_MAX_MS = 30_000
/** 连续崩几次之后放弃自动重启。5 次配上指数退避 ≈ 15 秒，够覆盖偶发抖动。 */
const RESTART_MAX_ATTEMPTS = 5
/** 起来之后活过这么久，就认为上一次崩溃是偶发的，把计数清零。
 *  没有这一条的话，一个运行三个月、期间偶尔崩过 5 次的进程会突然拒绝重启。 */
const RESTART_HEALTHY_UPTIME_MS = 60_000

/**
 * 后端沉默多久判调用失败。这是空闲超时而非总耗时上限：每条 progress 都会重新计时。
 * 20 秒：后端冷启动约 0.6 秒、最慢同步 RPC 约 0.4 秒，余量 30 倍以上，又短到用户不至失去耐心。
 */
const DEFAULT_SILENT_TIMEOUT_MS = 20_000

/**
 * 本来就该长时间沉默的操作单独放宽（等指纹传感器、邮件服务商超时、跨境测速等不由我们控制的事）。
 * 不在此表的 RPC 一律受默认预算约束；要放行必须在这里加一行并写明理由。
 */
const SILENT_TIMEOUT_OVERRIDES: Record<string, number> = {
  // 等用户去碰传感器/看摄像头。Windows Hello 自己的超时就有一分钟量级。
  unlock_fingerprint: 180_000,
  setup_verify_fingerprint: 180_000,
  // SMTP 最坏要走两轮连接超时。
  unlock_email_start: 120_000,
  send_test_email: 120_000,
  // 一次完整测速本身就要跑十几到几十秒，中途只有阶段性进度。
  network_speedtest_run: 180_000,

  // 加解密这一组只是安全网：它们全程按字节报进度（上限 0.2 秒一条，见 container.py
  // _PROGRESS_INTERVAL_S），
  // 放宽到 90 秒只防磁盘被别的程序拖住时偶发长时间不出声，把正常加解密误判成后端死了。
  encrypt_file: 90_000,
  decrypt_file: 90_000,
  decrypt_folder_preview: 90_000,
  decrypt_folder_confirm: 90_000,
  folder_container_reencrypt: 90_000,
  folder_container_diff: 90_000,
  // 口令分享：批次里第一个调用要先跑一次 Argon2id（默认 256 MiB，约 0.35 s，
  // 慢机器上几秒），这段时间不出进度；之后与普通加解密一样按块报进度。
  share_encrypt_file: 90_000,
  share_decrypt_file: 90_000,
  share_decrypt_folder_preview: 90_000,
  share_decrypt_folder_confirm: 90_000,
  // 读一批头部：头部里的 KDF 参数上限是 2 GiB × 16 轮，恶意或来自未来版本的
  // 容器可能派生得很久；给足预算，别把"还在算"误判成"后端死了"。
  share_read_headers: 120_000,
  // 只校验：整份读一遍，按块报进度。
  verify_container: 90_000,

  // 清理套件。这一组曾不在表里，是「这次扫描没跑完」的根因：任一类沉默超过 20 秒，桥接层就先判负。
  // 要三处一起改：① 放宽这张表；② 后端扫描期间发心跳（pcclean/service.py _Heartbeat，2 秒一次，
  // 真正的修法）；
  // ③ 失败时界面显示哪一类及原因（failures[]）。
  // 预算按最坏情况：体检慢项 schtasks /Query（5~9 秒）、重复文件全盘哈希、回收站 API 清理几万文件。
  pcclean_health_check: 180_000,
  pcclean_scan: 300_000,
  pcclean_execute: 300_000,
  pcclean_preview: 120_000,
  pcclean_uninstall: 300_000,
  pcclean_undo: 180_000,
  // 工具箱里 `sfcVerify` 单条就要跑几分钟，碎片整理更久。
  pcclean_run_tool: 300_000,
  pcclean_optimize_volume: 1_800_000,
  // 内存待命列表清理要走提权助手，中间隔着一个 UAC 弹窗，
  // 那是**人的反应时间**，跟机器快慢无关。
  pcclean_memory_purge_standby: 300_000,
}

/**
 * 持有 backend_server.py 子进程的整个生命周期，经 stdin/stdout 说 NDJSON 请求/应答/进度协议。
 * 一个 PythonBridge = 一个 Python 进程 = 一次会话的进程内状态（已解锁 IMK、IdentityStore、邮件
 * OTP、剪贴板监听）。
 * 崩溃（非 dispose() 导致的退出）时自动重拉新进程，并经 onRestart 通知 main.ts 让渲染端重新登录；
 * 历史数据在加密 SQLite（WAL）里不会损坏，只丢尚未落盘的本次会话内容。
 */
export class PythonBridge {
  private proc!: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private onEvent: ((payload: VaultPushEvent) => void) | null = null
  private onRestart: (() => void) | null = null
  private onFatal: ((detail: string) => void) | null = null
  private onSpawn: ((pid: number | undefined) => void) | null = null
  private disposed = false
  /** 连续崩溃次数。活过 RESTART_HEALTHY_UPTIME_MS 就清零。 */
  private crashCount = 0
  /** 本次进程是什么时候起来的，用来判断"这次算不算连续崩溃"。 */
  private spawnedAt = 0
  /** 后端最后吐的那段 stderr。放弃重启时要把它带给用户——
   *  真正的原因（缺依赖、路径没权限）只写在这里面。 */
  private lastStderr = ''
  /** 这次退出是我们自己为了「锁定金库」而杀的，不是崩溃。 */
  private lockRestarting = false

  // command 是系统 python（开发）或冻结的 file_vault_backend.exe（打包）；leadingArgs 承载差异：
  // 开发要传 `-X utf8 <脚本路径>`，冻结产物不能传，否则会被当成后端命令行参数导致 argparse 报错。
  constructor(
    private readonly command: string,
    private readonly leadingArgs: string[] = [],
    private readonly args: string[] = [],
  ) {
    this.spawnProcess()
  }

  private spawnProcess(): void {
    this.spawnedAt = Date.now()
    this.proc = spawn(this.command, [...this.leadingArgs, ...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    this.onSpawn?.(this.proc.pid)

    const rl = readline.createInterface({ input: this.proc.stdout })
    rl.on('line', (line) => this.handleLine(line))

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      console.error('[python]', text)
      // 只留最后 2000 字符：traceback 的**结尾**才是根因那一行，
      // 而开头是一堆调用栈。截断留尾不留头。
      this.lastStderr = (this.lastStderr + text).slice(-2000)
    })

    this.proc.on('exit', (code) => {
      const err = new Error(`Python backend exited unexpectedly (code ${code})`)
      for (const entry of this.pending.values()) {
        // 进程都没了，超时计时器留着只会在几十秒后再"失败"一次同一个请求
        // （那时它早已被 reject，只剩一个空转的定时器把进程拖着不退出）。
        clearTimeout(entry.timer)
        entry.reject(err)
      }
      this.pending.clear()

      if (this.disposed) return // intentional shutdown, e.g. app quitting - nothing to recover

      // 「锁定金库」是我们自己杀的：不计入崩溃次数、不退避、不打崩溃日志，且必须立刻重起新进程。
      // 主密钥只活在旧进程内存里，换进程是最彻底的抹除（Python bytes 释放后缓冲区会留副本，置 None
      // 管不到）。
      if (this.lockRestarting) {
        this.lockRestarting = false
        this.crashCount = 0
        this.spawnProcess()
        this.onRestart?.()
        return
      }

      // 活得够久就当上一轮已经恢复了，重新从第 1 次算起。
      if (Date.now() - this.spawnedAt >= RESTART_HEALTHY_UPTIME_MS) this.crashCount = 0
      this.crashCount += 1

      if (this.crashCount > RESTART_MAX_ATTEMPTS) {
        // 停下来并把真实原因带出去：stderr 里的 ModuleNotFoundError 等必须送到界面，
        // 否则用户只看到「后端进程意外重启」，不知道发生了什么。
        console.error(
          `[python] backend crashed ${this.crashCount - 1} times in a row; giving up. Last stderr:\n${this.lastStderr}`,
        )
        this.onFatal?.(this.lastStderr.trim() || `exit code ${code}`)
        return
      }

      const delay = Math.min(RESTART_DELAY_BASE_MS * 2 ** (this.crashCount - 1), RESTART_DELAY_MAX_MS)
      console.error(
        `[python] backend crashed (code ${code}), attempt ${this.crashCount}/${RESTART_MAX_ATTEMPTS}, restarting in ${delay}ms`,
      )
      setTimeout(() => {
        if (this.disposed) return
        this.spawnProcess()
        this.onRestart?.()
      }, delay)
    })
  }

  /** 崩溃后后端被重拉时触发；main.ts 据此让渲染端回登录页（新进程没有已解锁的 IMK）。 */
  setRestartListener(listener: () => void): void {
    this.onRestart = listener
  }

  /** 连续崩溃超过上限、放弃自动重启时触发，带上后端最后那段 stderr。
   *  跟 setRestartListener 分开："崩了但还会自己起来"和"起不来了，别等了"
   *  对用户是两件事，前者是提示，后者要给出能照着做的下一步。 */
  setFatalListener(listener: (detail: string) => void): void {
    this.onFatal = listener
  }

  /** 每次起进程（含崩溃重拉、锁定重起）都报一次 pid；登记时把当前这个也补报。 */
  setSpawnListener(listener: (pid: number | undefined) => void): void {
    this.onSpawn = listener
    listener(this.proc.pid)
  }

  /** Registers the (single) listener for unsolicited backend push events -
   * see VaultPushEvent. Only one caller (main.ts, forwarding to the
   * renderer) needs this, so it's a plain setter, not an EventEmitter. */
  setEventListener(listener: (payload: VaultPushEvent) => void): void {
    this.onEvent = listener
  }

  call<M extends VaultMethodName>(
    method: M,
    params: VaultMethods[M]['params'],
    onProgress?: (p: ProgressEvent) => void,
  ): Promise<VaultMethods[M]['result']> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // 静默超时：后端沉默超过预算就判这次调用失败，否则后端卡死会让调用方永远停在 await 上。
      // 是空闲计时而非总耗时（每条 progress 重新计时）；本来就该长时间沉默的操作在
      // SILENT_TIMEOUT_OVERRIDES 里放宽。
      const budget = SILENT_TIMEOUT_OVERRIDES[method as string] ?? DEFAULT_SILENT_TIMEOUT_MS
      const entry: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress,
      }
      if (budget !== Infinity) {
        const arm = () => {
          clearTimeout(entry.timer)
          entry.timer = setTimeout(() => {
            // 只有还挂在 pending 里才算超时——handleLine 删除条目和这里触发
            // 之间存在竞态，删过了说明答案其实到了。
            if (!this.pending.has(id)) return
            this.pending.delete(id)
            reject(new Error('backend.no_response'))
          }, budget)
        }
        entry.rearmTimer = arm
        arm()
      }
      this.pending.set(id, entry)
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: {
      id?: number
      result?: unknown
      error?: { message: string }
      progress?: ProgressEvent
      event?: string
    }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      console.error('[python] failed to parse line:', trimmed)
      return
    }

    if (msg.event) {
      this.onEvent?.(msg as unknown as VaultPushEvent)
      return
    }

    const entry = this.pending.get(msg.id!)
    if (!entry) return

    if (msg.progress) {
      // 有动静就重新计时——静默超时盯的是"没声音"，不是"没跑完"。
      entry.rearmTimer?.()
      entry.onProgress?.(msg.progress)
      return // not a final message - keep the request pending
    }

    clearTimeout(entry.timer)
    this.pending.delete(msg.id!)
    // 后端第一次应答才是界面真正可用的时刻，不记在 spawn 成功时（之后还要 import、连库、初始化加密）；
    // 失败应答也算。
    markStartup('backendReady')
    if (msg.error) {
      entry.reject(new Error(msg.error.message))
    } else {
      entry.resolve(msg.result)
    }
  }

  /**
   * 锁定金库：杀掉当前后端进程并立刻重起干净的。
   * 不让后端把密钥置空：Python 置 None 只是不可达，已释放缓冲区里仍留着字节且无法确认清净；新进程由
   * OS 保证旧页面不再属于我们。
   */
  restartForLock(): void {
    if (this.disposed) return
    this.lockRestarting = true
    this.proc.kill()
  }

  dispose(): void {
    this.disposed = true
    this.proc.kill()
  }
}
