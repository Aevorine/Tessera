package com.tessera.crossdevice

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Rect
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import org.json.JSONObject

/**
 * 界面内容的「关闭 / 恢复 / 排序」偏好。关掉的内容不再显示，直到在「管理已关闭的内容」里恢复。
 * 键是稳定的资源名（card:cardHero、btn:btnScan、tile:pair），与界面语言无关；同时记下关闭时的显示名，
 * 恢复列表里能看懂是什么。
 */
object LayoutPrefs {
    private const val PREFS = "tessera_layout"
    private const val KEY_HIDDEN = "hidden_labels"
    private const val KEY_TILE_ORDER = "tile_order"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** key → 显示名。 */
    fun hidden(ctx: Context): Map<String, String> {
        val raw = prefs(ctx).getString(KEY_HIDDEN, null) ?: return emptyMap()
        return runCatching {
            val o = JSONObject(raw)
            o.keys().asSequence().associateWith { o.optString(it) }
        }.getOrDefault(emptyMap())
    }

    fun isHidden(ctx: Context, key: String) = hidden(ctx).containsKey(key)

    fun setHidden(ctx: Context, key: String, label: String, hide: Boolean) {
        val cur = hidden(ctx).toMutableMap()
        if (hide) cur[key] = label else cur.remove(key)
        save(ctx, cur)
    }

    fun restore(ctx: Context, keys: Collection<String>) {
        val cur = hidden(ctx).toMutableMap()
        keys.forEach { cur.remove(it) }
        save(ctx, cur)
    }

    private fun save(ctx: Context, map: Map<String, String>) {
        val o = JSONObject()
        map.forEach { (k, v) -> o.put(k, v) }
        prefs(ctx).edit().putString(KEY_HIDDEN, o.toString()).apply()
    }

    fun tileOrder(ctx: Context): List<String> =
        prefs(ctx).getString(KEY_TILE_ORDER, "").orEmpty().split(',').filter { it.isNotBlank() }

    fun setTileOrder(ctx: Context, order: List<String>) {
        prefs(ctx).edit().putString(KEY_TILE_ORDER, order.joinToString(",")).apply()
    }

    /** 按用户排过的顺序排列；新出现的（升级后多出来的功能格）排在后面，保持原有相对次序。 */
    fun <T> ordered(ctx: Context, items: List<T>, key: (T) -> String): List<T> {
        val order = tileOrder(ctx)
        if (order.isEmpty()) return items
        val rank = order.withIndex().associate { it.value to it.index }
        return items.withIndex().sortedWith(compareBy({ rank[key(it.value)] ?: (order.size + it.index) }, { it.index }))
            .map { it.value }
    }
}

/**
 * 登记可关闭的界面块，负责三件事：
 * 1. 关掉的块始终 GONE。很多块的显隐由业务代码随时改（进度卡、接着刚才横幅…），所以不能只设一次，
 *    而是在每帧绘制前（OnPreDraw）把被关掉又被设成可见的块压回去，并取消这一帧，不会闪。
 * 2. 编辑模式：在最上层盖一层透明浮层，给屏幕上每个可关闭的块右上角画一个 ×，点 × 即关闭；浮层本身
 *    不拦触摸，块照常可用、可滚动。
 * 3. 管理已关闭的内容：勾选恢复 / 全部恢复。
 */
class LayoutCustomizer(
    private val root: ViewGroup,
    /** 关闭 / 撤销后宿主要刷新的（功能格等）。 */
    private val onChanged: () -> Unit,
    /** 恢复了内容：很多块的显隐由业务状态决定，最稳妥是让宿主整页重建一次。 */
    private val onRestored: () -> Unit,
) {
    private data class Entry(val key: String, val view: View, val label: () -> String)

    private val ctx: Context = root.context
    private val entries = LinkedHashMap<String, Entry>()
    /** 不允许关闭的块：关掉就再也找不到「管理已关闭的内容」入口了。 */
    private val locked = HashSet<String>()
    private var overlay: FrameLayout? = null
    private var editSnack: Snackbar? = null
    private val tmp = IntArray(2)
    private val rect = Rect()

    val editing: Boolean get() = overlay != null

    /** 内存里的已关闭键：OnPreDraw 每帧都要查，不能每帧去解析 SharedPreferences。 */
    private var hiddenKeys: Set<String> = LayoutPrefs.hidden(ctx).keys

    private val enforcer = ViewTreeObserver.OnPreDrawListener {
        var changed = false
        val hidden = hiddenKeys
        for (e in entries.values) {
            if (e.key in hidden && e.view.visibility != View.GONE) {
                e.view.visibility = View.GONE
                changed = true
            }
        }
        if (overlay != null) positionCloseButtons()
        !changed
    }

    init {
        root.viewTreeObserver.addOnPreDrawListener(enforcer)
    }

    fun register(key: String, view: View, label: () -> String) {
        entries[key] = Entry(key, view, label)
    }

    fun lock(key: String) {
        locked += key
    }

    /** 自动登记：所有带 id 的卡片与按钮。按钮里的返回 / 退出全屏一类导航控件不登记。 */
    fun registerTree(container: View, skipIds: Set<Int>) {
        if (container.id != View.NO_ID && container.id !in skipIds) {
            val name = runCatching { ctx.resources.getResourceEntryName(container.id) }.getOrNull()
            if (name != null && !name.contains("Back") && !name.contains("Exit")) {
                when (container) {
                    is MaterialCardView -> register("card:$name", container) { firstText(container) ?: name }
                    is MaterialButton -> register("btn:$name", container) {
                        container.text?.toString()?.takeIf { it.isNotBlank() }
                            ?: container.contentDescription?.toString() ?: name
                    }
                }
            }
        }
        if (container is ViewGroup && container !is TileGrid && container !is androidx.recyclerview.widget.RecyclerView) {
            for (i in 0 until container.childCount) registerTree(container.getChildAt(i), skipIds)
        }
    }

    fun hide(key: String, label: String) {
        if (key in locked) return
        LayoutPrefs.setHidden(ctx, key, label, true)
        hiddenKeys = LayoutPrefs.hidden(ctx).keys
        entries[key]?.view?.visibility = View.GONE
        onChanged()
        Snackbar.make(root, ctx.getString(R.string.layout_closed, label), Snackbar.LENGTH_LONG)
            .setAction(R.string.layout_undo) {
                LayoutPrefs.setHidden(ctx, key, label, false)
                hiddenKeys = LayoutPrefs.hidden(ctx).keys
                // 关闭前它就是可见的（用户正是看着它点的 ×），撤销直接设回可见即可。
                entries[key]?.view?.visibility = View.VISIBLE
                onChanged()
            }.show()
    }

    // ---- 编辑模式 ----

    fun toggleEdit() = if (editing) exitEdit() else enterEdit()

    fun enterEdit() {
        if (overlay != null) return
        val o = FrameLayout(ctx).apply {
            isClickable = false
            isFocusable = false
            elevation = 64f
        }
        root.addView(o, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        overlay = o
        positionCloseButtons()
        editSnack = Snackbar.make(root, R.string.layout_edit_hint, Snackbar.LENGTH_INDEFINITE)
            .setAction(R.string.layout_edit_done) { exitEdit() }
            .also { it.show() }
    }

    fun exitEdit() {
        overlay?.let { root.removeView(it) }
        overlay = null
        editSnack?.dismiss()
        editSnack = null
    }

    /** 给屏幕上可见的每个块放一个 ×。按键复用按钮，只改位置，滚动时跟着走。 */
    private fun positionCloseButtons() {
        val o = overlay ?: return
        o.getLocationInWindow(tmp)
        val ox = tmp[0]
        val oy = tmp[1]
        val size = (28 * ctx.resources.displayMetrics.density).toInt()
        val seen = HashSet<String>()
        for (e in entries.values) {
            if (e.key in locked || !e.view.isShown || !e.view.getGlobalVisibleRect(rect)) continue
            if (rect.width() < size || rect.height() < size / 2) continue
            seen += e.key
            var btn = o.findViewWithTag<ImageButton>(e.key)
            if (btn == null) {
                btn = ImageButton(ctx).apply {
                    tag = e.key
                    setImageResource(R.drawable.ic_close)
                    background = ContextCompat.getDrawable(ctx, R.drawable.bg_layout_close)
                    imageTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, android.R.color.white))
                    contentDescription = ctx.getString(R.string.layout_close_item, e.label())
                    tooltipText = contentDescription
                    setPadding(size / 5, size / 5, size / 5, size / 5)
                    scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                    setOnClickListener { hide(e.key, e.label()) }
                }
                o.addView(btn, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.START))
            }
            // 放在块的右上角内侧；getGlobalVisibleRect 是窗口坐标，换算到浮层坐标。
            val x = (rect.right - ox - size - size / 6).toFloat()
            val y = (rect.top - oy + size / 6).toFloat()
            if (btn.translationX != x) btn.translationX = x
            if (btn.translationY != y) btn.translationY = y
        }
        for (i in o.childCount - 1 downTo 0) {
            val c = o.getChildAt(i)
            if (c.tag !in seen) o.removeViewAt(i)
        }
    }

    // ---- 管理已关闭的内容 ----

    fun showManager() {
        val hidden = LayoutPrefs.hidden(ctx)
        val b = MaterialAlertDialogBuilder(ctx).setTitle(R.string.layout_manage_title)
        if (hidden.isEmpty()) {
            b.setMessage(R.string.layout_manage_empty)
                .setPositiveButton(R.string.layout_edit_start) { _, _ -> enterEdit() }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
            return
        }
        val keys = hidden.keys.toList()
        val labels = keys.map { hidden[it].orEmpty().ifBlank { it } }.toTypedArray()
        val checked = BooleanArray(keys.size)
        b.setMultiChoiceItems(labels, checked) { _, i, on -> checked[i] = on }
            .setPositiveButton(R.string.layout_restore_selected) { _, _ ->
                LayoutPrefs.restore(ctx, keys.filterIndexed { i, _ -> checked[i] })
                restoreVisibility()
            }
            .setNeutralButton(R.string.layout_restore_all) { _, _ ->
                LayoutPrefs.restore(ctx, keys)
                restoreVisibility()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun restoreVisibility() {
        hiddenKeys = LayoutPrefs.hidden(ctx).keys
        exitEdit()
        onRestored()
    }

    private fun firstText(v: View): String? {
        if (v is TextView && v !is MaterialButton) {
            val t = v.text?.toString()?.trim().orEmpty()
            if (t.isNotEmpty()) return t.take(24)
        }
        if (v is ViewGroup) for (i in 0 until v.childCount) firstText(v.getChildAt(i))?.let { return it }
        return null
    }
}
