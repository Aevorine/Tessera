/**
 * Authenticode 验签：新的信任根，取代外挂的 update-manifest.json/.sig 签名清单。
 *
 * Authenticode 把签名写进 PE 自身（IMAGE_DIRECTORY_ENTRY_SECURITY），分发物与签名是同一个文件。
 * `Get-AuthenticodeSignature`（WinVerifyTrust）负责解析 PE、重算摘要、验证书链与吊销；
 * 我们再加一层：签名者必须是锁定的发布者。不能省，因为 "Valid" 只表示被某个受信 CA 的证书签过，
 * 任何恶意程序用任一证书签名都是 "Valid"。
 *
 * 自签名模式：Authenticode 格式不关心证书出处，CA 证书买到的只是"Windows 默认信任"，
 * 而更新校验只需回答"签名者是不是我"，公钥指纹钉扎比 CN 比对更强（攻击者得拿到私钥）。
 * 因此 WinVerifyTrust 报"根不受信"是预期结果；买不到的只有 SmartScreen 信誉，仅影响首次安装体验。
 *
 * 用 PowerShell 而非 N-API 原生模块（要随 Electron ABI 重编译，对一年跑几次的校验不划算）。
 * 三点必须做对：
 *   1. 绝对路径调用 System32 下的 powershell.exe，不走可被劫持的 PATH
 *   2. 待验路径经环境变量传入，绝不拼进命令行（拼接即注入）
 *   3. 输出有大小上限、执行有超时，超时即杀
 */

import { execFile, type ExecFileException } from 'node:child_process'
import path from 'node:path'

import { UpdateError, assertTrustedSigner, type AuthenticodeInfo, type SignerPolicy } from './updateVersion'

/** 验签超时。正常几百毫秒；给到 60 秒容纳「首次验证要联网查 CRL/OCSP」和
 *  「杀毒软件正在扫这个 145MB 的文件」这两种慢法。 */
const VERIFY_TIMEOUT_MS = 60_000
/** 子进程输出上限。正常输出是一行几百字节的 JSON。 */
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 待验文件路径经此环境变量传入脚本，绝不能拼进 `-Command` 字符串：
 * 文件名带 `"; <任意 PowerShell>` 的下载物就能拿到代码执行，而本函数验证的正是不可信下载物。
 */
const TARGET_ENV_VAR = 'IDEAL1_AUTHENTICODE_TARGET'

/**
 * PowerShell 侧的探测脚本。
 * `GetNameInfo(SimpleName)` 直接给 CN，避免解析 `CN="Foo, Inc.", O=...` 这类带引号逗号的 DN 而使发布者比对失效。
 * `GetPublicKey()` 的原始 DER 经 SHA-256 是自签名模式的信任锚点；不用 `Thumbprint`（整证书 SHA-1，
 * 选择前缀碰撞已被做出），且钉公钥允许证书过期后用同一密钥对重签（见 updateVersion.ts 的 assertTrustedSigner）。
 * 单独报出时间戳副署（TimeStamperCertificate）：CA 模式下没有它，证书一到期此前签的包全部失效。
 */
const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('${TARGET_ENV_VAR}')
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
[pscustomobject]@{
  status = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  subject = if ($cert) { [string]$cert.Subject } else { $null }
  issuer = if ($cert) { [string]$cert.Issuer } else { $null }
  simpleName = $simpleName
  thumbprint = if ($cert) { [string]$cert.Thumbprint } else { $null }
  publicKeySha256 = $publicKeySha256
  timestamped = [bool]$sig.TimeStamperCertificate
} | ConvertTo-Json -Compress
`

/** 解析出 System32 下 powershell.exe 的绝对路径。不走 PATH 查找。 */
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 读取文件的 Authenticode 签名信息，只报告不判断；信任判定留给 verifySigner()，两者可分别测试。 */
export async function inspectAuthenticode(filePath: string): Promise<AuthenticodeInfo> {
  if (process.platform !== 'win32') {
    throw new UpdateError('Authenticode verification is only available on Windows', 'unsupported_platform')
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-Command', PROBE_SCRIPT],
      {
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf-8' as const,
        // 只往下传这次验签需要的东西。继承整个环境没有必要，也让「路径靠环境变量
        // 传递」这件事在阅读时一目了然。
        env: {
          [TARGET_ENV_VAR]: filePath,
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          windir: process.env.windir ?? 'C:\\Windows',
          PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
          // electron-env.d.ts 把 APP_ROOT / VITE_PUBLIC 声明成了 ProcessEnv 的
          // 必填字段（渲染进程那边确实总有），但这里刻意只传三个变量，所以要断言。
        } as unknown as NodeJS.ProcessEnv,
      },
      (error: ExecFileException | null, out: string, err: string) => {
        if (error) {
          const detail = (err || '').trim() || error.message
          reject(new UpdateError(`Authenticode verification could not run: ${detail}`, 'verify_unavailable'))
          return
        }
        resolve(out)
      },
    )
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new UpdateError('Authenticode verification returned unreadable output', 'verify_unavailable')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new UpdateError('Authenticode verification returned a non-object', 'verify_unavailable')
  }
  const record = parsed as Record<string, unknown>
  return {
    status: typeof record.status === 'string' ? record.status : '',
    statusMessage: typeof record.statusMessage === 'string' ? record.statusMessage : '',
    subject: typeof record.subject === 'string' ? record.subject : null,
    issuer: typeof record.issuer === 'string' ? record.issuer : null,
    simpleName: typeof record.simpleName === 'string' ? record.simpleName : null,
    thumbprint: typeof record.thumbprint === 'string' ? record.thumbprint : null,
    publicKeySha256: typeof record.publicKeySha256 === 'string' ? record.publicKeySha256 : null,
    timestamped: record.timestamped === true,
  }
}

/** 采集 + 判定的组合。正常调用方用这个。 */
export async function verifySigner(filePath: string, policy: SignerPolicy): Promise<AuthenticodeInfo> {
  const info = await inspectAuthenticode(filePath)
  assertTrustedSigner(info, policy)
  return info
}
