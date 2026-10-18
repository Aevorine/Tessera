package com.tessera.crossdevice

import android.os.Handler
import android.os.Looper
import android.widget.TextView

/**
 * 配对码倒计时：只在显示的秒数变化那一刻刷新（不是固定每秒轮询），到期回调一次，由调用方换新码。
 * 看不见时 [pause]，回来时 [resume]——过期了会在 resume 里立刻回调。
 */
class ExpiryCountdown(private val onExpired: () -> Unit) {
    private val handler = Handler(Looper.getMainLooper())
    private var view: TextView? = null
    private var expiresAt = 0L
    private var format: (String) -> String = { it }

    /** 是否有码在显示（含已过期待换）。 */
    val isActive: Boolean get() = view != null

    private val tick = object : Runnable {
        override fun run() {
            val v = view ?: return
            val left = expiresAt - System.currentTimeMillis()
            if (left <= 0) {
                onExpired()
                return
            }
            val sec = (left + 999) / 1000
            val text = format(clock(sec))
            if (v.text.toString() != text) v.text = text
            handler.postDelayed(this, left - (sec - 1) * 1000)
        }
    }

    fun start(target: TextView, expiresAtMs: Long, fmt: (String) -> String) {
        handler.removeCallbacks(tick)
        view = target
        expiresAt = expiresAtMs
        format = fmt
        tick.run()
    }

    fun resume() {
        handler.removeCallbacks(tick)
        tick.run()
    }

    fun pause() = handler.removeCallbacks(tick)

    fun stop() {
        handler.removeCallbacks(tick)
        view = null
    }

    private companion object {
        fun clock(sec: Long) = "%d:%02d".format(sec / 60, sec % 60)
    }
}
