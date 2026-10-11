package com.tessera.crossdevice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceListDiffTest {

    @Test
    fun pairedRowsKeepIdentityWhenOnlyConnectionStateChanges() {
        val before = PairedDeviceItem("device-1", "平板", "CONNECTING")
        val after = PairedDeviceItem("device-1", "平板", "CONNECTED")

        assertTrue(PairedDeviceDiff.sameItem(before, after))
        assertFalse(PairedDeviceDiff.sameContent(before, after))
    }

    @Test
    fun nearbyRowsUseDeviceIdInsteadOfEditableDisplayNameAsIdentity() {
        val renamed = NearbyDeviceItem("device-1", "我的手机")
        val original = NearbyDeviceItem("device-1", "Android")
        val impostor = NearbyDeviceItem("device-2", "Android")

        assertTrue(NearbyDeviceDiff.sameItem(original, renamed))
        assertFalse(NearbyDeviceDiff.sameItem(original, impostor))
    }
}
