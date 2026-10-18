package com.tessera.crossdevice

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import kotlin.math.max
import kotlin.math.min

/**
 * 手机 / 平板 / 横屏的版式。只看 screenWidthDp：Activity 没声明 configChanges，转屏、分屏都会重建，
 * 所以在 onCreate 里算一次就对，不用监听布局变化。
 *
 * - 手机：单栏占满。
 * - 竖屏平板：单栏限宽 720dp 居中，一行文字不用来回扫。
 * - 横屏平板 / 折叠屏展开（≥ 840dp）：左栏状态与设备，右栏「全部功能」，整体限宽 1240dp。
 */
object AdaptiveLayout {
    private const val TWO_PANE_DP = 840
    private const val COLUMN_MAX_DP = 720
    private const val TWO_PANE_MAX_DP = 1240
    private const val TILE_MIN_DP = 112
    private const val PANE_GAP_DP = 20

    fun isTwoPane(ctx: Context): Boolean = ctx.resources.configuration.screenWidthDp >= TWO_PANE_DP

    /** 把容器左右内边距撑到内容不超过 maxDp 宽并居中；窄屏保持原内边距。 */
    fun centerColumn(view: View, maxDp: Int = COLUMN_MAX_DP) {
        val res = view.resources
        val side = max(
            res.getDimensionPixelSize(R.dimen.screen_padding),
            ((res.configuration.screenWidthDp - maxDp) * res.displayMetrics.density / 2).toInt(),
        )
        view.setPadding(side, view.paddingTop, side, view.paddingBottom)
    }

    /** 主界面：限宽，宽屏时切左右两栏并把功能格挪到右栏。 */
    fun applyMain(content: LinearLayout, primary: View, secondary: ViewGroup, features: View) {
        val ctx = content.context
        val twoPane = isTwoPane(ctx)
        centerColumn(content, if (twoPane) TWO_PANE_MAX_DP else COLUMN_MAX_DP)
        if (!twoPane) return
        content.orientation = LinearLayout.HORIZONTAL
        val gap = (PANE_GAP_DP * ctx.resources.displayMetrics.density).toInt()
        primary.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        secondary.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            .apply { marginStart = gap }
        (features.parent as? ViewGroup)?.removeView(features)
        secondary.addView(features)
    }

    /** 功能格列数：按所在栏的宽度算，3–6 列。 */
    fun tileSpan(ctx: Context): Int {
        val w = ctx.resources.configuration.screenWidthDp
        val column = if (isTwoPane(ctx)) min(w, TWO_PANE_MAX_DP) / 2 else min(w, COLUMN_MAX_DP)
        return (column / TILE_MIN_DP).coerceIn(3, 6)
    }
}
