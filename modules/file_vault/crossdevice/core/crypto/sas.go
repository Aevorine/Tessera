// Package crypto 提供 Noise 握手封装、SAS 短认证串与提交-揭示，设计见 docs/02-配对方案全集.md §1。
package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/flynn/noise"
	"golang.org/x/crypto/hkdf"
)

// Suite 固定为 X25519 + ChaCha20-Poly1305 + SHA-256。
// 刻意不做套件协商——协商就意味着可被降级攻击。换套件 = 升协议主版本。
func Suite() noise.CipherSuite {
	return noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
}

// EmojiTable 是 64 个视觉差异明显、跨平台渲染稳定、不依赖颜色区分的表情，
// 供色盲用户与不识字用户核对 SAS。
var EmojiTable = [64]string{
	"🐼", "🌙", "🚀", "🌲", "🔑", "⚓", "🍎", "🎈",
	"🐘", "🌵", "⚡", "🎸", "🐳", "🍄", "🎁", "🧭",
	"🐝", "🌻", "🔔", "🎯", "🐧", "🍋", "💎", "🪁",
	"🦊", "🌈", "🧊", "🎺", "🐢", "🍇", "🕯", "🪜",
	"🦋", "🌊", "🔥", "🎨", "🐬", "🌰", "🛡", "🧵",
	"🦉", "❄", "🪵", "🎳", "🐙", "🌽", "🔮", "🧲",
	"🦁", "🌍", "⏰", "🎷", "🐍", "🍒", "📎", "🪀",
	"🦓", "☂", "🧱", "🥁", "🐊", "🥕", "📌", "🪞",
}

// SAS 是配对时给人眼核对的短认证串。
type SAS struct {
	Digits string   // 6 位数字，便于电话口述
	Emoji  []string // 6 个表情，便于视觉快速比对
	raw    [5]byte
}

func (s SAS) String() string {
	return fmt.Sprintf("%s  %s", s.Digits, strings.Join(s.Emoji, " "))
}

// Equal 用常数时间比较，避免时序侧信道。
func (s SAS) Equal(o SAS) bool {
	return subtle.ConstantTimeCompare(s.raw[:], o.raw[:]) == 1
}

// DeriveSAS 从 Noise 握手哈希派生 SAS。handshakeHash 只有真正直接握手的双方才相同；
// 有中间人时 A↔M 与 M↔B 是两条独立握手，哈希不同，两端 SAS 不一致，用户可察觉。
// nonceI/nonceR 参与 salt，配合提交-揭示（见 Commit）防止后手方挑公钥去凑哈希。
func DeriveSAS(handshakeHash, nonceI, nonceR []byte) (SAS, error) {
	var s SAS
	salt := make([]byte, 0, len(nonceI)+len(nonceR))
	salt = append(salt, nonceI...)
	salt = append(salt, nonceR...)

	r := hkdf.New(sha256.New, handshakeHash, salt, []byte("ClipBridge-SAS-v1"))
	if _, err := io.ReadFull(r, s.raw[:]); err != nil {
		return s, fmt.Errorf("派生 SAS 失败: %w", err)
	}

	// 取前 20 bit 做 6 位十进制。前 3 字节共 24 bit，右移 4 位取高 20 bit。
	v := uint32(s.raw[0])<<16 | uint32(s.raw[1])<<8 | uint32(s.raw[2])
	s.Digits = fmt.Sprintf("%06d", (v>>4)%1000000)

	// 5 字节 = 40 bit，每 6 bit 取一个表情，可取 6 个（36 bit）。
	var bits uint64
	for i := 0; i < 5; i++ {
		bits = bits<<8 | uint64(s.raw[i])
	}
	s.Emoji = make([]string, 6)
	for i := 0; i < 6; i++ {
		idx := (bits >> uint(40-6*(i+1))) & 0x3F
		s.Emoji[i] = EmojiTable[idx]
	}
	return s, nil
}

// 提交-揭示：单纯的 SAS 允许后手方看到先手方公钥后挑自己的公钥凑哈希；让先手方先发出对公钥的哈希承
// 诺即堵死此路。

const NonceSize = 16

// Commitment 是先手方对"我将要用的临时公钥"的承诺。
type Commitment struct {
	Hash  [32]byte
	nonce [NonceSize]byte
	value []byte
}

// NewCommitment 对 value（通常是临时公钥）生成承诺。
func NewCommitment(value []byte) (*Commitment, error) {
	c := &Commitment{value: append([]byte(nil), value...)}
	if _, err := io.ReadFull(rand.Reader, c.nonce[:]); err != nil {
		return nil, fmt.Errorf("生成 nonce 失败: %w", err)
	}
	c.Hash = commitHash(c.value, c.nonce[:])
	return c, nil
}

// Reveal 返回揭示阶段要发送的 (value, nonce)。
func (c *Commitment) Reveal() (value, nonce []byte) {
	return c.value, c.nonce[:]
}

func (c *Commitment) Nonce() []byte { return c.nonce[:] }

var ErrCommitMismatch = errors.New("承诺校验失败：对方揭示的值与先前承诺不符（可能存在中间人）")

// VerifyCommitment 校验揭示是否与承诺一致。不一致必须立即中止配对并记审计日志。
func VerifyCommitment(hash [32]byte, value, nonce []byte) error {
	got := commitHash(value, nonce)
	if subtle.ConstantTimeCompare(hash[:], got[:]) != 1 {
		return ErrCommitMismatch
	}
	return nil
}

func commitHash(value, nonce []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte("ClipBridge-commit-v1"))
	_ = binary.Write(h, binary.BigEndian, uint32(len(value)))
	h.Write(value)
	h.Write(nonce)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// RandomNonce 生成握手用随机数。
func RandomNonce() ([NonceSize]byte, error) {
	var n [NonceSize]byte
	_, err := io.ReadFull(rand.Reader, n[:])
	return n, err
}

// RandomBytes 生成 n 字节随机数据（一次性令牌、pairing_id、transfer_id 等）。
func RandomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return nil, fmt.Errorf("生成随机数失败: %w", err)
	}
	return b, nil
}
