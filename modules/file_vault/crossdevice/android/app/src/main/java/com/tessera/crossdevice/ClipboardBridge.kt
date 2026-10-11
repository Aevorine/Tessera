package com.tessera.crossdevice

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import android.util.Base64
import org.json.JSONObject

/** 系统剪贴板的读写。属平台侧，Go 一概不碰：同一份协议核心要跑在 Windows 和 Android 上。 */
object ClipboardBridge {

    /** 把收到的内容写进系统剪贴板，选最合适的表示：有 HTML 就用 HTML，避免公式和富文本退化成源码。 */
    fun write(context: Context, data: JSONObject?) {
        val reps = data?.optJSONArray("reps") ?: return
        var plain: String? = null
        var html: String? = null
        var image: Pair<String, ByteArray>? = null

        for (i in 0 until reps.length()) {
            val rep = reps.optJSONObject(i) ?: continue
            val mime = rep.optString("mime")
            val raw = rep.optString("data").takeIf { it.isNotEmpty() } ?: continue
            if (mime.startsWith("image/")) {
                // 图片按原始字节收，绝不当成 UTF-8 字符串去解——那会把二进制
                // 里所有非法序列换成替换字符，得到一张永远打不开的图。
                runCatching { Base64.decode(raw, Base64.DEFAULT) }
                    .getOrNull()
                    ?.let { image = mime to it }
                continue
            }
            val decoded = runCatching {
                String(Base64.decode(raw, Base64.DEFAULT), Charsets.UTF_8)
            }.getOrNull() ?: continue
            when {
                mime.startsWith("text/html") -> html = decoded
                mime.startsWith("text/plain") -> plain = decoded
            }
        }

        // 图片优先。电脑上截个图复制过来，用户要的是那张图，
        // 而 Windows 截图时剪贴板里常常还挂着一个没用的文件名文本。
        val img = image
        if (img != null) {
            val uri = stageImage(context, img.first, img.second)
            if (uri != null) {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                if (runCatching { cm.setPrimaryClip(ClipData.newUri(context.contentResolver, "Tessera", uri)) }.isSuccess) {
                    return
                }
            }
            // 落盘失败就往下走文本兜底，总比什么都不放强。
        }

        if (plain == null && html == null) return
        val text = plain ?: stripTags(html!!)

        // 剪贴板经 Binder 传递，单次事务约 1 MB；超限 setPrimaryClip 会抛 TransactionTooLargeException，整
        // 条丢失。
        // 逐级退让：纯文本 + HTML → 仅纯文本 → content:// 形式。
        val richOk = html != null && text.length + html.length <= SAFE_CLIP_CHARS
        val sensitive = data.optBoolean("sensitive", false)
        val attempts = buildList<() -> ClipData?> {
            if (richOk) add { ClipData.newHtmlText("Tessera", text, html) }
            add { ClipData.newPlainText("Tessera", text) }
            add { stageText(context, text)?.let { ClipData.newUri(context.contentResolver, "Tessera", it) } }
        }
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        for (make in attempts) {
            val clip = runCatching { make() }.getOrNull() ?: continue
            // 协议事件提供的是 JSON 布尔字段 sensitive；安卓本地落剪贴板时把它映射成
            // 系统的敏感标记，避免输入法/剪贴板历史直接预览正文。
            if (sensitive) {
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
            }
            if (runCatching { cm.setPrimaryClip(clip) }.isSuccess) return
        }
        DiagnosticLog.record(context, "clip", "收到的内容写不进系统剪贴板", "${text.length} 字符")
    }

    /** 纯文本 + HTML 合计不超过这个字符数才一起放进剪贴板。 */
    private const val SAFE_CLIP_CHARS = 360_000

    private fun stageText(context: Context, text: String): android.net.Uri? = runCatching {
        val dir = java.io.File(context.filesDir, "cliptext").apply { mkdirs() }
        val f = java.io.File(dir, "clipboard.txt")
        f.writeText(text, Charsets.UTF_8)
        androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.updates", f)
    }.getOrNull()

    /** 往剪贴板放一段纯文本。给「复制本机地址」这类界面动作用——不走
     *  跨设备同步那条路，只是本机的复制。 */
    fun copyPlainText(context: Context, text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Tessera", text))
    }

    /** 读当前剪贴板纯文本；空剪贴板返回 null。 */
    fun readPlain(context: Context): String? {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        return clip.getItemAt(0).coerceToText(context)?.toString()?.takeIf { it.isNotEmpty() }
    }

    /**
     * 把内容打包成协议核心要的 `{preferred, reps:[{mime, data(base64)}]}`。
     *
     * Go 侧 send_clip 没有 reps 就返回"没有可发送的内容"，之前发的 `{"text"}` 它从不读。
     * mime 须与桌面 readLocalClipboard 逐字一致（`text/plain;charset=utf-8`、`text/html`），否则对端挑
     * 不出可用表示。
     */
    fun buildTextReps(text: String, html: String? = null): JSONObject {
        val reps = org.json.JSONArray()
        reps.put(
            JSONObject()
                .put("mime", MIME_PLAIN)
                .put("data", encode(text)),
        )
        if (!html.isNullOrEmpty() && html != text) {
            reps.put(
                JSONObject()
                    .put("mime", MIME_HTML)
                    .put("data", encode(html)),
            )
        }
        return JSONObject()
            .put("preferred", MIME_PLAIN)
            .put("reps", reps)
    }

    /**
     * 读当前剪贴板并打包成多表示结构；空剪贴板返回 null。
     * 图片要单独处理：剪贴板里是 content:// URI，须经 ContentResolver 读字节，不能 coerceToText。
     */
    fun readAsReps(context: Context): JSONObject? {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        val item = clip.getItemAt(0)

        val uri = item.uri
        if (uri != null) {
            val mime = context.contentResolver.getType(uri).orEmpty()
            if (mime.startsWith("image/")) {
                readImage(context, uri)?.let { bytes ->
                    val reps = org.json.JSONArray().put(
                        JSONObject()
                            .put("mime", mime)
                            .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)),
                    )
                    return JSONObject().put("preferred", mime).put("reps", reps)
                }
            }
        }

        val plain = item.coerceToText(context)?.toString()?.takeIf { it.isNotEmpty() } ?: return null
        return buildTextReps(plain, item.htmlText)
    }

    /**
     * 剪贴板图片大小上限；剪贴板同步内联在一条消息里，大图会堵住连接，该走文件传输。超限返回 null，调用
     * 方回落到文本。
     */
    private const val MAX_CLIP_IMAGE = 8 * 1024 * 1024

    private fun readImage(context: Context, uri: android.net.Uri): ByteArray? = runCatching {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buf = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(chunk)
                if (n <= 0) break
                buf.write(chunk, 0, n)
                if (buf.size() > MAX_CLIP_IMAGE) return null
            }
            buf.toByteArray()
        }
    }.getOrNull()

    /**
     * 把收到的图片落到应用私有目录，返回别的应用可读的 content:// URI。每次覆盖同一文件名，只存当前这一
     * 张，避免无声占用空间。
     */
    private fun stageImage(context: Context, mime: String, bytes: ByteArray): android.net.Uri? = runCatching {
        val dir = java.io.File(context.filesDir, "clipimg").apply { mkdirs() }
        val ext = when (mime) {
            "image/jpeg" -> "jpg"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            else -> "png"
        }
        val f = java.io.File(dir, "clipboard.$ext")
        f.writeBytes(bytes)
        // 顺手清掉上一次留下的、扩展名不同的那张，别在目录里积一堆。
        dir.listFiles()?.forEach { if (it.name != f.name) it.delete() }
        androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.updates",
            f,
        )
    }.getOrNull()

    /** base64 用 NO_WRAP：默认的 DEFAULT 会每 76 字符插一个换行，
     *  Go 的 StdEncoding 解不了带换行的串，长一点的内容就会解码失败。 */
    private fun encode(s: String): String =
        Base64.encodeToString(s.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

    private const val MIME_PLAIN = "text/plain;charset=utf-8"
    private const val MIME_HTML = "text/html"

    private fun stripTags(html: String): String =
        html.replace(Regex("<[^>]*>"), "").trim()
}
