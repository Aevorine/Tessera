package com.tessera.crossdevice

import android.content.Context
import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 打开应用时的验证方式：不验证 / 密码 / 指纹或面容。
 *
 * 只管"谁能打开本机这个应用"，与设备配对、设备间身份认证无关，刻意不共用密码。
 * 生物识别走 BiometricPrompt，应用拿不到模板；密码只存 PBKDF2 派生值和盐，防的是别人拿起手机，不防
 * 读闪存。
 */
object AppLock {

    enum class Mode { NONE, PASSWORD, BIOMETRIC }

    private const val PREFS = "tessera-lock"
    private const val KEY_MODE = "mode"
    private const val KEY_HASH = "pw_hash"
    private const val KEY_SALT = "pw_salt"

    private const val ITERATIONS = 120_000

    private fun prefs(c: Context): SharedPreferences =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun mode(c: Context): Mode =
        runCatching { Mode.valueOf(prefs(c).getString(KEY_MODE, Mode.NONE.name)!!) }
            .getOrDefault(Mode.NONE)

    fun setNone(c: Context) {
        prefs(c).edit().putString(KEY_MODE, Mode.NONE.name).remove(KEY_HASH).remove(KEY_SALT).apply()
    }

    fun setBiometric(c: Context) {
        prefs(c).edit().putString(KEY_MODE, Mode.BIOMETRIC.name).apply()
    }

    fun setPassword(c: Context, password: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs(c).edit()
            .putString(KEY_MODE, Mode.PASSWORD.name)
            .putString(KEY_SALT, salt.toHex())
            .putString(KEY_HASH, derive(password, salt).toHex())
            .apply()
    }

    /** 校验密码。用常数时间比较，避免按前缀逐字节试出来。 */
    fun checkPassword(c: Context, password: String): Boolean {
        val p = prefs(c)
        val salt = p.getString(KEY_SALT, null)?.fromHex() ?: return false
        val want = p.getString(KEY_HASH, null)?.fromHex() ?: return false
        return MessageDigest.isEqual(derive(password, salt), want)
    }

    private fun derive(password: String, salt: ByteArray): ByteArray {
        val spec = javax.crypto.spec.PBEKeySpec(
            password.toCharArray(), salt, ITERATIONS, 256,
        )
        return javax.crypto.SecretKeyFactory
            .getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(spec).encoded
    }

    /** 这台设备能不能用生物识别。不能用时界面上就不该给这个选项。 */
    fun biometricAvailable(c: Context): Boolean =
        BiometricManager.from(c).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL,
        ) == BiometricManager.BIOMETRIC_SUCCESS

    /** 弹系统生物识别框；允许回退到锁屏凭据，否则传感器脏了用户会被锁在应用外。 */
    fun promptBiometric(activity: AppCompatActivity, onResult: (Boolean) -> Unit) {
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) =
                    onResult(true)

                override fun onAuthenticationError(code: Int, msg: CharSequence) = onResult(false)
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(R.string.lock_prompt_title))
                .setSubtitle(activity.getString(R.string.lock_prompt_subtitle))
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                )
                .build(),
        )
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    private fun String.fromHex() = runCatching {
        chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }.getOrNull()
}
