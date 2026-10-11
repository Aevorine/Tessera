package node

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"golang.org/x/text/width"

	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/discovery"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/netif"
	"github.com/Aevorine/Tessera/crossdevice/core/pairing"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/transport"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

// 配对握手消息体。响应方先承诺 H(nonce_r)、事后再揭示：Noise_XX 里响应方看到发起方
// 临时公钥后才选自己的，否则可反复挑选公钥直到 SAS 与想冒充的握手一致（grinding）。
// 先承诺就堵死了，它无法在看到 nonce_i 后再改 nonce_r。
type pairInit struct {
	PairingID []byte `cbor:"1,keyasint"`
	Token     []byte `cbor:"2,keyasint"`
	Method    string `cbor:"3,keyasint"`
	Ver       int    `cbor:"4,keyasint"`
}

type pairCommit struct {
	Commit []byte `cbor:"1,keyasint"`
}

type pairReveal struct {
	Nonce []byte `cbor:"1,keyasint"` // 被承诺的值
	Blind []byte `cbor:"2,keyasint"` // 承诺用的盲化随机数
}

// pairPeerInfo 在 Noise 握手载荷里传输，被动嗅探者不可见。Endpoints 必须互换：配对连接是
// 临时的、源端口随机，不能用于重连；双方须告知各自监听地址，否则配对完要等 mDNS 重新发现。
type pairPeerInfo struct {
	DeviceID  string   `cbor:"1,keyasint"`
	Name      string   `cbor:"2,keyasint"`
	Type      string   `cbor:"3,keyasint"`
	SignPub   []byte   `cbor:"4,keyasint"`
	Nonce     []byte   `cbor:"5,keyasint,omitempty"`
	Endpoints []string `cbor:"6,keyasint,omitempty"`
}

var (
	ErrPairRejected = errors.New("配对被拒绝")
	ErrSASMismatch  = errors.New("安全码不一致，已中止配对（可能存在中间人）")

	// errWrongPeer：该地址上应答的不是要配的设备（多网卡撞了同一虚拟网卡地址、DHCP 旧地址
	// 给了别人、绕回本机）。此时尚无人点过确认，换下一个地址是安全的。
	errWrongPeer = errors.New("这个地址上应答的不是要配对的那台设备")
)

// PairFlowTimeout 是配对从拨号到双方确认的总时限。须覆盖人核对安全码的时间：两端各弹
// 一次确认框（每个最多等 3 分钟，见 agent.confirmPair）。曾只给 20 秒，超时界面报失败，
// 握手却在后台完成、设备已落库。
const PairFlowTimeout = 4 * time.Minute

// pairDialTimeout 只管"连上对方"这一段：局域网里 QUIC 握手是毫秒级，
// 12 秒还没有一个地址连得上，就说明这些地址都不通。
const pairDialTimeout = 12 * time.Second

// DefaultListenPort 是桌面端守护进程默认监听的端口（被占用时才退到随机端口）。
// 手动输入地址只写了 IP、信标又问不到端口时，先按它试一次。
const DefaultListenPort = 39421

// defaultListenPort 是 DefaultListenPort 的可替换副本：测试不能真去拨 39421——
// 开发机上多半正跑着一个真的 Tessera，拨过去就是往用户桌面上弹配对请求。
var defaultListenPort = DefaultListenPort

// ShowPairingCode 生成供对方扫描/输入的配对码（二维码、NFC、深链接通用），60 秒失效且仅可用一次。
func (n *Node) ShowPairingCode(mode string, ttl time.Duration, hotspot *pairing.Hotspot) (string, *pairing.QRPayload, error) {
	eps := n.endpointHints()
	p, err := pairing.NewQRPayload(n.id, mode, pairing.QRTTL, eps, hotspot)
	if err != nil {
		return "", nil, err
	}
	if mode == pairing.TrustTemp {
		p.TTLSec = int64(ttl / time.Second)
	}
	n.tokens.Register(p)
	s, err := p.Encode()
	if err != nil {
		return "", nil, err
	}
	return s, p, nil
}

// RevokePairingCode 主动作废配对码（用户关闭界面、检测到截屏时调用）。
func (n *Node) RevokePairingCode(p *pairing.QRPayload) {
	n.tokens.Revoke(p.PairingID)
}

// 短数字配对码：旧的文本码有 416 个字符，没人能输入；二维码要摄像头，附近设备要组播，
// 手动地址要知道 IP 和端口。这条路是看着屏幕敲 6 位数字。
// 安全性与「附近设备」相同（同一套握手）：短码只用来在局域网里定位设备，不是凭据，
// 不携带密钥材料，也不进配对载荷；之后仍需对方点同意并核对独立的 SAS。

// ShortPairingCodeTTL 是短配对码有效期，比二维码长，因为要在两设备间来回看、手输。
// 到期靠 ShowShortPairingCode 起的定时器失效。
const ShortPairingCodeTTL = 5 * time.Minute

// ShowShortPairingCode 生成 6 位数字码并应答，返回码和到期时刻。同一时刻只有一个有效码，
// 再调会顶掉上一个，避免界面显示的和实际可用的不一致。
func (n *Node) ShowShortPairingCode() (string, time.Time, error) {
	if n.beacon == nil {
		return "", time.Time{}, errors.New("发现服务没有启动，短配对码用不了")
	}
	// 必须在这里拦住：应答短码走信标的固定端口，端口没占上（被占用、第二个实例）时
	// 对任何带码查询都不回话，而生成码本身总会成功，用户会拿到一个对面永远搜不到的码。
	if !n.beacon.Listening() {
		return "", time.Time{}, fmt.Errorf(
			"本机没能占用发现端口 %d（多半是另一个 Tessera 实例正开着，或被别的程序占了），"+
				"短配对码需要它来应答。请关掉多余的实例后重试，或改用二维码/手动输入地址配对",
			discovery.BeaconPort)
	}
	code, err := randomDigits(discovery.PairingCodeDigits)
	if err != nil {
		return "", time.Time{}, err
	}
	n.beacon.SetPairingCode(code)

	n.mu.Lock()
	if n.shortCodeTimer != nil {
		n.shortCodeTimer.Stop()
	}
	// 到期自动撤销。只撤"还是这个码"的情况：用户在这期间又生成了新码时，
	// 旧的定时器不能把新码一起清掉。
	n.shortCodeTimer = time.AfterFunc(ShortPairingCodeTTL, func() {
		n.clearShortPairingCodeIf(code)
	})
	n.mu.Unlock()

	return code, time.Now().Add(ShortPairingCodeTTL), nil
}

// ClearShortPairingCode 立刻停止应答短码（用户关掉配对界面时调用）。
func (n *Node) ClearShortPairingCode() {
	n.mu.Lock()
	if n.shortCodeTimer != nil {
		n.shortCodeTimer.Stop()
		n.shortCodeTimer = nil
	}
	n.mu.Unlock()
	if n.beacon != nil {
		n.beacon.SetPairingCode("")
	}
}

func (n *Node) clearShortPairingCodeIf(code string) {
	if n.beacon == nil {
		return
	}
	// 没有"比较并清除"的原子操作，退而求其次直接清。竞态窗口是定时器刚触发而用户恰好生成新码，
	// 代价只是新码少活几毫秒；反之（新码被旧定时器留着）才是问题。
	n.mu.Lock()
	stillMine := n.shortCodeTimer != nil
	n.shortCodeTimer = nil
	n.mu.Unlock()
	if stillMine {
		n.beacon.SetPairingCode("")
		n.logf("短配对码已到期失效")
	}
}

// PairWithShortCode 用对方屏幕上的 6 位数字配对：先按码在局域网找到设备（不依赖组播，
// 见 discovery.FindByCode），再走与「附近设备」相同的握手（对方确认 + 双向 SAS）。
func (n *Node) PairWithShortCode(ctx context.Context, code string) (*store.Peer, error) {
	code = strings.TrimSpace(code)
	// 用户十有八九是照着屏幕敲的，顺手带上空格或分隔符很常见。
	code = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, code)
	if len(code) != discovery.PairingCodeDigits {
		return nil, fmt.Errorf("配对码是 %d 位数字", discovery.PairingCodeDigits)
	}

	findCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	res, err := discovery.FindByCode(findCtx, n.id.DeviceID(), code, 6*time.Second)
	cancel()
	if err != nil {
		return nil, err
	}
	if len(res.Peers) == 0 {
		return nil, fmt.Errorf(
			"没有找到显示这个码的设备（扫了 %d 台，网段 %s）。"+
				"请确认两台设备连的是同一个 Wi-Fi，而且对方屏幕上的码还没过期",
			res.Probed, strings.Join(res.Subnets, "、"))
	}
	if len(res.Peers) > 1 {
		// 绝不"随便挑一台"：多台应答意味着撞码或有人在冒充，这时候自动选一台
		// 正好是把用户往错误的那台上引。
		return nil, errors.New("有多台设备回应了同一个配对码，请让对方重新生成一个再试")
	}

	peer := res.Peers[0]
	if len(peer.Addrs) == 0 {
		return nil, errors.New("对方应答了，但没有给出可用的连接地址")
	}
	// 指纹用这次应答里带的：走到短码路径多半因组播不通，设备不在 mDNS 缓存里，只查缓存则
	// 指纹为空、没人核对连的是不是应答者。地址全部交出，多网卡上第一个常连不通。
	return n.pairNearby(ctx, peer.DeviceID, peer.Fingerprint, peer.Addrs)
}

// randomDigits 生成 n 位十进制数字，用密码学随机源（不用 math/rand）：可预测的码会让
// 攻击者抢先应答/占用它。
func randomDigits(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成配对码失败: %w", err)
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = '0' + b%10
	}
	return string(out), nil
}

// endpointHints 返回要公布给对端的本机地址，三种情况须分开，否则配对码里的地址没在监听：
// 1. 用户显式指定对外地址 → 用它；2. 绑定具体 IP → 只公布该 IP；3. 绑定通配地址 → 枚举网卡。
func (n *Node) endpointHints() []string {
	n.mu.RLock()
	adv := n.cfg.AdvertiseAddrs
	n.mu.RUnlock()
	if len(adv) > 0 {
		return adv
	}
	addr := n.Addr()
	if addr == nil {
		return nil
	}
	ua, ok := addr.(*net.UDPAddr)
	if !ok || ua.Port == 0 {
		return nil
	}
	if ua.IP != nil && !ua.IP.IsUnspecified() {
		host := ua.IP.String()
		if ua.IP.To4() == nil {
			host = "[" + host + "]"
		}
		return []string{fmt.Sprintf("%s:%d", host, ua.Port)}
	}
	return localEndpoints(ua.Port)
}

// NearbyPairingID 是「附近设备」配对用的固定 pairing_id。该路径没有一次性令牌，
// 安全靠对端弹确认 + 双向 SAS（docs/02-配对方案全集.md §4.2）：任何人都能发起请求，
// 但对方不同意就无事发生；设备名可伪造，故 SAS 不可省且两端都要确认。
// 令牌保护"谁能发起"，SAS 保护"连的是不是本人"。
var NearbyPairingID = []byte("nearby")

// PairWithNearby 向局域网发现的设备发起配对，握手和 SAS 校验与扫码相同，唯一区别是
// 没有一次性令牌，所以对端先弹确认。addrs 与 mDNS 缓存里该设备的地址合并后一起竞速
// （多网卡上第一个常是 VPN/虚拟机网卡，手机到不了）。
func (n *Node) PairWithNearby(ctx context.Context, deviceID string, addrs ...string) (*store.Peer, error) {
	// 带上发现层拿到的公钥指纹：mDNS TXT 有对端公钥前 16 字节，握手时前缀比对，保证连上的
	// 就是列表里点的那台（设备名可伪造，指纹不行）。它不能替代 SAS——mDNS 无认证，
	// 攻击者也能广播自己的指纹；挡中间人的仍是双向 SAS，这里挡的是误连。
	var fp []byte
	all := append([]string(nil), addrs...)
	for _, np := range n.DiscoveredPeers() {
		if np.DeviceID == deviceID {
			fp = np.Fingerprint
			all = append(all, np.Addrs...)
			break
		}
	}
	return n.pairNearby(ctx, deviceID, fp, all)
}

// pairNearby 是「附近设备」和「短数字码」共用的发起方实现：没有令牌，
// 靠对端点确认 + 双向 SAS；deviceID 和指纹前缀用来确认连上的就是选中的那台。
func (n *Node) pairNearby(ctx context.Context, deviceID string, fp []byte, addrs []string) (*store.Peer, error) {
	if deviceID == n.id.DeviceID() {
		return nil, errors.New("不能和自己配对")
	}
	p := &pairing.QRPayload{
		Ver:         1,
		PairingID:   NearbyPairingID,
		DeviceID:    deviceID,
		Mode:        pairing.TrustLong,
		Endpoints:   addrs,
		NearbyFPPfx: fp,
	}
	return n.pairVia(ctx, addrs, p, pairing.MethodNearby)
}

// PairWithAddress 向手动输入的地址（如 "192.168.1.5:54321"）发起配对，是自动发现全失效时
// 的兜底。安全性与「附近设备」一致，走同一条 NearbyPairingID 路径：对端弹确认，双向 SAS
// 必须一致。唯一差别是少了 mDNS 指纹前缀预校验（地址是用户自己输的，不存在选错）。
// 可识别的写法见 parseManualAddr。
func (n *Node) PairWithAddress(ctx context.Context, addr string) (*store.Peer, error) {
	in, err := parseManualAddr(addr)
	if err != nil {
		return nil, err
	}

	var candidates []string
	var fpPrefix []byte
	if in.port != "" {
		candidates = []string{net.JoinHostPort(in.host, in.port)}
	} else {
		// 只写了 IP 或主机名、没写端口。端口只有对方界面才看得到，而这条兜底路径恰要在别的都
		// 失效时也能连上。先问信标要真实端口（两个单播包，不依赖组播）；问不到按默认端口试
		// （桌面端仅在端口被占用时才换）。信标只听 IPv4，IPv6 直接用默认端口。
		probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		peer, perr := n.probeManualHost(probeCtx, in.host)
		cancel()
		if perr == nil && len(peer.Addrs) > 0 {
			candidates = peer.Addrs
			// 顺手拿到了对方的公钥指纹前缀，带进握手做预校验——挡的是"同一时刻
			// 抢答的另一台设备"，跟附近配对那条路是同一个道理。
			fpPrefix = peer.Fingerprint
		} else {
			candidates = []string{net.JoinHostPort(in.host, strconv.Itoa(defaultListenPort))}
		}
	}

	for _, c := range candidates {
		if n.isSelfAddr(c) {
			return nil, errors.New("这是本机自己的地址，请输入另一台设备上显示的那一行")
		}
	}

	p := &pairing.QRPayload{
		Ver:         1,
		PairingID:   NearbyPairingID,
		Mode:        pairing.TrustLong,
		Endpoints:   candidates,
		NearbyFPPfx: fpPrefix,
	}
	peer, err := n.pairVia(ctx, candidates, p, pairing.MethodNearby)
	if err != nil && in.port == "" && errors.Is(err, errNoRoute) {
		return nil, fmt.Errorf(
			"%s 上找不到 Tessera（%w）。请确认对方开着 Tessera、两台设备在同一个网络里；"+
				"也可以照抄对方界面上完整的「IP:端口」再试一次", in.host, err)
	}
	return peer, err
}

// probeManualHost 用信标问一台主机的 QUIC 端口。主机名先解析，优先取 IPv4——
// 信标只在 IPv4 上应答，拿 AAAA 记录去问只会白等超时。
func (n *Node) probeManualHost(ctx context.Context, host string) (discovery.Peer, error) {
	ip := net.ParseIP(host)
	if ip == nil {
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return discovery.Peer{}, err
		}
		for _, cand := range ips {
			if cand.To4() != nil {
				ip = cand
				break
			}
		}
		if ip == nil {
			return discovery.Peer{}, errors.New("只解析到 IPv6 地址，信标问不了")
		}
	}
	if ip.To4() == nil {
		return discovery.Peer{}, errors.New("信标只在 IPv4 上应答")
	}
	return probeHost(ctx, ip.String(), 2*time.Second)
}

// probeHost 是 discovery.ProbeHost 的可替换入口：信标端口固定是 47654，
// 开发机上常有真实的 Tessera 占着它，测试要能把探测换成对着测试节点。
var probeHost = discovery.ProbeHost

// manualAddr 是解析后的手动地址。port 为空表示用户只给了主机。
type manualAddr struct {
	host string
	port string
}

// parseManualAddr 把手敲/粘贴的地址整理成 host + 可选端口，须容忍：全角标点（中文输入法）、
// 句号当点、引号、tessera:// 前缀与尾部斜杠、带方括号或 %zone 的 IPv6、
// 未加方括号但带十进制端口的 IPv6（2001:db8::5:39421）、只有主机、主机名。
func parseManualAddr(raw string) (manualAddr, error) {
	s := strings.TrimSpace(width.Narrow.String(raw))
	s = strings.Map(func(r rune) rune {
		switch r {
		case '。', '｡':
			return '.'
		case '“', '”', '‘', '’', '「', '」', '"', '\'', '`':
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	// 去掉路径部分（也顺带去掉了 CIDR 写法的 /24、/64）。
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return manualAddr{}, errors.New("请输入对方设备显示的地址")
	}
	if strings.ContainsAny(s, " \t") {
		return manualAddr{}, fmt.Errorf("地址里不该有空格：%q", s)
	}

	validPort := func(p string) bool {
		v, err := strconv.Atoi(p)
		return err == nil && v > 0 && v <= 65535
	}

	if host, port, err := net.SplitHostPort(s); err == nil {
		if host == "" {
			return manualAddr{}, errors.New("地址里少了 IP")
		}
		if !validPort(port) {
			return manualAddr{}, fmt.Errorf("端口不对：%q 不是 1-65535 之间的数字", port)
		}
		return manualAddr{host: host, port: port}, nil
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		return manualAddr{host: s[1 : len(s)-1]}, nil
	}
	if ip := parseIPZone(s); ip != nil {
		return manualAddr{host: s}, nil
	}
	// 没加方括号的 IPv6 + 端口：最后一段是五位十进制时它不可能是 IPv6 的一段
	// （一段最多四个十六进制位），只能是端口。
	if i := strings.LastIndexByte(s, ':'); i > 0 && strings.Count(s, ":") >= 2 {
		host, port := s[:i], s[i+1:]
		if parseIPZone(host) != nil && validPort(port) {
			return manualAddr{host: host, port: port}, nil
		}
	}
	if strings.Contains(s, ":") {
		return manualAddr{}, fmt.Errorf("看不懂这个地址：%q。请照抄对方界面上那一行，例如 192.168.1.5:39421", s)
	}
	// 主机名。
	return manualAddr{host: s}, nil
}

// parseIPZone 认带 zone 的 IPv6（fe80::1%wlan0）。
func parseIPZone(s string) net.IP {
	host := s
	if i := strings.IndexByte(s, '%'); i > 0 {
		host = s[:i]
	}
	return net.ParseIP(host)
}

// isSelfAddr 判断地址是否指回本机监听端口。多网卡很常见：两台电脑都装 WSL/Hyper-V，
// 虚拟网卡地址相同，拨对方的 172.x.x.1:39421 会连回自己。
func (n *Node) isSelfAddr(addr string) bool {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port != strconv.Itoa(n.Port()) {
		return false
	}
	ip := parseIPZone(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsUnspecified() {
		// 回环地址 + 本机端口：同一台机器上不可能有第二个进程监听同一个 UDP 端口。
		return true
	}
	for _, ifi := range netif.List() {
		for _, ipn := range ifi.IPNets() {
			if ipn.IP.Equal(ip) {
				return true
			}
		}
	}
	return false
}

// PairWithCode 扫码方发起配对。
func (n *Node) PairWithCode(ctx context.Context, code string, method pairing.Method) (*store.Peer, error) {
	p, err := pairing.Decode(code)
	if err != nil {
		return nil, err
	}
	if p.DeviceID == n.id.DeviceID() {
		return nil, errors.New("不能和自己配对")
	}

	if len(p.Endpoints) == 0 {
		return nil, errors.New("配对码里没有可用的连接地址")
	}
	return n.pairVia(ctx, p.Endpoints, p, method)
}

// errNoRoute 表示一个地址都没连上（还没到握手那一步）。
var errNoRoute = errors.New("所有地址都连不上")

// pairVia 是所有发起方配对路径的公共部分：拨号竞速，握手串行。
// 各路径手上常有多个地址，夹着连不通的（VPN TUN、虚拟机网卡、过期 IPv6），逐个试会
// 白等超时，所以 QUIC 拨号并行。但握手只在一条连接上跑：它会让对方弹确认框，并行就弹两次
// （附近设备没有一次性令牌挡第二次）。已连通的地址按先后排队，第一条握手失败且非终态
// 才换下一条。拨号有短时限 pairDialTimeout；握手阶段只受 ctx 管，因为在等人核对安全码。
func (n *Node) pairVia(ctx context.Context, addrs []string, p *pairing.QRPayload, method pairing.Method) (*store.Peer, error) {
	var cands []string
	seen := map[string]bool{}
	selfOnly := false
	for _, a := range addrs {
		a = strings.TrimSpace(a)
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		if n.isSelfAddr(a) {
			selfOnly = true
			continue
		}
		cands = append(cands, a)
	}
	if len(cands) == 0 {
		if selfOnly {
			return nil, errors.New("这些地址都指向本机自己，请确认用的是另一台设备上的码或地址")
		}
		return nil, errors.New("没有可用的连接地址")
	}

	dctx, cancelDial := context.WithTimeout(ctx, pairDialTimeout)
	defer cancelDial()
	conns := n.dialAll(dctx, cands)
	// 没轮到的连接要关掉：函数不论怎么返回，都把队列里剩下的排干。
	defer func() {
		cancelDial()
		go func() {
			for r := range conns {
				if r.conn != nil {
					_ = r.conn.CloseWithError(0, "")
				}
			}
		}()
	}()

	var dialFails []attemptFailure
	var lastErr error
	for r := range conns {
		if r.err != nil {
			dialFails = append(dialFails, attemptFailure{via: r.addr, addr: r.addr, err: r.err})
			continue
		}
		peer, err := n.pairOverConn(ctx, r.conn, r.addr, p, method)
		if err == nil {
			return peer, nil
		}
		lastErr = err
		if pairRetryable(ctx, err) {
			n.logf("配对：%s 这条路没走通，换下一个已连通的地址（%v）", r.addr, err)
			continue
		}
		// 终态：用户拒绝、安全码不一致、令牌失效、被取消……换个地址重试没有
		// 意义，而且继续跑下去只会让用户再被问一遍。
		return nil, err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parts := make([]string, 0, len(dialFails))
	for _, f := range dialFails {
		parts = append(parts, f.addr+"（"+shortReason(f.err)+"）")
	}
	return nil, fmt.Errorf("%w：%s", errNoRoute, strings.Join(parts, "、"))
}

type dialResult struct {
	conn *quic.Conn
	addr string
	err  error
}

// dialAll 并行拨所有地址，结果按完成的先后送进返回的 channel；全部结束后关闭它。
func (n *Node) dialAll(ctx context.Context, addrs []string) <-chan dialResult {
	out := make(chan dialResult, len(addrs))
	var wg sync.WaitGroup
	for _, a := range addrs {
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			// 必须从本机监听的那个套接字拨出去，不能另开一个（原因见 core/transport 头部）。
			c, err := n.ln.Dial(ctx, addr)
			out <- dialResult{conn: c, addr: addr, err: err}
		}(a)
	}
	go func() { wg.Wait(); close(out) }()
	return out
}

// pairOverConn 在已建好的 QUIC 连接上以发起方走完配对。ctx 取消时直接关连接：
// 握手阶段的读写不看 ctx，不关则等人点按钮的读会一直挂着。
func (n *Node) pairOverConn(ctx context.Context, conn *quic.Conn, addr string, p *pairing.QRPayload, method pairing.Method) (*store.Peer, error) {
	stop := context.AfterFunc(ctx, func() { _ = conn.CloseWithError(0, "配对已取消") })
	peer, err := n.pairInitiator(conn, addr, p, method)
	if !stop() && err != nil && ctx.Err() != nil {
		err = fmt.Errorf("配对超时或已取消: %w", ctx.Err())
	}
	if err != nil {
		_ = conn.CloseWithError(0, "")
		return nil, err
	}
	// 成功后稍等一下再关：对方可能还在读本机最后那条 PAIR_DONE，立刻关连接会
	// 让丢了包的那条永远补发不了。对方先关（新版本收完就关）就不用等满。
	go func() {
		select {
		case <-conn.Context().Done():
		case <-time.After(2 * time.Second):
		}
		_ = conn.CloseWithError(0, "")
	}()
	return peer, nil
}

func (n *Node) pairInitiator(conn *quic.Conn, addr string, p *pairing.QRPayload, method pairing.Method) (*store.Peer, error) {
	// 流的建立本身不该等太久：连接已经通了，这一步只是一个来回。
	sctx, cancel := context.WithTimeout(conn.Context(), transport.HandshakeTimeout)
	stream, err := conn.OpenStreamSync(sctx)
	cancel()
	if err != nil {
		return nil, err
	}
	rw := transport.StreamRW{Stream: stream}
	if _, err := rw.Write([]byte{modePairing}); err != nil {
		return nil, err
	}
	wc := wire.NewConn(rw)

	// 1. 明文交出一次性令牌，让对方先校验"你确实是扫了我刚显示的那张码"。
	if err := wc.WriteMsg(wire.TypePairHello, 0, &pairInit{
		PairingID: p.PairingID, Token: p.Token, Method: string(method), Ver: wire.ProtoVersion,
	}); err != nil {
		return nil, err
	}

	// 2. 收下对方对 nonce_r 的承诺。
	f, err := wc.ReadFrame()
	if err != nil {
		return nil, fmt.Errorf("等待配对承诺失败: %w", err)
	}
	if f.Type == wire.TypePairAbort {
		return nil, decodeAbort(f.Payload)
	}
	if f.Type != wire.TypePairPake1 {
		return nil, fmt.Errorf("配对流程异常：期望承诺，收到 %s", f.Type)
	}
	var commit pairCommit
	if err := wire.Unmarshal(f.Payload, &commit); err != nil {
		return nil, err
	}

	// 3. Noise_XX 握手。用 pairing_id 做 prologue，
	//    使这次握手无法被重放到另一次配对会话。
	nonceI, err := crypto.RandomNonce()
	if err != nil {
		return nil, err
	}
	prologue := pairPrologue(p.PairingID)
	myInfo, err := wire.Marshal(&pairPeerInfo{
		DeviceID: n.id.DeviceID(), Name: n.id.DisplayName(), Type: string(n.id.Type),
		SignPub: n.id.SignPub, Nonce: nonceI[:], Endpoints: n.endpointHints(),
	})
	if err != nil {
		return nil, err
	}

	var peerInfo pairPeerInfo
	res, err := crypto.HandshakeXXInitiator(rw, crypto.StaticKey(n.id.DHPriv, n.id.DHPub), prologue,
		myInfo, func(msg2Payload []byte) []byte {
			_ = wire.Unmarshal(msg2Payload, &peerInfo)
			return nil
		})
	if err != nil {
		return nil, fmt.Errorf("配对握手失败: %w", err)
	}

	sc := crypto.NewSecureConn(rw, res)
	swc := wire.NewConn(sc)

	// 4. 对方揭示 nonce_r，校验它与第 2 步的承诺一致。
	f, err = swc.ReadFrame()
	if err != nil {
		return nil, fmt.Errorf("等待揭示失败: %w", err)
	}
	if f.Type == wire.TypePairAbort {
		return nil, decodeAbort(f.Payload)
	}
	if f.Type != wire.TypePairPake2 {
		return nil, fmt.Errorf("配对流程异常：期望揭示，收到 %s", f.Type)
	}
	var rev pairReveal
	if err := wire.Unmarshal(f.Payload, &rev); err != nil {
		return nil, err
	}
	var ch [32]byte
	copy(ch[:], commit.Commit)
	if err := crypto.VerifyCommitment(ch, rev.Nonce, rev.Blind); err != nil {
		return nil, err
	}

	// 5. 双方独立算 SAS。有中间人则两端必然不同。
	sas, err := crypto.DeriveSAS(res.HandshakeHash, nonceI[:], rev.Nonce)
	if err != nil {
		return nil, err
	}

	// 6. 校验对方自报的 device_id 确由其公钥导出，不采信自报值。连回本机也在此挡住，
	// 必须在 finishPair 之前，否则本机先把自己存成已配对设备并弹两次确认框。
	if peerInfo.DeviceID == n.id.DeviceID() {
		return nil, fmt.Errorf("%w：%s 连回了本机自己", errWrongPeer, addr)
	}
	if err := verifyPeerInfo(&peerInfo, res.PeerStatic, p); err != nil {
		return nil, err
	}

	peer, err := n.finishPair(swc, &peerInfo, res.PeerStatic, sas, method, p, true, addr)
	if err != nil {
		return nil, &confirmStageError{err: err}
	}
	return peer, nil
}

// handlePairingResponder 处理出示配对码一方的流程。
func (n *Node) handlePairingResponder(conn *quic.Conn, rw transport.StreamRW) error {
	wc := wire.NewConn(rw)

	f, err := wc.ReadFrame()
	if err != nil {
		return err
	}
	if f.Type != wire.TypePairHello {
		return fmt.Errorf("配对流程异常：期望 PAIR_HELLO，收到 %s", f.Type)
	}
	var init pairInit
	if err := wire.Unmarshal(f.Payload, &init); err != nil {
		return err
	}

	// 附近设备配对没有一次性令牌（见 NearbyPairingID）：改由用户在本机点确认放行，
	// 且同样必须核对双向 SAS——挡中间人的是 SAS，不是令牌。
	var qp *pairing.QRPayload
	if bytes.Equal(init.PairingID, NearbyPairingID) {
		qp = &pairing.QRPayload{
			Ver:       1,
			PairingID: NearbyPairingID,
			DeviceID:  n.id.DeviceID(),
			Mode:      pairing.TrustLong,
		}
	} else {
		// 令牌校验：过期、用过、错误次数超限都在这里被挡下。
		var err error
		qp, err = n.tokens.Consume(init.PairingID, init.Token)
		if err != nil {
			_ = wc.WriteMsg(wire.TypePairAbort, 0, &wire.PairAbort{
				Code: wire.ErrCodePairTimeout, Msg: err.Error(),
			})
			return err
		}
	}

	// 先承诺，再看对方发来的任何东西。顺序不能反。
	nonceR, err := crypto.RandomNonce()
	if err != nil {
		return err
	}
	c, err := crypto.NewCommitment(nonceR[:])
	if err != nil {
		return err
	}
	if err := wc.WriteMsg(wire.TypePairPake1, 0, &pairCommit{Commit: c.Hash[:]}); err != nil {
		return err
	}

	prologue := pairPrologue(init.PairingID)
	myInfo, err := wire.Marshal(&pairPeerInfo{
		DeviceID: n.id.DeviceID(), Name: n.id.DisplayName(), Type: string(n.id.Type),
		SignPub: n.id.SignPub, Endpoints: n.endpointHints(),
	})
	if err != nil {
		return err
	}

	var peerInfo pairPeerInfo
	res, err := crypto.HandshakeXXResponder(rw, crypto.StaticKey(n.id.DHPriv, n.id.DHPub), prologue,
		func(msg1Payload []byte) []byte {
			_ = wire.Unmarshal(msg1Payload, &peerInfo)
			return myInfo
		})
	if err != nil {
		return fmt.Errorf("配对握手失败: %w", err)
	}

	sc := crypto.NewSecureConn(rw, res)
	swc := wire.NewConn(sc)

	// 揭示 nonce_r。
	value, blind := c.Reveal()
	if err := swc.WriteMsg(wire.TypePairPake2, 0, &pairReveal{Nonce: value, Blind: blind}); err != nil {
		return err
	}

	sas, err := crypto.DeriveSAS(res.HandshakeHash, peerInfo.Nonce, nonceR[:])
	if err != nil {
		return err
	}
	if peerInfo.DeviceID == n.id.DeviceID() {
		// 本机拨到了自己（多网卡、虚拟网卡地址相同）。在 finishPair 之前挡住，
		// 否则会先给自己弹一个确认框。
		return errors.New("对端就是本机自己")
	}
	if err := verifyPeerInfo(&peerInfo, res.PeerStatic, nil); err != nil {
		return err
	}

	method := pairing.Method(init.Method)
	peer, err := n.finishPair(swc, &peerInfo, res.PeerStatic, sas, method, qp, false, "")
	if err != nil {
		return err
	}
	n.logf("已与 %s 配对（%s，%s）", peer.Name, method, peer.Trust)
	return nil
}

// finishPair 完成双向确认并落库。双方都先发自己的确认再读对方的，避免互等死锁。
func (n *Node) finishPair(wc *wire.Conn, info *pairPeerInfo, peerStatic []byte,
	sas crypto.SAS, method pairing.Method, qp *pairing.QRPayload,
	initiator bool, dialedAddr string) (*store.Peer, error) {

	var dhPub [32]byte
	copy(dhPub[:], peerStatic)

	req := PairRequest{
		DeviceID:    info.DeviceID,
		Name:        info.Name,
		Type:        info.Type,
		Method:      method,
		Fingerprint: identity.Fingerprint(dhPub),
		SAS:         sas,
		Incoming:    !initiator,
	}

	// 没有确认回调就拒绝，绝不默认放行。配对是信任边界，SAS 只有被人看过才挡得住中间人；
	// 忘了接确认界面的宿主若默认同意，局域网任何人都能配成长期信任设备。
	ok, mode, ttl := false, pairing.TrustLong, time.Duration(0)
	if n.cfg.ConfirmPair != nil {
		ok, mode, ttl = n.cfg.ConfirmPair(req)
	} else {
		n.logf("没有配置配对确认回调，拒绝来自 %s 的配对", info.DeviceID)
	}
	// 配对方式本身可能限制最高信任等级（链接/声波只能配临时设备）。
	if method.DefaultTrust() == pairing.TrustTemp {
		mode = pairing.TrustTemp
		if ttl == 0 || ttl > time.Hour {
			ttl = time.Hour
		}
	}
	if qp != nil && qp.Mode == pairing.TrustTemp {
		mode = pairing.TrustTemp
		if qp.TTLSec > 0 {
			if d := time.Duration(qp.TTLSec) * time.Second; ttl == 0 || d < ttl {
				ttl = d
			}
		}
	}

	myConfirm := &wire.PairConfirm{Accept: ok, Mode: mode, TTLSec: int64(ttl / time.Second)}
	if err := wc.WriteMsg(wire.TypePairConfirm, 0, myConfirm); err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrPairRejected
	}

	f, err := wc.ReadFrame()
	if err != nil {
		return nil, fmt.Errorf("等待对方确认失败: %w", err)
	}
	if f.Type == wire.TypePairAbort {
		return nil, decodeAbort(f.Payload)
	}
	if f.Type != wire.TypePairConfirm {
		return nil, fmt.Errorf("配对流程异常：期望确认，收到 %s", f.Type)
	}
	var peerConfirm wire.PairConfirm
	if err := wire.Unmarshal(f.Payload, &peerConfirm); err != nil {
		return nil, err
	}
	if !peerConfirm.Accept {
		return nil, ErrPairRejected
	}

	// 取两端中更严格的一方：任一方选临时，结果就是临时；有效期取更短的。
	// 安全策略上"更保守的一方说了算"是唯一正确的合并方式。
	if peerConfirm.Mode == pairing.TrustTemp {
		mode = pairing.TrustTemp
	}
	if peerConfirm.TTLSec > 0 {
		if d := time.Duration(peerConfirm.TTLSec) * time.Second; ttl == 0 || d < ttl {
			ttl = d
		}
	}

	peer := &store.Peer{
		DeviceID: info.DeviceID,
		Name:     info.Name,
		Type:     info.Type,
		DHPub:    append([]byte(nil), peerStatic...),
		SignPub:  append([]byte(nil), info.SignPub...),
		Trust:    mode,
		PairedAt: time.Now(),
		Method:   string(method),
		Caps:     []string{"clip", "file"},
	}

	// 记下对端的监听地址。没有这一步，配对一结束就再也连不上对方
	// （配对那条连接的源端口是临时的，不能用来回拨），只能干等 mDNS 重新发现。
	peer.CachedAddrs = dedupAddrs(info.Endpoints)
	if initiator && dialedAddr != "" {
		// 扫码方知道哪个地址真的拨通了，直接作为下次重连竞速的第一路。
		peer.LastGoodAddr = dialedAddr
		peer.CachedAddrs = dedupAddrs(append([]string{dialedAddr}, peer.CachedAddrs...))
	} else if len(peer.CachedAddrs) > 0 {
		peer.LastGoodAddr = peer.CachedAddrs[0]
	}
	if mode == pairing.TrustTemp {
		if ttl == 0 {
			ttl = 30 * time.Minute
		}
		peer.ExpiresAt = time.Now().Add(ttl)
	}
	if err := n.store.PutPeer(peer); err != nil {
		return nil, err
	}

	// 双方互发 PAIR_DONE 并等到对方那条，配对才算结束。不等的话扫码方先关连接，QUIC
	// CONNECTION_CLOSE 会丢掉未送达的流数据，出示方可能没存下对端，表现为"配对成功但连不上"。
	// 但 PAIR_DONE 只是刷出数据的栅栏，不是再次授权（双方已核对 SAS、收到 Accept），
	// 所以这步读写失败不能算配对失败，否则设备已落库而界面报失败且不发 pair 事件、列表不刷新。
	// 只有对方明确发来 PAIR_ABORT 才回滚。
	if err := wc.WriteMsg(wire.TypePairDone, 0, &wire.PairDone{SignPub: n.id.SignPub}); err != nil {
		n.logf("配对完成确认没发出去（双方都已确认，按成功处理）: %v", err)
	} else if f, err = wc.ReadFrame(); err != nil {
		n.logf("没等到对方的配对完成确认（双方都已确认，按成功处理）: %v", err)
	} else if f.Type == wire.TypePairAbort {
		// 对方在最后一刻取消了，本地也要回滚，不能留下单边的信任记录。
		_ = n.store.Revoke(peer.DeviceID)
		return nil, decodeAbort(f.Payload)
	} else if f.Type != wire.TypePairDone {
		return nil, fmt.Errorf("配对流程异常：期望 PAIR_DONE，收到 %s", f.Type)
	}

	n.emit(Event{Kind: "pair", DeviceID: peer.DeviceID, Msg: "配对成功"})
	return peer, nil
}

// verifyPeerInfo 校验对端自报信息与其密钥自洽。
func verifyPeerInfo(info *pairPeerInfo, peerStatic []byte, qp *pairing.QRPayload) error {
	if len(info.SignPub) != 32 {
		return errors.New("对端签名公钥长度非法")
	}
	// device_id 必须能由公钥算出，否则对方可以随便冒用别人的 ID。
	if got := identity.DeviceIDFromSignPub(info.SignPub); got != info.DeviceID {
		return fmt.Errorf("对端 device_id 与其公钥不匹配（自报 %s，实际 %s）", info.DeviceID, got)
	}
	// 扫码方还要额外确认：握手中拿到的静态公钥就是二维码里印的那把。
	// 这一步才是"二维码作为可信信道"真正发挥作用的地方。
	if qp != nil && len(qp.DHPub) == 0 && len(qp.NearbyFPPfx) > 0 {
		// 附近配对：配对码里没有完整公钥（本来就没有二维码），
		// 改用 mDNS 公布的公钥指纹前缀比对，确认没连错设备。
		if len(peerStatic) < len(qp.NearbyFPPfx) ||
			!eqBytes(peerStatic[:len(qp.NearbyFPPfx)], qp.NearbyFPPfx) {
			return fmt.Errorf("%w: 对端公钥与附近设备列表里的指纹不符（可能选中的不是同一台设备）", ErrSASMismatch)
		}
	} else if qp != nil && len(qp.DHPub) > 0 {
		if !eqBytes(peerStatic, qp.DHPub) {
			return fmt.Errorf("%w: 对端公钥与配对码不符", ErrSASMismatch)
		}
		if info.DeviceID != qp.DeviceID {
			return fmt.Errorf("%w: 对端身份与配对码不符", ErrSASMismatch)
		}
	}
	return nil
}

func pairPrologue(pairingID []byte) []byte {
	h := sha256.Sum256(append([]byte("ClipBridge/1/pair"), pairingID...))
	return h[:]
}

func decodeAbort(p []byte) error {
	var a wire.PairAbort
	if err := wire.Unmarshal(p, &a); err != nil {
		return &peerAbortError{}
	}
	if a.Code == wire.ErrCodeSASMismatch {
		return ErrSASMismatch
	}
	if a.Code == wire.ErrCodeRejected {
		return ErrPairRejected
	}
	return &peerAbortError{msg: a.Msg}
}

// peerAbortError 是对方明确发来的 PAIR_ABORT（令牌过期、已被用过……）。
// 换一个地址连到的还是同一台设备，答复不会变，所以它是终态。
type peerAbortError struct{ msg string }

func (e *peerAbortError) Error() string {
	if e.msg == "" {
		return "配对被对方中止"
	}
	return "配对被对方中止: " + e.msg
}

// confirmStageError 标记"已经走到确认/安全码那一步之后"的失败。到了这一步两边
// 可能都弹过确认框，换地址重来只会让人再被问一遍，所以一律是终态。
type confirmStageError struct{ err error }

func (e *confirmStageError) Error() string { return e.err.Error() }
func (e *confirmStageError) Unwrap() error { return e.err }

// pairRetryable 判断发起方握手失败后能否换下一个已连通地址重试。只有还没到确认步骤的
// 失败可换（流打不开、读写超时、握手出错、连到别的设备）；对方拒绝/中止、安全码不一致、
// 已弹过确认框、调用方取消都是终态。
func pairRetryable(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil {
		return false
	}
	if errors.Is(err, errWrongPeer) {
		return true
	}
	var abort *peerAbortError
	var confirm *confirmStageError
	switch {
	case errors.As(err, &abort), errors.As(err, &confirm),
		errors.Is(err, ErrSASMismatch), errors.Is(err, ErrPairRejected):
		return false
	}
	return true
}

// dedupAddrs 去重并裁剪地址列表，保留 5 个：设备通常只在几个网络间移动，
// 太多只会让重连竞速多开一堆注定失败的 goroutine。
func dedupAddrs(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 5)
	for _, a := range in {
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
		if len(out) == 5 {
			break
		}
	}
	return out
}

func eqBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}
