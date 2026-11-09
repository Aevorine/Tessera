package com.tessera.crossdevice

import android.app.KeyguardManager
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 打开应用时的验证：不验证 / 密码 / 生物识别（人脸→指纹→虹膜，系统决定具体模态，失败可退应用密码、锁屏密码）。
 * 与设备配对、设备间认证无关，不共用密码。密码只存 PBKDF2 派生值和盐。
 * 会话状态只在内存：进程被杀即重新上锁。
 */
object AppLock {

    enum class Mode { NONE, PASSWORD, BIOMETRIC }
    enum class Kind { FACE, FINGERPRINT, IRIS }

    private const val PREFS = "tessera-lock"
    private const val KEY_MODE = "mode"
    private const val KEY_HASH = "pw_hash"
    private const val KEY_SALT = "pw_salt"
    private const val KEY_FAILS = "fails"
    private const val KEY_LOCKED_UNTIL = "locked_until_wall"

    private const val ITERATIONS = 120_000
    private const val FREE_FAILS = 5
    private const val BASE_LOCKOUT_MS = 30_000L
    private const val MAX_LOCKOUT_MS = 15 * 60_000L
    /** 本应用自己拉起的页面（选文件、扫码、系统验证框）回来不重新上锁的最长时间 */
    private const val EXPECT_RETURN_MS = 10 * 60_000L

    @Volatile private var unlocked = false
    @Volatile private var expectReturnUntil = 0L
    @Volatile private var returnDeadline = 0L

    private fun prefs(c: Context): SharedPreferences =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun mode(c: Context): Mode =
        runCatching { Mode.valueOf(prefs(c).getString(KEY_MODE, Mode.NONE.name)!!) }
            .getOrDefault(Mode.NONE)

    fun setNone(c: Context) {
        prefs(c).edit().putString(KEY_MODE, Mode.NONE.name).remove(KEY_HASH).remove(KEY_SALT).apply()
        unlocked = true
    }

    fun setBiometric(c: Context) {
        prefs(c).edit().putString(KEY_MODE, Mode.BIOMETRIC.name).apply()
        unlocked = true
    }

    fun setPassword(c: Context, password: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs(c).edit()
            .putString(KEY_MODE, Mode.PASSWORD.name)
            .putString(KEY_SALT, salt.toHex())
            .putString(KEY_HASH, derive(password, salt).toHex())
            .apply()
        unlocked = true
    }

    fun hasPassword(c: Context): Boolean = prefs(c).contains(KEY_HASH)

    /** 校验密码，常数时间比较；连错 5 次后指数退避（30 s 起，最长 15 min）。 */
    fun checkPassword(c: Context, password: String): Boolean {
        if (lockoutRemainingMs(c) > 0) return false
        val p = prefs(c)
        val salt = p.getString(KEY_SALT, null)?.fromHex() ?: return false
        val want = p.getString(KEY_HASH, null)?.fromHex() ?: return false
        val ok = MessageDigest.isEqual(derive(password, salt), want)
        if (ok) p.edit().remove(KEY_FAILS).remove(KEY_LOCKED_UNTIL).apply() else recordFailure(p)
        return ok
    }

    private fun recordFailure(p: SharedPreferences) {
        val fails = p.getInt(KEY_FAILS, 0) + 1
        val edit = p.edit().putInt(KEY_FAILS, fails)
        if (fails >= FREE_FAILS) {
            val wait = (BASE_LOCKOUT_MS shl (fails - FREE_FAILS).coerceAtMost(5)).coerceAtMost(MAX_LOCKOUT_MS)
            edit.putLong(KEY_LOCKED_UNTIL, System.currentTimeMillis() + wait)
        }
        edit.apply()
    }

    fun lockoutRemainingMs(c: Context): Long =
        (prefs(c).getLong(KEY_LOCKED_UNTIL, 0L) - System.currentTimeMillis()).coerceAtLeast(0L)

    private fun derive(password: String, salt: ByteArray): ByteArray {
        val spec = javax.crypto.spec.PBEKeySpec(password.toCharArray(), salt, ITERATIONS, 256)
        return javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    @Volatile private var vendorFaceCache: Boolean? = null

    /** 荣耀 / 华为厂商人脸是否可用（见 VendorFace）。探测要初始化一次厂商服务，结果缓存，refresh 时重查。 */
    fun vendorFaceAvailable(c: Context, refresh: Boolean = false): Boolean {
        if (!refresh) vendorFaceCache?.let { return it }
        return VendorFace.available(c).also { vendorFaceCache = it }
    }

    /** 本机有的生物识别硬件，按 人脸 → 指纹 → 虹膜。includeVendor 把厂商人脸也算作「人脸」。 */
    fun biometricKinds(c: Context, includeVendor: Boolean = true): List<Kind> {
        val pm = c.packageManager
        val q = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        return buildList {
            if ((q && pm.hasSystemFeature(PackageManager.FEATURE_FACE)) || (includeVendor && vendorFaceAvailable(c))) add(Kind.FACE)
            if (pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)) add(Kind.FINGERPRINT)
            if (q && pm.hasSystemFeature(PackageManager.FEATURE_IRIS)) add(Kind.IRIS)
        }
    }

    /** 已录入、第三方应用可调用的生物识别（厂商"便捷级"人脸不对第三方开放，这里自然为 false）。 */
    fun biometricEnrolled(c: Context): Boolean =
        BiometricManager.from(c).canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS

    fun deviceSecure(c: Context): Boolean =
        c.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

    /** 这台设备能不能用"生物识别"这一档（含锁屏密码兜底）。 */
    fun biometricAvailable(c: Context): Boolean = biometricEnrolled(c) || deviceSecure(c) || vendorFaceAvailable(c)

    /** 当前模式下这台设备真正有得验的方式；全空表示锁形同虚设（如设备没设锁屏且未设应用密码）。 */
    fun hasAnyVerifier(c: Context): Boolean = when (mode(c)) {
        Mode.NONE -> false
        Mode.PASSWORD -> hasPassword(c)
        Mode.BIOMETRIC -> biometricEnrolled(c) || deviceSecure(c) || hasPassword(c) || vendorFaceAvailable(c)
    }

    // ---- 会话 ----

    fun isUnlocked(c: Context): Boolean = unlocked || !hasAnyVerifier(c)

    fun markUnlocked() { unlocked = true; expectReturnUntil = 0L }

    /** 本应用即将拉起自己的页面；回来时不重新上锁。 */
    fun expectReturn() { expectReturnUntil = SystemClock.elapsedRealtime() + EXPECT_RETURN_MS }

    /** Activity 进入后台（非旋转等配置变化）：除非是自己拉起的页面，否则上锁。 */
    fun onBackground() {
        if (SystemClock.elapsedRealtime() > expectReturnUntil) unlocked = false
        else returnDeadline = expectReturnUntil
    }

    /** 回到前台：若离开时靠"自己拉起的页面"免锁，但回来已超过时限（期间从那个页面去了桌面），照样上锁。 */
    fun onForeground() {
        if (returnDeadline != 0L && SystemClock.elapsedRealtime() > returnDeadline) unlocked = false
        returnDeadline = 0L
        expectReturnUntil = 0L
    }

    /** 弹系统生物识别框。credentialOnly = 只用锁屏密码（API 30+）。 */
    fun promptBiometric(
        activity: AppCompatActivity,
        credentialOnly: Boolean = false,
        negativeText: CharSequence? = null,
        onResult: (ok: Boolean, code: Int) -> Unit,
    ) {
        val secure = deviceSecure(activity)
        val authenticators = when {
            credentialOnly && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> DEVICE_CREDENTIAL
            secure -> BIOMETRIC_WEAK or DEVICE_CREDENTIAL
            else -> BIOMETRIC_WEAK
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(true, 0)
                override fun onAuthenticationError(code: Int, msg: CharSequence) = onResult(false, code)
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(activity.getString(R.string.lock_prompt_title))
            .setSubtitle(activity.getString(R.string.lock_prompt_subtitle))
            .setAllowedAuthenticators(authenticators)
            .setConfirmationRequired(false)
        if (authenticators and DEVICE_CREDENTIAL == 0) {
            info.setNegativeButtonText(negativeText ?: activity.getString(android.R.string.cancel))
        }
        // 低版本的锁屏密码页是独立 Activity，会触发 onStop；先登记，回来不被当成离开
        expectReturn()
        prompt.authenticate(info.build())
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    private fun String.fromHex() = runCatching {
        chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }.getOrNull()
}
