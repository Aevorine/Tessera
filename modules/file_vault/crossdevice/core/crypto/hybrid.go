package crypto

import (
	"crypto/hkdf"
	"crypto/mlkem"
	"crypto/sha256"
	"errors"
	"fmt"
	"slices"

	"github.com/flynn/noise"
)

// 把已建立的 Noise 会话升级为 X25519 + ML-KEM-768 混合会话，防"先存后解"：Noise over X25519 可被
// Shor 破，而本地文件加密无公钥密码学。
// 两边在应用数据流动前完成：发起方发 ML-KEM 公钥，响应方封装共享密钥回密文，两边 HKDF(共享密钥,
// salt=Noise 握手哈希) 派生新收发密钥替换 Noise 传输密钥。
// 新密钥同时依赖 ML-KEM 与 X25519 握手，强度取二者较强者；交换跑在已加密认证的 Noise 通道里，中间人
// 换不掉公钥。
// 选 768 不选 1024：NIST 第 3 类，与 ChaCha20-Poly1305 相称，握手更小（1088 对 1568 字节）；文件容
// 器用 AES-256 配 1024，两处不同是有意的。
const (
	// PQFeature 是在 wire.Hello 的 ProtoFeature 里公布的能力名。两边都公布才升级；老设备不公布则照旧走
	// 纯 X25519，静默降级好过握手失败。
	PQFeature = "pq1"

	pqInfoInitiatorSend = "tessera.pq1.i2r"
	pqInfoResponderSend = "tessera.pq1.r2i"
)

var errPQBadLength = errors.New("对端发来的后量子握手数据长度不对")

// SupportsPQ 判断对端公布的特性里有没有混合握手。
func SupportsPQ(features []string) bool {
	return slices.Contains(features, PQFeature)
}

// UpgradeToHybrid 在 sc 上跑一轮 ML-KEM-768 并换掉双向传输密钥。
// 必须在任何应用数据发出前两边都调用，且 initiator 须与 Noise 握手时的角色一致，否则派生出不同密钥
// ，表现为"连上了但每条消息都解密失败"。
func UpgradeToHybrid(sc *SecureConn, initiator bool) error {
	var shared []byte

	if initiator {
		dk, err := mlkem.GenerateKey768()
		if err != nil {
			return fmt.Errorf("生成 ML-KEM 密钥失败: %w", err)
		}
		if err := sc.WriteRecord(dk.EncapsulationKey().Bytes()); err != nil {
			return fmt.Errorf("发送 ML-KEM 公钥失败: %w", err)
		}
		ct, err := sc.ReadRecord()
		if err != nil {
			return fmt.Errorf("接收 ML-KEM 密文失败: %w", err)
		}
		if len(ct) != mlkem.CiphertextSize768 {
			return errPQBadLength
		}
		shared, err = dk.Decapsulate(ct)
		if err != nil {
			return fmt.Errorf("ML-KEM 解封装失败: %w", err)
		}
	} else {
		pub, err := sc.ReadRecord()
		if err != nil {
			return fmt.Errorf("接收 ML-KEM 公钥失败: %w", err)
		}
		if len(pub) != mlkem.EncapsulationKeySize768 {
			return errPQBadLength
		}
		ek, err := mlkem.NewEncapsulationKey768(pub)
		if err != nil {
			return fmt.Errorf("ML-KEM 公钥无效: %w", err)
		}
		var ct []byte
		shared, ct = ek.Encapsulate()
		if err := sc.WriteRecord(ct); err != nil {
			return fmt.Errorf("发送 ML-KEM 密文失败: %w", err)
		}
	}

	return sc.rekeyHybrid(shared, initiator)
}

// rekeyHybrid 用 ML-KEM 共享密钥和 Noise 握手哈希派生新的双向密钥。
// salt 用握手哈希而非固定串：它把整个 Noise 握手（含双方静态公钥和 prologue 里的 device_id）绑进派
// 生，
// 同一个共享密钥被重放到另一对设备间也派生不出同一把密钥。
func (c *SecureConn) rekeyHybrid(shared []byte, initiator bool) error {
	hh := c.res.HandshakeHash
	i2r, err := hkdf.Key(sha256.New, shared, hh, pqInfoInitiatorSend, 32)
	if err != nil {
		return fmt.Errorf("派生后量子密钥失败: %w", err)
	}
	r2i, err := hkdf.Key(sha256.New, shared, hh, pqInfoResponderSend, 32)
	if err != nil {
		return fmt.Errorf("派生后量子密钥失败: %w", err)
	}

	var sendKey, recvKey [32]byte
	if initiator {
		copy(sendKey[:], i2r)
		copy(recvKey[:], r2i)
	} else {
		copy(sendKey[:], r2i)
		copy(recvKey[:], i2r)
	}

	// nonce 从 0 重新开始是安全的，而且是必须的：密钥是全新的，旧 nonce 计数
	// 跟它没有任何关系。两边都从 0 起，收发才对得上。
	c.wmu.Lock()
	c.res.send = noise.UnsafeNewCipherState(Suite(), sendKey, 0)
	c.wmu.Unlock()
	c.rmu.Lock()
	c.res.recv = noise.UnsafeNewCipherState(Suite(), recvKey, 0)
	c.rmu.Unlock()
	return nil
}
