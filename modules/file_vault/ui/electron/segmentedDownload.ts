/**
 * 多连接分段下载引擎。只管"字节怎么搬过来"，不管"搬过来的东西信不信"：
 * 每一跳地址都过调用方的白名单、大小边下边限；哈希比对与验签由调用方做。
 *
 * 不依赖 Electron，也不用需要转译的 TS 语法，测试能用 `node --experimental-strip-types`
 * 直接加载（见 tests/segmentedDownload.test.mjs）。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MIB = 1024 * 1024
const MAX_REDIRECTS = 5
/** 速率读数的平滑时间常数。 */
const RATE_TAU_MS = 1_200
const RESUME_FORMAT = 2
/** 清理半截包时只认带这个标记的记录——下载目录可能是用户自己的文件夹。 */
const RESUME_KIND = 'tessera-update-resume'

export interface Tuning {
  /** 小于它不分段：握手开销比省下的时间多。 */
  parallelMinBytes: number
  /**
   * 并行连接数，开局就全开。实测（140 MB 发布包、跨境线路）：单连接受限时吞吐随连接数
   * 近乎线性增长，且每条连接要十几秒才爬到满速，逐步试探只会浪费最值钱的头几秒；链路
   * 受限时 16 条与 8 条持平。16 也是 aria2 的单服务器上限，再多可能被 CDN 当滥用。
   */
  connections: number
  /** 一条连接的第一块：还不知道它多快，先小块试探。 */
  firstChunkBytes: number
  minChunkBytes: number
  maxChunkBytes: number
  /** 每块按"这条连接下这么久"来切：快连接拿大块省请求往返，慢连接拿小块。 */
  chunkTargetMs: number
  /**
   * 收尾时一块最短也按这么久来切。每个请求要先等约 0.2 s 才出字节（实测），块切得太碎
   * 时这笔固定开销会吃掉大半吞吐。
   */
  chunkMinMs: number
  /** 切分在途分段时两边各自至少留这么多。 */
  minSplitBytes: number
  /** 对方自己下完还要这么久以上才考虑帮它：再短就让它自己收尾。 */
  stealMinAloneMs: number
  /** 帮它至少要省下这个比例的时间才动手（拿活会废掉对方一条热连接，新请求还要重新起速）。 */
  stealMinGain: number
  /** 一条连接出字节不到这么久，速度读数不可信。 */
  rateSampleMs: number
  /** 一条连接这么久还没出第一个字节，视同卡住，可被接管。 */
  takeoverGraceMs: number
  /** 没活可接但别人还在下时，隔这么久回来看一眼有没有卡住的尾巴要接。 */
  rescueIntervalMs: number
  /** 攒够再写盘，免得多连接的小写入挤满 libuv 线程池。 */
  writeBatchBytes: number
  headerTimeoutMs: number
  totalTimeoutMs: number
  /** 所有连接一起没数据这么久，判整体停滞。 */
  stallTimeoutMs: number
  /** 单条连接没数据这么久就掐掉重试，不陪它等。 */
  connectionStallMs: number
  chunkMaxAttempts: number
  /** 一次尝试前进超过它就不记失败：线路时断时续但在走，就让它续。 */
  retryForgiveBytes: number
  retryBaseMs: number
  progressIntervalMs: number
  resumeSaveIntervalMs: number
  tickMs: number
  /** 签名地址过期可重新解析的次数；换了还被拒就是真被拒。 */
  maxUrlRefreshes: number
}

export const DEFAULT_TUNING: Tuning = {
  parallelMinBytes: 8 * MIB,
  connections: 16,
  firstChunkBytes: 2 * MIB,
  minChunkBytes: 512 * 1024,
  maxChunkBytes: 64 * MIB,
  chunkTargetMs: 8_000,
  chunkMinMs: 2_000,
  minSplitBytes: 256 * 1024,
  stealMinAloneMs: 3_000,
  stealMinGain: 0.4,
  rateSampleMs: 500,
  takeoverGraceMs: 2_000,
  rescueIntervalMs: 150,
  writeBatchBytes: 1 * MIB,
  headerTimeoutMs: 15_000,
  totalTimeoutMs: 30 * 60 * 1000,
  stallTimeoutMs: 60_000,
  connectionStallMs: 20_000,
  chunkMaxAttempts: 3,
  retryForgiveBytes: 256 * 1024,
  retryBaseMs: 600,
  progressIntervalMs: 100,
  resumeSaveIntervalMs: 750,
  tickMs: 250,
  maxUrlRefreshes: 8,
}

export class DownloadError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'DownloadError'
    this.code = code
  }
}

export interface FetchPolicy {
  /** 每一跳（含重定向落点）都要过它；不过就拒绝，不降级。 */
  isAllowedUrl(url: string): boolean
  userAgent: string
  fetchImpl?: typeof fetch
}

export interface DownloadProgress {
  received: number
  total: number
  bytesPerSecond: number
  connections: number
}

export interface DownloadOptions extends FetchPolicy {
  url: string
  /** 权威大小：多一个字节都不收。 */
  size: number
  partPath: string
  resumePath: string
  /** 续传记录必须跟它完全一致才接着用。 */
  identity: { version: string; assetName: string; digest: string | null }
  onProgress?: (progress: DownloadProgress) => void
  tuning?: Partial<Tuning>
}

export interface DownloadResult {
  received: number
  sha256: string
  mode: 'segmented' | 'single'
  peakConnections: number
  /** 空闲连接从别的连接手里分走分段的次数。 */
  steals: number
  resumedBytes: number
}

/** 闭区间 [start, end]。 */
export type ByteRange = [number, number]

// ---- 区间运算（纯函数） --------------------------------------------------------

/** 把 [start, end] 并进有序、互不相邻的区间表（原地）。 */
export function addRange(ranges: ByteRange[], start: number, end: number): void {
  let i = 0
  while (i < ranges.length && ranges[i][1] < start - 1) i += 1
  let j = i
  while (j < ranges.length && ranges[j][0] <= end + 1) {
    start = Math.min(start, ranges[j][0])
    end = Math.max(end, ranges[j][1])
    j += 1
  }
  ranges.splice(i, j - i, [start, end])
}

export function missingRanges(done: ByteRange[], size: number): ByteRange[] {
  const missing: ByteRange[] = []
  let next = 0
  for (const [start, end] of done) {
    if (start > next) missing.push([next, start - 1])
    next = end + 1
  }
  if (next < size) missing.push([next, size - 1])
  return missing
}

export function rangeBytes(ranges: ByteRange[]): number {
  return ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0)
}

/** 校验从磁盘读回的区间表；有一处不合规就整份作废。 */
export function sanitizeRanges(value: unknown, size: number): ByteRange[] | null {
  if (!Array.isArray(value)) return null
  const ranges: ByteRange[] = []
  let floor = 0
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null
    const [start, end] = item as unknown[]
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
    if ((start as number) < floor || (end as number) < (start as number) || (end as number) >= size) return null
    addRange(ranges, start as number, end as number)
    floor = (end as number) + 1
  }
  return ranges
}

export function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec((value ?? '').trim())
  if (!match) return null
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) }
}

// ---- 带白名单的 fetch ----------------------------------------------------------

/**
 * 手动跟随重定向，每一跳都过白名单；`timeoutMs` 只覆盖到拿到响应头。
 * 返回最后一跳的地址，分段请求直接打它，不必每段重新 302。
 */
export async function fetchFollowing(
  policy: FetchPolicy,
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
  controller?: AbortController,
): Promise<{ response: Response; url: string }> {
  const doFetch = policy.fetchImpl ?? fetch
  let current = url
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    if (!policy.isAllowedUrl(current)) {
      throw new DownloadError(`refusing to fetch a URL outside the allow-list: ${current}`, 'off_host_asset')
    }
    const active = controller ?? new AbortController()
    const timer = setTimeout(() => active.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(current, {
        headers: { 'User-Agent': policy.userAgent, ...headers },
        redirect: 'manual',
        signal: active.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (response.status < 300 || response.status >= 400) return { response, url: current }
    const location = response.headers.get('location')
    // 不丢掉 body，这条连接回不到池里。
    await discardBody(response)
    if (!location) throw new DownloadError('redirect without a location header', 'download_failed')
    current = new URL(location, current).toString()
  }
  throw new DownloadError('too many redirects', 'download_failed')
}

// ---- 下载 ----------------------------------------------------------------------

export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  return await new Transfer(options).run()
}

/**
 * 删掉别的包没下完留下的 `.part` 和续传记录。只认带 RESUME_KIND 标记、且文件名跟记录里
 * 的包名对得上的记录——下载目录可能是用户自己的文件夹。
 */
export async function removeStaleParts(dir: string, keepAssetName: string): Promise<void> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.part.json')) continue
    const sidecar = path.join(dir, name)
    try {
      if ((await fsp.stat(sidecar)).size > 64 * 1024) continue
      const record = JSON.parse(await fsp.readFile(sidecar, 'utf8')) as { kind?: unknown; assetName?: unknown } | null
      if (!record || record.kind !== RESUME_KIND || typeof record.assetName !== 'string') continue
      if (record.assetName === keepAssetName || name !== `${record.assetName}.part.json`) continue
      await Promise.all(
        [`${record.assetName}.part`, name, `${name}.tmp`].map((f) => fsp.rm(path.join(dir, f), { force: true })),
      )
    } catch {
      // 清理只是顺手，失败不影响本次下载。
    }
  }
}

interface Chunk {
  start: number
  /** 含。后半段被偷走时缩小。 */
  end: number
  /** 已写盘的字节数，重试从这里接着要。 */
  written: number
  /** 收到但还没写盘的字节数。 */
  buffered: number
  startedAt: number
  /** 0 表示还没收到过字节。 */
  firstByteAt: number
  /** 正在进行的那次请求；被接管时靠它叫醒卡在 read() 里的原主。 */
  attempt: Attempt | null
}

interface Attempt {
  controller: AbortController
  lastByteAt: number
  stalled: boolean
}

/** CDN 拒绝了已签名的地址，几乎总是过期：换个新地址，不记这块失败。 */
class ExpiredUrlError extends DownloadError {
  constructor(status: number) {
    super(`the CDN rejected the signed download URL (HTTP ${status})`, 'download_failed')
    this.name = 'ExpiredUrlError'
  }
}

class Transfer {
  private readonly options: DownloadOptions
  private readonly tuning: Tuning
  /** 总开关：停滞、超时或某块彻底失败时拉下，所有连接一起停。 */
  private readonly controller = new AbortController()
  private readonly attempts = new Set<Attempt>()
  private readonly inflight = new Set<Chunk>()
  private readonly startedAt = Date.now()
  private lastByteAt = Date.now()
  private abortReason: 'stalled' | 'timeout' | null = null
  private failure: unknown = null

  private handle: FileHandle | null = null
  private pending: ByteRange[] = []
  private done: ByteRange[] = []
  private doneBytes = 0
  private resumedBytes = 0
  private persist: Promise<void> = Promise.resolve()
  private resumeSavedAt = 0

  private url = ''
  private urlGeneration = 0
  private urlRefreshes = 0
  private urlRefreshing: Promise<boolean> | null = null

  private live = 0
  private target = 0
  private peak = 0
  private steals = 0
  private finished = false
  private onIdle: (() => void) | null = null

  /** 本次从网络收下的字节数，速率和爬升判断都看它。 */
  private netBytes = 0
  private rate = 0
  private rateSeeded = false
  private sampleAt = Date.now()
  private sampleBytes = 0
  private progressAt = 0
  /** 请求发出到第一个字节的时间，估算"接手一段要先付多少等待"。 */
  private ttfbMs = 500

  constructor(options: DownloadOptions) {
    this.options = options
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning }
  }

  async run(): Promise<DownloadResult> {
    const { size, partPath } = this.options
    const ticker = setInterval(() => this.tick(), this.tuning.tickMs)
    let mode: DownloadResult['mode'] = 'single'
    let received = 0
    let sha256: string | null = null
    try {
      // 探不通就退回单流：分段只是提速，不能变成新的故障点。
      const rangeUrl = size >= this.tuning.parallelMinBytes ? await this.probeRange() : null
      if (rangeUrl) {
        mode = 'segmented'
        await this.segmented(rangeUrl)
        received = this.doneBytes
      } else {
        const single = await this.singleStream()
        received = single.received
        sha256 = single.sha256
      }
    } catch (error) {
      throw this.abortError() ?? (error instanceof DownloadError ? error : new DownloadError(String(error), 'download_failed'))
    } finally {
      // 之后的整文件哈希期间不会有字节到来，看门狗留着会误判停滞。
      clearInterval(ticker)
    }
    this.emitProgress(true)
    return {
      received,
      // 分块乱序到达，整文件哈希只能下完后顺序读一遍算。
      sha256: sha256 ?? (await sha256File(partPath)),
      mode,
      peakConnections: this.peak,
      steals: this.steals,
      resumedBytes: this.resumedBytes,
    }
  }

  // ---- 单流 ----

  /** 一条连接从头到尾，边下边算哈希。没有 Range 就没法续传。 */
  private async singleStream(): Promise<{ received: number; sha256: string }> {
    const { url, size, partPath, resumePath } = this.options
    await Promise.all([fsp.rm(partPath, { force: true }), fsp.rm(resumePath, { force: true })])
    this.live = 1
    this.peak = Math.max(this.peak, 1)

    const { response } = await fetchFollowing(
      this.options,
      url,
      this.tuning.headerTimeoutMs,
      { Accept: 'application/octet-stream' },
      this.controller,
    )
    if (!response.ok || !response.body) {
      throw new DownloadError(`asset download failed with HTTP ${response.status}`, 'download_failed')
    }

    const hash = createHash('sha256')
    let received = 0
    // 放在流中间而不是下完再查：声称 145MB 的资产可能是个无限流。
    const counting = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.lastByteAt = Date.now()
        received += chunk.length
        this.netBytes += chunk.length
        this.doneBytes = received
        if (received > size) {
          callback(new DownloadError('download exceeded the expected size', 'download_too_large'))
          return
        }
        hash.update(chunk)
        this.emitProgress(false)
        callback(null, chunk)
      },
    })
    try {
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      await pipeline(body, counting, fs.createWriteStream(partPath))
    } catch (error) {
      await fsp.rm(partPath, { force: true })
      throw error
    }
    return { received, sha256: hash.digest('hex') }
  }

  // ---- 分段 ----

  /**
   * 探 CDN 认不认 Range，顺便走完重定向拿到最终地址。要的是 `bytes=0-0` 的 206，且总长
   * 等于期望大小；返回 null 表示别分段。
   */
  private async probeRange(): Promise<string | null> {
    const link = linkController(this.controller.signal)
    try {
      const { response, url } = await fetchFollowing(
        this.options,
        this.options.url,
        this.tuning.headerTimeoutMs,
        { Accept: 'application/octet-stream', Range: 'bytes=0-0' },
        link.controller,
      )
      // 不认 Range 的服务器会回 200 加整个文件，绝不能读。
      await discardBody(response)
      if (response.status !== 206) return null
      const range = parseContentRange(response.headers.get('content-range'))
      return range && range.start === 0 && range.end === 0 && range.total === this.options.size ? url : null
    } catch (error) {
      // 整体被叫停、或重定向出了白名单，都不是"不支持分段"，不能退回单流装没发生。
      if (this.controller.signal.aborted) throw error
      if (error instanceof DownloadError && error.code === 'off_host_asset') throw error
      console.warn(`[download] range probe failed, using a single stream: ${String(error)}`)
      return null
    } finally {
      link.dispose()
    }
  }

  /**
   * 多条连接各自从"缺口队列"里切一块来下，按偏移写进预分配的 `.part`。
   * 文件预分配为期望大小、每块只收自己那段，所以磁盘上不可能多出一个字节。
   */
  private async segmented(rangeUrl: string): Promise<void> {
    const { size, partPath, resumePath } = this.options
    this.url = rangeUrl
    // 接着用的字节不因此被信任：调用方照样整文件比哈希、验签。
    this.done = await loadResume(this.options)
    this.doneBytes = this.resumedBytes = rangeBytes(this.done)
    this.pending = missingRanges(this.done, size)
    if (this.resumedBytes > 0) {
      console.info(`[download] resuming: ${this.resumedBytes} of ${size} bytes already on disk`)
    }

    const handle = await fsp.open(partPath, this.resumedBytes > 0 ? 'r+' : 'w')
    this.handle = handle
    try {
      if (this.resumedBytes === 0) await handle.truncate(size)
      this.saveResume(true)
      if (this.pending.length > 0) {
        this.target = this.usefulConnections()
        await new Promise<void>((resolve) => {
          this.onIdle = resolve
          this.spawn()
        })
      }
    } finally {
      this.finished = true
      this.saveResume(true)
      await this.persist
      await handle.close()
    }

    if (this.failure !== null || this.controller.signal.aborted) {
      throw this.abortError() ?? this.failure ?? new DownloadError('the download was aborted', 'download_failed')
    }
    if (this.doneBytes !== size) throw new DownloadError('the download ended with bytes missing', 'download_failed')
    // 字节齐了记录就没用了；留着只会让下一次去续一个已被删掉的文件。
    await Promise.all([resumePath, `${resumePath}.tmp`].map((f) => fsp.rm(f, { force: true })))
  }

  private usefulConnections(): number {
    const remaining = this.options.size - this.doneBytes
    return Math.max(1, Math.min(this.tuning.connections, Math.ceil(remaining / this.tuning.minChunkBytes)))
  }

  /** 还没落到手里的字节：缺口队列加上在途分段各自没收到的部分。 */
  private unfinishedBytes(): number {
    let bytes = rangeBytes(this.pending)
    for (const chunk of this.inflight) bytes += Math.max(0, chunk.end - chunk.start - chunk.written - chunk.buffered + 1)
    return bytes
  }

  /** 一条"普通"连接此刻的速度，给还没有自己读数的连接当估计。 */
  private typicalRate(): number {
    return this.rateSeeded ? this.rate / Math.max(1, this.attempts.size) : 0
  }

  private spawn(): void {
    while (!this.finished && this.live < this.target) {
      this.live += 1
      this.peak = Math.max(this.peak, this.live)
      void this.worker()
    }
  }

  private async worker(): Promise<void> {
    let rate = 0
    try {
      while (this.failure === null && !this.controller.signal.aborted && this.live <= this.target) {
        const chunk = this.take(rate) ?? this.steal(rate)
        if (!chunk) {
          if (this.inflight.size === 0) return
          // 别人手里的分段现在分不动，过会儿可能变成该接管的慢尾巴。
          await delay(this.tuning.rescueIntervalMs, this.controller.signal).catch(() => undefined)
          continue
        }
        this.inflight.add(chunk)
        try {
          await this.fetchChunk(chunk)
        } catch (error) {
          // 一块重试用完就整体停：拼不出完整文件了，已落盘的区间留给下次续传。
          if (this.failure === null) this.failure = error
          this.controller.abort()
          return
        } finally {
          this.inflight.delete(chunk)
        }
        // 从第一个字节算起（不含握手和等响应头），并做平滑：小块一口气到齐时瞬时值会虚高。
        if (chunk.firstByteAt > 0 && chunk.written > 0) {
          const measured = (chunk.written * 1000) / Math.max(250, Date.now() - chunk.firstByteAt)
          rate = rate > 0 ? (rate + measured) / 2 : measured
        }
      }
    } finally {
      this.live -= 1
      if (this.live === 0) this.onIdle?.()
    }
  }

  /**
   * 从缺口队列头部切一块：这条连接的速度 × 时间片。时间片不超过"所有连接同时收工"还
   * 需要的时间，所以尾声的块按各连接的速度分摊，差不多同时下完，不留一条慢的独自收尾。
   */
  private take(rate: number): Chunk | null {
    const first = this.pending[0]
    if (!first) return null
    const { firstChunkBytes, minChunkBytes, maxChunkBytes, chunkTargetMs, chunkMinMs } = this.tuning
    const typical = this.typicalRate()
    // 单条连接的读数再高也按普通连接的 3 倍封顶，免得一次虚高就把剩下的全揽走。
    const speed = typical > 0 ? Math.min(rate > 0 ? rate : typical, 3 * typical) : rate
    let want: number
    if (speed > 0 && this.rate > 0) {
      const fairMs = (this.unfinishedBytes() * 1000) / this.rate
      const sliceMs = clamp(fairMs, chunkMinMs, chunkTargetMs)
      want = clamp(Math.round((speed * sliceMs) / 1000), minChunkBytes, maxChunkBytes)
    } else {
      want = clamp(Math.ceil(rangeBytes(this.pending) / Math.max(1, this.target)), minChunkBytes, firstChunkBytes)
    }
    const [start, end] = first
    let cut = Math.min(end, start + want - 1)
    if (end - cut < minChunkBytes) cut = end
    if (cut === end) this.pending.shift()
    else first[0] = cut + 1
    return newChunk(start, cut)
  }

  /**
   * 队列空了，看有没有哪条在途连接值得帮：按双方速度把它没收到的部分分走一份，让两边同时
   * 收工；对方那份太小就整段接管并掐掉它的请求（已收到的仍归它写盘，一个字节不重下）。
   *
   * 拿活不是白拿：自己要先等一次响应，对方那条热连接也会被废掉，之后它只能用冷连接。
   * 实测里放手去分的话，收尾会被一连串冷连接拖慢。所以只救明显卡住或爬行的连接，
   * 正常收尾靠 take() 的份额控制。
   */
  private steal(thiefRate: number): Chunk | null {
    const { minSplitBytes, stealMinAloneMs, stealMinGain, rateSampleMs, takeoverGraceMs } = this.tuning
    const mine = thiefRate > 0 ? thiefRate : this.typicalRate()
    if (mine <= 0) return null
    const now = Date.now()
    let victim: Chunk | null = null
    let share = 0
    let bestGain = 0
    for (const chunk of this.inflight) {
      const got = chunk.written + chunk.buffered
      const remaining = chunk.end - chunk.start - got + 1
      if (remaining <= 0) continue
      let theirs = 0
      if (chunk.firstByteAt === 0) {
        // 还在握手或等响应头：给足时间再判它卡住。
        if (now - chunk.startedAt < takeoverGraceMs) continue
      } else {
        const sampled = now - chunk.firstByteAt
        if (sampled < rateSampleMs) continue
        theirs = (got * 1000) / sampled
      }
      let take = Math.round((remaining * mine) / (mine + theirs))
      if (remaining - take < minSplitBytes) take = remaining
      else if (take < minSplitBytes) continue
      const aloneMs = theirs > 0 ? (remaining * 1000) / theirs : Number.MAX_SAFE_INTEGER
      if (aloneMs < stealMinAloneMs) continue
      const gain = aloneMs - (this.ttfbMs + (take * 1000) / mine)
      if (gain >= aloneMs * stealMinGain && gain > bestGain) {
        victim = chunk
        share = take
        bestGain = gain
      }
    }
    if (!victim) return null
    const from = victim.end - share + 1
    const taken = newChunk(from, victim.end)
    victim.end = from - 1
    // 整段接管：原主可能正卡在 read() 里，叫醒它去把已收到的写盘。
    if (victim.start + victim.written + victim.buffered > victim.end) victim.attempt?.controller.abort()
    this.steals += 1
    return taken
  }

  /** 下一块，带重试；每次都从已写盘的最后一个字节接着要。 */
  private async fetchChunk(chunk: Chunk): Promise<void> {
    const { chunkMaxAttempts, retryForgiveBytes, retryBaseMs } = this.tuning
    let failures = 0
    while (chunk.start + chunk.written <= chunk.end) {
      const before = chunk.written
      const generation = this.urlGeneration
      try {
        await this.fetchChunkOnce(chunk)
      } catch (error) {
        if (this.controller.signal.aborted) throw error
        // 被接管时请求是我们自己掐的：收到的已写盘，这块到此就算完成。
        if (chunk.start + chunk.written > chunk.end) return
        if (error instanceof DownloadError && error.code === 'off_host_asset') throw error
        if (error instanceof ExpiredUrlError && (await this.refreshUrl(generation))) continue
        if (chunk.written - before < retryForgiveBytes) failures += 1
        if (failures >= chunkMaxAttempts) throw error
        // 带抖动，别让同时失败的几条连接又在同一毫秒一起重试。
        const backoff = retryBaseMs * 2 ** Math.max(0, failures - 1) * (0.75 + Math.random() / 2)
        await delay(backoff, this.controller.signal)
      }
    }
  }

  private async fetchChunkOnce(chunk: Chunk): Promise<void> {
    const handle = this.handle as FileHandle
    const from = chunk.start + chunk.written
    const requestedEnd = chunk.end
    const link = linkController(this.controller.signal)
    const attempt: Attempt = { controller: link.controller, lastByteAt: Date.now(), stalled: false }
    this.attempts.add(attempt)
    chunk.attempt = attempt

    let pieces: Buffer[] = []
    let pieceBytes = 0
    const flush = async () => {
      if (pieceBytes === 0) return
      const data = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, pieceBytes)
      pieces = []
      pieceBytes = 0
      const at = chunk.start + chunk.written
      await writeAt(handle, data, at)
      chunk.written += data.length
      chunk.buffered = 0
      addRange(this.done, at, at + data.length - 1)
      this.doneBytes += data.length
      this.saveResume(false)
    }
    const room = () => chunk.end - (chunk.start + chunk.written + pieceBytes) + 1

    const requestedAt = Date.now()
    try {
      const { response } = await fetchFollowing(
        this.options,
        this.url,
        this.tuning.headerTimeoutMs,
        { Accept: 'application/octet-stream', Range: `bytes=${from}-${requestedEnd}` },
        link.controller,
      )
      if (response.status === 401 || response.status === 403 || response.status === 410) {
        await discardBody(response)
        throw new ExpiredUrlError(response.status)
      }
      if (response.status === 429 || response.status === 503) {
        await discardBody(response)
        this.easeOff()
        throw new DownloadError(`the server asked to slow down (HTTP ${response.status})`, 'download_failed')
      }
      if (response.status !== 206 || !response.body) {
        await discardBody(response)
        throw new DownloadError(`range request returned HTTP ${response.status}`, 'download_failed')
      }
      // 必须正好是要的那一段：起点错了，字节就写到文件的错误位置上。
      const range = parseContentRange(response.headers.get('content-range'))
      if (
        !range ||
        range.start !== from ||
        range.end !== requestedEnd ||
        (range.total !== null && range.total !== this.options.size)
      ) {
        await discardBody(response)
        throw new DownloadError(`unexpected Content-Range for bytes ${from}-${requestedEnd}`, 'download_failed')
      }

      const reader = response.body.getReader()
      let seen = 0
      try {
        while (room() > 0) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.byteLength === 0) continue
          const now = Date.now()
          attempt.lastByteAt = now
          this.lastByteAt = now
          if (chunk.firstByteAt === 0) chunk.firstByteAt = now
          if (seen === 0) this.ttfbMs += (now - requestedAt - this.ttfbMs) * 0.3
          seen += value.byteLength
          if (from + seen - 1 > requestedEnd) {
            throw new DownloadError('a range response ran past the requested end', 'download_failed')
          }
          // 等这次 read 的期间后半段可能已被偷走：多出来的归新主人，丢掉。
          const keep = Math.min(value.byteLength, Math.max(0, room()))
          if (keep > 0) {
            pieces.push(Buffer.from(value.buffer, value.byteOffset, keep))
            pieceBytes += keep
            chunk.buffered = pieceBytes
            this.netBytes += keep
            if (pieceBytes >= this.tuning.writeBatchBytes) await flush()
            this.emitProgress(false)
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      await flush()
      if (chunk.start + chunk.written <= chunk.end) {
        throw new DownloadError(`range response ended early at byte ${chunk.start + chunk.written}`, 'download_failed')
      }
    } catch (error) {
      // 已收到的前一截是好数据（起点核对过、没越界），写下去，下次从后面接着要。
      try {
        await flush()
      } catch {
        // 写盘失败就当这一截没收到，下次从 written 重新要，不会错位。
      }
      if (attempt.stalled && !this.controller.signal.aborted) {
        throw new DownloadError('a download connection stalled', 'download_stalled')
      }
      throw error
    } finally {
      chunk.buffered = 0
      chunk.attempt = null
      this.attempts.delete(attempt)
      link.dispose()
    }
  }

  /** 签名地址过期：重走一遍重定向。几条连接同时撞上只让一条去换。 */
  private refreshUrl(seenGeneration: number): Promise<boolean> {
    if (this.urlGeneration !== seenGeneration) return Promise.resolve(true)
    if (!this.urlRefreshing) {
      if (this.urlRefreshes >= this.tuning.maxUrlRefreshes) return Promise.resolve(false)
      this.urlRefreshes += 1
      this.urlRefreshing = this.probeRange()
        .then((url) => {
          if (!url) return false
          this.url = url
          this.urlGeneration += 1
          return true
        })
        .catch(() => false)
        .finally(() => {
          this.urlRefreshing = null
        })
    }
    return this.urlRefreshing
  }

  private saveResume(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.resumeSavedAt < this.tuning.resumeSaveIntervalMs) return
    this.resumeSavedAt = now
    const { identity, size, resumePath } = this.options
    const snapshot = JSON.stringify({ kind: RESUME_KIND, format: RESUME_FORMAT, ...identity, size, done: this.done })
    // 串成一条链，并且先写临时文件再改名：记录要么是旧的要么是新的，不会是半截。
    this.persist = this.persist
      .then(async () => {
        await fsp.writeFile(`${resumePath}.tmp`, snapshot)
        await fsp.rename(`${resumePath}.tmp`, resumePath)
      })
      .catch(() => undefined)
  }

  // ---- 看门狗、测速、连接数爬升 ----

  private tick(): void {
    if (this.finished || this.controller.signal.aborted) return
    const now = Date.now()
    const span = now - this.sampleAt
    if (span > 0) {
      const instant = ((this.netBytes - this.sampleBytes) * 1000) / span
      this.rate = this.rateSeeded ? this.rate + (instant - this.rate) * (1 - Math.exp(-span / RATE_TAU_MS)) : instant
      this.rateSeeded = this.rateSeeded || instant > 0
      this.sampleAt = now
      this.sampleBytes = this.netBytes
    }
    // 两条时限一起才封得住：每 30 秒吐 1 字节的连接永远不算停滞，但也永远下不完。
    if (now - this.lastByteAt > this.tuning.stallTimeoutMs) return this.abort('stalled')
    if (now - this.startedAt > this.tuning.totalTimeoutMs) return this.abort('timeout')
    for (const attempt of this.attempts) {
      if (now - attempt.lastByteAt > this.tuning.connectionStallMs) {
        attempt.stalled = true
        attempt.controller.abort()
      }
    }
    this.emitProgress(false)
  }

  /** 服务器明确要求降速（429/503）：连接数减半，多出来的 worker 下完手上这块就退。 */
  private easeOff(): void {
    this.target = Math.max(2, Math.floor(this.target / 2))
  }

  private abort(reason: 'stalled' | 'timeout'): void {
    this.abortReason = reason
    this.controller.abort()
  }

  private abortError(): DownloadError | null {
    if (this.abortReason === 'stalled') return new DownloadError('the download stalled and was aborted', 'download_stalled')
    if (this.abortReason === 'timeout') {
      return new DownloadError('the download exceeded its total time budget', 'download_timeout')
    }
    return null
  }

  private emitProgress(force: boolean): void {
    const { onProgress, size } = this.options
    const now = Date.now()
    if (!onProgress || (!force && now - this.progressAt < this.tuning.progressIntervalMs)) return
    this.progressAt = now
    let buffered = 0
    for (const chunk of this.inflight) buffered += chunk.buffered
    onProgress({
      received: Math.min(size, this.doneBytes + buffered),
      total: size,
      bytesPerSecond: Math.max(0, Math.round(this.rate)),
      // 在途请求数，而不是 worker 数：等着接尾巴的空闲 worker 不算在下载。
      connections: Math.max(1, this.attempts.size),
    })
  }
}

// ---- 零件 ----------------------------------------------------------------------

/**
 * 读续传记录。身份、大小、格式全对得上，`.part` 也还是预分配的大小，才返回已落盘的区间；
 * 否则把 `.part` 和记录一起删掉，从头来。
 */
async function loadResume(options: DownloadOptions): Promise<ByteRange[]> {
  const { partPath, resumePath, identity, size } = options
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(resumePath, 'utf8'), fsp.stat(partPath)])
    const record = JSON.parse(raw) as Record<string, unknown> | null
    if (
      record &&
      record.kind === RESUME_KIND &&
      record.format === RESUME_FORMAT &&
      record.version === identity.version &&
      record.assetName === identity.assetName &&
      record.digest === identity.digest &&
      record.size === size &&
      stat.size === size
    ) {
      const done = sanitizeRanges(record.done, size)
      if (done) return done
    }
  } catch {
    // 没有记录、读不了、JSON 坏了：都按"没有可续的"处理。
  }
  await Promise.all([partPath, resumePath, `${resumePath}.tmp`].map((f) => fsp.rm(f, { force: true })))
  return []
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function newChunk(start: number, end: number): Chunk {
  return { start, end, written: 0, buffered: 0, startedAt: Date.now(), firstByteAt: 0, attempt: null }
}

/** 跟着 parent 一起取消、但也能单独取消的 controller。 */
function linkController(parent: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onAbort, { once: true })
  return { controller, dispose: () => parent.removeEventListener('abort', onAbort) }
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function writeAt(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, position + offset)
    if (bytesWritten <= 0) throw new DownloadError('short write while saving the download', 'download_failed')
    offset += bytesWritten
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: MIB })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
