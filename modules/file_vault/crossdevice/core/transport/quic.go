// Package transport 提供 QUIC 承载与 Noise 叠加（设计见 docs/01-架构与技术原理.md §5）。
// 双层加密：QUIC/TLS 保护传输，内层 Noise 锚定身份。TLS 证书自签且客户端
// InsecureSkipVerify 是刻意分工，不是漏洞：中间人伪造证书，Noise 握手照样失败。
// 用 Endpoint 而非独立的 Listen()+Dial()：每次现开 socket 拨号会使跨网打洞物理上不可能——
// NAT 只放行本机某端口先发过东西的回包，拨号用临时端口 A 开的洞是 A 的，而对端回连的是监听
// 端口 B，被路由器丢弃，两边都在拨却永远连不上且不报错。所以监听与拨号必须共用同一个 UDP
// 套接字（quic.Transport，QUIC 靠连接 ID 而非四元组区分连接）。同一套接字拨汇合点还使服务器
// 看到的源地址即真实 NAT 映射，直接当 STUN 用。
// 这是全模块唯一的收发口，不要再加回独立的 Dial 自由函数，那会把上述 bug 重新引入。
package transport

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"net"
	"time"

	"github.com/quic-go/quic-go"
)

const (
	ALPN = "clipbridge/1"

	HandshakeTimeout = 8 * time.Second
	MaxIdleTimeout   = 30 * time.Second
	KeepAlivePeriod  = 10 * time.Second
)

// QUICConfig 返回统一的 QUIC 参数。KeepAlivePeriod 在 NAT 映射过期前续命；
// MaxIdleTimeout 决定多久没动静算断线，与心跳配合（10s 心跳 × 3 次容忍 = 30s）。
func QUICConfig() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout:  HandshakeTimeout,
		MaxIdleTimeout:        MaxIdleTimeout,
		KeepAlivePeriod:       KeepAlivePeriod,
		MaxIncomingStreams:    16,
		MaxIncomingUniStreams: 256,

		// 流控窗口放大：quic-go 默认初始 512 KiB、上限 6 MiB 且逐步翻倍，新连接和小文件爬不满速，
		// 高延迟链路上 6 MiB 上限即吞吐天花板。这里只是上限（接收方读得动才占用），不预分配。
		InitialStreamReceiveWindow:     4 << 20,
		MaxStreamReceiveWindow:         32 << 20,
		InitialConnectionReceiveWindow: 8 << 20,
		MaxConnectionReceiveWindow:     48 << 20,
		// 局域网常能跑到 1400+ MTU，开探测能显著提升大文件吞吐。
		DisablePathMTUDiscovery: false,
		Allow0RTT:               true,
	}
}

// ServerTLS 生成自签证书的服务端 TLS 配置。
// 证书只用于建立 QUIC 传输层，身份认证完全由内层 Noise 承担。
func ServerTLS() (*tls.Config, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成临时证书密钥失败: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "clipbridge-transport"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, fmt.Errorf("生成临时证书失败: %w", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: priv}},
		NextProtos:   []string{ALPN},
		MinVersion:   tls.VersionTLS13,
	}, nil
}

// ClientTLS 返回客户端 TLS 配置。InsecureSkipVerify=true 是有意的：对端证书自签且每次不同，
// 真正的身份校验在 Noise 层用静态公钥完成。
func ClientTLS() *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{ALPN},
		MinVersion:         tls.VersionTLS13,
	}
}

// Endpoint 是本机唯一的 UDP 端点：同一套接字既接受也发起连接（原因见文件头部）。
type Endpoint struct {
	udp *net.UDPConn
	tr  *quic.Transport
	ln  *quic.Listener
}

// Open 在 addr（":0"、":47821"、"127.0.0.1:0"）上开端点并监听；传 :0 时用 Port() 取实际端口。
func Open(addr string) (*Endpoint, error) {
	uaddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("解析监听地址 %s 失败: %w", addr, err)
	}
	udp, err := net.ListenUDP("udp", uaddr)
	if err != nil {
		return nil, fmt.Errorf("监听 %s 失败: %w", addr, err)
	}
	tlsConf, err := ServerTLS()
	if err != nil {
		_ = udp.Close()
		return nil, err
	}
	tr := &quic.Transport{Conn: udp}
	ln, err := tr.Listen(tlsConf, QUICConfig())
	if err != nil {
		_ = tr.Close()
		_ = udp.Close()
		return nil, fmt.Errorf("在 %s 上建立 QUIC 监听失败: %w", addr, err)
	}
	return &Endpoint{udp: udp, tr: tr, ln: ln}, nil
}

// Accept 等待一条外来连接。
func (e *Endpoint) Accept(ctx context.Context) (*quic.Conn, error) {
	return e.ln.Accept(ctx)
}

// Dial 从本端点的套接字拨出连接，是全模块唯一的拨号入口，
// 这样 NAT 上打开的洞才落在我们监听的端口上，对端才回得来。
func (e *Endpoint) Dial(ctx context.Context, addr string) (*quic.Conn, error) {
	uaddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("解析地址 %s 失败: %w", addr, err)
	}
	conn, err := e.tr.Dial(ctx, uaddr, ClientTLS(), QUICConfig())
	if err != nil {
		return nil, fmt.Errorf("连接 %s 失败: %w", addr, err)
	}
	return conn, nil
}

// Addr 返回本地监听地址。
func (e *Endpoint) Addr() net.Addr { return e.ln.Addr() }

// Port 返回实际监听端口（传 :0 时用来拿系统分配的端口）。
func (e *Endpoint) Port() int {
	if a, ok := e.ln.Addr().(*net.UDPAddr); ok {
		return a.Port
	}
	return 0
}

// Close 关闭端点。先关监听器再关 Transport，最后关套接字——
// 顺序反了会让还在握手中的连接收到莫名其妙的错误。
func (e *Endpoint) Close() error {
	if e.ln != nil {
		_ = e.ln.Close()
	}
	if e.tr != nil {
		_ = e.tr.Close()
	}
	if e.udp != nil {
		return e.udp.Close()
	}
	return nil
}

// StreamRW 把 QUIC Stream 适配成 io.ReadWriter，使上层不依赖 quic-go 类型，便于换降级通道。
type StreamRW struct {
	*quic.Stream
}

func (s StreamRW) Close() error { return s.Stream.Close() }
