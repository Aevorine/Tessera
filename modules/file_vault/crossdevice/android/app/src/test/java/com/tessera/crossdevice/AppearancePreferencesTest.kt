package com.tessera.crossdevice

import org.junit.Assert.assertEquals
import org.junit.Test

class AppearancePreferencesTest {
    @Test
    fun invalidValuesFallBackWithoutLosingValidFields() {
        val config = AppearancePreferences.normalize(
            mapOf(
                "interfaceMode" to "PROFESSIONAL",
                "themeMode" to "NEON",
                "visualStyle" to "ORIENTAL_TECH",
                "accent" to "PURPLE",
                "decoration" to 7,
                "metrics" to listOf("APP_HEAP", "APP_HEAP", "UNKNOWN"),
            )
        )

        assertEquals(InterfaceMode.PROFESSIONAL, config.interfaceMode)
        assertEquals(ThemeMode.SYSTEM, config.themeMode)
        assertEquals(VisualStyle.ORIENTAL_TECH, config.visualStyle)
        // 断言"认不出的值回落到默认值"而非"默认值是青绿色"：写死 Accent.FOREST 会在换默认色时无关地变红。
        assertEquals(AppearancePreferences.DEFAULT.accent, config.accent)
        assertEquals(Decoration.SUBTLE, config.decoration)
        assertEquals(listOf(AndroidMetric.APP_HEAP), config.metrics)
    }

    @Test
    fun emptyMetricSelectionFallsBackToUsefulDefaults() {
        val config = AppearancePreferences.normalize(mapOf("metrics" to emptyList<String>()))
        assertEquals(AppearancePreferences.DEFAULT.metrics, config.metrics)
    }
}
