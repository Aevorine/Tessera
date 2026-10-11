package com.tessera.crossdevice

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.transition.AutoTransition
import androidx.transition.TransitionManager

/**
 * 可展开 / 折叠的分区。首页卡片很长而日常只用前两三张，折叠后收起态只占一行标题，且仍在原位不必重找
 * 。
 * 折叠状态写进 SharedPreferences，免得每次打开都重收一遍；与桌面端同一套（标题行可点，展开时箭头转
 * 180°）。
 */
class Section(
    private val key: String,
    private val header: View,
    private val body: View,
    private val chevron: ImageView,
    private val title: String,
    /** 折叠动画要作用在哪个容器上。传卡片本身，动的才是整张卡的高度。 */
    private val animateIn: ViewGroup?,
) {
    var expanded: Boolean = true
        private set

    fun bind(context: Context, defaultExpanded: Boolean) {
        expanded = SectionPrefs.isExpanded(context, key, defaultExpanded)
        apply(animate = false)
        header.setOnClickListener {
            expanded = !expanded
            SectionPrefs.setExpanded(context, key, expanded)
            apply(animate = true)
        }
    }

    /** 外部要求展开（比如刚生成了配对码，收着就白生成了）。 */
    fun expand(context: Context) {
        if (expanded) return
        expanded = true
        SectionPrefs.setExpanded(context, key, true)
        apply(animate = true)
    }

    private fun apply(animate: Boolean) {
        if (animate && animateIn != null) {
            // 只做高度和淡入淡出，时长压到 160ms：折叠是个高频动作，
            // 动画长一点点就会让人觉得"卡"，而这一条正是要避免的。
            TransitionManager.beginDelayedTransition(
                animateIn,
                AutoTransition().apply { duration = 160 },
            )
        }
        body.visibility = if (expanded) View.VISIBLE else View.GONE
        chevron.rotation = if (expanded) 180f else 0f
        header.contentDescription = header.context.getString(
            if (expanded) R.string.section_collapse else R.string.section_expand,
            title,
        )
    }
}

/** 折叠状态的存档。单独一个文件，跟外观设置分开——两者的生命周期不一样。 */
object SectionPrefs {
    private const val STORE = "sections_v1"

    fun isExpanded(context: Context, key: String, default: Boolean): Boolean =
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getBoolean(key, default)

    fun setExpanded(context: Context, key: String, value: Boolean) {
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
            .edit().putBoolean(key, value).apply()
    }
}
