package crypto

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/flynn/noise"
)

const (
	// Noise 单条消息上限 65535 字节，扣掉 16 字节 AEAD tag。
	maxNoisePlaintext = 65535 - 16
	maxHandshakeMsg   = 4096
)

// Prologue 参与握手哈希。把协议名和双方 device_id 绑进去，
// 使得为设备 A 生成的握手无法被重放到设备 B。
func Prologue(protoName, initiatorID, responderID string) []byte {
	return []byte(protoName + "|" + initiatorID + "|" + responderID)
}

// HandshakeResult 是握手完成后的产物。
type HandshakeResult struct {
	send          *noise.CipherState
	recv          *noise.CipherState
	PeerStatic    []byte // 对端 X25519 静态公钥，用于查信任列表
	HandshakeHash []byte // 用于派生 SAS
	PeerPayload   []byte // 对端在握手中携带的业务载荷（IK 的 0.5-RTT 数据）
}

// StaticKey 把 32 字节私钥/公钥对包成 noise 需要的形式。
func StaticKey(priv, pub [32]byte) noise.DHKey {
	return noise.DHKey{Private: priv[:], Public: pub[:]}
}

// HandshakeIKInitiator 执行 Noise_IK 发起方（已知对端静态公钥，用于重连）。
// IK 的 msg1 就带加密载荷（0.5-RTT），对端一收到即可回业务数据，是"重连快"的第一根支柱。
func HandshakeIKInitiator(rw io.ReadWriter, static noise.DHKey, peerStatic, prologue, payload []byte) (*HandshakeResult, error) {
	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   Suite(),
		Pattern:       noise.HandshakeIK,
		Initiator:     true,
		Prologue:      prologue,
		StaticKeypair: static,
		PeerStatic:    peerStatic,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 IK 握手: %w", err)
	}

	msg1, _, _, err := hs.WriteMessage(nil, payload)
	if err != nil {
		return nil, fmt.Errorf("IK msg1: %w", err)
	}
	if err := writeHandshakeMsg(rw, msg1); err != nil {
		return nil, err
	}

	msg2, err := readHandshakeMsg(rw)
	if err != nil {
		return nil, err
	}
	peerPayload, cs0, cs1, err := hs.ReadMessage(nil, msg2)
	if err != nil {
		return nil, fmt.Errorf("IK msg2: %w", err)
	}
	return &HandshakeResult{
		send: cs0, recv: cs1,
		PeerStatic:    hs.PeerStatic(),
		HandshakeHash: hs.ChannelBinding(),
		PeerPayload:   peerPayload,
	}, nil
}

// HandshakeIKResponder 执行 Noise_IK 响应方。verify 在拿到对端静态公钥和 0.5-RTT 载荷后被调用，查信
// 任列表并决定回什么。
// 返回错误则中止握手，此时不得给对方任何有区分性的错误信息，否则可被用来枚举哪些设备被信任。
func HandshakeIKResponder(rw io.ReadWriter, static noise.DHKey, prologue []byte,
	verify func(peerStatic, peerPayload []byte) (replyPayload []byte, err error)) (*HandshakeResult, error) {

	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   Suite(),
		Pattern:       noise.HandshakeIK,
		Initiator:     false,
		Prologue:      prologue,
		StaticKeypair: static,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 IK 握手: %w", err)
	}

	msg1, err := readHandshakeMsg(rw)
	if err != nil {
		return nil, err
	}
	peerPayload, _, _, err := hs.ReadMessage(nil, msg1)
	if err != nil {
		return nil, fmt.Errorf("IK msg1: %w", err)
	}

	reply, err := verify(hs.PeerStatic(), peerPayload)
	if err != nil {
		return nil, err
	}

	msg2, cs0, cs1, err := hs.WriteMessage(nil, reply)
	if err != nil {
		return nil, fmt.Errorf("IK msg2: %w", err)
	}
	if err := writeHandshakeMsg(rw, msg2); err != nil {
		return nil, err
	}
	// 响应方拿到的 cs0 是对端的发送方向，故本地 recv=cs0、send=cs1。
	return &HandshakeResult{
		send: cs1, recv: cs0,
		PeerStatic:    hs.PeerStatic(),
		HandshakeHash: hs.ChannelBinding(),
		PeerPayload:   peerPayload,
	}, nil
}

// HandshakeXXInitiator 执行 Noise_XX 发起方（首次配对，互不知道对方公钥）。
// commitHash 在 msg1 明文里发出（此时还没有密钥），实现提交-揭示。
func HandshakeXXInitiator(rw io.ReadWriter, static noise.DHKey, prologue []byte,
	msg1Payload []byte, msg3Payload func(peerMsg2Payload []byte) []byte) (*HandshakeResult, error) {

	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   Suite(),
		Pattern:       noise.HandshakeXX,
		Initiator:     true,
		Prologue:      prologue,
		StaticKeypair: static,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 XX 握手: %w", err)
	}

	msg1, _, _, err := hs.WriteMessage(nil, msg1Payload)
	if err != nil {
		return nil, fmt.Errorf("XX msg1: %w", err)
	}
	if err := writeHandshakeMsg(rw, msg1); err != nil {
		return nil, err
	}

	raw2, err := readHandshakeMsg(rw)
	if err != nil {
		return nil, err
	}
	peerPayload, _, _, err := hs.ReadMessage(nil, raw2)
	if err != nil {
		return nil, fmt.Errorf("XX msg2: %w", err)
	}

	msg3, cs0, cs1, err := hs.WriteMessage(nil, msg3Payload(peerPayload))
	if err != nil {
		return nil, fmt.Errorf("XX msg3: %w", err)
	}
	if err := writeHandshakeMsg(rw, msg3); err != nil {
		return nil, err
	}
	return &HandshakeResult{
		send: cs0, recv: cs1,
		PeerStatic:    hs.PeerStatic(),
		HandshakeHash: hs.ChannelBinding(),
		PeerPayload:   peerPayload,
	}, nil
}

// HandshakeXXResponder 执行 Noise_XX 响应方。
func HandshakeXXResponder(rw io.ReadWriter, static noise.DHKey, prologue []byte,
	msg2Payload func(peerMsg1Payload []byte) []byte) (*HandshakeResult, error) {

	hs, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   Suite(),
		Pattern:       noise.HandshakeXX,
		Initiator:     false,
		Prologue:      prologue,
		StaticKeypair: static,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 XX 握手: %w", err)
	}

	raw1, err := readHandshakeMsg(rw)
	if err != nil {
		return nil, err
	}
	p1, _, _, err := hs.ReadMessage(nil, raw1)
	if err != nil {
		return nil, fmt.Errorf("XX msg1: %w", err)
	}

	msg2, _, _, err := hs.WriteMessage(nil, msg2Payload(p1))
	if err != nil {
		return nil, fmt.Errorf("XX msg2: %w", err)
	}
	if err := writeHandshakeMsg(rw, msg2); err != nil {
		return nil, err
	}

	raw3, err := readHandshakeMsg(rw)
	if err != nil {
		return nil, err
	}
	p3, cs0, cs1, err := hs.ReadMessage(nil, raw3)
	if err != nil {
		return nil, fmt.Errorf("XX msg3: %w", err)
	}
	return &HandshakeResult{
		send: cs1, recv: cs0,
		PeerStatic:    hs.PeerStatic(),
		HandshakeHash: hs.ChannelBinding(),
		PeerPayload:   p3, // XX 中 msg1 明文载荷已在 msg2Payload 回调里给了调用方
	}, nil
}

// ---------- 加密记录层 ----------

// SecureConn 把握手结果变成一条可读写字节流的安全通道。
// 记录格式：[u32 密文长度][密文]。每条记录 ≤ 64 KiB 明文（Noise 上限）。
type SecureConn struct {
	rw  io.ReadWriter
	res *HandshakeResult

	wmu sync.Mutex
	rmu sync.Mutex
	buf []byte // 上一条记录解密后未读完的残留

	// 收发各自复用一块缓冲，省掉每条 64 KiB 记录两次分配——大文件一秒钟
	// 有上万条记录，全是 GC 压力。wbuf 受 wmu 保护，rct/rpt 受 rmu 保护。
	wbuf []byte
	rct  []byte
	rpt  []byte
}

func NewSecureConn(rw io.ReadWriter, res *HandshakeResult) *SecureConn {
	return &SecureConn{rw: rw, res: res}
}

func (c *SecureConn) PeerStatic() []byte    { return c.res.PeerStatic }
func (c *SecureConn) HandshakeHash() []byte { return c.res.HandshakeHash }
func (c *SecureConn) PeerPayload() []byte   { return c.res.PeerPayload }

// WriteRecord 加密并发送一条完整记录。超过上限时自动切分为多条。
func (c *SecureConn) WriteRecord(p []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	for len(p) > 0 {
		n := len(p)
		if n > maxNoisePlaintext {
			n = maxNoisePlaintext
		}
		// 长度头和密文拼进同一块缓冲，一次 Write 发完：之前分成两次，
		// 每条记录在 QUIC 流上多一次 4 字节的小写入。
		if cap(c.wbuf) < 4+n+16 {
			c.wbuf = make([]byte, 0, 4+maxNoisePlaintext+16)
		}
		out := c.wbuf[:4]
		rec, err := c.res.send.Encrypt(out, nil, p[:n])
		if err != nil {
			return fmt.Errorf("加密失败: %w", err)
		}
		binary.BigEndian.PutUint32(rec[:4], uint32(len(rec)-4))
		if _, err := c.rw.Write(rec); err != nil {
			return err
		}
		c.wbuf = rec[:0]
		p = p[n:]
	}
	return nil
}

// ReadRecord 读取并解密一条记录。
func (c *SecureConn) ReadRecord() ([]byte, error) {
	return c.readRecord(false)
}

// readRecord 读一条记录并解密。reuse 为 true 时明文放进内部复用缓冲，返回切片只在下次读取前有效，
// 仅限 Read 这类用完才读下一条的调用方；对外的 ReadRecord 始终返回独立新切片。
func (c *SecureConn) readRecord(reuse bool) ([]byte, error) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	var hdr [4]byte
	if _, err := io.ReadFull(c.rw, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > 65535 {
		return nil, fmt.Errorf("记录长度非法: %d", n)
	}
	var ct, dst []byte
	if reuse {
		if c.rct == nil {
			c.rct = make([]byte, 65535)
			c.rpt = make([]byte, 0, 65535)
		}
		ct, dst = c.rct[:n], c.rpt[:0]
	} else {
		ct = make([]byte, n)
	}
	if _, err := io.ReadFull(c.rw, ct); err != nil {
		return nil, err
	}
	pt, err := c.res.recv.Decrypt(dst, nil, ct)
	if err != nil {
		// 解密失败意味着密文被篡改或密钥不同步——不可恢复，必须断开。
		return nil, fmt.Errorf("解密失败（可能被篡改）: %w", err)
	}
	if reuse {
		c.rpt = pt[:0]
	}
	return pt, nil
}

// Read 让 SecureConn 满足 io.Reader，便于上层直接跑帧解析器。
func (c *SecureConn) Read(p []byte) (int, error) {
	if len(c.buf) == 0 {
		// 残留已经读空才会来读下一条，所以明文放在复用缓冲里是安全的。
		rec, err := c.readRecord(true)
		if err != nil {
			return 0, err
		}
		c.buf = rec
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *SecureConn) Write(p []byte) (int, error) {
	if err := c.WriteRecord(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Rekey 前向/后向保密：定期轮换对称密钥，使历史与未来流量在密钥泄露时仍受保护。
func (c *SecureConn) Rekey() {
	c.wmu.Lock()
	c.res.send.Rekey()
	c.wmu.Unlock()
	c.rmu.Lock()
	c.res.recv.Rekey()
	c.rmu.Unlock()
}

var errHandshakeTooBig = errors.New("握手消息过长")

func writeHandshakeMsg(w io.Writer, msg []byte) error {
	if len(msg) > maxHandshakeMsg {
		return errHandshakeTooBig
	}
	var hdr [2]byte
	binary.BigEndian.PutUint16(hdr[:], uint16(len(msg)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(msg)
	return err
}

func readHandshakeMsg(r io.Reader) ([]byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint16(hdr[:])
	if int(n) > maxHandshakeMsg {
		return nil, errHandshakeTooBig
	}
	msg := make([]byte, n)
	if _, err := io.ReadFull(r, msg); err != nil {
		return nil, err
	}
	return msg, nil
}
