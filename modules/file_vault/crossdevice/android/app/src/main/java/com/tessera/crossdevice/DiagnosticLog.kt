package com.tessera.crossdevice

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 故障日志：只记「某个功能没能正常工作」，供手机上无调试工具时排障。
 * 硬约束：默认关闭；只记故障不记正常操作；绝不记内容本身（剪贴板正文、文件名、完整路径、密码）。
 */
object DiagnosticLog {

    private const val PREFS = "tessera-diaglog"
    private const val KEY_ENABLED = "enabled"
    private const val FILE = "diagnostic.log.jsonl"
    private const val MAX_BYTES = 1L * 1024 * 1024
    private const val MAX_ENTRIES = 500

    private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    private val lock = Any()

    fun isEnabled(c: Context): Boolean =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

    fun setEnabled(c: Context, on: Boolean) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, on).apply()
    }

    private fun file(c: Context) = File(c.filesDir, FILE)

    /** 记一条故障；没开日志直接返回、不做 I/O。detail 只放错误码、异常类名，不要传用户内容。 */
    fun record(c: Context, module: String, problem: String, detail: String = "") {
        if (!isEnabled(c)) return
        val entry = JSONObject()
            .put("at", stamp.format(Date()))
            .put("module", module)
            .put("problem", problem)
            .put("detail", detail.take(400).replace("\n", " "))
        synchronized(lock) {
            runCatching {
                val f = file(c)
                // 超过上限就整份重来。诊断日志只关心"最近出了什么问题"，
                // 留几个月的历史没有意义，只会白占空间。
                if (f.exists() && f.length() > MAX_BYTES) f.delete()
                f.appendText(entry.toString() + "\n")
            }
        }
    }

    /** 读最近的日志，最新的排前面。 */
    fun readAll(c: Context): List<JSONObject> {
        val f = file(c)
        if (!f.exists()) return emptyList()
        return runCatching {
            f.readLines()
                .asReversed()
                .mapNotNull { line ->
                    // 一行坏掉不该让整份日志读不出来
                    runCatching { JSONObject(line) }.getOrNull()
                }
                .take(MAX_ENTRIES)
        }.getOrDefault(emptyList())
    }

    /** 全部删除，返回删掉的条数。真删文件，不是标记删除。 */
    fun clearAll(c: Context): Int {
        synchronized(lock) {
            val n = readAll(c).size
            runCatching { file(c).delete() }
            return n
        }
    }

    /** 导出成可分享的文本，方便用户把日志发出来。 */
    fun exportText(c: Context): String {
        val arr = JSONArray()
        readAll(c).forEach { arr.put(it) }
        return arr.toString(2)
    }
}
