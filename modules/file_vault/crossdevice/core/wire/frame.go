// Package wire 实现帧层与 CBOR 消息编解码，规范见 docs/04-线协议规范.md §3。
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/fxamacker/cbor/v2"
)

const (
	ProtoVersion = 1
	ProtoName    = "ClipBridge/1"

	// ClipXferFeature 经 Hello.ProtoFeature 协商：双方都公布才走文件传输通道（见 node/clipxfer.go），
	// 单边支持则静默回退旧的 ClipFetch/ClipData，让手机和电脑不必同天升级。
	ClipXferFeature = "clipxfer1"

	// ClipHistFeature：对端认识 CLIP_HISTORY_REQ / CLIP_HISTORY（剪贴板时间线）。
	// 只向公布了它的对端发请求——老版本虽然会忽略未知帧，但白等一次回复没有意义。
	ClipHistFeature = "cliphist1"

	// MaxFrameSize 是控制类帧的上限。控制消息本来就该很小，
	// 卡死这个上限意味着畸形的控制帧最多让我们分配 1 MiB，攻击面很小。
	MaxFrameSize = 1 << 20 // 1 MiB

	// MaxChunkFrameSize 是文件分块帧上限：分块最大 16 MiB（见 transfer 包）加 1 MiB CBOR 头；
	// 与控制帧分开限长，避免控制帧也能塞 17 MiB。
	MaxChunkFrameSize = (16 << 20) + (1 << 20)
)

// maxSizeFor 返回该类型允许的载荷上限。
func maxSizeFor(t Type) uint32 {
	if t == TypeXferChunk {
		return MaxChunkFrameSize
	}
	return MaxFrameSize
}

// Type 是帧类型。
type Type uint8

const (
	TypeHello     Type = 0x01
	TypeHeartbeat Type = 0x02
	TypeAck       Type = 0x03
	TypeError     Type = 0x04

	TypeClipAnnounce Type = 0x10
	TypeClipFetch    Type = 0x11
	TypeClipData     Type = 0x12
	TypeClipRevoke   Type = 0x13

	// TypeContinuity 是「接着刚才」的活动播报（见 messages.go 的 Continuity）；
	// 与剪贴板同属 0x1x 的轻量可丢状态同步，而非 0x2x 的事务性传输。
	TypeContinuity Type = 0x14

	// 剪贴板时间线：向对端要它自己最近复制过的内容摘要（小文本带正文），
	// 让断线期间在别的设备上复制的东西也能在这台设备上翻到、再次粘贴。
	TypeClipHistoryReq Type = 0x15
	TypeClipHistory    Type = 0x16

	TypeXferOffer  Type = 0x20
	TypeXferAccept Type = 0x21
	TypeXferReject Type = 0x22
	TypeXferChunk  Type = 0x23
	TypeXferStatus Type = 0x24
	TypeXferDone   Type = 0x25

	TypeDevRoster Type = 0x30
	TypeDevRevoke Type = 0x31
	TypeDevIntro  Type = 0x32

	// 0x50 段是与**汇合点服务器**之间的信令，不是设备之间的消息。
	// 服务器只看得懂这一段，其余全部是它转发的密文。
	TypeRvHello   Type = 0x50 // 客户端 -> 服务器：我在这儿，这是我的地址们
	TypeRvWelcome Type = 0x51 // 服务器 -> 客户端：我看到你的公网地址是 X
	TypeRvPeer    Type = 0x52 // 服务器 -> 客户端：同暗号的另一方出现了，地址是 Y
	TypeRvRelay   Type = 0x53 // 客户端 -> 服务器：打不通，请帮我转发
	TypeRvRelayOK Type = 0x54 // 服务器 -> 客户端：已配对，此后本流是裸字节管道
	TypeRvError   Type = 0x55 // 服务器 -> 客户端：拒绝，附原因

	TypePairHello    Type = 0x40
	TypePairPake1    Type = 0x41
	TypePairPake2    Type = 0x42
	TypePairSASReady Type = 0x43
	TypePairConfirm  Type = 0x44
	TypePairAbort    Type = 0x45
	TypePairDone     Type = 0x46
)

var typeNames = map[Type]string{
	TypeHello: "HELLO", TypeHeartbeat: "HEARTBEAT", TypeAck: "ACK", TypeError: "ERROR",
	TypeClipAnnounce: "CLIP_ANNOUNCE", TypeClipFetch: "CLIP_FETCH",
	TypeClipData: "CLIP_DATA", TypeClipRevoke: "CLIP_REVOKE",
	TypeContinuity:     "CONTINUITY",
	TypeClipHistoryReq: "CLIP_HISTORY_REQ", TypeClipHistory: "CLIP_HISTORY",
	TypeXferOffer: "XFER_OFFER", TypeXferAccept: "XFER_ACCEPT", TypeXferReject: "XFER_REJECT",
	TypeXferChunk: "XFER_CHUNK", TypeXferStatus: "XFER_STATUS", TypeXferDone: "XFER_DONE",
	TypeDevRoster: "DEV_ROSTER", TypeDevRevoke: "DEV_REVOKE", TypeDevIntro: "DEV_INTRO",
	TypePairHello: "PAIR_HELLO", TypePairPake1: "PAIR_PAKE1", TypePairPake2: "PAIR_PAKE2",
	TypePairSASReady: "PAIR_SAS_READY", TypePairConfirm: "PAIR_CONFIRM",
	TypePairAbort: "PAIR_ABORT", TypePairDone: "PAIR_DONE",
	TypeRvHello: "RV_HELLO", TypeRvWelcome: "RV_WELCOME", TypeRvPeer: "RV_PEER",
	TypeRvRelay: "RV_RELAY", TypeRvRelayOK: "RV_RELAY_OK", TypeRvError: "RV_ERROR",
}

func (t Type) String() string {
	if n, ok := typeNames[t]; ok {
		return n
	}
	return fmt.Sprintf("UNKNOWN(0x%02x)", uint8(t))
}

// Flags 位定义。
type Flags uint8

const (
	FlagFin    Flags = 1 << 0 // 逻辑消息的最后一帧
	FlagComp   Flags = 1 << 1 // payload 已压缩
	FlagAckReq Flags = 1 << 2 // 需要对端回 ACK
	FlagUrgent Flags = 1 << 3 // 优先投递
)

func (f Flags) Has(x Flags) bool { return f&x != 0 }

// Frame 是线上的一帧。
type Frame struct {
	Type    Type
	Flags   Flags
	Payload []byte
}

var (
	ErrFrameTooBig = errors.New("帧超过最大长度")
	ErrBadFlags    = errors.New("帧标志位含未定义位")
)

// Encode 把帧写入 w。
func (f *Frame) Encode(w io.Writer) error {
	if uint32(len(f.Payload)) > maxSizeFor(f.Type) {
		return fmt.Errorf("%w: %s 帧 %d 字节", ErrFrameTooBig, f.Type, len(f.Payload))
	}
	var hdr [6]byte
	hdr[0] = byte(f.Type)
	hdr[1] = byte(f.Flags)
	binary.BigEndian.PutUint32(hdr[2:], uint32(len(f.Payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(f.Payload) > 0 {
		if _, err := w.Write(f.Payload); err != nil {
			return err
		}
	}
	return nil
}

// ReadFrame 从 r 读一帧。
func ReadFrame(r io.Reader) (*Frame, error) {
	var hdr [6]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[2:])
	if n > maxSizeFor(Type(hdr[0])) {
		// 不是"读到脏数据就跳过"——长度非法说明流已经不同步或对方在攻击，必须断开。
		return nil, fmt.Errorf("%w: %s 帧 %d 字节", ErrFrameTooBig, Type(hdr[0]), n)
	}
	// bit 4~7 保留，必须为 0；容忍未知位会给未来的降级攻击留口子。
	if hdr[1]&0xF0 != 0 {
		return nil, ErrBadFlags
	}
	f := &Frame{Type: Type(hdr[0]), Flags: Flags(hdr[1])}
	if n > 0 {
		f.Payload = make([]byte, n)
		if _, err := io.ReadFull(r, f.Payload); err != nil {
			return nil, err
		}
	}
	return f, nil
}

// Conn 把 io.ReadWriter 包成带互斥的帧读写通道。
type Conn struct {
	rw  io.ReadWriter
	wmu sync.Mutex
	rmu sync.Mutex
}

func NewConn(rw io.ReadWriter) *Conn { return &Conn{rw: rw} }

func (c *Conn) WriteFrame(f *Frame) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return f.Encode(c.rw)
}

func (c *Conn) ReadFrame() (*Frame, error) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	return ReadFrame(c.rw)
}

// WriteMsg 序列化 v 为 CBOR 后作为一帧发出。
func (c *Conn) WriteMsg(t Type, flags Flags, v any) error {
	b, err := Marshal(v)
	if err != nil {
		return err
	}
	return c.WriteFrame(&Frame{Type: t, Flags: flags | FlagFin, Payload: b})
}

// encMode 用确定性编码：同样的结构体永远产出同样的字节，
// 这样对消息做哈希/签名才有意义。
var encMode, decMode = func() (cbor.EncMode, cbor.DecMode) {
	em, err := cbor.EncOptions{Sort: cbor.SortCanonical}.EncMode()
	if err != nil {
		panic(err)
	}
	// 未知字段直接忽略——这是协议向前兼容的基础（见 docs/04 §11）。
	dm, err := cbor.DecOptions{
		MaxArrayElements: 1 << 20,
		MaxMapPairs:      1 << 20,
	}.DecMode()
	if err != nil {
		panic(err)
	}
	return em, dm
}()

func Marshal(v any) ([]byte, error) {
	b, err := encMode.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("CBOR 编码失败: %w", err)
	}
	return b, nil
}

func Unmarshal(b []byte, v any) error {
	if err := decMode.Unmarshal(b, v); err != nil {
		return fmt.Errorf("CBOR 解码失败: %w", err)
	}
	return nil
}
