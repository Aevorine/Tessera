package com.tessera.crossdevice

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.InterfaceAddress
import java.net.NetworkInterface

/**
 * 把本机网卡清单交给协议核心。
 *
 * 安卓 11 起 Go 的 `net.Interfaces()` 一律返回 netlinkrib: permission denied（平台封了
 * RTM_GETLINK，golang/go#40569，Go 侧无绕法），
 * 导致附近设备、扫描局域网、手动地址、出示我的码四条发现路径同时静默失效（Windows 端正常）。
 * java.net.NetworkInterface 走 getifaddrs() 不受影响，故由 Kotlin 枚举后序列化成 JSON 灌给 Go。
 * 必须在构造 Agent 之前灌入（发现层在构造函数里启动，晚了 mDNS 对着空列表注册）；换 Wi-Fi、开热点后
 * 也要重灌。
 */
object NetworkInterfaces {

    private const val TAG = "TesseraNetIf"

    /**
     * 枚举一次并推给 Go 侧，返回可用网卡数。整体 catch 兜住：拿不到网卡只是发现变弱，不该让同步服务起不
     * 来。
     */
    fun push(): Int {
        val list = snapshot()
        // 「可用网卡」这项指标就地更新：它是回答"为什么扫不到设备"的第一现场，
        // 而这里正是唯一知道真实数字的地方，再绕一圈去问 Go 侧毫无意义。
        val usable = list.filter { it.up && !it.loopback }
        LinkStats.usableInterfaces = usable.size
        LinkStats.multicastInterfaces = usable.count { it.multicast }
        return try {
            mobile.Mobile.setNetworkInterfaces(JSONArray(list.map { it.toJson() }).toString())
            usable.size
        } catch (t: Throwable) {
            Log.w(TAG, "网卡清单推送失败", t)
            0
        }
    }

    private data class Snapshot(
        val index: Int,
        val name: String,
        val up: Boolean,
        val loopback: Boolean,
        val multicast: Boolean,
        val addrs: List<String>,
    ) {
        // 字段名必须和 Go 侧 netif.Iface 的**导出字段名逐字一致**，
        // 那边是 encoding/json 直接反序列化，没有 tag 也没有大小写宽容。
        fun toJson(): JSONObject = JSONObject()
            .put("Index", index)
            .put("Name", name)
            .put("Up", up)
            .put("Loopback", loopback)
            .put("Multicast", multicast)
            .put("Addrs", JSONArray(addrs))
    }

    private fun snapshot(): List<Snapshot> {
        val out = ArrayList<Snapshot>()
        val ifaces = try {
            NetworkInterface.getNetworkInterfaces() ?: return out
        } catch (t: Throwable) {
            Log.w(TAG, "枚举网卡失败", t)
            return out
        }
        for (ifi in ifaces) {
            val snap = runCatching { describe(ifi) }.getOrNull() ?: continue
            // 没有任何地址的网卡对发现毫无用处，还会让 zeroconf 白加入一个
            // 收不到东西的组播组。
            if (snap.addrs.isEmpty()) continue
            out += snap
        }
        return out
    }

    private fun describe(ifi: NetworkInterface): Snapshot = Snapshot(
        // Index 必须是内核的接口序号：zeroconf 靠它定位要加入组播组的那张网卡。
        // 填错不会报错，只是加到别的接口上，然后一个包都收不到。
        index = ifi.index,
        name = ifi.name ?: "",
        up = ifi.isUp,
        loopback = ifi.isLoopback,
        // supportsMulticast 是区分真实网卡和 VPN/代理 TUN 的关键：
        // TUN 是点对点接口，本来就没有组播这回事，而设备发现全靠组播。
        multicast = ifi.supportsMulticast(),
        addrs = ifi.interfaceAddresses.mapNotNull(::cidr),
    )

    /**
     * 转成 Go `net.ParseCIDR` 认得的写法：IPv6 的 hostAddress 带 `%wlan0` scope 后缀会解析失败，而失败
     * 是静默跳过的。
     */
    private fun cidr(addr: InterfaceAddress): String? {
        val ip = addr.address ?: return null
        val host = ip.hostAddress?.substringBefore('%') ?: return null
        if (host.isEmpty()) return null
        val prefix = addr.networkPrefixLength.toInt()
        // 前缀长度偶尔会是 0 或越界（部分设备上的隧道接口），补一个合理默认值，
        // 总好过丢掉一张真实可用的网卡。
        val safePrefix = when {
            prefix in 1..128 -> prefix
            ip is Inet4Address -> 24
            else -> 64
        }
        return "$host/$safePrefix"
    }
}
