package rendezvous

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/transport"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
	"github.com/quic-go/quic-go"
)

// Dialer 指定用哪个套接字连汇合点。不能让 Client 自己开套接字：必须用本机监听的那个端点
// 拨出，服务器看到的源地址才是对外通信的 NAT 映射；另开套接字拿到的公网地址属于另一个映射，
// 拿去打洞必然打空，且不报错、只是永远连不上。
type Dialer interface {
	Dial(ctx context.Context, addr string) (*quic.Conn, error)
}

// ClientConfig 是客户端配置。
type ClientConfig struct {
	// ServerAddr 汇合点服务器地址，形如 "rv.example.com:47820"。空则整个跨网功能关闭。
	ServerAddr string
	Secret     string

	DeviceID string
	SignPriv ed25519.PrivateKey
	SignPub  ed25519.PublicKey

	Dialer Dialer

	// LocalEndpoints 每次报到时现取本机地址。用函数而不是固定值，
	// 是因为换 Wi-Fi 之后内网地址会变，取旧值等于报了个废地址。
	LocalEndpoints func() []Endpoint

	// OnPeer 在对端出现时回调。上层拿它去记地址并立刻发起打洞。
	OnPeer func(token string, pf PeerFound)

	Logger *log.Logger
}

// Client 维持与汇合点服务器的连接，替一组暗号"挂牌"并等对端出现。
type Client struct {
	cfg ClientConfig

	mu       sync.Mutex
	conn     *quic.Conn
	observed string
	relayOK  bool
	watching map[string]context.CancelFunc

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewClient 创建客户端。ServerAddr 为空时返回 nil——
// 上层用 `if c != nil` 判断跨网是否启用，不必到处塞开关。
func NewClient(cfg ClientConfig) *Client {
	if cfg.ServerAddr == "" || cfg.Dialer == nil {
		return nil
	}
	if cfg.Logger == nil {
		cfg.Logger = log.New(log.Writer(), "", log.LstdFlags)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		cfg:      cfg,
		watching: make(map[string]context.CancelFunc),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// ObservedAddr 返回服务器看到的本机公网地址（尚未报到过则为空）。
func (c *Client) ObservedAddr() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.observed
}

// RelayAvailable 报告这台服务器是否开着中继。
func (c *Client) RelayAvailable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.relayOK
}

// Watch 开始为某个暗号挂牌并等待对端。重复调用同一个暗号是幂等的。
func (c *Client) Watch(token string) {
	if !ValidToken(token) {
		return
	}
	c.mu.Lock()
	if _, ok := c.watching[token]; ok {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	c.watching[token] = cancel
	c.mu.Unlock()

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.watchLoop(ctx, token)
	}()
}

// Unwatch 停止为某个暗号挂牌（比如那台设备已经连上了，或者被吊销了）。
func (c *Client) Unwatch(token string) {
	c.mu.Lock()
	cancel, ok := c.watching[token]
	delete(c.watching, token)
	c.mu.Unlock()
	if ok {
		cancel()
	}
}

// Close 关闭客户端。
func (c *Client) Close() error {
	c.cancel()
	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	c.mu.Unlock()
	if conn != nil {
		_ = conn.CloseWithError(0, "")
	}
	c.wg.Wait()
	return nil
}

// NetworkChanged 在网络切换后调用：丢掉旧连接，让各挂牌循环用新地址重连。
// 旧连接绑在已消失的接口上不会报错，只是再也收不到推送（同 discovery 的静默失效）。
func (c *Client) NetworkChanged() {
	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	c.observed = ""
	c.mu.Unlock()
	if conn != nil {
		_ = conn.CloseWithError(0, "网络已切换")
	}
}

// backoff 是连不上服务器时的重试阶梯。服务器挂了是常态（个人自建的机器会重启、
// 会断电），不能因此把 CPU 和流量打满，但也不能退避到用户等半天。
var backoff = []time.Duration{1 * time.Second, 3 * time.Second, 8 * time.Second, 20 * time.Second, 45 * time.Second}

func (c *Client) watchLoop(ctx context.Context, token string) {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		err := c.watchOnce(ctx, token)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			c.logf("暗号 %s… 挂牌中断: %v", token[:4], err)
		}
		d := backoff[min(attempt, len(backoff)-1)]
		attempt++
		select {
		case <-ctx.Done():
			return
		case <-time.After(d):
		}
	}
}

// watchOnce 跑一次完整的挂牌：连服务器 -> 报到 -> 一直收推送直到断开。
func (c *Client) watchOnce(ctx context.Context, token string) error {
	conn, err := c.connect(ctx)
	if err != nil {
		return err
	}
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return err
	}
	rw := transport.StreamRW{Stream: stream}
	defer func() { _ = rw.Close() }()
	wc := wire.NewConn(rw)

	ts := time.Now().UnixMilli()
	nonce, err := newNonce()
	if err != nil {
		return err
	}
	hello := &Hello{
		Token:     token,
		DeviceID:  c.cfg.DeviceID,
		SignPub:   c.cfg.SignPub,
		Endpoints: c.localEndpoints(),
		TS:        ts,
		Nonce:     nonce,
		Sig:       Sign(c.cfg.SignPriv, "hello", token, c.cfg.DeviceID, ts, nonce),
		SecretMAC: SecretMAC(c.cfg.Secret, token, c.cfg.DeviceID, ts, nonce),
	}
	if err := wc.WriteMsg(wire.TypeRvHello, 0, hello); err != nil {
		return err
	}

	for {
		f, err := wc.ReadFrame()
		if err != nil {
			return err
		}
		switch f.Type {
		case wire.TypeRvWelcome:
			var w Welcome
			if err := wire.Unmarshal(f.Payload, &w); err != nil {
				return err
			}
			c.mu.Lock()
			c.observed = w.ObservedAddr
			c.relayOK = w.RelayEnabled
			c.mu.Unlock()
		case wire.TypeRvPeer:
			var pf PeerFound
			if err := wire.Unmarshal(f.Payload, &pf); err != nil {
				return err
			}
			if c.cfg.OnPeer != nil {
				c.cfg.OnPeer(token, pf)
			}
		case wire.TypeRvError:
			var e Error
			_ = wire.Unmarshal(f.Payload, &e)
			// 服务器明确拒绝（口令不对、配额用尽…）就别急着重连硬撞，
			// 让上层的退避把节奏放慢。
			return fmt.Errorf("服务器拒绝: %s", e.Reason)
		default:
			// 不认识的类型直接忽略，方便以后加字段不破坏老客户端。
		}
	}
}

// connect 取一条到服务器的连接，没有就建一条。多个暗号共用同一条连接
// （QUIC 一条连接上可以开很多流），省掉每个对端都跟服务器握一次手。
func (c *Client) connect(ctx context.Context) (*quic.Conn, error) {
	c.mu.Lock()
	if c.conn != nil {
		select {
		case <-c.conn.Context().Done():
			c.conn = nil // 已经断了，重建
		default:
			conn := c.conn
			c.mu.Unlock()
			return conn, nil
		}
	}
	c.mu.Unlock()

	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := c.cfg.Dialer.Dial(dctx, c.cfg.ServerAddr)
	if err != nil {
		return nil, fmt.Errorf("连汇合点服务器 %s 失败: %w", c.cfg.ServerAddr, err)
	}

	c.mu.Lock()
	if c.conn != nil {
		// 有人抢先建好了，用它，把自己这条关掉。
		existing := c.conn
		c.mu.Unlock()
		_ = conn.CloseWithError(0, "duplicate")
		return existing, nil
	}
	c.conn = conn
	c.mu.Unlock()
	return conn, nil
}

// RelayDial 请求服务器把本流和对端的流对接起来，返回一条可直接跑 Noise 的通道。
func (c *Client) RelayDial(ctx context.Context, token string, initiator bool) (io.ReadWriteCloser, error) {
	if !ValidToken(token) {
		return nil, ErrBadToken
	}
	conn, err := c.connect(ctx)
	if err != nil {
		return nil, err
	}
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, err
	}
	rw := transport.StreamRW{Stream: stream}
	ok := false
	defer func() {
		if !ok {
			_ = rw.Close()
		}
	}()

	ts := time.Now().UnixMilli()
	nonce, err := newNonce()
	if err != nil {
		return nil, err
	}
	req := &RelayRequest{
		Token:     token,
		DeviceID:  c.cfg.DeviceID,
		SignPub:   c.cfg.SignPub,
		TS:        ts,
		Nonce:     nonce,
		Sig:       Sign(c.cfg.SignPriv, "relay", token, c.cfg.DeviceID, ts, nonce),
		SecretMAC: SecretMAC(c.cfg.Secret, token, c.cfg.DeviceID, ts, nonce),
		Initiator: initiator,
	}
	wc := wire.NewConn(rw)
	if err := wc.WriteMsg(wire.TypeRvRelay, 0, req); err != nil {
		return nil, err
	}

	f, err := wc.ReadFrame()
	if err != nil {
		return nil, err
	}
	if f.Type == wire.TypeRvError {
		var e Error
		_ = wire.Unmarshal(f.Payload, &e)
		return nil, fmt.Errorf("中继被拒绝: %s", e.Reason)
	}
	if f.Type != wire.TypeRvRelayOK {
		return nil, errors.New("服务器应答不是中继就绪")
	}
	ok = true
	return rw, nil
}

func (c *Client) localEndpoints() []Endpoint {
	if c.cfg.LocalEndpoints == nil {
		return nil
	}
	return NormalizeEndpoints(c.cfg.LocalEndpoints())
}

func newNonce() ([]byte, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func (c *Client) logf(format string, args ...any) {
	c.cfg.Logger.Printf("[跨网] "+format, args...)
}
