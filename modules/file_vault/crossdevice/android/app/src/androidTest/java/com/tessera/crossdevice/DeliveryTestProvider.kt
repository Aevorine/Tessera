package com.tessera.crossdevice

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException

/** Only in the instrumentation APK; exercises real ContentResolver/SAF I/O. */
class DeliveryTestProvider : DocumentsProvider() {
    private val root get() = File(context!!.filesDir, "delivery-e2e").apply { mkdirs() }.canonicalFile
    private fun file(id: String): File = if (id == "root") root else File(root, id).canonicalFile.also {
        require(it.toPath().startsWith(root.canonicalFile.toPath()))
    }
    override fun onCreate() = true
    override fun queryRoots(projection: Array<out String>?): Cursor = MatrixCursor(projection ?: arrayOf("root_id", "document_id", "title")).apply {
        newRow().add("root_id", "root").add("document_id", "root").add("title", "Delivery E2E")
    }
    private fun cursor(projection: Array<out String>?) = MatrixCursor(projection ?: arrayOf(
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_FLAGS, Document.COLUMN_LAST_MODIFIED,
    ))
    private fun row(c: MatrixCursor, f: File) {
        val id = if (f == root) "root" else f.relativeTo(root).path
        val values = mapOf(
            Document.COLUMN_DOCUMENT_ID to id, Document.COLUMN_DISPLAY_NAME to f.name,
            Document.COLUMN_MIME_TYPE to if (f.isDirectory) Document.MIME_TYPE_DIR else "application/octet-stream",
            Document.COLUMN_SIZE to f.length(), Document.COLUMN_LAST_MODIFIED to f.lastModified(),
            Document.COLUMN_FLAGS to (Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE or
                if (f.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE else 0),
        )
        c.addRow(c.columnNames.map { values[it] }.toTypedArray())
    }
    override fun queryDocument(id: String, projection: Array<out String>?): Cursor = cursor(projection).apply {
        val f = file(id); if (f.exists()) row(this, f)
    }
    override fun queryChildDocuments(id: String, projection: Array<out String>?, sortOrder: String?): Cursor = cursor(projection).apply {
        file(id).listFiles()?.forEach { row(this, it) }
    }
    override fun isChildDocument(parent: String, child: String): Boolean = file(child).toPath().startsWith(file(parent).toPath())
    override fun createDocument(parent: String, mime: String, name: String): String {
        var dest = File(file(parent), name)
        var n = 1
        while (dest.exists()) dest = File(file(parent), "${File(name).nameWithoutExtension} (${n++}).${File(name).extension}")
        if (mime == Document.MIME_TYPE_DIR) check(dest.mkdirs()) else check(dest.createNewFile())
        return dest.relativeTo(root).path
    }
    override fun deleteDocument(id: String) { check(file(id).deleteRecursively()) }
    override fun openDocument(id: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        if (mode.contains('w') && File(root, ".deny").exists()) throw FileNotFoundException("Simulated permission loss")
        return ParcelFileDescriptor.open(file(id), ParcelFileDescriptor.parseMode(mode))
    }
}
