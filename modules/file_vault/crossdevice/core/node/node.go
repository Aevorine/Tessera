// Package node 把身份、配对、传输、剪贴板与文件传输组装成设备节点（一个 Node 一台设备）。
// 三端跑同一个 Node，差别只在平台注入的剪贴板读写与 UI 回调。
package node

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/discovery"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/pairing"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/transport"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

// 非内联剪贴板项在 announce 到达后才被拉取。近期不可变项要保留足够久，
// 以免用户复制下一项使上一次拉取失效。
const (
	clipFetchCacheTTL   = 2 * time.Minute
	clipFetchCacheBytes = 128 << 20
)

// 连接建立时的第一个字节，区分普通连接与配对连接。
const (
	modeNormal  byte = 0x01
	modePairing byte = 0x02
)

// State 是连接状态机的状态，见 docs/04-线协议规范.md §7。
type State string

const (
	StateDisconnected   State = "DISCONNECTED"
	StateDiscovering    State = "DISCOVERING"
	StateConnecting     State = "CONNECTING"
	StateAuthenticating State = "AUTHENTICATING"
	StateConnected      State = "CONNECTED"
	StateDegraded       State = "DEGRADED"
	StateReconnecting   State = "RECONNECTING"
	StateSuspended      State = "SUSPENDED"
	StateRevoked        State = "REVOKED"
)

// Event 是给 UI 的事件通知。
type Event struct {
	Kind     string // state | clip | transfer | pair | error
	DeviceID string
	State    State
	Msg      string
	Err      error

	// Path 是刚落地文件的完整路径，仅接收完成时有值。必须是结构化字段而非让调用方解析 Msg：
	// Android 要把文件从私有目录搬到用户选的位置（Go 写不了 SAF content:// URI），
	// 靠匹配中文提示一换措辞就静默失效。
	Path string

	// Xfer 在 Kind=="xfer_state" 时给出传输完整快照；结束类事件至少带 ID 和落地真名。
	Xfer *XferInfo

	// Code 是机器可读的原因码，供界面查翻译表。Msg 是给日志的中文，不能当界面文案
	// （守护进程不知界面语言；曾因此把中文漏到法语/俄语界面）。
	Code string
}

// PairRequest 是待用户确认的配对请求。
type PairRequest struct {
	DeviceID    string
	Name        string
	Type        string
	Method      pairing.Method
	Fingerprint string
	SAS         crypto.SAS
	Incoming    bool // true = 对方来配我
}

// TransferOffer 是收到的文件传输邀约。
type TransferOffer struct {
	TransferID []byte
	From       string
	Name       string
	// Kind 是发送端声明的种类：file | folder | image。文件夹里每个文件各是一次 offer，
	// 界面靠它识别"同一文件夹的第 N 个"，避免弹几百次确认框。
	Kind      string
	FileCount int
	TotalSize int64
	Files     []wire.FileEntry
}

// Config 配置一个节点。
type Config struct {
	Identity    *identity.Identity
	Store       *store.Store
	ListenAddr  string // 默认 ":0"（系统分配端口）
	DownloadDir string

	// CacheDir 是剪贴板大表示借文件通道同步时的私有暂存目录（非用户可见的 DownloadDir）。
	// 留空退到 os.TempDir() 子目录，仅测试用；正式宿主应传私有持久路径
	// （agent.New 传 filepath.Join(DataDir,"clipxfer")）。
	CacheDir string

	// AdvertiseAddrs 覆盖自动探测到的本机地址。
	// 用于测试、容器内运行、或用户手工指定对外地址的场景。
	AdvertiseAddrs []string

	// RendezvousAddr 是汇合点地址，如 "rv.example.com:47820"。留空则整个跨网关闭、只走局域网：
	// 不配就一个包都不会发到公网，不存在数据出境。
	RendezvousAddr string

	// RendezvousSecret 是汇合点服务器的口令（服务器端配了才需要）。
	// 填上就等于把那台服务器锁成自己私用，仍然不需要注册任何账号。
	RendezvousSecret string

	// AllowLoopbackPeers 允许把对端报来的回环地址当可拨地址。只给测试用，生产必须关闭：
	// 对端的 127.0.0.1 指它自己，拨过去只会连到本机。测试需要它，否则回环上的跨网用例会
	// 滤掉公网直连那路，只验到中继，漏了半条链路。
	AllowLoopbackPeers bool

	// DisableTCP 关掉局域网直连用的 TCP 通道（只走 QUIC）。见 tcpcarrier.go。
	DisableTCP bool

	// DisableDiscovery 关掉 mDNS 公布与浏览。测试必须关：大量节点广播会吵到真实设备，
	// 也会互相发现不该看见的对端。
	DisableDiscovery bool

	// ConfirmPair 由 UI 实现：显示 SAS 让用户核对，返回是否确认以及信任等级。
	// 返回 (false, ...) 会中止配对。留空则一律拒绝配对（不会默认放行）。
	ConfirmPair func(PairRequest) (ok bool, mode string, ttl time.Duration)

	// OnClip 收到剪贴板内容时回调。平台侧在这里写入系统剪贴板。
	OnClip func(*clipboard.Item)

	// ConfirmTransfer 决定是否接收文件、落到哪个目录。
	ConfirmTransfer func(TransferOffer) (accept bool, destDir string)

	// OnProgress 传输进行中的进度回调。按时间节流（见 progressInterval），
	// 不是每块都回调——每块都推会把 UI 的事件处理压垮，进度条反而更卡。
	OnProgress func(Progress)

	OnEvent func(Event)
	Logger  *log.Logger
}

// Node 是一台设备。
type Node struct {
	cfg    Config
	id     *identity.Identity
	store  *store.Store
	clock  *clipboard.Clock
	track  *clipboard.Tracker
	tokens *pairing.TokenRegistry

	ln    *transport.Endpoint
	tcpLn net.Listener // 局域网直连的 TCP 通道，可能为 nil（见 startTCP）

	// tcpBad 记着哪些设备最近试 TCP 失败过（旧版本没有这条通道、或被防火墙
	// 丢包），在 tcpBackoff 之内不再对它们先试 TCP。
	tcpMu  sync.Mutex
	tcpBad map[string]time.Time
	disc   *discovery.Service
	beacon *discovery.Beacon

	// crossnet 是跨网（打洞 + 中继）。没配汇合点时为 nil，用 `if cn := n.xnet(); cn != nil`
	// 短路：它是加速手段，不能成为局域网的单点故障。用原子指针因为 SetRendezvous 可运行中
	// 换，读取分散在多个 goroutine。
	crossnet atomic.Pointer[crossnetState]

	// 汇合点配置。单独放而不是改 cfg：cfg 在 New 之后被到处无锁读取，
	// 往里写就是数据竞争。
	rvMu     sync.Mutex
	rvAddr   string
	rvSecret string

	// metered：当前网络是否计费（平台告知）；relayOnMetered：计量网络下是否允许走中继。
	// 见 SetMetered。
	metered        atomic.Bool
	relayOnMetered atomic.Bool

	ctx    context.Context
	cancel context.CancelFunc

	// 短配对码的到期定时器。到点自动撤销对外应答，见 ShowShortPairingCode。
	shortCodeTimer *time.Timer

	mu       sync.RWMutex
	sessions map[string]*Session
	states   map[string]State

	// current 是本机当前剪贴板内容，供对端按需拉取。
	curMu          sync.RWMutex
	current        *clipboard.Item
	clipCache      map[string]cachedClip
	clipCacheBytes int64
	// lastSeenItem 见 setCurrent 的注释：本机因果链的当前头。
	lastSeenItem []byte

	// netSignal 每次网络变化就换一个新 channel 并关闭旧的，
	// 所有正在退避等待的重连循环因此被同时唤醒（广播语义）。
	netMu     sync.RWMutex
	netSignal chan struct{}

	// keepers 记录哪些设备已有保活循环，防止重复。KeepConnected 在启动和每次配对成功后各调，
	// 重新配对旧设备会命中两次，两个循环互相拆台：两条连接同建时 preferred() 关掉一条，
	// 被关的循环立刻重连，表现为"连上又断"，日志看着却都正常。
	keepMu  sync.Mutex
	keepers map[string]struct{}

	// xfers 是所有进行中传输（收发两向）的索引。界面的暂停/取消只有 transfer_id，
	// 不知道它挂在哪条会话上。见 xfercontrol.go。
	xfers *xferRegistry

	// cont 是「接着刚才」的状态（见 continuity.go）。
	cont *continuityState

	// clipXferDir 是剪贴板正文借文件传输通道同步时的私有暂存目录，见 clipxfer.go。
	clipXferDir string

	// clipXferMu 保护下面两个剪贴板传输账本；单独一把锁，因其更新频率和持有时长与
	// curMu/mu 不同，混用会让无关操作互等。
	clipXferMu    sync.Mutex
	outClipXfers  []*outClipXfer
	clipLogMu     sync.Mutex
	clipSyncLog   []ClipSyncEntry
	clipConflicts []ClipConflictEntry

	// clipAssemblyMu 保护 pendingClipAssembly，按「对端设备 ID + 内容哈希」记账而非挂在
	// *Session 上：断线重连换新 Session，账本跟旧会话作废的话，补发分片到达时会被
	// fulfillPendingClip 静默丢弃。挂在 Node 上才能跨会话，配合 resendPendingClipXfers。
	clipAssemblyMu      sync.Mutex
	pendingClipAssembly map[string]*pendingClipAssembly

	// clipAcked 记每台对端最后确认收到的本机内容 ID，重连补发据此判断
	// "它是不是已经有了"。
	clipAckMu   sync.Mutex
	clipAcked   map[string][]byte
	clipSentAt  map[string]clipSend
	clipLatency map[string]clipSend
	// clipLatHist 是每台设备最近 clipLatencyKeep 次测得的剪贴板端到端延迟，
	// 界面画成迷你曲线：网络变差时一眼能看出来，而不是只看到最后一个数。
	clipLatHist map[string][]LatencySample

	// clipHist 是剪贴板时间线，见 cliphistory.go。
	clipHist clipHistory

	// netWatch 是后台网络变化检测的基线，见 netwatch.go。
	netWatch netWatchState

	// offline 记每台设备最近一次自动重连失败的原因（连上即清），
	// 给界面回答"它为什么显示离线"。
	offMu   sync.Mutex
	offline map[string]OfflineReason

	wg sync.WaitGroup
}

type cachedClip struct {
	item    *clipboard.Item
	expires time.Time
	bytes   int64
}

// New 创建节点。
func New(cfg Config) (*Node, error) {
	if cfg.Identity == nil {
		return nil, errors.New("缺少设备身份")
	}
	if cfg.Store == nil {
		return nil, errors.New("缺少存储")
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":0"
	}
	if cfg.Logger == nil {
		cfg.Logger = log.New(log.Writer(), "", log.LstdFlags)
	}
	clipXferDir := cfg.CacheDir
	if clipXferDir == "" {
		clipXferDir = filepath.Join(os.TempDir(), "tessera-clipxfer")
	}
	if err := os.MkdirAll(clipXferDir, 0o700); err != nil {
		return nil, fmt.Errorf("创建剪贴板同步暂存目录失败: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	return &Node{
		cfg: cfg,
		// 汇合点配置从 cfg 抄进可变字段。之后一律以这两个为准——
		// cfg 在 New 之后被到处无锁读取，SetRendezvous 不能往里写。
		rvAddr:              cfg.RendezvousAddr,
		rvSecret:            cfg.RendezvousSecret,
		id:                  cfg.Identity,
		store:               cfg.Store,
		clock:               clipboard.NewClock(cfg.Identity.DeviceID()),
		track:               clipboard.NewTracker(),
		tokens:              pairing.NewTokenRegistry(),
		ctx:                 ctx,
		cancel:              cancel,
		sessions:            make(map[string]*Session),
		states:              make(map[string]State),
		netSignal:           make(chan struct{}),
		keepers:             make(map[string]struct{}),
		xfers:               newXferRegistry(),
		cont:                newContinuityState(),
		clipCache:           make(map[string]cachedClip),
		clipXferDir:         clipXferDir,
		pendingClipAssembly: make(map[string]*pendingClipAssembly),
		clipAcked:           make(map[string][]byte),
		clipSentAt:          make(map[string]clipSend),
		clipLatency:         make(map[string]clipSend),
		clipLatHist:         make(map[string][]LatencySample),
		offline:             make(map[string]OfflineReason),
	}, nil
}

// ---------- 本机剪贴板 ----------

func (n *Node) setCurrent(it *clipboard.Item) {
	n.curMu.Lock()
	n.current = it
	// lastSeenItem 是本设备最后知道的内容（本地复制和收到的都算），即因果链当前头指针，
	// checkClipConflict 靠它判断新内容是否在不知情下产生。与 current 同一个"头"，不另分开维护。
	n.lastSeenItem = it.ID
	n.cacheClipLocked(it)
	n.curMu.Unlock()
}

// lastSeen 返回本机因果链上的当前头（见 setCurrent 的注释）。
func (n *Node) lastSeen() []byte {
	n.curMu.RLock()
	defer n.curMu.RUnlock()
	return n.lastSeenItem
}

func clipBytes(it *clipboard.Item) int64 {
	var total int64
	for _, r := range it.Reps {
		total += int64(len(r.Data))
	}
	return total
}

func (n *Node) cacheClipLocked(it *clipboard.Item) {
	if it == nil || len(it.ID) == 0 {
		return
	}
	now := time.Now()
	for key, entry := range n.clipCache {
		if now.After(entry.expires) {
			n.clipCacheBytes -= entry.bytes
			delete(n.clipCache, key)
		}
	}
	key := hex.EncodeToString(it.ID)
	if prior, ok := n.clipCache[key]; ok {
		n.clipCacheBytes -= prior.bytes
	}
	entry := cachedClip{item: it, expires: now.Add(clipFetchCacheTTL), bytes: clipBytes(it)}
	n.clipCache[key] = entry
	n.clipCacheBytes += entry.bytes
	// 最新/当前项已驻留在 n.current，保留它不增加副本；不能因单次复制超过缓存预算就驱逐这唯一一项。
	for n.clipCacheBytes > clipFetchCacheBytes && len(n.clipCache) > 1 {
		var oldestKey string
		var oldest time.Time
		for candidate, cached := range n.clipCache {
			if oldestKey == "" || cached.expires.Before(oldest) {
				oldestKey, oldest = candidate, cached.expires
			}
		}
		if oldestKey == "" {
			break
		}
		n.clipCacheBytes -= n.clipCache[oldestKey].bytes
		delete(n.clipCache, oldestKey)
	}
}

func (n *Node) currentItem() *clipboard.Item {
	n.curMu.RLock()
	defer n.curMu.RUnlock()
	return n.current
}

// itemForFetch 按稳定内容 ID 返回近期 announce 过的项。只用 currentItem 对懒拉取不对：
// 复制 A 后立刻复制 B，会让所有拉取 A 的接收方报 "no longer current"。
func (n *Node) itemForFetch(id []byte) *clipboard.Item {
	n.curMu.Lock()
	defer n.curMu.Unlock()
	key := hex.EncodeToString(id)
	if entry, ok := n.clipCache[key]; ok {
		if time.Now().Before(entry.expires) {
			return entry.item
		}
		n.clipCacheBytes -= entry.bytes
		delete(n.clipCache, key)
	}
	return nil
}

// CurrentItem 返回本机当前剪贴板内容。
func (n *Node) CurrentItem() *clipboard.Item { return n.currentItem() }

// LocalCopy 由平台层在本机剪贴板变化时调用。先做回环判定：内容正是刚替对端写入的
// 就不再广播，否则 A→B→A 无限循环。
func (n *Node) LocalCopy(preferred string, reps []clipboard.Rep) (*clipboard.Item, error) {
	if len(reps) == 0 {
		return nil, errors.New("没有可发送的内容")
	}
	for i := range reps {
		if reps[i].Hash == nil && reps[i].Data != nil {
			reps[i].Hash = clipboard.HashRep(reps[i].Mime, reps[i].Data)
		}
	}
	for _, r := range reps {
		if r.Mime == preferred && n.track.IsEcho(r.Hash) {
			return nil, nil // 是自己刚写进去的，静默忽略
		}
	}

	it, err := clipboard.NewItem(n.clock, n.id.DeviceID(), preferred, reps)
	if err != nil {
		return nil, err
	}
	// 必须在 setCurrent 之前读：setCurrent 会把头指针移到这条新内容上，
	// CausalRef 记的是"移动之前"那个头，也就是这次复制发生时用户实际见过的内容。
	it.CausalRef = n.lastSeen()
	n.track.Mark(it.ID) // 自己也登记一次，防止转一圈回来又被当成新内容
	n.setCurrent(it)
	n.recordClipHistory(it, ClipViaLocal, "")
	return it, nil
}

// ManualCopy 是用户手动按"发送剪贴板"时的入口：不做回环判定（用户明确要发），
// 并打上 Force 标记让接收端跳过去重窗口。
func (n *Node) ManualCopy(preferred string, reps []clipboard.Rep) (*clipboard.Item, error) {
	if len(reps) == 0 {
		return nil, errors.New("没有可发送的内容")
	}
	it, err := clipboard.NewItem(n.clock, n.id.DeviceID(), preferred, reps)
	if err != nil {
		return nil, err
	}
	it.CausalRef = n.lastSeen()
	it.Force = true
	n.track.Mark(it.ID)
	n.setCurrent(it)
	n.recordClipHistory(it, ClipViaLocal, "")
	return it, nil
}

// alreadyHas 报告一条收到的内容是否无需再交付：本机当前内容就是它，
// 或者 DedupTTL 内刚交付/创建过它。
func (n *Node) alreadyHas(itemID []byte) bool {
	if cur := n.currentItem(); cur != nil && bytes.Equal(cur.ID, itemID) {
		return true
	}
	return n.track.Recent(itemID)
}

// BroadcastClip 把一条内容发给所有在线的已配对设备。
// 单台失败不影响其他设备——这是一对多的基本要求。
func (n *Node) BroadcastClip(it *clipboard.Item) []error {
	_, errs := n.BroadcastClipCount(it)
	return errs
}

func wrapSendErr(s *Session, err error) error {
	return fmt.Errorf("发给 %s 失败: %w", s.PeerName(), err)
}

// CopyText 是最常用的快捷入口：复制一段文本并广播。
func (n *Node) CopyText(text string) (*clipboard.Item, []error) {
	it, err := n.LocalCopy(clipboard.MimeText, []clipboard.Rep{
		{Mime: clipboard.MimeText, Data: []byte(text)},
	})
	if err != nil {
		return nil, []error{err}
	}
	if it == nil {
		return nil, nil
	}
	return it, n.BroadcastClip(it)
}

func (n *Node) Identity() *identity.Identity { return n.id }
func (n *Node) Store() *store.Store          { return n.store }
func (n *Node) Clock() *clipboard.Clock      { return n.clock }

// Start 开始监听。
func (n *Node) Start() error {
	ln, err := transport.Open(n.cfg.ListenAddr)
	if err != nil {
		return err
	}
	n.ln = ln
	n.logf("节点 %s (%s) 监听于 %s", n.id.DisplayName(), n.id.DeviceID(), ln.Addr())

	n.wg.Add(1)
	go n.acceptLoop()
	n.startTCP()

	n.wg.Add(1)
	go n.maintenanceLoop()

	n.wg.Add(1)
	go n.continuityLoop()

	// 发现层必须在监听器起来之后才启动：要公布的端口是系统分配的，
	// Listen 之前根本不知道是几号。
	if !n.cfg.DisableDiscovery {
		n.startDiscovery()
	}
	// 跨网必须在监听器之后启动：它要用监听用的那个套接字去连汇合点服务器，
	// 服务器看到的源地址才是本机真正对外通信的那个 NAT 映射。
	n.startCrossnet()

	// 网络监视最后起：它触发的 NetworkChanged 要读 n.disc / 跨网状态，
	// 先起的话那几个字段还没赋值，是一次无同步的并发读写。
	n.wg.Add(1)
	go n.netWatchLoop()
	return nil
}

// startDiscovery 启动 mDNS 公布/浏览和固定端口 UDP 信标。两条同开因失效场景不重叠：
// mDNS 快免配置但组播常被丢；信标不用组播但需用户主动扫一次。
func (n *Node) startDiscovery() {
	// 只公布公钥前 16 字节：足够让对端在握手前认出该用哪把静态公钥，
	// 又不至于把完整公钥撒得满局域网都是。
	fp := append([]byte(nil), n.id.DHPub[:16]...)
	cfg := discovery.Config{
		DeviceID:    n.id.DeviceID(),
		Name:        n.id.DisplayName(),
		Type:        string(n.id.Type),
		Caps:        []string{"clip", "file", "folder"},
		Fingerprint: fp,
		Port:        n.ln.Port(),
		Logger:      n.cfg.Logger,
		OnPeer:      n.onDiscovered,
	}
	n.disc = discovery.New(cfg)
	if err := n.disc.Start(); err != nil {
		n.logf("发现层启动失败（仍可通过缓存地址连接）: %v", err)
	}

	n.beacon = discovery.NewBeacon(cfg)
	if err := n.beacon.Start(); err != nil {
		n.logf("信标启动失败（仍可主动扫描别人）: %v", err)
	}

	// 同帐号自动发现。放在这里而非 Start()，因为要用此处才建好的 n.beacon。
	// 见 rendezvous.go：配对过的设备换网、mDNS 被丢时仍能自己找到对方。
	go n.runRendezvous()
}

// ScanLAN 主动扫一遍局域网。组播被过滤时这是找到对方的主要手段。
func (n *Node) ScanLAN(ctx context.Context, timeout time.Duration) (discovery.ScanResult, error) {
	res, err := discovery.Scan(ctx, n.id.DeviceID(), timeout)
	if err != nil {
		return res, err
	}
	// 扫到的设备一并喂给重连唤醒逻辑：如果里面有已配对但断线的设备，
	// 用户按下"扫描"的同时就顺手把它重连上了，不用再等退避计时器。
	for _, p := range res.Peers {
		n.onDiscovered(p)
	}
	return res, nil
}

// LocalEndpoints 返回本机可被对端直连的地址，如 "192.168.1.5:54321"。
// 界面显示后对端手动输入即可配对，是所有自动发现失效时仍可用的路。
func (n *Node) LocalEndpoints() []string {
	return n.endpointHints()
}

// onDiscovered 在局域网扫到设备时调用。若是已配对但未连上的设备就立即唤醒重连循环：
// "亲眼看到对端在同一网络"是最强信号，不必等退避计时器。
func (n *Node) onDiscovered(p discovery.Peer) {
	peer, err := n.store.GetPeer(p.DeviceID)
	if err != nil || !peer.Usable(time.Now()) {
		return // 陌生设备或已失效设备：只留在发现列表里供"附近设备"配对用
	}
	if s, ok := n.SessionFor(p.DeviceID); ok && s.Alive() {
		return // 已经连着了
	}
	n.logf("在局域网发现已配对设备 %s，立即尝试重连", peer.Name)
	n.wakeReconnect()
}

// DiscoveredPeers 返回当前在局域网里发现的设备，供"附近设备"配对界面使用。
func (n *Node) DiscoveredPeers() []discovery.Peer {
	if n.disc == nil {
		return nil
	}
	return n.disc.Peers()
}

// Addr 返回实际监听地址。
func (n *Node) Addr() net.Addr {
	if n.ln == nil {
		return nil
	}
	return n.ln.Addr()
}

func (n *Node) Port() int {
	if n.ln == nil {
		return 0
	}
	return n.ln.Port()
}

// SetAdvertiseAddrs 覆盖对外公布的地址。
// 监听端口在 Start() 之后才确定，所以需要一个启动后再设置的入口。
func (n *Node) SetAdvertiseAddrs(addrs []string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.cfg.AdvertiseAddrs = addrs
}

// Close 停止节点并断开全部连接。
func (n *Node) Close() error {
	n.cancel()
	// 先停发现层再停监听器：Shutdown 会发 goodbye 包，让对端立刻知道本机下线，
	// 不用干等 120 秒 TTL 过期才把我从设备列表里划掉。
	if n.disc != nil {
		_ = n.disc.Close()
	}
	if n.beacon != nil {
		_ = n.beacon.Close()
	}
	if cn := n.crossnet.Swap(nil); cn != nil && cn.client != nil {
		_ = cn.client.Close()
	}

	// 会话必须在端点之前关。关会话会给对端发 CONNECTION_CLOSE，对端立刻重连；
	// 这一帧要从本机 UDP 套接字发出，端点先关则发不出，对端要干等 MaxIdleTimeout（30 秒）。
	// 实测反序时对端离开 CONNECTED 恰为 30.0 秒，先关会话降到毫秒级。
	// 旧 Listener.Close() 只关监听器、套接字还活着，才掩盖了顺序错误，别改回去。
	n.mu.Lock()
	for _, s := range n.sessions {
		s.close(errors.New("节点关闭"))
	}
	n.sessions = make(map[string]*Session)
	n.mu.Unlock()

	if n.tcpLn != nil {
		_ = n.tcpLn.Close()
	}
	if n.ln != nil {
		_ = n.ln.Close()
	}
	n.wg.Wait()
	return nil
}

func (n *Node) acceptLoop() {
	defer n.wg.Done()
	for {
		conn, err := n.ln.Accept(n.ctx)
		if err != nil {
			if n.ctx.Err() != nil {
				return
			}
			n.logf("接受连接失败: %v", err)
			continue
		}
		n.wg.Add(1)
		go func() {
			defer n.wg.Done()
			n.handleIncoming(conn)
		}()
	}
}

func (n *Node) handleIncoming(conn *quic.Conn) {
	ctx, cancel := context.WithTimeout(n.ctx, transport.HandshakeTimeout)
	defer cancel()

	stream, err := conn.AcceptStream(ctx)
	if err != nil {
		_ = conn.CloseWithError(0, "no stream")
		return
	}
	rw := transport.StreamRW{Stream: stream}

	var mode [1]byte
	if _, err := rw.Read(mode[:]); err != nil {
		_ = conn.CloseWithError(0, "no mode byte")
		return
	}

	switch mode[0] {
	case modePairing:
		if err := n.handlePairingResponder(conn, rw); err != nil {
			n.logf("配对失败: %v", err)
			n.emit(Event{Kind: "error", Msg: "配对失败", Err: err})
			// 把真实原因放进 QUIC 关闭原因带给对端。只先写 PAIR_ABORT 帧再关连接不可靠：
			// 关闭可能抢在数据刷出前，用户只看到"配对失败"，分不清是过期还是码已被用。
			_ = conn.CloseWithError(0, truncateReason(err.Error()))
			return
		}
		// 配对成功后等发起方先关（它收完本机最后那条 PAIR_DONE 就会关），
		// 最多等几秒。立刻关的话丢了包的那条确认就再也补发不了。
		select {
		case <-conn.Context().Done():
		case <-n.ctx.Done():
		case <-time.After(3 * time.Second):
		}
		_ = conn.CloseWithError(0, "")
	case modeNormal:
		if err := n.handleNormalResponder(conn, rw); err != nil {
			// 未配对设备来连是常态（比如对方刚被撤销），不刷屏。
			if !errors.Is(err, errUntrusted) {
				n.logf("连接握手失败: %v", err)
			}
			_ = conn.CloseWithError(0, "handshake failed")
		}
	default:
		_ = conn.CloseWithError(0, "bad mode")
	}
}

var errUntrusted = errors.New("对端不在信任列表")

// handleNormalResponder 处理已配对设备的连入（Noise_IK 响应方）。
func (n *Node) handleNormalResponder(conn *quic.Conn, rw transport.StreamRW) error {
	car := quicCarrier{conn: conn}
	sess, err := n.responderHandshake(rw, car, viaInbound)
	if err != nil {
		return err
	}
	if sess.carrier != car {
		// 同时互拨，这条连接输了决胜；安静关掉它，已有那条继续用。
		_ = conn.CloseWithError(0, "duplicate connection")
		return nil
	}
	sess.run()
	return nil
}

// responderHandshake 在已建好的双向字节流上以 Noise_IK 响应方握手。流来源有两种：
// 直接拨入的 QUIC 流和经汇合点转发的中继流，对 Noise 等价（中继只见密文）。
// 调用方负责决胜判断（sess.carrier 是否为自己传入的）和 sess.run()，两条路输了的清理不同。
func (n *Node) responderHandshake(rw io.ReadWriter, car carrier, via string) (*Session, error) {
	prologue := crypto.Prologue(wire.ProtoName, "", n.id.DeviceID())

	var peer *store.Peer
	var peerHello wire.Hello

	res, err := crypto.HandshakeIKResponder(rw, crypto.StaticKey(n.id.DHPriv, n.id.DHPub), prologue,
		func(peerStatic, peerPayload []byte) ([]byte, error) {
			// 先查信任列表：查不到就断，且不返回任何区分性错误，
			// 否则攻击者能用不同公钥试探出"哪些设备是被信任的"。
			p, err := n.store.FindByDHPub(peerStatic)
			if err != nil {
				return nil, errUntrusted
			}
			if !p.Usable(time.Now()) {
				return nil, errUntrusted
			}
			peer = p

			if err := wire.Unmarshal(peerPayload, &peerHello); err != nil {
				return nil, fmt.Errorf("HELLO 解析失败: %w", err)
			}
			if peerHello.Ver != wire.ProtoVersion {
				return nil, fmt.Errorf("协议版本不兼容: 对端 v%d", peerHello.Ver)
			}
			return wire.Marshal(n.helloMsg(p.LastRecv))
		})
	if err != nil {
		return nil, err
	}

	sc := crypto.NewSecureConn(rw, res)
	// 后量子升级必须在建会话之前完成——会话一 run() 起来就开始收发应用数据，
	// 那时候再换密钥两边就对不齐了。
	if err := n.maybeUpgradeHybrid(sc, peerHello, false); err != nil {
		return nil, err
	}
	return n.newSession(peer, car, via, sc, false, peerHello.ProtoFeature), nil
}

// relayCarrier 把一条中继流包成 carrier。
// 结构体里只有一个接口字段，整体可比较，满足决胜逻辑用 != 判断的要求。
type relayCarrier struct{ rw io.ReadWriteCloser }

func (c relayCarrier) Close() error { return c.rw.Close() }

// handshakeResponderOver 在中继流上以响应方建会话。中继没有天然的拨号次序，由 device_id
// 字典序小者发起（见 dialViaRelay）；本端非发起方时先读掉对方的模式字节再走通用握手。
func (n *Node) handshakeResponderOver(ctx context.Context, rw io.ReadWriteCloser) (*Session, error) {
	_ = ctx
	var mode [1]byte
	if _, err := io.ReadFull(rw, mode[:]); err != nil {
		return nil, fmt.Errorf("中继流上读模式字节失败: %w", err)
	}
	if mode[0] != modeNormal {
		return nil, fmt.Errorf("中继流上收到意外的模式 0x%02x", mode[0])
	}
	car := relayCarrier{rw: rw}
	sess, err := n.responderHandshake(rw, car, viaRelay)
	if err != nil {
		return nil, err
	}
	if sess.carrier != car {
		// 输了决胜，把已有那条还给调用方，本条由调用方关掉。
		return sess, nil
	}
	go sess.run()
	return sess, nil
}

// maybeUpgradeHybrid 在双方都公布 PQFeature 时把会话升级成后量子混合会话。
// 单边支持就跳过：协议扩展对端不认识会被当应用数据，整条连接崩溃，这是新旧设备互通的唯一做法。
// 升级失败必须让整条连接失败，不能退回经典模式：两边密钥不一致则消息全解不开，
// 且"降级"正是攻击者想触发的，打断一个来回就能把会话按回可被量子破解的状态。
func (n *Node) maybeUpgradeHybrid(sc *crypto.SecureConn, peerHello wire.Hello, initiator bool) error {
	if !crypto.SupportsPQ(peerHello.ProtoFeature) {
		return nil
	}
	if err := crypto.UpgradeToHybrid(sc, initiator); err != nil {
		return fmt.Errorf("后量子握手失败: %w", err)
	}
	return nil
}

func (n *Node) helloMsg(lastRecv uint64) *wire.Hello {
	return &wire.Hello{
		Ver:         wire.ProtoVersion,
		DeviceID:    n.id.DeviceID(),
		Name:        n.id.DisplayName(),
		Type:        string(n.id.Type),
		Caps:        []string{"clip", "file", "folder"},
		LastRecvSeq: lastRecv,
		UnixMS:      time.Now().UnixMilli(),
		// 公布混合握手能力。老设备不认识就照旧走纯 X25519（静默降级，不是握手失败，见
		// crypto/hybrid.go）。clipxfer1 同理：不认识则退回 ClipFetch/ClipData 按需拉取。
		ProtoFeature: []string{crypto.PQFeature, wire.ClipXferFeature, wire.ClipHistFeature},
	}
}

// ---------- 会话登记 ----------

func (n *Node) newSession(peer *store.Peer, car carrier, via string, sc *crypto.SecureConn, initiator bool, peerFeatures []string) *Session {
	s := &Session{
		node:         n,
		peer:         peer,
		carrier:      car,
		via:          via,
		sc:           sc,
		wc:           wire.NewConn(sc),
		initiator:    initiator,
		peerFeatures: peerFeatures,
		done:         make(chan struct{}),
		pending:      make(map[string]*clipFetch),
		recvXfers:    make(map[string]*recvTransfer),
	}
	n.mu.Lock()
	if old, ok := n.sessions[peer.DeviceID]; ok && old.Alive() {
		// 只有活着的旧会话才需要决胜；已关闭但尚未被 run() 的 defer 摘掉的直接顶替，
		// 否则可能保留一具尸体，设备再也连不上。
		// 双方自动重连会同时互拨（glare），各有两条连接；若都"留新关旧"会互踢并立刻重连，
		// 表现为抖动。所以两端用同一规则算赢家：device_id 较小的一方作为拨号方的那条胜出，
		// 两边结果一致，恰好留一条。
		if s.preferred() == old.preferred() || !s.preferred() {
			// 新连接不该赢：保留旧的，让调用方把新连接关掉。
			n.mu.Unlock()
			return old
		}
		old.close(errors.New("被同时互拨中胜出的连接替换"))
	}
	n.sessions[peer.DeviceID] = s
	n.mu.Unlock()
	n.clearOfflineReason(peer.DeviceID)
	n.setState(peer.DeviceID, StateConnected)
	// 刚连上就把本机正在做的事补发一次，否则对端要等最多一个重播周期。
	// 放在另一个 goroutine 里：这里是握手路径上，写入阻塞会拖慢连接建立。
	go n.sendContinuityOnConnect(s)
	// 同理补发断线时没推完的剪贴板正文（resendPendingClipXfers）。先补发断线期间本机最新
	// 复制的内容，announce 必须先于正文到达，接收端才有账本可填，故两步串行；
	// 再向对端要它断线期间复制内容的摘要，补全剪贴板时间线。
	go func() {
		n.replayCurrentClip(s)
		n.resendPendingClipXfers(s)
		s.requestClipHistory()
	}()
	return s
}

func (n *Node) dropSession(s *Session) {
	n.mu.Lock()
	if cur, ok := n.sessions[s.peer.DeviceID]; ok && cur == s {
		delete(n.sessions, s.peer.DeviceID)
		n.mu.Unlock()
		// 连接断了就把它的提示清掉。不等 90 秒自然过期：
		// “电脑已经不在线了”本身就是“那边没事了”最直接的证据。
		n.dropContinuity(s.peer.DeviceID)
		n.setState(s.peer.DeviceID, StateDisconnected)
		return
	}
	n.mu.Unlock()
}

// SessionFor 返回与某设备的当前会话。
func (n *Node) SessionFor(deviceID string) (*Session, bool) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	s, ok := n.sessions[deviceID]
	return s, ok
}

// Sessions 返回全部活跃会话。
func (n *Node) Sessions() []*Session {
	n.mu.RLock()
	defer n.mu.RUnlock()
	out := make([]*Session, 0, len(n.sessions))
	for _, s := range n.sessions {
		out = append(out, s)
	}
	return out
}

// State 返回某设备的连接状态。
func (n *Node) State(deviceID string) State {
	n.mu.RLock()
	defer n.mu.RUnlock()
	if st, ok := n.states[deviceID]; ok {
		return st
	}
	return StateDisconnected
}

func (n *Node) setState(deviceID string, st State) {
	n.mu.Lock()
	old := n.states[deviceID]
	n.states[deviceID] = st
	n.mu.Unlock()
	if old != st {
		n.emit(Event{Kind: "state", DeviceID: deviceID, State: st})
	}
}

// maintenanceLoop 周期性清理到期的临时设备。
// 到期判断只信本地时钟——绝不采信对端自报的时间。
func (n *Node) maintenanceLoop() {
	defer n.wg.Done()
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
			now := time.Now()
			for _, p := range n.store.ListPeers() {
				if !p.Usable(now) {
					if s, ok := n.SessionFor(p.DeviceID); ok {
						s.close(errors.New("授权已到期"))
					}
					n.setState(p.DeviceID, StateRevoked)
				}
			}
			if k := n.store.PurgeExpired(now); k > 0 {
				n.logf("清理了 %d 台已到期的临时设备", k)
			}
			n.purgeStaleClipXferFiles(now)
		}
	}
}

func (n *Node) emit(e Event) {
	if n.cfg.OnEvent != nil {
		n.cfg.OnEvent(e)
	}
	// 传输离开注册表（完成/失败/取消/掉线）时，若本机正播报的恰是它，就收回「接着刚才」提示。
	// 所有结束路径最终都发 ended，放这里不必逐个收尾点补。另起 goroutine：收回要广播给各会话，
	// 而 emit 的某些调用点还持有会话锁。
	if e.Kind == "xfer_state" && e.Msg == XferEnded && e.Xfer != nil && n.cont != nil {
		go n.clearTransferContinuity(e.Xfer.ID)
	}
}

// truncateReason 裁剪 QUIC 关闭原因。QUIC 的 reason phrase 要塞进一个包里，
// 过长会被截断或导致关闭帧异常，这里先裁到安全长度。
func truncateReason(s string) string {
	const max = 200
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

func (n *Node) logf(format string, args ...any) {
	n.cfg.Logger.Printf("[%s] "+format, append([]any{n.id.DisplayName()}, args...)...)
}
