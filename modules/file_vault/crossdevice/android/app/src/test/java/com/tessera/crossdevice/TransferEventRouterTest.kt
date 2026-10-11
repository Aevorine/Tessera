package com.tessera.crossdevice

import org.junit.Assert.assertEquals
import org.junit.Test

class TransferEventRouterTest {
    @Test
    fun receivedFileCompletionIsDeliveredInsteadOfSwallowed() {
        assertEquals(
            TransferEventAction.DELIVER_RECEIVED_FILE,
            TransferEventRouter.route("recv_done", "/data/user/0/tessera/incoming/report.pdf"),
        )
    }

    @Test
    fun terminalAndIncompleteEventsAreSeparated() {
        assertEquals(TransferEventAction.HIDE_PROGRESS, TransferEventRouter.route("done", null))
        assertEquals(TransferEventAction.HIDE_PROGRESS_WITH_ERROR, TransferEventRouter.route("error", null))
        assertEquals(TransferEventAction.IGNORE, TransferEventRouter.route("recv_done", ""))
        assertEquals(TransferEventAction.IGNORE, TransferEventRouter.route("chunk", null))
    }
}
