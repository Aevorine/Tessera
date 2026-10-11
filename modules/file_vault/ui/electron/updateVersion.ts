/**
 * 更新流程中所有不碰 IO 的判断：版本比较、资产挑选、签名发布者判定、统一错误类型。
 * 与 IO 分家是为了让决定安全性的逻辑能用构造数据测遍边界。
 * tests/updateTrust.test.mjs 用 `node --experimental-strip-types` 直接加载本文件，
 * 所以不能用需转译的 TS 语法
 * （参数属性、enum、namespace、装饰器），也不能 import 任何相对路径模块；它是无依赖的叶子模块。
 */

/** 单个资产的大小上限。600MB——冻结的 Electron + Python 后端目前约 145MB，
 *  留足几倍余量，同时挡住"声称几十 GB"这类明显不合理的值。 */
export const MAX_ASSET_BYTES = 600 * 1024 * 1024
/** GitHub release 元数据 JSON 的上限。正常只有几 KB。 */
export const MAX_METADATA_BYTES = 1024 * 1024
/** release 说明文本在 UI 里的展示上限。release body 是**仓库侧可控的任意文本**，
 *  截断它既是为了排版，也是为了不让一份超长说明撑爆渲染进程。 */
export const MAX_NOTES_CHARS = 4000

/** 严格三段式 semver，不接受前导零、预发布后缀、build 元数据。 */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * 更新流程的统一错误。`code` 是稳定的机器可读标识，UI 用它查 i18n 文案
 * （`update.<code>`），message 只作为附加诊断信息展示。
 */
export class UpdateError extends Error {
  // 显式声明字段并在构造体里赋值，而不是用"构造函数参数属性"简写——后者是需要
  // 转译的语法糖，会让这个文件无法被 --experimental-strip-types 直接加载。
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
  }
}

export function isStrictSemver(value: string): boolean {
  return STRICT_SEMVER.test(value)
}

export function compareVersions(a: string, b: string): number {
  if (!STRICT_SEMVER.test(a) || !STRICT_SEMVER.test(b)) {
    throw new UpdateError('cannot compare non-strict-semver versions', 'invalid_version')
  }
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/** Release tag 必须精确是 `v<严格semver>`。拒绝 `v1.2.3-beta`、`release-1.2.3` 等。 */
export function versionFromTag(tag: string): string | null {
  if (!tag.startsWith('v')) return null
  const version = tag.slice(1)
  return STRICT_SEMVER.test(version) ? version : null
}

/**
 * 把 release body 收拾成可安全展示的纯文本（去控制字符、统一换行、截断）；body 仓库侧可控，
 * 不参与任何信任判断。
 */
export function sanitizeReleaseNotes(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    // 保留换行和制表符，其余 C0/C1 控制字符一律丢掉
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .trim()
  return normalized.length > MAX_NOTES_CHARS ? `${normalized.slice(0, MAX_NOTES_CHARS)}…` : normalized
}

export interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
  /** GitHub 报告的 sha256（`digest` 字段），可能没有 */
  sha256: string | null
}

export interface GithubRelease {
  tag_name: string
  assets: GithubAsset[]
  body: string
  published_at: string | null
}

/**
 * 安装形态，决定下哪个资产及怎么装：portable 是免安装单文件 exe，由我们的 runner 原地替换；
 * installer 是 NSIS 装的，下新安装包并运行，替换交给安装程序（它管注册表、快捷方式、卸载信息）。
 */
export type InstallFlavor = 'portable' | 'installer'

/** 安装包资产名里的标记。免安装版没有这个词。 */
const INSTALLER_MARKER = 'setup'

/**
 * 从 release 挑出这份安装该用的 exe（Tessera.exe 免安装版 / Tessera Setup.exe 安装包），
 * 按名字里的 `Setup` 区分。
 * 否掉的方案：按大小（接近且漂移）、在 body 写清单（不可信字段）、发两个 release（tag 只有一个）。
 * artifactName 在 electron-builder.json5 里改动必须同步改这里。
 * 挑不到就报错，绝不退而求其次：安装版退回下免安装版会留下游离 exe，
 * 注册表/快捷方式/卸载全部失效且看似成功。
 */
export function selectUpdateAsset(release: { assets: GithubAsset[] }, flavor: InstallFlavor): GithubAsset {
  const exes = release.assets.filter((a) => a.name.toLowerCase().endsWith('.exe'))
  if (exes.length === 0) {
    throw new UpdateError('the release contains no .exe asset', 'missing_asset')
  }

  const isInstaller = (a: GithubAsset) => a.name.toLowerCase().includes(INSTALLER_MARKER)
  const matching = exes.filter((a) => (flavor === 'installer' ? isInstaller(a) : !isInstaller(a)))

  if (matching.length === 0) {
    throw new UpdateError(
      `the release has no ${flavor} build (looked among: ${exes.map((a) => a.name).join(', ')})`,
      'missing_asset',
    )
  }
  if (matching.length > 1) {
    // 同一形态出现两个——多半是手滑把上个版本也传上去了。随便挑一个意味着可能
    // 悄悄给用户装了个旧版本，而且表现得完全正常。宁可明确报错。
    throw new UpdateError(
      `the release has ${matching.length} ${flavor} builds; expected exactly one`,
      'ambiguous_asset',
    )
  }
  return matching[0]
}

/** GitHub 的资产 `digest` 形如 `sha256:<64位hex>`。认不出来就当作没有。 */
export function parseDigest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const match = /^sha256:([0-9a-f]{64})$/.exec(raw.trim().toLowerCase())
  return match ? match[1] : null
}

/**
 * 替换目标的来源及可信度：portable 来自 PORTABLE_EXECUTABLE_FILE，权威；
 * remembered 来自上次启动记下的路径，在用户可写目录，不可直接信，
 * 用前必须确认那个文件确是我们签的。
 */
export type UpdateTargetSource = 'portable' | 'remembered'

export interface UpdateTarget {
  path: string
  source: UpdateTargetSource
}

/**
 * 在候选里挑要替换的 exe：环境变量优先于记忆（反映本次实际启动位置，记忆可能已过时）。
 * 保留记忆是因为某些启动方式拿不到 PORTABLE_EXECUTABLE_FILE，否则只能让用户手动下载。
 */
export function chooseUpdateTarget(candidates: {
  portable?: string | null
  remembered?: string | null
}): UpdateTarget | null {
  const portable = (candidates.portable ?? '').trim()
  if (portable.length > 0) return { path: portable, source: 'portable' }
  const remembered = (candidates.remembered ?? '').trim()
  if (remembered.length > 0) return { path: remembered, source: 'remembered' }
  return null
}

/**
 * 替换时磁盘上会同时有多份（新包 + `.previous-<版本>` 旧包 + 替换瞬间两份），按 2.5 倍再加 200MB
 * 余量，
 * 宁可提前报空间不够，也不要下完才在替换步失败。
 */
export function requiredFreeBytes(assetSize: number): number {
  return Math.ceil(assetSize * 2.5) + 200 * 1024 * 1024
}

export interface AuthenticodeInfo {
  /** WinVerifyTrust 的判定结果 */
  status: string
  statusMessage: string
  /** 证书主体的完整 DN，只用于日志和诊断 */
  subject: string | null
  issuer: string | null
  /** 证书的 CN，发布者比对用的就是这个值 */
  simpleName: string | null
  /** 证书 DER 的 SHA-1 指纹，只用于日志——**绝不用于信任判定**，见下方说明 */
  thumbprint: string | null
  /** 证书**公钥**的 SHA-256（hex）。自签名模式下的信任锚点。 */
  publicKeySha256: string | null
  /** 是否带 RFC 3161 时间戳副署 */
  timestamped: boolean
}

/**
 * 这个构建认哪个签名者，由 publicKeySha256 是否为空决定。
 * 自签名模式（填了指纹）：无 CA 背书，链验证必然失败属预期，信任完全靠公钥精确等于内置值；
 * 攻击者须拿到私钥。
 * CA 模式（留空）：链须验到 Windows 受信根，另要求状态 Valid 和时间戳副署。
 */
export interface SignerPolicy {
  /** 证书主体 CN，两种模式都要求精确匹配 */
  publisher: string
  /** 证书公钥的 SHA-256（hex，64 位）。非空 = 自签名模式。 */
  publicKeySha256: string
}

/**
 * 这些状态表示签名本身没通过，与签发者是否可信无关，两种模式一律拒绝。
 * HashMismatch 最要紧（文件被改过）：WinVerifyTrust 先算摘要再走证书链，所以即便自签名链不可信，
 * 被篡改文件
 * 拿到的仍是 HashMismatch；自签名模式接受链错误但绝不接受这一类，正依赖此顺序。
 */
const FATAL_SIGNATURE_STATUSES = new Set(['NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible'])

/**
 * 自签名模式可接受的状态（签名算对了只是链走不到受信根）；不同 Windows 版本报 UnknownError 或
 * NotTrusted，两个都收，真正的闸门是随后的公钥比对。
 */
const UNTRUSTED_CHAIN_STATUSES = new Set(['Valid', 'UnknownError', 'NotTrusted'])

/**
 * 按签名信息和策略决定接不接受，任一道不过即拒绝，绝不降级。
 * 四道闸：1) 策略里没有发布者 → 一切拒绝（不能「没配就放行」）；2) 状态属
 * FATAL_SIGNATURE_STATUSES → 拒绝；
 * 3) 证书 CN 精确等于锁定发布者（大小写不敏感，绝不前缀/包含匹配）；
 * 4) 自签名模式公钥 SHA-256 须精确匹配，CA 模式须 Valid 且带时间戳副署。
 * 钉公钥而非 thumbprint：thumbprint 是 SHA-1（2019 已有实用选择前缀碰撞）；
 * 钉公钥还允许证书过期后用同一对密钥重签，老客户端照样认。
 */
export function assertTrustedSigner(info: AuthenticodeInfo, policy: SignerPolicy): void {
  const expectedPublisher = policy.publisher.trim()
  if (expectedPublisher.length === 0) {
    throw new UpdateError('this build has no trusted update publisher configured', 'no_trusted_publisher')
  }

  if (FATAL_SIGNATURE_STATUSES.has(info.status) || info.status.trim().length === 0) {
    throw new UpdateError(
      `the downloaded file's code signature is not usable (${info.status || 'unknown'}): ${info.statusMessage}`,
      'bad_signature',
    )
  }

  const actualPublisher = (info.simpleName ?? '').trim()
  if (actualPublisher.length === 0) {
    throw new UpdateError('the code signature carries no readable publisher name', 'untrusted_publisher')
  }
  if (actualPublisher.toLowerCase() !== expectedPublisher.toLowerCase()) {
    throw new UpdateError(
      `the downloaded file is signed by "${actualPublisher}", not by the expected publisher "${expectedPublisher}"`,
      'untrusted_publisher',
    )
  }

  const pinnedKey = policy.publicKeySha256.trim().toLowerCase()
  if (pinnedKey.length > 0) {
    // 自签名模式：链不可信是预期的，公钥说了算。
    if (!UNTRUSTED_CHAIN_STATUSES.has(info.status)) {
      throw new UpdateError(
        `the downloaded file's code signature is not usable (${info.status}): ${info.statusMessage}`,
        'bad_signature',
      )
    }
    const actualKey = (info.publicKeySha256 ?? '').trim().toLowerCase()
    if (actualKey.length === 0) {
      throw new UpdateError('the code signature carries no readable public key', 'untrusted_certificate')
    }
    if (actualKey !== pinnedKey) {
      throw new UpdateError(
        'the downloaded file is signed with a different key than this build trusts',
        'untrusted_certificate',
      )
    }
    return
  }

  // CA 模式：没有钉公钥，只能靠 Windows 的链验证 + CA 的身份审核。
  if (info.status !== 'Valid') {
    throw new UpdateError(
      `the downloaded file's code signature is not valid (${info.status}): ${info.statusMessage}`,
      'bad_signature',
    )
  }
  // 无副署的 CA 签名随证书到期集体失效；自签名模式不强制，因为有效期自己定（脚本默认 20 年）。
  if (!info.timestamped) {
    throw new UpdateError('the downloaded file is signed but not timestamped', 'not_timestamped')
  }
}
