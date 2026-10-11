// Package rendezvous 实现「汇合点」：不在同一局域网的两台设备互相找到对方的公共集合地。
// 两台设备各在自家 NAT 后面，192.168.x.x 全球无数设备共用，真正的公网地址设备自己也不知道，
// 所以跨网必须有双方都能连上的第三方交换地址，这是 NAT 的物理限制，不是设计取舍。
// 服务器只看得到暗号（每 30 分钟变的随机串）和双方 IP:端口；设备间 Noise 加密（core/crypto）
// 在中继之上，服务器转发的始终是密文，不持有密钥。见 docs/01 §5。
// 无需账号系统：暗号由两把公钥推导（core/node/rendezvous.go 的 HKDF），知道暗号即是弱身份
// 证明，80 bit 空间撞不上。另加三层：
// 1. 签名：每条信令带 Ed25519 签名，覆盖暗号 + 时间戳 + 一次性随机数，偷到暗号也伪造不了应答。
// 2. 时间窗：时间戳超出 ±90 秒丢弃，配合随机数挡重放。
// 3. 可选口令：服务器配 secret 时客户端附 HMAC(secret, ...)，一行字符串即可锁成私用。
// 再加按暗号的每日流量配额（server.go），防止服务器沦为别人的免费流量池（自建中继常见翻车）。
package rendezvous

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// MaxClockSkew 是信令时间戳允许偏离服务器时间的幅度。手机与 VPS 差几十秒很常见，
	// 太严会连不上，太宽给重放留窗口，90 秒是折中。
	MaxClockSkew = 90 * time.Second

	// MaxEndpoints 是一台设备一次可公布的地址上限。正常最多七八条（多网卡 + IPv4/IPv6 + 公网映射）；
	// 限死是防畸形信令撑爆服务器内存。
	MaxEndpoints = 16

	// TokenLen 是暗号长度，与 core/node 里的 rendezvousCodeLen 保持一致。
	TokenLen = 16

	// sigContext 让这个签名不可能在别处被复用。
	sigContext = "tessera.rendezvous.v1"
)

var (
	ErrBadToken     = errors.New("暗号格式不对")
	ErrStaleMessage = errors.New("信令时间戳超出允许范围")
	ErrBadSignature = errors.New("签名校验不通过")
	ErrBadSecret    = errors.New("服务器口令不对")
	ErrQuota        = errors.New("已超出今日中继流量配额")
	ErrRelayBusy    = errors.New("中继并发已满，请稍后重试")
)

// Endpoint 是一个可拨的地址。
type Endpoint struct {
	Addr string `cbor:"1,keyasint"` // ip:port
	// Kind 只用于诊断展示：lan（本机自报的内网地址）/ public（服务器观察到的公网地址）。
	Kind string `cbor:"2,keyasint,omitempty"`
}

// Hello 是客户端向服务器报到的信令。
type Hello struct {
	Token     string     `cbor:"1,keyasint"`
	DeviceID  string     `cbor:"2,keyasint"`
	SignPub   []byte     `cbor:"3,keyasint"`
	Endpoints []Endpoint `cbor:"4,keyasint,omitempty"`
	TS        int64      `cbor:"5,keyasint"` // Unix 毫秒
	Nonce     []byte     `cbor:"6,keyasint"`
	Sig       []byte     `cbor:"7,keyasint"`
	// SecretMAC 在服务器配了口令时必填。
	SecretMAC []byte `cbor:"8,keyasint,omitempty"`
}

// Welcome 是服务器应答，核心是告知客户端它的公网地址。等价于一次 STUN 查询，且用同一个
// UDP 套接字，拿到的映射就是对外通信所用的，比问公共 STUN 更准。
type Welcome struct {
	ObservedAddr string `cbor:"1,keyasint"`
	ServerTS     int64  `cbor:"2,keyasint"`
	RelayEnabled bool   `cbor:"3,keyasint"`
}

// PeerFound 是"同暗号的另一方出现了"的推送。
type PeerFound struct {
	Token     string     `cbor:"1,keyasint"`
	DeviceID  string     `cbor:"2,keyasint"`
	Endpoints []Endpoint `cbor:"3,keyasint"`
	// PunchAt 是服务器给双方约定的同时打洞时刻（Unix 毫秒）。
	// 两边都按服务器的时钟对表，避免各自时钟不准导致错开。
	PunchAt int64 `cbor:"4,keyasint,omitempty"`
}

// RelayRequest 请求服务器把本流与同暗号的另一条流对接起来。
type RelayRequest struct {
	Token     string `cbor:"1,keyasint"`
	DeviceID  string `cbor:"2,keyasint"`
	SignPub   []byte `cbor:"3,keyasint"`
	TS        int64  `cbor:"4,keyasint"`
	Nonce     []byte `cbor:"5,keyasint"`
	Sig       []byte `cbor:"6,keyasint"`
	SecretMAC []byte `cbor:"7,keyasint,omitempty"`
	// Initiator 为真表示这一端发起 Noise 握手。两端必须恰有一个 true，由 device_id 字典序
	// （小者发起）决定，两边独立算出一致，无需再协商。
	Initiator bool `cbor:"8,keyasint"`
}

// RelayReady 表示对接完成，此后这条流上跑的是双方之间的密文，服务器只做搬运。
type RelayReady struct {
	PeerDeviceID string `cbor:"1,keyasint"`
}

// Error 是服务器的拒绝应答。
type Error struct {
	Reason string `cbor:"1,keyasint"`
}

// ValidToken 检查暗号格式。服务器不认识暗号的含义，只把它当不透明字符串，
// 但仍然要卡长度和字符集——否则暗号可以被当成注入载体或用来撑爆内存。
func ValidToken(t string) bool {
	if len(t) != TokenLen {
		return false
	}
	for i := 0; i < len(t); i++ {
		c := t[i]
		// base32 标准字母表：A-Z 与 2-7。
		if (c >= 'A' && c <= 'Z') || (c >= '2' && c <= '7') {
			continue
		}
		return false
	}
	return true
}

// signingBytes 拼出被签名的字节串。字段间必须用长度前缀分隔：`token="AB" nonce="C"` 与
// `token="A" nonce="BC"` 直接拼接结果相同，攻击者可把一条消息的签名搬到另一条上。
func signingBytes(kind, token, deviceID string, ts int64, nonce []byte) []byte {
	var buf []byte
	put := func(b []byte) {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(b)))
		buf = append(buf, l[:]...)
		buf = append(buf, b...)
	}
	put([]byte(sigContext))
	put([]byte(kind))
	put([]byte(token))
	put([]byte(deviceID))
	var tsb [8]byte
	binary.BigEndian.PutUint64(tsb[:], uint64(ts))
	put(tsb[:])
	put(nonce)
	return buf
}

// Sign 用设备的 Ed25519 身份私钥给一条信令签名。
func Sign(priv ed25519.PrivateKey, kind, token, deviceID string, ts int64, nonce []byte) []byte {
	return ed25519.Sign(priv, signingBytes(kind, token, deviceID, ts, nonce))
}

// VerifySig 校验签名。这里没有也不可能校验"公钥是否可信设备"（服务器没有名单，有了就等于
// 知道你有哪些设备）。签名的作用是绑定：保证同一信令流后续消息来自同一私钥持有者，且不能
// 被重放到别处。真正的身份认证在设备间的 Noise 握手。
func VerifySig(pub []byte, sig []byte, kind, token, deviceID string, ts int64, nonce []byte) error {
	if len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), signingBytes(kind, token, deviceID, ts, nonce), sig) {
		return ErrBadSignature
	}
	return nil
}

// SecretMAC 算出服务器口令的证明。服务器没配口令时返回 nil。
func SecretMAC(secret, token, deviceID string, ts int64, nonce []byte) []byte {
	if secret == "" {
		return nil
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(signingBytes("secret", token, deviceID, ts, nonce))
	return m.Sum(nil)
}

// CheckSecret 校验口令证明，用恒定时间比较避免计时侧信道。
func CheckSecret(secret, token, deviceID string, ts int64, nonce, got []byte) error {
	if secret == "" {
		return nil
	}
	want := SecretMAC(secret, token, deviceID, ts, nonce)
	if !hmac.Equal(want, got) {
		return ErrBadSecret
	}
	return nil
}

// CheckFreshness 卡时间窗。
func CheckFreshness(ts int64, now time.Time) error {
	d := now.Sub(time.UnixMilli(ts))
	if d < 0 {
		d = -d
	}
	if d > MaxClockSkew {
		return fmt.Errorf("%w: 偏差 %v", ErrStaleMessage, d.Round(time.Second))
	}
	return nil
}

// NormalizeEndpoints 去重、去空、限长。
func NormalizeEndpoints(in []Endpoint) []Endpoint {
	seen := make(map[string]bool, len(in))
	out := make([]Endpoint, 0, len(in))
	for _, e := range in {
		a := strings.TrimSpace(e.Addr)
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, Endpoint{Addr: a, Kind: e.Kind})
		if len(out) >= MaxEndpoints {
			break
		}
	}
	return out
}
