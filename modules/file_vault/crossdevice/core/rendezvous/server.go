package rendezvous

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/transport"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
	"github.com/quic-go/quic-go"
)

// ServerConfig 是汇合点服务器的配置。
type ServerConfig struct {
	// Addr 监听地址，形如 ":47820"。
	Addr string

	// Secret 可选的服务器口令。非空时客户端必须附上正确的 HMAC 才被受理，
	// 等于把这台服务器锁成私用。仍然不需要任何账号系统。
	Secret string

	// DisableRelay 为真时只做地址交换、不提供中继转发。
	// 适合"我只想帮设备互相找到，不想出带宽"的部署。
	DisableRelay bool

	// DailyRelayBytes 是每个暗号每天的中继流量上限，0 用默认值。不可省：没有配额的公开中继
	// 必被当免费流量池（自建中继最常见的翻车方式）。
	DailyRelayBytes int64

	// DailyRelayBytesPerIP 是同一来源地址每天的中继流量上限，0 用默认值。暗号由客户端自挑，
	// 只按暗号记账则换一批暗号就能无限用；再按来源地址记账（IPv6 按 /64，一户通常分到一整段）。
	DailyRelayBytesPerIP int64

	// MaxRelaysPerIP 是同一个来源地址同时挂着的中继流上限（包括还在等对家的半条），
	// 0 表示默认值。正常用户同一时刻只有几台设备在转发，这个数够宽。
	MaxRelaysPerIP int

	// MaxRelays 是整台服务器同时进行的中继流上限，0 表示默认值。
	MaxRelays int

	Logger *log.Logger
}

const (
	defaultDailyRelayBytes      = 2 << 30 // 2 GiB
	defaultDailyRelayBytesPerIP = 8 << 30 // 8 GiB
	defaultMaxRelaysPerIP       = 16
	defaultMaxRelays            = 1024
)

// waiter 是一个已报到、正在等对端出现的客户端。
type waiter struct {
	deviceID  string
	endpoints []Endpoint
	observed  string
	notify    chan PeerFound
	joinedAt  time.Time
}

// relayHalf 是一条等待配对的中继流。
type relayHalf struct {
	deviceID string
	stream   io.ReadWriteCloser
	paired   chan io.ReadWriteCloser
	once     sync.Once
}

// Server 是汇合点服务器，刻意做笨：不落盘、不记谁与谁通信、重启即忘。
// 唯一状态是内存里"此刻谁在等谁"和当日流量计数。
type Server struct {
	cfg ServerConfig
	ep  *transport.Endpoint

	mu      sync.Mutex
	waiting map[string][]*waiter    // token -> 正在等待的客户端
	relays  map[string]*relayHalf   // token -> 已到达、等着被配对的那一半
	seen    map[string]time.Time    // 一次性随机数 -> 过期时刻（防重放）
	used    map[string]*quotaBucket // token -> 当日流量
	ipUsed  map[string]*quotaBucket // 来源地址 -> 当日流量
	active  map[string]int          // 来源地址 -> 正在进行的中继流数
	nActive int                     // 全服务器正在进行的中继流数

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

type quotaBucket struct {
	day   int64
	bytes int64
}

// NewServer 创建服务器。
func NewServer(cfg ServerConfig) *Server {
	if cfg.Logger == nil {
		cfg.Logger = log.New(log.Writer(), "", log.LstdFlags)
	}
	if cfg.Addr == "" {
		cfg.Addr = ":47820"
	}
	if cfg.DailyRelayBytes <= 0 {
		cfg.DailyRelayBytes = defaultDailyRelayBytes
	}
	if cfg.DailyRelayBytesPerIP <= 0 {
		cfg.DailyRelayBytesPerIP = defaultDailyRelayBytesPerIP
	}
	if cfg.MaxRelaysPerIP <= 0 {
		cfg.MaxRelaysPerIP = defaultMaxRelaysPerIP
	}
	if cfg.MaxRelays <= 0 {
		cfg.MaxRelays = defaultMaxRelays
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{
		cfg:     cfg,
		waiting: make(map[string][]*waiter),
		relays:  make(map[string]*relayHalf),
		seen:    make(map[string]time.Time),
		used:    make(map[string]*quotaBucket),
		ipUsed:  make(map[string]*quotaBucket),
		active:  make(map[string]int),
		ctx:     ctx,
		cancel:  cancel,
	}
}

// Start 开始监听。
func (s *Server) Start() error {
	ep, err := transport.Open(s.cfg.Addr)
	if err != nil {
		return err
	}
	s.ep = ep
	s.logf("汇合点服务已启动，监听 %s（中继：%v，口令：%v）",
		ep.Addr(), !s.cfg.DisableRelay, s.cfg.Secret != "")

	s.wg.Add(2)
	go s.acceptLoop()
	go s.gcLoop()
	return nil
}

// Addr 返回实际监听地址（传 :0 时用来拿系统分配的端口）。
func (s *Server) Addr() net.Addr { return s.ep.Addr() }

// Close 停止服务。
func (s *Server) Close() error {
	s.cancel()
	if s.ep != nil {
		_ = s.ep.Close()
	}
	s.wg.Wait()
	return nil
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.ep.Accept(s.ctx)
		if err != nil {
			if s.ctx.Err() != nil {
				return
			}
			s.logf("接受连接失败: %v", err)
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.serveConn(conn)
		}()
	}
}

// serveConn 处理一条客户端连接。一条连接上可以开多条流：
// 一条常驻的信令流，外加按需的中继流。
func (s *Server) serveConn(conn *quic.Conn) {
	defer func() { _ = conn.CloseWithError(0, "") }()
	observed := conn.RemoteAddr().String()
	for {
		stream, err := conn.AcceptStream(s.ctx)
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.serveStream(transport.StreamRW{Stream: stream}, observed)
		}()
	}
}

func (s *Server) serveStream(rw io.ReadWriteCloser, observed string) {
	defer func() { _ = rw.Close() }()
	wc := wire.NewConn(rw)

	f, err := wc.ReadFrame()
	if err != nil {
		return
	}
	switch f.Type {
	case wire.TypeRvHello:
		var h Hello
		if err := wire.Unmarshal(f.Payload, &h); err != nil {
			s.reject(wc, "信令无法解析")
			return
		}
		s.handleHello(wc, &h, observed)
	case wire.TypeRvRelay:
		var r RelayRequest
		if err := wire.Unmarshal(f.Payload, &r); err != nil {
			s.reject(wc, "信令无法解析")
			return
		}
		s.handleRelay(wc, rw, &r, observed)
	default:
		s.reject(wc, "不认识的信令类型")
	}
}

func (s *Server) reject(wc *wire.Conn, reason string) {
	_ = wc.WriteMsg(wire.TypeRvError, 0, &Error{Reason: reason})
}

// authenticate 跑所有拒收检查：格式、时间窗、重放、口令、签名。顺序刻意：先便宜的
// （格式、时间），最后才验最贵的签名，垃圾包打不动服务器 CPU。
func (s *Server) authenticate(kind, token, deviceID string, signPub, sig, mac []byte, ts int64, nonce []byte) error {
	if !ValidToken(token) {
		return ErrBadToken
	}
	if deviceID == "" || len(nonce) == 0 || len(nonce) > 64 {
		return errors.New("信令字段不合法")
	}
	if err := CheckFreshness(ts, time.Now()); err != nil {
		return err
	}
	if !s.claimNonce(string(nonce), ts) {
		return errors.New("这条信令已经用过了（重放）")
	}
	if err := CheckSecret(s.cfg.Secret, token, deviceID, ts, nonce, mac); err != nil {
		return err
	}
	return VerifySig(signPub, sig, kind, token, deviceID, ts, nonce)
}

// claimNonce 记下一个一次性随机数，已经见过就返回 false。
func (s *Server) claimNonce(nonce string, ts int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.seen[nonce]; dup {
		return false
	}
	// 只需要留到时间窗过期为止：过了窗，CheckFreshness 自己就会拦下。
	s.seen[nonce] = time.UnixMilli(ts).Add(2 * MaxClockSkew)
	return true
}

// handleHello 让客户端报到并在对端出现时推送。这条流一直挂着直到客户端断开（"我在等人"）。
func (s *Server) handleHello(wc *wire.Conn, h *Hello, observed string) {
	if err := s.authenticate("hello", h.Token, h.DeviceID, h.SignPub, h.Sig, h.SecretMAC, h.TS, h.Nonce); err != nil {
		s.reject(wc, err.Error())
		return
	}

	// 必须加入服务器观察到的公网地址（客户端自己不知道，这正是它来找我们的原因），再统一去重：
	// 两台设备同网时自报内网地址与观察地址相同，不去重对端会白拨两遍。
	eps := NormalizeEndpoints(append(h.Endpoints, Endpoint{Addr: observed, Kind: "public"}))

	if err := wc.WriteMsg(wire.TypeRvWelcome, 0, &Welcome{
		ObservedAddr: observed,
		ServerTS:     time.Now().UnixMilli(),
		RelayEnabled: !s.cfg.DisableRelay,
	}); err != nil {
		return
	}

	me := &waiter{
		deviceID:  h.DeviceID,
		endpoints: eps,
		observed:  observed,
		notify:    make(chan PeerFound, 4),
		joinedAt:  time.Now(),
	}
	peers := s.join(h.Token, me)
	defer s.leave(h.Token, me)

	// 已经在等的那些人，立刻互相引见。
	punchAt := time.Now().Add(300 * time.Millisecond).UnixMilli()
	for _, p := range peers {
		s.introduce(p, me, punchAt)
		s.introduce(me, p, punchAt)
	}

	for {
		select {
		case <-s.ctx.Done():
			return
		case pf := <-me.notify:
			if err := wc.WriteMsg(wire.TypeRvPeer, 0, &pf); err != nil {
				return
			}
		}
	}
}

// introduce 把 from 的地址推给 to。非阻塞写：某客户端推送队列满（多半卡住或正断开），
// 不能拖住其他人的引见。
func (s *Server) introduce(to, from *waiter, punchAt int64) {
	if to.deviceID == from.deviceID {
		return // 同一台设备的两条连接，没必要引见给自己
	}
	select {
	case to.notify <- PeerFound{
		DeviceID:  from.deviceID,
		Endpoints: from.endpoints,
		PunchAt:   punchAt,
	}:
	default:
	}
}

func (s *Server) join(token string, w *waiter) []*waiter {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := append([]*waiter(nil), s.waiting[token]...)
	s.waiting[token] = append(s.waiting[token], w)
	return existing
}

func (s *Server) leave(token string, w *waiter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.waiting[token]
	for i, x := range list {
		if x == w {
			s.waiting[token] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(s.waiting[token]) == 0 {
		delete(s.waiting, token)
	}
}

// handleRelay 把两条同暗号的流对接起来，之后纯搬字节。
func (s *Server) handleRelay(wc *wire.Conn, rw io.ReadWriteCloser, r *RelayRequest, observed string) {
	if s.cfg.DisableRelay {
		s.reject(wc, "本服务器未开启中继")
		return
	}
	if err := s.authenticate("relay", r.Token, r.DeviceID, r.SignPub, r.Sig, r.SecretMAC, r.TS, r.Nonce); err != nil {
		s.reject(wc, err.Error())
		return
	}
	src := sourceKey(observed)
	if !s.admitRelay(src) {
		s.reject(wc, ErrRelayBusy.Error())
		return
	}
	defer s.releaseRelay(src)
	if !s.quotaAvailable(r.Token) || !s.ipQuotaAvailable(src) {
		s.reject(wc, ErrQuota.Error())
		return
	}

	me := &relayHalf{deviceID: r.DeviceID, stream: rw, paired: make(chan io.ReadWriteCloser, 1)}
	other, isSecond := s.pairRelay(r.Token, me)

	var peer io.ReadWriteCloser
	var peerID string
	if isSecond {
		peer, peerID = other.stream, other.deviceID
		other.once.Do(func() { other.paired <- rw })
	} else {
		// 先到的那一半在这儿等对家。等不到就走人——不能让半条中继永远挂着。
		select {
		case peer = <-me.paired:
			peerID = s.relayPeerID(r.Token, me)
		case <-time.After(30 * time.Second):
			s.dropRelay(r.Token, me)
			s.reject(wc, "等待对端接入中继超时")
			return
		case <-s.ctx.Done():
			return
		}
	}

	if err := wc.WriteMsg(wire.TypeRvRelayOK, 0, &RelayReady{PeerDeviceID: peerID}); err != nil {
		return
	}

	// 从这里开始服务器只是根管子。两个方向各一条 goroutine，
	// 任一方向结束就把两边都关掉，避免留下半开的连接。
	n := s.pipe(rw, peer)
	s.chargeQuota(r.Token, n)
	s.chargeIPQuota(src, n)
}

// sourceKey 把连接的来源地址归成记账用的键：IPv4 按单个地址，IPv6 按 /64。
// 一户人家的 IPv6 通常分到一整段 /64，按单个地址记账的话换个后缀就绕过去了。
func sourceKey(observed string) string {
	host := observed
	if h, _, err := net.SplitHostPort(observed); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// admitRelay 占一个中继并发名额；满了返回 false。成功后必须配对调用 releaseRelay。
func (s *Server) admitRelay(src string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.nActive >= s.cfg.MaxRelays || s.active[src] >= s.cfg.MaxRelaysPerIP {
		return false
	}
	s.nActive++
	s.active[src]++
	return true
}

func (s *Server) releaseRelay(src string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nActive--
	if s.active[src]--; s.active[src] <= 0 {
		delete(s.active, src)
	}
}

func (s *Server) pairRelay(token string, me *relayHalf) (*relayHalf, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if other, ok := s.relays[token]; ok {
		delete(s.relays, token)
		return other, true
	}
	s.relays[token] = me
	return nil, false
}

func (s *Server) relayPeerID(token string, me *relayHalf) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = token
	_ = me
	return "" // 先到的一方不需要知道对家 ID，握手里会验真身
}

func (s *Server) dropRelay(token string, me *relayHalf) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.relays[token]; ok && cur == me {
		delete(s.relays, token)
	}
}

// pipe 双向搬运，返回搬了多少字节。
func (s *Server) pipe(a, b io.ReadWriteCloser) int64 {
	var total int64
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst io.WriteCloser, src io.Reader) {
		defer wg.Done()
		n, _ := io.Copy(dst, src)
		mu.Lock()
		total += n
		mu.Unlock()
		// 一个方向断了，另一个方向也没有意义了。
		_ = a.Close()
		_ = b.Close()
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
	return total
}

func (s *Server) quotaAvailable(token string) bool {
	return s.bucketAvailable(s.used, token, s.cfg.DailyRelayBytes)
}

func (s *Server) chargeQuota(token string, n int64) {
	s.chargeBucket(s.used, token, n)
}

func (s *Server) ipQuotaAvailable(src string) bool {
	return s.bucketAvailable(s.ipUsed, src, s.cfg.DailyRelayBytesPerIP)
}

func (s *Server) chargeIPQuota(src string, n int64) {
	s.chargeBucket(s.ipUsed, src, n)
}

func (s *Server) bucketAvailable(m map[string]*quotaBucket, key string, limit int64) bool {
	day := time.Now().UTC().Unix() / 86400
	s.mu.Lock()
	defer s.mu.Unlock()
	q, ok := m[key]
	if !ok || q.day != day {
		m[key] = &quotaBucket{day: day}
		return true
	}
	return q.bytes < limit
}

func (s *Server) chargeBucket(m map[string]*quotaBucket, key string, n int64) {
	day := time.Now().UTC().Unix() / 86400
	s.mu.Lock()
	defer s.mu.Unlock()
	q, ok := m[key]
	if !ok || q.day != day {
		q = &quotaBucket{day: day}
		m[key] = q
	}
	q.bytes += n
}

// gcLoop 定期清掉过期的重放记录和陈旧的配额桶。
// 不清的话，一台长期运行的服务器内存会随着见过的随机数无限增长。
func (s *Server) gcLoop() {
	defer s.wg.Done()
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			now := time.Now()
			day := now.UTC().Unix() / 86400
			s.mu.Lock()
			for k, exp := range s.seen {
				if now.After(exp) {
					delete(s.seen, k)
				}
			}
			for _, m := range []map[string]*quotaBucket{s.used, s.ipUsed} {
				for k, q := range m {
					if q.day != day {
						delete(m, k)
					}
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) logf(format string, args ...any) {
	s.cfg.Logger.Printf("[汇合点] "+format, args...)
}
