package com.tessera.crossdevice

import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 剪贴板去重键，全进程共用一份：
 * 否则写入的对端内容会被后台监听当成新复制再广播回去。
 */
object ClipDedupe {
    @Volatile
    var lastKey: String? = null

    /**
     * 取 MIME 和内容的 SHA-256 而非 String.hashCode（32 位易撞，后一份会被误判已同步）；base64 固定
     * NO_WRAP，直接哈希。
     */
    fun key(payload: JSONObject): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        fun add(value: String) {
            digest.update(value.toByteArray(Charsets.UTF_8))
            digest.update(0)
        }
        add(payload.optString("preferred"))
        val reps = payload.optJSONArray("reps")
        for (i in 0 until (reps?.length() ?: 0)) {
            val r = reps?.optJSONObject(i) ?: continue
            add(r.optString("mime"))
            add(r.optString("data"))
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** 这份内容是不是刚发过/刚写进来的；不是就登记下来并返回 false。 */
    @Synchronized
    fun seenOrMark(payload: JSONObject): Boolean {
        val k = key(payload)
        if (k == lastKey) return true
        lastKey = k
        return false
    }

    /** 把系统剪贴板当前内容登记为"已见过"。收到对端内容写入之后调。 */
    fun markCurrent(context: Context) {
        runCatching { ClipboardBridge.readAsReps(context) }.getOrNull()?.let { lastKey = key(it) }
    }
}

/**
 * 输入法模式。安卓 10 起只有默认输入法和持焦点的应用能读剪贴板；
 * 按包名判定，Tessera 键盘为当前输入法时同包的 SyncService 也能读，可在后台直接同步。
 */
object ImeMode {
    private fun component(context: Context) =
        ComponentName(context, TesseraImeService::class.java)

    /** 已在系统设置里启用（出现在输入法列表中）。 */
    fun isEnabled(context: Context): Boolean {
        val imm = context.getSystemService(InputMethodManager::class.java) ?: return false
        val me = component(context)
        return runCatching { imm.enabledInputMethodList.any { it.component == me } }.getOrDefault(false)
    }

    /** 是当前默认输入法——只有这时后台才读得到剪贴板。 */
    fun isDefault(context: Context): Boolean {
        val cur = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
        }.getOrNull() ?: return false
        return ComponentName.unflattenFromString(cur) == component(context)
    }
}

/**
 * 后台剪贴板监听，仅在 Tessera 是默认输入法时工作。
 * 回调在主线程而读图可能达 8 MB，故放单独线程；变化时立即读一次，80 ms 后再补读一次
 * （一次复制可能写两遍），重复内容由 ClipDedupe 挡掉。
 */
class ClipWatcher(private val context: Context, private val send: (JSONObject) -> Boolean) {
    private val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "tessera-clip-watch") }
    private val readNow = Runnable { worker.execute { capture() } }
    private val listener = ClipboardManager.OnPrimaryClipChangedListener {
        worker.execute { capture() }
        main.removeCallbacks(readNow)
        main.postDelayed(readNow, 80)
    }

    fun start() {
        runCatching { cm.addPrimaryClipChangedListener(listener) }
    }

    fun stop() {
        runCatching { cm.removePrimaryClipChangedListener(listener) }
        main.removeCallbacks(readNow)
        worker.shutdownNow()
    }

    private fun capture() {
        // 不是默认输入法时根本读不到（系统返回空），还可能在安卓 12+ 上弹"已读取剪贴板"。
        if (!ImeMode.isDefault(context)) return
        val payload = runCatching { ClipboardBridge.readAsReps(context) }
            .onFailure { DiagnosticLog.record(context, "clip", "输入法模式读取剪贴板失败", "${it.javaClass.simpleName}: ${it.message}") }
            .getOrNull() ?: return
        if (ClipDedupe.seenOrMark(payload)) return
        // 不带 force：自动同步关着时 Go 侧会直接跳过（agent.sendClip）。
        send(payload)
    }
}
