package com.tessera.crossdevice

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate

enum class InterfaceMode { DEFAULT, PROFESSIONAL }
enum class ThemeMode { SYSTEM, LIGHT, DARK }
enum class VisualStyle { NATIVE, ORIENTAL_TECH }
// 九套强调色，顺序为色相顺序（非推荐顺序），与桌面 ACCENT_FAMILIES 一致。
// 枚举名按 name 存进 SharedPreferences，发布后不能改。
enum class Accent { FOREST, SKY, INDIGO, VIOLET, ROSE, EMBER, CLAY, GOLD, OLIVE }
enum class Decoration { OFF, SUBTLE, STANDARD }
/**
 * 可选的实时指标，顺序即设置里的排列顺序：传输与连接、本机资源、设备硬件三组。
 *
 * 枚举名按 name 存进 SharedPreferences，改名会让 normalize 丢掉用户已勾选的项。
 */
enum class AndroidMetric {
    // 传输与连接
    ONLINE_DEVICES,
    LINK_RTT,
    THROUGHPUT,
    SESSION_TOTAL,
    LISTEN_PORT,
    LOCAL_ADDRESSES,
    INTERFACES,
    DISCOVERED,

    // 本机资源
    APP_HEAP,
    DEVICE_MEMORY,
    STORAGE_FREE,
    BATTERY,
    UPTIME,
    REFRESH_LATENCY,

    // 设备硬件
    BATTERY_TEMP,
    CPU_CORES,
    DISPLAY_REFRESH,
}

data class AppearanceConfig(
    val interfaceMode: InterfaceMode,
    val themeMode: ThemeMode,
    val visualStyle: VisualStyle,
    val accent: Accent,
    val decoration: Decoration,
    val metrics: List<AndroidMetric>,
)

object AppearancePreferences {
    private const val STORE = "appearance_v1"
    private const val INTERFACE_MODE = "interfaceMode"
    private const val THEME_MODE = "themeMode"
    private const val VISUAL_STYLE = "visualStyle"
    private const val ACCENT = "accent"
    private const val DECORATION = "decoration"
    private const val METRICS = "metrics"

    val DEFAULT = AppearanceConfig(
        interfaceMode = InterfaceMode.DEFAULT,
        themeMode = ThemeMode.SYSTEM,
        visualStyle = VisualStyle.NATIVE,
        // 默认从 FOREST 改成 CLAY。老用户不受影响：存过的偏好照旧读存的那份，
        // 这个默认值只对从没设置过的新安装生效。
        accent = Accent.CLAY,
        decoration = Decoration.SUBTLE,
        // 默认勾的这五项都跟「这个应用现在好不好使」直接相关。
        // 内存和存储那类本机资源留给需要的人自己勾——它们回答的是另一个问题。
        metrics = listOf(
            AndroidMetric.ONLINE_DEVICES,
            AndroidMetric.LINK_RTT,
            AndroidMetric.THROUGHPUT,
            AndroidMetric.SESSION_TOTAL,
            AndroidMetric.INTERFACES,
        ),
    )

    fun normalize(raw: Map<String, Any?>): AppearanceConfig {
        val metrics = (raw[METRICS] as? Iterable<*>)
            ?.mapNotNull { value -> enumValueOrNull<AndroidMetric>(value) }
            ?.distinct()
            .orEmpty()

        return AppearanceConfig(
            interfaceMode = enumValueOrNull<InterfaceMode>(raw[INTERFACE_MODE]) ?: DEFAULT.interfaceMode,
            themeMode = enumValueOrNull<ThemeMode>(raw[THEME_MODE]) ?: DEFAULT.themeMode,
            visualStyle = enumValueOrNull<VisualStyle>(raw[VISUAL_STYLE]) ?: DEFAULT.visualStyle,
            accent = enumValueOrNull<Accent>(raw[ACCENT]) ?: DEFAULT.accent,
            decoration = enumValueOrNull<Decoration>(raw[DECORATION]) ?: DEFAULT.decoration,
            metrics = metrics.ifEmpty { DEFAULT.metrics },
        )
    }

    fun load(context: Context): AppearanceConfig {
        val store = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        return normalize(
            mapOf(
                INTERFACE_MODE to store.getString(INTERFACE_MODE, null),
                THEME_MODE to store.getString(THEME_MODE, null),
                VISUAL_STYLE to store.getString(VISUAL_STYLE, null),
                ACCENT to store.getString(ACCENT, null),
                DECORATION to store.getString(DECORATION, null),
                METRICS to store.getStringSet(METRICS, null),
            )
        )
    }

    fun save(context: Context, config: AppearanceConfig) {
        val safe = normalize(
            mapOf(
                INTERFACE_MODE to config.interfaceMode.name,
                THEME_MODE to config.themeMode.name,
                VISUAL_STYLE to config.visualStyle.name,
                ACCENT to config.accent.name,
                DECORATION to config.decoration.name,
                METRICS to config.metrics.map { it.name },
            )
        )
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
            .edit()
            .putString(INTERFACE_MODE, safe.interfaceMode.name)
            .putString(THEME_MODE, safe.themeMode.name)
            .putString(VISUAL_STYLE, safe.visualStyle.name)
            .putString(ACCENT, safe.accent.name)
            .putString(DECORATION, safe.decoration.name)
            .putStringSet(METRICS, safe.metrics.mapTo(linkedSetOf()) { it.name })
            .apply()
    }

    fun applyTheme(themeMode: ThemeMode) {
        AppCompatDelegate.setDefaultNightMode(
            when (themeMode) {
                ThemeMode.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                ThemeMode.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                ThemeMode.DARK -> AppCompatDelegate.MODE_NIGHT_YES
            }
        )
    }

    private inline fun <reified T : Enum<T>> enumValueOrNull(value: Any?): T? {
        val name = value as? String ?: return null
        return enumValues<T>().firstOrNull { it.name == name }
    }
}
