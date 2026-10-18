package com.tessera.crossdevice

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewAnimationUtils
import android.view.ViewGroup
import android.view.animation.PathInterpolator
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnLayout
import kotlin.math.hypot
import kotlin.math.max

/**
 * 全屏次功能面板的宿主：同一时刻只开一个，从点中的入口处圆形展开，返回键 / Esc / 左上角返回收起。
 * 面板在布局里按 tag 标出返回键（panelBack）和正文（panelBody），这里不认具体 id，新增面板只需 [register]。
 *
 * 要在剪贴板时间线全屏层之前创建：返回键回调后注册的先响应，时间线全屏应先于面板被收起。
 */
class PanelHost(private val activity: AppCompatActivity, private val root: ViewGroup) {

    private class Entry(val panel: View, val onOpen: (() -> Unit)?, val onClose: (() -> Unit)?) {
        var cx = -1f
        var cy = -1f
        var anim: Animator? = null
    }

    private val entries = LinkedHashMap<String, Entry>()

    /** 当前打开的面板 key，没有则为 null。 */
    var current: String? = null
        private set

    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            close()
        }
    }

    init {
        activity.onBackPressedDispatcher.addCallback(activity, back)
    }

    fun register(key: String, panel: View, onOpen: (() -> Unit)? = null, onClose: (() -> Unit)? = null) {
        entries[key] = Entry(panel, onOpen, onClose)
        panel.findViewWithTag<View>(TAG_BACK)?.setOnClickListener { close() }
        panel.findViewWithTag<View>(TAG_BODY)?.let { AdaptiveLayout.applyPanelBody(it) }
        // 沉浸式（安卓 15 起强制）下面板铺到状态栏下面，按系统栏让位；非沉浸式时这里拿到的是 0。
        ViewCompat.setOnApplyWindowInsetsListener(panel) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    fun isOpen(key: String): Boolean = current == key

    /** 打开面板；origin 是被点的入口，展开动画以它的中心为圆心。 */
    fun open(key: String, origin: View? = null, animate: Boolean = true) {
        val e = entries[key] ?: return
        if (current == key) return
        current?.let { hide(it, animate = false) }
        current = key
        back.isEnabled = true
        origin?.let { centerIn(it) }?.let { (x, y) -> e.cx = x; e.cy = y }
        e.anim?.cancel()
        e.panel.visibility = View.VISIBLE
        e.onOpen?.invoke()
        if (animate && ValueAnimator.areAnimatorsEnabled()) e.panel.doOnLayout { reveal(e) }
    }

    /** 收起当前面板；没有打开的面板时返回 false。 */
    fun close(animate: Boolean = true): Boolean {
        val key = current ?: return false
        current = null
        back.isEnabled = false
        hide(key, animate)
        return true
    }

    /** 键盘 Esc 收起；返回 true 表示已消费。 */
    fun handleKey(event: KeyEvent): Boolean {
        if (current == null || event.keyCode != KeyEvent.KEYCODE_ESCAPE) return false
        if (event.action == KeyEvent.ACTION_UP) close()
        return true
    }

    fun save(out: Bundle) {
        out.putString(STATE_KEY, current)
    }

    /** 转屏 / 换深浅色重建后回到原来的面板，不播动画。 */
    fun restore(state: Bundle?) {
        state?.getString(STATE_KEY)?.let { open(it, animate = false) }
    }

    private fun reveal(e: Entry) {
        val p = e.panel
        if (!p.isAttachedToWindow) return
        val (cx, cy) = origin(e, p)
        val r = hypot(max(cx, p.width - cx), max(cy, p.height - cy))
        e.anim = ViewAnimationUtils.createCircularReveal(p, cx.toInt(), cy.toInt(), 0f, r).apply {
            duration = OPEN_MS
            interpolator = PathInterpolator(0.4f, 0f, 0.2f, 1f)
            start()
        }
        // 正文稍晚一点浮上来，和圆形展开错开半拍，层次更清楚。
        p.findViewWithTag<View>(TAG_BODY)?.let { body ->
            body.alpha = 0f
            body.translationY = 24 * p.resources.displayMetrics.density
            body.animate().alpha(1f).translationY(0f)
                .setStartDelay(60).setDuration(OPEN_MS - 40)
                .setInterpolator(PathInterpolator(0.4f, 0f, 0.2f, 1f))
                .withLayer().start()
        }
    }

    private fun hide(key: String, animate: Boolean) {
        val e = entries[key] ?: return
        val p = e.panel
        e.onClose?.invoke()
        e.anim?.cancel()
        p.findViewWithTag<View>(TAG_BODY)?.animate()?.cancel()
        if (!animate || !ValueAnimator.areAnimatorsEnabled() || !p.isAttachedToWindow || p.width == 0) {
            p.visibility = View.GONE
            return
        }
        val (cx, cy) = origin(e, p)
        val r = hypot(max(cx, p.width - cx), max(cy, p.height - cy))
        e.anim = ViewAnimationUtils.createCircularReveal(p, cx.toInt(), cy.toInt(), r, 0f).apply {
            duration = CLOSE_MS
            interpolator = PathInterpolator(0.4f, 0f, 1f, 1f)
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    // 收起途中又被打开就别藏了。
                    if (current != key) p.visibility = View.GONE
                }
            })
            start()
        }
    }

    /** 圆心：记下的入口中心；没有（程序打开 / 恢复）就用面板中心。 */
    private fun origin(e: Entry, p: View): Pair<Float, Float> =
        if (e.cx >= 0 && e.cy >= 0) e.cx to e.cy else p.width / 2f to p.height / 2f

    /** 入口中心换算到根布局坐标（面板铺满根布局，两者坐标系一致）。 */
    private fun centerIn(v: View): Pair<Float, Float> {
        val a = IntArray(2)
        val b = IntArray(2)
        v.getLocationInWindow(a)
        root.getLocationInWindow(b)
        return (a[0] - b[0] + v.width / 2f) to (a[1] - b[1] + v.height / 2f)
    }

    private companion object {
        const val TAG_BACK = "panelBack"
        const val TAG_BODY = "panelBody"
        const val STATE_KEY = "open_panel"
        const val OPEN_MS = 300L
        const val CLOSE_MS = 220L
    }
}
