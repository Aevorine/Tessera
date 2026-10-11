package com.tessera.crossdevice

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 「接着刚才」安卓侧的取舍，守的都是"不会崩、只是提示不对"的失效。 */
class ContinuityTest {

    private fun items(vararg objs: JSONObject) = JSONArray().apply { objs.forEach { put(it) } }

    private fun item(
        device: String = "dev-1",
        name: String = "我的电脑",
        kind: String = "note",
        title: String = "季度财务复盘",
        localId: String = "42",
        updatedAt: Long = 1000,
    ) = JSONObject()
        .put("device_id", device)
        .put("device_name", name)
        .put("kind", kind)
        .put("title", title)
        .put("local_id", localId)
        .put("updated_at_ms", updatedAt)

    private val fmt: (String, String) -> String = { device, title -> "$device|$title" }

    @Test
    fun `空列表不显示横条`() {
        assertNull(Continuity.bannerOf(null, fmt))
        assertNull(Continuity.bannerOf(JSONArray(), fmt))
    }

    @Test
    fun `只显示最近更新的那一条，其余计入还有N件`() {
        // 手机屏幕上方那条横带只容得下一行。堆三条会把首屏内容挤到看不见，
        // 而这条提示的重要性永远低于用户当前想做的事。
        val banner = Continuity.bannerOf(
            items(
                item(device = "a", name = "旧的", updatedAt = 100),
                item(device = "b", name = "新的", updatedAt = 900),
                item(device = "c", name = "中间", updatedAt = 500),
            ),
            fmt,
        )!!
        assertTrue(banner.text.startsWith("新的|"))
        assertEquals(2, banner.extraCount)
    }

    @Test
    fun `kind为none的条目不显示也不计数`() {
        // none 是一条**收回提示**的消息，不该自己变成"某设备正在做 none"。
        // Go 侧已经滤过一次，这里再滤一次是因为两端版本可能不同步。
        assertNull(Continuity.bannerOf(items(item(kind = "none")), fmt))

        val banner = Continuity.bannerOf(
            items(item(device = "a", updatedAt = 100), item(device = "b", kind = "none", updatedAt = 900)),
            fmt,
        )!!
        assertEquals(0, banner.extraCount)
    }

    @Test
    fun `关闭键包含标题——换一件事后提示要重新出现`() {
        // 只按 device_id 记"已忽略"的话，用户关掉一次就等于永久关掉这台设备的
        // 所有提示，包括明天那条全新的、有用的。
        val first = Continuity.bannerOf(items(item(title = "第一篇")), fmt)!!
        val second = Continuity.bannerOf(items(item(title = "第二篇")), fmt)!!
        assertTrue(first.dedupeKey != second.dedupeKey)
    }

    @Test
    fun `设备名为空时退回设备ID前八位`() {
        // 一条写着"|季度财务复盘"的提示比没有提示更让人困惑——它说"有件事没做完"，
        // 却不说是哪台设备上的，而"哪台设备"正是这条提示的全部信息量。
        val banner = Continuity.bannerOf(
            items(item(device = "abcdefgh12345678", name = "")),
            fmt,
        )!!
        assertTrue(banner.text.startsWith("abcdefgh|"))
    }

    @Test
    fun `没在传时播报none`() {
        assertEquals("none", Continuity.publishParams(null, "x", 50).optString("kind"))
        assertEquals("none", Continuity.publishParams("", "x", 50).optString("kind"))
    }

    @Test
    fun `进度被夹到0到100之间`() {
        // Go 侧收到 -1 会当"未知"处理并画不出进度条；但这里播报的是真实传输，
        // 进度一定是已知的。越界值（比如上游算出 101）会让对端显示 101%。
        assertEquals(100, Continuity.publishParams("a.zip", "t1", 250).optInt("progress"))
        assertEquals(0, Continuity.publishParams("a.zip", "t1", -5).optInt("progress"))
    }

    @Test
    fun `播报里带着传输ID`() {
        val params = Continuity.publishParams("报告.pdf", "t-42", 30)
        assertEquals("transfer", params.optString("kind"))
        assertEquals("报告.pdf", params.optString("title"))
        assertEquals("t-42", params.optString("local_id"))
    }
}
