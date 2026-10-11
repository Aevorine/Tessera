/**
 * GitHub Releases 更新服务：检查、下载、验签，再交给独立 runner 安装。
 * 版本判断在 updateVersion.ts，验签在 authenticode.ts，字节传输在 segmentedDownload.ts。
 *
 * 信任模型：一个 release 只有一个 exe，信任根是它自带的 Authenticode 签名（对照内置的
 * 签名者策略）。GitHub API 给的 tag、说明、大小、digest 一律是不可信元数据——它们决定
 * "下不下、下多大、显示什么"，决定"装不装"的只有签名。
 *
 * 三条原则：自动检查只查元数据，绝不静默下载或替换；验签失败就停，不降级；下载边下边限。
 *
 * 已知代价：没有签名保护的过期时间，防不了冻结——能控制 GitHub 响应的攻击者可以一直把
 * 某个真实发布过的旧版本当作 latest 回放。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import signerPolicyFile from '../signer-policy.json'
import { verifySigner } from './authenticode'
import {
  DownloadError,
  downloadFile,
  fetchFollowing,
  removeStaleParts,
  type DownloadProgress,
  type DownloadResult,
  type FetchPolicy,
} from './segmentedDownload'
import {
  MAX_ASSET_BYTES,
  MAX_METADATA_BYTES,
  UpdateError,
  compareVersions,
  parseDigest,
  sanitizeReleaseNotes,
  selectUpdateAsset,
  versionFromTag,
  type GithubAsset,
  type GithubRelease,
  type InstallFlavor,
  type SignerPolicy,
} from './updateVersion'

/** 只认这一个仓库，写死不做成配置：能改配置文件的东西就能把更新源指到别处。
 *  保持占位符 `OWNER/REPO` 时明确报"未配置更新源"并拒绝任何更新。 */
const REPO = 'Aevorine/Tessera'
const REPO_CONFIGURED = !/^(OWNER\/REPO)$/.test(REPO)
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`
/** GitHub 的下载会 302 到 CDN；每一跳都必须落在这几个域里。 */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

const BASE_FETCH_POLICY: FetchPolicy = { isAllowedUrl: isAllowedDownloadUrl, userAgent: 'Tessera-Updater' }

/**
 * 这个构建认哪个签名者——整条信任链的锚点。值来自仓库里的 `signer-policy.json`，由
 * `npm run build:standalone` 写入并在每次构建前核对签名证书的公钥，不一致就中断构建。
 * 放进仓库而不是构建时从证书读：换机器、换证书时，信任哪把钥匙必须是一次看得见的提交。
 *
 * 自签名（默认）：两项都填，信任由公钥承担。CA 证书：只填 `publisher`，要求链验证通过且
 * 带时间戳。留空时拒绝任何更新，绝不"没配就放行"。
 */
const SIGNER_POLICY: SignerPolicy = {
  publisher: typeof signerPolicyFile.publisher === 'string' ? signerPolicyFile.publisher : '',
  publicKeySha256:
    typeof signerPolicyFile.publicKeySha256 === 'string' ? signerPolicyFile.publicKeySha256 : '',
}
const SIGNER_CONFIGURED = SIGNER_POLICY.publisher.trim().length > 0

/** 自动检查的节流窗口：查太勤只是白耗匿名 API 配额（每小时 60 次）。 */
export const AUTO_CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000

const METADATA_TIMEOUT_MS = 15_000

export type UpdateProgress = DownloadProgress

export interface UpdateCheckResult {
  status: 'up-to-date' | 'update-available' | 'error'
  currentVersion: string
  latest?: {
    version: string
    releasedAt: string
    notes: string
    assetName: string
    assetSize: number
  }
  errorCode?: string
  errorMessage?: string
  checkedAt: number
}

/** 一次检查定下来的待装版本。下载和安装都按这份快照走，"看到的"和"装上的"不会来自两次查询。 */
export interface PendingUpdate {
  version: string
  /** 安装版和免安装版的流程完全不同，必须跟着快照定下来，不能安装时再探测。 */
  flavor: InstallFlavor
  assetName: string
  assetSize: number
  /** GitHub 报的 sha256，可能没有。不是信任根，只用来提前发现传输损坏。 */
  reportedSha256: string | null
  releasedAt: string
  notes: string
}

export interface UpdateServiceOptions {
  currentVersion: string
  /** 跟着系统代理走的 fetch（见 proxyFetch.ts）；不传就用全局 fetch 直连。 */
  fetchImpl?: typeof fetch
}

export class UpdateService {
  private lastCheckedAt = 0
  private cachedResult: UpdateCheckResult | null = null
  private pending: PendingUpdate | null = null
  private readonly options: UpdateServiceOptions
  private readonly fetchPolicy: FetchPolicy

  constructor(options: UpdateServiceOptions) {
    this.options = options
    this.fetchPolicy = { ...BASE_FETCH_POLICY, fetchImpl: options.fetchImpl }
  }

  /** 检查更新，只读元数据。`force=false` 时受 24 小时节流约束，返回缓存结果。 */
  async check(force: boolean, flavor: InstallFlavor): Promise<UpdateCheckResult> {
    const now = Date.now()
    if (!force && this.cachedResult && now - this.lastCheckedAt < AUTO_CHECK_THROTTLE_MS) {
      return this.cachedResult
    }

    let result: UpdateCheckResult
    try {
      result = await this.performCheck(now, flavor)
    } catch (error) {
      result = {
        status: 'error',
        currentVersion: this.options.currentVersion,
        errorCode: error instanceof UpdateError ? error.code : 'network_error',
        errorMessage: error instanceof Error ? error.message : String(error),
        checkedAt: now,
      }
    }
    this.lastCheckedAt = now
    this.cachedResult = result
    return result
  }

  private async performCheck(now: number, flavor: InstallFlavor): Promise<UpdateCheckResult> {
    if (!REPO_CONFIGURED) {
      throw new UpdateError('no update source repository is configured in this build', 'no_update_source')
    }
    // 没有发布者就没有信任根，下回来的东西无论如何不会被接受，所以在联网之前就拒绝。
    if (!SIGNER_CONFIGURED) {
      throw new UpdateError('this build has no trusted update publisher configured', 'no_trusted_publisher')
    }

    const release = await this.fetchLatestRelease()
    const version = versionFromTag(release.tag_name)
    if (!version) {
      throw new UpdateError(`release tag is not v<strict semver>: ${release.tag_name}`, 'invalid_tag')
    }
    if (compareVersions(version, this.options.currentVersion) <= 0) {
      this.pending = null
      return { status: 'up-to-date', currentVersion: this.options.currentVersion, checkedAt: now }
    }

    // 挑不到对应形态时直接报错：挑错的后果是装上一个形态不对的东西。
    const asset = selectUpdateAsset(release, flavor)
    this.pending = {
      version,
      flavor,
      assetName: asset.name,
      assetSize: asset.size,
      reportedSha256: asset.sha256,
      releasedAt: release.published_at ?? new Date(now).toISOString(),
      notes: sanitizeReleaseNotes(release.body),
    }
    return {
      status: 'update-available',
      currentVersion: this.options.currentVersion,
      latest: {
        version: this.pending.version,
        releasedAt: this.pending.releasedAt,
        notes: this.pending.notes,
        assetName: this.pending.assetName,
        assetSize: this.pending.assetSize,
      },
      checkedAt: now,
    }
  }

  getPendingUpdate(): PendingUpdate | null {
    return this.pending
  }

  /** 供 runner 复用：runner 在主进程退出后才跑，两边判据必须是同一份。 */
  static signerPolicy(): SignerPolicy {
    return { ...SIGNER_POLICY }
  }

  /**
   * 下载新版本并验 Authenticode 签名，返回 `{ path, sha256 }`。
   *
   * Authenticode 覆盖整个 PE，必须先下完才能验；下载阶段的大小上限、停滞和总时长限制
   * 只是资源保护，不承担任何信任。
   */
  async download(
    /** 必须和目标 exe 同一个目录：跨卷 rename 不是原子操作，runner 的原子替换就不成立。 */
    downloadDir: string,
    onProgress?: (progress: UpdateProgress) => void,
  ): Promise<{ path: string; sha256: string }> {
    const pending = this.pending
    if (!pending) {
      throw new UpdateError('no verified update is pending; check for updates first', 'no_pending_update')
    }
    const release = await this.fetchLatestRelease()
    if (versionFromTag(release.tag_name) !== pending.version) {
      // 检查和下载之间发了新版：不下一个跟用户看到的说明对不上的包。
      throw new UpdateError('the release changed since the last check; please check again', 'release_changed')
    }
    const asset = release.assets.find((a) => a.name === pending.assetName)
    if (!asset) {
      throw new UpdateError(`asset disappeared from the release: ${pending.assetName}`, 'missing_asset')
    }

    await fsp.mkdir(downloadDir, { recursive: true })
    const target = path.join(downloadDir, pending.assetName)
    const temp = `${target}.part`
    // 上次留下的同名成品可能是验签失败的旧文件，清掉；同名 .part 留给引擎核对后续传。
    await fsp.rm(target, { force: true })
    await removeStaleParts(downloadDir, pending.assetName)

    let downloaded: DownloadResult
    try {
      downloaded = await downloadFile({
        ...this.fetchPolicy,
        url: asset.browser_download_url,
        size: asset.size,
        partPath: temp,
        resumePath: `${temp}.json`,
        identity: { version: pending.version, assetName: pending.assetName, digest: pending.reportedSha256 },
        onProgress,
      })
    } catch (error) {
      throw error instanceof DownloadError
        ? new UpdateError(error.message, error.code)
        : new UpdateError(String(error), 'download_failed')
    }
    console.info(
      `[update] downloaded ${downloaded.received} bytes: mode=${downloaded.mode} peak=${downloaded.peakConnections} ` +
        `steals=${downloaded.steals} resumed=${downloaded.resumedBytes}`,
    )
    return await this.finishDownload({ pending, asset, received: downloaded.received, digest: downloaded.sha256, temp, target })
  }

  /** 大小和 digest 先比（便宜，筛掉明显损坏的下载）；真正的闸门是最后的 verifySigner()。 */
  private async finishDownload(args: {
    pending: PendingUpdate
    asset: GithubAsset
    received: number
    digest: string
    temp: string
    target: string
  }): Promise<{ path: string; sha256: string }> {
    const { pending, asset, received, digest, temp, target } = args

    if (received !== asset.size) {
      await fsp.rm(temp, { force: true })
      throw new UpdateError('downloaded size does not match the size reported by GitHub', 'size_mismatch')
    }
    if (pending.reportedSha256 && digest !== pending.reportedSha256) {
      await fsp.rm(temp, { force: true })
      throw new UpdateError('downloaded file hash does not match the digest reported by GitHub', 'hash_mismatch')
    }

    // 先改名再验签（验签认扩展名）；验不过就删，绝不留一个没验过的 exe 等人双击。
    await fsp.rename(temp, target)
    try {
      const info = await verifySigner(target, SIGNER_POLICY)
      console.info(
        `[update] signature ok: publisher="${info.simpleName}" key=${info.publicKeySha256?.slice(0, 16)} status=${info.status} timestamped=${info.timestamped}`,
      )
    } catch (error) {
      await fsp.rm(target, { force: true })
      throw error
    }

    return { path: target, sha256: digest }
  }

  private async fetchLatestRelease(): Promise<GithubRelease> {
    let response: Response
    try {
      const fetched = await fetchFollowing(this.fetchPolicy, LATEST_RELEASE_URL, METADATA_TIMEOUT_MS, {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      })
      response = fetched.response
    } catch (error) {
      throw error instanceof DownloadError ? new UpdateError(error.message, error.code) : error
    }
    if (!response.ok) {
      // 匿名请求下，404 = 仓库私有或不存在（GitHub 故意不区分），403/429 = 限流；
      // 都不是"稍后重试"能解决的故障，所以给出各自的错误码。
      if (response.status === 404) {
        throw new UpdateError(
          `release feed for ${REPO} is not publicly reachable (HTTP 404)`,
          'update_source_unreachable',
        )
      }
      if (response.status === 403 || response.status === 429) {
        throw new UpdateError(`GitHub rate limit hit (HTTP ${response.status})`, 'update_rate_limited')
      }
      throw new UpdateError(`GitHub API returned HTTP ${response.status}`, 'github_api_error')
    }
    const text = await response.text()
    if (text.length > MAX_METADATA_BYTES) {
      throw new UpdateError('GitHub release metadata is implausibly large', 'metadata_too_large')
    }
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null) {
      throw new UpdateError('GitHub release metadata is not an object', 'github_api_error')
    }
    return this.parseRelease(data as Record<string, unknown>)
  }

  private parseRelease(record: Record<string, unknown>): GithubRelease {
    // 草稿和预发布可能是还没验证完的构建，一律不接受。
    if (record.draft === true) throw new UpdateError('latest release is a draft', 'draft_release')
    if (record.prerelease === true) throw new UpdateError('latest release is a prerelease', 'prerelease')

    const tagName = record.tag_name
    if (typeof tagName !== 'string') {
      throw new UpdateError('release has no tag_name', 'github_api_error')
    }
    const rawAssets = record.assets
    if (!Array.isArray(rawAssets)) {
      throw new UpdateError('release has no asset list', 'github_api_error')
    }

    const assets: GithubAsset[] = []
    const seenNames = new Set<string>()
    for (const item of rawAssets) {
      if (typeof item !== 'object' || item === null) continue
      const a = item as Record<string, unknown>
      const name = a.name
      const size = a.size
      const url = a.browser_download_url
      if (typeof name !== 'string' || typeof size !== 'number' || typeof url !== 'string') continue
      if (seenNames.has(name)) {
        // 同名资产出现两次就无法确定该下哪个，宁可拒绝也不猜。
        throw new UpdateError(`release has duplicate assets named ${name}`, 'duplicate_asset')
      }
      seenNames.add(name)
      if (!isAllowedDownloadUrl(url)) {
        throw new UpdateError(`release asset points outside GitHub: ${name}`, 'off_host_asset')
      }
      if (size > MAX_ASSET_BYTES) {
        throw new UpdateError(`release asset is implausibly large: ${name}`, 'asset_too_large')
      }
      assets.push({ name, size, browser_download_url: url, sha256: parseDigest(a.digest) })
    }

    return {
      tag_name: tagName,
      assets,
      body: typeof record.body === 'string' ? record.body : '',
      published_at: typeof record.published_at === 'string' ? record.published_at : null,
    }
  }
}

export { UpdateError }
