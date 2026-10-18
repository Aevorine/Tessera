package com.tessera.crossdevice

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors

/** 「全部功能」的一格：key 对应一个全屏面板，badge 是格上那行实时小结，attention 时小结用警示色。 */
data class FeatureTile(
    val key: String,
    @DrawableRes val icon: Int,
    @StringRes val title: Int,
    val badge: String,
    val attention: Boolean = false,
)

/** 功能格适配器。小结变了只重绑那一格（DiffUtil），状态每秒轮询也不会整片闪。 */
class FeatureTileAdapter(
    private val onOpen: (FeatureTile, View) -> Unit,
) : ListAdapter<FeatureTile, FeatureTileAdapter.Holder>(DIFF) {

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val card = view as MaterialCardView
        val iconBg: View = view.findViewById(R.id.tileIconBg)
        val icon: ImageView = view.findViewById(R.id.tileIcon)
        val title: TextView = view.findViewById(R.id.tileTitle)
        val badge: TextView = view.findViewById(R.id.tileBadge)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_feature_tile, parent, false))

    override fun onBindViewHolder(h: Holder, position: Int) {
        val item = getItem(position)
        val ctx = h.itemView.context
        val accent = AppearanceStyler.currentAccent ?: ContextCompat.getColor(ctx, R.color.accent_forest)
        h.card.setCardBackgroundColor(AppearanceStyler.currentSurface ?: ContextCompat.getColor(ctx, R.color.app_surface))
        h.card.strokeWidth = AppearanceStyler.currentBorderWidth
        h.card.strokeColor = AppearanceStyler.currentBorder
        h.iconBg.backgroundTintList = ColorStateList.valueOf(ColorUtils.setAlphaComponent(accent, 0x2E))
        h.icon.setImageResource(item.icon)
        h.icon.imageTintList = ColorStateList.valueOf(accent)
        h.title.setText(item.title)
        h.badge.text = item.badge
        h.badge.setTextColor(
            if (item.attention) ContextCompat.getColor(ctx, R.color.status_warning)
            else MaterialColors.getColor(h.badge, com.google.android.material.R.attr.colorOnSurfaceVariant)
        )
        h.card.contentDescription = ctx.getString(item.title) + "，" + item.badge
        h.card.setOnClickListener { onOpen(item, it) }
    }

    /** 强调色 / 描边改了：格子是后建的，样式遍历够不到，只能整片重绑。 */
    fun restyle() = notifyItemRangeChanged(0, itemCount)

    private companion object {
        val DIFF = object : DiffUtil.ItemCallback<FeatureTile>() {
            override fun areItemsTheSame(a: FeatureTile, b: FeatureTile) = a.key == b.key
            override fun areContentsTheSame(a: FeatureTile, b: FeatureTile) = a == b
        }
    }
}
