package node

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// TCP 直连通道。QUIC 用户态按包收发，Windows 上每个 UDP 包一次系统调用（几十微秒），
// 吞吐被钉在 40~50 MiB/s，跑不满千兆的 119 MiB/s；TCP 有内核分段卸载，同机可超 800 MiB/s。
// 所以局域网直连优先 TCP，QUIC 留给配对、打洞、跨网、中继、IP 迁移。
// 安全不变：此路无 TLS 也不需要，认证和加密本由内层 Noise_IK 完成（QUIC 自签 TLS 从不校验，
// 见 transport/quic.go）；TCP 上跑同一套 Noise 握手、记录层、后量子升级，对端须在信任名单内。
// 兼容：旧对端不认识 TCP 通道会立即拒绝，回落 QUIC；TCP 被防火墙静默丢包时试一次
// （tcpDialTimeout）就记下，之后一阵子不再试。

const (
	// tcpDialTimeout 是 TCP 建连的上限。局域网里正常是毫秒级；被防火墙静默
	// 丢弃时最多白等这么久，然后回落到 QUIC。
	tcpDialTimeout = 1200 * time.Millisecond
	// tcpHandshakeTimeout 是 Noise 握手的上限，防止慢速连接占着不放。
	tcpHandshakeTimeout = 10 * time.Second
	// tcpBackoff 是一次 TCP 失败后，对同一设备多久内不再尝试 TCP。
	tcpBackoff = 5 * time.Minute

	tcpBufSize = 4 << 20 // 套接字收发缓冲
	tcpReadBuf = 256 << 10
)

// tcpStream 把 TCP 连接包成带读缓冲的双向字节流：记录层每条记录读两次（4 字节长度头 +
// 密文），不缓冲则每次一个系统调用。
type tcpStream struct {
	conn net.Conn
	r    *bufio.Reader
}

func newTCPStream(c net.Conn) *tcpStream {
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(10 * time.Second)
		_ = tc.SetReadBuffer(tcpBufSize)
		_ = tc.SetWriteBuffer(tcpBufSize)
	}
	return &tcpStream{conn: c, r: bufio.NewReaderSize(c, tcpReadBuf)}
}

func (t *tcpStream) Read(p []byte) (int, error)  { return t.r.Read(p) }
func (t *tcpStream) Write(p []byte) (int, error) { return t.conn.Write(p) }
func (t *tcpStream) Close() error                { return t.conn.Close() }

// tcpCarrier 把 TCP 连接包成 carrier。
// 结构体里只有一个指针，整体可比较，满足决胜逻辑用 != 判断的要求。
type tcpCarrier struct{ s *tcpStream }

func (c tcpCarrier) Close() error { return c.s.conn.Close() }

// startTCP 在 QUIC 同一端口号上开 TCP 监听。失败（端口被占）只记日志：QUIC 照常，仅少了快路。
func (n *Node) startTCP() {
	if n.cfg.DisableTCP || n.ln == nil {
		return
	}
	host := ""
	if ua, ok := n.ln.Addr().(*net.UDPAddr); ok && ua.IP != nil && !ua.IP.IsUnspecified() {
		host = ua.IP.String()
	}
	addr := net.JoinHostPort(host, strconv.Itoa(n.ln.Port()))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		n.logf("TCP 直连通道未启用（只走 QUIC）: %v", err)
		return
	}
	n.tcpLn = ln
	n.wg.Add(1)
	go n.tcpAcceptLoop(ln)
}

func (n *Node) tcpAcceptLoop(ln net.Listener) {
	defer n.wg.Done()
	for {
		c, err := ln.Accept()
		if err != nil {
			if n.ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			n.logf("TCP 接受连接失败: %v", err)
			select {
			case <-time.After(50 * time.Millisecond):
			case <-n.ctx.Done():
				return
			}
			continue
		}
		n.wg.Add(1)
		go func() {
			defer n.wg.Done()
			n.handleIncomingTCP(c)
		}()
	}
}

// handleIncomingTCP 处理一条拨进来的 TCP 连接：读模式字节，走 Noise_IK 响应方。
// 配对不走这条路（配对要的是 QUIC 那套带过期/一次性语义的流程）。
func (n *Node) handleIncomingTCP(c net.Conn) {
	// 节点关闭时握手中的连接也要跟着断，不然 wg.Wait 会被它卡住。
	stop := context.AfterFunc(n.ctx, func() { _ = c.Close() })
	defer stop()

	st := newTCPStream(c)
	_ = c.SetDeadline(time.Now().Add(tcpHandshakeTimeout))

	var mode [1]byte
	if _, err := io.ReadFull(st, mode[:]); err != nil || mode[0] != modeNormal {
		_ = c.Close()
		return
	}
	car := tcpCarrier{s: st}
	sess, err := n.responderHandshake(st, car, viaInbound)
	if err != nil {
		if !errors.Is(err, errUntrusted) {
			n.logf("TCP 连接握手失败: %v", err)
		}
		_ = c.Close()
		return
	}
	if sess.carrier != car {
		// 同时互拨，这条连接输了决胜；安静关掉它，已有那条继续用。
		_ = c.Close()
		return
	}
	_ = c.SetDeadline(time.Time{})
	sess.run()
}

// tcpUsable 报告对这台设备现在值不值得先试 TCP。
func (n *Node) tcpUsable(deviceID string) bool {
	if n.cfg.DisableTCP {
		return false
	}
	n.tcpMu.Lock()
	defer n.tcpMu.Unlock()
	until, bad := n.tcpBad[deviceID]
	if !bad {
		return true
	}
	if time.Now().After(until) {
		delete(n.tcpBad, deviceID)
		return true
	}
	return false
}

// noteTCPFailure 记一次 TCP 失败：一阵子内不再对这台设备先试 TCP。
func (n *Node) noteTCPFailure(deviceID string) {
	n.tcpMu.Lock()
	if n.tcpBad == nil {
		n.tcpBad = make(map[string]time.Time)
	}
	n.tcpBad[deviceID] = time.Now().Add(tcpBackoff)
	n.tcpMu.Unlock()
}

// clearTCPFailure 在 TCP 成功之后清掉失败记录。
func (n *Node) clearTCPFailure(deviceID string) {
	n.tcpMu.Lock()
	delete(n.tcpBad, deviceID)
	n.tcpMu.Unlock()
}

// dialTCPAndHandshake 经 TCP 拨 addr 并完成 Noise_IK 握手。
// 语义与 dialAndHandshake 的 QUIC 分支一致，包括同时互拨的决胜处理。
func (n *Node) dialTCPAndHandshake(ctx context.Context, peer *store.Peer, addr, via string) (*Session, error) {
	d := net.Dialer{Timeout: tcpDialTimeout}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	// 竞速里别的路赢了、或调用方取消：把握手中的连接直接断掉。
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()

	st := newTCPStream(c)
	car := tcpCarrier{s: st}
	_ = c.SetDeadline(time.Now().Add(tcpHandshakeTimeout))
	ok := false
	defer func() {
		if !ok {
			_ = c.Close()
		}
	}()

	sess, err := n.handshakeOver(ctx, peer, st, car, via)
	if err != nil {
		return nil, err
	}
	if sess.carrier != car {
		// 输了同时互拨的决胜：关掉这条新连接，把已有那条返回给调用方。
		return sess, nil
	}
	_ = c.SetDeadline(time.Time{})
	ok = true
	n.store.RememberAddr(peer.DeviceID, addr)
	go sess.run()
	return sess, nil
}
