/**
 * 一键构建独立 EXE：冻结两个 Python 运行时 → 签内层可执行文件 → 构建并签外层 portable EXE。
 * 必须在 Windows x64 上跑（PyInstaller 非交叉编译器），用法：npm run build:standalone
 * 签名全自动：本机无证书时自动造自签名证书（20 年）、备份私钥、把公钥指纹写进 signer-policy.json；
 * 之后每次构建核对待用证书与 signer-policy.json 钉的公钥，
 * 不一致即中断（否则换机/重建证书后包能发布，但所有客户端拒绝）。
 * 环境变量：IDEAL1_SIGN_SUBJECT 证书 CN（改了等于换信任根）；IDEAL1_SKIP_SIGNING=1 跳过签名；
 * IDEAL1_SIGNTOOL signtool.exe 路径（默认找 PATH 再找 electron-builder 工具集缓存，无需装 Windows
 * SDK）；
 * IDEAL1_TIMESTAMP_URL RFC 3161 时间戳服务器，默认 DigiCert。
 * CI 必须设 IDEAL1_SKIP_SIGNING=1，否则会自动造一张没人钉过的证书，
 * 签出所有客户端拒绝却看似已签的包。
 * 私钥不得进入本脚本或 CI secrets：signtool 经 Windows 证书存储按主体名取用，脚本只拿到名字。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(uiDir, '..', '..', '..')
const policyPath = path.join(uiDir, 'signer-policy.json')

const skipSigning = (process.env.IDEAL1_SKIP_SIGNING ?? '').trim() === '1'
/**
 * 找可用的 signtool.exe：IDEAL1_SIGNTOOL → PATH → electron-builder 工具集缓存
 * （其 windows-kits bundle 本就为签外层 exe 下载，见 electron-builder.json5 toolsets.winCodeSign，
 * 免装几 GB 的 Windows SDK）。
 * 深层 import 了 app-builder-lib 内部路径较脆，所以失败时提示设 IDEAL1_SIGNTOOL，而不是抛
 * MODULE_NOT_FOUND。
 */
async function resolveSigntool() {
  const explicit = (process.env.IDEAL1_SIGNTOOL ?? '').trim()
  if (explicit) return explicit

  const onPath = spawnSync('where', ['signtool'], { shell: true, encoding: 'utf-8' })
  if (onPath.status === 0) {
    const first = String(onPath.stdout || '').split(/\r?\n/).find((l) => l.trim())
    if (first) return first.trim()
  }

  try {
    const { getSignToolPath } = await import('app-builder-lib/out/toolsets/windows.js')
    const resolved = await getSignToolPath(WIN_CODESIGN_TOOLSET, true)
    const found = typeof resolved === 'string' ? resolved : resolved?.path
    if (found) {
      console.log(`\nsigntool: 用 electron-builder 的工具集副本\n  ${found}`)
      return found
    }
  } catch (err) {
    console.error(`\n找不到 signtool.exe，也没能从 electron-builder 的工具集里取到（${err.message}）。`)
    console.error('装了 Windows SDK 的话，直接指过去：')
    console.error('  $env:IDEAL1_SIGNTOOL = "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<版本>\\x64\\signtool.exe"')
    process.exit(1)
  }
  return 'signtool'
}

// 必须和 electron-builder.json5 里的 toolsets.winCodeSign 一致：两边取的是同一个
// bundle，写不一样只会多下一份、还可能拿到不同版本的 signtool。
const WIN_CODESIGN_TOOLSET = '1.1.0'
const timestampUrl = (process.env.IDEAL1_TIMESTAMP_URL ?? 'http://timestamp.digicert.com').trim()

/** 默认主体名取 productName，这样开箱即用不用先想名字。 */
function defaultSubject() {
  const builderConfig = readFileSync(path.join(uiDir, 'electron-builder.json5'), 'utf-8')
  const match = /"productName"\s*:\s*"([^"]+)"/.exec(builderConfig)
  return match ? match[1] : 'Tessera'
}

/**
 * 给 powershell.exe（5.1）准备干净环境变量，摘掉 PowerShell 7 的 PSModulePath 项。
 * 从 PS7 启动时其模块目录排在 5.1 系统目录前，5.1 会自动加载 PowerShell Core 的
 * Microsoft.PowerShell.Security 而失败，
 * 导致 Cert: 驱动器不存在，最终报出误导性的「找不到匹配 'CodeSigningCert' 的参数」；cmd 或 5.1
 * 里则正常。
 */
function windowsPowerShellEnv() {
  const raw = process.env.PSModulePath
  if (!raw) return process.env
  const cleaned = raw
    .split(';')
    .filter((entry) => {
      const p = entry.trim().toLowerCase().replace(/\\+$/, '')
      if (!p) return false
      // 只保留路径含 WindowsPowerShell 的模块目录：PS7 的目录可能来自安装目录、用户 profile
      // 或其他运行时，
      // 提供同名 Core 类型扩展，与 5.1 重复加载会使证书检查在 Import-Module 阶段失败。
      return /[\\/]windowspowershell[\\/]/.test(p)
    })
    .join(';')
  return { ...process.env, PSModulePath: cleaned }
}

function readPolicy() {
  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf-8'))
    return {
      raw: parsed,
      publisher: typeof parsed.publisher === 'string' ? parsed.publisher.trim() : '',
      publicKeySha256: typeof parsed.publicKeySha256 === 'string' ? parsed.publicKeySha256.trim().toLowerCase() : '',
    }
  } catch {
    return { raw: {}, publisher: '', publicKeySha256: '' }
  }
}

/**
 * 确保有可用签名证书且与仓库钉的公钥一致，返回 `{ publisher }`，跳过签名时返回 null。
 * 策略文件为空 → 造证书并写入公钥、提示提交；有值且本机证书对得上 → 继续；对不上 → 中断构建
 * （否则新机器会悄悄用新证书签名，直到用户点「立即更新」才发现装不上）。
 */
function ensureSigningIdentity() {
  if (skipSigning) {
    console.log('\n=== Signing: skipped (IDEAL1_SKIP_SIGNING=1) ===')
    return null
  }

  const policy = readPolicy()
  const subject = (process.env.IDEAL1_SIGN_SUBJECT ?? '').trim() || policy.publisher || defaultSubject()

  console.log('\n=== Ensure signing certificate ===')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
     '-File', path.join(uiDir, 'scripts', 'ensure-signing-cert.ps1'), '-Subject', subject],
    { encoding: 'utf-8', env: windowsPowerShellEnv() },
  )
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    console.error('could not obtain a signing certificate. Set IDEAL1_SKIP_SIGNING=1 to build without one.')
    process.exit(result.status ?? 1)
  }

  // 只取 stdout 最后一行 JSON：ensure-signing-cert.ps1 备份失败的警告在被 Node 捕获时会落到 stdout，
  // 对整个 stdout 做 JSON.parse 会失败；脚本保证 ConvertTo-Json 是最后一个输出。
  const jsonLine = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .pop()

  let cert
  try {
    cert = JSON.parse(jsonLine)
  } catch {
    console.error(`unreadable output from ensure-signing-cert.ps1:\n${result.stdout}`)
    process.exit(1)
  }

  if (cert.created) {
    console.log(`created a new self-signed certificate: CN=${cert.publisher}, valid until ${cert.notAfter}`)
  } else {
    console.log(`using the existing certificate: CN=${cert.publisher}, valid until ${cert.notAfter}`)
  }
  if (cert.backupPath) console.log(`private key backed up to: ${cert.backupPath}`)

  if (!policy.publisher) {
    // 第一次：把公钥钉进仓库。
    const next = { ...policy.raw, publisher: cert.publisher, publicKeySha256: cert.publicKeySha256 }
    writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    console.log('')
    console.log(`>>> signer-policy.json updated. COMMIT IT.`)
    console.log(`    publisher       = ${cert.publisher}`)
    console.log(`    publicKeySha256 = ${cert.publicKeySha256}`)
    console.log('    This is what installed clients will trust. Changing it later locks them out.')
    return { publisher: cert.publisher }
  }

  // 已经钉过了 —— 核对，不一致就停。
  if (policy.publisher !== cert.publisher || policy.publicKeySha256 !== cert.publicKeySha256) {
    console.error('')
    console.error('!!! The certificate on this machine does not match signer-policy.json.')
    console.error('')
    console.error(`    pinned in repo : CN=${policy.publisher}`)
    console.error(`                     ${policy.publicKeySha256}`)
    console.error(`    on this machine: CN=${cert.publisher}`)
    console.error(`                     ${cert.publicKeySha256}`)
    console.error('')
    console.error('    Signing with this certificate would produce a build that every already-installed')
    console.error('    client refuses to update to - and nothing would look wrong until a user tries.')
    console.error('')
    console.error('    Either import the original key (npm run signing:export made a .pfx on the machine')
    console.error('    that first built this), or - if you really mean to change the trust anchor -')
    console.error('    clear signer-policy.json and accept that existing users must reinstall by hand.')
    process.exit(1)
  }

  return { publisher: cert.publisher }
}

function run(label, command, args, options = {}) {
  console.log(`\n=== ${label} ===`)
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
  if (result.status !== 0) {
    console.error(`\n${label} failed with exit code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

/**
 * 给 PE 文件盖 Authenticode 签名，`/tr` + `/td sha256` 加时间戳副署。
 * 自签名模式客户端不强制副署，但它固定了签名时间，便于日后追查 exe 出自哪次构建；
 * 公共时间戳服务不关心证书由谁签发。
 * 时间戳服务抽风不让构建失败但也不静默：signtool 会打印错误，CA 模式下客户端会拒绝无副署的包。
 */
// resolveSigntool() 的结果。只有真要签名时才去解析（解析可能触发一次下载），
// 所以跳过签名的构建完全不碰它。
let signtool = 'signtool'

/**
 * 时间戳服务器备选清单。曾有 digicert 连续两次间歇性不可达，作废了两个跑了十五分钟的构建
 * （事后五台探测全部可用），所以要的是不让一次网络抖动作废整个构建。
 * IDEAL1_TIMESTAMP_URL 指定的那台永远排第一（显式意图不能被悄悄绕过）。
 */
const TIMESTAMP_FALLBACKS = [
  timestampUrl,
  'http://timestamp.sectigo.com',
  'http://timestamp.acs.microsoft.com',
  'http://time.certum.pl',
].filter((url, i, all) => all.indexOf(url) === i)

/** 每台服务器试几次。同一台重试一次就能过的情况实测出现过。 */
const TIMESTAMP_ATTEMPTS_PER_URL = 2

function signFile(label, target, subject) {
  console.log(`\n=== Sign ${label} ===`)
  for (const url of TIMESTAMP_FALLBACKS) {
    for (let attempt = 1; attempt <= TIMESTAMP_ATTEMPTS_PER_URL; attempt += 1) {
      const args = [
        'sign',
        '/n', `"${subject}"`,
        '/fd', 'sha256',
        '/tr', url,
        '/td', 'sha256',
        '/v',
        `"${target}"`,
      ]
      console.log(`$ ${signtool} ${args.join(' ')}`)
      const result = spawnSync(signtool, args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (result.status === 0) return
      console.error(
        `Sign ${label} failed (exit ${result.status}) with ${url}, ` +
        `attempt ${attempt}/${TIMESTAMP_ATTEMPTS_PER_URL}`,
      )
    }
  }
  // 全部试完还是不行 —— 那才是真的签不了，如实失败，**不许静默跳过签名**：
  // 一个没签名的包所有已安装客户端都会拒绝，而它看起来和签好的一模一样。
  console.error(
    `\nSign ${label} failed against every timestamp server ` +
    `(${TIMESTAMP_FALLBACKS.join(', ')}).`,
  )
  process.exit(1)
}

if (process.platform !== 'win32') {
  // 早失败好过让人等 20 分钟然后拿到一个跑不了的产物。
  console.error('build:standalone must run on Windows x64 - PyInstaller does not cross-compile.')
  process.exit(1)
}

// 冻结产物是构建输入，陈旧的残留会让人误以为"构建成功了"其实用的是上次的。
for (const stale of ['dist/file_vault_backend', 'dist/file_vault_backend.exe', 'dist/file_hook_worker']) {
  const target = path.join(repoRoot, stale)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
}

// 原生 C 助手先编译——两个 spec 都把它们作为 datas 打进去，缺了会在冻结那一步
// 才报"文件不存在"，而那时已经等了几分钟。
run('Build native helpers', 'node', ['scripts/build-file-hook.mjs'], { cwd: uiDir })

run('Freeze backend (one-dir)', 'pyinstaller', ['--clean', '--noconfirm', 'packaging/file_vault_backend.spec'], {
  cwd: repoRoot,
})
run('Freeze file hook worker (one-dir)', 'pyinstaller', ['--clean', '--noconfirm', 'packaging/file_hook_worker.spec'], {
  cwd: repoRoot,
})

for (const required of ['dist/file_vault_backend/file_vault_backend.exe', 'dist/file_hook_worker/file_hook_worker.exe']) {
  if (!existsSync(path.join(repoRoot, required))) {
    console.error(`\nexpected PyInstaller output is missing: ${required}`)
    process.exit(1)
  }
}

// 跨设备守护进程是单独的 Go 可执行文件，不走 Python 后端：协议核心三端共用（Windows 直接编译，
// Android 走 gomobile bind），
// 详见 crossdevice/docs/01-架构与技术原理.md §1。-trimpath 去本机绝对路径，-s -w 去符号表和
// DWARF（约 12 MB 降到 8 MB）。
const crossDeviceDir = path.join(repoRoot, 'modules', 'file_vault', 'crossdevice')
const crossDeviceExe = path.join(crossDeviceDir, 'tessera-crossdevice.exe')
if (existsSync(crossDeviceExe)) rmSync(crossDeviceExe, { force: true })

// Packaging does not run tests. Run the test commands separately when requested.
run(
  'Build cross-device daemon',
  'go',
  // ldflags 值必须自带引号：run() 在 Windows 上 shell:true，不加引号 `-s -w` 会在空格处裂开，go 报
  // flag provided but not defined。
  ['build', '-trimpath', '-ldflags="-s -w"', '-o', 'tessera-crossdevice.exe', './cmd/tessera-crossdevice'],
  { cwd: crossDeviceDir, env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } },
)
if (!existsSync(crossDeviceExe)) {
  console.error('\nexpected Go output is missing: modules/file_vault/crossdevice/tessera-crossdevice.exe')
  process.exit(1)
}

// 证书在这里就位：冻结已经跑完（万一后面中断，产物还在），但打包还没开始
// （证书不匹配这种错必须在产出一个签错名的 exe 之前就报出来）。
const signer = ensureSigningIdentity()

// 内层可执行文件也签（更新验签只看外层）：未签名的 PyInstaller 产物易被杀软误报，
// 表现为更新后后端起不来、runner 因无回执而回滚。
if (signer) {
  signtool = await resolveSigntool()
  signFile(
    'frozen backend',
    path.join(repoRoot, 'dist', 'file_vault_backend', 'file_vault_backend.exe'),
    signer.publisher,
  )
  signFile(
    'frozen file hook worker',
    path.join(repoRoot, 'dist', 'file_hook_worker', 'file_hook_worker.exe'),
    signer.publisher,
  )
  // 跨设备守护进程同样要签：它常驻后台并监听 UDP 端口，未签名的话
  // Windows 防火墙弹窗和杀软误报都会找上它。
  signFile('cross-device daemon', crossDeviceExe, signer.publisher)
}

run('Type-check', 'npx', ['tsc'], { cwd: uiDir })
run('Bundle renderer + Electron', 'npx', ['vite', 'build'], { cwd: uiDir })

// 外层 exe 交给 electron-builder 在打包过程中签（portable 把 payload 塞进启动器，
// 签完再改会弄坏签名）；
// signExecutable 平时为 false（见 electron-builder.json5），要签时必须打开。
// electron-builder 26 起 certificateSubjectName 和 rfc3161TimeStampServer 搬进
// win.signtoolOptions.*，
// 老路径只会被忽略而产物无签名，须与 electron-builder.json5 的 signtoolOptions 同时改。
// signAndEditExecutable 现在同时管签名和资源编辑，不能再当签名开关，改用 win 顶层 signExecutable。
const packageArgs = ['electron-builder']
if (signer) {
  packageArgs.push(
    // 证书主体名必须加引号：默认值 "Tessera" 含空格，run() 在 Windows 上 shell:true，不加会被拆开，
    // yargs 报 Unknown arguments: File, Vault；只有开了签名才会出现。
    `--config.win.signtoolOptions.certificateSubjectName="${signer.publisher}"`,
    `--config.win.signtoolOptions.rfc3161TimeStampServer="${timestampUrl}"`,
    // 与 electron-builder.json5 的默认 signExecutable=false 成对（不签名但保留图标和版本信息），
    // 这里打开。
    // 不要写回 signAndEditExecutable：electron-builder 26 起它同时管资源编辑，且不会报错。
    '--config.win.signExecutable=true',
  )
}
run('Package', 'npx', packageArgs, { cwd: uiDir })

console.log('\n=== Done ===')
console.log('The portable exe is under modules/file_vault/ui/release/<version>/.')
console.log('')
if (signer) {
  console.log(`Signed as: ${signer.publisher}`)
  console.log('')
  console.log('Upload THAT ONE FILE to the GitHub Release. Nothing else - no manifest, no signature file.')
  console.log('')
  console.log('Keep a portable backup of the signing key somewhere off this machine:')
  console.log('  npm run signing:export')
  console.log('Losing it means no future build can be accepted by already-installed clients.')
} else {
  console.log('! This build is UNSIGNED (IDEAL1_SKIP_SIGNING=1).')
  console.log('! The in-app updater will refuse it: the embedded code signature is the only trust anchor.')
  console.log('! Unset IDEAL1_SKIP_SIGNING and rebuild to publish - the certificate is created for you.')
}
