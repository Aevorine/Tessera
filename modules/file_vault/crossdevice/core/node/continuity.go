package node

import (
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

// 「接着刚才」跨设备续做：各设备周期性播报自己在做什么，接收方只记内存、过期即丢。
// 刻意没有权威状态（无同步、冲突解决、落盘）：失败模式必须是"没提示"而非"提示是错的"。

const (
	// ContinuityStaleAfter：过期时间 90 秒。须容得下两次丢包（播报间隔 30 秒，见
	// ContinuityInterval）；过长则电脑关机后仍提示，过短则切个窗口回来提示就没了。
	ContinuityStaleAfter = 90 * time.Second

	// ContinuityInterval 是重播间隔。不做"变了才发"：漏发一次会让对端永久过期，
	// 定期重播幂等，代价仅每 30 秒几十字节。
	ContinuityInterval = 30 * time.Second

	// 标题上限。截断在发送侧做，不指望接收侧——一条 10 MB 的"标题"会撑爆
	// 对端的帧大小限制，表现为整条会话被判协议错误后断开。
	ContinuityTitleMax = 120
)

// ContinuityKind 的取值。用常量而不是散落的字符串字面量：
// 拼错一个字母不会有任何编译错误，只会让某一类提示永远不出现。
const (
	ContinuityKindNone     = "none"
	ContinuityKindNote     = "note"
	ContinuityKindTransfer = "transfer"
)

// ContinuityItem 是一条"某台设备上还有事"的记录。
type ContinuityItem struct {
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	LocalID    string `json:"local_id"`
	Progress   int    `json:"progress"`
	// UpdatedAtMS 是**发出方**的墙钟。两台设备的时钟可能差几秒到几分钟，
	// 所以过期判定不能直接拿它跟本地时钟比——见 receivedAt。
	UpdatedAtMS int64 `json:"updated_at_ms"`

	// receivedAt 是本机收到播报的时刻，过期判定只用它：对端墙钟与本地比较，时钟差几分钟
	// 就会立刻过期或永不过期。
	receivedAt time.Time
}

func (c ContinuityItem) staleAt(now time.Time) bool {
	return now.Sub(c.receivedAt) > ContinuityStaleAfter
}

// continuityShown 报告一条播报是否该展示为「还有一件没做完」。不展示：kind 为 none
// （收回提示）；进度已 100%。旧版手机传完不发 none，只留 100% 帧并每 30 秒重播（刷新
// 过期计时，永不消失），所以接收侧自己挡住，不依赖对端升级。
func continuityShown(kind string, progress int) bool {
	if kind == ContinuityKindNone {
		return false
	}
	if kind == ContinuityKindTransfer && progress >= 100 {
		return false
	}
	return true
}

// transferClaimLive 报告本机 kind=transfer 播报是否仍成立：传输仍在注册表、不是剪贴板
// 内部推送、未到 100%。以守护进程注册表为准，不靠界面记得发 none（界面可能已被回收、
// 事件可能迟到、传输可能掉线无声结束）。
func (n *Node) transferClaimLive(localID string, progress int) bool {
	if progress >= 100 || localID == "" || n.xfers == nil {
		return false
	}
	c, ok := n.xfers.get(localID)
	// 剪贴板正文借文件通道同步（Kind=="clip"）是协议内部的搬运，对用户来说它是
	// "复制了一张图"，不是"一件没做完的事"。
	return ok && c.kind != "clip"
}

// clearTransferContinuity 在某条传输离开注册表时调用：本机正在播报的恰好是它，就立刻收回。
func (n *Node) clearTransferContinuity(transferID string) {
	n.cont.mu.RLock()
	mine, ok := n.cont.mine, n.cont.hasMine
	n.cont.mu.RUnlock()
	if !ok || mine.Kind != ContinuityKindTransfer || mine.LocalID != transferID {
		return
	}
	n.SetContinuity(ContinuityKindNone, "", "", 0)
}

type continuityState struct {
	mu sync.RWMutex
	// 每台设备只保留最新一条。设备上"正在做的事"天然只有一件——同时开五篇笔记
	// 的话，播报的是当前聚焦的那一篇，由上层决定，不在这里堆成列表。
	peers map[string]ContinuityItem

	// mine 是本机当前播报的内容。新会话建立时要立刻补发一次，
	// 否则手机连上电脑之后要等最多 30 秒才看得到提示。
	mine wire.Continuity
	// hasMine 区分"还没设过"和"设过但 Kind 是 none"。前者不该往外发任何东西。
	hasMine bool
}

func newContinuityState() *continuityState {
	return &continuityState{peers: make(map[string]ContinuityItem)}
}

// SetContinuity 设置本机正在做的事并广播给在线设备。调用方不必去重：内容没变就不广播，
// 只更新时间戳。
func (n *Node) SetContinuity(kind, title, localID string, progress int) {
	if kind == "" {
		kind = ContinuityKindNone
	}
	// 传输播报只在传输真在进行时成立。剪贴板正文内部推送和传输结束后的迟到事件都按
	// "没有在做事"处理，不依赖界面发 none。
	if kind == ContinuityKindTransfer && !n.transferClaimLive(localID, progress) {
		kind, title, localID, progress = ContinuityKindNone, "", "", 0
	}
	if len([]rune(title)) > ContinuityTitleMax {
		title = string([]rune(title)[:ContinuityTitleMax])
	}
	msg := wire.Continuity{
		Kind:       kind,
		Title:      title,
		LocalID:    localID,
		Progress:   progress,
		DeviceName: n.id.DisplayName(),
		UpdatedAt:  time.Now().UnixMilli(),
	}

	n.cont.mu.Lock()
	prev := n.cont.mine
	hadPrev := n.cont.hasMine
	n.cont.mine = msg
	n.cont.hasMine = true
	n.cont.mu.Unlock()

	unchanged := hadPrev &&
		prev.Kind == msg.Kind &&
		prev.Title == msg.Title &&
		prev.LocalID == msg.LocalID &&
		prev.Progress == msg.Progress
	if unchanged {
		return
	}
	n.broadcastContinuity(msg)
}

func (n *Node) broadcastContinuity(msg wire.Continuity) {
	for _, s := range n.Sessions() {
		// 单台发失败不影响其他设备，也不上报错误：这是一条提示，
		// 发不出去的正确表现是对端提示自然过期，而不是弹一个"续做同步失败"。
		_ = s.sendContinuity(msg)
	}
}

// continuityLoop 定期重播。见 ContinuityInterval 的说明。
func (n *Node) continuityLoop() {
	defer n.wg.Done()
	ticker := time.NewTicker(ContinuityInterval)
	defer ticker.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.cont.mu.RLock()
			msg, ok := n.cont.mine, n.cont.hasMine
			n.cont.mu.RUnlock()
			if !ok || msg.Kind == ContinuityKindNone {
				continue
			}
			// 重播之前先确认这件事还在。不确认的话，一条已经结束的传输会被每 30 秒
			// 重播一次、不停刷新对端的过期计时，于是永远不会过期。
			if msg.Kind == ContinuityKindTransfer && !n.transferClaimLive(msg.LocalID, msg.Progress) {
				n.SetContinuity(ContinuityKindNone, "", "", 0)
				continue
			}
			msg.UpdatedAt = time.Now().UnixMilli()
			n.broadcastContinuity(msg)
		}
	}
}

// sendContinuityOnConnect 在新会话建立时补发一次，否则手机连上后要干等 30 秒才见提示。
func (n *Node) sendContinuityOnConnect(s *Session) {
	n.cont.mu.RLock()
	msg, ok := n.cont.mine, n.cont.hasMine
	n.cont.mu.RUnlock()
	if !ok || msg.Kind == ContinuityKindNone {
		return
	}
	if msg.Kind == ContinuityKindTransfer && !n.transferClaimLive(msg.LocalID, msg.Progress) {
		return
	}
	_ = s.sendContinuity(msg)
}

// Continuities 返回所有未过期的对端活动，最近更新在前。过期项查询时顺手删除，
// 不另开清理 goroutine，免去与读取的竞争。
func (n *Node) Continuities() []ContinuityItem {
	now := time.Now()
	n.cont.mu.Lock()
	defer n.cont.mu.Unlock()
	out := make([]ContinuityItem, 0, len(n.cont.peers))
	for id, item := range n.cont.peers {
		if item.staleAt(now) {
			delete(n.cont.peers, id)
			continue
		}
		if !continuityShown(item.Kind, item.Progress) {
			continue
		}
		out = append(out, item)
	}
	// 简单插入排序：这个列表的长度等于配对设备数，实际是个位数。
	// 引入 sort 包只为了排三个元素不划算，而且插入排序在这个规模上更快。
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].UpdatedAtMS > out[j-1].UpdatedAtMS; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// dropContinuity 在设备被解除配对或会话彻底关闭时清掉它的提示。
func (n *Node) dropContinuity(deviceID string) {
	n.cont.mu.Lock()
	delete(n.cont.peers, deviceID)
	n.cont.mu.Unlock()
}

// ---------- 会话侧 ----------

func (s *Session) sendContinuity(msg wire.Continuity) error {
	// 不要 ACK：这是一条随时可丢、下一轮会重发的状态播报。要 ACK 会让它
	// 占用重传队列，而重传一条 30 秒后就作废的提示是纯浪费。
	return s.wc.WriteMsg(wire.TypeContinuity, 0, &msg)
}

func (s *Session) onContinuity(f *wire.Frame) error {
	var msg wire.Continuity
	if err := wire.Unmarshal(f.Payload, &msg); err != nil {
		return err
	}
	name := msg.DeviceName
	if name == "" {
		name = s.PeerName()
	}
	item := ContinuityItem{
		DeviceID:    s.peer.DeviceID,
		DeviceName:  name,
		Kind:        msg.Kind,
		Title:       msg.Title,
		LocalID:     msg.LocalID,
		Progress:    msg.Progress,
		UpdatedAtMS: msg.UpdatedAt,
		receivedAt:  time.Now(),
	}

	n := s.node
	n.cont.mu.Lock()
	if !continuityShown(msg.Kind, msg.Progress) {
		delete(n.cont.peers, s.peer.DeviceID)
	} else {
		n.cont.peers[s.peer.DeviceID] = item
	}
	n.cont.mu.Unlock()

	// 事件只带 DeviceID，界面再调 Continuities() 取完整列表；Event 是所有事件共用的结构，
	// 不为单一事件加字段。
	n.emit(Event{Kind: "continuity", DeviceID: s.peer.DeviceID, Msg: msg.Kind})
	return nil
}
