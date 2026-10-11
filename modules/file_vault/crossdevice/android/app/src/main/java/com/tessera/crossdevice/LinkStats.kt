package com.tessera.crossdevice

import java.util.concurrent.atomic.AtomicLong

/**
 * 连接与传输的实时统计。
 *
 * 在 Kotlin 侧算而不加 Go 的 RPC：这些数已在事件流里（progress 每 250 ms 带 speed/done/direction，
 * status 带 state 和 rtt_ms），顺手记下即可，没有新线程、轮询或 JNI 调用。
 * 累计量只算本次会话、不落盘：落盘就成了"何时传了多少"的记录，进程重启归零是有意的。
 */
object LinkStats {

    /** 在线 / 已配对设备数。renderDevices 每次刷新时更新。 */
    @Volatile var onlineDevices: Int = 0
    @Volatile var pairedDevices: Int = 0

    /** 已配对设备里最好的那条链路延迟，毫秒。<0 表示还没有任何一台报上来。 */
    @Volatile var bestRttMs: Long = -1

    /** 本机监听端口。0 表示还没拿到。 */
    @Volatile var listenPort: Int = 0

    /** 本机可对外公布的地址条数，以及排第一的那个（给"念给对方"用）。 */
    @Volatile var localAddressCount: Int = 0
    @Volatile var primaryAddress: String = ""

    /** 附近发现到的设备数。 */
    @Volatile var discovered: Int = 0

    /** 可用网卡数 / 其中支持组播的张数。安卓上这两个数一为零就什么都发现不了。 */
    @Volatile var usableInterfaces: Int = 0
    @Volatile var multicastInterfaces: Int = 0

    private val sentTotal = AtomicLong(0)
    private val recvTotal = AtomicLong(0)

    /** 每条在途传输最近一次上报的 done，用来算增量。传完就移除。 */
    private val lastDone = HashMap<String, Long>()

    /** 每条在途传输最近一次上报的速度，按方向分别求和。 */
    private val speeds = HashMap<String, Pair<String, Long>>()

    @Synchronized
    fun onProgress(transferId: String, direction: String, done: Long, speed: Long) {
        // 增量而不是直接累加 done：done 是**这条传输**的累计值，直接加会把
        // 同一批字节重复计上几十遍，几秒钟就报出几个 GB 的荒唐数字。
        val prev = lastDone[transferId] ?: 0L
        val delta = (done - prev).coerceAtLeast(0)
        lastDone[transferId] = done
        if (direction == "send") sentTotal.addAndGet(delta) else recvTotal.addAndGet(delta)
        speeds[transferId] = direction to speed
    }

    @Synchronized
    fun onTransferEnded(transferId: String) {
        lastDone.remove(transferId)
        speeds.remove(transferId)
    }

    @Synchronized
    fun clearActive() {
        lastDone.clear()
        speeds.clear()
    }

    /** 当前上行 / 下行速度，字节每秒。 */
    @Synchronized
    fun currentSpeeds(): Pair<Long, Long> {
        var up = 0L
        var down = 0L
        for ((dir, speed) in speeds.values) {
            if (dir == "send") up += speed else down += speed
        }
        return up to down
    }

    fun totals(): Pair<Long, Long> = sentTotal.get() to recvTotal.get()
}
