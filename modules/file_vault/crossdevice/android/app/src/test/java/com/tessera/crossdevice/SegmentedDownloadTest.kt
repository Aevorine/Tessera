package com.tessera.crossdevice

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** 起一个真的本地 HTTP 服务器，让下载器真的把文件下回来再比字节。 */
class SegmentedDownloadTest {

    private val body = ByteArray(3 * 1024 * 1024).also { bytes ->
        var x = 0x2545F491
        for (i in bytes.indices) {
            x = x xor (x shl 13)
            x = x xor (x ushr 17)
            x = x xor (x shl 5)
            bytes[i] = x.toByte()
        }
    }
    private val target = File.createTempFile("tessera-update", ".apk")
    private val pool = Executors.newCachedThreadPool()
    private val listener = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val requests = AtomicInteger(0)
    private val concurrent = AtomicInteger(0)
    private val peakConcurrent = AtomicInteger(0)
    private val progress = Collections.synchronizedList(mutableListOf<Pair<Long, Long>>())

    /** 一个请求：它要的路径和范围，以及回给它的那条连接。 */
    private class Request(val index: Int, val path: String, val from: Int, val to: Int, val out: OutputStream)

    @After
    fun tearDown() {
        listener.close()
        pool.shutdownNow()
        target.delete()
    }

    /** [respond] 自己回了就返回 true；返回 false 表示按规矩回 206。 */
    private fun start(respond: (Request) -> Boolean = { false }): String {
        pool.execute {
            while (!listener.isClosed) {
                val socket = runCatching { listener.accept() }.getOrNull() ?: break
                pool.execute { socket.use { serve(it, respond) } }
            }
        }
        return "http://127.0.0.1:${listener.localPort}/v1"
    }

    private fun serve(socket: Socket, respond: (Request) -> Boolean) {
        val now = concurrent.incrementAndGet()
        peakConcurrent.accumulateAndGet(now) { a, b -> maxOf(a, b) }
        try {
            val head = StringBuilder()
            val input = socket.getInputStream()
            while (!head.endsWith("\r\n\r\n")) {
                val c = input.read()
                if (c < 0) return
                head.append(c.toChar())
            }
            val path = head.substring(0, head.indexOf("\r\n")).split(" ")[1]
            val range = Regex("""(?i)range: bytes=(\d+)-(\d+)""").find(head)!!
            val request = Request(
                requests.getAndIncrement(), path, range.groupValues[1].toInt(), range.groupValues[2].toInt(),
                socket.getOutputStream(),
            )
            if (!respond(request)) send(request)
        } catch (_: Exception) {
            // 客户端先断开了：测试里这是预期的。
        } finally {
            concurrent.decrementAndGet()
        }
    }

    private fun send(r: Request, contentRange: String = "bytes ${r.from}-${r.to}/${body.size}", cutAfter: Int = -1) {
        val length = r.to - r.from + 1
        r.out.write(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: $contentRange\r\nContent-Length: $length\r\nConnection: close\r\n\r\n"
                .toByteArray(),
        )
        r.out.flush()
        // 稍微拖一下，让几条连接真的同时在途。
        Thread.sleep(15)
        r.out.write(body, r.from, if (cutAfter >= 0) minOf(cutAfter, length) else length)
        r.out.flush()
    }

    private fun download(url: String, resolve: () -> String = { throw AssertionError("unexpected URL refresh") }) {
        SegmentedDownload(
            totalBytes = body.size.toLong(),
            target = target,
            open = { u, from, to ->
                (URL(u).openConnection() as HttpURLConnection).apply { setRequestProperty("Range", "bytes=$from-$to") }
            },
            resolve = resolve,
            onProgress = { done, total, _ -> progress.add(done to total) },
            connections = 4,
            chunkBytes = 256L * 1024,
        ).run(url)
    }

    @Test
    fun fileArrivesIntactOverSeveralConnections() {
        download(start())
        assertArrayEquals(body, target.readBytes())
        assertTrue("never used more than one connection", peakConcurrent.get() > 1)
        assertEquals(body.size.toLong() to body.size.toLong(), progress.last())
        assertTrue("progress went backwards", progress.zipWithNext().all { (a, b) -> b.first >= a.first })
    }

    @Test
    fun droppedConnectionsAreRetriedFromTheLastByteOnDisk() {
        val url = start { request ->
            if (request.index >= 5) return@start false
            send(request, cutAfter = 100 * 1024)
            true
        }
        download(url)
        assertArrayEquals(body, target.readBytes())
    }

    @Test
    fun expiredUrlIsResolvedAgainInsteadOfFailing() {
        val refreshes = AtomicInteger(0)
        // 旧地址用过三次就过期，新地址一直有效。
        val base = start { request ->
            val expired = request.path.endsWith("/v1") && request.index >= 3
            if (expired) {
                request.out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            }
            expired
        }
        download(base) {
            refreshes.incrementAndGet()
            base.removeSuffix("/v1") + "/v2"
        }
        assertArrayEquals(body, target.readBytes())
        assertEquals(1, refreshes.get())
    }

    @Test
    fun responseForTheWrongRangeIsNeverAccepted() {
        val url = start { request ->
            send(request, contentRange = "bytes ${request.from + 1}-${request.to + 1}/${body.size}")
            true
        }
        try {
            download(url)
            fail("a mislabelled range was accepted")
        } catch (e: Updater.UpdateError) {
            assertEquals("download_failed", e.code)
        }
    }

    @Test
    fun chunkSizeKeepsRequestOverheadLowWithoutALongTail() {
        val mib = 1024L * 1024
        assertEquals(35 * mib / 16, SegmentedDownload.chunkSizeFor(35 * mib, 8))
        assertEquals(1 * mib, SegmentedDownload.chunkSizeFor(6 * mib, 8))
        assertEquals(4 * mib, SegmentedDownload.chunkSizeFor(500 * mib, 8))
    }
}
