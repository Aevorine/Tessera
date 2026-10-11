package com.tessera.crossdevice

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 从 GitHub Release 检查并安装更新。
 *
 * "自动"只自动到检查：安卓不允许旁加载的应用静默安装另一个包，最后一步永远是系统自己的
 * 确认框。自动模式（默认）每次打开应用查一次，手动模式只在按「检查更新」时查。
 *
 * 信任模型：系统强制"签名相同才允许覆盖安装"，所以不用自己验签；HTTPS 只保证确实来自
 * GitHub。要自己守住的只有下载来源——每一跳都只认 GitHub 的域名。
 */
object Updater {

    private const val PREFS = "tessera-update"
    private const val KEY_AUTO = "auto_check"

    private const val REPO = "Aevorine/Tessera"
    private const val LATEST_URL = "https://api.github.com/repos/$REPO/releases/latest"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 30_000
    private const val MAX_REDIRECTS = 5

    /** release 元数据正常只有几十 KB。给足余量，但不给无限。 */
    private const val MAX_METADATA_BYTES = 1 * 1024 * 1024

    /** APK 目前 35 MB 左右。留足余量，防止被一个无限长的响应撑爆磁盘。 */
    private const val MAX_APK_BYTES = 150L * 1024 * 1024

    /** 小于它不分段：握手开销比省下的时间多。 */
    private const val PARALLEL_MIN_BYTES = 4L * 1024 * 1024

    private fun prefs(c: Context): SharedPreferences =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isAutoCheck(c: Context): Boolean = prefs(c).getBoolean(KEY_AUTO, true)

    fun setAutoCheck(c: Context, auto: Boolean) {
        prefs(c).edit().putBoolean(KEY_AUTO, auto).apply()
    }

    /** 检查结果。`available` 为假时 `version`/`url` 无意义。 */
    data class Result(
        val available: Boolean,
        val version: String = "",
        val currentVersion: String = "",
        val url: String = "",
        val sizeBytes: Long = 0,
        val notes: String = "",
    )

    class UpdateError(val code: String, message: String) : Exception(message)

    /**
     * 查一次 GitHub。阻塞，必须在后台线程调用。
     *
     * 匿名请求下 404 = 仓库私有或不存在（GitHub 故意不区分），重试没有意义，所以单列错误码。
     */
    fun check(c: Context): Result {
        val conn = (URL(LATEST_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
        }
        val body: String
        try {
            when (val code = conn.responseCode) {
                200 -> Unit
                404 -> throw UpdateError("update_source_unreachable", "release feed not publicly reachable")
                403, 429 -> throw UpdateError("update_rate_limited", "GitHub rate limit hit (HTTP $code)")
                else -> throw UpdateError("github_api_error", "GitHub API returned HTTP $code")
            }
            body = conn.inputStream.use { it.readBytes(MAX_METADATA_BYTES).toString(Charsets.UTF_8) }
        } finally {
            conn.disconnect()
        }

        val json = JSONObject(body)
        val tag = json.optString("tag_name").trim().removePrefix("v")
        val current = currentVersion(c)
        if (tag.isEmpty()) throw UpdateError("github_api_error", "release has no tag_name")

        // release 里同时挂着 Windows 的 exe，只挑 .apk。
        val assets = json.optJSONArray("assets") ?: throw UpdateError("missing_asset", "release has no assets")
        var url = ""
        var size = 0L
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            if (!a.optString("name").endsWith(".apk", ignoreCase = true)) continue
            url = a.optString("browser_download_url")
            size = a.optLong("size")
            break
        }
        if (url.isEmpty()) throw UpdateError("missing_asset", "release has no .apk asset")

        return Result(
            available = isNewer(tag, current),
            version = tag,
            currentVersion = current,
            url = url,
            sizeBytes = size,
            notes = json.optString("name").ifEmpty { tag },
        )
    }

    fun currentVersion(c: Context): String =
        runCatching {
            @Suppress("DEPRECATION")
            c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: ""
        }.getOrDefault("")

    /** 语义化版本比较，只比数字段；字符串比较会把 "0.10.0" 判成比 "0.9.0" 旧。 */
    internal fun isNewer(remote: String, local: String): Boolean {
        val r = parse(remote)
        val l = parse(local)
        for (i in 0 until maxOf(r.size, l.size)) {
            val a = r.getOrElse(i) { 0 }
            val b = l.getOrElse(i) { 0 }
            if (a != b) return a > b
        }
        return false
    }

    private fun parse(v: String): List<Int> =
        v.trim().removePrefix("v").split("-", "+")[0]
            .split(".")
            .map { it.toIntOrNull() ?: 0 }

    /** 更新包只允许来自 GitHub 自己控制的 HTTPS 域名。 */
    internal fun isTrustedDownloadUrl(value: String): Boolean =
        runCatching {
            val parsed = URL(value)
            val host = parsed.host.lowercase()
            parsed.protocol.equals("https", ignoreCase = true) &&
                (
                    host == "github.com" ||
                        host.endsWith(".github.com") ||
                        host == "objects.githubusercontent.com" ||
                        host.endsWith(".githubusercontent.com")
                    )
        }.getOrDefault(false)

    internal fun resolveTrustedRedirect(currentUrl: String, location: String): String {
        val resolved = runCatching { URL(URL(currentUrl), location).toExternalForm() }
            .getOrElse { throw UpdateError("untrusted_host", "invalid update redirect") }
        if (!isTrustedDownloadUrl(resolved)) {
            throw UpdateError("untrusted_host", "refusing update redirect")
        }
        return resolved
    }

    /**
     * 手动跟随重定向，每一跳都重新校验来源（自动跟随不会把最终地址交给我们复核）。
     * 返回连接和它最终落在的地址——分段请求直接打那个地址，不必每段重新 302。
     */
    private fun openTrusted(initialUrl: String, range: String? = null): Pair<HttpURLConnection, String> {
        var currentUrl = initialUrl
        var redirectCount = 0
        while (true) {
            if (!isTrustedDownloadUrl(currentUrl)) {
                throw UpdateError("untrusted_host", "refusing untrusted update source")
            }
            val conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = false
                // 自己处理字节范围，不要透明 gzip 改掉长度。
                setRequestProperty("Accept-Encoding", "identity")
                if (range != null) setRequestProperty("Range", range)
            }
            val code = conn.responseCode
            if (code !in setOf(301, 302, 303, 307, 308)) return conn to currentUrl

            val location = conn.getHeaderField("Location").orEmpty()
            conn.disconnect()
            if (location.isEmpty() || redirectCount >= MAX_REDIRECTS) {
                throw UpdateError("untrusted_host", "update redirect chain is invalid")
            }
            currentUrl = resolveTrustedRedirect(currentUrl, location)
            redirectCount += 1
        }
    }

    /**
     * 探 CDN 认不认 Range，顺便拿到重定向后的最终地址。要的是 `bytes=0-0` 的 206 且总长
     * 等于期望大小；返回 null 表示别分段。
     */
    private fun probeRange(url: String, size: Long): String? {
        val (conn, finalUrl) = try {
            openTrusted(url, "bytes=0-0")
        } catch (e: UpdateError) {
            throw e
        } catch (e: Exception) {
            return null
        }
        try {
            if (conn.responseCode != 206) return null
            return finalUrl.takeIf { conn.getHeaderField("Content-Range")?.trim() == "bytes 0-0/$size" }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 下载 APK 到应用私有目录。阻塞，必须在后台线程调用。
     *
     * `onProgress(已下载, 总大小, 字节/秒)` 已串行化并节流，调用方可以直接用。
     */
    fun downloadApk(c: Context, url: String, expectedBytes: Long, onProgress: (Long, Long, Long) -> Unit): File {
        val dir = File(c.filesDir, "update").apply { mkdirs() }
        // 先清掉旧的：别让失败的半个包留着占地方，也别装到旧包。
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "tessera-update.apk")
        if (expectedBytes > MAX_APK_BYTES) throw UpdateError("download_failed", "update is implausibly large")

        try {
            // 探不通就退回单流：分段只是提速，不能变成新的故障点。
            val cdnUrl = if (expectedBytes >= PARALLEL_MIN_BYTES) probeRange(url, expectedBytes) else null
            if (cdnUrl != null) {
                SegmentedDownload(
                    totalBytes = expectedBytes,
                    target = out,
                    open = { target, from, to -> openTrusted(target, "bytes=$from-$to").first },
                    resolve = {
                        probeRange(url, expectedBytes)
                            ?: throw UpdateError("download_failed", "could not refresh the download URL")
                    },
                    onProgress = onProgress,
                ).run(cdnUrl)
            } else {
                downloadSingleStream(url, expectedBytes, out, onProgress)
            }
        } catch (e: Exception) {
            out.delete()
            // 界面只认 untrusted_host 和 download_failed 两种下载错误。
            throw if (e is UpdateError && e.code == "untrusted_host") e
            else UpdateError("download_failed", e.message ?: e.javaClass.simpleName)
        }
        return out
    }

    /** 一条连接从头下到尾。CDN 不认 Range 或包太小时走这里。 */
    private fun downloadSingleStream(url: String, expectedBytes: Long, out: File, onProgress: (Long, Long, Long) -> Unit) {
        val conn = openTrusted(url).first
        try {
            val code = conn.responseCode
            if (code != 200) throw UpdateError("download_failed", "download returned HTTP $code")

            val total = if (expectedBytes > 0) expectedBytes else conn.contentLengthLong.coerceAtLeast(0)
            if (total > MAX_APK_BYTES) throw UpdateError("download_failed", "update is implausibly large")

            var done = 0L
            val started = System.nanoTime()
            conn.inputStream.use { input ->
                out.outputStream().use { sink ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        sink.write(buf, 0, n)
                        done += n
                        if (done > MAX_APK_BYTES) throw UpdateError("download_failed", "update exceeded size cap")
                        val seconds = (System.nanoTime() - started) / 1e9
                        onProgress(done, total, if (seconds > 0) (done / seconds).toLong() else 0)
                    }
                }
            }
            if (total > 0 && done != total) {
                // 断了的包装上去只会报"解析失败"，在这里说清楚。
                throw UpdateError("download_failed", "download truncated at $done of $total bytes")
            }
        } finally {
            conn.disconnect()
        }
    }

    /** 交给系统安装：系统弹自己的确认框，签名不一致会被它直接拒绝。 */
    fun installApk(c: Context, apk: File) {
        val uri: Uri = FileProvider.getUriForFile(c, "${c.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        c.startActivity(intent)
    }

    /** 系统设置里「允许安装未知应用」对本应用是否已打开。 */
    fun canRequestInstall(c: Context): Boolean =
        runCatching { c.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

    fun openInstallPermissionSettings(c: Context) {
        val intent = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${c.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        c.startActivity(intent)
    }

    /** 读满 [limit] 就停，不给对面用无限长的响应把我们撑爆的机会。 */
    private fun java.io.InputStream.readBytes(limit: Int): ByteArray {
        val buffer = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        while (buffer.size() < limit) {
            val n = read(chunk)
            if (n <= 0) break
            buffer.write(chunk, 0, n)
        }
        return buffer.toByteArray()
    }
}
