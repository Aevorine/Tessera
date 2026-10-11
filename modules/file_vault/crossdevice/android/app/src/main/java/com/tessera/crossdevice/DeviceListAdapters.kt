package com.tessera.crossdevice

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.progressindicator.LinearProgressIndicator

internal data class PairedDeviceItem(
    val deviceId: String,
    val name: String,
    val state: String,
    /** phone | tablet | pc，用来挑图标。空串回落到通用设备图标。 */
    val type: String = "",
    /** 链路延迟（毫秒），-1 表示还没有；让每行都显示，与桌面端设备列表对齐。 */
    val rttMs: Long = -1,
    /** 最近一次剪贴板同步的端到端耗时（发出 → 对端写入并确认），毫秒；-1 表示还没测到。 */
    val clipLatencyMs: Long = -1,
    /** 最近若干次剪贴板同步耗时（毫秒，旧的在前），画成迷你曲线。用 List 而不是
     *  LongArray：数组的 equals 比的是引用，DiffUtil 会把每次刷新都当成内容变了。 */
    val clipLatencyHist: List<Long> = emptyList(),
    /**
     * 离线时显示的"最后在线于 X 前"文案，由 MainActivity 按 last_seen 算好传入；null 表示从没连上过。
     * 不在此存时间戳自算：DiffUtil 只在内容变化时重绑，把按分钟取整的文案放进 item，才会每分钟触发重绑
     * 。
     */
    val offlineHint: String? = null,
    /**
     * 这条连接实际走的路径（缓存地址 / 局域网发现 / 公网直连 / 中继转发）；空串表示没连上或守护进程未报
     * 。
     * 必须显示：跨网后"已连接"底下速度和隐私性质差别很大。
     */
    val via: String = "",
    /** 是否正在经由中继服务器转发。单独一个布尔而不是让界面去比字符串：
     *  这一条要在界面上给出显眼提示，判断条件不该散落在各处。 */
    val relayed: Boolean = false,
    /** 这一台设备单独的剪贴板同步范围：all / text / off（见 Go 侧 clippolicy.go）。 */
    val clipPolicy: String = "all",
    /** 这一台设备单独的收文件策略：inherit / ask / auto。 */
    val filePolicy: String = "inherit",
    /** 最近一次自动重连失败的原因码（not_found / refused / timeout ……），连上即清。 */
    val offlineCode: String = "",
)

internal object PairedDeviceDiff {
    fun sameItem(old: PairedDeviceItem, new: PairedDeviceItem): Boolean =
        old.deviceId == new.deviceId

    fun sameContent(old: PairedDeviceItem, new: PairedDeviceItem): Boolean =
        old == new
}

private object PairedDeviceItemCallback : DiffUtil.ItemCallback<PairedDeviceItem>() {
    override fun areItemsTheSame(oldItem: PairedDeviceItem, newItem: PairedDeviceItem): Boolean =
        PairedDeviceDiff.sameItem(oldItem, newItem)

    override fun areContentsTheSame(oldItem: PairedDeviceItem, newItem: PairedDeviceItem): Boolean =
        PairedDeviceDiff.sameContent(oldItem, newItem)
}

/**
 * 已配对设备列表，支持多选删除。
 * 勾选状态存在适配器而非 item：存进 item 会让 DiffUtil 整行重绑，与每几秒的心跳刷新叠加导致勾选闪烁
 * 。
 */
internal class PairedDeviceAdapter(
    private val stateLabel: (String) -> String,
    /** 选择集变化时回调，宿主据此更新"已选 N 台"和删除按钮的可用状态。 */
    private val onSelectionChanged: () -> Unit = {},
    /** 长按任意一行进入选择模式——这是安卓上最符合直觉的入口。 */
    private val onEnterSelection: () -> Unit = {},
    /** 非选择模式下点一行：打开这台设备的同步设置。 */
    private val onOpen: (PairedDeviceItem) -> Unit = {},
) : ListAdapter<PairedDeviceItem, PairedDeviceAdapter.Holder>(PairedDeviceItemCallback) {

    var selectionMode: Boolean = false
        private set

    private val selected = linkedSetOf<String>()

    /** 当前勾中的设备 ID。返回副本，调用方遍历时不怕被并发改动。 */
    fun selectedIds(): List<String> = selected.toList()

    fun selectedCount(): Int = selected.size

    fun setSelectionMode(on: Boolean) {
        if (selectionMode == on) return
        selectionMode = on
        if (!on) selected.clear()
        notifyItemRangeChanged(0, itemCount)
        onSelectionChanged()
    }

    fun toggle(deviceId: String) {
        if (!selected.remove(deviceId)) selected.add(deviceId)
        val idx = currentList.indexOfFirst { it.deviceId == deviceId }
        if (idx >= 0) notifyItemChanged(idx)
        onSelectionChanged()
    }

    fun selectAll(on: Boolean) {
        selected.clear()
        if (on) currentList.forEach { selected.add(it.deviceId) }
        notifyItemRangeChanged(0, itemCount)
        onSelectionChanged()
    }

    fun allSelected(): Boolean = currentList.isNotEmpty() && selected.size == currentList.size

    /** 删除成功后把已经不存在的 ID 清掉，免得"已选 3 台"里混着两台已经没了的。 */
    fun pruneSelection() {
        val alive = currentList.mapTo(HashSet()) { it.deviceId }
        if (selected.retainAll(alive)) onSelectionChanged()
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val check: MaterialCheckBox = view.findViewById(R.id.checkDevice)
        val icon: ImageView = view.findViewById(R.id.iconDevice)
        val name: TextView = view.findViewById(R.id.textName)
        val state: TextView = view.findViewById(R.id.textState)
        val spark: SparklineView = view.findViewById(R.id.sparkLatency)

        /** 布局原本的状态文字颜色，用于染警示色后还原。不能写死：Holder 会复用，且颜色随主题变化。 */
        val defaultStateColor: Int = state.currentTextColor
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_device, parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        holder.name.text = item.name
        // 延迟（rtt_ms）与桌面端同样缀「· 23ms」；只在有真实数值时拼，离线设备不显示旧延迟。
        holder.state.text = buildString {
            append(stateLabel(item.state))
            // 走的哪条路。排在延迟前面：先说"怎么连上的"，再说"有多快"，
            // 因为前者能解释后者——中继比直连慢是正常的，不是故障。
            if (item.via.isNotEmpty()) append(" · ").append(item.via)
            // 这台设备被设成了不同步 / 只同步文字：列表上就要看得出来，
            // 否则"怎么这台收不到剪贴板"又得点进去才知道。
            when (item.clipPolicy) {
                "off" -> append(" · ").append(holder.itemView.context.getString(R.string.policy_clip_off))
                "text" -> append(" · ").append(holder.itemView.context.getString(R.string.policy_clip_text))
            }
            when {
                item.rttMs >= 0 -> {
                    append(" · ").append(item.rttMs).append("ms")
                    if (item.clipLatencyMs >= 0) {
                        append(" · ").append(
                            holder.itemView.context.getString(R.string.clip_latency_short, item.clipLatencyMs.toInt())
                        )
                    }
                }
                // 不在线、但知道上次是什么时候连上的：老实说清楚"断了多久"，
                // 别让这一行看起来像卡住不动了。
                item.offlineHint != null -> append(" · ").append(item.offlineHint)
            }
        }
        // 经中继时标警示色：内容仍端到端加密，只是让用户一眼看出字节经过了服务器。
        holder.state.setTextColor(
            if (item.relayed) holder.itemView.context.getColor(R.color.status_warning)
            else holder.defaultStateColor
        )
        holder.spark.setValues(item.clipLatencyHist)
        holder.check.visibility = if (selectionMode) View.VISIBLE else View.GONE
        holder.check.isChecked = selected.contains(item.deviceId)
        holder.itemView.setOnClickListener {
            if (selectionMode) toggle(item.deviceId) else onOpen(item)
        }
        holder.itemView.setOnLongClickListener {
            if (!selectionMode) {
                onEnterSelection()
                toggle(item.deviceId)
            }
            true
        }
    }
}

/**
 * 附近列表里的一台设备。
 * [address] 必须带上：主动扫描发现的设备不在守护进程的 mDNS 缓存里，只给 deviceId 会被回「已不在附
 * 近」。
 */
internal data class NearbyDeviceItem(
    val deviceId: String,
    val name: String,
    val address: String = "",
    // 发现结果也会包含已配对设备，让用户看得到它在线；但不能再给一颗会发起
    // 冗余配对的按钮，否则点击后只会得到一次毫无意义的配对流程。
    val paired: Boolean = false,
)

internal object NearbyDeviceDiff {
    fun sameItem(old: NearbyDeviceItem, new: NearbyDeviceItem): Boolean =
        old.deviceId == new.deviceId

    fun sameContent(old: NearbyDeviceItem, new: NearbyDeviceItem): Boolean =
        old == new
}

private object NearbyDeviceItemCallback : DiffUtil.ItemCallback<NearbyDeviceItem>() {
    override fun areItemsTheSame(oldItem: NearbyDeviceItem, newItem: NearbyDeviceItem): Boolean =
        NearbyDeviceDiff.sameItem(oldItem, newItem)

    override fun areContentsTheSame(oldItem: NearbyDeviceItem, newItem: NearbyDeviceItem): Boolean =
        NearbyDeviceDiff.sameContent(oldItem, newItem)
}

internal class NearbyDeviceAdapter(
    private val onPair: (NearbyDeviceItem) -> Unit,
) : ListAdapter<NearbyDeviceItem, NearbyDeviceAdapter.Holder>(NearbyDeviceItemCallback) {

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val name: TextView = view.findViewById(R.id.textName)
        val unverified: TextView = view.findViewById(R.id.textUnverified)
        val address: TextView = view.findViewById(R.id.textAddress)
        val pair: View = view.findViewById(R.id.btnPair)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_nearby, parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        holder.name.text = item.name
        holder.address.text = item.address
        holder.address.visibility = if (item.address.isEmpty()) View.GONE else View.VISIBLE
        if (item.paired) {
            holder.unverified.setText(R.string.nearby_already_paired)
            holder.unverified.setTextColor(holder.itemView.context.getColor(R.color.status_success))
            holder.pair.visibility = View.GONE
            holder.pair.setOnClickListener(null)
        } else {
            holder.unverified.setText(R.string.nearby_unverified)
            holder.unverified.setTextColor(holder.itemView.context.getColor(R.color.status_warning))
            holder.pair.visibility = View.VISIBLE
            holder.pair.setOnClickListener { onPair(item) }
        }
    }
}

// 进行中的传输

/**
 * 一条进行中的传输。
 * [transferId] 是守护进程给的 transfer_id，不能用"设备+文件名"：接收端重名会改成 `报告 (1).pdf`，进
 * 度和结束事件就对不上。
 */
internal data class TransferItem(
    val transferId: String,
    val name: String,
    val itemKind: String,
    val direction: String,
    val deviceName: String,
    val done: Long,
    val total: Long,
    val percent: Int,
    val speed: Long,
    val paused: Boolean,
)

private object TransferItemCallback : DiffUtil.ItemCallback<TransferItem>() {
    override fun areItemsTheSame(oldItem: TransferItem, newItem: TransferItem): Boolean =
        oldItem.transferId == newItem.transferId

    override fun areContentsTheSame(oldItem: TransferItem, newItem: TransferItem): Boolean =
        oldItem == newItem
}

/** 进行中的传输列表；每条传输独占一行，避免多文件同时传时进度互相覆盖。 */
internal class TransferAdapter(
    private val detailText: (TransferItem) -> String,
    private val onPauseResume: (TransferItem) -> Unit,
    private val onCancel: (TransferItem) -> Unit,
) : ListAdapter<TransferItem, TransferAdapter.Holder>(TransferItemCallback) {

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val icon: ImageView = view.findViewById(R.id.iconItem)
        val name: TextView = view.findViewById(R.id.textName)
        val percent: TextView = view.findViewById(R.id.textPercent)
        val progress: LinearProgressIndicator = view.findViewById(R.id.progressTransfer)
        val detail: TextView = view.findViewById(R.id.textDetail)
        val pauseResume: MaterialButton = view.findViewById(R.id.btnPauseResume)
        val cancel: MaterialButton = view.findViewById(R.id.btnCancel)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_transfer, parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        holder.name.text = item.name
        holder.percent.text = "${item.percent}%"
        holder.progress.setProgressCompat(item.percent, true)
        holder.progress.alpha = if (item.paused) 0.45f else 1f
        // 强调色由外观设置决定，而这一行是 apply() 跑完之后才创建的，
        // 那一遍视图树遍历够不到它——在这里补上。
        AppearanceStyler.currentAccent?.let { holder.progress.setIndicatorColor(it) }
        holder.detail.text = detailText(item)
        holder.icon.setImageResource(
            when (item.itemKind) {
                "image" -> R.drawable.ic_image
                "folder" -> R.drawable.ic_folder
                "app" -> R.drawable.ic_app
                else -> R.drawable.ic_file
            }
        )
        holder.pauseResume.setIconResource(
            if (item.paused) R.drawable.ic_play else R.drawable.ic_pause
        )
        holder.pauseResume.contentDescription = holder.itemView.context.getString(
            if (item.paused) R.string.transfer_resume else R.string.transfer_pause
        )
        holder.pauseResume.setOnClickListener { onPauseResume(item) }
        holder.cancel.setOnClickListener { onCancel(item) }
    }
}
