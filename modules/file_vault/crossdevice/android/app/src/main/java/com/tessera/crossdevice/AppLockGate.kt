package com.tessera.crossdevice

import android.os.Build
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * 打开应用时的验证门。
 * 根因修复：旧实现只在 onCreate 验一次，前台服务让 Activity 常驻，之后从桌面/最近任务/通知回来都不再验证，
 * 且验证框底下内容完全可见。现在：每次从后台回来（非旋转、非本应用拉起的页面）都盖上锁屏层，验过才揭开。
 * 顺序：生物识别（人脸→指纹→虹膜，按硬件命名）→ 应用密码 → 锁屏密码；设备不支持或没设置的不显示。
 */
class AppLockGate(private val activity: AppCompatActivity) {

    private val density = activity.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private lateinit var overlay: FrameLayout
    private lateinit var btnBiometric: MaterialButton
    private lateinit var btnPassword: MaterialButton
    private lateinit var btnCredential: MaterialButton
    private lateinit var passwordBox: LinearLayout
    private lateinit var passwordLayout: TextInputLayout
    private lateinit var passwordInput: TextInputEditText
    private lateinit var errorText: TextView
    private var autoTried = false
    private var prompting = false

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() { activity.moveTaskToBack(true) }
    }

    fun attach() {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        overlay = buildOverlay()
        content.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        activity.onBackPressedDispatcher.addCallback(activity, backCallback)
        if (!AppLock.isUnlocked(activity)) show() else hide()
    }

    fun onStart() {
        AppLock.onForeground()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.setRecentsScreenshotEnabled(AppLock.mode(activity) == AppLock.Mode.NONE)
        }
        if (!AppLock.isUnlocked(activity)) show()
    }

    fun onResume() {
        if (overlay.isVisible && !autoTried && !prompting) {
            autoTried = true
            overlay.post { if (overlay.isVisible) startPrimary() }
        }
    }

    fun onStop(changingConfigurations: Boolean) {
        if (changingConfigurations || prompting) return
        AppLock.onBackground()
        if (!AppLock.isUnlocked(activity)) show()
    }

    val isLocked: Boolean get() = ::overlay.isInitialized && overlay.isVisible

    private fun show() {
        refreshMethods()
        autoTried = false
        errorText.isVisible = false
        passwordInput.setText("")
        overlay.isVisible = true
        overlay.bringToFront()
        backCallback.isEnabled = true
        DiagnosticLog.record(activity, "applock", "locked", "mode=${AppLock.mode(activity)}")
    }

    private fun hide() {
        overlay.isVisible = false
        backCallback.isEnabled = false
        activity.getSystemService(InputMethodManager::class.java)
            ?.hideSoftInputFromWindow(overlay.windowToken, 0)
    }

    private fun unlocked(via: String) {
        AppLock.markUnlocked()
        hide()
        DiagnosticLog.record(activity, "applock", "unlocked", "via=$via")
    }

    private fun biometricOffered() =
        AppLock.mode(activity) == AppLock.Mode.BIOMETRIC && AppLock.biometricEnrolled(activity)

    private fun passwordOffered() = AppLock.hasPassword(activity) &&
        AppLock.mode(activity) != AppLock.Mode.NONE

    private fun credentialOffered() = AppLock.mode(activity) == AppLock.Mode.BIOMETRIC &&
        AppLock.deviceSecure(activity) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    /** 按硬件给生物识别按钮命名与配图；不支持的方式整行隐藏。 */
    private fun refreshMethods() {
        val kinds = AppLock.biometricKinds(activity)
        btnBiometric.text = activity.getString(
            when {
                AppLock.Kind.FACE in kinds && AppLock.Kind.FINGERPRINT in kinds -> R.string.lock_btn_face_fingerprint
                AppLock.Kind.FACE in kinds -> R.string.lock_btn_face
                AppLock.Kind.FINGERPRINT in kinds -> R.string.lock_btn_fingerprint
                AppLock.Kind.IRIS in kinds -> R.string.lock_btn_iris
                else -> R.string.lock_btn_biometric
            },
        )
        btnBiometric.setIconResource(if (AppLock.Kind.FACE in kinds && AppLock.Kind.FINGERPRINT !in kinds) R.drawable.ic_lock_face else R.drawable.ic_lock_fingerprint)
        btnBiometric.isVisible = biometricOffered()
        btnPassword.isVisible = passwordOffered()
        btnCredential.isVisible = credentialOffered() && !biometricOffered()
        // 只剩密码一种时直接展开输入框
        val onlyPassword = !btnBiometric.isVisible && !btnCredential.isVisible && btnPassword.isVisible
        passwordBox.isVisible = onlyPassword
        btnPassword.isVisible = btnPassword.isVisible && !onlyPassword
    }

    /** 自动发起排第一的方式。 */
    private fun startPrimary() {
        when {
            biometricOffered() -> promptBiometric(credentialOnly = false)
            credentialOffered() -> promptBiometric(credentialOnly = true)
            passwordOffered() -> openPassword()
            !AppLock.hasAnyVerifier(activity) -> unlocked("no_verifier")
        }
    }

    private fun promptBiometric(credentialOnly: Boolean) {
        if (prompting) return
        prompting = true
        errorText.isVisible = false
        val negative = if (passwordOffered()) activity.getString(R.string.lock_btn_app_password) else null
        AppLock.promptBiometric(activity, credentialOnly, negative) { ok, code ->
            prompting = false
            if (ok) {
                unlocked(if (credentialOnly) "device_credential" else "biometric")
                return@promptBiometric
            }
            DiagnosticLog.record(activity, "applock", "prompt_failed", "code=$code")
            when (code) {
                BiometricPrompt.ERROR_NEGATIVE_BUTTON -> openPassword()
                BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED -> Unit
                BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
                    showError(activity.getString(R.string.lock_biometric_locked_out))
                else -> showError(activity.getString(R.string.lock_biometric_failed))
            }
        }
    }

    private fun openPassword() {
        btnPassword.isVisible = false
        passwordBox.isVisible = true
        passwordInput.requestFocus()
        activity.getSystemService(InputMethodManager::class.java)
            ?.showSoftInput(passwordInput, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun submitPassword() {
        val wait = AppLock.lockoutRemainingMs(activity)
        if (wait > 0) {
            showError(activity.getString(R.string.lock_locked_out, ((wait + 999) / 1000).toInt()))
            return
        }
        if (AppLock.checkPassword(activity, passwordInput.text?.toString().orEmpty())) {
            passwordInput.setText("")
            unlocked("password")
        } else {
            passwordInput.setText("")
            val w = AppLock.lockoutRemainingMs(activity)
            showError(
                if (w > 0) activity.getString(R.string.lock_locked_out, ((w + 999) / 1000).toInt())
                else activity.getString(R.string.lock_wrong_password),
            )
            DiagnosticLog.record(activity, "applock", "wrong_password")
        }
    }

    private fun showError(msg: String) {
        errorText.text = msg
        errorText.isVisible = true
    }

    private fun buildOverlay(): FrameLayout {
        val surface = MaterialColors.getColor(activity, com.google.android.material.R.attr.colorSurface, 0)
        val onSurface = MaterialColors.getColor(activity, com.google.android.material.R.attr.colorOnSurface, 0)
        val onSurfaceVariant = MaterialColors.getColor(activity, com.google.android.material.R.attr.colorOnSurfaceVariant, onSurface)
        val error = MaterialColors.getColor(activity, com.google.android.material.R.attr.colorError, 0)

        val root = FrameLayout(activity).apply {
            setBackgroundColor(surface)
            isClickable = true
            isFocusable = true
            elevation = dp(64).toFloat()
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        root.addView(column, FrameLayout.LayoutParams(dp(400).coerceAtMost(activity.resources.displayMetrics.widthPixels), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        column.addView(ImageView(activity).apply {
            setImageDrawable(activity.applicationInfo.loadIcon(activity.packageManager))
            contentDescription = null
        }, LinearLayout.LayoutParams(dp(72), dp(72)))

        column.addView(TextView(activity).apply {
            text = activity.getString(R.string.lock_screen_title)
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_HeadlineSmall)
            setTextColor(onSurface)
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16); bottomMargin = dp(32) })

        fun button(outlined: Boolean, onClick: () -> Unit): MaterialButton {
            val b = if (outlined) MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle) else MaterialButton(activity)
            b.minHeight = dp(52)
            b.iconGravity = MaterialButton.ICON_GRAVITY_TEXT_START
            b.setOnClickListener { onClick() }
            column.addView(b, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            return b
        }

        btnBiometric = button(false) { promptBiometric(credentialOnly = false) }
        btnCredential = button(false) { promptBiometric(credentialOnly = true) }.apply {
            text = activity.getString(R.string.lock_btn_device_credential)
            setIconResource(R.drawable.ic_lock_pin)
        }
        btnPassword = button(true) { openPassword() }.apply {
            text = activity.getString(R.string.lock_btn_app_password)
            setIconResource(R.drawable.ic_lock_pin)
        }

        passwordBox = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        passwordLayout = TextInputLayout(activity, null, com.google.android.material.R.attr.textInputOutlinedStyle).apply {
            hint = activity.getString(R.string.lock_enter_password)
            endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
        }
        passwordInput = TextInputEditText(passwordLayout.context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_DONE
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_DONE) { submitPassword(); true } else false
            }
        }
        passwordLayout.addView(passwordInput)
        passwordBox.addView(passwordLayout, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        passwordBox.addView(MaterialButton(activity).apply {
            text = activity.getString(R.string.lock_unlock)
            minHeight = dp(52)
            setOnClickListener { submitPassword() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
        column.addView(passwordBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

        errorText = TextView(activity).apply {
            setTextColor(if (error != 0) error else onSurfaceVariant)
            gravity = Gravity.CENTER
            isVisible = false
        }
        column.addView(errorText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })
        return root
    }
}
