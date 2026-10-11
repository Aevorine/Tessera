// Package agent 把协议核心包装成可被任意宿主驱动的 JSON 请求/事件端点，Windows 守护进程和 Android
// 应用共用。
// 宿主提供发出 JSON 行的回调（sink），并把请求交给 Handle()：Windows 接 stdout/stdin，Android 接
// gomobile 回调。
// 目的是协议核心只写一份，避免复制出的副本走散（docs/01-架构与技术原理.md §1）。
package agent

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/discovery"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
	"github.com/Aevorine/Tessera/crossdevice/core/pairing"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// ---------- 线协议 ----------

type request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type response struct {
	ID     int    `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type event struct {
	Event string `json:"event"`
	Data  any    `json:"data,omitempty"`
}

// Agent 持有节点与所有待用户答复的请求。
type Agent struct {
	n     *node.Node
	id    *identity.Identity
	store *store.Store

	// sink 由宿主注入：收到一行 JSON（响应或事件）就把它送出去。
	// Windows 侧写 stdout，Android 侧转成 gomobile 回调。
	outMu sync.Mutex
	sink  func(string)

	// pending 是"等 UI 回话"的请求：配对安全码确认、是否接收文件。
	// Go 侧发一个事件出去，然后阻塞等 Electron 调对应的 *_respond 方法。
	pendMu  sync.Mutex
	pending map[string]chan map[string]any
	pendSeq atomic.Int64

	clipSync      atomic.Bool
	clipPlainOnly atomic.Bool
	autoAccept    atomic.Bool
	downloadDir   atomic.Value // string

	// folderDec 记着用户对「某台设备发来的某个文件夹」的回答。文件夹里每个文件在协议上是独立 offer，
	// 不记则确认框弹几百次，各占一个等待位，2 分钟超时被当拒绝，文件夹只收到一半。见 confirmTransfer。
	folderMu  sync.Mutex
	folderDec map[string]*folderDecision
}

// folderDecision 是对一个文件夹的确认结果。
type folderDecision struct {
	done   chan struct{} // 用户答复（或超时）之后关闭
	accept bool
	dir    string
	until  time.Time // 这条结论的有效期（滑动）；零值表示还在等用户答复
}

const (
	// folderAcceptTTL：接受之后，同一设备同名文件夹的后续文件在这段时间内
	// 免再确认。滑动窗口——文件还在源源不断地来就一直有效。
	folderAcceptTTL = 10 * time.Minute
	// folderRejectTTL：拒绝之后很快再来的文件直接回绝，别再弹框打扰。
	folderRejectTTL = 2 * time.Minute
)

// Sink 是宿主提供的输出通道：每次调用收到一行完整的 JSON（响应或事件）。
// 实现必须是并发安全的——Agent 会从多个 goroutine 调它。
type Sink func(line string)

// Config 是启动一个 Agent 所需的全部参数。
type Config struct {
	DataDir string // 身份、设备名单、传输断点都放这里
	Name    string // 本机设备名；留空则取主机名
	Addr    string // 监听地址；留空则用 :39421
	Sink    Sink   // 必填
}

// New 创建并启动一个 Agent。返回后节点已在监听，且已对已配对的长期设备开启自动重连。
func New(cfg Config) (*Agent, error) {
	if cfg.Sink == nil {
		return nil, errors.New("必须提供 Sink")
	}
	if cfg.Addr == "" {
		cfg.Addr = ":39421"
	}
	name := cfg.Name
	if name == "" {
		if h, err := os.Hostname(); err == nil && h != "" {
			name = h
		} else {
			name = "Tessera"
		}
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}

	d := &Agent{
		sink:    cfg.Sink,
		pending: make(map[string]chan map[string]any),
	}

	st, err := store.Open(filepath.Join(cfg.DataDir, "devices.json"))
	if err != nil {
		return nil, err
	}
	d.store = st

	// 用户改过名字就用他改的。宿主每次启动都会把主机名当默认值传进来，
	// 不先读存档的话，用户改的名字一重启就被主机名盖回去。
	if saved := st.Options().DeviceName; saved != "" {
		name = saved
	}

	id, err := loadOrCreateIdentity(cfg.DataDir, name)
	if err != nil {
		return nil, err
	}
	d.id = id

	// 偏好从存档恢复，默认值只在存档无对应键时才用。用指针区分"用户显式关掉"和"老存档没这个字段"，
	// 否则升级用户会被静默重置；接收目录同理。
	opts := st.Options()
	d.clipSync.Store(opts.ClipSync == nil || *opts.ClipSync)
	d.clipPlainOnly.Store(opts.ClipPlainOnly != nil && *opts.ClipPlainOnly)
	d.autoAccept.Store(opts.AutoAccept == nil || *opts.AutoAccept)
	if opts.DownloadDir != "" {
		d.downloadDir.Store(opts.DownloadDir)
	} else {
		d.downloadDir.Store(filepath.Join(cfg.DataDir, "downloads"))
	}

	// 节点配置只写一份：端口回退时若再抄一遍 Config，新增回调（OnProgress）漏改第二处，
	// 走回退路径的用户就会静默失去传输进度。
	newNode := func(addr string) (*node.Node, error) {
		return node.New(node.Config{
			Identity:    id,
			Store:       st,
			ListenAddr:  addr,
			DownloadDir: d.downloadDir.Load().(string),
			// 私有暂存目录，跟用户能看见的下载目录分开——见 node.Config.CacheDir。
			CacheDir:        filepath.Join(cfg.DataDir, "clipxfer"),
			Logger:          log.New(os.Stderr, "[crossdevice] ", log.LstdFlags),
			ConfirmPair:     d.confirmPair,
			ConfirmTransfer: d.confirmTransfer,
			OnClip:          d.onClip,
			OnProgress:      d.onProgress,
			OnEvent:         d.onNodeEvent,
			// 跨网。两项都留空时整块功能不启用，只走局域网——这是默认状态。
			RendezvousAddr:   opts.RendezvousAddr,
			RendezvousSecret: opts.RendezvousSecret,
		})
	}

	n, err := newNode(cfg.Addr)
	if err != nil {
		return nil, err
	}
	d.n = n
	// 存档里的"计量网络下允不允许中继"要在启动时就装回去，否则每次重启都会
	// 悄悄回到默认值（关），用户上次显式打开的选择就没了。
	if opts.RelayOnMetered != nil {
		n.SetRelayOnMetered(*opts.RelayOnMetered)
	}
	if err := n.Start(); err != nil {
		// 固定端口（39421）可能被占用、上个实例未退净或开了两份；退到系统分配的端口重试一次，
		// 没有东西依赖该端口——配对码和 mDNS 公布的都是实际监听端口。
		if cfg.Addr == ":0" {
			return nil, err
		}
		log.Printf("在 %s 监听失败（%v），改用系统分配的端口重试", cfg.Addr, err)
		n2, err2 := newNode(":0")
		if err2 != nil {
			return nil, err
		}
		if err2 := n2.Start(); err2 != nil {
			return nil, fmt.Errorf("监听失败（固定端口和随机端口都试过了）: %w", err2)
		}
		d.n = n2
		n = n2
	}

	// 已配对的长期设备一律开自动重连——这是"断联后自动连上"的入口。
	for _, p := range st.ActivePeers(time.Now()) {
		if p.Trust == pairing.TrustLong {
			n.KeepConnected(p.DeviceID)
		}
	}

	d.emit("ready", map[string]any{
		"device_id":   id.DeviceID(),
		"name":        id.DisplayName(),
		"fingerprint": id.Fingerprint(),
		"port":        n.Port(),
	})
	return d, nil
}

// Handle 处理一行 JSON 请求，响应经 Sink 异步送回。每条请求独立 goroutine：
// 配对确认等方法会阻塞几十秒等用户点按钮，串行会卡死通道，连"取消"都发不进来。
func (d *Agent) Handle(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		log.Printf("请求解析失败: %v", err)
		return
	}
	go d.handle(req)
}

// Close 停止节点。
func (d *Agent) Close() error {
	if d.n != nil {
		return d.n.Close()
	}
	return nil
}

func (d *Agent) handle(req request) {
	result, err := d.dispatch(req.Method, req.Params)
	if err != nil {
		d.write(response{ID: req.ID, OK: false, Error: err.Error()})
		return
	}
	d.write(response{ID: req.ID, OK: true, Result: result})
}

func (d *Agent) write(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("序列化失败: %v", err)
		return
	}
	d.outMu.Lock()
	defer d.outMu.Unlock()
	d.sink(string(b))
}

func (d *Agent) emit(name string, data any) {
	d.write(event{Event: name, Data: data})
}

// ---------- 方法分发 ----------

func (d *Agent) dispatch(method string, raw json.RawMessage) (any, error) {
	p := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}

	switch method {
	case "status":
		return d.status(), nil

	case "show_pairing_code":
		mode := pairing.TrustLong
		if str(p, "mode") == "temp" {
			mode = pairing.TrustTemp
		}
		ttl := time.Duration(num(p, "ttl_sec")) * time.Second
		if mode == pairing.TrustTemp && ttl == 0 {
			ttl = 30 * time.Minute
		}
		code, payload, err := d.n.ShowPairingCode(mode, ttl, nil)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"code":        code,
			"fingerprint": payload.Fingerprint(),
			"expires_at":  payload.ExpiresAt,
			"endpoints":   payload.Endpoints,
			"mode":        mode,
		}, nil

	case "pair_with_code":
		code := str(p, "code")
		if code == "" {
			return nil, fmt.Errorf("缺少配对码")
		}
		ctx, cancel := context.WithTimeout(context.Background(), node.PairFlowTimeout)
		defer cancel()
		peer, err := d.n.PairWithCode(ctx, code, pairing.MethodQR)
		if err != nil {
			return nil, err
		}
		d.n.KeepConnected(peer.DeviceID)
		return peerJSON(peer, d.n), nil

	// 短数字配对码：显示 6 位数字让对方敲入，补其它路都走不通的空档（二维码要摄像头，附近设备要组播，
	// 手动地址要 IP 和端口，而原「配对码」是 416 字符的二维码载荷转储）。
	case "show_short_code":
		code, expires, err := d.n.ShowShortPairingCode()
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"code":       code,
			"expires_at": expires.UnixMilli(),
			"digits":     discovery.PairingCodeDigits,
		}, nil

	case "clear_short_code":
		d.n.ClearShortPairingCode()
		return map[string]any{"ok": true}, nil

	case "pair_with_short_code":
		code := str(p, "code")
		if code == "" {
			return nil, fmt.Errorf("请输入对方设备上显示的配对码")
		}
		ctx, cancel := context.WithTimeout(context.Background(), node.PairFlowTimeout)
		defer cancel()
		peer, err := d.n.PairWithShortCode(ctx, code)
		if err != nil {
			return nil, err
		}
		d.n.KeepConnected(peer.DeviceID)
		return peerJSON(peer, d.n), nil

	case "pair_respond", "transfer_respond":
		id := str(p, "request_id")
		d.pendMu.Lock()
		ch, ok := d.pending[id]
		if ok {
			delete(d.pending, id)
		}
		d.pendMu.Unlock()
		if !ok {
			// 请求已超时或被撤销。这不是错误——用户点得慢一点就会走到这里，
			// 报错只会让 UI 弹一个没人看得懂的提示。
			return map[string]any{"stale": true}, nil
		}
		ch <- p
		return map[string]any{"stale": false}, nil

	// 附近设备：列出 mDNS 当前发现的未配对设备，是二维码之外的第三条配对路径。
	// 安全性不打折：选中后仍走完整配对握手，对方要确认，两边核对同一组安全码——挡中间人的是安全码，不是
	// 怎么找到对方。
	case "list_nearby":
		return map[string]any{"nearby": d.nearbyList(d.n.DiscoveredPeers())}, nil

	// 主动扫局域网。与 list_nearby 的区别：后者只读 mDNS 被动结果，组播被路由器丢掉时永远为空；
	// lan_scan 真的发广播并逐台单播探测，绕开组播。
	case "lan_scan":
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		res, err := d.n.ScanLAN(ctx, 3*time.Second)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"nearby":  d.nearbyList(res.Peers),
			"probed":  res.Probed,
			"subnets": res.Subnets,
		}, nil

	// 本机地址，给对方手动输入。nil 归一成空数组：nil 会编码成 JSON null，界面 `.map` 会炸，而这是自动
	// 发现全败时的兜底。
	case "local_endpoints":
		eps := d.n.LocalEndpoints()
		if eps == nil {
			eps = []string{}
		}
		return map[string]any{"endpoints": eps}, nil

	// 手动输入地址配对。自动发现全都失效时的兜底路径。
	case "pair_with_address":
		addr := str(p, "address")
		ctx, cancel := context.WithTimeout(context.Background(), node.PairFlowTimeout)
		defer cancel()
		peer, err := d.n.PairWithAddress(ctx, addr)
		if err != nil {
			return nil, err
		}
		d.n.KeepConnected(peer.DeviceID)
		return peerJSON(peer, d.n), nil

	// 连接自检：回答"为什么我看不到另一台设备"。
	case "net_diagnose":
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		rep := d.n.Diagnose(ctx)
		checks := make([]map[string]any, 0, len(rep.Checks))
		for _, c := range rep.Checks {
			checks = append(checks, map[string]any{
				"id": c.ID, "status": c.Status, "values": c.Values,
			})
		}
		return map[string]any{"checks": checks, "endpoints": rep.Endpoints}, nil

	// 向附近设备发起配对，对方确认后两边再核对安全码。
	// 地址有两个来源：mDNS 缓存与调用方从 lan_scan 拿到的；后者必需，扫出的设备不在 DiscoveredPeers 里
	// 。
	// 设备 ID 始终以调用方给的为准并带进握手：即使地址来自外部，连到的也必须是该 ID 的设备，安全码照常
	// 要过。
	case "pair_nearby":
		devID := str(p, "device_id")
		if devID == "" {
			return nil, fmt.Errorf("缺少设备 ID")
		}
		// 地址全部交给节点竞速：多网卡的电脑上第一个地址常常是 VPN、虚拟机网卡
		// 那种这台设备根本到不了的。节点还会并上 mDNS 缓存里这台设备的地址。
		var addrs []string
		if a := strings.TrimSpace(str(p, "address")); a != "" {
			addrs = append(addrs, a)
		}
		addrs = append(addrs, strSlice(p, "addresses")...)
		known := len(addrs) > 0
		for _, np := range d.n.DiscoveredPeers() {
			if np.DeviceID == devID && len(np.Addrs) > 0 {
				known = true
				break
			}
		}
		if !known {
			return nil, fmt.Errorf("这台设备已经不在附近了，请刷新后重试")
		}
		ctx, cancel := context.WithTimeout(context.Background(), node.PairFlowTimeout)
		defer cancel()
		peer, err := d.n.PairWithNearby(ctx, devID, addrs...)
		if err != nil {
			return nil, err
		}
		d.n.KeepConnected(peer.DeviceID)
		return peerJSON(peer, d.n), nil

	case "list_devices":
		return d.devices(), nil

	case "connect_device":
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := d.n.Connect(ctx, str(p, "device_id")); err != nil {
			return nil, err
		}
		return map[string]any{"connected": true}, nil

	case "revoke_device":
		devID := str(p, "device_id")
		if err := d.store.Revoke(devID); err != nil {
			return nil, err
		}
		// 先取消该设备进行中的传输再断连；反过来连接一断，传输控制块还在而会话已没，成了界面上按不动的僵尸
		// 。
		d.n.CancelTransfersFor(devID)
		if s, ok := d.n.SessionFor(devID); ok {
			s.Close("已被撤销")
		}
		return map[string]any{"revoked": true}, nil

	// 批量撤销。手机端要「多选删除 / 全部删除」，一条一条发请求的话中间
	// 任何一条失败都会留下一个说不清的半成品状态，界面还得自己去对账。
	case "revoke_devices":
		ids := strSlice(p, "device_ids")
		if len(ids) == 0 {
			return nil, fmt.Errorf("没有选择设备")
		}
		revoked := 0
		failed := map[string]string{}
		for _, id := range ids {
			if err := d.store.Revoke(id); err != nil {
				failed[id] = err.Error()
				continue
			}
			d.n.CancelTransfersFor(id)
			if s, ok := d.n.SessionFor(id); ok {
				s.Close("已被撤销")
			}
			revoked++
		}
		return map[string]any{"revoked": revoked, "failed": failed, "devices": d.devices()}, nil

	case "set_device_name":
		newName := strings.TrimSpace(str(p, "name"))
		if newName == "" {
			return nil, fmt.Errorf("设备名不能为空")
		}
		if r := []rune(newName); len(r) > 64 {
			newName = string(r[:64])
		}
		d.id.SetName(newName)
		opts := d.store.Options()
		opts.DeviceName = newName
		if err := d.store.SetOptions(opts); err != nil {
			return nil, err
		}
		// 不用断线重连：名字会随下一个心跳（≤10 秒）捎带给每台已连接的设备，
		// 对端收到后更新它存的备注。断连重连虽然也能同步，但会打断正在进行的传输。
		return map[string]any{"name": newName}, nil

	case "rename_device":
		peer, err := d.store.GetPeer(str(p, "device_id"))
		if err != nil {
			return nil, err
		}
		peer.Name = str(p, "name")
		if err := d.store.PutPeer(peer); err != nil {
			return nil, err
		}
		if s, ok := d.n.SessionFor(peer.DeviceID); ok {
			s.SetPeerName(peer.Name)
		}
		return peerJSON(peer, d.n), nil

	// 每台设备单独的同步范围：剪贴板（全部 / 只文字 / 不同步）和收文件
	// （跟随全局 / 每次问 / 自动收）。空串表示那一项不改。
	case "set_device_policy":
		peer, err := d.n.SetPeerPolicy(str(p, "device_id"), str(p, "clip_policy"), str(p, "file_policy"))
		if err != nil {
			return nil, err
		}
		return peerJSON(peer, d.n), nil

	// 「接着刚才」（见 core/node/continuity.go）：播报与查看两个方向刻意不联动，不做自动跳转（理由见
	// wire.Continuity 注释）。
	case "set_continuity":
		progress := -1
		if _, ok := p["progress"]; ok {
			// -1 表示"进度未知"，跟"进度是 0"是两回事：前者不该画进度条，
			// 后者该画一根空的。缺字段时必须落在前者。
			progress = int(num(p, "progress"))
		}
		d.n.SetContinuity(str(p, "kind"), str(p, "title"), str(p, "local_id"), progress)
		return map[string]any{"ok": true}, nil

	case "list_continuity":
		items := d.n.Continuities()
		out := make([]map[string]any, 0, len(items))
		for _, it := range items {
			out = append(out, map[string]any{
				"device_id":     it.DeviceID,
				"device_name":   it.DeviceName,
				"kind":          it.Kind,
				"title":         it.Title,
				"local_id":      it.LocalID,
				"progress":      it.Progress,
				"updated_at_ms": it.UpdatedAtMS,
			})
		}
		return map[string]any{"items": out}, nil

	case "send_clip":
		return d.sendClip(p)

	case "send_files":
		return d.sendFiles(p)

	// 传输控制：三个动作走同一条路径，收发两方向都能暂停/取消——发现传错东西的往往是接收方，而他只有
	// offer 弹窗一次机会。
	case "pause_transfer":
		if err := d.n.PauseTransfer(str(p, "transfer_id")); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil

	case "resume_transfer":
		if err := d.n.ResumeTransfer(str(p, "transfer_id")); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil

	case "cancel_transfer":
		if err := d.n.CancelTransfer(str(p, "transfer_id")); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil

	// 进行中的传输快照：事件是推送的，错过就没了，而界面每次挂载都是白纸；没有它切换面板后进度和暂停/取
	// 消按钮会消失。
	case "active_transfers":
		list := d.n.ActiveTransfers()
		out := make([]map[string]any, 0, len(list))
		for _, x := range list {
			out = append(out, map[string]any{
				"transfer_id": x.ID, "device_id": x.DeviceID, "device_name": x.DeviceName,
				"direction": x.Direction, "name": x.Name, "item_kind": x.Kind,
				"total": x.Total, "state": x.State,
			})
		}
		return map[string]any{"transfers": out}, nil

	// 同步面板：active_transfers 里 item_kind=="clip" 是进行中的正文同步（core/node/clipxfer.go），
	// 这里补已结束的近期历史，合起来才是完整时间线。
	case "clip_sync_log":
		items := d.n.ClipSyncLog()
		out := make([]map[string]any, 0, len(items))
		for _, it := range items {
			out = append(out, map[string]any{
				"device_id": it.DeviceID, "device_name": it.DeviceName,
				"mime": it.Mime, "item_id": it.ItemID, "ok": it.OK,
				"error": it.Error, "at": it.At.UnixMilli(),
			})
		}
		return map[string]any{"items": out}, nil

	// 跨设备剪贴板时间线（本机复制的、对端同步来的、连上时向对端要来的），新的在前。
	// refresh=true 时顺便向在线设备重新要，回复到了再发 clip_timeline 事件。
	case "clip_timeline":
		if v, _ := p["refresh"].(bool); v {
			d.n.RefreshClipHistory()
		}
		return map[string]any{"items": d.clipTimeline(), "clip_sync": d.clipSync.Load()}, nil

	// 再次粘贴时间线上的一条：返回完整正文交给平台层写进系统剪贴板。
	// broadcast=true 时同时当成一次手动发送推给所有在线设备。
	case "clip_timeline_apply":
		id, err := hex.DecodeString(str(p, "item_id"))
		if err != nil || len(id) == 0 {
			return nil, fmt.Errorf("item_id 不合法")
		}
		broadcast, _ := p["broadcast"].(bool)
		it, errs, err := d.n.ApplyClipHistory(id, broadcast)
		if err != nil {
			return nil, err
		}
		msgs := make([]string, 0, len(errs))
		for _, e := range errs {
			msgs = append(msgs, e.Error())
		}
		return map[string]any{
			"item_id": fmt.Sprintf("%x", it.ID), "preferred": it.Preferred,
			"reps": repsJSON(it.Reps), "errors": msgs,
		}, nil

	case "clip_timeline_remove":
		id, err := hex.DecodeString(str(p, "item_id"))
		if err != nil || len(id) == 0 {
			return nil, fmt.Errorf("item_id 不合法")
		}
		return map[string]any{"removed": d.n.RemoveClipHistory(id)}, nil

	case "clip_timeline_clear":
		d.n.ClearClipHistory()
		return map[string]any{"ok": true}, nil

	// 因果冲突：最近几条"对方复制这条内容时还没见过我这边现状"的记录，
	// 供界面画一条"这两条其实是并发的，不是谁覆盖了谁"的提示。
	case "clip_conflicts":
		items := d.n.ClipConflicts()
		out := make([]map[string]any, 0, len(items))
		for _, it := range items {
			out = append(out, map[string]any{
				"device_id": it.DeviceID, "device_name": it.DeviceName,
				"incoming_hlc": it.IncomingHLC, "local_hlc": it.LocalHLC,
				"at": it.At.UnixMilli(),
			})
		}
		return map[string]any{"items": out}, nil

	case "set_options":
		if v, ok := p["clip_sync"].(bool); ok {
			d.clipSync.Store(v)
		}
		if v, ok := p["auto_accept"].(bool); ok {
			d.autoAccept.Store(v)
		}
		if v, ok := p["clip_plain_only"].(bool); ok {
			d.clipPlainOnly.Store(v)
		}
		if v := str(p, "download_dir"); v != "" {
			// 落盘前先确认这个目录真能写。用户选了个只读盘或已拔出的 U 盘时，
			// 现在就报错，好过等到对方传了 3 GB 才在落地那一刻失败。
			if err := os.MkdirAll(v, 0o700); err != nil {
				return nil, fmt.Errorf("接收目录不可用: %w", err)
			}
			probe := filepath.Join(v, ".tessera-write-test")
			if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
				return nil, fmt.Errorf("接收目录不可写: %w", err)
			}
			_ = os.Remove(probe)
			d.downloadDir.Store(v)
		}
		// 持久化，否则重启后设置悄悄回到默认值。
		// 必须先读出再改：SetOptions 是整体替换（s.d.Options = o），新构造结构体会清零未写字段；
		// 曾因此抹掉 DeviceName，改名后再动接收目录或剪贴板开关就丢名字，且随心跳同步给所有已配对设备，全程
		// 无报错。
		opts := d.store.Options()
		clip, auto := d.clipSync.Load(), d.autoAccept.Load()
		opts.DownloadDir = d.downloadDir.Load().(string)
		opts.ClipSync = &clip
		opts.AutoAccept = &auto
		plainOnly := d.clipPlainOnly.Load()
		opts.ClipPlainOnly = &plainOnly

		// 跨网设置。两者都是"只有传了这个键才动"，因为界面可能只提交了
		// 其中一项；不加这层判断的话，改一下剪贴板开关就会把汇合点地址清空。
		if v, ok := p["rendezvous_addr"]; ok {
			addr := strings.TrimSpace(fmt.Sprint(v))
			if addr != "" {
				if err := validateRendezvousAddr(addr); err != nil {
					return nil, err
				}
			}
			opts.RendezvousAddr = addr
		}
		if v, ok := p["rendezvous_secret"]; ok {
			opts.RendezvousSecret = fmt.Sprint(v)
		}
		if v, ok := p["relay_on_metered"].(bool); ok {
			opts.RelayOnMetered = &v
			d.n.SetRelayOnMetered(v)
		}
		if err := d.store.SetOptions(opts); err != nil {
			return nil, err
		}
		// 立刻生效，不要求用户重启应用——否则他填完地址发现没反应，
		// 会以为功能是坏的。
		d.n.SetRendezvous(opts.RendezvousAddr, opts.RendezvousSecret)
		return d.options(), nil

	case "set_network":
		// 平台侧在网络变化时告诉核心"当前这张网要不要按流量计费"。
		// 桌面端不用调，默认按不计费处理。
		if v, ok := p["metered"].(bool); ok {
			d.n.SetMetered(v)
		}
		return map[string]any{"metered": d.n.Metered()}, nil

	case "recovery_code":
		return map[string]any{"code": d.id.ExportRecoveryCode()}, nil

	case "shutdown":
		go func() {
			time.Sleep(200 * time.Millisecond)
			os.Exit(0)
		}()
		return map[string]any{"bye": true}, nil

	default:
		return nil, fmt.Errorf("未知方法: %s", method)
	}
}

// nearbyList 把发现结果整理成界面用的形状。
// 旧写法滤掉所有在 store.ListPeers() 出现过的，而它含已撤销设备，撤销过一次就再也无法出现在「附近的
// 设备」。
// 现在撤销过的照常出现（视为陌生设备），已配对的也出现但带 paired 标记，界面显示"已配对"；
// 整个藏起来会让用户分不清"没扫到"和"被隐藏"。
func (d *Agent) nearbyList(peers []discovery.Peer) []map[string]any {
	paired := map[string]bool{}
	for _, p := range d.store.ListPeers() {
		if !p.Revoked {
			paired[p.DeviceID] = true
		}
	}
	out := []map[string]any{}
	for _, np := range peers {
		out = append(out, map[string]any{
			"device_id": np.DeviceID,
			"name":      np.Name,
			"type":      np.Type,
			"addrs":     np.Addrs,
			"paired":    paired[np.DeviceID],
		})
	}
	return out
}

func (d *Agent) status() map[string]any {
	return map[string]any{
		"device_id":   d.id.DeviceID(),
		"name":        d.id.DisplayName(),
		"type":        string(d.id.Type),
		"fingerprint": d.id.Fingerprint(),
		"port":        d.n.Port(),
		"devices":     d.devices(),
		"options":     d.options(),
	}
}

// validateRendezvousAddr 在保存前挡掉明显填错的地址，否则用户以为配好了，面对永远连不上的跨网却没有
// 任何错误提示。
func validateRendezvousAddr(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("汇合点地址要写成「域名或IP:端口」的形式，比如 rv.example.com:47820（你填的是 %q）", addr)
	}
	if strings.TrimSpace(host) == "" {
		return fmt.Errorf("汇合点地址少了域名或 IP（你填的是 %q）", addr)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n <= 0 || n > 65535 {
		return fmt.Errorf("汇合点端口不对：%q 不是 1-65535 之间的数字", port)
	}
	return nil
}

func (d *Agent) options() map[string]any {
	opts := d.store.Options()
	return map[string]any{
		"clip_sync":       d.clipSync.Load(),
		"clip_plain_only": d.clipPlainOnly.Load(),
		"auto_accept":     d.autoAccept.Load(),
		"download_dir":    d.downloadDir.Load(),
		// 跨网设置。地址为空 = 只走局域网（默认）。
		"rendezvous_addr":  opts.RendezvousAddr,
		"relay_on_metered": d.n.RelayOnMetered(),
		"metered":          d.n.Metered(),
		// 口令不回传明文，只回"设没设过"，设置页显示圆点即可；明文回传只会多一份可能被日志、截图、剪贴板带
		// 走的副本。
		"rendezvous_secret_set": opts.RendezvousSecret != "",
	}
}

func (d *Agent) devices() []map[string]any {
	peers := d.store.ListPeers()
	out := make([]map[string]any, 0, len(peers))
	for _, p := range peers {
		if p.Revoked {
			continue
		}
		out = append(out, peerJSON(p, d.n))
	}
	return out
}

func peerJSON(p *store.Peer, n *node.Node) map[string]any {
	m := map[string]any{
		"device_id": p.DeviceID,
		"name":      p.Name,
		"type":      p.Type,
		"trust":     p.Trust,
		"state":     string(n.State(p.DeviceID)),
		"paired_at": p.PairedAt.UnixMilli(),
		"method":    p.Method,
	}
	if !p.ExpiresAt.IsZero() {
		m["expires_at"] = p.ExpiresAt.UnixMilli()
	}
	if !p.LastSeen.IsZero() {
		m["last_seen"] = p.LastSeen.UnixMilli()
	}
	// 延迟曲线在断线后也留着：「刚才为什么越来越慢然后断了」正要靠它回答。
	if hist := n.ClipLatencyHistory(p.DeviceID); len(hist) > 0 {
		pts := make([]map[string]any, 0, len(hist))
		for _, h := range hist {
			pts = append(pts, map[string]any{"ms": h.Latency.Milliseconds(), "at": h.At.UnixMilli()})
		}
		m["clip_latency_hist"] = pts
	}
	if s, ok := n.SessionFor(p.DeviceID); ok {
		if s.RTT() > 0 {
			m["rtt_ms"] = s.RTT().Milliseconds()
		}
		if lat, at, ok := n.ClipLatency(p.DeviceID); ok {
			m["clip_latency_ms"] = lat.Milliseconds()
			m["clip_acked_at"] = at.UnixMilli()
		}
		// 这条连接实际走的哪条路。界面必须显示出来：走中继时用户有权知道
		// 字节经过了服务器，而"这次为什么慢"也只能靠它回答。
		if v := s.Via(); v != "" {
			m["via"] = v
			m["relayed"] = v == "中继转发"
			m["route"] = s.Route()
		}
	}
	m["clip_policy"] = store.NormalizeClipPolicy(p.ClipPolicy)
	m["file_policy"] = store.NormalizeFilePolicy(p.FilePolicy)
	// 离线时回答"它为什么连不上"：code 给界面查翻译表，at 让界面说"几分钟前"。
	if r, ok := n.LastOfflineReason(p.DeviceID); ok {
		m["offline_reason"] = map[string]any{"code": r.Code, "at": r.At.UnixMilli()}
	}
	return m
}

// ---------- 剪贴板 ----------

func (d *Agent) sendClip(p map[string]any) (any, error) {
	rawReps, _ := p["reps"].([]any)
	if len(rawReps) == 0 {
		return nil, fmt.Errorf("没有可发送的内容")
	}
	var reps []clipboard.Rep
	for _, r := range rawReps {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		mime := str(m, "mime")
		b64 := str(m, "data")
		data, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("表示 %s 的数据不是合法 base64: %w", mime, err)
		}
		reps = append(reps, clipboard.Rep{Mime: mime, Data: data})
	}
	if len(reps) == 0 {
		return nil, fmt.Errorf("没有可用的表示")
	}
	if d.clipPlainOnly.Load() {
		reps = plainReps(reps)
	}
	preferred := str(p, "preferred")
	if preferred == "" {
		preferred = reps[0].Mime
	}

	force, _ := p["force"].(bool)
	// 自动同步关着时，平台自动捕获的复制（输入法监听、桌面轮询）一律不发，仅用户亲手发送（force）照发；
	// 开关在此统一判断。
	if !force && !d.clipSync.Load() {
		return map[string]any{"skipped": "clip_sync_off"}, nil
	}

	var it *clipboard.Item
	var err error
	if force {
		it, err = d.n.ManualCopy(preferred, reps)
	} else {
		it, err = d.n.LocalCopy(preferred, reps)
	}
	if err != nil {
		return nil, err
	}
	if it == nil {
		// 是我们刚写进系统剪贴板的内容转了一圈回来，静默忽略即可，
		// 不然 A 复制 → B 写入 → B 广播回 A，无限循环。
		return map[string]any{"skipped": "echo"}, nil
	}

	// sent 只数真正发出去的：按设备同步范围跳过的不算，否则界面会说
	// 「已发到 3 台」而其中一台根本设成了不同步剪贴板。
	sent, errs := d.n.BroadcastClipCount(it)
	msgs := make([]string, 0, len(errs))
	for _, e := range errs {
		msgs = append(msgs, e.Error())
	}
	return map[string]any{
		"item_id": fmt.Sprintf("%x", it.ID),
		"sent":    sent,
		"errors":  msgs,
	}, nil
}

// plainReps 只留纯文本与图片表示。过滤后一个不剩（比如只有 HTML）时原样返回，
// 宁可带着富格式发出去，也不能让一次复制什么都不同步。
func plainReps(reps []clipboard.Rep) []clipboard.Rep {
	kept := make([]clipboard.Rep, 0, len(reps))
	for _, r := range reps {
		if strings.HasPrefix(r.Mime, "text/plain") || strings.HasPrefix(r.Mime, "image/") {
			kept = append(kept, r)
		}
	}
	if len(kept) == 0 {
		return reps
	}
	return kept
}

func (d *Agent) onClip(it *clipboard.Item) {
	if !d.clipSync.Load() {
		return
	}
	data := map[string]any{
		"item_id":   fmt.Sprintf("%x", it.ID),
		"source":    it.Source,
		"preferred": it.Preferred,
		"sensitive": it.Sensitive,
		"at":        it.HLC.Time().UnixMilli(),
		"replay":    it.Replay,
	}
	if p, err := d.store.GetPeer(it.Source); err == nil {
		data["source_name"] = p.Name
	}
	data["reps"] = repsJSON(it.Reps)
	d.emit("clip", data)
}

func repsJSON(in []clipboard.Rep) []map[string]any {
	reps := make([]map[string]any, 0, len(in))
	for _, r := range in {
		m := map[string]any{"mime": r.Mime, "size": r.Size}
		if r.Data != nil {
			m["data"] = base64.StdEncoding.EncodeToString(r.Data)
		}
		reps = append(reps, m)
	}
	return reps
}

// clipTimeline 转成界面用的 JSON：只含预览和各表示大小，不含正文。
// 正文待用户点「再次粘贴」才经 clip_timeline_apply 取，列表刷新频繁，全量 base64 既慢又多一趟传输。
func (d *Agent) clipTimeline() []map[string]any {
	names := map[string]string{}
	self := d.n.Identity().DeviceID()
	out := []map[string]any{}
	for _, e := range d.n.ClipHistory() {
		name, ok := names[e.Source]
		if !ok {
			if e.Source == self {
				name = d.n.Identity().DisplayName()
			} else if p, err := d.store.GetPeer(e.Source); err == nil {
				name = p.Name
			}
			names[e.Source] = name
		}
		kinds := make([]map[string]any, 0, len(e.Kinds))
		var size int64
		for _, k := range e.Kinds {
			kinds = append(kinds, map[string]any{"mime": k.Mime, "size": k.Size, "ready": k.Ready})
			size += k.Size
		}
		_, online := d.n.SessionFor(e.Source)
		out = append(out, map[string]any{
			"item_id":     hex.EncodeToString(e.ItemID),
			"source":      e.Source,
			"source_name": name,
			"local":       e.Source == self,
			"via":         e.Via,
			"at":          e.At.UnixMilli(),
			"preferred":   e.Preferred,
			"preview":     e.Preview,
			"kinds":       kinds,
			"size":        size,
			"complete":    e.Complete,
			// 正文不全、来源又不在线时，这条暂时粘贴不了：界面据此把按钮置灰。
			"available": e.Usable || (online && e.Source != self),
		})
	}
	return out
}

// ---------- 文件 ----------

// sendItem 是展开后真正要发的一份。协议一次只发一个文件，所以文件夹先走一遍展开成「文件 + 相对路径
// 」，接收端据此重建目录结构。
type sendItem struct {
	path    string // 本机绝对路径
	relPath string // 发给对端的相对路径（含文件夹名）
	folder  string // 属于哪个文件夹；空表示这是用户直接选中的单个文件
	size    int64  // 文件大小；决定走哪条发送车道
	group   node.FolderInfo
}

// expandPaths 把用户选中的路径展开成待发文件列表。此前完全不支持文件夹：OpenSender 对目录 Read 会失
// 败，用户只见"是一个目录"。
func expandPaths(paths []string) ([]sendItem, []string) {
	var out []sendItem
	var bad []string
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			bad = append(bad, filepath.Base(p))
			continue
		}
		if !st.IsDir() {
			if !st.Mode().IsRegular() {
				bad = append(bad, filepath.Base(p)) // 设备文件 / 管道：读它会卡死
				continue
			}
			out = append(out, sendItem{path: p, relPath: filepath.Base(p), size: st.Size()})
			continue
		}
		root := filepath.Clean(p)
		folder := filepath.Base(root)
		// 选中指向目录的符号链接 / 联接点时 WalkDir 不往里走，整个文件夹会被当"一个文件"发而失败；
		// 先解析到真实目录再走，显示名仍用用户选的。
		walkRoot := root
		if real, err := filepath.EvalSymlinks(root); err == nil {
			walkRoot = real
		}
		before := len(out)
		var folderBytes int64
		_ = filepath.WalkDir(walkRoot, func(fp string, de fs.DirEntry, err error) error {
			if err != nil || de.IsDir() {
				// 单个读不了的子项跳过就好，不该让整个文件夹发不出去。
				return nil //nolint:nilerr // 有意吞掉：跳过这一项，继续走完目录
			}
			info, err := de.Info()
			if err != nil {
				return nil //nolint:nilerr // 同上
			}
			if de.Type()&fs.ModeSymlink != 0 {
				// 文件符号链接：发它指向的内容。指向目录的不跟进去——不递归，
				// 也就不会被环形链接拖进死循环。
				target, err := os.Stat(fp)
				if err != nil || target.IsDir() {
					return nil //nolint:nilerr // 悬空链接或目录链接：跳过
				}
				info = target
			}
			if !info.Mode().IsRegular() {
				return nil // 命名管道、套接字、设备文件：读它们会一直卡住
			}
			rel, err := filepath.Rel(walkRoot, fp)
			if err != nil {
				return nil //nolint:nilerr // 同上
			}
			// 相对路径一律用正斜杠：接收端可能是安卓，而 Windows 的反斜杠
			// 在那边不是分隔符，会变成文件名里的一个普通字符。
			out = append(out, sendItem{
				path:    fp,
				relPath: folder + "/" + filepath.ToSlash(rel),
				folder:  folder,
				size:    info.Size(),
			})
			folderBytes += info.Size()
			return nil
		})
		if len(out) == before {
			// 空文件夹：说清楚，别让用户以为发出去了。
			bad = append(bad, folder)
			continue
		}
		// 回头把整个文件夹的规模填进每一项：接收端的确认框要用。
		info := node.FolderInfo{Files: len(out) - before, Bytes: folderBytes}
		for i := before; i < len(out); i++ {
			out[i].group = info
		}
	}
	return out, bad
}

func (d *Agent) sendFiles(p map[string]any) (any, error) {
	paths := strSlice(p, "paths")
	if len(paths) == 0 {
		return nil, fmt.Errorf("没有选择文件")
	}
	targets := strSlice(p, "device_ids")

	var sessions []*node.Session
	if len(targets) == 0 {
		sessions = d.n.Sessions()
	} else {
		for _, id := range targets {
			if s, ok := d.n.SessionFor(id); ok {
				sessions = append(sessions, s)
			}
		}
	}
	if len(sessions) == 0 {
		return nil, fmt.Errorf("没有在线的目标设备")
	}

	items, skipped := expandPaths(paths)
	if len(items) == 0 {
		return nil, fmt.Errorf("选中的内容里没有可发送的文件")
	}

	// 一对多：每台设备一条独立的传输链路，单台失败不影响其他。
	// 立刻返回，进度通过 transfer 事件推给 UI，不阻塞调用方。
	for _, s := range sessions {
		go d.sendBatch(s, items)
	}
	return map[string]any{
		"queued":  len(sessions) * len(items),
		"files":   len(items),
		"devices": len(sessions),
		"skipped": skipped,
	}, nil
}

const (
	// bigFileBytes 以上走「大文件车道」，一次只发一个：它们各自就能跑满链路，并发只会抢带宽，总时间不变
	// 而每条更慢。
	bigFileBytes = 32 << 20
	// smallLaneWorkers：小文件车道的并发数。小文件瓶颈是往返（offer→accept、done→ack、整文件摘要）而非
	// 带宽，
	// 严格串行时链路大半空闲；并发把等待互相盖住。协议不变（本就按 transfer_id 多路复用），旧版本照常能
	// 收。
	smallLaneWorkers = 6
)

// sendBatch 把一批文件发给一台设备：大文件逐个发、小文件并发发，两条车道同时走。
func (d *Agent) sendBatch(s *node.Session, items []sendItem) {
	var big, small []sendItem
	for _, it := range items {
		if it.size >= bigFileBytes {
			big = append(big, it)
		} else {
			small = append(small, it)
		}
	}
	rej := &rejectedFolders{seen: make(map[string]bool)}
	var wg sync.WaitGroup

	if len(big) > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, it := range big {
				d.sendOne(s, it, rej)
			}
		}()
	}
	if len(small) > 0 {
		jobs := make(chan sendItem)
		workers := smallLaneWorkers
		if workers > len(small) {
			workers = len(small)
		}
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for it := range jobs {
					d.sendOne(s, it, rej)
				}
			}()
		}
		for _, it := range small {
			jobs <- it
		}
		close(jobs)
	}
	wg.Wait()
}

// rejectedFolders 记下对端已经回绝过的文件夹。
type rejectedFolders struct {
	mu   sync.Mutex
	seen map[string]bool // folder -> 是否已经报过错
}

// isRejected 报告这个文件夹是否已被回绝。
func (r *rejectedFolders) isRejected(folder string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.seen[folder]
	return ok
}

// markRejected 登记一次回绝，返回这是不是第一次（只有第一次要向用户报错）。
func (r *rejectedFolders) markRejected(folder string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.seen[folder] {
		return false
	}
	r.seen[folder] = true
	return true
}

func (d *Agent) sendOne(s *node.Session, it sendItem, rej *rejectedFolders) {
	name := filepath.Base(it.path)
	dev := s.Peer().DeviceID
	// 对端已经回绝了这个文件夹：剩下的文件不用再去问一遍。
	if it.folder != "" && rej.isRejected(it.folder) {
		return
	}
	d.emit("transfer", map[string]any{
		"kind": "start", "direction": "send",
		"device_id": dev, "device_name": s.PeerName(), "name": name,
		"folder": it.folder,
	})

	var (
		res *node.SendFileResult
		err error
	)
	if it.folder != "" {
		res, err = s.SendFileInFolder(context.Background(), it.path, it.relPath, it.folder, it.group)
	} else {
		res, err = s.SendFileAs(context.Background(), it.path, it.relPath)
	}
	if err != nil {
		// 同一个文件夹被回绝时，只报第一条：后面几百个文件各报一遍
		// 只会把界面刷成一面红墙，而原因只有一个。
		if it.folder != "" && errors.Is(err, node.ErrPeerRejected) && !rej.markRejected(it.folder) {
			return
		}
		// 用户自己按的取消不是错误。报成红色的失败记录，等于告诉他"你刚才那下
		// 操作出问题了"——而事情完全按他的意思发生了。
		kind, payload := "error", map[string]any{"error": err.Error()}
		if errors.Is(err, node.ErrTransferCanceled) {
			kind, payload = "canceled", map[string]any{}
		}
		payload["kind"] = kind
		payload["direction"] = "send"
		payload["device_id"] = dev
		payload["device_name"] = s.PeerName()
		payload["name"] = name
		payload["folder"] = it.folder
		d.emit("transfer", payload)
		return
	}
	d.emit("transfer", map[string]any{
		"kind": "done", "direction": "send",
		"transfer_id": res.ID, "item_kind": res.Kind,
		"device_id": dev, "device_name": s.PeerName(), "name": res.Name,
		"folder": it.folder,
		"size":   res.Size, "chunks": res.Chunks, "sent_chunks": res.SentChunks,
		// skipped 让界面能说"对方已经有了"，而不是笼统的"已发送"。
		// 0 字节完成如果和正常传输显示成一样，用户会怀疑到底传没传。
		"skipped":    res.Skipped,
		"elapsed_ms": res.Elapsed.Milliseconds(),
	})
}

// onProgress 把传输进度转成事件推给 UI。节流只在 node 层做（progressInterval），这里不再限流，否则
// 间隔叠加、进度条一顿一顿。
func (d *Agent) onProgress(p node.Progress) {
	pct := 0
	if p.Total > 0 {
		pct = int(p.Done * 100 / p.Total)
	}
	d.emit("progress", map[string]any{
		// transfer_id 是界面配对进度与结束事件的唯一依据；用"设备+文件名"会因接收端重名改名而对不上，进度永
		// 远删不掉停在 99%。
		"transfer_id": p.ID, "item_kind": p.Kind,
		"device_id": p.DeviceID, "device_name": p.DeviceName,
		"name": p.Name, "direction": p.Direction,
		"done": p.Done, "total": p.Total, "percent": pct,
		"chunks": p.Chunks, "total_chunks": p.TotalChunk,
		"speed": p.Speed,
	})
}

// shouldAutoAccept 判断某设备发来的文件是否免确认直接收。
// 设备自己的收文件策略优先（「每次问」则全局自动也要问，「自动收」则全局关着也收）；
// 跟随全局时只有长期信任的设备自动收，临时设备一律逐次问。
func (d *Agent) shouldAutoAccept(deviceID string) bool {
	p, err := d.store.GetPeer(deviceID)
	if err != nil || !p.Usable(time.Now()) {
		return false
	}
	switch store.NormalizeFilePolicy(p.FilePolicy) {
	case store.FileAsk:
		return false
	case store.FileAuto:
		return true
	}
	return d.autoAccept.Load() && p.Trust == pairing.TrustLong
}

func (d *Agent) confirmTransfer(o node.TransferOffer) (bool, string) {
	dir, _ := d.downloadDir.Load().(string)

	// 已配对的长期设备默认自动接收；临时设备一律逐次问。
	// 这条区分是"别人的设备"这个概念真正落地的地方。
	tid := hex.EncodeToString(o.TransferID)
	if d.shouldAutoAccept(o.From) {
		if p, err := d.store.GetPeer(o.From); err == nil {
			d.emit("transfer", map[string]any{
				"kind": "start", "direction": "recv",
				"transfer_id": tid,
				"device_id":   o.From, "device_name": p.Name,
				"name": o.Name, "size": o.TotalSize, "files": o.FileCount,
			})
			return true, dir
		}
	}

	// 文件夹里每个文件是一次 offer，但用户只做一个决定：第一个文件去问，同文件夹其余文件跟随它的答案，
	// 不各自弹框。
	if o.Kind == "folder" && o.Name != "" {
		return d.confirmFolder(o, tid, dir)
	}
	return d.askTransfer(o, tid, dir)
}

// confirmFolder 让同一设备的同一个文件夹只问一次。
func (d *Agent) confirmFolder(o node.TransferOffer, tid, defDir string) (bool, string) {
	key := o.From + "\x00" + o.Name
	now := time.Now()

	d.folderMu.Lock()
	if d.folderDec == nil {
		d.folderDec = make(map[string]*folderDecision)
	}
	if dec, ok := d.folderDec[key]; ok && (dec.until.IsZero() || now.Before(dec.until)) {
		d.folderMu.Unlock()
		<-dec.done // 还在等用户答复就一起等；已有结论则立刻通过
		d.folderMu.Lock()
		accept, dir := dec.accept, dec.dir
		if accept {
			dec.until = time.Now().Add(folderAcceptTTL)
		}
		d.folderMu.Unlock()
		return accept, dir
	}
	// 顺手清掉过期的结论，免得这张表只增不减。
	for k, dec := range d.folderDec {
		if !dec.until.IsZero() && now.After(dec.until) {
			delete(d.folderDec, k)
		}
	}
	dec := &folderDecision{done: make(chan struct{})}
	d.folderDec[key] = dec
	d.folderMu.Unlock()

	accept, dir := d.askTransfer(o, tid, defDir)

	d.folderMu.Lock()
	dec.accept, dec.dir = accept, dir
	if accept {
		dec.until = time.Now().Add(folderAcceptTTL)
	} else {
		dec.until = time.Now().Add(folderRejectTTL)
	}
	d.folderMu.Unlock()
	close(dec.done)
	return accept, dir
}

// askTransfer 弹确认框问用户这次传输收不收。
func (d *Agent) askTransfer(o node.TransferOffer, tid, dir string) (bool, string) {
	name := o.From
	if p, err := d.store.GetPeer(o.From); err == nil {
		name = p.Name
	}
	reply, ok := d.ask("transfer_request", map[string]any{
		"transfer_id": tid,
		"device_id":   o.From, "device_name": name,
		"name": o.Name, "size": o.TotalSize, "files": o.FileCount,
	}, 2*time.Minute)
	if !ok {
		return false, ""
	}
	accept, _ := reply["accept"].(bool)
	if v := str(reply, "dest_dir"); v != "" {
		dir = v
	}
	return accept, dir
}

// ---------- 配对确认 ----------

func (d *Agent) confirmPair(r node.PairRequest) (bool, string, time.Duration) {
	reply, ok := d.ask("pair_request", map[string]any{
		"device_id":   r.DeviceID,
		"name":        r.Name,
		"type":        r.Type,
		"method":      string(r.Method),
		"fingerprint": r.Fingerprint,
		"sas_digits":  r.SAS.Digits,
		"sas_emoji":   r.SAS.Emoji,
		"incoming":    r.Incoming,
	}, 3*time.Minute)
	if !ok {
		// 超时按拒绝处理。配对是安全边界，超时默认放行是不可接受的。
		return false, pairing.TrustLong, 0
	}
	accept, _ := reply["accept"].(bool)
	mode := pairing.TrustLong
	if str(reply, "mode") == "temp" {
		mode = pairing.TrustTemp
	}
	ttl := time.Duration(num(reply, "ttl_sec")) * time.Second
	return accept, mode, ttl
}

// ask 发一个需要用户答复的事件，然后阻塞等 UI 调 *_respond。
func (d *Agent) ask(name string, data map[string]any, timeout time.Duration) (map[string]any, bool) {
	id := fmt.Sprintf("req-%d", d.pendSeq.Add(1))
	ch := make(chan map[string]any, 1)

	d.pendMu.Lock()
	d.pending[id] = ch
	d.pendMu.Unlock()

	data["request_id"] = id
	d.emit(name, data)

	select {
	case reply := <-ch:
		return reply, true
	case <-time.After(timeout):
		d.pendMu.Lock()
		delete(d.pending, id)
		d.pendMu.Unlock()
		d.emit(name+"_timeout", map[string]any{"request_id": id})
		return nil, false
	}
}

func (d *Agent) onNodeEvent(e node.Event) {
	switch e.Kind {
	case "state":
		d.emit("state", map[string]any{
			"device_id": e.DeviceID,
			"state":     string(e.State),
			"devices":   d.devices(),
		})
	case "transfer":
		m := map[string]any{"kind": "recv_update", "device_id": e.DeviceID, "message": e.Msg}
		// code 让界面用自己的语言说这句话。Msg 是中文日志，直接显示出来
		// 等于把六种语言写死成一种（"已有相同文件，无需传输"就这么漏出去过）。
		if e.Code != "" {
			m["code"] = e.Code
		}
		if e.Xfer != nil {
			m["transfer_id"] = e.Xfer.ID
			m["item_kind"] = e.Xfer.Kind
			if e.Xfer.Name != "" {
				m["name"] = e.Xfer.Name
			}
		}
		if e.Err != nil {
			m["kind"] = "error"
			m["error"] = e.Err.Error()
		} else if e.Path != "" {
			// 有 Path 表示文件已完整落地；单独给一个 kind，让平台层可靠接住"收完了、在这个路径上"（安卓据此把文
			// 件搬到用户选的目录）。
			m["kind"] = "recv_done"
			m["path"] = e.Path
			m["name"] = filepath.Base(e.Path)
		}
		d.emit("transfer", m)

	// 传输被暂停 / 继续 / 取消。对端按的也会走到这里——本机界面上那条进度
	// 必须跟着变成"已暂停"，否则用户看到的是一条不动的进度条，和卡死一样。
	case "xfer_state":
		if e.Xfer == nil {
			return
		}
		d.emit("xfer_state", map[string]any{
			"transfer_id": e.Xfer.ID, "device_id": e.Xfer.DeviceID,
			"device_name": e.Xfer.DeviceName, "direction": e.Xfer.Direction,
			"name": e.Xfer.Name, "item_kind": e.Xfer.Kind,
			"total": e.Xfer.Total, "state": e.Xfer.State,
		})
	// 对端播报了新的"我在干什么"。只推一个信号，完整列表让界面回头查一次——
	// 事件里塞完整列表的话，三台设备同时活跃时每次都要序列化三遍。
	case "continuity":
		d.emit("continuity", map[string]any{"device_id": e.DeviceID})
	// 剪贴板正文同步结束或检出因果冲突时只推信号，界面回头查 clip_sync_log / clip_conflicts 补细节（理
	// 由同 continuity：避免每次序列化完整历史）。
	case "clip_sync":
		d.emit("clip_sync", map[string]any{"device_id": e.DeviceID})
	case "clip_conflict":
		d.emit("clip_conflict", map[string]any{"device_id": e.DeviceID})
	case "clip_timeline":
		d.emit("clip_timeline", map[string]any{"device_id": e.DeviceID})
	case "clip_ack":
		m := map[string]any{"device_id": e.DeviceID}
		if lat, at, ok := d.n.ClipLatency(e.DeviceID); ok {
			m["latency_ms"] = lat.Milliseconds()
			m["at"] = at.UnixMilli()
		}
		d.emit("clip_ack", m)
	case "pair":
		d.emit("paired", map[string]any{"device_id": e.DeviceID, "devices": d.devices()})
	// 对端改了名字（或别的展示信息）。借 state 事件把列表带过去：界面和安卓端
	// 收到 state 只刷新列表，不会像 paired 那样收起配对面板、作废正在显示的短码。
	case "peer_updated":
		d.emit("state", map[string]any{
			"device_id": e.DeviceID,
			"state":     string(d.n.State(e.DeviceID)),
			"devices":   d.devices(),
		})
	case "error":
		msg := e.Msg
		if e.Err != nil {
			msg = e.Msg + ": " + e.Err.Error()
		}
		d.emit("notice", map[string]any{"device_id": e.DeviceID, "message": msg})
	}
}

// 身份持久化：种子存数据目录下，权限 0600，等同设备私钥。
// 不再套一层加密：解密密钥也得放同一台机器，只是挪位置；保护靠文件系统（用户配置目录，其他账户读不
// 到）。
// 注意守护进程不等金库解锁就启动（剪贴板同步和文件互传本就不依赖金库），锁定期间复制的内容照常同步
// ；
// 密码管理器类复制由桌面端的排除格式挡掉。

func loadOrCreateIdentity(dir, name string) (*identity.Identity, error) {
	p := filepath.Join(dir, "device.key")
	if b, err := os.ReadFile(p); err == nil {
		id, err := identity.RestoreFromRecoveryCode(strings.TrimSpace(string(b)), name, identity.TypePC)
		if err != nil {
			return nil, fmt.Errorf("设备身份文件已损坏: %w", err)
		}
		return id, nil
	}
	id, err := identity.New(name, identity.TypePC)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(p, []byte(id.ExportRecoveryCode()), 0o600); err != nil {
		return nil, err
	}
	log.Printf("已生成新的设备身份: %s", id.DeviceID())
	return id, nil
}

// ---------- 参数helpers ----------

func str(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

func num(m map[string]any, k string) int64 {
	switch v := m[k].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	}
	return 0
}

func strSlice(m map[string]any, k string) []string {
	raw, _ := m[k].([]any)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}
