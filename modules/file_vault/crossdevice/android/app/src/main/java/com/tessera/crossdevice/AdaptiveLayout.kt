package com.tessera.crossdevice

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout

/**
 * 手机 / 平板 / 横屏版式，内容一律铺满宽度。Activity 未声明 configChanges，转屏会重建，onCreate 里算一次即可。
 * - 窄屏：单栏，状态头 → 功能格（撑满剩余高度）→ 设备。
 * - 宽屏（≥ 840dp，或横屏且 ≥ 600dp）：左栏状态与设备，右栏功能格；面板正文分两栏。
 */
object AdaptiveLayout {
    private const val TWO_PANE_DP = 840
    private const val LANDSCAPE_TWO_PANE_DP = 600
    private const val PANE_GAP_DP = 16

    fun isTwoPane(ctx: Context): Boolean {
        val c = ctx.resources.configuration
        return c.screenWidthDp >= TWO_PANE_DP ||
            (c.screenWidthDp >= LANDSCAPE_TWO_PANE_DP && c.screenWidthDp > c.screenHeightDp)
    }

    private fun gap(ctx: Context) = (PANE_GAP_DP * ctx.resources.displayMetrics.density).toInt()

    fun applyMain(content: LinearLayout, primary: View, secondary: ViewGroup, features: View, devices: View) {
        val ctx = content.context
        if (!isTwoPane(ctx)) {
            secondary.visibility = View.GONE
            return
        }
        content.orientation = LinearLayout.HORIZONTAL
        primary.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
        secondary.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1.25f)
            .apply { marginStart = gap(ctx) }
        (features.parent as? ViewGroup)?.removeView(features)
        secondary.addView(features, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        // 左栏设备卡撑到底，与右栏等高。
        (devices.layoutParams as LinearLayout.LayoutParams).apply { height = 0; weight = 1f }
    }

    /** 宽屏面板正文：卡片交替分进两栏；一栏全隐藏时收起，另一栏占满。 */
    fun applyPanelBody(body: View) {
        val ctx = body.context
        if (body !is LinearLayout || body.childCount < 2 || !isTwoPane(ctx)) return
        val kids = (0 until body.childCount).map { body.getChildAt(it) }
        val top = (kids[0].layoutParams as? ViewGroup.MarginLayoutParams)?.topMargin ?: 0
        body.removeAllViews()
        body.orientation = LinearLayout.HORIZONTAL
        val cols = List(2) { LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL } }
        kids.forEachIndexed { i, v ->
            if (i < 2) (v.layoutParams as? ViewGroup.MarginLayoutParams)?.topMargin = top
            cols[i % 2].addView(v)
        }
        cols.forEachIndexed { i, c ->
            body.addView(c, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                if (i == 1) marginStart = gap(ctx)
            })
        }
        body.viewTreeObserver.addOnGlobalLayoutListener {
            cols.forEach { c ->
                val vis = if ((0 until c.childCount).any { c.getChildAt(it).visibility == View.VISIBLE }) View.VISIBLE else View.GONE
                if (c.visibility != vis) c.visibility = vis
            }
        }
    }
}
