package com.tessera.crossdevice

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Process
import android.os.StatFs
import android.os.SystemClock

data class AndroidRuntimeSnapshot(
    val appHeapBytes: Long,
    val usedDeviceMemoryBytes: Long,
    val totalDeviceMemoryBytes: Long,
    val storageFreeBytes: Long,
    val batteryPercent: Int?,
    val uptimeSeconds: Long,
    val refreshLatencyMs: Double,
    /** 电池温度，摄氏度。取不到时为 null——部分设备不上报这一项。 */
    val batteryTempC: Double?,
    val cpuCores: Int,
    /** 屏幕刷新率 Hz。0 表示取不到。 */
    val displayRefreshHz: Float,
)

object RuntimeMetricsCollector {
    fun collect(context: Context): AndroidRuntimeSnapshot {
        val started = SystemClock.elapsedRealtimeNanos()
        val runtime = Runtime.getRuntime()
        val appHeap = runtime.totalMemory() - runtime.freeMemory()

        val memory = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)

        val storage = StatFs(context.filesDir.absolutePath)
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val battery = batteryManager
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            .takeIf { it in 0..100 }
        val uptime = ((SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()) / 1000)
            .coerceAtLeast(0)

        return AndroidRuntimeSnapshot(
            appHeapBytes = appHeap,
            usedDeviceMemoryBytes = (memory.totalMem - memory.availMem).coerceAtLeast(0),
            totalDeviceMemoryBytes = memory.totalMem,
            storageFreeBytes = storage.availableBytes,
            batteryPercent = battery,
            uptimeSeconds = uptime,
            refreshLatencyMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0,
            batteryTempC = batteryTemperature(context),
            cpuCores = runtime.availableProcessors(),
            displayRefreshHz = displayRefreshRate(context),
        )
    }

    /**
     * 电池温度。用 `registerReceiver(null, ...)` 取粘性广播的当前值，免得注册后忘记注销而泄漏；单位
     * 0.1℃。
     */
    private fun batteryTemperature(context: Context): Double? {
        val intent = runCatching {
            context.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull() ?: return null
        val raw = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        if (raw == Int.MIN_VALUE) return null
        return raw / 10.0
    }

    @Suppress("DEPRECATION")
    private fun displayRefreshRate(context: Context): Float = runCatching {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            context.display?.refreshRate ?: 0f
        } else {
            (context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager)
                .defaultDisplay.refreshRate
        }
    }.getOrDefault(0f)

    fun format(context: Context, snapshot: AndroidRuntimeSnapshot, metrics: List<AndroidMetric>): String {
        return metrics.joinToString("\n") { metric ->
            when (metric) {
                // ---- 传输与连接。数全部来自已经流过的事件，没有额外开销 ----
                AndroidMetric.ONLINE_DEVICES ->
                    context.getString(
                        R.string.metric_value_online_devices,
                        LinkStats.onlineDevices, LinkStats.pairedDevices,
                    )
                AndroidMetric.LINK_RTT ->
                    context.getString(
                        R.string.metric_value_link_rtt,
                        LinkStats.bestRttMs.takeIf { it >= 0 }?.let { "$it ms" }
                            ?: context.getString(R.string.metric_unavailable),
                    )
                AndroidMetric.THROUGHPUT -> {
                    val (up, down) = LinkStats.currentSpeeds()
                    context.getString(R.string.metric_value_throughput, bytes(up), bytes(down))
                }
                AndroidMetric.SESSION_TOTAL -> {
                    val (sent, recv) = LinkStats.totals()
                    context.getString(R.string.metric_value_session_total, bytes(sent), bytes(recv))
                }
                AndroidMetric.LISTEN_PORT ->
                    context.getString(
                        R.string.metric_value_listen_port,
                        LinkStats.listenPort.takeIf { it > 0 }?.toString()
                            ?: context.getString(R.string.metric_unavailable),
                    )
                AndroidMetric.LOCAL_ADDRESSES ->
                    context.getString(
                        R.string.metric_value_local_addresses,
                        LinkStats.localAddressCount,
                        LinkStats.primaryAddress.ifEmpty { context.getString(R.string.metric_unavailable) },
                    )
                AndroidMetric.INTERFACES ->
                    context.getString(
                        R.string.metric_value_interfaces,
                        LinkStats.usableInterfaces, LinkStats.multicastInterfaces,
                    )
                AndroidMetric.DISCOVERED ->
                    context.getString(R.string.metric_value_discovered, LinkStats.discovered)

                // ---- 设备硬件 ----
                AndroidMetric.BATTERY_TEMP ->
                    context.getString(
                        R.string.metric_value_battery_temp,
                        snapshot.batteryTempC?.let { String.format("%.1f ℃", it) }
                            ?: context.getString(R.string.metric_unavailable),
                    )
                AndroidMetric.CPU_CORES ->
                    context.getString(R.string.metric_value_cpu_cores, snapshot.cpuCores)
                AndroidMetric.DISPLAY_REFRESH ->
                    context.getString(
                        R.string.metric_value_display_refresh,
                        if (snapshot.displayRefreshHz > 0) String.format("%.0f", snapshot.displayRefreshHz)
                        else context.getString(R.string.metric_unavailable),
                    )

                // ---- 本机资源（原有六项） ----
                AndroidMetric.APP_HEAP ->
                    context.getString(R.string.metric_value_app_heap, bytes(snapshot.appHeapBytes))
                AndroidMetric.DEVICE_MEMORY -> {
                    val percent = if (snapshot.totalDeviceMemoryBytes > 0) {
                        snapshot.usedDeviceMemoryBytes * 100.0 / snapshot.totalDeviceMemoryBytes
                    } else 0.0
                    context.getString(R.string.metric_value_device_memory, percent, bytes(snapshot.usedDeviceMemoryBytes))
                }
                AndroidMetric.STORAGE_FREE ->
                    context.getString(R.string.metric_value_storage_free, bytes(snapshot.storageFreeBytes))
                AndroidMetric.BATTERY ->
                    context.getString(
                        R.string.metric_value_battery,
                        snapshot.batteryPercent?.let { "$it%" } ?: context.getString(R.string.metric_unavailable),
                    )
                AndroidMetric.UPTIME ->
                    context.getString(R.string.metric_value_uptime, duration(snapshot.uptimeSeconds))
                AndroidMetric.REFRESH_LATENCY ->
                    context.getString(R.string.metric_value_refresh_latency, snapshot.refreshLatencyMs)
            }
        }
    }

    private fun bytes(value: Long): String {
        val mb = value.coerceAtLeast(0) / (1024.0 * 1024.0)
        return if (mb >= 1024) String.format("%.1f GB", mb / 1024) else String.format("%.1f MB", mb)
    }

    private fun duration(seconds: Long): String {
        val minutes = seconds / 60
        val hours = minutes / 60
        return if (hours > 0) "${hours}h ${minutes % 60}m" else "${minutes}m"
    }
}
