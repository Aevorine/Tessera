package com.tessera.crossdevice

import android.content.res.ColorStateList
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import com.google.android.material.card.MaterialCardView
import com.tessera.crossdevice.databinding.ActivityMainBinding

object AppearanceStyler {
    /** 分区标题图标的 tag：同 id 重复会让 ViewBinding 无法生成唯一引用，且只需批量染色。 */
    private const val SECTION_ICON_TAG = "sectionIcon"
    private const val PANEL_ROOT_TAG = "panelRoot"
    private const val PANEL_BAR_TAG = "panelBar"

    /**
     * 当前强调色，给 RecyclerView 的行用（它们在 apply() 之后才创建，遍历视图树够不到）。
     * null 表示尚未应用外观，用主题默认色。
     */
    @Volatile
    var currentAccent: Int? = null
        private set

    /** 卡片底色与描边，给后建的功能格用（同 currentAccent 的理由）。 */
    var currentSurface: Int? = null
        private set
    var currentBorder: Int = Color.TRANSPARENT
        private set
    var currentBorderWidth: Int = 0
        private set

    @Suppress("DEPRECATION")
    fun apply(activity: MainActivity, ui: ActivityMainBinding, config: AppearanceConfig) {
        val accent = ContextCompat.getColor(
            activity,
            when (config.accent) {
                Accent.FOREST -> R.color.accent_forest
                Accent.SKY -> R.color.accent_sky
                Accent.INDIGO -> R.color.accent_indigo
                Accent.VIOLET -> R.color.accent_violet
                Accent.ROSE -> R.color.accent_rose
                Accent.EMBER -> R.color.accent_ember
                Accent.CLAY -> R.color.accent_clay
                Accent.GOLD -> R.color.accent_gold
                Accent.OLIVE -> R.color.accent_olive
            },
        )
        val background = ContextCompat.getColor(
            activity,
            if (config.visualStyle == VisualStyle.ORIENTAL_TECH) {
                R.color.oriental_background
            } else {
                R.color.native_background
            },
        )
        val surface = ContextCompat.getColor(activity, R.color.app_surface)
        val gold = ContextCompat.getColor(activity, R.color.decorative_gold)

        ui.root.setBackgroundColor(background)
        ui.toolbar.setBackgroundColor(ColorUtils.blendARGB(surface, accent, 0.08f))
        // 标题文字也吃强调色，跟桌面端页面标题左边那个强调色图标底片是同一个
        // 用意：用户选了金色，整个应用（不是只有按钮）都该透着金色。
        ui.toolbar.setTitleTextColor(accent)
        ui.toolbar.subtitle = when {
            config.interfaceMode == InterfaceMode.PROFESSIONAL ->
                activity.getString(R.string.appearance_professional_mode)
            config.visualStyle == VisualStyle.ORIENTAL_TECH ->
                activity.getString(R.string.appearance_oriental)
            else -> null
        }
        ui.btnScan.backgroundTintList = ColorStateList.valueOf(accent)
        // 进度条在 RecyclerView 每一行里，visio() 走不到后建的行：存下强调色，由适配器绑定时取用。
        currentAccent = accent

        val border = when {
            config.decoration == Decoration.OFF -> Color.TRANSPARENT
            config.visualStyle == VisualStyle.ORIENTAL_TECH ->
                ColorUtils.blendARGB(accent, gold, if (config.decoration == Decoration.STANDARD) 0.42f else 0.22f)
            else -> ColorUtils.setAlphaComponent(accent, if (config.decoration == Decoration.STANDARD) 105 else 58)
        }
        visit(ui.root) { view ->
            if (view is MaterialCardView) {
                view.strokeWidth = if (config.decoration == Decoration.OFF) 0 else 1
                view.strokeColor = border
                view.setCardBackgroundColor(surface)
            }
            // 分区标题图标统一染成强调色，对齐桌面端的强调色图标底片。
            if (view is ImageView && view.tag == SECTION_ICON_TAG) {
                view.imageTintList = ColorStateList.valueOf(accent)
            }
            // 全屏面板：底色同主界面，标题栏同顶栏。
            when (view.tag) {
                PANEL_ROOT_TAG -> view.setBackgroundColor(background)
                PANEL_BAR_TAG -> view.setBackgroundColor(ColorUtils.blendARGB(surface, accent, 0.08f))
            }
        }
        // 状态头透一点强调色，一眼认出它是首页的「主角」。
        ui.cardHero.setCardBackgroundColor(ColorUtils.blendARGB(surface, accent, 0.10f))
        currentSurface = surface
        currentBorder = border
        currentBorderWidth = if (config.decoration == Decoration.OFF) 0 else 1
        activity.window.statusBarColor = ColorUtils.blendARGB(background, accent, 0.08f)
        activity.window.navigationBarColor = background
    }

    private fun visit(view: View, action: (View) -> Unit) {
        action(view)
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) visit(view.getChildAt(index), action)
        }
    }
}
