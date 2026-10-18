package com.tessera.crossdevice

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.text.TextUtils
import android.text.format.DateUtils
import android.text.format.Formatter
import android.util.TypedValue
import android.view.Gravity
import android.webkit.MimeTypeMap
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import androidx.core.widget.TextViewCompat
import androidx.documentfile.provider.DocumentFile
import java.io.File

/**
 * 「打开收件文件夹」。选过外部文件夹：先交给系统文件管理器（DocumentsUI 显式优先，
 * 厂商默认处理器常认不了目录）；打不开或用的是应用私有目录：在应用内列出文件，点开即看。
 */
object ReceivedFolder {

    private val DOCS_UI = listOf("com.google.android.documentsui", "com.android.documentsui")
    private const val LIST_MAX = 500

    private class Entry(val name: String, val size: Long, val modified: Long, val uri: Uri)

    fun open(activity: Activity) {
        val tree = FileBridge.saveTree(activity)
        if (tree != null && openInFileManager(activity, tree)) return
        Thread {
            val items = runCatching { if (tree != null) listTree(activity, tree) else listPrivate(activity) }
                .getOrElse {
                activity.runOnUiThread { Toast.makeText(activity, R.string.no_app_to_open, Toast.LENGTH_SHORT).show() }
                return@Thread
            }
            activity.runOnUiThread { if (!activity.isFinishing) showList(activity, tree, items) }
        }.start()
    }

    private fun openInFileManager(activity: Activity, tree: Uri): Boolean {
        val doc = runCatching {
            DocumentsContract.buildDocumentUri(tree.authority, DocumentsContract.getTreeDocumentId(tree))
        }.getOrNull() ?: return false
        val base = Intent(Intent.ACTION_VIEW)
            .setDataAndType(doc, DocumentsContract.Document.MIME_TYPE_DIR)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        for (pkg in DOCS_UI + listOf<String?>(null)) {
            val ok = runCatching {
                activity.startActivity(Intent(base).apply { if (pkg != null) setPackage(pkg) })
            }.onFailure { if (it !is ActivityNotFoundException && it !is SecurityException) throw it }.isSuccess
            if (ok) return true
        }
        return false
    }

    private fun listPrivate(activity: Activity): List<Entry> {
        val root = File(activity.filesDir, "downloads")
        val authority = "${activity.packageName}.updates"
        return root.walkTopDown().filter { it.isFile }.take(LIST_MAX).map {
            Entry(it.relativeTo(root).path, it.length(), it.lastModified(), FileProvider.getUriForFile(activity, authority, it))
        }.sortedByDescending { it.modified }.toList()
    }

    private fun listTree(activity: Activity, tree: Uri): List<Entry> {
        val out = ArrayList<Entry>()
        fun walk(dir: DocumentFile, prefix: String) {
            for (f in dir.listFiles()) {
                if (out.size >= LIST_MAX) return
                val name = prefix + (f.name ?: continue)
                if (f.isDirectory) walk(f, "$name/") else out += Entry(name, f.length(), f.lastModified(), f.uri)
            }
        }
        DocumentFile.fromTreeUri(activity, tree)?.let { walk(it, "") }
        return out.sortedByDescending { it.modified }
    }

    private fun showList(activity: Activity, tree: Uri?, items: List<Entry>) {
        val dp = activity.resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        fun attr(a: Int) = TypedValue().also { activity.theme.resolveAttribute(a, it, true) }.resourceId

        val list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        if (items.isEmpty()) {
            list.addView(TextView(activity).apply {
                text = activity.getString(R.string.received_empty)
                gravity = Gravity.CENTER
                setPadding(px(16), px(32), px(16), px(32))
                TextViewCompat.setTextAppearance(this, attr(com.google.android.material.R.attr.textAppearanceBodyMedium))
            })
        }
        for (e in items) {
            val row = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(px(4), px(10), px(4), px(10))
                background = TypedValue().let {
                    activity.theme.resolveAttribute(android.R.attr.selectableItemBackground, it, true)
                    androidx.core.content.ContextCompat.getDrawable(activity, it.resourceId)
                }
                tooltipText = activity.getString(R.string.open_file)
            }
            row.addView(ImageView(activity).apply {
                setImageResource(R.drawable.ic_file)
                layoutParams = LinearLayout.LayoutParams(px(22), px(22)).apply { marginEnd = px(14) }
                imageTintList = android.content.res.ColorStateList.valueOf(
                    com.google.android.material.color.MaterialColors.getColor(this, androidx.appcompat.R.attr.colorPrimary)
                )
            })
            val texts = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            texts.addView(TextView(activity).apply {
                text = e.name
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.MIDDLE
                TextViewCompat.setTextAppearance(this, attr(com.google.android.material.R.attr.textAppearanceBodyMedium))
            })
            texts.addView(TextView(activity).apply {
                text = "${Formatter.formatShortFileSize(activity, e.size)} · " +
                    DateUtils.getRelativeTimeSpanString(e.modified, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
                TextViewCompat.setTextAppearance(this, attr(com.google.android.material.R.attr.textAppearanceBodySmall))
            })
            row.addView(texts)
            row.setOnClickListener { view(activity, e) }
            row.setOnLongClickListener { share(activity, e); true }
            list.addView(row)
        }

        val maxH = activity.resources.displayMetrics.heightPixels
        val scroll = object : ScrollView(activity) {
            override fun onMeasure(w: Int, h: Int) =
                super.onMeasure(w, MeasureSpec.makeMeasureSpec(maxH, MeasureSpec.AT_MOST))
        }.apply {
            setPadding(px(16), px(4), px(16), 0)
            addView(list)
        }
        val dialog = AlertDialog.Builder(activity)
            .setView(scroll)
            .setPositiveButton(R.string.close, null)
            .apply {
                if (tree != null) setNeutralButton(R.string.open_in_files) { _, _ -> openPicker(activity, tree) }
            }
            .create()
        dialog.show()
        dialog.window?.setLayout(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
    }

    /** 最后一招：系统选择器从该目录起步，至少能浏览里面的内容。 */
    private fun openPicker(activity: Activity, tree: Uri) {
        val doc = runCatching {
            DocumentsContract.buildDocumentUri(tree.authority, DocumentsContract.getTreeDocumentId(tree))
        }.getOrNull()
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        if (doc != null) i.putExtra(DocumentsContract.EXTRA_INITIAL_URI, doc)
        runCatching { activity.startActivity(i) }
    }

    private fun mimeOf(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"

    private fun view(activity: Activity, e: Entry) {
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(e.uri, mimeOf(e.name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            activity.startActivity(Intent.createChooser(i, e.name))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(activity, R.string.no_app_to_open, Toast.LENGTH_SHORT).show()
        }
    }

    private fun share(activity: Activity, e: Entry) {
        val i = Intent(Intent.ACTION_SEND).setType(mimeOf(e.name))
            .putExtra(Intent.EXTRA_STREAM, e.uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { activity.startActivity(Intent.createChooser(i, e.name)) }
    }
}
