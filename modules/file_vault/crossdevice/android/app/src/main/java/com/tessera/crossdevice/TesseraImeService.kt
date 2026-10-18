package com.tessera.crossdevice

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Tessera 键盘：输入法模式。
 * 1) 被选为默认输入法时后台可读剪贴板（安卓 10 起除前台应用外唯一身份，按包名判定，实际干活的是
 * SyncService 的 ClipWatcher）；
 * 2) 键盘顶部有剪贴板时间线：点击输入到当前输入框，长按放进本机剪贴板。
 * 键盘本身只是够用的英文/符号键盘；切走后后台读不到剪贴板是系统规则，界面有说明。
 */
class TesseraImeService : InputMethodService() {

    private val main = Handler(Looper.getMainLooper())
    private var strip: LinearLayout? = null
    private var keysBox: LinearLayout? = null
    private var shift = ShiftState.OFF
    private var symbols = false
    private var lastShiftTap = 0L
    private var items: List<JSONObject> = emptyList()

    private enum class ShiftState { OFF, ONCE, LOCK }

    private val onEvent: (JSONObject) -> Unit = { obj ->
        when (obj.optString("event")) {
            "clip_timeline", "ready", "service_ready" -> main.post { loadTimeline(false) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        // 输入法可能比界面先起来（开机后直接在别的应用里打字）：把同步服务拉起来。
        runCatching { ContextCompat.startForegroundService(this, Intent(this, SyncService::class.java)) }
        SyncService.listeners.add(onEvent)
    }

    override fun onDestroy() {
        SyncService.listeners.remove(onEvent)
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ---------- 颜色与尺寸 ----------

    private val night: Boolean
        get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    private val bg get() = getColor(R.color.native_background)
    private val keyBg get() = getColor(R.color.app_elevated)
    private val keyAltBg get() = getColor(R.color.app_surface_muted)
    private val accent get() = getColor(R.color.accent_forest)
    private val fg get() = if (night) 0xFFECE8DF.toInt() else 0xFF1D1B16.toInt()
    private val fgMuted get() = if (night) 0xFFB8B2A6.toInt() else 0xFF5C574C.toInt()

    private fun dp(v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun rounded(color: Int, radius: Float = 8f) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(color)
    }

    // ---------- 视图 ----------

    override fun onCreateInputView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bg)
            setPadding(dp(4f), dp(4f), dp(4f), dp(6f))
        }
        root.addView(buildStripBar())
        keysBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(keysBox)
        renderKeys()
        return root
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        symbols = when ((info?.inputType ?: 0) and EditorInfo.TYPE_MASK_CLASS) {
            EditorInfo.TYPE_CLASS_NUMBER, EditorInfo.TYPE_CLASS_PHONE, EditorInfo.TYPE_CLASS_DATETIME -> true
            else -> false
        }
        shift = if (autoCapitalize(info)) ShiftState.ONCE else ShiftState.OFF
        renderKeys()
        loadTimeline(false)
    }

    private fun autoCapitalize(info: EditorInfo?): Boolean {
        val caps = info?.inputType?.and(EditorInfo.TYPE_TEXT_FLAG_CAP_SENTENCES) ?: 0
        if (caps == 0) return false
        val before = currentInputConnection?.getTextBeforeCursor(2, 0)?.toString().orEmpty()
        return before.isEmpty() || before.trimEnd().endsWith(".") || before.endsWith("\n")
    }

    /** 顶部一条：同步按钮 + 横向滚动的时间线条目。 */
    private fun buildStripBar(): View {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, dp(4f))
        }
        val sync = TextView(this).apply {
            text = "⇪"
            textSize = 18f
            gravity = Gravity.CENTER
            setTextColor(accent)
            background = rounded(keyAltBg, 16f)
            contentDescription = getString(R.string.ime_send_clipboard)
            if (Build.VERSION.SDK_INT >= 26) tooltipText = getString(R.string.ime_send_clipboard)
            setOnClickListener { sendClipboardNow() }
        }
        bar.addView(sync, LinearLayout.LayoutParams(dp(40f), dp(34f)).apply { marginEnd = dp(6f) })
        val scroller = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
        }
        strip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        scroller.addView(strip)
        bar.addView(scroller, LinearLayout.LayoutParams(0, dp(34f), 1f))
        renderStrip()
        return bar
    }

    private fun renderStrip() {
        val box = strip ?: return
        box.removeAllViews()
        if (items.isEmpty()) {
            box.addView(TextView(this).apply {
                text = getString(R.string.ime_timeline_empty)
                setTextColor(fgMuted)
                textSize = 13f
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8f), 0, dp(8f), 0)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
            return
        }
        for (item in items) {
            val local = item.optBoolean("local")
            val source = if (local) getString(R.string.this_device_short) else item.optString("source_name")
            val preview = item.optString("preview").ifEmpty {
                if (item.optString("preferred").startsWith("image/")) getString(R.string.clip_timeline_image)
                else getString(R.string.clip_timeline_no_preview)
            }
            val chip = TextView(this).apply {
                text = "$source · $preview"
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                maxWidth = dp(180f)
                textSize = 13f
                setTextColor(if (item.optBoolean("available", true)) fg else fgMuted)
                background = rounded(if (local) keyAltBg else keyBg, 16f)
                setPadding(dp(10f), 0, dp(10f), 0)
                gravity = Gravity.CENTER_VERTICAL
                contentDescription = getString(R.string.ime_chip_desc, source, preview)
                setOnClickListener { _ -> useItem(item, insert = true) }
                setOnLongClickListener { _ -> useItem(item, insert = false); true }
            }
            box.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
                marginEnd = dp(6f)
            })
        }
    }

    private fun loadTimeline(refresh: Boolean) {
        SyncService.call("clip_timeline", JSONObject().put("refresh", refresh)) { res ->
            val arr = res.optJSONObject("result")?.optJSONArray("items") ?: JSONArray()
            // 键盘上地方小：先放别的设备的内容（这正是它存在的理由），最多 15 条。
            val all = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
            val picked = (all.filter { !it.optBoolean("local") } + all.filter { it.optBoolean("local") }).take(15)
            main.post {
                items = picked
                renderStrip()
            }
        }
    }

    /** insert=true：直接输入到当前输入框；false：放进本机剪贴板。 */
    private fun useItem(item: JSONObject, insert: Boolean) {
        val id = item.optString("item_id")
        val ok = SyncService.call("clip_timeline_apply", JSONObject().put("item_id", id)) { res ->
            main.post {
                if (!res.optBoolean("ok", true)) {
                    val err = res.optString("error")
                    toast(
                        if (err.contains("clip_source_offline")) getString(R.string.clip_timeline_offline, item.optString("source_name"))
                        else err.ifEmpty { getString(R.string.clip_timeline_failed) }
                    )
                    return@post
                }
                val result = res.optJSONObject("result") ?: return@post
                if (insert) {
                    val text = plainText(result)
                    if (text == null) {
                        // 图片没法"输入"，放进剪贴板让用户自己粘贴。
                        ClipboardBridge.write(this, result)
                        ClipDedupe.markCurrent(this)
                        toast(getString(R.string.clip_timeline_copied))
                    } else {
                        currentInputConnection?.commitText(text, 1)
                    }
                } else {
                    ClipboardBridge.write(this, result)
                    ClipDedupe.markCurrent(this)
                    toast(getString(R.string.clip_timeline_copied))
                }
            }
        }
        if (!ok) toast(getString(R.string.starting))
    }

    private fun plainText(result: JSONObject): String? {
        val reps = result.optJSONArray("reps") ?: return null
        for (i in 0 until reps.length()) {
            val r = reps.optJSONObject(i) ?: continue
            if (!r.optString("mime").startsWith("text/plain")) continue
            val data = r.optString("data").takeIf { it.isNotEmpty() } ?: continue
            return runCatching { String(Base64.decode(data, Base64.DEFAULT), Charsets.UTF_8) }.getOrNull()
        }
        return null
    }

    private fun sendClipboardNow() {
        val payload = ClipboardBridge.readAsReps(this)
        if (payload == null) {
            toast(getString(R.string.clipboard_empty))
            return
        }
        ClipDedupe.lastKey = ClipDedupe.key(payload)
        val ok = SyncService.call("send_clip", payload.put("force", true))
        toast(getString(if (ok) R.string.clip_sent else R.string.starting))
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    // ---------- 按键 ----------

    private val letterRows = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
    private val symbolRows = listOf("1234567890", "@#$%&-+()/", "*\"':;!?_=", "~`|\\{}[]<>")

    private fun renderKeys() {
        val box = keysBox ?: return
        box.removeAllViews()
        if (symbols) {
            symbolRows.forEachIndexed { i, row ->
                val keys = row.map { c -> charKey(c.toString()) }.toMutableList()
                if (i == symbolRows.lastIndex) keys += deleteKey()
                box.addView(rowOf(keys))
            }
        } else {
            box.addView(rowOf("1234567890".map { charKey(it.toString(), alt = true) }))
            letterRows.forEachIndexed { i, row ->
                val keys = row.map { c -> charKey(if (shift != ShiftState.OFF) c.uppercase() else c.toString()) }.toMutableList()
                if (i == 2) {
                    keys.add(0, shiftKey())
                    keys += deleteKey()
                }
                box.addView(rowOf(keys))
            }
        }
        box.addView(rowOf(listOf(
            funcKey(if (symbols) "ABC" else "?123", 1.4f, R.string.ime_key_symbols) { symbols = !symbols; renderKeys() },
            globeKey(),
            charKey(","),
            spaceKey(),
            charKey("."),
            enterKey(),
        )))
    }

    private fun rowOf(keys: List<View>): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        keys.forEach { k ->
            val weight = (k.tag as? Float) ?: 1f
            addView(k, LinearLayout.LayoutParams(0, dp(44f), weight).apply { setMargins(dp(2f), dp(3f), dp(2f), dp(3f)) })
        }
    }

    private val keyFont: Typeface by lazy {
        androidx.core.content.res.ResourcesCompat.getFont(this, R.font.tessera_serif) ?: Typeface.SERIF
    }

    private fun baseKey(label: String, weight: Float, alt: Boolean): TextView = TextView(this).apply {
        text = label
        tag = weight
        gravity = Gravity.CENTER
        textSize = if (label.length > 1) 14f else 20f
        typeface = keyFont
        setTextColor(fg)
        background = rounded(if (alt) keyAltBg else keyBg)
        isSoundEffectsEnabled = true
    }

    private fun charKey(label: String, alt: Boolean = false): View = baseKey(label, 1f, alt).apply {
        setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            currentInputConnection?.commitText(label, 1)
            if (shift == ShiftState.ONCE) {
                shift = ShiftState.OFF
                renderKeys()
            }
        }
    }

    private fun funcKey(label: String, weight: Float, desc: Int, onClick: () -> Unit): View =
        baseKey(label, weight, alt = true).apply {
            contentDescription = getString(desc)
            if (Build.VERSION.SDK_INT >= 26) tooltipText = getString(desc)
            setOnClickListener {
                it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                onClick()
            }
        }

    private fun shiftKey(): View = funcKey(
        when (shift) { ShiftState.OFF -> "⇧"; ShiftState.ONCE -> "⬆"; ShiftState.LOCK -> "⇪" },
        1.4f, R.string.ime_key_shift,
    ) {
        val now = System.currentTimeMillis()
        shift = when {
            shift == ShiftState.ONCE && now - lastShiftTap < 400 -> ShiftState.LOCK
            shift == ShiftState.OFF -> ShiftState.ONCE
            else -> ShiftState.OFF
        }
        lastShiftTap = now
        renderKeys()
    }.also { if (shift != ShiftState.OFF) (it as TextView).setTextColor(accent) }

    /** 删除键：按住连删，跟系统键盘一样先慢后快。 */
    private fun deleteKey(): View = baseKey("⌫", 1.4f, alt = true).apply {
        contentDescription = getString(R.string.ime_key_delete)
        if (Build.VERSION.SDK_INT >= 26) tooltipText = getString(R.string.ime_key_delete)
        var repeats = 0
        val repeat = object : Runnable {
            override fun run() {
                deleteOne()
                repeats++
                main.postDelayed(this, if (repeats < 8) 90L else 40L)
            }
        }
        setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    v.isPressed = true
                    deleteOne()
                    repeats = 0
                    main.postDelayed(repeat, 420L)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.isPressed = false
                    main.removeCallbacks(repeat)
                    if (e.actionMasked == MotionEvent.ACTION_UP) v.performClick()
                }
            }
            true
        }
    }

    private fun deleteOne() {
        // 用按键事件而不是 deleteSurroundingText(1, 0)：前者由目标应用自己处理，
        // 选中一段时删整段、遇到表情这类代理对时删整个字符，都不会删出半个字。
        sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
    }

    private fun spaceKey(): View = baseKey(getString(R.string.ime_key_space), 4f, alt = false).apply {
        textSize = 13f
        setTextColor(fgMuted)
        setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            currentInputConnection?.commitText(" ", 1)
        }
    }

    private fun globeKey(): View = funcKey("🌐", 1f, R.string.ime_key_switch) {
        // 切回用户常用的输入法（打中文时）。切走之后后台就读不到剪贴板了。
        val switched = if (Build.VERSION.SDK_INT >= 28) switchToPreviousInputMethod() else false
        if (!switched) getSystemService(InputMethodManager::class.java)?.showInputMethodPicker()
    }.apply {
        setOnLongClickListener {
            getSystemService(InputMethodManager::class.java)?.showInputMethodPicker()
            true
        }
    }

    private fun enterKey(): View = funcKey("⏎", 1.4f, R.string.ime_key_enter) {
        val info = currentInputEditorInfo
        val action = (info?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        val noEnterAction = ((info?.imeOptions ?: 0) and EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0
        if (!noEnterAction && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            currentInputConnection?.performEditorAction(action)
        } else {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        }
    }
}
