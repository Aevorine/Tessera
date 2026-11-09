package com.tessera.crossdevice

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager

/**
 * 传输期间把 Wi-Fi 与 CPU 拉到高性能档，空闲 [IDLE_RELEASE_MS] 后自动放掉。
 *
 * 根因：安卓 Wi-Fi 默认开省电（PSM），无前台交互时网卡每个 DTIM 周期（100–300 ms）才醒一次收包，
 * 灭屏/切后台后吞吐常跌到几百 KB/s；CPU 也会被调度到小核甚至挂起，读循环、解密、哈希一起变慢。
 * 前台服务只保证进程不被杀，不保证网卡与 CPU 全速。
 * - WifiLock：API 29+ 用 LOW_LATENCY（同时关 PSM、提高调度优先级，仅前台/前台服务生效），
 *   以下用 FULL_HIGH_PERF。
 * - 部分唤醒锁：灭屏后 CPU 不挂起。带超时兜底，进程异常也不会无限持锁耗电。
 * 只在有字节在动时持有，空闲即放，不常驻耗电。
 */
object TransferBoost {
    private const val IDLE_RELEASE_MS = 15_000L
    private const val WAKE_TIMEOUT_MS = 10 * 60_000L
    private const val TAG = "Tessera:transfer"

    private val main = Handler(Looper.getMainLooper())
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val release = Runnable { releaseNow() }

    /** 每次有传输进度 / 开始事件时调用；线程安全（统一切到主线程处理）。 */
    fun touch(context: Context) {
        val ctx = context.applicationContext
        main.post {
            acquire(ctx)
            main.removeCallbacks(release)
            main.postDelayed(release, IDLE_RELEASE_MS)
        }
    }

    fun releaseNow() {
        main.removeCallbacks(release)
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
    }

    val active: Boolean get() = wifiLock?.isHeld == true

    private fun acquire(ctx: Context) {
        if (wifiLock == null) {
            val wm = ctx.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = runCatching { wm?.createWifiLock(mode, TAG)?.apply { setReferenceCounted(false) } }.getOrNull()
        }
        if (wakeLock == null) {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = runCatching {
                pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG)?.apply { setReferenceCounted(false) }
            }.getOrNull()
        }
        runCatching { wifiLock?.takeIf { !it.isHeld }?.acquire() }
            .onFailure { DiagnosticLog.record(ctx, "transfer", "Wi-Fi 高性能锁获取失败", it.javaClass.simpleName) }
        // 每次续期都重新带超时：持续传输时不断延后，进程卡死时最多 10 分钟自动放。
        runCatching { wakeLock?.acquire(WAKE_TIMEOUT_MS) }
    }
}
