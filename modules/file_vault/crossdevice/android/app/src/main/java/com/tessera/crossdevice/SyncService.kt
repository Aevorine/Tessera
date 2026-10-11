package com.tessera.crossdevice

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import mobile.Agent
import mobile.EventSink
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * 承载协议核心的前台服务。必须前台：要求断联后快速自动连回，进程须在息屏、后台时存活，
 * 否则重连状态机、已建立会话和传输断点都会随进程消失。
 * 这里只做平台侧的事（托管进程、组播锁、系统剪贴板），协议逻辑在 Go 侧，与 Windows 守护进程共用
 * core/agent。
 */
class SyncService : Service() {

    companion object {
        // internal：设置区「系统权限与后台运行」卡片要用同一 ID 查该通知渠道是否被单独关掉。
        // 渠道 ID 换成 "_v2"：渠道重要性只在首次创建时生效，改 IMPORTANCE_* 对已装旧版的手机无效，必须建新
        // 渠道。
        internal const val CHANNEL_ID = "tessera_sync_v2"
        private const val NOTIF_ID = 1

        /** 进程内单例：Activity 要拿它发请求，服务重启则重新赋值。 */
        @Volatile
        var instance: SyncService? = null
            private set

        /** 事件订阅者。UI 层注册后即可收到 Go 侧推来的每一行 JSON。 */
        val listeners = CopyOnWriteArrayList<(JSONObject) -> Unit>()

        /**
         * 带回调的请求。id 从 2^24 起编以与 MainActivity 的序号错开；响应按 id 直接交回调用方，不广播给所有
         * 订阅者。
         */
        private val callSeq = AtomicInteger(1 shl 24)
        private val callbacks = ConcurrentHashMap<Int, (JSONObject) -> Unit>()

        /** 发一条请求，响应回到 [onResult]（在 Go 的回调线程上）。核心没就绪时返回 false。 */
        fun call(method: String, params: JSONObject? = null, onResult: ((JSONObject) -> Unit)? = null): Boolean {
            val svc = instance ?: return false
            val id = callSeq.incrementAndGet()
            val req = JSONObject().put("id", id).put("method", method)
            if (params != null) req.put("params", params)
            if (onResult != null) callbacks[id] = onResult
            val ok = svc.request(req.toString())
            if (!ok) callbacks.remove(id)
            return ok
        }
    }

    private var agent: Agent? = null
    private var clipWatcher: ClipWatcher? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /** 启动中标记，防止 onStartCommand 重复触发时并发建两个 Agent。 */
    @Volatile private var starting = false

    /** 最近一次启动失败的原因，供界面显示——不能让用户对着一个永远转圈的屏幕。 */
    @Volatile var lastError: String? = null
        private set

    /** 协议核心是否已经就绪。界面据此决定显示"启动中"还是真实状态。 */
    val isReady: Boolean get() = agent != null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForeground(NOTIF_ID, buildNotification())
        acquireMulticastLock()
        watchNetworkChanges()
        startAgent()
        // 输入法模式：Tessera 键盘是默认输入法时，后台也读得到剪贴板，复制即同步。
        clipWatcher = ClipWatcher(this) { payload -> call("send_clip", payload) }.also { it.start() }
    }

    /**
     * 换网后重新灌一次网卡清单：index 和地址全变，不重灌则 Go 侧的组播套接字绑在已消失的网卡上，
     * 不报错却再也收不到任何东西。
     */
    private fun watchNetworkChanges() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                refreshInterfaces()
                reportMetered(cm)
            }

            override fun onLost(network: Network) {
                refreshInterfaces()
                reportMetered(cm)
            }

            override fun onLinkPropertiesChanged(network: Network, props: LinkProperties) =
                refreshInterfaces()

            // 计费属性变化会走这条回调（比如从 Wi-Fi 切到 4G）。
            // 必须跟着报给核心，否则跨网会在用户的手机流量上偷偷跑中继。
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                reportMetered(cm)
            }
        }
        runCatching {
            cm.registerNetworkCallback(
                NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                callback,
            )
            networkCallback = callback
        }
    }

    /**
     * 重新枚举并推给 Go 侧。回调会连来多条（available + linkProperties），所以只推送，催发现交给界面按
     * 自己节奏做。
     */
    /**
     * 把"当前网络是否计量"报给核心。跨网会自动花手机流量（后台重连、中继把整个文件过一遍公网），用户无
     * 感；
     * 核心默认计量网络不走中继，前提是有人告诉它。用 NET_CAPABILITY_NOT_METERED 而非"是否蜂窝"：热点和
     * 限流 Wi-Fi 同样被标计量。
     */
    private fun reportMetered(cm: ConnectivityManager) {
        val metered = runCatching {
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            // 拿不到能力信息时按"计量"处理：宁可保守一点少花用户的钱，
            // 也不要在不确定的情况下默认开着中继跑流量。
            caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }.getOrDefault(true)
        request(
            JSONObject()
                .put("id", 0)
                .put("method", "set_network")
                .put("params", JSONObject().put("metered", metered))
                .toString()
        )
    }

    private fun refreshInterfaces() {
        Thread({
            val n = NetworkInterfaces.push()
            // 让界面知道网络变了，可以重新拉一次附近设备。
            emitLocal(
                JSONObject()
                    .put("event", "network_changed")
                    .put("data", JSONObject().put("interfaces", n))
                    .toString()
            )
        }, "tessera-netif-refresh").start()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_name),
            // DEFAULT 而非 LOW：不少厂商系统（含荣耀 MagicOS）把 LOW 渠道通知折叠成摘要，按钮要点开才见；
            // 要压的是出声/横幅，靠单独关声音，不靠渠道等级。
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            setSound(null, null)
            enableVibration(false)
        }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(): android.app.Notification {
        // 点了就读一次剪贴板发出去，见 ClipSyncTrampolineActivity 顶部说明——
        // 这是安卓不让后台读剪贴板之后，退出界面还想同步新复制内容的最快捷径。
        val syncIntent = Intent(this, ClipSyncTrampolineActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
        val syncPending = PendingIntent.getActivity(
            this, 0, syncIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text))
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(true)
            .addAction(0, getString(R.string.notif_action_sync_clip), syncPending)
            // 部分厂商系统仍会折叠常驻通知；把同一个 PendingIntent 也挂到整条通知的点击上，折叠态下点这一行也能
            // 同步。
            .setContentIntent(syncPending)
            .build()
    }

    /**
     * 拿组播锁，否则 mDNS 发现时灵时不灵：Wi-Fi 省电模式下芯片会滤掉非发给本机 MAC 的帧，
     * 表现为亮屏正常、息屏就发现不了设备，易被误判成对方掉线。
     */
    private fun acquireMulticastLock() {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("tessera-mdns").apply {
            setReferenceCounted(true)
            acquire()
        }
    }

    /**
     * 启动协议核心。必须在后台线程：Agent 构造要生成密钥、读写身份文件、建 QUIC 监听、注册 mDNS，全是阻
     * 塞操作，
     * 在主线程会 ANR 或抛异常带走服务，之后 instance 永远为 null。失败必须说出来，不能吞掉让界面一直转
     * 圈。
     */
    private fun startAgent() {
        if (agent != null || starting) return
        starting = true
        val dataDir = filesDir.absolutePath   // 私钥只放应用私有目录
        val name = Build.MODEL ?: "Android"

        Thread({
            try {
                // 必须在构造 Agent 之前：发现层在构造函数里启动，网卡清单晚到则 mDNS 对着空列表注册，"成功"却发现不
                // 了设备（见 NetworkInterfaces）。
                val ifCount = NetworkInterfaces.push()
                if (ifCount == 0) {
                    DiagnosticLog.record(
                        this, "sync", "没有枚举到任何可用网卡",
                        "设备发现（附近设备 / 扫描局域网 / 手动地址）都会失效，请检查 Wi-Fi 是否连接",
                    )
                }
                val a = Agent(dataDir, name, "", EventSink { line -> dispatch(line) })
                agent = a
                starting = false
                // 核心起来先报一次当前网络的计费属性：只靠 NetworkCallback 不够，启动时网络早已连好、回调不再触发，
                // 核心会误以为不计费而放心走中继。
                getSystemService(ConnectivityManager::class.java)?.let { reportMetered(it) }
                // Agent 构造成功时自己会发 ready；这里补一条，覆盖"构造慢、
                // 界面已经渲染完"的情况，让 UI 无论订阅早晚都能收到一次。
                emitLocal("""{"event":"service_ready"}""")
            } catch (t: Throwable) {
                starting = false
                lastError = t.message ?: t.toString()
                // 服务起不来是最需要日志的场景：界面上只表现为"一直在启动中"，
                // 没有日志就完全无从判断。
                DiagnosticLog.record(this, "sync", "同步服务启动失败", "${t.javaClass.simpleName}: ${t.message}")
                emitLocal(
                    JSONObject()
                        .put("event", "service_failed")
                        .put("data", JSONObject().put("error", lastError))
                        .toString()
                )
            }
        }, "tessera-agent-start").start()
    }

    /** 把一条本地构造的事件送进和 Go 侧同一条事件流，让 UI 只需要处理一种来源。 */
    private fun emitLocal(line: String) = dispatch(line)

    private fun dispatch(line: String) {
        val obj = runCatching { JSONObject(line) }.getOrNull() ?: return
        // 收到对端剪贴板内容就写进系统剪贴板。这里跑在 Go 回调线程，异常抛回 JNI 会带崩整个进程，所以一律就
        // 地吞下并记诊断日志。
        if (obj.optString("event") == "clip") {
            runCatching { ClipboardBridge.write(this, obj.optJSONObject("data")) }
                .onFailure { DiagnosticLog.record(this, "clip", "写入剪贴板失败", "${it.javaClass.simpleName}: ${it.message}") }
            // 写进去的这份登记为"见过"：输入法模式的后台监听随后会看到这次变化，
            // 不登记就会把对端内容当成本机新复制再广播回去。
            if (ImeMode.isDefault(this)) ClipDedupe.markCurrent(this)
        }
        callbacks.remove(obj.optInt("id", -1))?.let { cb ->
            runCatching { cb(obj) }
                .onFailure { DiagnosticLog.record(this, "sync", "请求回调失败", "${it.javaClass.simpleName}: ${it.message}") }
            return
        }
        listeners.forEach { l ->
            runCatching { l(obj) }
                .onFailure { DiagnosticLog.record(this, "sync", "事件处理失败", "${it.javaClass.simpleName}: ${it.message}") }
        }
    }

    /** UI 层调它发请求；响应异步回到 [listeners]。返回 false 表示核心还没就绪。 */
    fun request(json: String): Boolean {
        val a = agent ?: return false
        a.handle(json)
        return true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 上次启动失败过就再试一次。用户重新打开界面时会再发一次 startForegroundService，
        // 那正是重试的好时机——否则一次失败就永久卡住，只能重装。
        startAgent()
        // STICKY：被系统回收后自动重建，这是「自动重连」在进程层面的兜底。
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        clipWatcher?.stop()
        clipWatcher = null
        networkCallback?.let { cb ->
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
        }
        networkCallback = null
        multicastLock?.takeIf { it.isHeld }?.release()
        runCatching { agent?.close() }
        agent = null
        instance = null
        super.onDestroy()
    }
}
