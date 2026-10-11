package discovery

// 信标：固定端口的 UDP 应答者外加一次主动扫描，补 mDNS（组播）的洞。
// 组播最先被丢：路由器 AP 隔离、企业/校园/酒店 Wi-Fi 过滤、Windows 拒绝未请求的入站 UDP、安卓无
// MulticastLock 时硬件层丢帧，
// 致两台设备能互相 ping 通而「附近的设备」为空。这里走两条非组播通路：定向广播（x.x.x.255），
// 和对同网段逐个单播探测（最多 254 个小包）。
// 不多泄露信息：应答与 mDNS TXT 逐字段相同（设备 ID、名称、类型、能力、公钥前 16 字节、QUIC 端口）
// ，不含完整公钥或金库内容；
// 应答探测不等于允许配对，仍须对端确认并双向核对安全码。

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/netif"
)

const (
	// BeaconPort 是信标的固定 UDP 端口。必须固定：QUIC 端口随机分配，扫描方事先不知道；
	// 取动态端口区间（49152-65535）之外并避开常见服务。
	BeaconPort = 47654

	// 查询与应答的前缀。带版本号，将来改格式时老版本会直接忽略而不是误解析。
	beaconQuery = "TSRA?1"
	beaconReply = "TSRA!1"

	// 单个应答的长度上限。设备名是用户可改的，这里连同整包一起裁剪，
	// 避免有人靠一个超长名字把扫描方的缓冲区撑爆。
	maxBeaconPacket = 1024

	// 带配对码查询里码字段的前缀。老版信标用 strings.HasPrefix(pkt, beaconQuery) 判断是否问我们，
	// 会把带码查询当普通查询照常应答；这是有意的向后兼容，找不到码时仍能按普通扫描列出设备。
	beaconCodeField = "c="

	// 配对码位数：6 位已近"人能照着屏幕敲入"的上限。位数不承担安全责任，码只是定位符：
	// 挑中后仍要对方点同意并核对独立的 SAS，试遍 10^6 个码也只会让对方多弹几次确认框。
	PairingCodeDigits = 6
)

// Beacon 在固定端口上应答探测，只回答、不主动广播：主动广播会让设备在局域网持续留痕，而需求是"想找
// 时能找到"。
type Beacon struct {
	cfg Config

	mu   sync.RWMutex
	port int // 当前 QUIC 监听端口，随 UpdatePort 变化

	conn   *net.UDPConn
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// 当前对外有效的配对码。空串 = 没在配对，一律不应答带码查询。
	// 和 port 共用 mu。
	pairingCode string

	// 约定令牌（rendezvous）与 pairingCode 同一套带码查询机制，区别在生命周期：配对码点了"显示配对码"才
	// 有、几分钟过期；
	// 约定令牌每台已配对设备一个，认识对方就一直在。用 map：每对设备令牌不同（见 node.rendezvousCodes）
	// 。
	rendezvous map[string]struct{}
}

// SetPairingCode 登记当前有效的短配对码，空串撤销。只应答完全匹配的码；
// 没登记时对任何带码查询都不回，否则本机会成为"局域网有没有人在配对"的探测器。
func (b *Beacon) SetPairingCode(code string) {
	b.mu.Lock()
	b.pairingCode = code
	b.mu.Unlock()
}

// SetRendezvousCodes 整份替换约定令牌集合，空集合表示都不应答。
// 不做增删：调用方每轮从"当前还认识哪些设备"重算，增量会让已撤销信任设备的令牌永远留着。
func (b *Beacon) SetRendezvousCodes(codes []string) {
	set := make(map[string]struct{}, len(codes))
	for _, c := range codes {
		if c != "" {
			set[c] = struct{}{}
		}
	}
	b.mu.Lock()
	b.rendezvous = set
	b.mu.Unlock()
}

// matchesPairingCode 判断带码查询该不该应答。用 subtle.ConstantTimeCompare 而非 ==：
// 码虽只是定位符，按时间差逐位试出来仍是很便宜的攻击，防住只需一行。
func (b *Beacon) matchesPairingCode(code string) bool {
	b.mu.RLock()
	want := b.pairingCode
	rv := b.rendezvous
	b.mu.RUnlock()

	if want != "" && len(code) == len(want) &&
		subtle.ConstantTimeCompare([]byte(code), []byte(want)) == 1 {
		return true
	}
	// 约定令牌走 map 查找，不做常量时间比较：令牌由两把公钥推出，能算出者本已知道公钥，无秘密可泄露。
	// 它与 6 位配对码同为定位符，凭据是握手私钥加人眼核对的 SAS。
	if _, ok := rv[code]; ok {
		return true
	}
	return false
}

// queryCode 从查询包里取出配对码。第二个返回值表示"这是一次带码查询"。
func queryCode(pkt []byte) (string, bool) {
	for _, line := range strings.Split(string(pkt), "\n") {
		if strings.HasPrefix(line, beaconCodeField) {
			return strings.TrimSpace(strings.TrimPrefix(line, beaconCodeField)), true
		}
	}
	return "", false
}

// NewBeacon 创建信标。Config 与 mDNS 那一层共用，两处公布的内容必须一致。
func NewBeacon(cfg Config) *Beacon {
	ctx, cancel := context.WithCancel(context.Background())
	return &Beacon{cfg: cfg, port: cfg.Port, ctx: ctx, cancel: cancel}
}

// Start 开始监听。绑不上端口不是致命错误（第二个实例或端口被占用）：本机不应答探测，但仍可主动扫描
// 别人，发现能用一半好过整体塌掉。
func (b *Beacon) Start() error {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: BeaconPort})
	if err != nil {
		b.logf("信标端口 %d 绑定失败，本机将不应答探测（仍可主动扫描）: %v", BeaconPort, err)
		return nil
	}
	b.conn = conn
	b.wg.Add(1)
	go b.serve()
	return nil
}

func (b *Beacon) serve() {
	defer b.wg.Done()
	buf := make([]byte, maxBeaconPacket)
	for {
		if b.ctx.Err() != nil {
			return
		}
		// 带截止时间的读：Close 时关掉 conn 会让这里立刻返回错误，
		// 但万一某个平台上不会，超时也能保证循环有机会看到 ctx 已取消。
		_ = b.conn.SetReadDeadline(time.Now().Add(time.Second))
		n, from, err := b.conn.ReadFromUDP(buf)
		if err != nil {
			var nerr net.Error
			if errors.As(err, &nerr) && nerr.Timeout() {
				continue
			}
			return // 套接字已关闭
		}
		if !strings.HasPrefix(string(buf[:n]), beaconQuery) {
			continue // 不是问我们的，安静丢掉，绝不回错误信息
		}
		// 带码查询：只有码对上才回。码不对就当没听见——回一句"码不对"等于
		// 告诉对方"这台机器在配对，只是码错了"，白送一半信息。
		if code, coded := queryCode(buf[:n]); coded && !b.matchesPairingCode(code) {
			continue
		}
		reply := b.replyPacket()
		if len(reply) > maxBeaconPacket {
			reply = reply[:maxBeaconPacket]
		}
		_ = b.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_, _ = b.conn.WriteToUDP(reply, from)
	}
}

// replyPacket 组装应答。字段与 mDNS 的 TXT 记录一一对应（见 txtRecords），
// 这样两条发现通路解析出来的 Peer 完全一致，上层不需要区分来源。
func (b *Beacon) replyPacket() []byte {
	b.mu.RLock()
	port := b.port
	b.mu.RUnlock()

	caps := strings.Join(b.cfg.Caps, ",")
	if caps == "" {
		caps = "clip,file,folder"
	}
	fields := []string{
		beaconReply,
		"id=" + b.cfg.DeviceID,
		"fp=" + base64.RawStdEncoding.EncodeToString(b.cfg.Fingerprint),
		"n=" + b.cfg.Name,
		"t=" + b.cfg.Type,
		"c=" + caps,
		"p=" + strconv.Itoa(port),
	}
	return []byte(strings.Join(fields, "\n"))
}

// Listening 报告信标是否真的占上固定端口；false 表示不应答别人的主动扫描。
// 连接自检单列它：现象是"我能扫到你、你扫不到我"，单看一边界面想不到原因。
func (b *Beacon) Listening() bool {
	return b.conn != nil
}

// UpdatePort 在 QUIC 监听端口变化后同步。
func (b *Beacon) UpdatePort(port int) {
	b.mu.Lock()
	b.port = port
	b.mu.Unlock()
}

// Close 停止应答。
func (b *Beacon) Close() error {
	b.cancel()
	if b.conn != nil {
		_ = b.conn.Close()
	}
	b.wg.Wait()
	return nil
}

func (b *Beacon) logf(format string, args ...any) {
	if b.cfg.Logger != nil {
		b.cfg.Logger.Printf("[信标] "+format, args...)
	}
}

// 主动扫描

// ScanResult 是一次主动扫描的结果。
type ScanResult struct {
	Peers []Peer
	// Probed 是实际探测的主机数，Broadcast 是发出的广播数；界面显示它们，用户见"扫了 254 台一台没回"就
	// 知道问题在网络或防火墙。
	Probed    int
	Broadcast int
	// Subnets 是扫描覆盖到的网段，形如 "192.168.1.0/24"。
	// 两台设备各自显示自己的网段，一眼就能看出是不是压根不在一个网里。
	Subnets []string
}

// Scan 主动找一遍局域网设备：先广播、后逐个单播（广播命中的话设备在头几十毫秒就回，单播只补漏）。
// 两轮共用同一套接字和接收循环，晚到的广播应答不会丢。selfID 用来滤掉自己的应答（广播会打到自己）。
func Scan(ctx context.Context, selfID string, timeout time.Duration) (ScanResult, error) {
	return scanWith(ctx, selfID, timeout, "")
}

// FindByCode 按短配对码找那一台设备：与 Scan 走完全同一条扫描路径（广播 + 单播 + ARP 热身），
// 区别是查询包多带码，只有登记了该码的设备应答，因此不依赖组播。
// 返回多台不算错误（极小概率撞码或有人冒充），交调用方决定；上层按"没找到唯一一台"处理，不随便挑一
// 台。
func FindByCode(ctx context.Context, selfID, code string, timeout time.Duration) (ScanResult, error) {
	if strings.TrimSpace(code) == "" {
		return ScanResult{Peers: []Peer{}}, errors.New("配对码是空的")
	}
	return scanWith(ctx, selfID, timeout, strings.TrimSpace(code))
}

// scanWith 是 Scan 和 FindByCode 共用的实现，code 为空即普通扫描。
// 抽出来而非复制：ARP 热身两遍、每 32 个包喘口气、广播每遍都发，都是踩出来的细节。
func scanWith(ctx context.Context, selfID string, timeout time.Duration, code string) (ScanResult, error) {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	out := ScanResult{Peers: []Peer{}}

	// 用临时端口发，不占用 BeaconPort：本机的应答者正在用它，而且扫描方也
	// 不需要固定端口——应答按源地址回来。
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		return out, fmt.Errorf("扫描套接字创建失败: %w", err)
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	found := make(map[string]Peer)
	var mu sync.Mutex
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, maxBeaconPacket)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return // 到期或已关闭
			}
			p, ok := parseBeaconReply(buf[:n], from)
			if !ok || p.DeviceID == selfID {
				continue
			}
			mu.Lock()
			if prev, existed := found[p.DeviceID]; existed {
				p.Addrs = mergeAddrs(prev.Addrs, p.Addrs)
			}
			found[p.DeviceID] = p
			mu.Unlock()
		}
	}()

	query := []byte(beaconQuery)
	if code != "" {
		// 多带一行 c=<码>。老版本信标只看前缀，会把它当普通查询照常应答——
		// 于是"新手机 + 旧电脑"至少还能扫出设备来，不会整条路径哑掉。
		query = []byte(beaconQuery + "\n" + beaconCodeField + code)
	}
	subnets := localIPv4Subnets()
	for _, subnet := range subnets {
		out.Subnets = append(out.Subnets, subnet.String())
	}

	// 扫两遍中间隔一下，这不是"重试以防丢包"而是 ARP 的硬性要求：
	// 往未进 ARP 缓存的 IP 发 UDP 时系统先发 ARP 并挂起该包，队列通常只一个包深，等不到就静默丢弃，
	// 冷缓存下 /24 扫描 WriteToUDP 全成功、Probed 显示 254，实际到达的可能只有个位数。
	// 第一遍填 ARP 表，第二遍才真正探测；间隔需够一个 ARP 往返（局域网毫秒级），300ms 很宽裕。
	const arpWarmupPasses = 2
	for pass := 0; pass < arpWarmupPasses; pass++ {
		if pass > 0 {
			select {
			case <-ctx.Done():
			case <-time.After(300 * time.Millisecond):
			}
		}
		if ctx.Err() != nil {
			break
		}
		for _, subnet := range subnets {
			// 广播每一遍都发。UDP 广播没有重传，路由器偶尔丢一个就整轮白等，
			// 而重发的代价是一个包。
			if bcast := broadcastAddr(subnet); bcast != nil {
				if _, err := conn.WriteToUDP(query, &net.UDPAddr{IP: bcast, Port: BeaconPort}); err == nil {
					out.Broadcast++
				}
			}

			// 逐个单播只扫 /24 及更小网段：/16 有 65534 台，要几分钟且会被当端口扫描，那种规模该走手动输入地址
			// 。
			ones, bits := subnet.Mask.Size()
			if bits != 32 || ones < 24 {
				continue
			}
			for i, ip := range hostsIn(subnet) {
				if ctx.Err() != nil {
					break
				}
				if _, err := conn.WriteToUDP(query, &net.UDPAddr{IP: ip, Port: BeaconPort}); err == nil {
					// 只在第二遍计数，第一遍是热身。否则界面上"探测了 508 台"
					// 会让用户以为网里有 508 台机器。
					if pass == arpWarmupPasses-1 {
						out.Probed++
					}
				}
				// 每发一批喘口气：254 个包一次灌入会在 Windows 上撞 ENOBUFS（发送缓冲满）致后面的包失败，
				// 突发流量也易被无线 AP 限速削掉。
				if i%32 == 31 {
					select {
					case <-ctx.Done():
					case <-time.After(5 * time.Millisecond):
					}
				}
			}
		}
	}

	// 等到期。发完就返回的话，绝大部分应答还在路上。
	select {
	case <-ctx.Done():
	case <-time.After(time.Until(deadline)):
	}
	_ = conn.Close()
	wg.Wait()

	mu.Lock()
	for _, p := range found {
		out.Peers = append(out.Peers, p)
	}
	mu.Unlock()
	return out, nil
}

// ProbeHost 只探测一台主机，把「用户只知道 IP」变成「知道该连哪个端口」。
// QUIC 端口随机分配而「手动输入地址」原本要求 IP:端口，端口只有对方界面上才有；
// 这条兜底路径不该设用户跨不过的门槛。信标端口固定（BeaconPort），问一句即得 QUIC 端口，
// 不依赖组播或广播，只是一来一回两个单播包。
func ProbeHost(ctx context.Context, host string, timeout time.Duration) (Peer, error) {
	return probeHostPort(ctx, host, BeaconPort, timeout)
}

// probeHostPort 是 ProbeHost 的实现，端口可指定，只为可测试：
// 信标固定占 47654，开发机上常已有真 Tessera 占着，绑不上就只能跳过，这条最后兜底路径就成了全仓库唯
// 一没验证的。
func probeHostPort(ctx context.Context, host string, port int, timeout time.Duration) (Peer, error) {
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// 允许写主机名：家里的设备常常有个 mDNS 名字（`xiaomi-pad.local`）。
		addrs, err := net.DefaultResolver.LookupHost(ctx, host)
		if err != nil || len(addrs) == 0 {
			return Peer{}, fmt.Errorf("解析不了这个地址: %s", host)
		}
		ip = net.ParseIP(addrs[0])
		if ip == nil {
			return Peer{}, fmt.Errorf("解析不了这个地址: %s", host)
		}
	}

	conn, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		return Peer{}, err
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	target := &net.UDPAddr{IP: ip, Port: port}
	// 发两遍，间隔一下。跟 Scan 里一样是 ARP 的硬性要求：冷缓存时第一个包
	// 会被挂起等 ARP，等不到就静默丢掉，WriteToUDP 照样返回成功。
	for i := 0; i < 2; i++ {
		if _, err := conn.WriteToUDP([]byte(beaconQuery), target); err != nil {
			return Peer{}, err
		}
		if i == 0 {
			select {
			case <-ctx.Done():
				return Peer{}, ctx.Err()
			case <-time.After(150 * time.Millisecond):
			}
		}
	}

	buf := make([]byte, maxBeaconPacket)
	for {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return Peer{}, fmt.Errorf("对方没有应答（%s）", host)
		}
		// 只认来自目标 IP 的应答：同一个网段里可能有别的设备也在回，
		// 拿错一份就会去连一台用户没打算连的设备。
		if !from.IP.Equal(ip) {
			continue
		}
		p, ok := parseBeaconReply(buf[:n], from)
		if !ok {
			continue
		}
		return p, nil
	}
}

// parseBeaconReply 解析应答包。字段格式与 mDNS TXT 相同，只是换了个载体。
func parseBeaconReply(data []byte, from *net.UDPAddr) (Peer, bool) {
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != beaconReply {
		return Peer{}, false
	}
	p := Peer{SeenAt: time.Now()}
	port := 0
	for _, line := range lines[1:] {
		k, v, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found {
			continue
		}
		switch k {
		case "id":
			p.DeviceID = v
		case "n":
			p.Name = v
		case "t":
			p.Type = v
		case "c":
			p.Caps = strings.Split(v, ",")
		case "fp":
			if raw, err := base64.RawStdEncoding.DecodeString(v); err == nil {
				p.Fingerprint = raw
			}
		case "p":
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 65535 {
				port = n
			}
		}
	}
	if p.DeviceID == "" || port == 0 || from == nil {
		return Peer{}, false
	}
	// 地址取应答的来源 IP，不取应答内容自报的地址（NAT 或多网卡机器上常是另一张网卡的，连不通）；
	// 端口仍用自报的，QUIC 端口与信标端口本就不同。
	p.Addrs = []string{net.JoinHostPort(from.IP.String(), strconv.Itoa(port))}
	return p, true
}

// localIPv4Subnets 返回本机各网卡的 IPv4 网段，跳过回环、链路本地和不支持组播的接口
// （几乎必是 VPN/代理 TUN，见 reconnect.go 同款判断；往那里广播白等，/24 还会打出 254 个无人接收的
// 包）。
// 走 netif 而非 net.Interfaces()：安卓 11+ 上后者 permission denied，会静默算不出任何网段，见
// core/netif。
func localIPv4Subnets() []*net.IPNet {
	var out []*net.IPNet
	for _, ifi := range netif.Usable() {
		if !ifi.Multicast {
			continue
		}
		for _, ipn := range ifi.IPNets() {
			if ipn.IP.To4() == nil {
				continue
			}
			if ipn.IP.IsLoopback() || ipn.IP.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, &net.IPNet{IP: ipn.IP.Mask(ipn.Mask), Mask: ipn.Mask})
		}
	}
	return out
}

// broadcastAddr 算出一个网段的定向广播地址（主机位全 1）。
func broadcastAddr(n *net.IPNet) net.IP {
	ip := n.IP.To4()
	mask := net.IP(n.Mask).To4()
	if ip == nil || mask == nil {
		return nil
	}
	out := make(net.IP, 4)
	for i := range out {
		out[i] = ip[i] | ^mask[i]
	}
	return out
}

// hostsIn 列出一个网段里的所有主机地址（不含网络地址和广播地址）。
func hostsIn(n *net.IPNet) []net.IP {
	ip := n.IP.To4()
	mask := net.IP(n.Mask).To4()
	if ip == nil || mask == nil {
		return nil
	}
	bcast := broadcastAddr(n)
	var out []net.IP
	cur := make(net.IP, 4)
	copy(cur, ip)
	for {
		// 步进到下一个地址
		next := make(net.IP, 4)
		copy(next, cur)
		for i := 3; i >= 0; i-- {
			next[i]++
			if next[i] != 0 {
				break
			}
		}
		if !n.Contains(next) || next.Equal(bcast) {
			break
		}
		out = append(out, next)
		cur = next
		if len(out) > 4096 { // 安全阀，正常 /24 只有 254 个
			break
		}
	}
	return out
}
