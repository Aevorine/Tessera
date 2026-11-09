package com.tessera.crossdevice

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Surface
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy

/**
 * 厂商人脸识别（荣耀 / 华为）。
 *
 * 为什么需要它：这两家的人脸解锁大多是 2D 方案，系统没有把它登记进安卓 BiometricPrompt，第三方应用调系统
 * 生物识别时只看得到指纹——手机明明能刷脸解锁，Tessera 却只弹指纹框。厂商在系统里另有一套人脸服务
 * （`com.hihonor.android.facerecognition.FaceRecognizeManager` / `com.huawei.facerecognition.FaceRecognizeManager`），
 * 用的是用户在系统设置里录入的那张脸，比对在系统安全环境里做，应用拿不到人脸数据，只拿到「通过 / 不通过」。
 *
 * 实现：全部走反射与动态代理，APK 里不放任何厂商类或桩类；机器上没有这套服务、没有权限、没录入人脸，
 * [available] 都返回 false，界面就不出现这个方式，退回系统生物识别。没有网络、没有常驻。
 *
 * 接口形状（类名、方法签名、回调码）参考 AdvancedBiometricPromptCompat（Apache-2.0，Sergey Komlach，
 * https://github.com/Salat-Cx65/AdvancedBiometricPromptCompat ）的 biometric-api 桩定义，代码为本项目重写；
 * 见 THIRD-PARTY-NOTICES.md。
 */
object VendorFace {

    private val CANDIDATES = listOf(
        "com.hihonor.android.facerecognition.FaceRecognizeManager",
        "com.huawei.facerecognition.FaceRecognizeManager",
    )

    // FaceRecognizeCallback.onCallbackEvent(reqId, type, code, errorCode)
    private const val TYPE_AUTH = 2
    private const val CODE_RESULT = 1
    private const val CODE_CANCEL = 2
    private const val CODE_ACQUIRE = 3
    private const val CODE_BUSY = 4

    // FaceErrorCode
    private const val ERR_SUCCESS = 0
    private const val ERR_FAILED = 1
    private const val ERR_CANCELED = 2
    private const val ERR_COMPARE_FAIL = 3
    private const val ERR_TIMEOUT = 4
    private const val ERR_LOCKOUT = 8
    private const val ERR_NO_FACE_DATA = 10
    private const val ERR_CAMERA_FAIL = 12

    /** 认证过程中给用户的实时提示（AcquireInfo 映射过来）。 */
    enum class Hint { NO_FACE, TOO_FAR, TOO_CLOSE, MOVE, DARK, BRIGHT, EYES_CLOSED, OCCLUDED, KEEP_STILL, LIVENESS }

    enum class Failure { NOT_MATCH, TIMEOUT, LOCKOUT, CAMERA, CANCELED, UNAVAILABLE }

    interface Listener {
        fun onHint(hint: Hint) {}
        fun onSuccess()
        fun onFailure(reason: Failure)
    }

    private val main = Handler(Looper.getMainLooper())

    /** 探测结果缓存一次进程；厂商服务不会在运行中出现或消失。录入状态每次现查。 */
    @Volatile private var cls: Class<*>? = null
    @Volatile private var probed = false

    private fun managerClass(): Class<*>? {
        if (probed) return cls
        synchronized(this) {
            if (!probed) {
                cls = CANDIDATES.firstNotNullOfOrNull { runCatching { Class.forName(it) }.getOrNull() }
                probed = true
            }
        }
        return cls
    }

    private fun callbackInterface(c: Class<*>): Class<*>? =
        runCatching { Class.forName(c.name + "\$FaceRecognizeCallback") }.getOrNull()

    private fun newManager(ctx: Context, handler: InvocationHandler): Any? {
        val c = managerClass() ?: return null
        val cbIface = callbackInterface(c) ?: return null
        val cb = Proxy.newProxyInstance(cbIface.classLoader, arrayOf(cbIface), handler)
        return runCatching {
            c.getConstructor(Context::class.java, cbIface).newInstance(ctx.applicationContext, cb)
        }.getOrNull()
    }

    private fun Any.call(name: String, vararg args: Any?): Any? {
        val m = javaClass.methods.firstOrNull { it.name == name && it.parameterTypes.size == args.size } ?: return null
        return m.invoke(this, *args)
    }

    private fun supported(mgr: Any): Boolean = runCatching {
        val ability = mgr.call("getFaceRecognitionAbility")
        if (ability != null) {
            val f = ability.javaClass.getField("isFaceRecognitionSupport")
            f.getBoolean(ability)
        } else {
            ((mgr.call("getHardwareSupportType") as? Int) ?: 0) and 1 != 0
        }
    }.getOrElse {
        runCatching { ((mgr.call("getHardwareSupportType") as? Int) ?: 0) and 1 != 0 }.getOrDefault(false)
    }

    /** 有厂商人脸服务、硬件支持、系统里已录入人脸、本应用调得动（init 返回 0）。 */
    fun available(ctx: Context): Boolean {
        if (managerClass() == null) return false
        val noop = InvocationHandler { _, m, _ -> if (m.returnType == Boolean::class.javaPrimitiveType) false else null }
        val mgr = newManager(ctx, noop) ?: return false
        return try {
            if (!supported(mgr)) return false
            val init = runCatching { mgr.call("init") as? Int }.getOrNull() ?: -1
            if (init != 0) return false
            val ids = runCatching { mgr.call("getEnrolledFaceIDs") as? IntArray }.getOrNull()
            ids != null && ids.isNotEmpty()
        } catch (t: Throwable) {
            DiagnosticLog.record(ctx, "applock", "vendor_face_probe_failed", t.javaClass.simpleName)
            false
        } finally {
            runCatching { mgr.call("release") }
        }
    }

    /** 一次进行中的人脸认证；[cancel] 幂等。 */
    class Session internal constructor(private val mgr: Any, private val reqId: Int) {
        @Volatile internal var finished = false
        fun cancel() {
            if (finished) return
            finished = true
            runCatching { mgr.call("cancelAuthenticate", reqId) }
            runCatching { mgr.call("release") }
        }
    }

    /**
     * 开始认证。surface 是一块可见的预览面（厂商服务把摄像头画面送到这里）；对不上脸会继续比对直到
     * 成功、超时或被取消。回调都在主线程。
     */
    fun authenticate(ctx: Context, surface: Surface, listener: Listener): Session? {
        val reqId = (System.nanoTime() and 0x3fff_ffff).toInt().coerceAtLeast(1)
        var session: Session? = null
        val handler = InvocationHandler { _, m, args ->
            if (m.name == "onCallbackEvent" && args != null && args.size == 4) {
                val type = args[1] as Int
                val code = args[2] as Int
                val err = args[3] as Int
                if (type == TYPE_AUTH) main.post { dispatch(session, code, err, listener) }
            }
            when (m.returnType) {
                Boolean::class.javaPrimitiveType -> false
                Int::class.javaPrimitiveType -> 0
                else -> null
            }
        }
        val mgr = newManager(ctx, handler) ?: return null
        return try {
            if ((mgr.call("init") as? Int ?: -1) != 0) {
                runCatching { mgr.call("release") }
                return null
            }
            val s = Session(mgr, reqId)
            session = s
            val ret = mgr.call("authenticate", reqId, TYPE_AUTH, surface) as? Int ?: -1
            if (ret != 0) {
                s.cancel()
                null
            } else {
                s
            }
        } catch (t: Throwable) {
            DiagnosticLog.record(ctx, "applock", "vendor_face_start_failed", "${t.javaClass.simpleName}: ${t.cause?.javaClass?.simpleName}")
            runCatching { mgr.call("release") }
            null
        }
    }

    private fun dispatch(session: Session?, code: Int, err: Int, l: Listener) {
        if (session == null || session.finished) return
        when (code) {
            CODE_ACQUIRE -> hintFor(err)?.let { l.onHint(it) }
            CODE_RESULT -> when (err) {
                ERR_SUCCESS -> { session.cancel(); l.onSuccess() }
                ERR_COMPARE_FAIL, ERR_FAILED -> l.onHint(Hint.MOVE) // 继续比对，不打断
                ERR_TIMEOUT -> { session.cancel(); l.onFailure(Failure.TIMEOUT) }
                ERR_LOCKOUT -> { session.cancel(); l.onFailure(Failure.LOCKOUT) }
                ERR_CAMERA_FAIL -> { session.cancel(); l.onFailure(Failure.CAMERA) }
                ERR_CANCELED -> { session.cancel(); l.onFailure(Failure.CANCELED) }
                ERR_NO_FACE_DATA -> { session.cancel(); l.onFailure(Failure.UNAVAILABLE) }
                else -> { session.cancel(); l.onFailure(Failure.NOT_MATCH) }
            }
            CODE_CANCEL -> { session.cancel(); l.onFailure(Failure.CANCELED) }
            CODE_BUSY -> { session.cancel(); l.onFailure(Failure.UNAVAILABLE) }
        }
    }

    // AcquireInfo → 提示
    private fun hintFor(info: Int): Hint? = when (info) {
        5 -> Hint.NO_FACE
        6 -> Hint.TOO_FAR
        7 -> Hint.TOO_CLOSE
        8, 9, 10, 11, 15, 16, 17, 18, 29 -> Hint.MOVE
        30, 39, 32 -> Hint.DARK
        31 -> Hint.BRIGHT
        22 -> Hint.EYES_CLOSED
        21, 23 -> Hint.OCCLUDED
        19, 20, 28 -> Hint.KEEP_STILL
        13, 14 -> Hint.LIVENESS
        else -> null
    }
}
