package com.tessera.crossdevice

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.View

/**
 * 剪贴板同步耗时的迷你曲线，与桌面端 LatencySparkline 同规则：
 * 纵轴从 0 起画，最近一次比中位数慢一倍以上（且多 50 ms 以上）时整条改警示色。
 */
class SparklineView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private var values: List<Long> = emptyList()
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = resources.displayMetrics.density * 1.4f
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val path = Path()
    private val area = Path()

    fun setValues(v: List<Long>) {
        if (v == values) return
        values = v
        visibility = if (v.size >= 2) VISIBLE else GONE
        contentDescription = LatencyTrend.describe(context, v)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (values.size < 2) return
        val color = context.getColor(if (LatencyTrend.worse(values)) R.color.status_warning else R.color.accent_forest)
        line.color = color
        dot.color = color
        fill.color = color
        fill.alpha = 30
        val pad = resources.displayMetrics.density * 2
        val w = width - pad * 2
        val h = height - pad * 2
        val top = maxOf(values.max(), 10L).toFloat()
        val step = w / (values.size - 1)
        path.reset()
        area.reset()
        area.moveTo(pad, pad + h)
        values.forEachIndexed { i, v ->
            val x = pad + i * step
            val y = pad + h - (v / top) * h
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            area.lineTo(x, y)
        }
        area.lineTo(pad + w, pad + h)
        area.close()
        canvas.drawPath(area, fill)
        canvas.drawPath(path, line)
        val lastY = pad + h - (values.last() / top) * h
        canvas.drawCircle(pad + w, lastY, pad, dot)
    }
}

/** 延迟样本的统计，与桌面端 src/lib/latencyStats.ts 保持同一判据。 */
object LatencyTrend {
    fun worse(v: List<Long>): Boolean {
        if (v.size < 4) return false
        val median = v.sorted()[v.size / 2]
        return v.last() > maxOf(median * 2, median + 50)
    }

    fun describe(context: Context, v: List<Long>): String {
        if (v.isEmpty()) return ""
        val base = context.getString(
            R.string.clip_latency_stats, v.size, v.min().toInt(), v.average().toInt(), v.max().toInt(),
        )
        return if (worse(v)) base + " · " + context.getString(R.string.clip_latency_worse) else base
    }
}
