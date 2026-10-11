package com.tessera.crossdevice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.snackbar.Snackbar
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.tessera.crossdevice.databinding.ActivityMainBinding
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** 首页。刻意做薄：状态真相都在 Go 侧，这里只发 JSON 请求、渲染 JSON 事件，两端共用一套状态机。 */
class MainActivity : AppCompatActivity() {

    private companion object {
        /** 能立刻收东西的状态。与桌面端 ONLINE_STATES 保持一致——
         *  两端对"在线"的定义要是不一样，同一台设备在电脑上能选、在手机上选不到。 */
        val ONLINE_STATES = setOf("CONNECTED", "DEGRADED")

        /** 重建 Activity 时记住"剪贴板时间线是否正全屏"。 */
        const val STATE_TIMELINE_FULLSCREEN = "timeline_fullscreen"

        /** 时间线窗口（卡片内）最多画几条 / 全屏时最多画几条。窗口是固定高度、在里面滑动看，
         *  所以不必像以前那样只留 20 条；上限只是为了不在一次刷新里一口气铺出上千个视图。 */
        const val TIMELINE_INLINE_ROWS = 50
        const val TIMELINE_FULLSCREEN_ROWS = 200
    }

    private lateinit var ui: ActivityMainBinding
    private val seq = AtomicInteger(0)
    private var appearanceConfig = AppearancePreferences.DEFAULT
    private var activityVisible = false
    private lateinit var pairedDeviceAdapter: PairedDeviceAdapter
    private lateinit var nearbyDeviceAdapter: NearbyDeviceAdapter
    private lateinit var transferAdapter: TransferAdapter

    /**
     * 进行中的传输，按 transfer_id 索引。用 LinkedHashMap 保序，否则进度刷新会让用户要点的「取消」挪位
     * 。
     */
    private val transfers = LinkedHashMap<String, TransferItem>()

    /** 发给一台还是发给多台。默认一台：一份东西默认只发一个地方，
     *  比默认群发安全，也符合绝大多数用法。与桌面端同一条规则。 */
    private var fanoutMany = false

    /** 剪贴板自动同步开关。真相在 Go 侧的 options 里，这里只是缓存一份给界面用。 */
    private var clipAutoSync = true
    private var clipPlainOnly = false

    /** 附近设备合并结果：mDNS 与主动扫描会重复报同一台，按 device_id 去重并用 LinkedHashMap 保序。 */
    private val nearbyCache = LinkedHashMap<String, NearbyDeviceItem>()

    /** 本机地址，给「手动输入地址」对话框念给对方用。 */
    private var myEndpoints: List<String> = emptyList()

    /** 正开着的「手动输入地址」对话框里显示本机地址的那个 TextView。
     *  地址是异步取的，拿到之后要能回填到已经弹出来的对话框上。 */
    private var manualAddressView: android.widget.TextView? = null

    /** 当前在线的已配对设备，分享目标选择器要用。 */
    private var onlineDevices: List<PairedDeviceItem> = emptyList()

    /** 从系统分享菜单进来、还在等设备列表的那份内容。 */
    private var pendingShare: SharePayload? = null
    private val shareHandler = Handler(Looper.getMainLooper())

    /**
     * 等设备列表的兜底：分享打开应用时 status 常未回来；等满 4 秒仍无在线设备就明说"没连上设备，先去配
     * 对"。
     */
    private val shareTimeout = Runnable {
        if (pendingShare != null) {
            pendingShare = null
            snack(getString(R.string.share_no_devices))
        }
    }
    private val metricsHandler = Handler(Looper.getMainLooper())
    private val refreshMetrics = object : Runnable {
        override fun run() {
            if (!activityVisible || appearanceConfig.interfaceMode != InterfaceMode.PROFESSIONAL) return
            val snapshot = RuntimeMetricsCollector.collect(this@MainActivity)
            ui.textRuntimeMetrics.text = RuntimeMetricsCollector.format(
                this@MainActivity,
                snapshot,
                appearanceConfig.metrics,
            )
            metricsHandler.postDelayed(this, 2_500)
        }
    }

    /**
     * 设备列表（含链路延迟）的后台轮询。
     *
     * Go 只在连接状态变化时推带 rtt_ms 的列表，心跳（每 10 秒）量到新延迟不触发推送，
     * 所以保持连接期间数字会停在刚连上的快照（常为空）。每秒问一次，换来接近实时的显示，代价仅一次小
     * JSON 往返。
     */
    private val statusPollHandler = Handler(Looper.getMainLooper())
    private val refreshStatusPoll = object : Runnable {
        override fun run() {
            if (!activityVisible) return
            send("status")
            statusPollHandler.postDelayed(this, 1_000)
        }
    }

    /** 核心就绪前攒下的请求。就绪后一次性补发，避免首屏那次 status 被丢掉。 */
    private val pending = mutableListOf<String>()

    /**
     * 请求 id -> 方法名。没有它只能靠有无 devices 字段猜响应归属，而 pair_with_code 返回单个设备对象，
     * 配对后界面会没反应。
     */
    private val inflight = java.util.concurrent.ConcurrentHashMap<Int, String>()

    private val onEvent: (JSONObject) -> Unit = { obj -> runOnUiThread { render(obj) } }

    // ---- 三个系统交互的返回入口 ----

    private val scanForPairing = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val code = result.data?.getStringExtra(ScanActivity.EXTRA_CODE) ?: return@registerForActivityResult
        send("pair_with_code", JSONObject().put("code", code))
        snack(getString(R.string.scan_to_pair))
    }

    private val pickFilesToSend = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        // 选完文件先问发给谁，再发。以前是直接发给**所有**在线设备，
        // 用户既没得选也不知情——把东西发错设备是收不回来的。
        if (uris.isNotEmpty()) pickTargetsThenSend(uris)
    }

    private val pickSaveFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri != null) {
            FileBridge.rememberSaveTree(this, uri)
            refreshSaveTo()
            snack(getString(R.string.save_to_changed))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        appearanceConfig = AppearancePreferences.load(this)
        AppearancePreferences.applyTheme(appearanceConfig.themeMode)
        super.onCreate(savedInstanceState)
        ui = ActivityMainBinding.inflate(layoutInflater)
        setContentView(ui.root)
        pairedDeviceAdapter = PairedDeviceAdapter(
            stateLabel = ::stateLabel,
            onSelectionChanged = ::refreshDeviceSelectionUi,
            onEnterSelection = { setDeviceSelectionMode(true) },
            onOpen = ::showDevicePolicy,
        )
        nearbyDeviceAdapter = NearbyDeviceAdapter { item ->
            // 地址一并送过去：扫描发现的设备不在守护进程的 mDNS 缓存里，
            // 只给 device_id 会被回绝成「这台设备已经不在附近了」。
            send(
                "pair_nearby",
                JSONObject()
                    .put("device_id", item.deviceId)
                    .put("address", item.address)
                    .put("mode", "long"),
            )
        }
        transferAdapter = TransferAdapter(
            detailText = ::transferDetail,
            onPauseResume = { item ->
                send(
                    if (item.paused) "resume_transfer" else "pause_transfer",
                    JSONObject().put("transfer_id", item.transferId),
                )
            },
            onCancel = { item ->
                send("cancel_transfer", JSONObject().put("transfer_id", item.transferId))
            },
        )
        ui.listDevices.layoutManager = LinearLayoutManager(this)
        ui.listDevices.adapter = pairedDeviceAdapter
        ui.listDevices.isNestedScrollingEnabled = false
        ui.listNearby.layoutManager = LinearLayoutManager(this)
        ui.listNearby.adapter = nearbyDeviceAdapter
        ui.listNearby.isNestedScrollingEnabled = false
        ui.listTransfers.layoutManager = LinearLayoutManager(this)
        ui.listTransfers.adapter = transferAdapter
        ui.listTransfers.isNestedScrollingEnabled = false
        // 进度每 250 ms 刷一次，默认的增删动画会让整行抖动。
        ui.listTransfers.itemAnimator = null

        wireDeviceSelection()
        wireFanout()
        wireClipAutoSync()
        wireImeMode()
        wireClipTimeline()
        // 旋转屏幕 / 换深浅色会重建 Activity：正在全屏看时间线就还停在全屏，别把人踢回首页。
        if (savedInstanceState?.getBoolean(STATE_TIMELINE_FULLSCREEN) == true) setTimelineFullscreen(true)

        requestNotificationPermissionIfNeeded()
        requestIgnoreBatteryOptimizationsIfNeeded()
        wireSystemPermissionsSetting()
        refreshSystemPermissionsStatus()
        gateOnAppLock()
        ContextCompat.startForegroundService(this, Intent(this, SyncService::class.java))
        SyncService.listeners.add(onEvent)

        ui.btnRefreshNearby.setOnClickListener { send("list_nearby") }
        // 扫描最长 10 秒：按钮自己变成"正在扫描…"并禁用，扫完复原，否则用户会以为按钮坏了再按而叠加扫描。
        ui.btnScanLan.setOnClickListener {
            setScanBusy(true)
            send("lan_scan")
        }
        ui.btnManualAddress.setOnClickListener { showManualAddressDialog() }
        ui.btnShortCode.setOnClickListener { showShortCodeDialog() }
        ui.btnDiagnose.setOnClickListener {
            ui.textDiagResult.visibility = android.view.View.VISIBLE
            ui.textDiagResult.text = getString(R.string.diag_running)
            send("net_diagnose")
        }

        ui.btnScan.setOnClickListener {
            scanForPairing.launch(Intent(this, ScanActivity::class.java))
        }
        ui.btnShowCode.setOnClickListener {
            send("show_pairing_code", JSONObject().put("mode", "long"))
        }
        ui.btnSendClip.setOnClickListener { sendClipboard() }
        ui.btnSendFiles.setOnClickListener {
            // 先确认有设备可发，再去开文件选择器。反过来的话，用户挑完文件
            // 才被告知"没有在线设备"，白挑一趟。
            if (onlineDevices.isEmpty()) {
                snack(getString(R.string.fanout_no_online))
            } else {
                pickFilesToSend.launch(arrayOf("*/*"))
            }
        }
        ui.btnPickSaveDir.setOnClickListener { pickSaveFolder.launch(null) }
        ui.btnAppearance.setOnClickListener { showAppearanceSettings() }
        ui.btnGuide.setOnClickListener { FirstRunGuide.show(this) }

        handleShareIntent(intent)

        wireSections()

        ui.btnRenameDevice.setOnClickListener { askRenameDevice() }
        wireCrossnetSetting()
        wireAppLockSetting()
        wireDiagnosticLog()

        // 第一次打开时弹一次操作引导。放在所有 wire* 之后：引导是盖在界面上的，
        // 底下那一屏得先装配好，否则用户点掉引导看到的是一个还没长好的界面。
        FirstRunGuide.showIfFirstRun(this)
        applyAppearance()
        setupUpdates()
        refreshSaveTo()
        renderIntegrity()
        send("status")
    }

    // ---- 可展开 / 折叠的分区 ----

    /**
     * 把五张卡接成可折叠的。
     * 「快捷操作」和「已配对设备」永远摊开（天天要用）；「进行中的传输」按有无传输自己显示。
     * 默认展开附近设备（未配对时要用），更新 / 日志 / 应用锁默认收起。
     */
    private fun wireSections() {
        fun section(key: String, header: android.view.View, body: android.view.View,
                    chevron: android.widget.ImageView, title: Int, defaultExpanded: Boolean): Section =
            Section(key, header, body, chevron, getString(title), ui.root).also {
                it.bind(this, defaultExpanded)
            }

        myCodeSection = section(
            "my_code", ui.headerMyCode, ui.bodyMyCode, ui.chevronMyCode,
            R.string.my_code_section, defaultExpanded = true,
        )
        section(
            "nearby", ui.headerNearby, ui.bodyNearby, ui.chevronNearby,
            R.string.nearby_devices, defaultExpanded = true,
        )
        section(
            "crossnet", ui.headerCrossnet, ui.bodyCrossnet, ui.chevronCrossnet,
            R.string.crossnet_section, defaultExpanded = false,
        )
        section(
            "update", ui.headerUpdate, ui.bodyUpdate, ui.chevronUpdate,
            R.string.update_section, defaultExpanded = false,
        )
        section(
            "lock", ui.headerLock, ui.groupLock, ui.chevronLock,
            R.string.lock_title, defaultExpanded = false,
        )
        section(
            "diag", ui.headerDiag, ui.bodyDiag, ui.chevronDiag,
            R.string.diag_title, defaultExpanded = false,
        )
    }

    /** 生成了配对码却折叠着等于白生成，所以 showQr 要能把它展开。 */
    private var myCodeSection: Section? = null

    // ---- 跨网络连接 ----

    /**
     * 「中转点」设置。
     * 默认关闭，必须由用户显式填地址才启用：不预置官方服务器也不推荐，因为它决定流量是否经过第三方。
     * 保存后立即生效（SetRendezvous 支持热切换），不要求重启。
     */
    /** 本次 set_options 是否在改跨网设置；回包总带跨网字段，不判断则拨剪贴板开关也会弹提示。 */
    private var lastSetOptionsTouchedCrossnet = false

    private fun wireCrossnetSetting() {
        ui.btnSaveCrossnet.setOnClickListener {
            val addr = ui.inputRendezvousAddr.text?.toString()?.trim().orEmpty()
            if (addr.isEmpty()) {
                snack(getString(R.string.crossnet_need_addr))
                return@setOnClickListener
            }
            val payload = JSONObject().put("rendezvous_addr", addr)
            // 口令框是空的时候**不提交这个键**，这样"我只想改地址"不会把已经存好的
            // 口令抹掉。想清空口令的话，走「关闭跨网络」再重新配。
            ui.inputRendezvousSecret.text?.toString()?.takeIf { it.isNotEmpty() }?.let {
                payload.put("rendezvous_secret", it)
            }
            lastSetOptionsTouchedCrossnet = true
            send("set_options", payload)
        }
        ui.btnDisableCrossnet.setOnClickListener {
            ui.inputRendezvousAddr.setText("")
            ui.inputRendezvousSecret.setText("")
            lastSetOptionsTouchedCrossnet = true
            send(
                "set_options",
                JSONObject().put("rendezvous_addr", "").put("rendezvous_secret", ""),
            )
        }
        ui.switchRelayOnMetered.setOnCheckedChangeListener { view, checked ->
            // isPressed 判断：程序回填状态时不该触发一次网络请求和提示，
            // 否则每次 status 刷新都会弹一条"已允许用手机流量中转"。
            if (!view.isPressed) return@setOnCheckedChangeListener
            send("set_options", JSONObject().put("relay_on_metered", checked))
            snack(
                getString(
                    if (checked) R.string.crossnet_metered_on else R.string.crossnet_metered_off
                )
            )
        }
    }

    /** 把 Go 侧回来的跨网设置画到界面上。以存档为准，本地输入框只是草稿。 */
    private fun renderCrossnetOptions(opts: JSONObject) {
        val addr = opts.optString("rendezvous_addr")
        // 只有当输入框没在被编辑时才回填，否则用户正打字时会被覆盖掉。
        if (!ui.inputRendezvousAddr.hasFocus()) ui.inputRendezvousAddr.setText(addr)
        ui.textCrossnetStatus.text =
            if (addr.isEmpty()) getString(R.string.crossnet_status_off)
            else getString(R.string.crossnet_status_on, addr)
        // 口令永远不回填明文（Go 侧也不发明文），只用提示文案表示"已经设过了"。
        if (opts.optBoolean("rendezvous_secret_set", false) &&
            ui.inputRendezvousSecret.text.isNullOrEmpty() && !ui.inputRendezvousSecret.hasFocus()
        ) {
            ui.inputRendezvousSecret.hint = "••••••••"
        }

        val allowOnMetered = opts.optBoolean("relay_on_metered", false)
        ui.switchRelayOnMetered.isChecked = allowOnMetered

        // 用流量时明说处境：否则"Wi-Fi 能连、流量连不上"像 bug，其实是默认策略在省流量。
        val meteredNow = opts.optBoolean("metered", false)
        ui.textMeteredNow.visibility =
            if (meteredNow && addr.isNotEmpty()) android.view.View.VISIBLE
            else android.view.View.GONE
        if (meteredNow) {
            ui.textMeteredNow.setText(
                if (allowOnMetered) R.string.crossnet_metered_now_allowed
                else R.string.crossnet_metered_now
            )
        }
    }

    // ---- 已配对设备的多选删除 ----

    /**
     * 「选择」按钮 + 全选 + 删除。
     * 此前安卓端没有删除已配对设备的入口（revoke_device 有响应却从未发送），只能去电脑上删。
     */
    private fun wireDeviceSelection() {
        ui.btnSelectDevices.setOnClickListener {
            setDeviceSelectionMode(!pairedDeviceAdapter.selectionMode)
        }
        ui.checkSelectAllDevices.setOnCheckedChangeListener { view, checked ->
            // 只响应用户点击：refreshDeviceSelectionUi 会程序化改勾选（勾满变全选），不判断会递归触发
            // selectAll，把刚取消的又勾回去。
            if (view.isPressed) pairedDeviceAdapter.selectAll(checked)
        }
        ui.btnDeleteDevices.setOnClickListener { confirmDeleteSelectedDevices() }
    }

    private fun setDeviceSelectionMode(on: Boolean) {
        pairedDeviceAdapter.setSelectionMode(on)
        ui.rowDeviceSelection.visibility = if (on) android.view.View.VISIBLE else android.view.View.GONE
        ui.btnSelectDevices.setText(if (on) R.string.devices_select_done else R.string.devices_select)
        if (!on) ui.checkSelectAllDevices.isChecked = false
        refreshDeviceSelectionUi()
    }

    private fun refreshDeviceSelectionUi() {
        val n = pairedDeviceAdapter.selectedCount()
        ui.btnDeleteDevices.isEnabled = n > 0
        ui.btnDeleteDevices.text =
            if (n > 0) getString(R.string.devices_delete) + " ($n)" else getString(R.string.devices_delete)
        // 勾满时把"全选"也点上，取消一台就自动弹回去——两个控件说的是同一件事，
        // 不同步的话用户会看到"全选"打着勾而实际只选了两台。
        val all = pairedDeviceAdapter.allSelected()
        if (ui.checkSelectAllDevices.isChecked != all) ui.checkSelectAllDevices.isChecked = all
    }

    /** 删除不可逆（需重新配对），必须确认；确认框要说清会断开并取消进行中的传输。 */
    private fun confirmDeleteSelectedDevices() {
        val ids = pairedDeviceAdapter.selectedIds()
        if (ids.isEmpty()) return
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.devices_delete_confirm_title, ids.size))
            .setMessage(R.string.devices_delete_confirm_msg)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.devices_delete) { _, _ ->
                val arr = org.json.JSONArray()
                ids.forEach(arr::put)
                // 一次请求批量删。逐条发的话中间任何一条失败都会留下一个说不清的
                // 半成品状态，而界面还得自己去对账。
                send("revoke_devices", JSONObject().put("device_ids", arr))
            }
            .show()
    }

    // ---- 一对一 / 一对多 ----

    private fun wireFanout() {
        ui.groupFanout.check(if (fanoutMany) R.id.btnFanoutMany else R.id.btnFanoutOne)
        ui.groupFanout.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            fanoutMany = checkedId == R.id.btnFanoutMany
            refreshFanoutHint()
        }
        refreshFanoutHint()
    }

    /**
     * 只在选了「发给多台」时显示提示：一对一不需解释，群发会发错地方，所以那一刻要摆出「这一份会去 N 台
     * 」。
     */
    private fun refreshFanoutHint() {
        ui.textFanoutHint.visibility =
            if (fanoutMany) android.view.View.VISIBLE else android.view.View.GONE
        if (fanoutMany) {
            ui.textFanoutHint.text = getString(R.string.fanout_hint_many, onlineDevices.size)
        }
    }

    // ---- 剪贴板自动同步 ----

    private fun wireClipAutoSync() {
        wireClipPlainOnly()
        ui.switchClipAuto.isChecked = clipAutoSync
        ui.switchClipAuto.setOnCheckedChangeListener { view, checked ->
            if (!view.isPressed) return@setOnCheckedChangeListener
            clipAutoSync = checked
            // 落盘到 Go 侧：这个开关跟桌面端是同一个 clip_sync 选项，
            // 两边各存一份状态迟早会分叉。
            send("set_options", JSONObject().put("clip_sync", checked))
            refreshClipAutoUi()
            // 说明只在拨动开关的那一刻出现：那条"安卓 10 起只有前台读得到剪贴板"的限制在此刻最该知道，常驻则成
            // 噪音。
            snack(
                if (checked) {
                    getString(R.string.clip_auto_on_desc) + " " +
                        getString(R.string.clip_auto_foreground_note)
                } else {
                    getString(R.string.clip_auto_off_desc)
                }
            )
        }
        refreshClipAutoUi()
    }

    private fun refreshClipAutoUi() {
        ui.switchClipAuto.isChecked = clipAutoSync
        ui.switchClipPlain.isChecked = clipPlainOnly
    }

    private fun wireClipPlainOnly() {
        ui.switchClipPlain.isChecked = clipPlainOnly
        ui.switchClipPlain.setOnCheckedChangeListener { view, checked ->
            if (!view.isPressed) return@setOnCheckedChangeListener
            clipPlainOnly = checked
            send("set_options", JSONObject().put("clip_plain_only", checked))
            if (checked) snack(getString(R.string.clip_plain_only_desc))
        }
    }

    /**
     * 应用回到前台时，把系统剪贴板当前内容同步出去。
     * 安卓 10 起只有前台应用（或输入法）读得到剪贴板，后台监听回调里 getPrimaryClip() 返回空，系统限制
     * 无法绕过；
     * 界面已用 clip_auto_foreground_note 明说。接收方向不受限，写剪贴板随时可以。
     */
    private fun syncClipboardOnResume() {
        if (!clipAutoSync) return
        // 先取多表示结构再算去重键：图片在剪贴板里是 content:// URI，没有纯文本，用 readPlain 做键会
        // return 导致图片从不同步。
        val payload = ClipboardBridge.readAsReps(this) ?: return
        // 只发最新一次且同内容不重复发；去重键整进程共用（ClipDedupe），输入法模式的后台监听也认它。
        if (ClipDedupe.seenOrMark(payload)) return
        send("send_clip", payload)
        snack(getString(R.string.clip_synced_out))
    }

    // ---- 输入法模式 ----

    private fun wireImeMode() {
        ui.btnImeSetup.setOnClickListener {
            if (!ImeMode.isEnabled(this)) {
                // 第一次：先去系统设置里把 Tessera 键盘打开。系统会弹一段"输入法能看到
                // 所输入内容"的标准警示；这个键盘不记录也不上传任何按键，指南里写明了。
                snack(getString(R.string.ime_enable_hint))
                runCatching { startActivity(Intent(android.provider.Settings.ACTION_INPUT_METHOD_SETTINGS)) }
            } else {
                getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.showInputMethodPicker()
            }
        }
        refreshImeStatus()
    }

    private fun refreshImeStatus() {
        val (status, action) = when {
            !ImeMode.isEnabled(this) -> R.string.ime_status_off to R.string.ime_enable
            !ImeMode.isDefault(this) -> R.string.ime_status_enabled to R.string.ime_choose
            else -> R.string.ime_status_active to R.string.ime_switch
        }
        ui.textImeStatus.setText(status)
        ui.btnImeSetup.setText(action)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 输入法选择框是系统对话框，关掉它不会触发 onResume，只会把焦点还回来。
        if (hasFocus) refreshImeStatus()
    }

    // 剪贴板时间线：卡片内的固定高度窗口与全屏覆盖层（overlayClipTimeline）共用同一批数据。

    /** 最近一次拿到的时间线。打开全屏时直接用它画，不必再等一次往返。 */
    private var lastTimeline = org.json.JSONArray()
    private var timelineFullscreen = false

    /** 返回键退出全屏。只在全屏期间启用，平时不拦截返回键。 */
    private val timelineBackCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = setTimelineFullscreen(false)
    }

    private fun wireClipTimeline() {
        ui.btnTimelineRefresh.setOnClickListener { loadTimeline(true) }
        ui.btnTimelineRefreshFull.setOnClickListener { loadTimeline(true) }
        val clearAll = android.view.View.OnClickListener {
            SyncService.call("clip_timeline_clear") { runOnUiThread { renderTimeline(org.json.JSONArray()) } }
        }
        ui.btnTimelineClear.setOnClickListener(clearAll)
        ui.btnTimelineClearFull.setOnClickListener(clearAll)
        ui.btnTimelineFullscreen.setOnClickListener { setTimelineFullscreen(true) }
        ui.btnTimelineExitFullscreen.setOnClickListener { setTimelineFullscreen(false) }
        onBackPressedDispatcher.addCallback(this, timelineBackCallback)
    }

    /** 进入 / 退出全屏；全屏时同时收起状态栏和导航栏（滑动可临时唤出），否则只是更大的卡片。 */
    private fun setTimelineFullscreen(on: Boolean) {
        if (timelineFullscreen == on) return
        timelineFullscreen = on
        timelineBackCallback.isEnabled = on
        ui.overlayClipTimeline.visibility = if (on) android.view.View.VISIBLE else android.view.View.GONE
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            bars.hide(WindowInsetsCompat.Type.systemBars())
            renderTimeline(lastTimeline)
            // 打开的这一刻顺手向核心要一份最新的，卡片里那份可能已经是几分钟前的。
            loadTimeline(false)
        } else {
            bars.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    /**
     * 键盘 Esc 退出全屏。在 dispatchKeyEvent 而非 onKeyDown 拦：焦点在按钮/滚动容器时按键先到它们，
     * onKeyDown 只在无人消费时才轮到 Activity。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (timelineFullscreen && event.keyCode == KeyEvent.KEYCODE_ESCAPE) {
            if (event.action == KeyEvent.ACTION_UP) setTimelineFullscreen(false)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_TIMELINE_FULLSCREEN, timelineFullscreen)
    }

    private fun loadTimeline(refresh: Boolean) {
        SyncService.call("clip_timeline", JSONObject().put("refresh", refresh)) { res ->
            val arr = res.optJSONObject("result")?.optJSONArray("items") ?: return@call
            runOnUiThread { renderTimeline(arr) }
        }
    }

    private fun renderTimeline(arr: org.json.JSONArray) {
        lastTimeline = arr
        val hasAny = arr.length() > 0
        ui.btnTimelineClear.isEnabled = hasAny
        ui.btnTimelineClearFull.isEnabled = hasAny
        renderTimelineInto(
            ui.listClipTimeline, ui.textTimelineEmpty, arr,
            maxRows = TIMELINE_INLINE_ROWS, previewLines = 2,
        )
        // 全屏那份只在全屏期间画：平时画了也没人看，白白多铺几百个视图。
        if (timelineFullscreen) {
            renderTimelineInto(
                ui.listClipTimelineFull, ui.textTimelineEmptyFull, arr,
                maxRows = TIMELINE_FULLSCREEN_ROWS, previewLines = 8,
            )
        }
    }

    private fun renderTimelineInto(
        box: android.widget.LinearLayout,
        empty: android.view.View,
        arr: org.json.JSONArray,
        maxRows: Int,
        previewLines: Int,
    ) {
        box.removeAllViews()
        var drawn = 0
        for (i in 0 until minOf(arr.length(), maxRows)) {
            val item = arr.optJSONObject(i) ?: continue
            val row = layoutInflater.inflate(R.layout.item_clip_timeline, box, false)
            val local = item.optBoolean("local")
            val source = if (local) getString(R.string.this_device_short) else item.optString("source_name")
            val meta = buildString {
                append(source).append(" · ").append(relativeAgo(item.optLong("at")))
                append(" · ").append(android.text.format.Formatter.formatShortFileSize(this@MainActivity, item.optLong("size")))
                if (item.optString("via") == "pull") append(" · ").append(getString(R.string.clip_timeline_pulled))
            }
            row.findViewById<android.widget.TextView>(R.id.textClipMeta).text = meta
            row.findViewById<android.widget.TextView>(R.id.textClipPreview).apply {
                maxLines = previewLines
                text = item.optString("preview").ifEmpty {
                    if (item.optString("preferred").startsWith("image/")) getString(R.string.clip_timeline_image)
                    else getString(R.string.clip_timeline_no_preview)
                }
            }
            val available = item.optBoolean("available", true)
            row.findViewById<android.view.View>(R.id.btnClipCopy).apply {
                isEnabled = available
                setOnClickListener { applyTimelineItem(item, broadcast = false) }
            }
            row.findViewById<android.view.View>(R.id.btnClipSendAll).apply {
                isEnabled = available
                setOnClickListener { applyTimelineItem(item, broadcast = true) }
            }
            row.findViewById<android.view.View>(R.id.btnClipRemove).setOnClickListener {
                val id = item.optString("item_id")
                SyncService.call("clip_timeline_remove", JSONObject().put("item_id", id))
                // 两个呈现共用 lastTimeline：从里面摘掉，再整体重画一遍，
                // 否则全屏里删了一条，退出后卡片里那条还在（反之亦然）。
                val kept = org.json.JSONArray()
                for (j in 0 until lastTimeline.length()) {
                    val it2 = lastTimeline.optJSONObject(j) ?: continue
                    if (it2.optString("item_id") != id) kept.put(it2)
                }
                renderTimeline(kept)
            }
            box.addView(row)
            drawn++
        }
        empty.visibility = if (drawn == 0) android.view.View.VISIBLE else android.view.View.GONE
    }

    private fun applyTimelineItem(item: JSONObject, broadcast: Boolean) {
        val params = JSONObject().put("item_id", item.optString("item_id")).put("broadcast", broadcast)
        val sent = SyncService.call("clip_timeline_apply", params) { res ->
            runOnUiThread {
                if (!res.optBoolean("ok", true)) {
                    val err = res.optString("error")
                    snack(
                        if (err.contains("clip_source_offline")) {
                            getString(R.string.clip_timeline_offline, item.optString("source_name"))
                        } else {
                            err.ifEmpty { getString(R.string.clip_timeline_failed) }
                        }
                    )
                    return@runOnUiThread
                }
                val result = res.optJSONObject("result") ?: return@runOnUiThread
                ClipboardBridge.write(this, result)
                ClipDedupe.markCurrent(this)
                snack(getString(if (broadcast) R.string.clip_timeline_sent else R.string.clip_timeline_copied))
            }
        }
        if (!sent) snack(getString(R.string.starting))
    }

    private fun showAppearanceSettings() {
        AppearanceSettingsDialog.show(this, appearanceConfig) { requested ->
            val previousTheme = appearanceConfig.themeMode
            AppearancePreferences.save(this, requested)
            appearanceConfig = AppearancePreferences.load(this)
            AppearancePreferences.applyTheme(appearanceConfig.themeMode)
            if (previousTheme == appearanceConfig.themeMode) {
                applyAppearance()
            }
        }
    }

    private fun applyAppearance() {
        val professional = appearanceConfig.interfaceMode == InterfaceMode.PROFESSIONAL
        ui.cardMetrics.visibility = if (professional) android.view.View.VISIBLE else android.view.View.GONE
        ui.cardDiagnostics.visibility = if (professional) android.view.View.VISIBLE else android.view.View.GONE
        AppearanceStyler.apply(this, ui, appearanceConfig)
        metricsHandler.removeCallbacks(refreshMetrics)
        if (activityVisible && professional) metricsHandler.post(refreshMetrics)
    }

    /** 给本机改名；不用重连，名字随下一次心跳（≤10 秒）捎给已配对设备，重连会打断传输。 */
    private fun askRenameDevice() {
        val input = android.widget.EditText(this).apply {
            setText(ui.textDeviceName.text)
            setSelection(text.length)
            hint = getString(R.string.rename_device_title)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.rename_device_title)
            .setMessage(R.string.rename_device_hint)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) {
                    send("set_device_name", JSONObject().put("name", name))
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * 点一台已配对设备：该设备单独的同步范围（两组单选，选中即生效，与桌面端同一 RPC），外加离线原因。
     * 过滤在 Go 侧按本机设置双向执行，对端无需升级。
     */
    private fun showDevicePolicy(item: PairedDeviceItem) {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val box = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(pad * 3 / 2, pad / 2, pad * 3 / 2, 0)
        }
        if (item.offlineCode.isNotEmpty()) {
            box.addView(android.widget.TextView(this).apply {
                text = getString(R.string.offline_reason_line, offlineReasonText(item.offlineCode))
                setTextColor(getColor(R.color.status_warning))
                setPadding(0, 0, 0, pad / 2)
            })
        }
        fun group(title: Int, values: List<Pair<String, Int>>, current: String, key: String) {
            box.addView(android.widget.TextView(this).apply {
                setText(title)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setPadding(0, pad / 2, 0, 0)
            })
            val rg = android.widget.RadioGroup(this)
            values.forEach { (value, label) ->
                rg.addView(android.widget.RadioButton(this).apply {
                    id = android.view.View.generateViewId()
                    setText(label)
                    tag = value
                    isChecked = value == current
                })
            }
            rg.setOnCheckedChangeListener { g, checkedId ->
                val value = g.findViewById<android.view.View>(checkedId)?.tag as? String ?: return@setOnCheckedChangeListener
                send("set_device_policy", JSONObject().put("device_id", item.deviceId).put(key, value))
            }
            box.addView(rg)
        }
        group(
            R.string.policy_clip_title,
            listOf("all" to R.string.policy_clip_all, "text" to R.string.policy_clip_text, "off" to R.string.policy_clip_off),
            item.clipPolicy, "clip_policy",
        )
        group(
            R.string.policy_file_title,
            listOf("inherit" to R.string.policy_file_inherit, "ask" to R.string.policy_file_ask, "auto" to R.string.policy_file_auto),
            item.filePolicy, "file_policy",
        )
        AlertDialog.Builder(this)
            .setTitle(item.name)
            .setView(android.widget.ScrollView(this).apply { addView(box) })
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun offlineReasonText(code: String): String = getString(
        when (code) {
            "not_found" -> R.string.offline_not_found
            "not_found_crossnet" -> R.string.offline_not_found_crossnet
            "metered" -> R.string.offline_metered
            "refused" -> R.string.offline_refused
            "timeout" -> R.string.offline_timeout
            "unreachable" -> R.string.offline_unreachable
            "auth" -> R.string.offline_auth
            "revoked" -> R.string.offline_revoked
            else -> R.string.offline_other
        }
    )

    /** 故障日志：开关、全选、全部删除、导出。 */
    private fun wireDiagnosticLog() {
        fun refreshLog() {
            val on = DiagnosticLog.isEnabled(this)
            ui.diagActions.visibility = if (on) android.view.View.VISIBLE else android.view.View.GONE
            val entries = if (on) DiagnosticLog.readAll(this) else emptyList()
            ui.textDiagLog.text = when {
                !on -> getString(R.string.diag_empty_off)
                entries.isEmpty() -> getString(R.string.diag_empty_on)
                else -> entries.joinToString("\n") { e ->
                    val detail = e.optString("detail")
                    buildString {
                        append(e.optString("at")).append("  [")
                        append(e.optString("module")).append("]  ")
                        append(e.optString("problem"))
                        if (detail.isNotEmpty()) append("\n    ").append(detail)
                    }
                }
            }
            // 没有条目时删除按钮该是灰的——点了也没东西可删。
            ui.btnDiagClear.isEnabled = entries.isNotEmpty() && ui.diagSelectAll.isChecked
        }

        ui.switchDiag.isChecked = DiagnosticLog.isEnabled(this)
        ui.switchDiag.setOnCheckedChangeListener { view, on ->
            DiagnosticLog.setEnabled(this, on)
            refreshLog()
            // 「只记出问题的地方，绝不记你的内容」这句以前常驻在标题下面。
            // 它是打开日志时唯一需要被打消的顾虑，说一次就够。
            if (view.isPressed && on) snack(getString(R.string.diag_hint))
        }
        ui.diagSelectAll.setOnCheckedChangeListener { _, _ -> refreshLog() }
        ui.btnDiagClear.setOnClickListener {
            val n = DiagnosticLog.clearAll(this)
            ui.diagSelectAll.isChecked = false
            refreshLog()
            snack(getString(R.string.diag_cleared, n))
        }
        ui.btnDiagShare.setOnClickListener {
            val text = DiagnosticLog.exportText(this)
            startActivity(
                Intent.createChooser(
                    Intent(Intent.ACTION_SEND)
                        .setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, text),
                    getString(R.string.diag_share),
                )
            )
        }
        refreshLog()
    }

    /**
     * 打开应用时按用户选的方式验证；这道锁与设备配对、设备间身份认证互不相干，不共用密码。
     * 验证不通过只结束 Activity，同步服务照常在后台跑，否则已配对设备的自动重连形同虚设。
     */
    private fun gateOnAppLock() {
        when (AppLock.mode(this)) {
            AppLock.Mode.NONE -> Unit
            AppLock.Mode.BIOMETRIC -> AppLock.promptBiometric(this) { ok -> if (!ok) finish() }
            AppLock.Mode.PASSWORD -> promptPassword()
        }
    }

    private fun promptPassword() {
        val input = android.widget.EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = getString(R.string.lock_enter_password)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.lock_prompt_title)
            .setView(input)
            .setPositiveButton(R.string.lock_unlock) { _, _ ->
                if (!AppLock.checkPassword(this, input.text.toString())) {
                    snack(getString(R.string.lock_wrong_password))
                    finish()
                }
            }
            .setCancelable(false)
            .show()
    }

    /** 设置区：选打开应用时的验证方式。 */
    private fun wireAppLockSetting() {
        // 没有可用的生物识别就不给这个选项——给了也点不动，只会让人以为坏了。
        ui.lockBiometric.isEnabled = AppLock.biometricAvailable(this)

        when (AppLock.mode(this)) {
            AppLock.Mode.NONE -> ui.lockNone.isChecked = true
            AppLock.Mode.PASSWORD -> ui.lockPassword.isChecked = true
            AppLock.Mode.BIOMETRIC -> ui.lockBiometric.isChecked = true
        }

        ui.groupLock.setOnCheckedChangeListener { _, id ->
            when (id) {
                R.id.lockNone -> AppLock.setNone(this)
                R.id.lockBiometric ->
                    if (AppLock.biometricAvailable(this)) AppLock.setBiometric(this)
                    else snack(getString(R.string.lock_biometric_unavailable))
                R.id.lockPassword -> askNewPassword()
            }
        }
    }

    private fun askNewPassword() {
        val input = android.widget.EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.lock_set_password)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val pw = input.text.toString()
                // 空密码等于没锁，别让用户以为设上了。
                if (pw.isBlank()) { AppLock.setNone(this); ui.lockNone.isChecked = true }
                else AppLock.setPassword(this, pw)
            }
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                // 取消就退回原来的选择，不要留下一个"选了密码但没设密码"的状态
                ui.lockNone.isChecked = true
                AppLock.setNone(this)
            }
            .show()
    }

    /** Android 13+ 通知权限需显式申请；缺它前台服务照跑，但常驻通知不显示，用户看不到同步在运行。 */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    /**
     * 小米/华为/OPPO/vivo 等厂商的省电策略会无视前台服务而冻结或杀后台进程，导致退出界面就断联；
     * 标准做法是请求电池优化白名单。系统对话框用户可拒绝，每次冷启动最多问一次。
     */
    private fun requestIgnoreBatteryOptimizationsIfNeeded() {
        val pm = getSystemService(android.os.PowerManager::class.java) ?: return
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        AlertDialog.Builder(this)
            .setTitle(R.string.battery_opt_title)
            .setMessage(R.string.battery_opt_message)
            .setPositiveButton(R.string.battery_opt_allow) { _, _ ->
                runCatching {
                    startActivity(
                        Intent(
                            android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:$packageName"),
                        )
                    )
                }
            }
            .setNegativeButton(R.string.battery_opt_later, null)
            .show()
    }

    /**
     * 系统权限与后台运行状态卡片上的两个「去设置」按钮，直接跳系统设置页：
     * 拒绝过一次后很多机型再调 requestPermissions 不会弹窗，只有设置页在所有厂商系统上都可靠。
     */
    private fun wireSystemPermissionsSetting() {
        ui.btnNotifPermFix.setOnClickListener {
            val opened = runCatching {
                startActivity(
                    Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
                )
            }.isSuccess
            if (!opened) {
                runCatching {
                    startActivity(
                        Intent(
                            android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:$packageName"),
                        )
                    )
                }.onFailure { snack(getString(R.string.battery_opt_settings_unreachable)) }
            }
        }
        ui.btnBatteryOptFix.setOnClickListener { openBatteryOptSettings() }
    }

    /**
     * 打开电池优化设置，带兜底链，点了不能没反应（荣耀 MagicOS 等已豁免时请求式意图常不弹任何东西）。
     * 三级都用标准 API，不用厂商专属 ComponentName：1) 请求豁免本 App；2) 系统电池优化总列表；3) 本
     * App 应用信息页。
     * 三级都失败才提示用户。
     */
    private fun openBatteryOptSettings() {
        val attempts = listOf(
            Intent(
                android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            ),
            Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName"),
            ),
        )
        for (intent in attempts) {
            if (runCatching { startActivity(intent) }.isSuccess) return
        }
        snack(getString(R.string.battery_opt_settings_unreachable))
    }

    /**
     * 刷新系统权限卡片的状态文字和按钮显隐；onCreate 和 onResume 都调，用户从设置页返回必触发
     * onResume，从而不显示旧状态。
     */
    private fun refreshSystemPermissionsStatus() {
        // 三层都要查，否则会"卡片说已开启而通知其实看不见"：
        // 1) Android 13+ 运行时权限 POST_NOTIFICATIONS；
        // 2) App 级总开关（从应用信息页关掉时 checkSelfPermission 仍返回 GRANTED）；
        // 3) 通知渠道是否被单独静音（长按通知选「关闭」关的是渠道）。
        val runtimeGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        val appLevelOn = androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()
        val channelOn = getSystemService(android.app.NotificationManager::class.java)
            ?.getNotificationChannel(SyncService.CHANNEL_ID)
            ?.let { it.importance != android.app.NotificationManager.IMPORTANCE_NONE }
            ?: true // 渠道还没创建（服务没启动过）时不能当成"被关了"
        val notifOn = runtimeGranted && appLevelOn && channelOn
        ui.statusNotifPerm.text = getString(
            if (notifOn) R.string.notif_perm_status_on else R.string.notif_perm_status_off
        )

        val pm = getSystemService(android.os.PowerManager::class.java)
        val batteryOk = pm?.isIgnoringBatteryOptimizations(packageName) ?: true
        ui.statusBatteryOpt.text = getString(
            if (batteryOk) R.string.battery_opt_status_on else R.string.battery_opt_status_off
        )

        // 两个按钮常驻显示：厂商系统的通知折叠、横幅、锁屏显示等开关查不出来，权限已开时按钮仍是调这些细节
        // 的入口。
    }

    // ---- 发请求 ----

    /**
     * 处理系统分享菜单进来的内容，三种都要接住，否则应用出现在分享列表却点了没反应：
     * ACTION_SEND + 文本（当剪贴板发）、ACTION_SEND + 单文件、ACTION_SEND_MULTIPLE。
     * EXTRA_STREAM 给的是 content:// URI，须经 FileBridge 复制成真实路径（Go 打不开 content://）。
     * 不直接发出去：先弹目标选择、发后给提示，一台设备都没有时明说。
     */
    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        when (intent.action) {
            Intent.ACTION_SEND -> {
                val uri = shareStream(intent, Intent.EXTRA_STREAM)
                if (uri != null) {
                    startShare(SharePayload.Files(listOf(uri)))
                    return
                }
                intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }?.let { text ->
                    startShare(SharePayload.Text(text))
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris = shareStreamList(intent)
                if (uris.isNotEmpty()) startShare(SharePayload.Files(uris))
            }
        }
    }

    /** 分享进来的内容：要么是一段文本，要么是一批文件。 */
    private sealed interface SharePayload {
        data class Text(val text: String) : SharePayload
        data class Files(val uris: List<Uri>) : SharePayload
    }

    /**
     * 开始一次分享。设备列表异步而分享打开应用时往往未到，不能直接判"没有设备"；先攒着，renderDevices
     * 拿到后再继续（flushPendingShare）。
     */
    private fun startShare(payload: SharePayload) {
        pendingShare = payload
        if (onlineDevices.isEmpty()) {
            // 还没拿到设备表就先催一次；真的一台都没有时，由 flushPendingShare 报。
            send("status")
            shareHandler.removeCallbacks(shareTimeout)
            shareHandler.postDelayed(shareTimeout, 4_000)
            snack(getString(R.string.share_preparing))
            return
        }
        flushPendingShare()
    }

    /** 设备表到了（或等超时了）之后，把攒下的分享内容走完流程。 */
    private fun flushPendingShare() {
        val payload = pendingShare ?: return
        if (onlineDevices.isEmpty()) return // 继续等，超时由 shareTimeout 兜底
        pendingShare = null
        shareHandler.removeCallbacks(shareTimeout)
        pickShareTargets(payload)
    }

    /**
     * 选发给谁。文本不问：剪贴板语义是所有配对设备共用一份。
     * 文件只有一台在线时不弹框；多于一台用多选框、默认不勾，发错设备收不回来，宁可多点一下也不默认群发
     * 。
     */
    private fun pickShareTargets(payload: SharePayload) {
        val targets = onlineDevices
        if (payload is SharePayload.Text) {
            dispatchShare(payload, emptyList(), getString(R.string.share_all_label, targets.size))
            return
        }
        if (targets.size == 1) {
            dispatchShare(payload, listOf(targets[0].deviceId), targets[0].name)
            return
        }
        val names = targets.map { it.name }.toTypedArray()
        val checked = BooleanArray(targets.size)
        AlertDialog.Builder(this)
            .setTitle(R.string.share_pick_targets)
            .setMultiChoiceItems(names, checked) { _, which, isChecked -> checked[which] = isChecked }
            .setNegativeButton(R.string.cancel, null)
            .setNeutralButton(R.string.share_to_all) { _, _ ->
                dispatchShare(payload, targets.map { it.deviceId }, getString(R.string.share_all_label, targets.size))
            }
            .setPositiveButton(R.string.share_send) { _, _ ->
                val picked = targets.filterIndexed { i, _ -> checked[i] }
                if (picked.isEmpty()) {
                    snack(getString(R.string.share_pick_at_least_one))
                    return@setPositiveButton
                }
                dispatchShare(
                    payload,
                    picked.map { it.deviceId },
                    if (picked.size == 1) picked[0].name else getString(R.string.share_all_label, picked.size),
                )
            }
            .show()
    }

    /** 真的发出去，并且**一定**给一句反馈。 */
    private fun dispatchShare(payload: SharePayload, deviceIds: List<String>, targetLabel: String) {
        when (payload) {
            is SharePayload.Text -> {
                // 剪贴板走广播，不带 device_ids——见 pickShareTargets 的说明。
                // 分享文字也是同一条广播通道，反馈不能假装只会发给刚才选的目标。
                send("send_clip", ClipboardBridge.buildTextReps(payload.text).put("force", true))
                snack(getString(R.string.clip_sent))
            }
            is SharePayload.Files -> {
                snack(getString(R.string.share_staging, payload.uris.size))
                sendFiles(payload.uris, deviceIds, targetLabel)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun shareStream(intent: Intent, key: String): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(key, Uri::class.java)
        } else {
            intent.getParcelableExtra(key)
        }

    @Suppress("DEPRECATION")
    private fun shareStreamList(intent: Intent): List<Uri> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
        } else {
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
        }

    /** 应用已在前台时又收到一次分享，走的是 onNewIntent 而不是 onCreate。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    /** 发一条请求；核心未就绪时先排队，就绪后补发，否则首屏的 status 丢失后界面会停在启动中。 */
    // 「接着刚才」中被用户关掉的条目只记内存：提示 90 秒不更新即过期，持久化只会让明天同一件事的新提示
    // 也被吞掉。
    private val continuityDismissed = mutableSetOf<String>()

    /** 拉一次别的设备在做什么。事件到达时和界面回到前台时各调一次。 */
    /** 显示这份安装包是不是官方签的。**不通过时不退出**——自己编译的版本也会
     *  走到这一档，而那是 AGPL 明确允许的正当使用。如实说明，让人自己判断。 */
    private fun renderIntegrity() {
        val result = AppIntegrity.check(this)
        val label = when (result.status) {
            AppIntegrity.Status.OFFICIAL -> getString(R.string.integrity_official)
            AppIntegrity.Status.UNOFFICIAL -> getString(R.string.integrity_unofficial)
            AppIntegrity.Status.UNKNOWN -> getString(R.string.integrity_unknown)
        }
        // 非官方时显示指纹：用户可对照官方发布页的值自行判断是自编译还是被换过，而不是要求无条件相信提示。
        ui.textIntegrity.text = if (result.status == AppIntegrity.Status.UNOFFICIAL && result.fingerprint != null) {
            label + "\n" + getString(R.string.integrity_fingerprint, result.fingerprint)
        } else {
            label
        }
    }

    private fun refreshContinuity() {
        send("list_continuity")
    }

    private fun renderContinuity(items: org.json.JSONArray?) {
        val banner = Continuity.bannerOf(items) { device, title ->
            getString(
                R.string.continuity_generic,
                device,
                title.ifEmpty { getString(R.string.continuity_untitled) },
            )
        }
        if (banner == null || continuityDismissed.contains(banner.dedupeKey)) {
            ui.rowContinuity.visibility = android.view.View.GONE
            return
        }
        val extra = if (banner.extraCount > 0) getString(R.string.continuity_more, banner.extraCount) else ""
        ui.textContinuity.text = banner.text + extra
        ui.rowContinuity.visibility = android.view.View.VISIBLE
        ui.btnContinuityDismiss.setOnClickListener {
            continuityDismissed += banner.dedupeKey
            ui.rowContinuity.visibility = android.view.View.GONE
        }
    }

    private fun send(method: String, params: JSONObject? = null) {
        val id = seq.incrementAndGet()
        inflight[id] = method
        val req = JSONObject().put("id", id).put("method", method)
        if (params != null) req.put("params", params)
        val line = req.toString()
        val svc = SyncService.instance
        if (svc == null || !svc.request(line)) {
            pending += line
            ui.textDeviceName.text = getString(R.string.starting)
        }
    }

    /** 核心就绪后把排队的请求补发出去。 */
    private fun flushPending() {
        val svc = SyncService.instance ?: return
        val queued = pending.toList()
        pending.clear()
        queued.forEach { svc.request(it) }
    }

    private fun sendClipboard() {
        // 必须发多表示结构：Go 侧读的是 reps，只给 text 的话它会当成空内容
        // 直接回绝（详见 ClipboardBridge.buildTextReps 的说明）。
        val payload = ClipboardBridge.readAsReps(this)
        if (payload == null) {
            snack(getString(R.string.clipboard_empty))
            return
        }
        // 同步进来的内容已由 SyncService 写入系统剪贴板；仅靠 Go 的 5 秒回环抑制，用户稍后切回前台会把它当
        // 新复制再广播。
        // 记录本机实际发送的 payload，使 Activity 生命周期内能跳过这份内容。
        ClipDedupe.lastKey = ClipDedupe.key(payload)
        // force：手动按的发送，接收端不做回环去重，同一内容也照发不误。
        send("send_clip", payload.put("force", true))
        snack(getString(R.string.clip_sent))
    }

    /**
     * 发文件：先把 content:// 复制成真实路径再交协议核心（理由见 FileBridge），复制放后台线程，避免大视
     * 频冻住界面。
     * deviceIds 为空表示发给当前所有在线设备；从分享菜单进来时一定带明确目标。
     */
    private fun sendFiles(
        uris: List<Uri>,
        deviceIds: List<String> = emptyList(),
        targetLabel: String? = null,
    ) {
        Thread {
            val paths = FileBridge.stageForSending(this, uris)
            runOnUiThread {
                if (paths.isEmpty()) {
                    // 这里失败的是"把 content:// 复制成真实文件"，跟有没有在线设备
                    // 毫无关系。以前报的是"没有在线设备"，把人往完全错误的方向指。
                    snack(getString(R.string.share_stage_failed))
                    return@runOnUiThread
                }
                val arr = org.json.JSONArray()
                paths.forEach(arr::put)
                val params = JSONObject().put("paths", arr)
                if (deviceIds.isNotEmpty()) {
                    val ids = org.json.JSONArray()
                    deviceIds.forEach(ids::put)
                    params.put("device_ids", ids)
                }
                send("send_files", params)
                snack(
                    if (targetLabel != null) getString(R.string.share_files_sent, paths.size, targetLabel)
                    else getString(R.string.files_queued, paths.size),
                )
            }
        }.start()
    }

    /**
     * 应用内「发送文件」的目标选择，规则跟顶上「发给一台 / 发给多台」开关走，与桌面端一致：
     * 一台为单选，只有一台在线时不问；多台为多选，默认不勾（发错设备收不回来）。
     */
    private fun pickTargetsThenSend(uris: List<Uri>) {
        val targets = onlineDevices
        if (targets.isEmpty()) {
            snack(getString(R.string.fanout_no_online))
            return
        }
        if (targets.size == 1) {
            sendFiles(uris, listOf(targets[0].deviceId), targets[0].name)
            return
        }
        val names = targets.map { it.name }.toTypedArray()
        if (!fanoutMany) {
            AlertDialog.Builder(this)
                .setTitle(R.string.fanout_pick_one)
                .setItems(names) { _, which ->
                    sendFiles(uris, listOf(targets[which].deviceId), targets[which].name)
                }
                .setNegativeButton(R.string.cancel, null)
                .show()
            return
        }
        val checked = BooleanArray(targets.size)
        AlertDialog.Builder(this)
            .setTitle(R.string.fanout_pick_many)
            .setMultiChoiceItems(names, checked) { _, which, isChecked -> checked[which] = isChecked }
            .setNegativeButton(R.string.cancel, null)
            .setNeutralButton(R.string.share_to_all) { _, _ ->
                sendFiles(
                    uris,
                    targets.map { it.deviceId },
                    getString(R.string.share_all_label, targets.size),
                )
            }
            .setPositiveButton(R.string.share_send) { _, _ ->
                val picked = targets.filterIndexed { i, _ -> checked[i] }
                if (picked.isEmpty()) {
                    snack(getString(R.string.fanout_pick_at_least_one))
                    return@setPositiveButton
                }
                sendFiles(
                    uris,
                    picked.map { it.deviceId },
                    if (picked.size == 1) picked[0].name
                    else getString(R.string.share_all_label, picked.size),
                )
            }
            .show()
    }

    /**
     * 扫描进行中的界面状态；带 15 秒兜底（Go 侧上限 10 秒），响应万一丢失时按钮也不能永远卡在禁用。
     */
    private fun setScanBusy(busy: Boolean) {
        ui.btnScanLan.isEnabled = !busy
        ui.btnScanLan.setText(if (busy) R.string.scanning else R.string.scan_lan)
        scanHandler.removeCallbacks(scanTimeout)
        if (busy) scanHandler.postDelayed(scanTimeout, 15_000)
    }

    private val scanHandler = Handler(Looper.getMainLooper())
    private val scanTimeout = Runnable {
        if (!ui.btnScanLan.isEnabled) {
            setScanBusy(false)
            snack(getString(R.string.scan_done, nearbyCache.size))
        }
    }

    private fun refreshSaveTo() {
        ui.textSaveTo.text = FileBridge.saveTreeLabel(this) ?: getString(R.string.save_to_default)
    }

    // ---- 渲染事件 ----

    private fun render(obj: JSONObject) {
        when (obj.optString("event")) {
            "ready" -> {
                val d = obj.optJSONObject("data") ?: return
                ui.textDeviceName.text = d.optString("name")
                ui.textFingerprint.text = d.optString("fingerprint")
                flushPending()
                send("status")
                send("list_nearby")
                // 刚连上就拉一次：事件是推送的，连接建立之前发生的那次错过就没了。
                refreshContinuity()
                loadTimeline(true)
                return
            }
            "service_ready" -> {
                flushPending()
                send("status")
                send("list_nearby")
                // 刚连上就拉一次：事件是推送的，连接建立之前发生的那次错过就没了。
                refreshContinuity()
                return
            }
            // 换 Wi-Fi / 开热点后网卡全变，界面要重新发现，否则列表留着旧网络的设备，点配对必然失败且原因莫名。
            "network_changed" -> {
                nearbyCache.clear()
                nearbyDeviceAdapter.submitList(emptyList())
                snack(getString(R.string.network_changed_rescan))
                send("list_nearby")
                return
            }
            // 配对完成或设备状态变化都刷新列表：带 devices 直接用，没带就回头拉。
            // continuity 事件只带 device_id，完整列表回头拉，免得多设备活跃时每次序列化多遍。
            "continuity" -> {
                refreshContinuity()
                return
            }
            // 传输进度。每 250 ms 一条（节流在 Go 侧做），直接刷界面即可。
            "progress" -> {
                val d = obj.optJSONObject("data") ?: return
                val id = d.optString("transfer_id").ifEmpty {
                    "${d.optString("device_id")}|${d.optString("name")}"
                }
                // 暂停期间不会有新的进度上报，所以状态沿用已知值而不是重置成
                // running——否则用户暂停后最后那一条在途的进度会把按钮又变回「暂停」。
                val wasPaused = transfers[id]?.paused ?: false
                transfers[id] = TransferItem(
                    transferId = id,
                    name = d.optString("name"),
                    itemKind = d.optString("item_kind", "file"),
                    direction = d.optString("direction", "send"),
                    deviceName = d.optString("device_name"),
                    done = d.optLong("done"),
                    total = d.optLong("total"),
                    percent = d.optInt("percent"),
                    speed = d.optLong("speed"),
                    paused = wasPaused,
                )
                LinkStats.onProgress(
                    id,
                    d.optString("direction", "send"),
                    d.optLong("done"),
                    d.optLong("speed"),
                )
                // 播报这条传输，让另一台设备知道手机还在传（Go 侧按内容去重，每条进度都调无额外网络开销）。
                // 剪贴板内部正文推送（item_kind == "clip"）不播报：那不是"没做完的事"，否则电脑顶部会一直挂着「剪贴
                // 板图片 100%」。
                // 核心也有同样判断（node.transferClaimLive），这里不发是省一次往返。
                if (d.optString("item_kind") != "clip") {
                    send("set_continuity", Continuity.publishParams(
                        d.optString("name"), id, d.optInt("percent")))
                }
                renderTransfers()
                return
            }
            // 暂停 / 继续 / 取消。**对端按的也会走到这里**——本机界面上那条进度
            // 必须跟着变成「已暂停」，否则用户看到的是一条不动的进度条，和卡死一样。
            "xfer_state" -> {
                val d = obj.optJSONObject("data") ?: return
                val id = d.optString("transfer_id")
                if (id.isEmpty()) return
                when (d.optString("state")) {
                    "canceled" -> {
                        transfers.remove(id)
                        LinkStats.onTransferEnded(id)
                        snack(getString(R.string.transfer_canceled, d.optString("name")))
                    }
                    // ended = 该传输已离开守护进程注册表（传完 / 失败 / 掉线），是最后的兜底：
                    // error 事件带不出 transfer_id，没有它进度行永远删不掉。静默移除，失败原因由 error 事件负责。
                    "ended" -> {
                        transfers.remove(id)
                        LinkStats.onTransferEnded(id)
                    }
                    "paused" -> transfers[id]?.let { transfers[id] = it.copy(paused = true) }
                    else -> transfers[id]?.let { transfers[id] = it.copy(paused = false) }
                }
                renderTransfers()
                return
            }
            // 传输结束就收起进度卡，否则停在最后百分比像卡住。
            // 收尾和落盘必须在同一个 "transfer" 分支：Kotlin 只认第一个同名分支，第二个（onTransfer 搬进用户目
            // 录）曾成死代码，
            // 表现为提示收到了、文件管理器里却找不到。
            "transfer" -> {
                val data = obj.optJSONObject("data") ?: return
                // 按 transfer_id 摘掉结束的那条：用"设备+文件名"会因接收端重名改成 `报告 (1).pdf` 而对不上，进度挂
                // 着删不掉。
                val ending = TransferEventRouter.route(data.optString("kind"), data.optString("path"))
                if (ending != TransferEventAction.IGNORE) {
                    val id = data.optString("transfer_id")
                    if (id.isNotEmpty()) transfers.remove(id)
                    else transfers.keys.removeAll { it.endsWith("|" + data.optString("name")) }
                    renderTransfers()
                }
                when (ending) {
                    TransferEventAction.HIDE_PROGRESS -> Unit
                    TransferEventAction.HIDE_PROGRESS_WITH_ERROR -> snack(data.optString("error"))
                    TransferEventAction.DELIVER_RECEIVED_FILE -> onTransfer(data)
                    TransferEventAction.IGNORE -> Unit
                }
                return
            }
            // 对端确认收到了本机发出的剪贴板：刷新设备列表，把这次测得的耗时显示出来。
            "clip_ack" -> {
                send("status")
                return
            }
            // 时间线变了（本机复制、收到对端内容、连上时取回对方断线期间复制的）。
            "clip_timeline" -> {
                loadTimeline(false)
                return
            }
            "clip" -> {
                // SyncService 已把对端内容写进系统剪贴板；用实际写入后的平台 payload 登记去重键：
                // 事件数组可能含未拉取的非首选表示，直接算键会与真实内容不同，随后仍会反向广播。
                ClipDedupe.markCurrent(this)
                return
            }
            "paired", "state" -> {
                val devices = obj.optJSONObject("data")?.optJSONArray("devices")
                if (devices != null) renderDevices(devices) else send("status")
                return
            }
            // 守护进程推来的异步错误（配对失败、会话读写出错、被对端拒绝）：此前没接，用户按了配对毫无提示。
            // 同步请求失败走另一条路（按 id 找回请求处的 ok:false 分支），两者不重叠。
            "notice" -> {
                val msg = obj.optJSONObject("data")?.optString("message").orEmpty()
                if (msg.isNotEmpty()) snack(msg)
                return
            }
            // 启动失败必须说出来。以前异常被吞掉，用户面对的是一个永远转圈的界面，
            // 完全无从判断是网络问题、权限问题还是别的什么。
            "service_failed" -> {
                val err = obj.optJSONObject("data")?.optString("error").orEmpty()
                ui.textDeviceName.text = getString(R.string.service_failed)
                ui.textFingerprint.text = err
                snack(getString(R.string.service_failed))
                return
            }
            // 配对安全码确认：**这一步不能省，也不能自动点掉**。设备名可以随便伪造，
            // 两端比对同一组安全码才是挡住中间人的唯一手段。
            "pair_request" -> {
                showSasDialog(obj.optJSONObject("data") ?: return)
                return
            }
        }

        // 到这里就是一条响应（不是事件）。按 id 找回它是哪个请求的。
        val id = obj.optInt("id", -1)
        val method = inflight.remove(id)

        if (!obj.optBoolean("ok", true)) {
            // 扫描失败也要把按钮放回去。不放的话「扫描局域网」会永久卡在
            // "正在扫描…"的禁用状态上——一次失败就再也点不动了。
            if (method == "lan_scan") setScanBusy(false)
            val err = obj.optString("error")
            if (err.isNotEmpty()) snack(err)
            return
        }

        val result = obj.optJSONObject("result")

        when (method) {
            // 配对成功后必须重拉设备列表：pair_with_code 响应只有单个设备对象、没有 devices，不补 status 手机上
            // 就看不到新设备。
            "pair_with_code" -> {
                val name = result?.optString("name").orEmpty()
                snack(if (name.isEmpty()) getString(R.string.scan_to_pair) else name)
                send("status")
                return
            }
            // 「接着刚才」的完整列表；set_continuity 的响应不用管，播报失败的正确表现是对端提示自然过期，不是弹
            // 无法修复的错误。
            "list_continuity" -> {
                renderContinuity(result?.optJSONArray("items"))
                return
            }
            "set_continuity" -> return
            "set_device_name" -> {
                val name = result?.optString("name").orEmpty()
                if (name.isNotEmpty()) {
                    ui.textDeviceName.text = name
                    snack(getString(R.string.rename_device_done, name))
                }
                return
            }
            "revoke_device" -> {
                send("status")
                return
            }
            // 回来的是改好的那一台；整表重拉一次最省事，也顺带刷新别的设备状态。
            "set_device_policy" -> {
                send("status")
                return
            }
            "revoke_devices" -> {
                val n = result?.optInt("revoked") ?: 0
                val failed = result?.optJSONObject("failed")?.length() ?: 0
                snack(
                    if (failed > 0) getString(R.string.devices_delete_partial, n, failed)
                    else getString(R.string.devices_deleted, n)
                )
                setDeviceSelectionMode(false)
                result?.optJSONArray("devices")?.let { renderDevices(it) } ?: send("status")
                return
            }
            "set_options" -> {
                // 以 Go 侧回来的为准：本地那个 switch 只是个乐观显示，
                // 真相在存档里。两边不对齐的话，界面写着"已开启"而实际没开。
                result?.let {
                    if (it.has("clip_sync")) {
                        clipAutoSync = it.optBoolean("clip_sync", clipAutoSync)
                        clipPlainOnly = it.optBoolean("clip_plain_only", clipPlainOnly)
                        refreshClipAutoUi()
                    }
                    if (it.has("rendezvous_addr")) {
                        val addr = it.optString("rendezvous_addr")
                        renderCrossnetOptions(it)
                        // 只在这次请求确实是在改跨网设置时才提示，否则每次动
                        // 别的开关都会弹一条无关的"已启用跨网络"。
                        if (lastSetOptionsTouchedCrossnet) {
                            lastSetOptionsTouchedCrossnet = false
                            snack(
                                if (addr.isEmpty()) getString(R.string.crossnet_disabled)
                                else getString(R.string.crossnet_saved, addr)
                            )
                        }
                    }
                }
                send("status")
                return
            }
            // 补齐进行中的传输：事件是推送的，错过就没了，而 Activity 每次重建（转屏、被回收）都是白纸，
            // 不补则进度和暂停/取消按钮会消失。
            "active_transfers" -> {
                transfers.clear()
                val arr = result?.optJSONArray("transfers") ?: org.json.JSONArray()
                for (i in 0 until arr.length()) {
                    val x = arr.optJSONObject(i) ?: continue
                    val id = x.optString("transfer_id")
                    if (id.isEmpty()) continue
                    transfers[id] = TransferItem(
                        transferId = id,
                        name = x.optString("name"),
                        itemKind = x.optString("item_kind", "file"),
                        direction = x.optString("direction", "send"),
                        deviceName = x.optString("device_name"),
                        done = 0,
                        total = x.optLong("total"),
                        percent = 0,
                        speed = 0,
                        paused = x.optString("state") == "paused",
                    )
                }
                renderTransfers()
                return
            }
            "show_short_code" -> {
                val code = obj.optJSONObject("result")?.optString("code").orEmpty()
                if (code.isNotEmpty()) {
                    shortCodeView?.text = code
                    val expiresAt = obj.optJSONObject("result")?.optLong("expires_at") ?: 0L
                    val leftSec = ((expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                    shortCodeExpiryView?.text = getString(R.string.short_code_expires_in, leftSec / 60, leftSec % 60)
                }
            }

            "pair_with_short_code" -> {
                // 跟 pair_with_code 一样：成功时返回的是**单个**设备对象、没有
                // devices 数组，所以要再问一次 status 才能把它显示到列表里。
                val name = result?.optString("name").orEmpty()
                if (name.isNotEmpty()) snack(name)
                send("status")
                send("list_nearby")
                return
            }

            "pair_nearby", "pair_with_address" -> {
                val name = result?.optString("name").orEmpty()
                if (name.isNotEmpty()) snack(name)
                send("status")
                send("list_nearby")
                return
            }
            "list_nearby" -> {
                // 被动列表整份替换：它就是"当前还在广播的设备"这个事实本身，
                // 合并的话已经关机的设备会永远留在列表上。
                nearbyCache.clear()
                val arr = result?.optJSONArray("nearby") ?: org.json.JSONArray()
                mergeNearby(arr)
                // 空了就自动接着扫：被动列表走 mDNS 组播，Wi-Fi 芯片没拿 MulticastLock 时会在硬件层丢组播帧，
                // 此类手机被动列表永远为空；主动扫描可绕开组播。
                if (arr.length() == 0) send("lan_scan")
                return
            }
            "lan_scan" -> {
                setScanBusy(false)
                val arr = result?.optJSONArray("nearby") ?: org.json.JSONArray()
                mergeNearby(arr)
                snack(getString(R.string.scan_done, arr.length()))
                return
            }
            "local_endpoints" -> {
                myEndpoints = result?.optJSONArray("endpoints")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotEmpty) }
                } ?: emptyList()
                LinkStats.localAddressCount = myEndpoints.size
                LinkStats.primaryAddress = myEndpoints.firstOrNull().orEmpty()
                refreshManualAddressView()
                return
            }
            "net_diagnose" -> {
                renderDiagnosis(result?.optJSONArray("checks") ?: org.json.JSONArray())
                return
            }
        }

        if (result == null) return
        result.optInt("port", 0).takeIf { it > 0 }?.let { LinkStats.listenPort = it }
        result.optString("code").takeIf { it.isNotEmpty() }?.let { showQr(it, result.optLong("expires_at")) }
        result.optJSONArray("devices")?.let { renderDevices(it) }
        // status 里带着 options：剪贴板自动同步的开关以它为准，
        // 而不是每次启动都默认打开——那等于悄悄忽略用户上次的选择。
        result.optJSONObject("options")?.let { opts ->
            if (opts.has("clip_sync")) {
                clipAutoSync = opts.optBoolean("clip_sync", true)
                clipPlainOnly = opts.optBoolean("clip_plain_only", false)
                refreshClipAutoUi()
            }
            // 跨网设置同理：以存档为准，不能每次启动都显示成"未开启"。
            if (opts.has("rendezvous_addr")) renderCrossnetOptions(opts)
        }
    }

    private fun renderDevices(arr: org.json.JSONArray) {
        ui.textNoDevices.visibility = if (arr.length() == 0) android.view.View.VISIBLE else android.view.View.GONE
        val items = ArrayList<PairedDeviceItem>(arr.length())
        val onlineNow = ArrayList<PairedDeviceItem>(arr.length())
        // Go 侧 peerJSON 一直在回 rtt_ms，安卓这边以前直接扔了。取在线设备里
        // 最好的那条作为「链路延迟」指标——一台设备卡不代表整体链路差。
        var bestRtt = -1L
        for (i in 0 until arr.length()) {
            val dev = arr.optJSONObject(i) ?: continue
            val name = dev.optString("name")
            val id = dev.optString("device_id").ifEmpty { "$name#$i" }
            val state = dev.optString("state")
            // 离线设备不带这次的延迟数字——那是它上一次在线时的旧值，
            // 当作"现在"的连接质量看就是在撒谎。
            val rtt = dev.optLong("rtt_ms", -1).takeIf { state in ONLINE_STATES } ?: -1
            // 离线时显示"最后在线于 X 前"而非留空（空白像卡住，多半是省电策略冻结了后台进程）；last_seen 是 Go
            // 侧每次连上更新的真实时间戳。
            val offlineHint = if (rtt < 0) {
                dev.optLong("last_seen", 0).takeIf { it > 0 }?.let { relativeAgo(it) }
            } else null
            val item = PairedDeviceItem(
                id, name, state, dev.optString("type"), rtt,
                clipLatencyMs = dev.optLong("clip_latency_ms", -1).takeIf { state in ONLINE_STATES } ?: -1,
                // 延迟曲线断线后也留着：「刚才为什么越来越慢然后断了」正要靠它回答。
                clipLatencyHist = dev.optJSONArray("clip_latency_hist")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optLong("ms", -1)?.takeIf { v -> v >= 0 } }
                } ?: emptyList(),
                offlineHint = offlineHint,
                // 走的哪条路。跨网之后"已连接"底下可能是同网直连、跨网打洞直连、
                // 或者经服务器转发三种完全不同的情况，都写"已连接"等于把信息藏起来。
                via = dev.optString("via"),
                relayed = dev.optBoolean("relayed", false),
                clipPolicy = dev.optString("clip_policy").ifEmpty { "all" },
                filePolicy = dev.optString("file_policy").ifEmpty { "inherit" },
                offlineCode = if (state in ONLINE_STATES) "" else
                    dev.optJSONObject("offline_reason")?.optString("code").orEmpty(),
            )
            items += item
            if (state in ONLINE_STATES) {
                onlineNow += item
                if (rtt >= 0 && (bestRtt < 0 || rtt < bestRtt)) bestRtt = rtt
            }
        }
        pairedDeviceAdapter.submitList(items) {
            // 列表真正换完之后再对账：submitList 是异步的，紧接着调 pruneSelection
            // 拿到的还是旧列表，刚删掉的设备会留在"已选 3 台"里。
            pairedDeviceAdapter.pruneSelection()
            refreshDeviceSelectionUi()
            // 一台设备都没有了就退出选择模式——留着一个空列表加一条工具条很怪。
            if (items.isEmpty() && pairedDeviceAdapter.selectionMode) setDeviceSelectionMode(false)
        }

        // 记下当前在线设备，发送目标选择器要用。
        onlineDevices = onlineNow
        // 指标要用的三个数顺手记下来：没有额外的请求，也没有额外的线程。
        LinkStats.onlineDevices = onlineNow.size
        LinkStats.pairedDevices = items.size
        LinkStats.bestRttMs = bestRtt
        refreshFanoutHint()
        // 分享进来时设备表可能还没到，那份待发内容就攒在这里等这一刻。
        flushPendingShare()
    }

    /** 把进行中的传输画出来。空了就把整张卡收起来，不占位置。 */
    private fun renderTransfers() {
        val list = transfers.values.toList()
        ui.cardProgress.visibility =
            if (list.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE
        transferAdapter.submitList(list)
    }

    /** 进度那一行的详情文案：已传/总量 · 速度 · 剩余 · 对方设备。 */
    private fun transferDetail(item: TransferItem): String {
        val peer = if (item.direction == "send") {
            getString(R.string.transfer_dir_send, item.deviceName)
        } else {
            getString(R.string.transfer_dir_recv, item.deviceName)
        }
        if (item.paused) {
            return getString(
                R.string.transfer_detail_paused,
                humanSize(item.done), humanSize(item.total), peer,
            )
        }
        // 速度是 0 说明刚开始（还没有两次上报可以求差），这时候不猜剩余时间——
        // 显示一个"剩余 0 秒"比什么都不显示更糟。
        if (item.speed <= 0 || item.total <= 0) {
            return getString(
                R.string.transfer_detail_starting,
                humanSize(item.done), humanSize(item.total), peer,
            )
        }
        val left = ((item.total - item.done) / item.speed).coerceAtLeast(0)
        return getString(
            R.string.transfer_detail_running,
            humanSize(item.done), humanSize(item.total),
            humanSize(item.speed), humanDuration(left), peer,
        )
    }

    private fun humanDuration(sec: Long): String = when {
        sec < 60 -> "${sec}s"
        sec < 3600 -> "${sec / 60}m ${sec % 60}s"
        else -> "${sec / 3600}h ${(sec % 3600) / 60}m"
    }

    // ---- 应用更新 ----

    /**
     * 「自动」只自动到检查这一步：安卓不允许旁加载应用静默安装，最后的「安装」永远是系统弹框。
     * 自动模式打开应用时查一次，手动只在按按钮时查；界面说明也如此写。
     */
    private fun setupUpdates() {
        ui.textUpdateStatus.text = getString(R.string.update_current, Updater.currentVersion(this))
        ui.switchAutoUpdate.isChecked = Updater.isAutoCheck(this)
        ui.switchAutoUpdate.setOnCheckedChangeListener { view, checked ->
            Updater.setAutoCheck(this, checked)
            // 「自动只自动到检查这一步、最后一定由系统弹框」这句解释挪到这里：
            // 它是拨开关那一刻才需要知道的事，不是每次滚过这张卡都要重读一遍的事。
            if (view.isPressed) snack(getString(R.string.update_auto_hint))
        }
        ui.switchUpdateMirror.isChecked = Updater.source(this) == Updater.SOURCE_MIRROR
        ui.switchUpdateMirror.setOnCheckedChangeListener { view, checked ->
            Updater.setSource(this, if (checked) Updater.SOURCE_MIRROR else Updater.SOURCE_MAIN)
            if (view.isPressed) snack(getString(R.string.update_mirror_hint))
        }
        ui.btnCheckUpdate.setOnClickListener { checkForUpdate(userInitiated = true) }
        if (Updater.isAutoCheck(this)) checkForUpdate(userInitiated = false)
    }

    /**
     * 查一次 GitHub。自动检查失败只记故障日志、不提示；按按钮查失败必须给回话。
     * 仓库是私有的，匿名检查每次都失败且用户无能为力，每次开应用都红字只会让人学会无视。
     */
    private fun checkForUpdate(userInitiated: Boolean) {
        if (userInitiated) {
            ui.btnCheckUpdate.isEnabled = false
            ui.textUpdateStatus.text = getString(R.string.update_checking)
        }
        Thread {
            val outcome = runCatching { Updater.check(this) }
            outcome.onFailure { e ->
                // 在后台线程记，别把文件 I/O 甩到主线程去做。
                DiagnosticLog.record(this, "update", "检查更新失败", "${errorCode(e)}: ${e.message}")
            }
            runOnUiThread {
                ui.btnCheckUpdate.isEnabled = true
                outcome.onSuccess { r ->
                    if (r.available) {
                        ui.textUpdateStatus.text = getString(R.string.update_found_title, r.version)
                        promptUpdate(r)
                    } else {
                        ui.textUpdateStatus.text = getString(R.string.update_none, r.currentVersion)
                    }
                }.onFailure { e ->
                    if (userInitiated) ui.textUpdateStatus.text = updateErrorText(e)
                }
            }
        }.start()
    }

    /** 有新版才问，问完不点「更新」就什么都不做——不下载、不留文件。 */
    private fun promptUpdate(r: Updater.Result) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.update_found_title, r.version))
            .setMessage(
                getString(
                    R.string.update_found_msg,
                    r.currentVersion,
                    r.version,
                    humanSize(r.sizeBytes),
                )
            )
            .setPositiveButton(R.string.update_now) { _, _ -> startUpdate(r) }
            .setNegativeButton(R.string.update_later, null)
            .show()
    }

    /** 下载后交给系统安装。「允许安装未知应用」权限在下载前查，免得用户等完四十几兆才被告知装不上。 */
    private fun startUpdate(r: Updater.Result) {
        if (!Updater.canRequestInstall(this)) {
            AlertDialog.Builder(this)
                .setTitle(R.string.update_install_perm_title)
                .setMessage(R.string.update_install_perm_msg)
                .setPositiveButton(R.string.update_go_settings) { _, _ ->
                    Updater.openInstallPermissionSettings(this)
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
            return
        }
        ui.btnCheckUpdate.isEnabled = false
        Thread {
            var lastPct = -1
            val outcome = runCatching {
                Updater.downloadApk(this, r.url, r.sizeBytes) { done, total, bytesPerSecond ->
                    // 每涨 1% 才回一次主线程，免得进度文字把自己卡住。
                    val pct = if (total > 0) (done * 100 / total).toInt() else 0
                    if (pct != lastPct) {
                        lastPct = pct
                        runOnUiThread {
                            ui.textUpdateStatus.text =
                                getString(R.string.update_downloading, pct, humanSize(bytesPerSecond))
                        }
                    }
                }
            }
            outcome.onFailure { e ->
                DiagnosticLog.record(this, "update", "下载更新失败", "${errorCode(e)}: ${e.message}")
            }
            runOnUiThread {
                ui.btnCheckUpdate.isEnabled = true
                outcome.onSuccess { apk ->
                    ui.textUpdateStatus.text = getString(R.string.update_found_title, r.version)
                    runCatching { Updater.installApk(this, apk) }.onFailure { e ->
                        DiagnosticLog.record(this, "update", "唤起安装失败", e.javaClass.simpleName)
                        ui.textUpdateStatus.text = updateErrorText(e)
                    }
                }.onFailure { e ->
                    ui.textUpdateStatus.text = updateErrorText(e)
                }
            }
        }.start()
    }

    private fun errorCode(e: Throwable): String =
        (e as? Updater.UpdateError)?.code ?: e.javaClass.simpleName

    private fun updateErrorText(e: Throwable): String = when (errorCode(e)) {
        "update_source_unreachable" -> getString(R.string.update_err_source)
        "update_rate_limited" -> getString(R.string.update_err_rate)
        "missing_asset" -> getString(R.string.update_err_asset)
        "untrusted_host" -> getString(R.string.update_err_host)
        "download_failed" -> getString(R.string.update_err_download)
        else -> getString(R.string.update_err_generic, e.message ?: e.javaClass.simpleName)
    }

    /**
     * 把一批发现结果并进列表：合并 mDNS 被动监听与主动扫描（组播被丢时唯一有效）。
     * 按 device_id 去重、后来的覆盖先前的——后者地址更新，地址过期是"看得见却连不上"的头号原因。
     */
    private fun mergeNearby(arr: org.json.JSONArray) {
        for (i in 0 until arr.length()) {
            val dev = arr.optJSONObject(i) ?: continue
            val id = dev.optString("device_id")
            if (id.isEmpty()) continue
            val addr = dev.optJSONArray("addrs")?.optString(0).orEmpty()
            nearbyCache[id] = NearbyDeviceItem(
                deviceId = id,
                name = dev.optString("name"),
                address = addr,
                paired = dev.optBoolean("paired"),
            )
        }
        LinkStats.discovered = nearbyCache.size
        val empty = nearbyCache.isEmpty()
        ui.textNoNearby.visibility = if (empty) android.view.View.VISIBLE else android.view.View.GONE
        ui.textNoNearby.text = getString(if (empty) R.string.nearby_empty_hint else R.string.nearby_empty)
        nearbyDeviceAdapter.submitList(nearbyCache.values.toList())
    }

    /**
     * 手动输入地址配对，是所有自动发现失效时的最后一条路。
     * 对话框同时给本机地址（念给对方）和输入框，否则用户还得自己去找"我的地址"。
     */
    /** 正开着的数字码对话框里那两个要回填的控件；关掉时置空。 */
    private var shortCodeView: android.widget.TextView? = null
    private var shortCodeExpiryView: android.widget.TextView? = null

    /**
     * 数字码配对，补其它三条路的前提空档（扫码要摄像头、附近设备要组播、手动要 IP 和端口），只需敲 6 个
     * 数字。
     * 安全与「附近设备」同套：数字只用来在局域网里挑出对方，对方仍须在屏幕上点同意，两边还要核对同一组
     * 安全码。
     */
    private fun showShortCodeDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_short_code, null)
        val codeText = view.findViewById<android.widget.TextView>(R.id.textMyShortCode)
        val expiryText = view.findViewById<android.widget.TextView>(R.id.textMyShortCodeExpiry)
        val input = view.findViewById<android.widget.EditText>(R.id.inputPeerShortCode)

        view.findViewById<android.view.View>(R.id.btnGenerateShortCode).setOnClickListener {
            send("show_short_code")
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.short_code_title)
            .setView(view)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.pair_now) { _, _ ->
                val code = input.text.toString().filter { it.isDigit() }
                if (code.length == 6) {
                    snack(getString(R.string.short_code_searching))
                    send("pair_with_short_code", JSONObject().put("code", code))
                } else {
                    snack(getString(R.string.short_code_needs_six))
                }
            }
            .create()
        // 关掉对话框就停止对外应答：界面都不在了还继续让别人搜得到，
        // 是用户完全预期不到的。
        dialog.setOnDismissListener {
            shortCodeView = null
            shortCodeExpiryView = null
            send("clear_short_code")
        }
        shortCodeView = codeText
        shortCodeExpiryView = expiryText
        dialog.show()
    }

    private fun showManualAddressDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_manual_address, null)
        val mine = view.findViewById<android.widget.TextView>(R.id.textMyAddress)
        val input = view.findViewById<android.widget.EditText>(R.id.inputPeerAddress)

        // 地址是异步向 Go 侧要的，回来前显示"正在获取"。须记下 TextView 由 render() 回填：
        // 先 show() 再 send() 时对话框已渲染，myEndpoints 更新后不会回头刷新，会永远显示"暂时拿不到本机地址
        // "。
        mine.text = myEndpoints.firstOrNull() ?: getString(R.string.my_address_loading)
        view.findViewById<android.view.View>(R.id.btnCopyMyAddress).setOnClickListener {
            val addr = myEndpoints.firstOrNull()
            if (addr == null) {
                snack(getString(R.string.my_address_unknown))
            } else {
                ClipboardBridge.copyPlainText(this, addr)
                snack(getString(R.string.address_copied))
            }
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.manual_address_title)
            .setView(view)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.pair_now) { _, _ ->
                val addr = input.text.toString().trim()
                if (addr.isNotEmpty()) {
                    send("pair_with_address", JSONObject().put("address", addr).put("mode", "long"))
                }
            }
            .create()
        dialog.setOnDismissListener { manualAddressView = null }
        manualAddressView = mine
        dialog.show()

        // 地址每次打开都重新问一次：换了 Wi-Fi 之后旧地址是废的，而"照着一个
        // 早就失效的地址念半天"是这条路上最常见的浪费。
        send("local_endpoints")
    }

    /** 把最新的本机地址填进正开着的「手动输入地址」对话框。 */
    private fun refreshManualAddressView() {
        val view = manualAddressView ?: return
        view.text = myEndpoints.firstOrNull() ?: getString(R.string.my_address_unknown)
    }

    /** 把诊断报告翻译成人话。Go 侧只给 id 和数值，句子在这边拼。 */
    private fun renderDiagnosis(checks: org.json.JSONArray) {
        val lines = ArrayList<String>(checks.length())
        for (i in 0 until checks.length()) {
            val c = checks.optJSONObject(i) ?: continue
            val v = c.optJSONObject("values")
            fun value(key: String): String = v?.optString(key).orEmpty()
            val line = when ("${c.optString("id")}.${c.optString("status")}") {
                // 网卡这一条排在最前面是有原因的：安卓上它一挂，下面几条全会以
                // "一切正常但就是找不到设备"的样子失败。见 core/netif 的说明。
                "interfaces.ok" -> getString(R.string.diag_interfaces_ok, value("usable"), value("multicast"))
                "interfaces.warn" -> getString(R.string.diag_interfaces_warn, value("usable"))
                "interfaces.fail" -> getString(R.string.diag_interfaces_fail)
                "listening.ok" -> getString(R.string.diag_listening_ok, value("addr"))
                "listening.fail" -> getString(R.string.diag_listening_fail)
                "endpoints.ok" -> getString(R.string.diag_endpoints_ok, value("count"))
                "endpoints.fail" -> getString(R.string.diag_endpoints_fail)
                "mdns_publish.ok" -> getString(R.string.diag_mdns_publish_ok)
                "mdns_publish.warn" -> getString(R.string.diag_mdns_publish_warn)
                "beacon.ok" -> getString(R.string.diag_beacon_ok, value("port"))
                "beacon.warn" -> getString(R.string.diag_beacon_warn, value("port"))
                "mdns_peers.ok" -> getString(R.string.diag_mdns_peers_ok, value("count"))
                "mdns_peers.warn" -> getString(R.string.diag_mdns_peers_warn)
                // info = 本机一切正常、只是对面不在，不算故障；措辞不带"请检查"，否则用户会白折腾防火墙和网络设置。
                "mdns_peers.info" -> getString(R.string.diag_mdns_peers_info)
                "lan_scan.ok" -> getString(R.string.diag_lan_scan_ok, value("found"))
                "lan_scan.warn" -> getString(R.string.diag_lan_scan_warn, value("probed"), value("subnets"))
                "lan_scan.info" -> getString(R.string.diag_lan_scan_info, value("probed"), value("subnets"))
                "lan_scan.fail" -> getString(R.string.diag_lan_scan_fail)
                // 认不出的组合不能静默跳过：Go 侧新增状态档时，报告会悄悄少一行却仍显得完整；宁可显示粗糙。
                else -> "${c.optString("id")}: ${c.optString("status")}"
            }
            lines += line
        }
        ui.textDiagResult.visibility = android.view.View.VISIBLE
        ui.textDiagResult.text = lines.joinToString("\n")
    }

    /**
     * 把"上次连上是何时"变成人话，按分钟取整：作为 [PairedDeviceItem] 字段参与 DiffUtil 比较，按秒会让
     * 每秒的状态轮询都整行重绑。
     */
    private fun relativeAgo(lastSeenMs: Long): String {
        val elapsed = (System.currentTimeMillis() - lastSeenMs).coerceAtLeast(0)
        val minutes = elapsed / 60_000
        return when {
            minutes < 1 -> getString(R.string.last_seen_just_now)
            minutes < 60 -> getString(R.string.last_seen_minutes, minutes)
            minutes < 60 * 24 -> getString(R.string.last_seen_hours, minutes / 60)
            else -> getString(R.string.last_seen_days, minutes / (60 * 24))
        }
    }

    /** 设备状态的人话。原先这几句写死在这里，翻译不到、也没法跟桌面端对齐。 */
    private fun stateLabel(state: String): String = getString(
        when (state) {
            "CONNECTED" -> R.string.dev_state_connected
            "DEGRADED" -> R.string.dev_state_degraded
            "CONNECTING", "AUTHENTICATING" -> R.string.dev_state_connecting
            "RECONNECTING" -> R.string.dev_state_reconnecting
            "REVOKED" -> R.string.dev_state_revoked
            else -> R.string.dev_state_offline
        }
    )

    /** 收到文件后搬到用户选定的目录。没选过就留在应用私有目录，不做任何事。 */
    private fun onTransfer(data: JSONObject) {
        // 只认 recv_done——它是唯一带 path 的那个，表示文件已经完整落地。
        // 别去匹配提示文案：换个措辞就悄悄失灵，而失灵的表现是"收到了但找不到"。
        if (data.optString("kind") != "recv_done") return
        val path = data.optString("path").takeIf { it.isNotEmpty() } ?: return
        Thread {
            val moved = FileBridge.deliverToUserFolder(this, File(path))
            if (moved) runOnUiThread { snack(getString(R.string.save_to_changed)) }
        }.start()
    }

    private fun showQr(code: String, expiresAt: Long) {
        val size = 560
        val matrix = QRCodeWriter().encode(code, BarcodeFormat.QR_CODE, size, size)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        for (x in 0 until size) {
            for (y in 0 until size) {
                bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
        }
        ui.imageQr.setImageBitmap(bmp)
        ui.cardMyCode.visibility = android.view.View.VISIBLE
        // 刚生成的码要是折叠着，等于白生成——用户按了「出示我的码」，
        // 屏幕上却只多出一行标题。
        myCodeSection?.expand(this)
        val left = ((expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
        ui.textCodeExpiry.text = getString(R.string.code_expires_in, left.toInt())
    }

    private fun showSasDialog(data: JSONObject) {
        val digits = data.optString("sas_digits")
        val emoji = data.optJSONArray("sas_emoji")?.let { arr ->
            (0 until arr.length()).joinToString(" ") { arr.optString(it) }
        } ?: ""
        val requestId = data.optString("request_id")
        AlertDialog.Builder(this)
            .setTitle(R.string.confirm_pair_title)
            .setMessage("${data.optString("name")}\n\n$digits\n$emoji\n\n${getString(R.string.confirm_pair_hint)}")
            .setPositiveButton(R.string.matches) { _, _ ->
                send(
                    "pair_respond",
                    JSONObject().put("request_id", requestId).put("accept", true).put("mode", "long"),
                )
            }
            .setNegativeButton(R.string.mismatch) { _, _ ->
                send("pair_respond", JSONObject().put("request_id", requestId).put("accept", false))
            }
            .setCancelable(false)
            .show()
    }

    /** 把字节数写成人看的样子。1024 进制，跟系统文件管理器一致。 */
    private fun humanSize(n: Long): String {
        if (n <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var v = n.toDouble()
        var i = 0
        while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
        return if (v < 10 && i > 0) String.format("%.1f %s", v, units[i])
        else String.format("%d %s", v.toLong(), units[i])
    }

    private fun snack(text: String) = Snackbar.make(ui.root, text, Snackbar.LENGTH_SHORT).show()

    override fun onStart() {
        super.onStart()
        activityVisible = true
        if (appearanceConfig.interfaceMode == InterfaceMode.PROFESSIONAL) {
            metricsHandler.post(refreshMetrics)
        }
        statusPollHandler.post(refreshStatusPoll)
    }

    override fun onResume() {
        super.onResume()
        // 安卓 10 起只有前台应用读得到剪贴板，所以"回到前台"是这个平台上
        // 能拿到剪贴板变化的唯一时机。详见 syncClipboardOnResume 的说明。
        syncClipboardOnResume()
        refreshImeStatus()
        // 从系统设置页改完通知权限/电池优化回来，这里必然会触发——
        // 卡片上的状态才不会停在打开设置页那一刻的旧值。
        refreshSystemPermissionsStatus()
        // 顺便把进行中的传输补一次：Activity 可能刚被系统回收重建，
        // 而这段时间里的进度事件已经错过了。
        send("active_transfers")
    }

    override fun onStop() {
        activityVisible = false
        metricsHandler.removeCallbacks(refreshMetrics)
        statusPollHandler.removeCallbacks(refreshStatusPoll)
        super.onStop()
    }

    override fun onDestroy() {
        metricsHandler.removeCallbacks(refreshMetrics)
        SyncService.listeners.remove(onEvent)
        super.onDestroy()
    }
}
