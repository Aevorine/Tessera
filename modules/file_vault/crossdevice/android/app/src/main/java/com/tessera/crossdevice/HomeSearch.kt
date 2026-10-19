package com.tessera.crossdevice

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.widget.TextView
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.chip.Chip
import com.tessera.crossdevice.databinding.ActivityMainBinding
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

internal class HomeSearch(
    private val activity: Activity,
    private val ui: ActivityMainBinding,
    private val devices: PairedDeviceAdapter,
    private val nearby: NearbyDeviceAdapter,
    private val transfers: TransferAdapter,
    private val onQuery: () -> Unit,
    private val onApplyClip: (JSONObject) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(1), ThreadPoolExecutor.DiscardOldestPolicy())
    private val readings by lazy {
        val out = HashMap<Char, String>()
        activity.assets.open("search-pinyin.txt").bufferedReader().use { it.readText() }.split('|').forEach { group ->
            val parts = group.split(':', limit = 2)
            if (parts.size == 2) parts[1].forEach { ch -> out.putIfAbsent(ch, parts[0]) }
        }
        out
    }
    private val engine = SmartSearch(PinyinProvider { readings[it] })
    private var pairedRows = emptyList<PairedDeviceItem>()
    private var nearbyRows = emptyList<NearbyDeviceItem>()
    private var transferRows = emptyList<TransferItem>()
    private var files: List<ReceivedFolder.Entry>? = null
    private var timeline = JSONArray()
    private var query = SmartQuery.EMPTY
    private var generation = 0
    private var closed = false
    private var deviceCommit: () -> Unit = {}
    private val refresh = Runnable { search() }


    fun submitDevices(rows: List<PairedDeviceItem>, committed: () -> Unit) {
        pairedRows = rows
        deviceCommit = committed
        schedule()
    }

    fun submitTimeline(rows: JSONArray) {
        if (timeline === rows) return
        timeline = rows
        if (!query.isEmpty) schedule()
    }

    fun submitNearby(rows: List<NearbyDeviceItem>) { nearbyRows = rows; schedule() }
    fun submitTransfers(rows: List<TransferItem>) {
        if (transferRows.any { old -> rows.none { it.transferId == old.transferId } }) files = null
        transferRows = rows
        schedule()
    }

    private fun schedule() {
        generation++
        handler.removeCallbacks(refresh)
        if (query.isEmpty) search() else handler.postDelayed(refresh, 80)
    }

    private fun search() {
        if (closed) return
        val version = generation
        val q = query
        val pairedSnapshot = pairedRows
        val nearbySnapshot = nearbyRows
        val transferSnapshot = transferRows
        val committed = deviceCommit
        val timelineSnapshot = timeline
        if (q.isEmpty) {
            devices.highlight = Highlighter.NONE
            nearby.highlight = Highlighter.NONE
            transfers.highlight = Highlighter.NONE
            devices.submitList(pairedSnapshot, committed)
            nearby.submitList(nearbySnapshot)
            transfers.submitList(transferSnapshot)
            ui.cardSearchFiles.visibility = View.GONE
            ui.textSearchNoMatch.visibility = View.GONE
            return
        }
        worker.execute {
            val pairedHits = engine.filter(pairedSnapshot, q) { d -> listOf(
                SearchField("device", d.name, 2.0), SearchField("id", d.deviceId),
                SearchField("status", d.state), SearchField("type", d.type),
                SearchField("type", activity.getString(when (d.type) {
                    "phone" -> R.string.search_type_phone; "tablet" -> R.string.search_type_tablet; else -> R.string.search_type_pc
                })),
            ) }.map { it.item }
            val nearbyHits = engine.filter(nearbySnapshot, q) { d -> listOf(
                SearchField("device", d.name, 2.0), SearchField("id", d.deviceId), SearchField("ip", d.address),
            ) }.map { it.item }
            val transferHits = engine.filter(transferSnapshot, q) { d -> listOf(
                SearchField("file", d.name, 2.0), SearchField(setOf("device", "from"), d.deviceName),
                SearchField("type", d.itemKind), SearchField("status", if (d.paused) "paused 暂停" else "running 传输中"),
            ) }.map { it.item }
            val inventory = files ?: ReceivedFolder.list(activity).also { files = it }
            val fileHits = engine.filter(inventory, q) { f -> listOf(SearchField("file", f.name, 2.0)) }.map { it.item }
            val clipHits = timelineHits(timelineSnapshot, q)
            handler.post {
                if (closed || generation != version || activity.isFinishing) return@post
                val highlighter = Highlighter(engine, q)
                devices.highlight = highlighter
                nearby.highlight = highlighter
                transfers.highlight = highlighter
                devices.submitList(pairedHits, committed)
                nearby.submitList(nearbyHits)
                transfers.submitList(transferHits)
                fileAdapter.rows = fileHits.map { ResultRow(it.name, android.text.format.Formatter.formatFileSize(activity, it.size), it, null) } +
                    clipHits.map { ResultRow(it.optString("preview"), it.optString("source_name"), null, it) }
                fileAdapter.highlight = highlighter
                fileAdapter.notifyDataSetChanged()
                ui.cardSearchFiles.visibility = if (fileAdapter.rows.isEmpty()) View.GONE else View.VISIBLE
                ui.textSearchFilesTitle.text = activity.getString(R.string.search_section_count,
                    activity.getString(R.string.search_action), fileAdapter.rows.size)
                ui.textSearchNoMatch.visibility = if (pairedHits.isEmpty() && nearbyHits.isEmpty() &&
                    transferHits.isEmpty() && fileHits.isEmpty() && clipHits.isEmpty()) View.VISIBLE else View.GONE
            }
        }
    }

    private fun timelineHits(arr: JSONArray, q: SmartQuery): List<JSONObject> {
        val rows = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        return engine.filter(rows, q) { item: JSONObject -> listOf(
            SearchField("clip", item.optString("preview"), 2.0),
            SearchField(setOf("device", "from"), item.optString("source_name")),
            SearchField("type", item.optString("preferred")),
        ) }.map { it.item }
    }

    fun filterTimeline(arr: JSONArray): JSONArray = if (query.isEmpty) arr else JSONArray(timelineHits(arr, query))

    fun close() {
        closed = true
        generation++
        handler.removeCallbacksAndMessages(null)
        worker.shutdownNow()
    }

    private val fileAdapter by lazy { object : androidx.recyclerview.widget.RecyclerView.Adapter<FileHolder>() {
        var rows = emptyList<ResultRow>()
        var highlight = Highlighter.NONE
        override fun getItemCount() = rows.size
        override fun onCreateViewHolder(parent: android.view.ViewGroup, viewType: Int) =
            FileHolder(LayoutInflater.from(parent.context).inflate(R.layout.item_search_file, parent, false))
        override fun onBindViewHolder(holder: FileHolder, position: Int) {
            val entry = rows[position]
            holder.name.text = highlight.apply(entry.title)
            holder.meta.text = entry.meta
            holder.icon.setImageResource(if (entry.file != null) R.drawable.ic_file else R.drawable.ic_clipboard)
            holder.itemView.setOnClickListener { entry.file?.let { ReceivedFolder.openEntry(activity, it) }; entry.clip?.let(onApplyClip) }
            holder.itemView.setOnLongClickListener { entry.file?.let { ReceivedFolder.shareEntry(activity, it) }; entry.clip?.let(onApplyClip); true }
        }
    } }

    init {
        ui.searchBox.endIconMode = com.google.android.material.textfield.TextInputLayout.END_ICON_CLEAR_TEXT
        ui.editSearch.doAfterTextChanged {
            query = SmartSearch.parse(it?.toString().orEmpty())
            generation++
            handler.removeCallbacks(refresh)
            handler.postDelayed(refresh, 80)
            onQuery()
        }
        listOf("device" to R.string.search_field_device, "file" to R.string.search_field_file,
            "status" to R.string.search_field_status, "ip" to R.string.search_field_ip).forEach { (key, label) ->
            ui.chipsSearch.addView(Chip(activity).apply {
                text = activity.getString(label)
                setOnClickListener {
                    val current = ui.editSearch.text?.toString().orEmpty().trimEnd()
                    ui.editSearch.setText("${if (current.isEmpty()) "" else "$current "}$key:")
                    ui.editSearch.setSelection(ui.editSearch.text?.length ?: 0)
                    ui.editSearch.requestFocus()
                }
            })
        }
        ui.editSearch.setOnFocusChangeListener { _, focused ->
            ui.chipsSearch.visibility = if (focused) View.VISIBLE else View.GONE
        }
        ui.listSearchFiles.layoutManager = androidx.recyclerview.widget.LinearLayoutManager(activity)
        ui.listSearchFiles.isNestedScrollingEnabled = false
        ui.listSearchFiles.adapter = fileAdapter
    }


    private data class ResultRow(val title: String, val meta: String, val file: ReceivedFolder.Entry?, val clip: JSONObject?)

    private class FileHolder(view: View) : androidx.recyclerview.widget.RecyclerView.ViewHolder(view) {
        val name: TextView = view.findViewById(R.id.textName)
        val meta: TextView = view.findViewById(R.id.textMeta)
        val icon: android.widget.ImageView = view.findViewById(R.id.iconSearchResult)
    }
}
