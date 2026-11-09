package com.tessera.crossdevice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.DocumentsContract
import java.io.File

/** Test-only provider owner grants a real tree URI to the instrumented app. */
class DeliveryGrantReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        File(context.filesDir, "delivery-e2e").deleteRecursively()
        val uri = DocumentsContract.buildTreeDocumentUri("com.tessera.crossdevice.delivery.e2e", "root")
        context.grantUriPermission("com.tessera.crossdevice", uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }
}
