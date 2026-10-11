package node

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/netif"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/transport"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

// 退避阶梯。任何网络事件（换 Wi-Fi、屏幕点亮、mDNS 扫到对端）都让退避归零重来，
// "感觉快"靠这个而非调小间隔。上限压到 15 秒（原 60 秒）：发现层常驻监听
// （discovery.browseLoop），对端上线通告会毫秒级唤醒重连，退避只覆盖对端确实没回来的空窗。
// 头三档都在一秒内：多数断连是瞬时的，一两次重试就能接上。
var backoffSteps = []time.Duration{
	200 * time.Millisecond,
	400 * time.Millisecond,
	800 * time.Millisecond,
	1500 * time.Millisecond,
	3 * time.Second,
	6 * time.Second,
	10 * time.Second,
	15 * time.Second,
}

// candidate 是一条待尝试的连接路径。delay 是分级启动延迟：路 1/2 几乎零成本且命中率最高，
// 立即发；后面几路有代价（广播扰民、耗电、占服务器配额），延后发，多数情况走不到。
type candidate struct {
	addr  string
	delay time.Duration
	via   string

	// dial 非空时代替"按 addr 直连"。中继那路没有可拨地址（是到汇合点开转发流），
	// 所以候选须能自带拨号方式。
	dial func(context.Context) (*Session, error)
}

// Connect 连接一台已配对设备，多路径并行竞速，第一条成功的立即启用。
func (n *Node) Connect(ctx context.Context, deviceID string) (*Session, error) {
	if s, ok := n.SessionFor(deviceID); ok && s.Alive() {
		// 已连上（多半对方先拨过来）。必须把状态改回 CONNECTED：互拨决胜中输掉的那条会唤醒重连
		// 循环并置为 RECONNECTING，而另一条其实连着，不修则 UI 一直显示"重连中"。
		n.setState(deviceID, StateConnected)
		return s, nil
	}
	// 上面必须查 Alive()：会话关闭后要等 run() 的 defer 才从 map 摘除，此窗口内当"已连接"
	// 返回的话，KeepConnected 会从已关闭的 Done() 立刻返回并再拿到同一具尸体，满速空转，
	// 且 UI 一直显示"已连接"。
	peer, err := n.store.GetPeer(deviceID)
	if err != nil {
		return nil, err
	}
	if !peer.Usable(time.Now()) {
		n.setState(deviceID, StateRevoked)
		return nil, &ConnectError{Code: OfflineRevoked, Err: fmt.Errorf("设备 %s 已撤销或授权到期", peer.Name)}
	}

	n.setState(deviceID, StateConnecting)
	cands := n.candidatesFor(peer)
	if len(cands) == 0 {
		n.setState(deviceID, StateDisconnected)
		code := OfflineNotFoundCrossnet
		switch {
		case n.xnet() == nil:
			code = OfflineNotFound
		case n.Metered() && !n.RelayOnMetered():
			code = OfflineMetered
		}
		return nil, &ConnectError{Code: code, Err: n.noRouteError(peer)}
	}

	sess, err := n.race(ctx, peer, cands)
	if err != nil {
		n.setState(deviceID, StateDisconnected)
		return nil, err
	}
	return sess, nil
}

// candidatesFor 组装候选路径，按命中率排序。
func (n *Node) candidatesFor(peer *store.Peer) []candidate {
	var out []candidate
	seen := map[string]bool{}

	add := func(addr string, delay time.Duration, via string) {
		if addr == "" || seen[addr] {
			return
		}
		seen[addr] = true
		out = append(out, candidate{addr: addr, delay: delay, via: via})
	}

	// 路 1：上次成功的地址。实测这条命中率最高，所以零延迟且排第一。
	add(peer.LastGoodAddr, 0, viaCachedLAN)
	// 路 2：历史地址（设备常在家/公司几个网络间移动）。
	for _, a := range peer.CachedAddrs {
		add(a, 0, viaHistory)
	}
	// 路 3：mDNS 当前发现的地址，专治缓存失效（对端换 Wi-Fi、DHCP 重发、换网段后前两路的
	// 地址全废）。给 150ms 启动延迟：缓存地址那两路命中率高，多半在这路发车前就握完手。
	if n.disc != nil {
		for _, a := range n.disc.AddrsFor(peer.DeviceID) {
			add(a, 150*time.Millisecond, viaDiscovery)
		}
	}

	// 路 4：跨网，对端此刻的公网地址（由汇合点交换）。800ms 延迟有依据：前三路是局域网直连，
	// 正常 100ms 内握完手，到 800ms 还没成才说明大概率不在同一网络；在家使用时这路永不发车，
	// 不会有包打到公网。
	for _, a := range n.crossnetAddrs(peer.DeviceID) {
		add(a, 800*time.Millisecond, viaHolePunch)
	}

	// 路 5：中继，打洞不通时经汇合点转发密文。没有可拨地址，用自定义拨号；2500ms 起步是
	// 刻意保守，中继耗服务器带宽。用 relayAllowedNow 而非 RelayAvailable：计量网络（手机
	// 流量）默认不走中继，自动重连也会走这条，会静默耗流量。见 SetMetered。
	if n.relayAllowedNow() {
		out = append(out, candidate{
			delay: 2500 * time.Millisecond,
			via:   viaRelay,
			dial:  func(ctx context.Context) (*Session, error) { return n.dialViaRelay(ctx, peer) },
		})
	}
	return out
}

// noRouteError 解释"一条路都没有"并给出下一步。用户分不清是对方没开机、不在同一网络、
// 跨网没配还是软件坏了，而四种情况要做的事不同。
func (n *Node) noRouteError(peer *store.Peer) error {
	crossnetOn := n.xnet() != nil
	switch {
	case !crossnetOn:
		return fmt.Errorf("找不到 %s。它需要和本机连同一个 Wi-Fi。"+
			"如果它现在在外面（用手机流量、或在别的网络里），"+
			"要先在「跨网络连接」里填一个中转点地址才能连上", peer.Name)
	case n.Metered() && !n.RelayOnMetered():
		// 这一条必须单独说清楚。否则用户看到的是"连 Wi-Fi 就好、开流量就不行"，
		// 完全像个 bug，而实际上是我们按默认策略主动省了他的流量。
		return fmt.Errorf("找不到 %s。当前是按流量计费的网络，已自动跳过中转"+
			"（中转会把整个文件过一遍公网，很费流量）。"+
			"接上 Wi-Fi 就能连，或者在设置里允许用流量中转", peer.Name)
	default:
		return fmt.Errorf("找不到 %s。局域网里没有发现它，中转点那边也还没看到它上线。"+
			"确认对方设备开着 Tessera，并且两台设备填的是同一个中转点地址", peer.Name)
	}
}

// attemptFailure 记一条候选路径的失败，用来拼出说得清的诊断。
type attemptFailure struct {
	via  string
	addr string
	err  error
}

// explainFailures 把每条路的失败拼成用户看得懂的话。只报"所有路径均不可达"只会让用户
// 反复重试，而真因可能是"跨网没配"，重试无用。
func explainFailures(peer *store.Peer, fails []attemptFailure) error {
	if len(fails) == 0 {
		return fmt.Errorf("连不上 %s：所有路径都没有响应", peer.Name)
	}
	// 同一条路可能有多个地址（好几个历史地址），按路合并，
	// 否则一台多网卡设备会刷出七八行几乎一样的话。
	seen := map[string]bool{}
	parts := make([]string, 0, len(fails))
	for _, f := range fails {
		label := f.via
		if label == "" {
			label = "未知路径"
		}
		if seen[label] {
			continue
		}
		seen[label] = true
		parts = append(parts, label+"（"+shortReason(f.err)+"）")
	}
	return fmt.Errorf("连不上 %s，试过这几条路都不通：%s",
		peer.Name, strings.Join(parts, "、"))
}

// shortReason 把底层报错翻成人话：英文 "connection refused"/"i/o timeout" 对用户无意义，
// 却是判断怎么办的关键（拒绝 = 对方在但没开软件，超时 = 不在这个网）。
func shortReason(err error) string {
	if err == nil {
		return "没有响应"
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "refused"):
		return "对方在这个地址上，但没有在监听——多半是软件没运行"
	case strings.Contains(s, "timeout") || strings.Contains(s, "deadline exceeded"):
		return "超时，对方多半已经不在这个网络里了"
	case strings.Contains(s, "no route") || strings.Contains(s, "unreachable"):
		return "网络不可达"
	case strings.Contains(s, "跨网未启用"):
		return "没有配置中转点"
	case strings.Contains(s, "中继被拒绝"):
		return "中转点拒绝了这次转发"
	case strings.Contains(s, "握手失败"):
		return "连上了但身份校验没过，可能需要重新配对"
	default:
		return s
	}
}

// race 并行尝试所有候选路径，第一条完成握手的胜出，其余立即取消。
func (n *Node) race(ctx context.Context, peer *store.Peer, cands []candidate) (*Session, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	type result struct {
		sess *Session
		via  string
		addr string
		err  error
	}
	results := make(chan result, len(cands))
	var wg sync.WaitGroup

	for _, c := range cands {
		wg.Add(1)
		go func(c candidate) {
			defer wg.Done()
			if c.delay > 0 {
				select {
				case <-time.After(c.delay):
				case <-ctx.Done():
					return
				}
			}
			var sess *Session
			var err error
			if c.dial != nil {
				sess, err = c.dial(ctx)
			} else {
				sess, err = n.dialAndHandshake(ctx, peer, c.addr, c.via)
			}
			select {
			case results <- result{sess: sess, via: c.via, addr: c.addr, err: err}:
			case <-ctx.Done():
				if sess != nil {
					sess.close(errors.New("竞速已有胜者"))
				}
			}
		}(c)
	}

	go func() { wg.Wait(); close(results) }()

	// 收集每一条路的失败而非只留最后一个，否则报出的往往是延迟最久、最不相关的中继，
	// 真正说明问题的（如"局域网里根本没发现它"）被覆盖。
	fails := make([]attemptFailure, 0, len(cands))
	for r := range results {
		if r.err != nil {
			fails = append(fails, attemptFailure{via: r.via, addr: r.addr, err: r.err})
			continue
		}
		// 有胜者了：取消上下文，其余尝试会自行退出并关闭各自的连接。
		cancel()
		n.logf("已连接 %s（经由 %s）", peer.Name, r.via)
		return r.sess, nil
	}
	return nil, &ConnectError{Code: failuresCode(fails), Err: explainFailures(peer, fails)}
}

// 连接是靠哪条路建起来的。只用于展示与诊断，不影响协议行为。
const (
	viaInbound   = "对方拨入"
	viaCachedLAN = "缓存地址"
	viaHistory   = "历史地址"
	viaDiscovery = "局域网发现"
	viaHolePunch = "公网直连"
	viaRelay     = "中继转发"
)

// dialAndHandshake 建立一条直连并完成 Noise_IK 握手。
func (n *Node) dialAndHandshake(ctx context.Context, peer *store.Peer, addr, via string) (*Session, error) {
	// 局域网直连先试 TCP：大文件可跑满网线，而 QUIC 在 Windows 上被每包一次系统调用钉在
	// 40~50 MiB/s（见 tcpcarrier.go）。公网打洞出的地址是 UDP 的 NAT 映射，TCP 打不进，直接 QUIC。
	if via != viaHolePunch && n.tcpUsable(peer.DeviceID) {
		sess, err := n.dialTCPAndHandshake(ctx, peer, addr, via)
		if err == nil {
			n.clearTCPFailure(peer.DeviceID)
			return sess, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
		// 对端是旧版本（拒绝连接）或防火墙丢了包：记一笔，回落到 QUIC。
		n.noteTCPFailure(peer.DeviceID)
	}

	// 必须从本机监听的那个套接字拨出去，不能另开一个（原因见 core/transport 头部）。
	conn, err := n.ln.Dial(ctx, addr)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.CloseWithError(0, "")
		}
	}()

	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, err
	}
	sess, err := n.handshakeOver(ctx, peer, transport.StreamRW{Stream: stream},
		quicCarrier{conn: conn}, via)
	if err != nil {
		return nil, err
	}
	if sess.carrier != (quicCarrier{conn: conn}) {
		// 输了同时互拨的决胜：关掉这条新连接，把已有那条返回给调用方。
		// 对调用方而言"我要连上 X"这个诉求已经满足了，不该报错。
		_ = conn.CloseWithError(0, "duplicate connection")
		return sess, nil
	}
	ok = true
	n.store.RememberAddr(peer.DeviceID, addr)
	go sess.run()
	return sess, nil
}

// handshakeOver 在已建好的双向字节流上完成 Noise_IK 握手并建会话。流来源有两种
// （直连 QUIC 流 / 中继流），对 Noise 等价，中继只见密文。
// 调用方负责决胜判断（sess.carrier 是否为自己传入的）和 sess.run()，因为中继路输了
// 决胜时的清理与直连不同。
func (n *Node) handshakeOver(ctx context.Context, peer *store.Peer, rw io.ReadWriteCloser, car carrier, via string) (*Session, error) {
	if _, err := rw.Write([]byte{modeNormal}); err != nil {
		return nil, err
	}

	n.setState(peer.DeviceID, StateAuthenticating)

	var peerStatic [32]byte
	copy(peerStatic[:], peer.DHPub)

	// IK 的 0.5-RTT：HELLO 直接塞进握手第一条消息，
	// 对端一收到就知道我是谁、我收到哪条了，不用再来一轮。
	hello, err := wire.Marshal(n.helloMsg(peer.LastRecv))
	if err != nil {
		return nil, err
	}
	prologue := crypto.Prologue(wire.ProtoName, "", peer.DeviceID)
	res, err := crypto.HandshakeIKInitiator(rw,
		crypto.StaticKey(n.id.DHPriv, n.id.DHPub), peerStatic[:], prologue, hello)
	if err != nil {
		return nil, fmt.Errorf("握手失败: %w", err)
	}

	var peerHello wire.Hello
	if err := wire.Unmarshal(res.PeerPayload, &peerHello); err != nil {
		return nil, fmt.Errorf("对端 HELLO 无法解析: %w", err)
	}
	if peerHello.DeviceID != peer.DeviceID {
		// 公钥对得上但 ID 对不上，说明本地记录与实际不一致，不能继续。
		return nil, fmt.Errorf("对端身份不符：期望 %s，实际 %s", peer.DeviceID, peerHello.DeviceID)
	}

	sc := crypto.NewSecureConn(rw, res)
	if err := n.maybeUpgradeHybrid(sc, peerHello, true); err != nil {
		return nil, err
	}
	return n.newSession(peer, car, via, sc, true, peerHello.ProtoFeature), nil
}

// KeepConnected 后台保持与某设备的连接，断开即重连、带随机抖动的退避（防多设备惊群），
// 收到 NetworkChanged 立即重置退避。同一设备只有一个保活循环，重复调用直接返回
// （见 Node.keepers）。
func (n *Node) KeepConnected(deviceID string) {
	if deviceID == "" {
		return
	}
	// "我想连上这台设备"就是"该去汇合点挂牌找它"的时刻。光靠定时刷新的话，
	// 刚配对完的设备最长要干等一整个刷新周期才开始被跨网寻找。
	n.wakeCrossnet()

	n.keepMu.Lock()
	if _, running := n.keepers[deviceID]; running {
		n.keepMu.Unlock()
		// 已经有循环在跑了。但调用方多半是"刚刚配对成功，希望马上连上"，
		// 所以踢一脚让退避中的那个循环立刻重试，而不是干等它把退避走完。
		n.wakeReconnect()
		return
	}
	n.keepers[deviceID] = struct{}{}
	n.keepMu.Unlock()

	n.wg.Add(1)
	go func() {
		defer n.wg.Done()
		defer func() {
			n.keepMu.Lock()
			delete(n.keepers, deviceID)
			n.keepMu.Unlock()
		}()
		attempt := 0
		for {
			select {
			case <-n.ctx.Done():
				return
			default:
			}

			peer, err := n.store.GetPeer(deviceID)
			if err != nil || !peer.Usable(time.Now()) {
				// 临时设备到期后不再自动重连——这是与长期设备的关键区别。
				n.setState(deviceID, StateRevoked)
				return
			}

			// 唤醒信号必须在拨号之前取：拨号竞速最长十几秒，期间对端上线发出的唤醒若落在拨号中，
			// 拨号后再取就是新 channel，唤醒丢失，只能干等退避。
			wake := n.netChanged(deviceID)
			sess, err := n.Connect(n.ctx, deviceID)
			if err == nil {
				attempt = 0
				select {
				case <-sess.Done():
					n.setState(deviceID, StateReconnecting)
					continue // 断开后立刻重来，不等退避
				case <-n.ctx.Done():
					return
				}
			}
			n.noteConnectFailure(deviceID, err)

			d := backoffSteps[minInt(attempt, len(backoffSteps)-1)]
			// ±20% 抖动：多台设备同时掉线时避免它们在同一毫秒一起重连。
			d = time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
			attempt++

			select {
			case <-time.After(d):
			case <-wake:
				attempt = 0 // 网络变了或刚看到对端，立即重试
				// 留一点点间隔：唤醒可能成串到达（一次扫描里每台设备各唤醒一次），
				// 失败得很快的拨号（对方拒绝）不该因此变成满速空转。
				select {
				case <-time.After(backoffSteps[0]):
				case <-n.ctx.Done():
					return
				}
			case <-n.ctx.Done():
				return
			}
		}
	}()
}

// NetworkChanged 由平台层在网络切换时调用（NetworkCallback、NotifyAddrChange、屏幕点亮、
// 睡眠恢复等），唤醒所有退避中的重连循环立刻重试。
func (n *Node) NetworkChanged() {
	n.netWatchSync()
	n.wakeReconnect()
	// 已有会话多半绑在刚消失的路上（旧 Wi-Fi 地址、休眠前的 NAT 映射），不报错只是收不到东西，
	// 要心跳丢三次（约 30 秒）才判死。这里立即各探一次，几秒无回音就断开，让重连换路。
	for _, s := range n.Sessions() {
		go s.probeLiveness(networkProbeTimeout)
	}

	// 换了网之后缓存地址基本全废，必须让发现层立刻重新扫一轮，
	// 否则竞速的三路里有两路注定超时，白等。
	if n.disc != nil {
		n.disc.Refresh()
	}
	// 跨网这边同样要重来：旧连接绑在已经消失的接口上不会报错、只是再也收不到
	// 推送，而本机的公网地址在换网之后必定变了，不重新报到就等于挂了个废地址。
	if cn := n.xnet(); cn != nil && cn.client != nil {
		cn.client.NetworkChanged()
		n.wakeCrossnet()
	}
	n.logf("检测到网络变化，立即触发重连检查")
}

// wakeReconnect 只唤醒退避中的重连循环，不碰发现层。必须与 NetworkChanged 分开：
// 发现层扫到设备也要唤醒重连，若走 NetworkChanged 会"扫到→清缓存重扫→又扫到"自激，
// mDNS 被自己刷爆。
func (n *Node) wakeReconnect() {
	n.netMu.Lock()
	old := n.netSignal
	n.netSignal = make(chan struct{})
	n.netMu.Unlock()
	close(old)
}

func (n *Node) netChanged(string) <-chan struct{} {
	n.netMu.RLock()
	defer n.netMu.RUnlock()
	return n.netSignal
}

// ---------- 本机地址 ----------

// localEndpoints 收集本机可被连接的地址供二维码与 mDNS 用。私有网段地址排前：二维码最多
// 放 3 个，VMware/WSL/Docker 虚拟网卡会挤掉真正可用的。走 netif 而非 net.Interfaces()：
// 安卓 11+ 后者 permission denied，会让「手动输入地址」和配对码里都没有可连地址
// （详见 core/netif）。
func localEndpoints(port int) []string {
	type scored struct {
		addr  string
		score int
	}
	var out []scored
	for _, ifi := range netif.Usable() {
		for _, ipn := range ifi.IPNets() {
			ip := ipn.IP
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
				continue
			}
			v4 := ip.To4()
			score := 0
			switch {
			case v4 != nil && ip.IsPrivate():
				score = 100 // 家用/办公局域网，最可能连通
			case v4 != nil:
				score = 50
			default:
				score = 10 // IPv6 放后面：很多环境下配了但不通
			}

			// 不支持组播的接口几乎必是 VPN/代理 TUN，比按名字猜可靠：实测 `singbox_tun` 是
			// `up|running`，真实 `WLAN` 是 `up|broadcast|multicast|running`。设备发现靠 mDNS 组播，
			// 无组播接口本就没用；若排在配对码前，手机会先白等一个超时（如 172.18.0.1）。
			// 按名字维护黑名单追不完，能力检测一劳永逸。
			if !ifi.Multicast {
				score -= 200
			}
			// 名字黑名单仍然保留：有些虚拟网卡（VMware 的 host-only）确实支持
			// 组播，光靠上面那条筛不掉。
			if isVirtualIface(ifi.Name) {
				score -= 80
			}
			host := ip.String()
			if v4 == nil {
				host = "[" + host + "]"
			}
			out = append(out, scored{addr: fmt.Sprintf("%s:%d", host, port), score: score})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	res := make([]string, 0, len(out))
	for _, s := range out {
		res = append(res, s.addr)
	}
	return res
}

func isVirtualIface(name string) bool {
	for _, k := range []string{"VMware", "VirtualBox", "vEthernet", "Hyper-V", "Loopback",
		"docker", "veth", "utun", "Npcap", "TAP", "WSL"} {
		if containsFold(name, k) {
			return true
		}
	}
	return false
}

func containsFold(s, sub string) bool {
	ls, lsub := []rune(lower(s)), []rune(lower(sub))
	if len(lsub) > len(ls) {
		return false
	}
	for i := 0; i+len(lsub) <= len(ls); i++ {
		match := true
		for j := range lsub {
			if ls[i+j] != lsub[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func lower(s string) string {
	b := []rune(s)
	for i, r := range b {
		if r >= 'A' && r <= 'Z' {
			b[i] = r + 32
		}
	}
	return string(b)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
