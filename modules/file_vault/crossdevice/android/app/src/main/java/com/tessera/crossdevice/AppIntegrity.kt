package com.tessera.crossdevice

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/**
 * 运行时校验 APK 是否仍是自己的签名，挡重打包（改代码后用攻击者密钥重签）。
 *
 * 挡不住能改本段代码的人，只是抬高成本；真正的防线是包里没有秘密（密钥派生自口令，会话密钥由 Noise
 * 现协商）。
 * 校验失败只返回状态、不退出进程：debug 签名、合法自编译（AGPL）都会对不上，由界面（安全体检）呈现
 * 。
 */
object AppIntegrity {

    /** 官方发布密钥的证书 SHA-256。 */
    // 此值非秘密（对发布 APK 跑 keytool 即可得），写进代码是让应用自己比对。
    // 取自 v0.1.13 发布包；换发布密钥时必须同步改，否则官方包会被判成非官方。
    private const val RELEASE_CERT_SHA256 =
        "2efcf2a139bbdef2ca5445f91b006a914777eaa0767ba52d492ed4363a946d5f"

    enum class Status {
        /** 签名是官方发布密钥。 */
        OFFICIAL,

        /** 签名有效，但不是官方密钥——自编译版本，或者被重打包了。 */
        UNOFFICIAL,

        /** 读不到签名信息。系统层面的异常，不当成"有问题"。 */
        UNKNOWN,
    }

    data class Result(val status: Status, val fingerprint: String?)

    @Volatile
    private var cached: Result? = null

    /** 结果会缓存：签名在进程生命周期内不可能变，而读它要过一次 IPC 到 PackageManager。 */
    fun check(context: Context): Result {
        cached?.let { return it }
        val result = compute(context)
        cached = result
        return result
    }

    private fun compute(context: Context): Result {
        val fingerprint = try {
            currentCertSha256(context)
        } catch (e: Exception) {
            null
        } ?: return Result(Status.UNKNOWN, null)

        // 用 MessageDigest.isEqual（恒定时间）：此处指纹是公开值并无计时风险，
        // 但让安全摘要比较在全库只有一种写法更不易出错。
        val official = MessageDigest.isEqual(
            fingerprint.toByteArray(Charsets.US_ASCII),
            RELEASE_CERT_SHA256.toByteArray(Charsets.US_ASCII),
        )
        return Result(if (official) Status.OFFICIAL else Status.UNOFFICIAL, fingerprint)
    }

    /** 当前 APK 签名证书的 SHA-256（小写十六进制，无分隔符）。 */
    private fun currentCertSha256(context: Context): String? {
        val pm = context.packageManager
        val name = context.packageName

        // API 28 起 GET_SIGNATURES 废弃且会返回含轮换前旧证书的全部历史签名者；
        // 判断"现在谁签的"须用 GET_SIGNING_CERTIFICATES 取 apkContentsSigners。
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES)
            val signing = info.signingInfo ?: return null
            if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(name, PackageManager.GET_SIGNATURES).signatures
        } ?: return null

        val first = signatures.firstOrNull() ?: return null
        val digest = MessageDigest.getInstance("SHA-256").digest(first.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}
