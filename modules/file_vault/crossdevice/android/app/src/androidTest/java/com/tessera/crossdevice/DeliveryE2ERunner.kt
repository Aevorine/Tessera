package com.tessera.crossdevice

import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import mobile.Agent
import mobile.EventSink
import mobile.Mobile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** One targeted E2E: real service + native peer + SAF, with the Activity closed. */
class DeliveryE2ERunner : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun onStart() {
        val result = Bundle()
        try {
            verifyDelivery()
            result.putString("stream", "PASS: background service -> native transport -> verified SAF receipt; failed save retained, retry recovered, duplicate suppressed, temp state excluded\n")
            finish(-1, result)
        } catch (t: Throwable) {
            result.putString("stream", "FAIL: ${t.stackTraceToString()}\n")
            finish(0, result)
        }
    }

    private fun verifyDelivery() {
        val c = targetContext
        c.startForegroundService(Intent(c, SyncService::class.java))
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (SyncService.instance?.isReady != true && System.nanoTime() < until) Thread.sleep(50)
        check(SyncService.instance?.isReady == true) { "Service did not start" }

        val tree = DocumentsContract.buildTreeDocumentUri("com.tessera.crossdevice.delivery.e2e", "root")
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, "root")
        val prefs = c.getSharedPreferences("tessera-crossdevice", 0)
        val oldTree = prefs.getString("save_tree_uri", null)
        val seq = AtomicInteger(4000)
        val replies = ConcurrentHashMap<Int, CompletableFuture<JSONObject>>()
        val events = LinkedBlockingQueue<JSONObject>()
        lateinit var peer: Agent
        fun respond(line: JSONObject, send: (String) -> Unit) {
            if (line.optString("event") == "pair_request") send(JSONObject().put("id", 0).put("method", "pair_respond")
                .put("params", JSONObject().put("request_id", line.getJSONObject("data").getString("request_id"))
                    .put("accept", true).put("mode", "long")).toString())
        }
        val listener: (JSONObject) -> Unit = { line -> respond(line) { SyncService.instance!!.request(it) } }
        SyncService.listeners.add(listener)
        val peerDir = File(c.cacheDir, "delivery-e2e-peer-${System.nanoTime()}")
        peer = Agent(peerDir.absolutePath, "Delivery E2E sender", "127.0.0.1:0", EventSink { text ->
            val line = JSONObject(text)
            replies.remove(line.optInt("id", -1))?.complete(line)
            respond(line) { peer.handle(it) }
            if (line.optString("event") == "transfer") events.offer(line.getJSONObject("data"))
        })
        fun service(method: String, params: JSONObject? = null): JSONObject {
            val reply = CompletableFuture<JSONObject>()
            check(SyncService.call(method, params) { reply.complete(it) })
            val value = reply.get(30, TimeUnit.SECONDS)
            check(value.optBoolean("ok")) { value.toString() }
            return value.getJSONObject("result")
        }
        fun call(method: String, params: JSONObject): JSONObject {
            val id = seq.incrementAndGet()
            val future = CompletableFuture<JSONObject>()
            replies[id] = future
            peer.handle(JSONObject().put("id", id).put("method", method).put("params", params).toString())
            val value = future.get(30, TimeUnit.SECONDS)
            check(value.optBoolean("ok")) { value.toString() }
            return value.optJSONObject("result") ?: JSONObject()
        }
        fun ended(): JSONObject {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < deadline) {
                val e = events.poll(1, TimeUnit.SECONDS) ?: continue
                if (e.optString("kind") in listOf("done", "error")) return e
            }
            error("Missing sender result")
        }
        try {
            prefs.edit().putString("save_tree_uri", tree.toString()).commit()
            val code = service("show_pairing_code").getString("code")
            call("pair_with_code", JSONObject().put("code", code))
            val receiver = service("status").getString("device_id")
            val name = "example-${System.nanoTime()}.apk"
            val source = File(peerDir, name)
            val bytes = ByteArray(2_100_000) { (it % 251).toByte() }
            source.writeBytes(bytes)
            fun send() {
                events.clear()
                call("send_files", JSONObject().put("paths", JSONArray().put(source.absolutePath))
                    .put("device_ids", JSONArray().put(receiver)))
            }
            val denied = DocumentsContract.createDocument(c.contentResolver, root, "application/octet-stream", ".deny")!!
            send()
            check(ended().getString("kind") == "error") { "Failed SAF save reported success" }
            val staged = File(c.filesDir, "downloads/$name")
            check(staged.readBytes().contentEquals(bytes)) { "Failed save lost original" }
            DocumentsContract.deleteDocument(c.contentResolver, denied)
            send()
            val receipt = ended()
            check(receipt.getString("kind") == "done" && receipt.getBoolean("delivery_confirmed") && receipt.getBoolean("skipped"))
            val uri = Uri.parse(receipt.getString("saved_to"))
            check(c.contentResolver.openInputStream(uri)!!.use { it.readBytes().contentEquals(bytes) })
            check(!staged.exists()) { "Successful save left staging file" }
            val contentKey = Mobile.fileContentKey(source.absolutePath, 4L shl 20)
            check(FileBridge.deliverReceivedFile(c, staged, contentKey) == uri.toString()) { "Recovery/live callback did not share receipt" }
            send()
            check(ended().getBoolean("delivery_confirmed"))
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, "root")
            c.contentResolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)!!.use {
                check(it.count == 1) { "Duplicate visible files: ${it.count}" }
            }
            // 相同暂存路径被下一代内容复用后，旧回调仍必须指向旧内容。
            val changed = bytes.copyOf().also { it[0] = (it[0].toInt() xor 0x7f).toByte() }
            source.writeBytes(changed)
            send()
            val changedReceipt = ended()
            check(changedReceipt.getString("kind") == "done" && changedReceipt.getString("saved_to") != uri.toString())
            check(FileBridge.deliverReceivedFile(c, staged, contentKey) == uri.toString()) { "Receipt mixed content generations" }
            check(c.contentResolver.openInputStream(uri)!!.use { it.readBytes().contentEquals(bytes) })
            val state = File(c.filesDir, "downloads/crash.cbstate.tmp")
            state.parentFile!!.mkdirs(); state.writeText("internal bitmap")
            FileBridge.recoverPending(c)
            check(state.isFile) { "Recovery exported internal state" }
            state.delete()
        } finally {
            SyncService.listeners.remove(listener)
            peer.close()
            peerDir.deleteRecursively()
            prefs.edit().putString("save_tree_uri", oldTree).commit()
            DocumentsContract.deleteDocument(c.contentResolver, root)
        }
    }
}
