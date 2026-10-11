package com.tessera.crossdevice

import org.json.JSONArray
import org.json.JSONObject

/**
 * 「接着刚才」的安卓侧；协议和过期判定在 Go（crossdevice/core/node/continuity.go）。
 *
 * 横带只容一行，故只显示最近更新的一条，其余用「还有 N 件」带过；
 * 本机只播报传输（手机上唯一"没做完"的事），凑别的只会训练用户忽略横带。
 */
object Continuity {

    /** 界面要显示的一条。null = 没有任何设备在做事，横带该收起来。 */
    data class Banner(val text: String, val extraCount: Int, val dedupeKey: String)

    /**
     * 把 `list_continuity` 的返回变成一条横幅。
     * @param formatter 由 Activity 提供以套用字符串资源，使本函数不依赖 Context、可直接单测。
     */
    fun bannerOf(items: JSONArray?, formatter: (device: String, title: String) -> String): Banner? {
        if (items == null || items.length() == 0) return null

        var best: JSONObject? = null
        var bestAt = Long.MIN_VALUE
        var count = 0
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            // kind=none 表示收回提示，不能显示成"正在做 none"；Go 侧已滤过，这里再滤是因为旧版守护进程可能仍会
            // 发。
            if (item.optString("kind") == "none") continue
            count++
            val at = item.optLong("updated_at_ms")
            if (at > bestAt) {
                bestAt = at
                best = item
            }
        }
        val top = best ?: return null

        val device = top.optString("device_name").ifEmpty { top.optString("device_id").take(8) }
        val title = top.optString("title")
        return Banner(
            text = formatter(device, title),
            extraCount = count - 1,
            // 关闭按钮按这个键记"已忽略"。带上标题和 id：换一件事之后
            // 提示要重新出现，否则关掉一次就等于永久关掉这台设备的提示。
            dedupeKey = "${top.optString("device_id")}|${top.optString("kind")}|${top.optString("local_id")}|$title",
        )
    }

    /** 播报本机正在传的东西。传 null 表示"我现在没在传"。 */
    fun publishParams(name: String?, transferId: String?, percent: Int): JSONObject {
        if (name.isNullOrEmpty()) {
            return JSONObject().put("kind", "none")
        }
        return JSONObject()
            .put("kind", "transfer")
            .put("title", name)
            .put("local_id", transferId ?: "")
            .put("progress", percent.coerceIn(0, 100))
    }
}
