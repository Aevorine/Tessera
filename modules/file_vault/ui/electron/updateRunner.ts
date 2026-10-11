/**
 * 独立的更新安装器进程，由主应用退出前启动：运行中的 EXE 被 Windows 锁住不能替换自己。
 * 不能从 resourcesPath 直接跑：portable 外层启动器会在主进程退出后清掉临时 resources（连日志目录）
 * ，
 * 所以主进程先把 runner 复制到 %LOCALAPPDATA%\Tessera\updates\runner-<digest>\
 * 并校验后再从那里启动。
 * 流程：等主进程退出 → 再验下载文件 → 当前 EXE 保留为 `.previous-<版本>` → 原子替换 →
 * 启动新版本（带 `--post-update-health <事务id>`）→ 等健康回执；任何一步失败或超时都恢复旧 EXE
 * 并重启。
 * 成功必须由新版本自己写回执确认，进程活着不算（可能卡在白屏）。
 * 用法：node updateRunner.js --transaction <path-to-transaction.json>
 */

import { execFile, spawn, type ExecFileException } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface UpdateTransaction {
  /** 要被替换的那个稳定外层 EXE 的绝对路径（PORTABLE_EXECUTABLE_FILE，不是 execPath） */
  targetExe: string
  /** 已下载、验过哈希、也验过 Authenticode 签名的新 EXE */
  downloadedExe: string
  /** 期望的 SHA-256，runner 在替换前会再算一遍 */
  expectedSha256: string
  /** 锁定的代码签名发布者（证书 CN）。runner 在替换前会再验一次签名。 */
  expectedPublisher: string
  /** 自签名模式下锁定的证书公钥 SHA-256（hex）；CA 模式为空串。 */
  expectedPublicKeySha256: string
  /** 当前版本，用于给保留的旧 EXE 命名 */
  currentVersion: string
  newVersion: string
  /** 主进程 PID，runner 会先等它退出 */
  mainPid: number
  /** 新版本写健康回执的位置 */
  healthReceiptPath: string
  /** 事务日志 */
  logPath: string
}

/** 等主进程退出的上限。正常退出是秒级；给到 60 秒容纳"退出时正在落盘一个大文件"
 *  这类情况。超时就放弃本次更新（不强杀主进程——那可能打断一次正在进行的写入）。 */
const WAIT_EXIT_TIMEOUT_MS = 60_000
/** 等新版本写健康回执的上限。冷启动要起 Electron + 冻结的 Python 后端，慢机器上
 *  可能要十几秒；给到 120 秒。超时按失败处理并回滚。 */
const HEALTH_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 500

async function main(): Promise<void> {
  const transactionPath = readTransactionPathFromArgv(process.argv)
  if (!transactionPath) {
    process.stderr.write('updateRunner: --transaction <path> is required\n')
    process.exit(2)
    return
  }
  const transaction = JSON.parse(await fsp.readFile(transactionPath, 'utf-8')) as UpdateTransaction
  const log = (message: string) => appendLog(transaction.logPath, message)

  await log(`runner started for ${transaction.currentVersion} -> ${transaction.newVersion}`)

  if (!(await waitForProcessExit(transaction.mainPid, WAIT_EXIT_TIMEOUT_MS))) {
    await log('main process did not exit in time; aborting without touching anything')
    process.exit(1)
    return
  }
  await log('main process exited')

  // 再校验一次：检查之后文件在磁盘上躺了一会儿，可能被磁盘错误、杀软「修复」或人为替换；替换 EXE
  // 不可逆。
  const actual = await sha256File(transaction.downloadedExe)
  if (actual !== transaction.expectedSha256) {
    await log(`downloaded file hash changed on disk (${actual}); aborting`)
    process.exit(1)
    return
  }
  await log('downloaded file hash re-verified')

  // 哈希与期望哈希（事务 JSON）都在用户可写的 %LOCALAPPDATA% 下，能改一个就能改另一个，
  // 对本机写权限攻击者形同虚设。
  // 再验签名把门槛抬到必须由我们的证书签出（拿不到私钥做不到）；runner 自身同样可写，不是万能，
  // 但足以挡住改一行 JSON。
  const publisher = (transaction.expectedPublisher ?? '').trim()
  if (publisher.length === 0) {
    await log('transaction carries no expected publisher; aborting')
    process.exit(1)
    return
  }
  const pinnedKey = (transaction.expectedPublicKeySha256 ?? '').trim().toLowerCase()
  const signature = await inspectAuthenticode(transaction.downloadedExe)
  const reason = signatureRejectionReason(signature, publisher, pinnedKey)
  if (reason) {
    await log(`downloaded file failed signature re-verification (${reason}); aborting`)
    process.exit(1)
    return
  }
  await log(`downloaded file signature re-verified (publisher="${signature.simpleName ?? ''}")`)

  const previousExe = `${transaction.targetExe}.previous-${transaction.currentVersion}`
  try {
    // 版本化保留旧 EXE 而不是删掉：回滚需要它，而且用户手动退回旧版也需要它。
    // 保留而不是覆盖同名备份，是为了让多次更新之后仍能看出每个备份是哪个版本。
    await fsp.rm(previousExe, { force: true })
    await fsp.rename(transaction.targetExe, previousExe)
    await log(`current exe preserved as ${path.basename(previousExe)}`)
  } catch (error) {
    await log(`failed to preserve the current exe: ${String(error)}; aborting`)
    process.exit(1)
    return
  }

  try {
    // 同卷 rename 是原子的；下载目录是目标 EXE 目录下的子目录（updateInstaller 的 stagingDirFor），
    // 同卷由结构保证。
    const stagingDir = path.dirname(transaction.downloadedExe)
    await fsp.rename(transaction.downloadedExe, transaction.targetExe)
    await log('new exe installed')
    // 暂存目录空了就收掉，别在用户的文件夹里留一个空目录。rmdir 只删空目录，
    // 里面万一还有东西（上一次失败留下的诊断文件）就会失败——那正是我们要的。
    await fsp.rmdir(stagingDir).catch(() => {})
  } catch (error) {
    await log(`failed to install the new exe: ${String(error)}; rolling back`)
    await rollback(transaction, previousExe, log)
    process.exit(1)
    return
  }

  await fsp.rm(transaction.healthReceiptPath, { force: true })
  const started = launch(transaction.targetExe, ['--post-update-health', transaction.logPath])
  if (!started) {
    await log('new exe failed to launch; rolling back')
    await rollback(transaction, previousExe, log)
    process.exit(1)
    return
  }
  await log('new exe launched, waiting for the health receipt')

  if (await waitForFile(transaction.healthReceiptPath, HEALTH_TIMEOUT_MS)) {
    await log('health receipt received; update complete')
    process.exit(0)
    return
  }

  // 没等到回执。可能是新版本崩了，也可能是它起来了但卡在某个初始化步骤上——
  // 后一种情况下进程还活着，所以**不能**用"进程是否存活"来判断成功。
  await log('health receipt timed out; rolling back')
  await rollback(transaction, previousExe, log)
  process.exit(1)
}

async function rollback(transaction: UpdateTransaction, previousExe: string, log: (m: string) => Promise<void>) {
  try {
    // 把失败的新 EXE 挪到一边而不是直接删——它是诊断"为什么这个版本起不来"的
    // 唯一证据，删了就查不了了。
    const failed = `${transaction.targetExe}.failed-${transaction.newVersion}`
    await fsp.rm(failed, { force: true })
    if (fs.existsSync(transaction.targetExe)) {
      await fsp.rename(transaction.targetExe, failed)
    }
    await fsp.rename(previousExe, transaction.targetExe)
    await log('rolled back to the previous exe')
    launch(transaction.targetExe, [])
    await log('previous exe relaunched')
  } catch (error) {
    // 回滚都失败了——这是最坏的情况。日志里留下完整路径，用户可以手工把
    // `.previous-<版本>` 改回原名。
    await log(
      `ROLLBACK FAILED: ${String(error)}. Manually rename "${previousExe}" back to "${transaction.targetExe}".`,
    )
  }
}

/**
 * 启动进程并彻底脱离本进程：detached + unref，stdio 全 ignore，否则 runner
 * 退出后子进程随之消失或写入坏管道崩溃。
 */
function launch(exe: string, args: string[]): boolean {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return !isProcessAlive(pid)
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 不发送任何信号，只做"这个 pid 存在且我有权限操作它"的探测。
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但没权限——仍然算活着。只有 ESRCH（查无此进程）才是退出了。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/**
 * Authenticode 探测的独立副本（与 electron/authenticode.ts 逻辑必须一致，改一处要改两处）。
 * runner 必须编译成自包含的 updateRunner.js：与 main.js 共享 import 会被 rollup 抽成共享 chunk，
 * 而 extraResources 只带走 updateRunner.js，runner 会在主进程已退出时 require 不存在的 chunk
 * 而崩溃。
 */
function signatureRejectionReason(
  signature: { status: string; simpleName: string | null; publicKeySha256: string | null },
  expectedPublisher: string,
  pinnedKey: string,
): string | null {
  // 跟 updateVersion.ts 的 assertTrustedSigner 保持同样的判据（同样的重复理由，
  // 见下面 inspectAuthenticode 的说明）。任何一边改了，另一边必须跟着改。
  const fatal = ['NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible']
  if (fatal.includes(signature.status) || signature.status.trim().length === 0) {
    return `status=${signature.status || 'unknown'}`
  }
  const publisher = (signature.simpleName ?? '').trim()
  if (publisher.toLowerCase() !== expectedPublisher.toLowerCase()) {
    return `publisher="${publisher}"`
  }
  if (pinnedKey.length > 0) {
    // 自签名模式：链不可信是预期的，公钥说了算。
    if (!['Valid', 'UnknownError', 'NotTrusted'].includes(signature.status)) {
      return `status=${signature.status}`
    }
    if ((signature.publicKeySha256 ?? '').trim().toLowerCase() !== pinnedKey) {
      return 'public key does not match the pinned key'
    }
    return null
  }
  if (signature.status !== 'Valid') return `status=${signature.status}`
  return null
}

async function inspectAuthenticode(
  filePath: string,
): Promise<{ status: string; simpleName: string | null; publicKeySha256: string | null }> {
  if (process.platform !== 'win32') return { status: 'UnsupportedPlatform', simpleName: null, publicKeySha256: null }

  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // 路径通过环境变量传进去，绝不拼进命令行——待验文件按定义就是不可信输入。
  const script = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('IDEAL1_AUTHENTICODE_TARGET')
if ([string]::IsNullOrEmpty($target)) { throw 'target path is empty' }
$sig = Get-AuthenticodeSignature -LiteralPath $target
$cert = $sig.SignerCertificate
$simpleName = $null
$publicKeySha256 = $null
if ($cert) {
  $simpleName = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $publicKeySha256 = -join ($sha.ComputeHash($cert.GetPublicKey()) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}
[pscustomobject]@{ status = [string]$sig.Status; simpleName = $simpleName; publicKeySha256 = $publicKeySha256 } | ConvertTo-Json -Compress
`

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-Command', script],
        {
          timeout: 60_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          encoding: 'utf-8' as const,
          env: {
            IDEAL1_AUTHENTICODE_TARGET: filePath,
            SystemRoot: systemRoot,
            windir: systemRoot,
            PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
          } as unknown as NodeJS.ProcessEnv,
        },
        (error: ExecFileException | null, out: string) => (error ? reject(error) : resolve(out)),
      )
    })
    const parsed = JSON.parse(stdout.trim()) as { status?: unknown; simpleName?: unknown; publicKeySha256?: unknown }
    return {
      status: typeof parsed.status === 'string' ? parsed.status : 'VerifyUnavailable',
      simpleName: typeof parsed.simpleName === 'string' ? parsed.simpleName : null,
      publicKeySha256: typeof parsed.publicKeySha256 === 'string' ? parsed.publicKeySha256 : null,
    }
  } catch {
    // 验不了就是验不过。这里绝不能 return 一个"看起来通过"的结果——整个 runner
    // 的存在意义就是在没人看着的时候替换一个可执行文件。
    return { status: 'VerifyUnavailable', simpleName: null, publicKeySha256: null }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

async function appendLog(logPath: string, message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    await fsp.mkdir(path.dirname(logPath), { recursive: true })
    await fsp.appendFile(logPath, line, 'utf-8')
  } catch {
    // 日志写不了也要继续装——日志是诊断手段，不是流程的一部分
  }
  process.stdout.write(line)
}

function readTransactionPathFromArgv(argv: string[]): string | null {
  const index = argv.indexOf('--transaction')
  if (index === -1 || index + 1 >= argv.length) return null
  return argv[index + 1]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 作为脚本直接跑时才执行 main；被 import 时（单元测试）不执行。
if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`updateRunner crashed: ${String(error)}\n`)
    process.exit(1)
  })
}
