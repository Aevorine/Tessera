package com.tessera.crossdevice

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * 通知栏「同步剪贴板」按钮的落地页，全透明。
 *
 * 安卓 10 起只有持有窗口焦点的 App（或输入法）能读剪贴板，前台服务不行；这里用最小代价换一次聚焦，
 * 读完即关。
 * 在 onWindowFocusChanged(true) 而非 onCreate/onResume 里读：只有此刻系统才确认焦点在本窗口。
 */
class ClipSyncTrampolineActivity : AppCompatActivity() {

    companion object {
        // 不需要跟 MainActivity 的请求 id 对齐：这条请求是一次性的，不等响应，
        // 只要在极短时间窗口内不撞别的并发请求即可。
        private val seq = AtomicInteger(1)
    }

    private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 不调用 setContentView：主题本身全透明，没有任何东西要画。
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 焦点变化可能不止触发一次，只处理拿到焦点的第一次。
        if (!hasFocus || handled) return
        handled = true
        syncNow()
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private fun syncNow() {
        // 逻辑跟 MainActivity.sendClipboard() 一致，但这里不依赖任何 Activity
        // 视图绑定——落地页可能在 MainActivity 从未创建过的情况下独立跑起来。
        val payload = ClipboardBridge.readAsReps(this)
        if (payload == null) {
            Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
            return
        }
        val req = JSONObject()
            .put("id", seq.incrementAndGet())
            .put("method", "send_clip")
            .put("params", payload.put("force", true))
        val ok = SyncService.instance?.request(req.toString()) ?: false
        Toast.makeText(
            this,
            if (ok) R.string.clip_sent else R.string.starting,
            Toast.LENGTH_SHORT,
        ).show()
    }
}
