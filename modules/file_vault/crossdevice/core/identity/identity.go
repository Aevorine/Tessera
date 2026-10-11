// Package identity 实现设备身份：长期密钥、device_id、指纹与恢复码。
// 所有长期密钥由一个 32 字节种子确定性派生，备份种子即可在新设备恢复同一身份。
// 设计见 docs/01-架构与技术原理.md §3。
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

const (
	SeedSize     = 32
	DeviceIDLen  = 26 // base32 字符数
	infoEd25519  = "clipbridge/v1/ed25519"
	infoX25519   = "clipbridge/v1/x25519"
	infoGroupKey = "clipbridge/v1/groupkey"
)

// DeviceType 用于 UI 图标与能力判断。
type DeviceType string

const (
	TypePhone   DeviceType = "phone"
	TypeTablet  DeviceType = "tablet"
	TypePC      DeviceType = "pc"
	TypeUnknown DeviceType = "unknown"
)

// crockford 是 Crockford Base32 字母表：去掉了 I/L/O/U，避免手抄恢复码时看错。
var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// Identity 是本机设备身份。私钥字段永远不应被序列化到明文存储，
// 落盘时只存 seed，且 seed 必须交给 Keystore(Android) / DPAPI(Windows) 保护。
type Identity struct {
	seed [SeedSize]byte

	SignPriv ed25519.PrivateKey // 签名（设备撤销通知、介绍凭据）
	SignPub  ed25519.PublicKey
	DHPriv   [32]byte // Noise 静态密钥
	DHPub    [32]byte

	// Name 是构造时的初始名字。运行中改名必须走 SetName，读取走 DisplayName：
	// 心跳、握手、日志在多个 goroutine 里同时读它，直接赋值是数据竞争。
	Name string
	Type DeviceType

	nameMu  sync.RWMutex
	current string
}

// DisplayName 返回本机当前的显示名。
func (id *Identity) DisplayName() string {
	id.nameMu.RLock()
	defer id.nameMu.RUnlock()
	if id.current != "" {
		return id.current
	}
	return id.Name
}

// SetName 在运行中修改本机显示名。
func (id *Identity) SetName(name string) {
	id.nameMu.Lock()
	id.current = name
	id.nameMu.Unlock()
}

// New 生成一个全新身份。
func New(name string, typ DeviceType) (*Identity, error) {
	var seed [SeedSize]byte
	if _, err := io.ReadFull(rand.Reader, seed[:]); err != nil {
		return nil, fmt.Errorf("生成种子失败: %w", err)
	}
	return FromSeed(seed, name, typ)
}

// FromSeed 由种子确定性派生完整身份：同一 seed 在任何设备得到相同的 device_id 和密钥。
func FromSeed(seed [SeedSize]byte, name string, typ DeviceType) (*Identity, error) {
	id := &Identity{seed: seed, Name: name, Type: typ}

	edSeed, err := derive(seed[:], infoEd25519, ed25519.SeedSize)
	if err != nil {
		return nil, err
	}
	id.SignPriv = ed25519.NewKeyFromSeed(edSeed)
	id.SignPub = id.SignPriv.Public().(ed25519.PublicKey)

	dhSeed, err := derive(seed[:], infoX25519, 32)
	if err != nil {
		return nil, err
	}
	copy(id.DHPriv[:], dhSeed)
	// RFC 7748 clamping：curve25519.X25519 内部会做，但显式做一次让密钥本身规范化，
	// 保证 DHPriv 直接被其他实现使用时也一致。
	id.DHPriv[0] &= 248
	id.DHPriv[31] &= 127
	id.DHPriv[31] |= 64

	pub, err := curve25519.X25519(id.DHPriv[:], curve25519.Basepoint)
	if err != nil {
		return nil, fmt.Errorf("派生 X25519 公钥失败: %w", err)
	}
	copy(id.DHPub[:], pub)

	return id, nil
}

func derive(secret []byte, info string, n int) ([]byte, error) {
	out := make([]byte, n)
	r := hkdf.New(sha256.New, secret, []byte("clipbridge-salt-v1"), []byte(info))
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, fmt.Errorf("HKDF(%s) 失败: %w", info, err)
	}
	return out, nil
}

// Seed 返回种子副本。调用方用完应尽快清零。
func (id *Identity) Seed() [SeedSize]byte { return id.seed }

// DeviceID 是设备的稳定标识：base32(SHA-256(ed25519_pub)) 前 26 字符。
// 用 Crockford 字母表，便于人读、人抄、口述。
func (id *Identity) DeviceID() string { return DeviceIDFromSignPub(id.SignPub) }

// DeviceIDFromSignPub 让对端也能从收到的公钥独立算出同一个 device_id，
// 从而无需信任对方自报的 ID。
func DeviceIDFromSignPub(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return crockford.EncodeToString(sum[:])[:DeviceIDLen]
}

// Fingerprint 返回给人眼核对的短指纹，形如 "K3M8-F2QX-7VBN-4PWD"。
// 它取自 DH 公钥而非签名公钥，因为握手中被中间人替换的正是 DH 公钥。
func Fingerprint(dhPub [32]byte) string {
	sum := sha256.Sum256(dhPub[:])
	s := crockford.EncodeToString(sum[:])[:16]
	return fmt.Sprintf("%s-%s-%s-%s", s[0:4], s[4:8], s[8:12], s[12:16])
}

func (id *Identity) Fingerprint() string { return Fingerprint(id.DHPub) }

// GroupKey 派生"我的设备"组密钥，用于 BLE 可解析轮换标识符与设备名单加密。
// 该密钥在组内共享，因此只由组创建者派生一次后分发。
func (id *Identity) GroupKey() ([32]byte, error) {
	var k [32]byte
	b, err := derive(id.seed[:], infoGroupKey, 32)
	if err != nil {
		return k, err
	}
	copy(k[:], b)
	return k, nil
}

// 恢复码：M1 用 Crockford Base32（32 字节种子 + 4 字节校验 = 58 字符，分 12 组）；
// M5 换 BIP-39 24 词，两者底层同一个种子，可互转。

// ExportRecoveryCode 导出恢复码。**这串字符等同于设备私钥，泄露即设备被冒充。**
func (id *Identity) ExportRecoveryCode() string {
	buf := make([]byte, 0, SeedSize+4)
	buf = append(buf, id.seed[:]...)
	sum := sha256.Sum256(id.seed[:])
	buf = append(buf, sum[:4]...)

	s := crockford.EncodeToString(buf)
	var sb strings.Builder
	for i := 0; i < len(s); i += 5 {
		if i > 0 {
			sb.WriteByte('-')
		}
		end := i + 5
		if end > len(s) {
			end = len(s)
		}
		sb.WriteString(s[i:end])
	}
	return sb.String()
}

var ErrBadRecoveryCode = errors.New("恢复码无效（长度或校验位不对）")

// RestoreFromRecoveryCode 由恢复码还原身份。大小写不敏感，忽略分隔符与空格。
func RestoreFromRecoveryCode(code, name string, typ DeviceType) (*Identity, error) {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r - 32
		case (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z'):
			return r
		default:
			return -1 // 丢弃 '-'、空格、换行
		}
	}, code)

	raw, err := crockford.DecodeString(cleaned)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadRecoveryCode, err)
	}
	if len(raw) != SeedSize+4 {
		return nil, ErrBadRecoveryCode
	}
	var seed [SeedSize]byte
	copy(seed[:], raw[:SeedSize])
	sum := sha256.Sum256(seed[:])
	// 校验位不匹配说明抄错了字符，此时必须报错而不是静默生成一个错误的身份——
	// 否则用户会得到一台"看起来正常但谁也不认识它"的设备。
	for i := 0; i < 4; i++ {
		if raw[SeedSize+i] != sum[i] {
			return nil, ErrBadRecoveryCode
		}
	}
	return FromSeed(seed, name, typ)
}
