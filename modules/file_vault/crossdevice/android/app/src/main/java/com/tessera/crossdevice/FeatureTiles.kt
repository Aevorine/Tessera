package com.tessera.crossdevice

import android.content.Context
import android.content.res.ColorStateList
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/** 主界面的一格：key 对应一个全屏面板，badge 是实时小结，attention 时小结用警示色。 */
data class FeatureTile(
    val key: String,
    @DrawableRes val icon: Int,
    @StringRes val title: Int,
    val badge: String,
    val attention: Boolean = false,
)

/**
 * 功能格：格子铺满分到的空间，不留空白。列数按格子长宽比挑最接近 [TARGET_RATIO] 的；
 * 末行不满时拉宽补齐。按 key 复用视图，小结变了只改那一格的字。
 */
class TileGrid @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : ViewGroup(context, attrs) {

    private val density = resources.displayMetrics.density
    private val gap = (10 * density).toInt()
    private val minCellW = (100 * density).toInt()
    private val minCellH = (132 * density).toInt()
    private var cols = 1
    private var rows = 1
    private var cellH = minCellH
    private var items: List<FeatureTile> = emptyList()
    private var onOpen: ((FeatureTile, View) -> Unit)? = null

    fun setOnOpen(listener: (FeatureTile, View) -> Unit) {
        onOpen = listener
    }

    fun submit(tiles: List<FeatureTile>) {
        val old = HashMap<String, View>()
        for (i in 0 until childCount) getChildAt(i).let { old[it.tag as String] = it }
        val reorder = items.map { it.key } != tiles.map { it.key }
        items = tiles
        if (reorder) removeAllViewsInLayout()
        val inflater = LayoutInflater.from(context)
        tiles.forEach { t ->
            val v = old[t.key] ?: inflater.inflate(R.layout.item_feature_tile, this, false).also { it.tag = t.key }
            if (reorder) addViewInLayout(v, -1, v.layoutParams ?: generateDefaultLayoutParams(), true)
            bind(v, t)
        }
        if (reorder) requestLayout()
    }

    /** 强调色 / 描边改了：重新上色。 */
    fun restyle() {
        for (i in 0 until childCount) {
            val v = getChildAt(i)
            items.firstOrNull { it.key == v.tag }?.let { bind(v, it) }
        }
    }

    private fun bind(v: View, item: FeatureTile) {
        val ctx = v.context
        val card = v as MaterialCardView
        val accent = AppearanceStyler.currentAccent ?: ContextCompat.getColor(ctx, R.color.accent_forest)
        val surface = AppearanceStyler.currentSurface ?: ContextCompat.getColor(ctx, R.color.app_surface)
        card.setCardBackgroundColor(ColorUtils.blendARGB(surface, accent, 0.04f))
        card.strokeWidth = AppearanceStyler.currentBorderWidth
        card.strokeColor = AppearanceStyler.currentBorder
        v.findViewById<View>(R.id.tileIconBg).backgroundTintList =
            ColorStateList.valueOf(ColorUtils.setAlphaComponent(accent, 0x2E))
        v.findViewById<ImageView>(R.id.tileIcon).apply {
            setImageResource(item.icon)
            imageTintList = ColorStateList.valueOf(accent)
        }
        v.findViewById<ImageView>(R.id.tileWatermark).apply {
            setImageResource(item.icon)
            imageTintList = ColorStateList.valueOf(accent)
        }
        val title = ctx.getString(item.title)
        v.findViewById<TextView>(R.id.tileTitle).let { if (it.text != title) it.text = title }
        v.findViewById<TextView>(R.id.tileBadge).let {
            if (it.text.toString() != item.badge) it.text = item.badge
            it.setTextColor(
                if (item.attention) ContextCompat.getColor(ctx, R.color.status_warning)
                else MaterialColors.getColor(it, com.google.android.material.R.attr.colorOnSurfaceVariant)
            )
        }
        card.contentDescription = "$title，${item.badge}"
        card.tooltipText = title
        card.setOnClickListener { onOpen?.invoke(item, it) }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val n = childCount
        if (n == 0) {
            setMeasuredDimension(w, 0)
            return
        }
        val inner = w - paddingLeft - paddingRight
        val hMode = MeasureSpec.getMode(heightMeasureSpec)
        val hInner = MeasureSpec.getSize(heightMeasureSpec) - paddingTop - paddingBottom
        val compact = min(n, max(1, (inner + gap) / (minCellW + gap)))
        cols = compact
        if (hMode == MeasureSpec.EXACTLY) {
            var best = Double.MAX_VALUE
            for (c in 1..n) {
                val r = (n + c - 1) / c
                val cw = (inner - gap * (c - 1)) / c
                val ch = (hInner - gap * (r - 1)) / r
                if (cw < minCellW || ch < minCellH) continue
                val score = abs(ln(cw.toDouble() / ch) - ln(TARGET_RATIO))
                if (score < best) {
                    best = score
                    cols = c
                }
            }
        }
        rows = (n + cols - 1) / cols
        val natural = rows * minCellH + gap * (rows - 1)
        val h = if (hMode == MeasureSpec.EXACTLY) max(hInner, natural) else natural
        cellH = (h - gap * (rows - 1)) / rows
        for (i in 0 until n) {
            val cw = cellWidth(i, inner)
            getChildAt(i).measure(
                MeasureSpec.makeMeasureSpec(cw, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(cellH, MeasureSpec.EXACTLY),
            )
        }
        setMeasuredDimension(w, h + paddingTop + paddingBottom)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val inner = width - paddingLeft - paddingRight
        for (i in 0 until childCount) {
            val row = i / cols
            val inRow = if (row == rows - 1) i - row * cols else i % cols
            val cw = cellWidth(i, inner)
            val x = paddingLeft + inRow * (cw + gap)
            val y = paddingTop + row * (cellH + gap)
            getChildAt(i).layout(x, y, x + cw, y + cellH)
        }
    }

    /** 末行不满列时，末行几格平分整行宽度。 */
    private fun cellWidth(index: Int, inner: Int): Int {
        val row = index / cols
        val perRow = if (row == rows - 1) childCount - row * cols else cols
        return (inner - gap * (perRow - 1)) / perRow
    }

    override fun generateDefaultLayoutParams(): LayoutParams =
        LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)

    private companion object {
        const val TARGET_RATIO = 1.15
    }
}
