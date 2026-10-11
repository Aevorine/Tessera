package com.tessera.crossdevice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 判据必须跟桌面端 src/lib/latencyStats.ts 一致，否则两端对"网络变差了"说法不一。 */
class LatencyTrendTest {
    @Test
    fun tooFewSamplesNeverWorse() {
        assertFalse(LatencyTrend.worse(listOf(10L, 10L, 900L)))
    }

    @Test
    fun loopbackJitterIsNotAlarming() {
        // 本机回环 0~3 ms：翻倍毫无意义，要多出 50 ms 以上才算。
        assertFalse(LatencyTrend.worse(listOf(1L, 0L, 2L, 1L, 3L, 6L)))
    }

    @Test
    fun clearSlowdownIsFlagged() {
        assertTrue(LatencyTrend.worse(listOf(40L, 45L, 38L, 42L, 41L, 180L)))
    }

    @Test
    fun steadyHighLatencyIsNotASlowdown() {
        assertFalse(LatencyTrend.worse(listOf(300L, 310L, 290L, 305L, 320L)))
    }
}
