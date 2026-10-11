// Package pairing 实现配对：二维码载荷、一次性令牌、配对状态机与 SAS 确认。
// 设计见 docs/02-配对方案全集.md。
package pairing

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

const (
	// QRTTL 同时管二维码和「配对码」文本（同一载荷的两种呈现）。原 60 秒让配对码路径完全
	// 不可用：二维码当场扫，一分钟够；配对码要复制再送到另一台设备（416 字符，只能传不能手打）。
	// 放宽到 5 分钟的安全依据：令牌一次性（`n.tokens` 登记，用掉或撤销即失效），且二维码和
	// 配对码都强制 SAS 人眼核对（Method.RequiresSAS）；挡中间人的是 SAS，不是窗口多短。
	QRTTL   = 5 * time.Minute
	CodeTTL = 120 * time.Second
	LinkTTL = 10 * time.Minute

	// 二维码里最多放 3 个地址提示。放多了会让二维码版本升高，
	// 识别速度明显变慢——这是实测出来的取舍，不要随意放宽。
	MaxEndpointHints = 3
)

// Method 是配对方式，决定信任默认值与是否强制 SAS。
type Method string

const (
	MethodQR     Method = "qr"
	MethodCode   Method = "code"
	MethodNearby Method = "nearby"
	MethodNFC    Method = "nfc"
	MethodUSB    Method = "usb"
	MethodLink   Method = "link"
	MethodSound  Method = "sound"
	MethodShake  Method = "shake"
	MethodIntro  Method = "intro"
)

// RequiresSAS 判断该方式是否必须人眼确认。二维码/NFC/USB 是物理可信信道，理论上可省，
// 但仍默认开，因为挡不住扫到别人屏幕上假码的社工攻击；附近设备/链接/声波的设备名可伪造，
// SAS 绝不可省。
func (m Method) RequiresSAS() bool {
	switch m {
	case MethodUSB, MethodNFC:
		return false
	default:
		return true
	}
}

// DefaultTrust 返回该方式默认允许的最高信任等级。
func (m Method) DefaultTrust() string {
	switch m {
	case MethodLink, MethodSound:
		// 这两条信道攻击面明显更大（IM 服务商可见 / 声波会穿墙），
		// 因此禁止直接配成长期设备，用户想升级必须走另一条方式再配一次。
		return TrustTemp
	default:
		return TrustLong
	}
}

const (
	TrustLong = "long"
	TrustTemp = "temp"
)

// Hotspot 是无路由器场景下随二维码一起下发的热点凭据。
type Hotspot struct {
	SSID string `cbor:"1,keyasint"`
	PSK  string `cbor:"2,keyasint"`
}

// QRPayload 是二维码/NFC/深链接共用的配对引导数据。只放公钥，绝不放私钥或长期口令：
// 二维码可能被偷拍、录屏、转发；公钥泄露无害，一次性令牌用一次即废。
type QRPayload struct {
	Ver       int    `cbor:"1,keyasint"`
	Kind      string `cbor:"2,keyasint"` // "pair"
	PairingID []byte `cbor:"3,keyasint"`
	DeviceID  string `cbor:"4,keyasint"`
	DHPub     []byte `cbor:"5,keyasint"`

	// NearbyFPPfx 仅用于「附近设备」配对：mDNS 公布的公钥指纹前缀。不参与二维码编解码，
	// 只在进程内从发现层传到握手校验。
	NearbyFPPfx []byte   `cbor:"-" json:"-"`
	SignPub     []byte   `cbor:"6,keyasint"`
	Name        string   `cbor:"7,keyasint"`
	Type        string   `cbor:"8,keyasint"`
	Token       []byte   `cbor:"9,keyasint"`
	Endpoints   []string `cbor:"10,keyasint,omitempty"`
	BLEHint     string   `cbor:"11,keyasint,omitempty"`
	Hotspot     *Hotspot `cbor:"12,keyasint,omitempty"`
	ExpiresAt   int64    `cbor:"13,keyasint"`
	Mode        string   `cbor:"14,keyasint"`
	TTLSec      int64    `cbor:"15,keyasint,omitempty"`
}

var (
	ErrExpired      = errors.New("配对码已过期")
	ErrBadPayload   = errors.New("配对码格式不正确")
	ErrTokenUsed    = errors.New("配对码已被使用过")
	ErrTokenUnknown = errors.New("配对码不存在或已作废")
	ErrWrongVersion = errors.New("配对码版本不兼容，请升级两端应用")
)

// NewQRPayload 生成一份配对引导数据及其一次性令牌。
func NewQRPayload(id *identity.Identity, mode string, ttl time.Duration, endpoints []string, hs *Hotspot) (*QRPayload, error) {
	pid, err := crypto.RandomBytes(16)
	if err != nil {
		return nil, err
	}
	tok, err := crypto.RandomBytes(32)
	if err != nil {
		return nil, err
	}
	if len(endpoints) > MaxEndpointHints {
		endpoints = endpoints[:MaxEndpointHints]
	}
	p := &QRPayload{
		Ver:       wire.ProtoVersion,
		Kind:      "pair",
		PairingID: pid,
		DeviceID:  id.DeviceID(),
		DHPub:     id.DHPub[:],
		SignPub:   id.SignPub,
		Name:      id.DisplayName(),
		Type:      string(id.Type),
		Token:     tok,
		Endpoints: endpoints,
		Hotspot:   hs,
		ExpiresAt: time.Now().Add(ttl).UnixMilli(),
		Mode:      mode,
	}
	if mode == TrustTemp {
		p.TTLSec = int64(ttl / time.Second)
	}
	return p, nil
}

// Encode 编码成可放进二维码的字符串，用 base64url 无填充：字母数字模式不支持小写，
// 字节模式支持，实测比 base45 更通用（各家扫码库都认）。
func (p *QRPayload) Encode() (string, error) {
	b, err := wire.Marshal(p)
	if err != nil {
		return "", err
	}
	return "CB1:" + base64.RawURLEncoding.EncodeToString(b), nil
}

// Decode 解析二维码字符串，并校验版本与有效期。
func Decode(s string) (*QRPayload, error) {
	if len(s) < 4 || s[:4] != "CB1:" {
		return nil, fmt.Errorf("%w: 缺少 CB1 前缀", ErrBadPayload)
	}
	raw, err := base64.RawURLEncoding.DecodeString(s[4:])
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadPayload, err)
	}
	var p QRPayload
	if err := wire.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadPayload, err)
	}
	if p.Ver != wire.ProtoVersion {
		return nil, fmt.Errorf("%w: 收到 v%d，本机 v%d", ErrWrongVersion, p.Ver, wire.ProtoVersion)
	}
	if p.Kind != "pair" {
		return nil, fmt.Errorf("%w: kind=%q", ErrBadPayload, p.Kind)
	}
	if len(p.DHPub) != 32 || len(p.SignPub) != 32 || len(p.Token) == 0 || len(p.PairingID) == 0 {
		return nil, fmt.Errorf("%w: 关键字段缺失", ErrBadPayload)
	}
	// device_id 必须能由 SignPub 独立算出，绝不采信对方自报的 ID。
	if got := identity.DeviceIDFromSignPub(p.SignPub); got != p.DeviceID {
		return nil, fmt.Errorf("%w: device_id 与公钥不匹配", ErrBadPayload)
	}
	if time.Now().UnixMilli() > p.ExpiresAt {
		return nil, ErrExpired
	}
	return &p, nil
}

// DHPubArray 返回定长的 DH 公钥，便于直接喂给 Noise。
func (p *QRPayload) DHPubArray() ([32]byte, error) {
	var k [32]byte
	if len(p.DHPub) != 32 {
		return k, ErrBadPayload
	}
	copy(k[:], p.DHPub)
	return k, nil
}

// Fingerprint 返回该配对码对应设备的人眼指纹，配对界面上应显示出来。
func (p *QRPayload) Fingerprint() string {
	k, err := p.DHPubArray()
	if err != nil {
		return "????"
	}
	return identity.Fingerprint(k)
}

// ---------- 一次性令牌登记簿 ----------

type tokenEntry struct {
	payload   *QRPayload
	expiresAt time.Time
	used      bool
	failures  int
}

// TokenRegistry 是出示方对自己签发配对码的登记簿：过期即拒、用过即废、连续失败即锁。
// 没有它，被拍照的二维码可被反复使用。
type TokenRegistry struct {
	mu sync.Mutex
	m  map[string]*tokenEntry
}

func NewTokenRegistry() *TokenRegistry {
	return &TokenRegistry{m: make(map[string]*tokenEntry)}
}

const maxTokenFailures = 5

func (r *TokenRegistry) Register(p *QRPayload) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gcLocked()
	r.m[string(p.PairingID)] = &tokenEntry{
		payload:   p,
		expiresAt: time.UnixMilli(p.ExpiresAt),
	}
}

// Consume 校验并作废一个令牌。成功返回原始 payload（含 mode/ttl 等配对参数）。
func (r *TokenRegistry) Consume(pairingID, token []byte) (*QRPayload, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gcLocked()

	e, ok := r.m[string(pairingID)]
	if !ok {
		return nil, ErrTokenUnknown
	}
	if time.Now().After(e.expiresAt) {
		delete(r.m, string(pairingID))
		return nil, ErrExpired
	}
	if e.used {
		return nil, ErrTokenUsed
	}
	if !constantTimeEqual(e.payload.Token, token) {
		e.failures++
		if e.failures >= maxTokenFailures {
			// 连续猜错说明有人在暴力尝试，整张码直接作废，逼用户重新生成。
			delete(r.m, string(pairingID))
		}
		return nil, ErrTokenUnknown
	}
	e.used = true
	return e.payload, nil
}

// Revoke 主动作废（用户关闭配对界面、检测到截屏等）。
func (r *TokenRegistry) Revoke(pairingID []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.m, string(pairingID))
}

func (r *TokenRegistry) gcLocked() {
	now := time.Now()
	for k, e := range r.m {
		if now.After(e.expiresAt) {
			delete(r.m, k)
		}
	}
}

func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}
