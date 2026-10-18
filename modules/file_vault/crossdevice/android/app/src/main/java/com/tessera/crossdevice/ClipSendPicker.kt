package com.tessera.crossdevice

import android.app.Activity
import android.text.TextUtils
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.widget.TextViewCompat

/** 候选条目：当前剪贴板（itemId 为空）或时间线上的一条。 */
class ClipPickEntry(val itemId: String?, val meta: String, val preview: String)

/** 「发送剪贴板」选择框：可单选、多选、全选，点发送后回调所选条目（保持传入顺序）。 */
object ClipSendPicker {
    fun show(activity: Activity, entries: List<ClipPickEntry>, onSend: (List<ClipPickEntry>) -> Unit) {
        val dp = activity.resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        val checked = BooleanArray(entries.size) { it == 0 }
        val boxes = ArrayList<CheckBox>()
        var dialog: AlertDialog? = null
        var syncing = false
        val all = CheckBox(activity).apply {
            text = activity.getString(R.string.clip_pick_all)
            setPadding(px(8), px(8), px(8), px(8))
        }
        val list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

        fun refresh() {
            syncing = true
            all.isChecked = checked.all { it }
            syncing = false
            val n = checked.count { it }
            dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
                text = activity.getString(R.string.clip_pick_send, n)
                isEnabled = n > 0
            }
        }

        entries.forEachIndexed { i, e ->
            val row = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(px(8), px(6), px(8), px(6))
            }
            val box = CheckBox(activity).apply {
                isChecked = checked[i]
                // 整行响应点击，复选框自己不抢事件
                isClickable = false
                isFocusable = false
            }
            boxes += box
            val texts = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            texts.addView(TextView(activity).apply {
                text = e.meta
                TextViewCompat.setTextAppearance(this, themeAttr(activity, com.google.android.material.R.attr.textAppearanceBodySmall))
            })
            texts.addView(TextView(activity).apply {
                text = e.preview
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
                TextViewCompat.setTextAppearance(this, themeAttr(activity, com.google.android.material.R.attr.textAppearanceBodyMedium))
            })
            row.addView(box)
            row.addView(texts)
            row.setOnClickListener {
                checked[i] = !checked[i]
                box.isChecked = checked[i]
                refresh()
            }
            list.addView(row)
        }

        all.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            checked.fill(on)
            boxes.forEach { it.isChecked = on }
            refresh()
        }

        val maxH = (activity.resources.displayMetrics.heightPixels * 0.7).toInt()
        val scroll = object : ScrollView(activity) {
            override fun onMeasure(w: Int, h: Int) {
                super.onMeasure(w, MeasureSpec.makeMeasureSpec(maxH, MeasureSpec.AT_MOST))
            }
        }.apply { addView(list) }
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(16), px(8), px(16), 0)
            addView(all)
            addView(scroll)
        }

        dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.clip_pick_title)
            .setView(root)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(activity.getString(R.string.clip_pick_send, 1)) { _, _ ->
                onSend(entries.filterIndexed { i, _ -> checked[i] })
            }
            .create()
        dialog.setOnShowListener { refresh() }
        dialog.show()
    }

    private fun themeAttr(activity: Activity, attr: Int): Int {
        val tv = TypedValue()
        activity.theme.resolveAttribute(attr, tv, true)
        return tv.resourceId
    }
}
