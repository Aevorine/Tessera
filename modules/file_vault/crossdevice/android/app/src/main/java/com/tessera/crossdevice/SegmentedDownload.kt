package com.tessera.crossdevice

import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * 多连接分段下载。只管字节怎么搬过来：每个请求都经调用方给的 [open]（由它逐跳校验来源），
 * 每段只收自己那一截，文件预分配为期望大小，磁盘上不可能多出一个字节。
 *
 * 为什么要分段：发布包由 CDN 按连接限速，单连接只吃得到带宽的一小截；实测吞吐随连接数
 * 近乎线性增长。不依赖 Android，JVM 单元测试直接起本地服务器跑（SegmentedDownloadTest）。
 */
internal class SegmentedDownload(
    private val totalBytes: Long,
    private val target: File,
    /** 打开 `url` 的 `bytes=from-to`。必须自己校验来源、处理重定向。 */
    private val open: (url: String, from: Long, to: Long) -> HttpURLConnection,
    /** 签名地址过期时重新解析出一个新的。 */
    private val resolve: () -> String,
    private val onProgress: (done: Long, total: Long, bytesPerSecond: Long) -> Unit,
    private val connections: Int = CONNECTIONS,
    private val chunkBytes: Long = chunkSizeFor(totalBytes, connections),
) {
    private val cursor = AtomicLong(0)
    private val received = AtomicLong(0)
    private val failure = AtomicReference<Throwable?>(null)
    private val active = ConcurrentHashMap.newKeySet<HttpURLConnection>()

    private val urlLock = Any()
    private var url = ""
    private var urlGeneration = 0
    private var urlRefreshes = 0

    private val progressLock = Any()
    private val lastReportNanos = AtomicLong(0)
    private var sampleNanos = System.nanoTime()
    private var sampleBytes = 0L
    private var rate = 0.0

    fun run(initialUrl: String) {
        url = initialUrl
        RandomAccessFile(target, "rw").use { it.setLength(totalBytes) }
        val chunks = (totalBytes + chunkBytes - 1) / chunkBytes
        val threads = List(minOf(connections.toLong(), chunks).toInt()) { index ->
            Thread({ runWorker() }, "tessera-update-$index").apply { isDaemon = true; start() }
        }
        threads.forEach { it.join() }
        failure.get()?.let { throw it }
        if (received.get() != totalBytes) {
            throw Updater.UpdateError("download_failed", "download ended with bytes missing")
        }
    }

    private fun runWorker() {
        try {
            val buffer = ByteArray(BUFFER_BYTES)
            RandomAccessFile(target, "rw").use { file ->
                while (failure.get() == null) {
                    val start = cursor.getAndAdd(chunkBytes)
                    if (start >= totalBytes) return
                    fetchChunk(file, buffer, start, minOf(totalBytes, start + chunkBytes) - 1)
                }
            }
        } catch (e: Throwable) {
            // 一段彻底失败就整体停：拼不出完整文件了。掐掉其余连接，别让它们读到超时。
            if (failure.compareAndSet(null, e)) active.forEach { it.disconnect() }
        }
    }

    /** 下一段，带重试；每次都从已写盘的最后一个字节接着要。 */
    private fun fetchChunk(file: RandomAccessFile, buffer: ByteArray, start: Long, end: Long) {
        var position = start
        var failures = 0
        while (position <= end && failure.get() == null) {
            val before = position
            val (currentUrl, generation) = synchronized(urlLock) { url to urlGeneration }
            var conn: HttpURLConnection? = null
            try {
                conn = open(currentUrl, position, end).also { active.add(it) }
                when (val code = conn.responseCode) {
                    206 -> Unit
                    // 签名地址过期不是这一段的错：换个新地址，不记失败。
                    401, 403, 410 -> {
                        conn.disconnect()
                        refreshUrl(generation)
                        continue
                    }
                    else -> throw Updater.UpdateError("download_failed", "range request returned HTTP $code")
                }
                // 必须正好是要的那一段：起点错了，字节就写到文件的错误位置上。
                if (conn.getHeaderField("Content-Range")?.trim() != "bytes $position-$end/$totalBytes") {
                    throw Updater.UpdateError("download_failed", "unexpected Content-Range")
                }
                conn.inputStream.use { input ->
                    file.seek(position)
                    while (position <= end) {
                        val n = input.read(buffer, 0, minOf(buffer.size.toLong(), end - position + 1).toInt())
                        if (n < 0) break
                        file.write(buffer, 0, n)
                        position += n
                        report(n)
                    }
                }
                if (position <= end) throw Updater.UpdateError("download_failed", "range response ended early")
            } catch (e: Exception) {
                if (failure.get() != null) return
                if (e is Updater.UpdateError && (e.code == "untrusted_host" || e.code == "url_expired")) throw e
                // 这次尝试真的往前走了就不记失败：线路时断时续但在走，就让它续。
                if (position - before < FORGIVE_BYTES) failures += 1
                if (failures >= MAX_ATTEMPTS) throw e
                conn?.disconnect()
                Thread.sleep(RETRY_BASE_MS shl maxOf(0, failures - 1))
            } finally {
                conn?.let { active.remove(it) }
            }
        }
    }

    /** 几条连接同时撞上过期，只让一条去换，其余直接用新的。 */
    private fun refreshUrl(seenGeneration: Int) {
        synchronized(urlLock) {
            if (urlGeneration != seenGeneration) return
            if (urlRefreshes >= MAX_URL_REFRESHES) {
                throw Updater.UpdateError("url_expired", "the CDN keeps rejecting the download URL")
            }
            urlRefreshes += 1
            url = resolve()
            urlGeneration += 1
        }
    }

    /** 进度回调串行化并节流到约每 100 ms 一次，调用方不用再考虑多线程。 */
    private fun report(bytes: Int) {
        val done = received.addAndGet(bytes.toLong())
        val now = System.nanoTime()
        val last = lastReportNanos.get()
        if (done < totalBytes && now - last < REPORT_INTERVAL_NANOS) return
        if (!lastReportNanos.compareAndSet(last, now) && done < totalBytes) return
        synchronized(progressLock) {
            val seconds = (now - sampleNanos) / 1e9
            if (seconds > 0) {
                val instant = (done - sampleBytes) / seconds
                rate = if (rate == 0.0) instant else rate + (instant - rate) * RATE_SMOOTHING
                sampleNanos = now
                sampleBytes = done
            }
            onProgress(done, totalBytes, rate.toLong())
        }
    }

    companion object {
        /** 手机端取 8 条：包只有三四十兆，再多连接握手的开销就压过收益了。 */
        const val CONNECTIONS = 8
        private const val BUFFER_BYTES = 64 * 1024
        private const val MIN_CHUNK_BYTES = 1L * 1024 * 1024
        private const val MAX_CHUNK_BYTES = 4L * 1024 * 1024
        private const val MAX_ATTEMPTS = 3
        private const val FORGIVE_BYTES = 128L * 1024
        private const val RETRY_BASE_MS = 500L
        private const val MAX_URL_REFRESHES = 4
        private const val REPORT_INTERVAL_NANOS = 100_000_000L
        private const val RATE_SMOOTHING = 0.3

        /** 每条连接大约两段：段够大，请求往返的开销小；又不至于让最后一段拖尾太久。 */
        fun chunkSizeFor(totalBytes: Long, connections: Int): Long =
            (totalBytes / (connections * 2L)).coerceIn(MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)
    }
}
