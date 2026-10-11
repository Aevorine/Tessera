package com.tessera.crossdevice

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import java.io.File

/**
 * 在 content:// 与协议核心的普通文件路径之间搬运。
 *
 * 核心是共用的 Go 代码用 os.Open 读写路径，而 Android 10+ 给的是 content:// URI。
 * 发送前复制到应用私有缓存再交路径，接收后落私有目录再搬到 SAF 目录；
 * 多一次复制，换来核心里零 Android 特判。
 */
object FileBridge {

    private const val PREFS = "tessera-crossdevice"
    private const val KEY_SAVE_TREE = "save_tree_uri"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---------- 接收位置 ----------

    /** 用户选定的接收目录（SAF 树 URI）。没选过返回 null，此时文件留在应用私有目录。 */
    fun saveTree(context: Context): Uri? =
        prefs(context).getString(KEY_SAVE_TREE, null)?.let(Uri::parse)

    /** 记住用户选的接收目录；必须同时 takePersistableUriPermission，否则进程重启后授权失效。 */
    fun rememberSaveTree(context: Context, uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        prefs(context).edit().putString(KEY_SAVE_TREE, uri.toString()).apply()
    }

    /** 给界面显示用的目录名。没选过就返回 null，由调用方显示「默认位置」。 */
    fun saveTreeLabel(context: Context): String? {
        val uri = saveTree(context) ?: return null
        return DocumentFile.fromTreeUri(context, uri)?.name
    }

    // ---------- 发送：content:// → 真实路径 ----------

    /** 把选中的内容复制到缓存并返回真实路径；复制失败的一条跳过，不拖垮整批。 */
    fun stageForSending(context: Context, uris: List<Uri>): List<String> {
        val root = File(context.cacheDir, "outgoing").apply { mkdirs() }
        purgeStaleStaging(root)

        // 每批、每个文件各占独立子目录，文件名原样保留。平铺会让同名文件（不同相册的 IMG_0001.jpg）
        // 互相覆盖，也会让上一批正在读的源文件被改写，导致接收端整体校验失败。
        val batch = File(root, "b${System.nanoTime()}").apply { mkdirs() }
        val staged = mutableListOf<String>()
        for ((i, uri) in uris.withIndex()) {
            val name = displayName(context, uri) ?: continue
            val dir = File(batch, i.toString()).apply { mkdirs() }
            val target = File(dir, name)
            runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    target.outputStream().use { output -> input.copyTo(output, 1 shl 20) }
                } ?: return@runCatching
                staged += target.absolutePath
            }
        }
        return staged
    }

    /**
     * 清理早先批次的暂存，只动超过六小时未修改的目录：几十 GB 的发送可能很久，不能删还在读的源文件。
     */
    private fun purgeStaleStaging(root: File) {
        val cutoff = System.currentTimeMillis() - 6L * 60 * 60 * 1000
        root.listFiles()?.forEach { entry ->
            val newest = entry.walkTopDown().maxOfOrNull { it.lastModified() } ?: entry.lastModified()
            if (newest < cutoff) entry.deleteRecursively()
        }
    }

    /** 取 content:// 的显示文件名。取不到就用 URI 的最后一段兜底。 */
    private fun displayName(context: Context, uri: Uri): String? {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) return sanitize(c.getString(idx))
                }
            }
        return uri.lastPathSegment?.substringAfterLast('/')?.let(::sanitize)
    }

    /** 清掉文件名里的路径分隔符：名字来自别的应用，`../../evil` 会让复制目标逃出缓存目录。 */
    private fun sanitize(name: String?): String? {
        val cleaned = name?.replace(Regex("""[/\\]"""), "_")?.trim()
        return cleaned?.takeIf { it.isNotEmpty() && it != "." && it != ".." }
    }

    // ---------- 接收：私有目录 → 用户选定的 SAF 目录 ----------

    /**
     * 把收到的文件搬到用户选定目录；没选过目录或失败时保留原文件并返回 false，绝不因搬运失败而删除。
     */
    fun deliverToUserFolder(context: Context, received: File): Boolean {
        val tree = saveTree(context) ?: return false
        val root = DocumentFile.fromTreeUri(context, tree) ?: return false
        return runCatching {
            // 收到文件夹里的文件时在接收根目录下按相对路径重建目录，否则目录结构丢失、不同子目录的同名文件会互
            // 相改名。
            val downloads = File(context.filesDir, "downloads")
            val rel = runCatching { received.relativeTo(downloads) }.getOrNull()
            val parts = rel?.path?.split(File.separatorChar)?.filter { it.isNotEmpty() }.orEmpty()
            var dir: DocumentFile = root
            for (part in parts.dropLast(1)) {
                dir = dir.findFile(part)?.takeIf { it.isDirectory }
                    ?: dir.createDirectory(part)
                    ?: return false
            }
            val doc = dir.createFile(mimeOf(received.name), received.name) ?: return false
            context.contentResolver.openOutputStream(doc.uri)?.use { out ->
                received.inputStream().use { it.copyTo(out, 1 shl 20) }
            } ?: return false
            received.delete()
            // 搬空之后把留在私有目录里的空文件夹一并清掉，免得越攒越多。
            var parent = received.parentFile
            while (parent != null && parent != downloads && parent.isDirectory &&
                parent.list().isNullOrEmpty() && parent.delete()
            ) {
                parent = parent.parentFile
            }
            true
        }.getOrDefault(false)
    }

    /**
     * 按扩展名猜 MIME。
     * 不能一律传 octet-stream：DocumentsProvider 会按类型补扩展名，落地成 `photo.jpg.bin`，相册看不到。
     * 猜不出时才回落（此时本来就没有扩展名）。
     */
    private fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext.isEmpty()) return "application/octet-stream"
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: "application/octet-stream"
    }
}
