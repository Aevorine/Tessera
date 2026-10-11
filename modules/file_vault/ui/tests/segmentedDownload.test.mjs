/**
 * 分段下载引擎的端到端测试：起一个真的本地 HTTP 服务器，让引擎真的把文件下回来再比字节。
 * 跑法：`npm run test:update`（需要 Node ≥ 22.6，直接加载 .ts）。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DownloadError,
  addRange,
  downloadFile,
  missingRanges,
  parseContentRange,
  rangeBytes,
  removeStaleParts,
  sanitizeRanges,
} from '../electron/segmentedDownload.ts'

const KIB = 1024
const MIB = 1024 * KIB

/** 把引擎的尺寸和时限按比例缩小，一个用例几百毫秒跑完。 */
const TUNING = {
  parallelMinBytes: 256 * KIB,
  connections: 6,
  firstChunkBytes: 128 * KIB,
  minChunkBytes: 64 * KIB,
  maxChunkBytes: MIB,
  chunkTargetMs: 200,
  chunkMinMs: 100,
  minSplitBytes: 32 * KIB,
  stealMinAloneMs: 300,
  stealMinGain: 0.4,
  rateSampleMs: 100,
  takeoverGraceMs: 300,
  rescueIntervalMs: 30,
  writeBatchBytes: 64 * KIB,
  headerTimeoutMs: 5_000,
  stallTimeoutMs: 5_000,
  connectionStallMs: 1_500,
  retryForgiveBytes: 16 * KIB,
  retryBaseMs: 20,
  progressIntervalMs: 20,
  resumeSaveIntervalMs: 20,
  tickMs: 25,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

function payload(size) {
  const out = Buffer.alloc(size)
  let x = 0x9e3779b9
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

/**
 * `/asset` 302 到 `/cdn?token=…`，跟 GitHub 的 release 下载同形。`behavior` 的各个钩子
 * 决定这台服务器怎么不守规矩。
 */
async function startServer(body, behavior = {}) {
  const stats = { assetHits: 0, chunkRequests: 0, bytesSent: 0, concurrent: 0, peakConcurrent: 0, sizes: [] }
  let token = 0

  const send = async (res, data, plan) => {
    const rate = plan.bytesPerSecond ?? 0
    const slice = plan.sliceBytes ?? (rate ? Math.max(KIB, Math.floor(rate / 20)) : 64 * KIB)
    let sent = 0
    while (sent < data.length && !res.destroyed) {
      let n = Math.min(slice, data.length - sent)
      if (plan.cutAfter !== undefined) n = Math.min(n, plan.cutAfter - sent)
      if (n <= 0) break
      if (rate) await sleep((n / rate) * 1000)
      if (res.destroyed) return
      // 回调在这一片真正交给内核（或连接已断）之后才触发，天然带背压。
      await new Promise((resolve) => res.write(data.subarray(sent, sent + n), resolve))
      sent += n
      stats.bytesSent += n
    }
    if (sent < data.length) {
      // 让已发出的字节先到对端，再掐线。
      await sleep(20)
      res.destroy()
    } else res.end()
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local')
    if (url.pathname === '/asset') {
      stats.assetHits += 1
      token += 1
      res.writeHead(302, { location: behavior.redirectTo ?? `/cdn?token=${token}` })
      res.end()
      return
    }
    if (behavior.rejectToken?.(Number(url.searchParams.get('token')), token, stats)) {
      res.writeHead(403)
      res.end()
      return
    }
    const match = behavior.ignoreRange ? null : /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match ? Number(match[2]) : body.length - 1
    const probe = match !== null && start === 0 && end === 0
    const headers = { 'content-length': end - start + 1 }
    if (match) headers['content-range'] = behavior.contentRange?.(start, end) ?? `bytes ${start}-${end}/${body.length}`
    res.writeHead(match ? 206 : 200, headers)
    if (probe) {
      res.end(body.subarray(0, 1))
      return
    }
    const index = stats.chunkRequests
    stats.chunkRequests += 1
    stats.sizes.push(end - start + 1)
    stats.concurrent += 1
    stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.concurrent)
    res.once('close', () => {
      stats.concurrent -= 1
    })
    send(res, body.subarray(start, end + 1), behavior.plan?.({ index, start, end, stats }) ?? {}).catch(() => res.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    stats,
    behavior,
    url: `${origin}/asset`,
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

async function withDownload(body, behavior, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-dl-'))
  const server = await startServer(body, behavior)
  const options = (extra = {}) => ({
    url: server.url,
    size: body.length,
    partPath: path.join(dir, 'app.exe.part'),
    resumePath: path.join(dir, 'app.exe.part.json'),
    identity: { version: '1.0.0', assetName: 'app.exe', digest: null },
    isAllowedUrl: (url) => new URL(url).hostname === '127.0.0.1',
    userAgent: 'test',
    tuning: TUNING,
    ...extra,
  })
  try {
    await run({ server, dir, options })
  } finally {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function codeOf(promise) {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof DownloadError, `expected a DownloadError, got ${String(error)}`)
    return error.code
  }
  return 'no error'
}

// ---- 区间运算 ----

test('ranges merge when they touch or overlap, and stay sorted', () => {
  const ranges = []
  addRange(ranges, 10, 19)
  addRange(ranges, 40, 49)
  addRange(ranges, 0, 4)
  assert.deepEqual(ranges, [[0, 4], [10, 19], [40, 49]])
  addRange(ranges, 5, 9)
  assert.deepEqual(ranges, [[0, 19], [40, 49]])
  addRange(ranges, 15, 45)
  assert.deepEqual(ranges, [[0, 49]])
  assert.equal(rangeBytes(ranges), 50)
})

test('missing ranges are the exact complement', () => {
  assert.deepEqual(missingRanges([], 10), [[0, 9]])
  assert.deepEqual(missingRanges([[0, 9]], 10), [])
  assert.deepEqual(missingRanges([[2, 3], [7, 8]], 10), [[0, 1], [4, 6], [9, 9]])
})

test('a resume record with any malformed range is rejected whole', () => {
  assert.deepEqual(sanitizeRanges([[0, 4], [5, 9]], 10), [[0, 9]])
  assert.equal(sanitizeRanges([[0, 10]], 10), null)
  assert.equal(sanitizeRanges([[5, 9], [0, 4]], 10), null)
  assert.equal(sanitizeRanges([[0, 4], [4, 9]], 10), null)
  assert.equal(sanitizeRanges([[3, 2]], 10), null)
  assert.equal(sanitizeRanges([[0.5, 2]], 10), null)
  assert.equal(sanitizeRanges('nope', 10), null)
})

test('Content-Range is parsed strictly', () => {
  assert.deepEqual(parseContentRange('bytes 5-9/100'), { start: 5, end: 9, total: 100 })
  assert.deepEqual(parseContentRange('bytes 5-9/*'), { start: 5, end: 9, total: null })
  assert.equal(parseContentRange('items 5-9/100'), null)
  assert.equal(parseContentRange(null), null)
})

// ---- 真下载 ----

test('a large file arrives intact over several connections', async () => {
  const body = payload(6 * MIB)
  await withDownload(body, { plan: () => ({ bytesPerSecond: 2 * MIB }) }, async ({ server, options }) => {
    const seen = []
    const result = await downloadFile(options({ onProgress: (p) => seen.push(p) }))
    assert.equal(result.mode, 'segmented')
    assert.equal(result.received, body.length)
    assert.equal(result.sha256, sha256(body))
    assert.deepEqual(await fs.readFile(options().partPath), body)
    assert.ok(server.stats.peakConcurrent > 1, 'never used more than one connection')

    assert.ok(seen.length > 2)
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].received >= seen[i - 1].received, 'progress went backwards')
    assert.equal(seen.at(-1).received, body.length)
    assert.ok(seen.every((p) => p.total === body.length && p.connections >= 1 && p.bytesPerSecond >= 0))
    assert.ok(seen.some((p) => p.bytesPerSecond > 0))
    // 下完后续传记录不该留下。
    await assert.rejects(fs.stat(options().resumePath))
  })
})

test('a server that ignores Range still works, over one stream', async () => {
  const body = payload(MIB)
  await withDownload(body, { ignoreRange: true }, async ({ server, options }) => {
    const result = await downloadFile(options())
    assert.equal(result.mode, 'single')
    assert.equal(result.sha256, sha256(body))
    assert.equal(server.stats.peakConcurrent, 1)
  })
})

test('a small file is not segmented', async () => {
  const body = payload(100 * KIB)
  await withDownload(body, {}, async ({ server, options }) => {
    const result = await downloadFile(options())
    assert.equal(result.mode, 'single')
    assert.equal(result.sha256, sha256(body))
    assert.equal(server.stats.chunkRequests, 1)
  })
})

test('a single stream that runs past the expected size is cut off', async () => {
  const body = payload(MIB)
  await withDownload(body, { ignoreRange: true }, async ({ options }) => {
    assert.equal(await codeOf(downloadFile(options({ size: body.length - 4096 }))), 'download_too_large')
  })
})

test('dropped connections are retried from the last byte on disk', async () => {
  const body = payload(3 * MIB)
  const plan = ({ index }) => (index < 6 ? { cutAfter: 80 * KIB } : {})
  await withDownload(body, { plan }, async ({ server, options }) => {
    const result = await downloadFile(options())
    assert.equal(result.sha256, sha256(body))
    assert.deepEqual(await fs.readFile(options().partPath), body)
    assert.ok(server.stats.chunkRequests > 6)
  })
})

test('a failed download resumes from the ranges already on disk', async () => {
  const body = payload(4 * MIB)
  const behavior = { broken: true }
  behavior.plan = ({ stats }) => (behavior.broken && stats.bytesSent > 1.5 * MIB ? { cutAfter: 0 } : {})
  await withDownload(body, behavior, async ({ server, options }) => {
    assert.equal(await codeOf(downloadFile(options())), 'download_failed')
    const record = JSON.parse(await fs.readFile(options().resumePath, 'utf8'))
    assert.ok(rangeBytes(record.done) >= MIB, 'nothing was recorded as done')

    behavior.broken = false
    const sentBefore = server.stats.bytesSent
    const result = await downloadFile(options())
    assert.equal(result.sha256, sha256(body))
    assert.equal(result.resumedBytes, rangeBytes(record.done))
    // 已落盘的区间没有被重新要一遍（留一点余量给收尾时被切走后丢弃的字节）。
    const resent = server.stats.bytesSent - sentBefore
    assert.ok(resent < body.length - result.resumedBytes + 512 * KIB, `re-downloaded ${resent} bytes`)
  })
})

test('a resume record for a different build is thrown away', async () => {
  const body = payload(2 * MIB)
  const behavior = { broken: true }
  behavior.plan = ({ stats }) => (behavior.broken && stats.bytesSent > MIB ? { cutAfter: 0 } : {})
  await withDownload(body, behavior, async ({ options }) => {
    assert.equal(await codeOf(downloadFile(options())), 'download_failed')
    behavior.broken = false
    const other = { version: '1.0.1', assetName: 'app.exe', digest: null }
    const result = await downloadFile(options({ identity: other }))
    assert.equal(result.resumedBytes, 0)
    assert.equal(result.sha256, sha256(body))
  })
})

test('an expired signed URL is re-resolved instead of failing the download', async () => {
  const body = payload(3 * MIB)
  // 第一个令牌用过 3 次就过期；之后发的令牌一直有效。
  const rejectToken = (used, _latest, stats) => used === 1 && stats.chunkRequests >= 3
  await withDownload(body, { rejectToken, plan: () => ({ bytesPerSecond: 4 * MIB }) }, async ({ server, options }) => {
    const result = await downloadFile(options())
    assert.equal(result.sha256, sha256(body))
    assert.ok(server.stats.assetHits >= 2, 'the URL was never refreshed')
  })
})

test('a redirect outside the allow-list is refused, not downgraded to a single stream', async () => {
  const body = payload(MIB)
  await withDownload(body, { redirectTo: 'http://attacker.invalid/app.exe' }, async ({ server, options }) => {
    assert.equal(await codeOf(downloadFile(options())), 'off_host_asset')
    assert.equal(server.stats.chunkRequests, 0)
  })
})

test('a response for the wrong byte range is never written', async () => {
  const body = payload(MIB)
  const contentRange = (start, end) => (start === 0 && end === 0 ? undefined : `bytes ${start + 1}-${end + 1}/${body.length}`)
  await withDownload(body, { contentRange }, async ({ options }) => {
    assert.equal(await codeOf(downloadFile(options())), 'download_failed')
  })
})

test('idle connections take over the tail of a crawling one', async () => {
  const body = payload(2 * MIB)
  // 第一条连接的第一块 16 KiB/s，128 KiB 要 8 秒；其余连接全速。
  const plan = ({ index }) => (index === 0 ? { bytesPerSecond: 16 * KIB } : {})
  await withDownload(body, { plan }, async ({ options }) => {
    const started = Date.now()
    const result = await downloadFile(options())
    assert.equal(result.sha256, sha256(body))
    assert.ok(result.steals >= 1, 'nothing was stolen from the slow connection')
    assert.ok(Date.now() - started < 4_000, `the slow connection held the download hostage for ${Date.now() - started}ms`)
  })
})

test('every configured connection is used from the first moment', async () => {
  const body = payload(6 * MIB)
  await withDownload(body, { plan: () => ({ bytesPerSecond: 400 * KIB }) }, async ({ server, options }) => {
    const result = await downloadFile(options())
    assert.equal(result.sha256, sha256(body))
    assert.equal(result.peakConnections, TUNING.connections)
    assert.equal(server.stats.peakConcurrent, TUNING.connections)
  })
})

test('chunks shrink towards the end so equal connections finish together, with nothing to steal', async () => {
  const body = payload(6 * MIB)
  const tuning = { ...TUNING, chunkTargetMs: 1_000 }
  await withDownload(body, { plan: () => ({ bytesPerSecond: 400 * KIB }) }, async ({ server, options }) => {
    const result = await downloadFile(options({ tuning }))
    assert.equal(result.sha256, sha256(body))
    const { sizes } = server.stats
    const tail = sizes.slice(-TUNING.connections).sort((a, b) => a - b)
    assert.ok(Math.max(...sizes) >= 300 * KIB, `mid-download chunks never grew: max ${Math.max(...sizes)}`)
    // 看中位数：最后几个请求里偶尔会混进一个更早切出来的大块。
    assert.ok(tail[tail.length >> 1] <= 0.6 * Math.max(...sizes), `the last chunks stayed large: ${tail.join(', ')}`)
    assert.equal(result.steals, 0)
  })
})

test('a server that asks to slow down gets fewer connections, and the download still completes', async () => {
  const body = payload(3 * MIB)
  let refused = 0
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (!match) {
      res.writeHead(400)
      res.end()
      return
    }
    const [start, end] = [Number(match[1]), Number(match[2])]
    // 前几个真正的分段请求一律 503：模拟 CDN 嫌连接太多。
    if (end > 0 && refused < 4) {
      refused += 1
      res.writeHead(503)
      res.end()
      return
    }
    res.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${body.length}` })
    res.end(body.subarray(start, end + 1))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-dl-'))
  try {
    const result = await downloadFile({
      url: `http://127.0.0.1:${server.address().port}/cdn`,
      size: body.length,
      partPath: path.join(dir, 'app.exe.part'),
      resumePath: path.join(dir, 'app.exe.part.json'),
      identity: { version: '1.0.0', assetName: 'app.exe', digest: null },
      isAllowedUrl: (url) => new URL(url).hostname === '127.0.0.1',
      userAgent: 'test',
      tuning: TUNING,
    })
    assert.equal(result.sha256, sha256(body))
    assert.equal(refused, 4)
  } finally {
    server.closeAllConnections()
    server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('stale partial downloads are removed, but only our own', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-dl-'))
  try {
    const write = (name, data) => fs.writeFile(path.join(dir, name), data)
    await write('old.exe.part', 'x')
    await write('old.exe.part.json', JSON.stringify({ kind: 'tessera-update-resume', assetName: 'old.exe' }))
    await write('new.exe.part', 'x')
    await write('new.exe.part.json', JSON.stringify({ kind: 'tessera-update-resume', assetName: 'new.exe' }))
    await write('theirs.part', 'x')
    await write('theirs.part.json', JSON.stringify({ kind: 'someone-else', assetName: 'theirs' }))
    await write('renamed.part.json', JSON.stringify({ kind: 'tessera-update-resume', assetName: 'new.exe' }))

    await removeStaleParts(dir, 'new.exe')
    assert.deepEqual(
      (await fs.readdir(dir)).sort(),
      ['new.exe.part', 'new.exe.part.json', 'renamed.part.json', 'theirs.part', 'theirs.part.json'],
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
