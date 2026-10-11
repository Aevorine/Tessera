// Package discovery 用 mDNS / DNS-SD 在局域网公布本机并持续发现其他设备，解决"换地址后能否自动连回
// "：
// 缓存地址覆盖大多数重连，但对端换 Wi-Fi、DHCP 重发或换网段后缓存全失效，没有发现层则已配对设备永远
// 连不上、只能重新扫码（docs/01 §6.1）。
// 记录格式见 docs/04-线协议规范.md §9；TXT 带 x25519 公钥指纹，让发起方发 Noise_IK 第一条消息前就知
// 道用哪个静态公钥，省一次往返。
package discovery

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/netif"
	"github.com/grandcat/zeroconf"
)

const (
	// ServiceType 用 _udp 而非文档早期的 _tcp：底下是 QUIC，监听在 UDP 上；用 _tcp 公布 UDP 服务会让
	// Bonjour/dns-sd 排查对不上。
	ServiceType = "_clipbridge._udp"
	Domain      = "local."

	// 缓存里的记录多久没再被看到就算过期。mDNS 的 SRV/A TTL 是 120 秒，
	// 这里给到两倍多一点，容忍偶尔丢一两次组播应答。
	peerTTL = 5 * time.Minute

	// 常驻浏览的重启周期，不是轮询间隔：浏览一直开着，重启只为自愈"网络切换后套接字绑在旧接口、不报错也
	// 收不到"。
	// 5 分钟：长到不打断正常监听，短到出问题时不必久等。
	restartInterval = 5 * time.Minute
)

// Peer 是通过 mDNS 看到的一台设备。它只是"发现"层的结果，不代表已配对，
// 更不代表可信——是否放行完全由上层按设备公钥判断。
type Peer struct {
	DeviceID    string
	Name        string
	Type        string
	Caps        []string
	Fingerprint []byte // x25519 公钥前 16 字节，用于握手前预取静态公钥
	Addrs       []string
	SeenAt      time.Time
}

// Config 是发现服务的配置。
type Config struct {
	DeviceID    string
	Name        string
	Type        string
	Caps        []string
	Fingerprint []byte
	Port        int

	// OnPeer 每次看到（或刷新）一台设备时回调。上层拿它来立刻唤醒重连循环——
	// "刚刚扫到对端就在同一个网里"是最强的重连信号，比等退避计时器有效得多。
	OnPeer func(Peer)

	Logger *log.Logger
}

// Service 是发现服务实例。
type Service struct {
	cfg Config

	mu    sync.RWMutex
	peers map[string]Peer

	// server 在网络变化后会被换掉（见 republish），读写都走 srvMu。
	srvMu  sync.Mutex
	server *zeroconf.Server

	// needRepublish 由 Refresh 置位，浏览循环下一轮开始前重新公布一次。
	needRepublish atomic.Bool

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// wake 用来把"立刻重新浏览一次"的请求送进浏览循环。
	// 容量 1 + 非阻塞写入 = 合并掉短时间内的重复请求。
	wake chan struct{}
}

// New 创建发现服务。
func New(cfg Config) *Service {
	if cfg.Logger == nil {
		cfg.Logger = log.New(log.Writer(), "", log.LstdFlags)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		cfg:    cfg,
		peers:  make(map[string]Peer),
		ctx:    ctx,
		cancel: cancel,
		wake:   make(chan struct{}, 1),
	}
}

// Start 开始公布本机并持续浏览。公布失败不算致命（严格防火墙、容器、AP 隔离下常见），浏览往往仍可用
// ，
// 缓存地址重连也不依赖 mDNS，所以只记日志让节点继续跑：发现层是加速手段而非必需品。
func (s *Service) Start() error {
	s.publish()
	s.wg.Add(1)
	go s.browseLoop()
	return nil
}

// publish 按**当前**网卡清单注册 mDNS 服务。
func (s *Service) publish() {
	instance := instanceName(s.cfg.DeviceID)
	// 网卡清单必须显式传入，不能传 nil：nil 时 zeroconf 自己调 net.Interfaces()，安卓 11+ 上
	// permission denied
	// （golang/go#40569，见 core/netif），只 log 一句而 Register 仍返回成功，「附近的设备」永远为空且无
	// 错可查。
	// 桌面端 netif 返回 nil，行为不变。
	server, err := zeroconf.Register(instance, ServiceType, Domain, s.cfg.Port, s.txtRecords(), netif.MulticastInterfaces())
	if err != nil {
		s.logf("mDNS 公布失败（仍可通过缓存地址连接）: %v", err)
		return
	}
	// 不在这里改 TTL：Register 返回时探测 goroutine 已在读它，事后调 server.TTL() 是数据竞争（CI 竞态检
	// 测每次报）。
	// 用库默认 TTL；下线时的 goodbye 包让对端清记录，发现层自身的过期判断（peerTTL）也不依赖它。
	s.srvMu.Lock()
	s.server = server
	s.srvMu.Unlock()
}

// republish 换网后重新公布：公布用的组播套接字按注册时的网卡清单绑定，换 Wi-Fi（安卓上网卡 index 也
// 变）后
// 绑在已消失的接口上，不报错却没人听得到，别的设备的「附近」列表从此没有本机，直到应用重启。浏览那
// 一半每 5 分钟自会重开。
func (s *Service) republish() {
	s.srvMu.Lock()
	old := s.server
	s.server = nil
	s.srvMu.Unlock()
	if old != nil {
		old.Shutdown() // 顺带发 goodbye，对端会先删再重新收到新的通告
	}
	if s.ctx.Err() != nil {
		return
	}
	s.publish()
}

// txtRecords 组装 TXT 记录，字段定义见 docs/04-线协议规范.md §9。
func (s *Service) txtRecords() []string {
	caps := strings.Join(s.cfg.Caps, ",")
	if caps == "" {
		caps = "clip,file,folder"
	}
	return []string{
		"v=1",
		"id=" + s.cfg.DeviceID,
		"fp=" + base64.RawStdEncoding.EncodeToString(s.cfg.Fingerprint),
		"n=" + s.cfg.Name,
		"t=" + s.cfg.Type,
		"c=" + caps,
		"p=" + strconv.Itoa(s.cfg.Port),
	}
}

// browseLoop 保持常驻的 mDNS 浏览。曾是"每 60 秒开一个 5 秒窗口"，92% 时间没在听，
// 设备重新上线发的通告多半落在聋区，自动重连慢到几十秒；常驻监听后对端一上线即毫秒级唤醒。
// 仍定期重启：网络切换后旧组播套接字绑在已消失接口上不报错也收不到东西，只能靠重开自愈。
func (s *Service) browseLoop() {
	defer s.wg.Done()
	for {
		if s.ctx.Err() != nil {
			return
		}
		// 每一轮开一条长连接式的浏览，直到被 Refresh/Close 打断或到期重开。
		stop := s.browseUntil(restartInterval)

		select {
		case <-s.ctx.Done():
			return
		default:
		}
		if stop {
			return
		}
		s.expire()
		if s.needRepublish.Swap(false) {
			s.republish()
		}
	}
}

// browseUntil 开一条浏览并保持到超时、Refresh 或 Close。返回 true 表示该退出了。
func (s *Service) browseUntil(d time.Duration) bool {
	// 同 Start()：接口清单必须显式给，否则安卓上浏览器建得出来却收不到任何设备。
	// 桌面端 MulticastInterfaces() 返回 nil，SelectIfaces(nil) 等价于原 NewResolver(nil)。
	resolver, err := zeroconf.NewResolver(zeroconf.SelectIfaces(netif.MulticastInterfaces()))
	if err != nil {
		s.logf("mDNS 解析器创建失败: %v", err)
		// 建不出来就等一会儿再试，别把 CPU 打满。
		select {
		case <-s.ctx.Done():
			return true
		case <-time.After(2 * time.Second):
		}
		return false
	}

	ctx, cancel := context.WithTimeout(s.ctx, d)
	defer cancel()

	entries := make(chan *zeroconf.ServiceEntry, 32)
	go func() {
		for e := range entries {
			s.absorb(e)
		}
	}()

	if err := resolver.Browse(ctx, ServiceType, Domain, entries); err != nil {
		s.logf("mDNS 浏览失败: %v", err)
		select {
		case <-s.ctx.Done():
			return true
		case <-time.After(2 * time.Second):
		}
		return false
	}

	select {
	case <-ctx.Done():
		// 到期或被 Close
		return s.ctx.Err() != nil
	case <-s.wake:
		// Refresh：网络变了，立刻重开一条，别用绑在旧接口上的套接字。
		cancel()
		return false
	}
}

// absorb 把一条 mDNS 应答转成 Peer 并入库。
func (s *Service) absorb(e *zeroconf.ServiceEntry) {
	if e == nil {
		return
	}
	p, ok := parseEntry(e)
	if !ok {
		return
	}
	// 自己发的广播自己也会收到，直接丢掉——否则设备列表里会出现"自己"，
	// 重连逻辑还会试图跟自己握手。
	if p.DeviceID == s.cfg.DeviceID {
		return
	}

	s.mu.Lock()
	prev, existed := s.peers[p.DeviceID]
	if existed {
		// 同一台设备可能分多条应答到达（A 记录和 AAAA 记录分开来），
		// 地址要合并而不是覆盖，否则会来回丢掉 IPv4 或 IPv6 那一半。
		p.Addrs = mergeAddrs(prev.Addrs, p.Addrs)
	}
	s.peers[p.DeviceID] = p
	s.mu.Unlock()

	if s.cfg.OnPeer != nil {
		s.cfg.OnPeer(p)
	}
}

// parseEntry 解析 TXT 记录并组装地址列表。
func parseEntry(e *zeroconf.ServiceEntry) (Peer, bool) {
	p := Peer{SeenAt: time.Now()}
	port := e.Port

	for _, kv := range e.Text {
		k, v, found := strings.Cut(kv, "=")
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
			// TXT 里的端口优先于 SRV：SRV 端口在某些代理/中继场景下会被改写，
			// TXT 是我们自己写进去的，更可信。
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 65535 {
				port = n
			}
		}
	}
	if p.DeviceID == "" || port == 0 {
		return Peer{}, false
	}

	for _, ip := range e.AddrIPv4 {
		if ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		p.Addrs = append(p.Addrs, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	}
	for _, ip := range e.AddrIPv6 {
		// 链路本地 IPv6 没有 zone id 是连不上的，而 mDNS 应答里通常不带 zone，
		// 收下来也只会浪费一路竞速，直接跳过。
		if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() {
			continue
		}
		p.Addrs = append(p.Addrs, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	}
	if len(p.Addrs) == 0 {
		return Peer{}, false
	}
	return p, true
}

func mergeAddrs(old, fresh []string) []string {
	seen := make(map[string]bool, len(old)+len(fresh))
	out := make([]string, 0, len(old)+len(fresh))
	for _, a := range append(append([]string{}, fresh...), old...) {
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	return out
}

// expire 清掉太久没再出现的记录。
func (s *Service) expire() {
	cutoff := time.Now().Add(-peerTTL)
	s.mu.Lock()
	for id, p := range s.peers {
		if p.SeenAt.Before(cutoff) {
			delete(s.peers, id)
		}
	}
	s.mu.Unlock()
}

// AddrsFor 返回某台设备当前被发现的地址，供重连竞速使用。
func (s *Service) AddrsFor(deviceID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.peers[deviceID]
	if !ok {
		return nil
	}
	return append([]string(nil), p.Addrs...)
}

// Published 报告 mDNS 公布是否成功。失败不影响浏览和缓存地址重连（见 Start
// 的说明），但它决定了"对方能不能自动看到本机"，连接自检要单独报这一条。
func (s *Service) Published() bool {
	s.srvMu.Lock()
	defer s.srvMu.Unlock()
	return s.server != nil
}

// Peers 返回当前发现到的全部设备，供"附近设备"配对界面使用。
func (s *Service) Peers() []Peer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Peer, 0, len(s.peers))
	for _, p := range s.peers {
		out = append(out, p)
	}
	return out
}

// Refresh 立刻重新浏览一轮（网络切换、屏幕点亮、睡眠恢复时调用）。非阻塞：调用方（通常是
// Node.NetworkChanged）可能正持锁，绝不能在这里等。
func (s *Service) Refresh() {
	// 地址在网络切换后基本全废，先清空，避免拿旧地址去竞速白等一轮超时。
	s.mu.Lock()
	s.peers = make(map[string]Peer)
	s.mu.Unlock()
	s.needRepublish.Store(true)

	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// UpdatePort 在监听端口变化后重新公布。
func (s *Service) UpdatePort(port int) {
	s.cfg.Port = port
	s.srvMu.Lock()
	defer s.srvMu.Unlock()
	if s.server != nil {
		s.server.SetText(s.txtRecords())
	}
}

// Close 停止公布与浏览。Shutdown 会发 goodbye 包（TTL=0），
// 让对端立刻知道本机下线，而不用干等 120 秒 TTL 过期。
func (s *Service) Close() error {
	s.cancel()
	// 先等浏览循环退出：它可能正在 republish，跟这里同时 Shutdown 会关两次。
	s.wg.Wait()
	s.srvMu.Lock()
	srv := s.server
	s.server = nil
	s.srvMu.Unlock()
	if srv != nil {
		srv.Shutdown()
	}
	return nil
}

func (s *Service) logf(format string, args ...any) {
	s.cfg.Logger.Printf("[发现] "+format, args...)
}

// instanceName 取 device_id 前 8 位作实例名（docs/04 §9）：DNS-SD 实例名有长度和字符限制，完整 id
// 在 TXT 的 id= 字段里。
func instanceName(deviceID string) string {
	if len(deviceID) > 8 {
		return deviceID[:8]
	}
	if deviceID == "" {
		return fmt.Sprintf("cb%d", time.Now().UnixNano()%100000000)
	}
	return deviceID
}
