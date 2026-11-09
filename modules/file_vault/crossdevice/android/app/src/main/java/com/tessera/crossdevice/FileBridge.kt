package com.tessera.crossdevice

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.annotation.RequiresApi
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import mobile.Mobile

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
        Thread({ recoverPending(context.applicationContext) }, "tessera-receive-recovery").start()
    }

    /** 给界面显示用的目录名。没选过就返回 null，由调用方显示「默认位置」。 */
    fun saveTreeLabel(context: Context): String? {
        val uri = saveTree(context) ?: return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            "${Environment.DIRECTORY_DOWNLOADS}/$PUBLIC_SUBDIR" else null
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

    /** 公共「下载/Tessera」目录名；没选文件夹时 Android 10+ 投递到这里，文件管理器直接可见。 */
    const val PUBLIC_SUBDIR = "Tessera"

    /** 投递目标：SAF 文件夹或 MediaStore 下载目录。 */
    private interface Target {
        val id: String
        /** 同目录下名为 names 之一的已有文件（uri, 长度）。 */
        fun siblings(parts: List<String>, names: Set<String>): List<Pair<Uri, Long>>
        fun create(parts: List<String>, name: String): Uri
        fun commit(uri: Uri) = Unit
        fun discard(uri: Uri)
    }

    private class TreeTarget(val context: Context, val tree: Uri) : Target {
        override val id = tree.toString()
        private val root = DocumentFile.fromTreeUri(context, tree) ?: throw IOException("Receive folder unavailable")
        private fun dir(parts: List<String>, make: Boolean): DocumentFile? {
            var d = root
            for (p in parts) d = d.findFile(p)?.takeIf { it.isDirectory }
                ?: (if (make) d.createDirectory(p) else null) ?: return null
            return d
        }
        override fun siblings(parts: List<String>, names: Set<String>) =
            dir(parts, false)?.listFiles()?.filter { it.isFile && it.name in names }?.map { it.uri to it.length() }.orEmpty()
        override fun create(parts: List<String>, name: String): Uri =
            (dir(parts, true) ?: throw IOException("Cannot create receive directory"))
                .createFile(mimeOf(name), name)?.uri ?: throw IOException("Cannot create received file")
        override fun discard(uri: Uri) { DocumentFile.fromSingleUri(context, uri)?.delete() }
    }

    /** Android 10+ 无需权限写公共下载目录；IS_PENDING 保证写一半的文件不被其他应用看到。 */
    @RequiresApi(Build.VERSION_CODES.Q)
    private class MediaTarget(val context: Context) : Target {
        override val id = "mediastore:${Environment.DIRECTORY_DOWNLOADS}/$PUBLIC_SUBDIR"
        private val coll = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        private fun rel(parts: List<String>) =
            (listOf(Environment.DIRECTORY_DOWNLOADS, PUBLIC_SUBDIR) + parts).joinToString("/", postfix = "/")
        override fun siblings(parts: List<String>, names: Set<String>): List<Pair<Uri, Long>> {
            val out = ArrayList<Pair<Uri, Long>>()
            context.contentResolver.query(coll,
                arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.IS_PENDING}=0",
                arrayOf(rel(parts)), null)?.use { c ->
                while (c.moveToNext()) if (c.getString(1) in names) out += ContentUris.withAppendedId(coll, c.getLong(0)) to c.getLong(2)
            }
            return out
        }
        override fun create(parts: List<String>, name: String): Uri = context.contentResolver.insert(coll, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
            put(MediaStore.MediaColumns.RELATIVE_PATH, rel(parts))
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }) ?: throw IOException("Cannot create download entry")
        override fun commit(uri: Uri) {
            context.contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        }
        override fun discard(uri: Uri) { context.contentResolver.delete(uri, null, null) }
    }

    /** 当前投递目标；Android 8–9 未选文件夹时为 null（无权限写公共目录，留在应用内）。 */
    private fun target(context: Context): Target? = saveTree(context)?.let { TreeTarget(context, it) }
        ?: if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaTarget(context) else null

    /** 回执前完成投递；保存失败保留原文件。 */
    @Synchronized
    fun deliverReceivedFile(context: Context, received: File, contentKey: String? = null): String {
        val downloads = File(context.filesDir, "downloads").canonicalFile
        val source = received.canonicalFile
        require(source.toPath().startsWith(downloads.toPath()) && source != downloads) {
            "Invalid received file"
        }
        val tgt = target(context) ?: run {
            check(source.isFile) { "Received file missing" }
            return source.absolutePath
        }
        val key = contentKey ?: Mobile.fileContentKey(source.absolutePath, 4L shl 20)
        val sourceKey = MessageDigest.getInstance("SHA-256").digest((source.absolutePath + "\u0000" + key).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        fun matches(uri: Uri, size: Long, want: ByteArray): Boolean = runCatching {
            context.contentResolver.openInputStream(uri)?.use { s -> digestCounted(s).let { it.first == size && it.second.contentEquals(want) } } == true
        }.getOrDefault(false)
        val previous = DeliveryReceipts(context).use { it.find(sourceKey, tgt.id) }
        // 恢复线程可能已投递此文件；核对持久凭据后共享同一个结果。
        val sameContent = source.isFile && Mobile.fileContentKey(source.absolutePath, key.substringBefore(':').toLong()) == key
        if (!sameContent) {
            if (previous != null && matches(Uri.parse(previous.uri), previous.size, previous.digest)) return previous.uri
            throw IOException("Received file missing and no valid delivery receipt")
        }
        var created: Uri? = null
        try {
            val parts = source.relativeTo(downloads).path.split(File.separatorChar).dropLast(1)
            val size = source.length()
            val expected = source.inputStream().use { digest(it) }
            if (previous != null && previous.size == size && previous.digest.contentEquals(expected) &&
                matches(Uri.parse(previous.uri), size, expected)) {
                removeStaged(source, downloads)
                return previous.uri
            }
            // 已有同内容文件（含改名变体）就复用，避免重复副本。
            val stem = source.nameWithoutExtension
            val ext = source.extension.let { if (it.isEmpty()) "" else ".$it" }
            val names = (1..8).map { "$stem ($it)$ext" }.toSet() + source.name
            val existing = tgt.siblings(parts, names).firstOrNull { (u, len) -> len == size && matches(u, size, expected) }?.first
            val uri = existing ?: tgt.create(parts, source.name).also { created = it }
            if (existing == null) {
                context.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                    source.inputStream().use { it.copyTo(out, 1 shl 20) }
                } ?: throw IOException("Cannot write received file")
                if (!matches(uri, size, expected)) throw IOException("Received file verification failed")
                tgt.commit(uri)
            }
            // 先读回核对、记凭据，之后才删暂存；失败留下可恢复原件。
            DeliveryReceipts(context).use { it.save(sourceKey, tgt.id, DeliveryReceipts.Receipt(uri.toString(), size, expected)) }
            removeStaged(source, downloads)
            return uri.toString()
        } catch (e: Exception) {
            runCatching { created?.let(tgt::discard) }
            DiagnosticLog.record(context, "receive", "delivery_failed_source_retained", e.javaClass.simpleName)
            throw IOException("Receive folder save failed; original retained in Tessera", e)
        }
    }

    private fun removeStaged(source: File, downloads: File) {
        source.delete()
        var parent = source.parentFile
        while (parent != null && parent != downloads && parent.isDirectory &&
            parent.list().isNullOrEmpty() && parent.delete()
        ) parent = parent.parentFile
    }

    private fun digestCounted(input: java.io.InputStream): Pair<Long, ByteArray> {
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(1 shl 20)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            hash.update(buffer, 0, n); total += n
        }
        return total to hash.digest()
    }

    private fun digest(input: java.io.InputStream): ByteArray = digestCounted(input).second

    /** 把滞留在应用私有目录的已收文件补投递（旧版只在页面打开时搬运，后台收到的会卡在这里）。 */
    fun recoverPending(context: Context) {
        if (target(context) == null) return
        File(context.filesDir, "downloads").walkTopDown()
            .filter { isCompletedFile(it) }
            .take(5000).forEach { file ->
                runCatching { deliverReceivedFile(context, file) }
                    .onFailure { return }
            }
    }

    fun isCompletedFile(file: File): Boolean = file.isFile &&
        !file.name.endsWith(".cbpart") && !file.name.endsWith(".cbstate") && !file.name.endsWith(".cbstate.tmp")

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
