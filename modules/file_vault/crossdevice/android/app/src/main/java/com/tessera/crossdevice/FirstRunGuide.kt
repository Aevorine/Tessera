package com.tessera.crossdevice

import android.app.Activity
import android.content.Context
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/**
 * 第一次打开时的操作引导。
 *
 * 第一屏是一列折叠分区，新用户不知道先点哪个，且配对需两台设备配合，第一步走错就卡住；
 * 所以做进应用而非文档。只在第一次弹出，之后可从菜单随时重看。
 */
object FirstRunGuide {
    private const val PREFS = "tessera_first_run"
    private const val KEY_SEEN = "guide_seen"

    /** 第一次打开时自动弹一次。已经看过就什么都不做。 */
    fun showIfFirstRun(activity: Activity) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_SEEN, false)) return
        show(activity)
        // 弹出时就记"看过了"，不等点确定：按返回键就是"我不想看"，不应下次再弹。
        prefs.edit().putBoolean(KEY_SEEN, true).apply()
    }

    /** 从菜单主动重看。 */
    fun show(activity: Activity) {
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(activity, 20)
            setPadding(pad, dp(activity, 8), pad, 0)
        }

        // 步骤按真实使用顺序排，不按功能重要性排：新用户要的是"接下来点哪里"。
        val steps = listOf(
            R.string.guide_step1_title to R.string.guide_step1_body,
            R.string.guide_step2_title to R.string.guide_step2_body,
            R.string.guide_step3_title to R.string.guide_step3_body,
            R.string.guide_step4_title to R.string.guide_step4_body,
        )

        steps.forEachIndexed { index, (titleRes, bodyRes) ->
            content.addView(
                TextView(activity).apply {
                    // 编号是有意义的：这四步**必须按顺序做**，第 2 步之前做第 3 步
                    // 会卡住。所以这里的数字不是装饰，是信息。
                    text = activity.getString(titleRes, index + 1)
                    textSize = 16f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                },
                lp(activity, top = if (index == 0) 0 else 18),
            )
            content.addView(
                TextView(activity).apply {
                    text = activity.getString(bodyRes)
                    textSize = 15f
                    setLineSpacing(dp(activity, 4).toFloat(), 1f)
                    alpha = 0.85f
                },
                lp(activity, top = 4),
            )
        }

        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.guide_title)
            .setView(ScrollView(activity).apply { addView(content) })
            .setPositiveButton(R.string.guide_got_it, null)
            .show()
    }

    private fun lp(activity: Activity, top: Int) =
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(activity, top) }

    private fun dp(activity: Activity, value: Int): Int =
        (value * activity.resources.displayMetrics.density).toInt()
}
