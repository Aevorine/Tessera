package com.tessera.crossdevice

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * 后台同步的健康记录与厂商自启动入口。
 *
 * 手机「打开应用能同步、放一阵就连不上电脑」的根因不在网络：后台服务被系统停掉（Android 15
 * 前台服务时限、厂商省电冻结、后台启动被拒）。被停那一刻没有界面，用户只能看到电脑那边一直离线。
 * 这里把「被停过」记下来，下次打开应用在「后台运行」卡片上直说，并给出能修好的入口。
 */
object BackgroundHealth {
    private const val PREFS = "background_health"

    fun noteStopped(ctx: Context, code: String, detail: String) {
        runCatching {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("stop_code", code)
                .putString("stop_detail", detail.take(200))
                .putLong("stop_at", System.currentTimeMillis())
                .apply()
        }
    }

    fun noteRunning(ctx: Context) {
        runCatching {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong("running_at", System.currentTimeMillis())
                .apply()
        }
    }

    /** 最近一次被系统停止的时间（毫秒），从没停过返回 0。 */
    fun lastStopAt(ctx: Context): Long =
        runCatching { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("stop_at", 0L) }
            .getOrDefault(0L)

    /** 有一次还没告诉过用户的「被停止」：返回 true 并标记已告知（每次停止只提示一次）。 */
    fun consumeUnseenStop(ctx: Context): Boolean = runCatching {
        val sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = sp.getLong("stop_at", 0L)
        if (at == 0L || sp.getLong("seen_at", 0L) >= at) return@runCatching false
        sp.edit().putLong("seen_at", at).apply()
        true
    }.getOrDefault(false)

    fun clearStop(ctx: Context) {
        runCatching {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove("stop_code").remove("stop_detail").remove("stop_at").apply()
        }
    }

    /** 荣耀 / 华为系统要在「应用启动管理」里把本应用改为手动管理并允许后台活动，否则前台服务照样被冻结。 */
    fun isHonorOrHuawei(): Boolean {
        val m = (Build.MANUFACTURER ?: "").lowercase()
        val b = (Build.BRAND ?: "").lowercase()
        return m.contains("honor") || m.contains("huawei") || b.contains("honor") || b.contains("huawei")
    }

    /**
     * 打开厂商的自启动 / 后台活动管理页。没有公开 API，只能按已知页面逐个试，全部失败退到本应用的
     * 应用信息页（那里也能进「耗电详情 / 后台活动」），保证按钮点了一定有反应。
     */
    fun openAutostartSettings(ctx: Context): Boolean {
        val candidates = listOf(
            ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            ComponentName("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"),
            ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
        )
        for (c in candidates) {
            val intent = Intent().setComponent(c).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { ctx.startActivity(intent) }.isSuccess) return true
        }
        return runCatching {
            ctx.startActivity(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }.isSuccess
    }
}
