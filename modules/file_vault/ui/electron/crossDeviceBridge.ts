import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

const RESTART_DELAY_MS = 800
/** stdout 单行可能带着一张 base64 的截图，默认的 readline 行长度足够，
 *  但 stdin 那侧我们自己写，所以这里只需要防守读的一侧。 */
const MAX_LINE = 64 * 1024 * 1024

export interface CrossDeviceEvent {
  event: string
  data?: Record<string, unknown>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

/**
 * 拥有 tessera-crossdevice 守护进程，用 NDJSON 经 stdin/stdout 通信。
 *
 * 与 PythonBridge 模式相同但故意不共用代码，失败语义不同：Python 后端崩了意味着已解锁的 IMK 丢失，
 * 必须踢回登录页；跨设备守护进程崩了只是暂时连不上，重启后已配对设备和未传完的分块会自行恢复。
 * 生命周期跟随主窗口而非登录状态；守护进程不持有金库密钥，设备身份是独立的长期密钥（见 crossdevice/core/identity）。
 */
export class CrossDeviceBridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private onEvent: ((e: CrossDeviceEvent) => void) | null = null
  private disposed = false
  private lastError: string | null = null
  private ready = false

  constructor(
    private readonly command: string,
    private readonly dataDir: string,
    private readonly deviceName: string,
    private readonly listenAddr = ':39421',
  ) {}

  start(): void {
    if (this.disposed || this.proc) return
    this.spawnProcess()
  }

  private spawnProcess(): void {
    try {
      this.proc = spawn(
        this.command,
        ['-data', this.dataDir, '-name', this.deviceName, '-listen', this.listenAddr],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (err) {
      // 守护进程起不来不该拖垮整个应用——跨设备只是众多面板中的一个。
      // 记下原因，UI 查 status 时会看到 available:false 和这条原因。
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error('[crossdevice] 启动失败:', this.lastError)
      return
    }

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => this.handleLine(line))

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error('[crossdevice]', text)
    })

    this.proc.on('exit', (code) => {
      this.ready = false
      const err = new Error(`跨设备服务已退出（code ${code}）`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.proc = null

      if (this.disposed) return
      this.lastError = `服务意外退出（code ${code}），正在重启`
      this.onEvent?.({ event: 'daemon_restarting', data: { code } })
      setTimeout(() => {
        if (this.disposed) return
        this.spawnProcess()
      }, RESTART_DELAY_MS)
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length > MAX_LINE) return

    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: Record<string, unknown> }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      console.error('[crossdevice] 无法解析的输出:', trimmed.slice(0, 200))
      return
    }

    if (msg.event) {
      if (msg.event === 'ready') {
        this.ready = true
        this.lastError = null
      }
      this.onEvent?.({ event: msg.event, data: msg.data })
      return
    }

    if (typeof msg.id !== 'number') return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new Error(msg.error || '跨设备服务返回了未知错误'))
  }

  setEventListener(listener: (e: CrossDeviceEvent) => void): void {
    this.onEvent = listener
  }

  isAvailable(): boolean {
    return this.ready && this.proc !== null
  }

  getLastError(): string | null {
    return this.lastError
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc) {
      return Promise.reject(new Error(this.lastError ?? '跨设备服务未运行'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
      // 配对确认这类方法要等真人点按钮，超时必须给够；但也不能永不超时，
      // 否则守护进程被 kill -9 时这些 Promise 会永远挂着。
      const timeoutMs = method === 'pair_with_code' ? 120_000 : 60_000
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`))
      }, timeoutMs)
    })
  }

  dispose(): void {
    this.disposed = true
    if (!this.proc) return
    // 先礼后兵：让它自己退，收尾时能把传输进度刷盘。
    try {
      this.proc.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n')
    } catch {
      /* 管道可能已经断了，下面直接 kill */
    }
    const proc = this.proc
    setTimeout(() => {
      if (!proc.killed) proc.kill()
    }, 500)
    this.proc = null
  }
}
