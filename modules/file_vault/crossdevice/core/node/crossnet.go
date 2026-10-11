package node

import (
	"context"
	"errors"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/rendezvous"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// 跨网：让不在同一局域网的设备互相找到并连上。
// 1. 用监听用的那个套接字（core/transport 保证）连汇合点，服务器看到的源地址即公网映射。
// 2. 用 rendezvous 暗号（rendezvous.go，两把公钥 HKDF 推出，每 30 分钟轮换）挂牌，
//    服务器不知真实设备 ID，也无法长期追踪。
// 3. 对端挂同一暗号时，服务器互推地址并约定同时打洞的时刻。
// 4. 双方同时拨对方公网地址，各自路由器因"先往那边发过包"而开洞。
// 5. 打不通（对称 NAT、CGNAT）退到中继，服务器只搬 Noise 密文。
// 这些排在重连竞速的后几路（reconnect.go candidatesFor：路 4 延迟 800ms，路 5 延迟
// 2500ms），局域网先连上则被取消，不产生公网流量。服务器挂了这几路直接消失，局域网
// 照常工作：汇合点是加速手段，不能成为单点故障。

const (
	// crossnetAddrTTL 是从汇合点学到的公网地址的保鲜期。
	// 公网映射会随运营商 NAT 超时而失效，留太久只会让竞速白等一轮。
	crossnetAddrTTL = 3 * time.Minute

	// punchAttempts：单次打洞的拨号次数。两边的包要在各自 NAT 上"对穿"，先到的会被丢，
	// 靠后续补上；三次是常见取值。
	punchAttempts = 3

	// punchInterval 是这几次拨号之间的间隔。
	punchInterval = 250 * time.Millisecond

	// punchDialTimeout 是单次打洞拨号的超时。打洞要么很快成，要么根本不成，
	// 给太长只会拖住整条竞速。
	punchDialTimeout = 3 * time.Second
)

// crossnetPeer 是从汇合点学到的、关于某台对端的信息。
type crossnetPeer struct {
	addrs   []string
	seenAt  time.Time
	punchAt time.Time
}

// crossnetState 是跨网这一块的全部运行时状态。
type crossnetState struct {
	client *rendezvous.Client

	mu    sync.RWMutex
	peers map[string]crossnetPeer // deviceID -> 学到的地址

	// punching 防止对同一台设备同时开多轮打洞。
	punchMu  sync.Mutex
	punching map[string]bool

	// wake 用来把"立刻重新挂一遍牌"的请求送进挂牌循环。
	// 容量 1 + 非阻塞写入 = 合并掉短时间内的重复请求。
	wake chan struct{}
}

// RelayAvailable 报告中继是否可用。
func (c *crossnetState) RelayAvailable() bool {
	return c != nil && c.client != nil && c.client.RelayAvailable()
}

// xnet 取当前的跨网状态。没启用时返回 nil，调用方一律先判空。
func (n *Node) xnet() *crossnetState { return n.crossnet.Load() }

// SetMetered 由平台侧告知当前网络是否按流量计费，未调用时按不计费（桌面端）。
// 跨网会自动花用户流量：计量网络下后台重连会连汇合点，中继还会把整个文件过一遍公网。
// 所以计量网络默认不自动走中继，由用户显式打开；打洞直连仍允许（等同用户点"发送"）。
func (n *Node) SetMetered(metered bool) {
	n.metered.Store(metered)
}

// Metered 报告当前网络是否按流量计费。
func (n *Node) Metered() bool { return n.metered.Load() }

// SetRelayOnMetered 设置"计量网络下是否也允许走中继"。默认否。
func (n *Node) SetRelayOnMetered(allow bool) { n.relayOnMetered.Store(allow) }

// RelayOnMetered 报告当前策略。
func (n *Node) RelayOnMetered() bool { return n.relayOnMetered.Load() }

// relayAllowedNow 综合"中继可不可用"和"现在这张网准不准用中继"。
func (n *Node) relayAllowedNow() bool {
	if !n.xnet().RelayAvailable() {
		return false
	}
	if n.metered.Load() && !n.relayOnMetered.Load() {
		return false
	}
	return true
}

// SetRendezvous 运行中热切换汇合点（addr 空串 = 关闭跨网），免得改设置后要重启才生效。
// 已建立的会话不受影响；走中继的那条断开后按新配置重连。
func (n *Node) SetRendezvous(addr, secret string) {
	n.rvMu.Lock()
	if n.rvAddr == addr && n.rvSecret == secret {
		// 没变就别折腾——设置页每次保存都会调过来，白重连一次汇合点
		// 只会让本来挂好的牌全断一遍。
		n.rvMu.Unlock()
		return
	}
	n.rvAddr, n.rvSecret = addr, secret
	n.rvMu.Unlock()

	if old := n.crossnet.Swap(nil); old != nil && old.client != nil {
		_ = old.client.Close()
	}
	n.startCrossnet()
}

// startCrossnet 启动跨网。汇合点地址为空时整块功能不启用，直接返回。
func (n *Node) startCrossnet() {
	n.rvMu.Lock()
	addr, secret := n.rvAddr, n.rvSecret
	n.rvMu.Unlock()

	client := rendezvous.NewClient(rendezvous.ClientConfig{
		ServerAddr:     addr,
		Secret:         secret,
		DeviceID:       n.id.DeviceID(),
		SignPriv:       n.id.SignPriv,
		SignPub:        n.id.SignPub,
		Dialer:         n.ln,
		LocalEndpoints: n.crossnetLocalEndpoints,
		OnPeer:         n.onCrossnetPeer,
		Logger:         n.cfg.Logger,
	})
	if client == nil {
		n.logf("跨网未启用（没有配置汇合点服务器），只走局域网")
		return
	}
	cn := &crossnetState{
		client:   client,
		peers:    make(map[string]crossnetPeer),
		punching: make(map[string]bool),
		wake:     make(chan struct{}, 1),
	}
	n.crossnet.Store(cn)
	n.logf("跨网已启用，汇合点 %s", addr)

	n.wg.Add(1)
	go n.crossnetLoop(cn)
}

// crossnetLoop 维护挂牌，由两条驱动共同保证，缺一不可：
// 定时——暗号每 30 分钟轮换（rendezvousWindow），不跟着换则两边挂的是不同的牌；
// 唤醒——启动时尚无配对设备首轮为空，配对成功/重连/换网都不触发刷新，会干等整个周期。
// cn 是启动本轮循环时的状态，不能在循环里重新取：SetRendezvous 换状态后旧循环须认自己
// 那份并退出，否则新旧两个循环同时往同一客户端挂牌。
func (n *Node) crossnetLoop(cn *crossnetState) {
	defer n.wg.Done()
	t := time.NewTicker(rendezvousScanEvery)
	defer t.Stop()

	n.refreshCrossnetWatches()
	for {
		if n.xnet() != cn {
			return // 汇合点已经被换掉了，这一轮循环该退休了
		}
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
			n.refreshCrossnetWatches()
		case <-cn.wake:
			n.refreshCrossnetWatches()
		}
	}
}

// wakeCrossnet 请求立刻重挂牌。非阻塞：调用方可能持有锁，绝不能在这里等。
func (n *Node) wakeCrossnet() {
	cn := n.xnet()
	if cn == nil {
		return
	}
	select {
	case cn.wake <- struct{}{}:
	default:
	}
}

// refreshCrossnetWatches 只为还没连上的对端挂牌：每个暗号在服务器上占一条流。
func (n *Node) refreshCrossnetWatches() {
	cn := n.xnet()
	if cn == nil {
		return
	}
	now := time.Now()
	self := n.id.DHPub[:]
	w := currentRendezvousWindow(now)

	for _, p := range n.store.ListPeers() {
		if len(p.DHPub) == 0 || !p.Usable(now) {
			continue
		}
		// 当前窗口和上一个窗口都挂上：跨窗那一刻两台设备的时钟不可能完全一致，
		// 只挂当前窗口的话边界附近会出现一段谁也找不到谁的空窗。
		for _, win := range []int64{w, w - 1} {
			token := rendezvousToken(self, p.DHPub, win)
			if token == "" {
				continue
			}
			if st := n.State(p.DeviceID); st == StateConnected || st == StateDegraded {
				cn.client.Unwatch(token)
				continue
			}
			cn.client.Watch(token)
		}
	}
}

// onCrossnetPeer 是汇合点推送"对端出现"的回调。不能信任推送里的 device_id：知道两把
// 公钥的旁观者也能算出同一暗号并抢答。这里只记地址去尝试连接，把关在 Noise 握手。
func (n *Node) onCrossnetPeer(token string, pf rendezvous.PeerFound) {
	cn := n.xnet()
	if cn == nil {
		return
	}
	deviceID := n.peerForToken(token)
	if deviceID == "" {
		// 这个暗号不对应本机认识的任何设备。多半是暗号刚好换了窗，
		// 或者有人在瞎撞。忽略即可。
		return
	}

	addrs := make([]string, 0, len(pf.Endpoints))
	for _, e := range pf.Endpoints {
		a := strings.TrimSpace(e.Addr)
		if a == "" || !n.dialableAddr(a) {
			continue
		}
		addrs = append(addrs, a)
	}
	if len(addrs) == 0 {
		n.logf("跨网：%s 报来的地址一条都拨不通（%v），只能走中继", shortID(deviceID), pf.Endpoints)
		return
	}

	punchAt := time.Now()
	if pf.PunchAt > 0 {
		punchAt = time.UnixMilli(pf.PunchAt)
	}
	cn.mu.Lock()
	cn.peers[deviceID] = crossnetPeer{addrs: addrs, seenAt: time.Now(), punchAt: punchAt}
	cn.mu.Unlock()

	n.logf("跨网：发现 %s 在公网上的地址 %v", shortID(deviceID), addrs)

	// 立刻开打洞，别等下一轮重连退避——对端此刻正好也在打，错过这个时间窗
	// 双方的 NAT 映射可能就换了。
	go n.punch(deviceID, addrs, punchAt)

	// 同时唤醒常规重连循环，让竞速把这些新地址用起来。
	n.KeepConnected(deviceID)
}

// peerForToken 反查暗号属于哪台设备：遍历对端列表重算比对，不另维护要随时间窗过期的映射表。
func (n *Node) peerForToken(token string) string {
	now := time.Now()
	self := n.id.DHPub[:]
	w := currentRendezvousWindow(now)
	for _, p := range n.store.ListPeers() {
		if len(p.DHPub) == 0 {
			continue
		}
		for _, win := range []int64{w, w - 1} {
			if rendezvousToken(self, p.DHPub, win) == token {
				return p.DeviceID
			}
		}
	}
	return ""
}

// punch 执行同时打洞：双方在约定时刻各向对方公网地址拨号。先到的包多半被对方 NAT
// 丢弃，但已在己侧 NAT 开洞，对方随后的包即可进入；多次拨号是为覆盖时钟不齐。
// 这是 WebRTC ICE / libp2p DCUtR 的标准做法。
func (n *Node) punch(deviceID string, addrs []string, at time.Time) {
	cn := n.xnet()
	if cn == nil {
		return
	}
	cn.punchMu.Lock()
	if cn.punching[deviceID] {
		cn.punchMu.Unlock()
		return
	}
	cn.punching[deviceID] = true
	cn.punchMu.Unlock()
	defer func() {
		cn.punchMu.Lock()
		delete(cn.punching, deviceID)
		cn.punchMu.Unlock()
	}()

	// 对表：等到服务器约定的时刻再动手，两边才是"同时"。
	if d := time.Until(at); d > 0 && d < 5*time.Second {
		select {
		case <-n.ctx.Done():
			return
		case <-time.After(d):
		}
	}

	peer, err := n.store.GetPeer(deviceID)
	if err != nil {
		return
	}

	for i := 0; i < punchAttempts; i++ {
		if n.ctx.Err() != nil {
			return
		}
		if st := n.State(deviceID); st == StateConnected || st == StateDegraded {
			return // 已经连上了，不用再打
		}
		for _, addr := range addrs {
			ctx, cancel := context.WithTimeout(n.ctx, punchDialTimeout)
			sess, err := n.dialAndHandshake(ctx, peer, addr, viaHolePunch)
			cancel()
			if err == nil && sess != nil {
				n.logf("跨网：与 %s 打洞成功，直连 %s", peer.Name, addr)
				return
			}
		}
		select {
		case <-n.ctx.Done():
			return
		case <-time.After(punchInterval):
		}
	}
	n.logf("跨网：与 %s 打洞未成功，将退到中继", peer.Name)
}

// crossnetAddrs 返回某台对端在公网上的地址（供重连竞速的路 4 使用）。
func (n *Node) crossnetAddrs(deviceID string) []string {
	cn := n.xnet()
	if cn == nil {
		return nil
	}
	cn.mu.RLock()
	defer cn.mu.RUnlock()
	p, ok := cn.peers[deviceID]
	if !ok || time.Since(p.seenAt) > crossnetAddrTTL {
		return nil
	}
	return append([]string(nil), p.addrs...)
}

// dialViaRelay 走中继建会话。服务器只转发 Noise 密文，无密钥；上层无感知，
// 仅 Session.via 记录"中继转发"供界面如实提示。
func (n *Node) dialViaRelay(ctx context.Context, peer *store.Peer) (*Session, error) {
	cn := n.xnet()
	if cn == nil || cn.client == nil {
		return nil, errors.New("跨网未启用")
	}
	token := rendezvousToken(n.id.DHPub[:], peer.DHPub, currentRendezvousWindow(time.Now()))
	if token == "" {
		return nil, errors.New("算不出暗号（对端公钥缺失）")
	}

	// 两端必须恰好一个发起方，否则互等死锁或双方同时发起致握手错乱。按 device_id 字典序，
	// 小者发起，两边独立算出结果一致，无需协商。
	initiator := n.id.DeviceID() < peer.DeviceID

	rw, err := cn.client.RelayDial(ctx, token, initiator)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = rw.Close()
		}
	}()

	if !initiator {
		// 中继这条路上没有"谁拨谁"的概念，所以由字典序小的一端当发起方。
		// 本端不是发起方时，走应答者流程等对方握手过来。
		sess, err := n.handshakeResponderOver(ctx, rw)
		if err != nil {
			return nil, err
		}
		ok = true
		return sess, nil
	}

	sess, err := n.handshakeOver(ctx, peer, rw, relayCarrier{rw: rw}, viaRelay)
	if err != nil {
		return nil, err
	}
	if sess.carrier != (relayCarrier{rw: rw}) {
		// 输了同时互拨的决胜，安静退出，把已有那条还给调用方。
		return sess, nil
	}
	ok = true
	go sess.run()
	return sess, nil
}

// crossnetLocalEndpoints 收集本机地址交给汇合点。带上内网地址是因为两台设备可能同在
// 局域网而 mDNS 被路由器丢了（企业 Wi-Fi、AP 隔离），这时可直接接通局域网直连。
func (n *Node) crossnetLocalEndpoints() []rendezvous.Endpoint {
	addrs := n.LocalEndpoints()
	out := make([]rendezvous.Endpoint, 0, len(addrs))
	for _, a := range addrs {
		if n.dialableAddr(a) {
			out = append(out, rendezvous.Endpoint{Addr: a, Kind: "lan"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Addr < out[j].Addr })
	return out
}

// dialableAddr 挡掉明显拨不通的地址，省得白占一路竞速去等超时。
func (n *Node) dialableAddr(a string) bool {
	host, port, err := net.SplitHostPort(a)
	if err != nil || port == "" || port == "0" {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host != "" // 域名形式，交给解析器
	}
	if ip.IsUnspecified() {
		return false
	}
	if ip.IsLoopback() {
		// 对端报来的 127.0.0.1 指的是它自己那台机器，拨过去只会连到本机。
		// 只有测试（两个节点跑在同一台机器上）才需要放行，见 Config 的说明。
		return n.cfg.AllowLoopbackPeers
	}
	// 没有 zone id 的链路本地 IPv6 连不上，收下来只会浪费一路竞速。
	return !ip.IsLinkLocalUnicast()
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
