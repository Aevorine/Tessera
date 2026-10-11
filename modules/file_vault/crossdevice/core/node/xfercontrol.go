package node

// 传输的暂停/继续/取消。XFER_STATUS（wire.TypeXferStatus，Action = pause|resume|cancel）
// 协议里早已声明却无人收发，用户只能关应用，同时丢掉已传部分。三个设计决定：
// 1. 控制权两端对等：发现传错的往往是接收方，不能只在 offer 弹窗那一下能拒绝。
// 2. 暂停不丢已传块：发送循环停在两块之间，接收端 .cbpart 和位图原样保留，继续时不重发
//    已传字节；取消才丢，留残片只占盘。
// 3. 取消双向广播：谁按取消谁发 XFER_STATUS 给对面，否则对端一直等（发送端等 XFER_DONE，
//    接收端 .cbpart 永留），两边都不报错。

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
)

// ErrTransferCanceled 是任一端取消时返回的错误。单独设哨兵值，让上层区分"传输失败"：
// 用户自己按的取消不该显示成红色错误记录。
var ErrTransferCanceled = errors.New("传输已取消")

// 传输的对外状态。界面直接拿它决定按钮长什么样。
const (
	XferRunning  = "running"
	XferPaused   = "paused"
	XferCanceled = "canceled"
	// XferEnded 表示传输离开注册表（完成、失败或断线）。与 XferCanceled 分开：canceled 要在
	// 历史里记一笔；ended 只是"可从进行中列表移除"，不产生记录，否则每传完一个文件历史就多一条重复。
	XferEnded = "ended"
)

// XferInfo 是一次进行中的传输对外可见的快照。
type XferInfo struct {
	ID         string `json:"id"`
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
	Direction  string `json:"direction"` // send | recv
	Name       string `json:"name"`
	Kind       string `json:"kind"` // file | folder | image
	Total      int64  `json:"total"`
	State      string `json:"state"`
}

// xferCtl 是一次传输的控制块。用 channel 而不用 sync.Cond：发送循环等"继续"时还须能被
// 断线、ctx 取消唤醒，Cond 无法与 select 混用，对端掉线时 goroutine 会永远挂住。
type xferCtl struct {
	id         string
	deviceID   string
	deviceName string
	direction  string
	name       string
	kind       string
	total      int64

	mu       sync.Mutex
	paused   bool
	canceled bool
	resume   chan struct{} // 暂停期间非 nil；继续时关闭
	cancelCh chan struct{}
}

func newXferCtl(id, deviceID, deviceName, direction, name, kind string, total int64) *xferCtl {
	return &xferCtl{
		id: id, deviceID: deviceID, deviceName: deviceName,
		direction: direction, name: name, kind: kind, total: total,
		cancelCh: make(chan struct{}),
	}
}

func (c *xferCtl) info() XferInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := XferRunning
	if c.canceled {
		state = XferCanceled
	} else if c.paused {
		state = XferPaused
	}
	return XferInfo{
		ID: c.id, DeviceID: c.deviceID, DeviceName: c.deviceName,
		Direction: c.direction, Name: c.name, Kind: c.kind,
		Total: c.total, State: state,
	}
}

// Pause 让传输停在下一个块边界。已取消的传输不受影响。
// 返回 true 表示状态真的变了（调用方据此决定要不要通知对端和界面）。
func (c *xferCtl) Pause() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.paused || c.canceled {
		return false
	}
	c.paused = true
	c.resume = make(chan struct{})
	return true
}

// Resume 让暂停中的传输接着走。
func (c *xferCtl) Resume() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.paused || c.canceled {
		return false
	}
	c.paused = false
	close(c.resume)
	c.resume = nil
	return true
}

// Cancel 中止传输。暂停中的传输也要能被取消——否则用户先暂停再取消就卡住了，
// 而"先暂停、再决定不要了"恰恰是最自然的操作顺序。
func (c *xferCtl) Cancel() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.canceled {
		return false
	}
	c.canceled = true
	close(c.cancelCh)
	if c.paused {
		c.paused = false
		close(c.resume)
		c.resume = nil
	}
	return true
}

func (c *xferCtl) Canceled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.canceled
}

// Gate 在发送每个块之前调用：没暂停立即返回，暂停则在此等待。四个出口缺一不可
// （继续、取消、ctx 结束、连接断开），否则对应场景下发送 goroutine 永久挂住，
// 表现为"传输卡在 37% 不动，没有报错"。
func (c *xferCtl) Gate(ctx context.Context, done <-chan struct{}) error {
	for {
		c.mu.Lock()
		if c.canceled {
			c.mu.Unlock()
			return ErrTransferCanceled
		}
		paused, ch := c.paused, c.resume
		c.mu.Unlock()
		if !paused {
			return nil
		}
		select {
		case <-ch:
			// 继续，回到循环顶部再确认一次状态（期间可能又被暂停了）
		case <-c.cancelCh:
			return ErrTransferCanceled
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return errors.New("连接已断开")
		}
	}
}

// xferRegistry 是本机所有进行中传输（收发两向）的索引。放在 Node 而非 Session 上：
// 界面的取消只有 transfer_id，不知道也不该知道传输挂在哪条会话。
type xferRegistry struct {
	mu sync.Mutex
	m  map[string]*xferCtl
}

func newXferRegistry() *xferRegistry {
	return &xferRegistry{m: make(map[string]*xferCtl)}
}

func (r *xferRegistry) add(c *xferCtl) {
	r.mu.Lock()
	r.m[c.id] = c
	r.mu.Unlock()
}

func (r *xferRegistry) remove(id string) {
	r.mu.Lock()
	delete(r.m, id)
	r.mu.Unlock()
}

func (r *xferRegistry) get(id string) (*xferCtl, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.m[id]
	return c, ok
}

func (r *xferRegistry) list() []XferInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]XferInfo, 0, len(r.m))
	for _, c := range r.m {
		out = append(out, c.info())
	}
	return out
}

// cancelAllFor 取消某台设备上所有进行中的传输。设备被撤销时调用——
// 撤销之后连接就没了，留着的传输永远等不到对面，只会挂在界面上。
func (r *xferRegistry) cancelAllFor(deviceID string) []*xferCtl {
	r.mu.Lock()
	defer r.mu.Unlock()
	var hit []*xferCtl
	for _, c := range r.m {
		if c.deviceID == deviceID && c.Cancel() {
			hit = append(hit, c)
		}
	}
	return hit
}

// ActiveTransfers 返回所有进行中的传输，供界面重开面板时补齐现状：事件是推送的，
// 错过就没了，而界面每次挂载都是白纸。
func (n *Node) ActiveTransfers() []XferInfo {
	return n.xfers.list()
}

// CancelTransfersFor 取消某台设备上所有进行中的传输。撤销设备时调用。
func (n *Node) CancelTransfersFor(deviceID string) {
	for _, c := range n.xfers.cancelAllFor(deviceID) {
		if c.direction == "recv" {
			if s, ok := n.SessionFor(deviceID); ok {
				s.abortRecvTransfer(c.id, false)
			}
		}
		n.xfers.remove(c.id)
		if s, ok := n.SessionFor(deviceID); ok && s.Alive() {
			s.sendXferStatus(c.id, "cancel")
		}
		n.emitXferState(c)
	}
}

// PauseTransfer 暂停一次传输，并把这个决定告诉对端。
func (n *Node) PauseTransfer(id string) error {
	return n.controlTransfer(id, "pause")
}

// ResumeTransfer 让暂停中的传输继续。
func (n *Node) ResumeTransfer(id string) error {
	return n.controlTransfer(id, "resume")
}

// CancelTransfer 取消一次传输。
func (n *Node) CancelTransfer(id string) error {
	return n.controlTransfer(id, "cancel")
}

func (n *Node) controlTransfer(id, action string) error {
	c, ok := n.xfers.get(id)
	if !ok {
		// 传输可能刚刚自己传完了。这不是错误——用户点得慢一点就会走到这里，
		// 报错只会让界面弹一个没人看得懂的提示。
		return nil
	}
	var changed bool
	switch action {
	case "pause":
		changed = c.Pause()
	case "resume":
		changed = c.Resume()
	case "cancel":
		changed = c.Cancel()
	default:
		return errors.New("未知的传输控制动作: " + action)
	}
	if !changed {
		return nil
	}

	// 取消要负责把接收端的残片清掉：发送端不发了，接收端还留着一个永远等不到
	// 后续块的 .cbpart。这一步在本机这一侧做（如果本机就是接收端）。
	if action == "cancel" {
		if c.direction == "recv" {
			if s, ok := n.SessionFor(c.deviceID); ok {
				s.abortRecvTransfer(c.id, false)
			}
		}
		// 先删注册表，再发状态。接收方取消会同步摘掉控制块；如果先发事件，Android
		// 可能立即刷新 active_transfers 而又把这条已取消任务画回来。
		n.xfers.remove(c.id)
	}

	// 通知对端。发不出去（连接刚断）不算失败：本地已经停了，而重连之后
	// 对端那条传输也会因为连接断开自己收尾。
	if s, ok := n.SessionFor(c.deviceID); ok && s.Alive() {
		s.sendXferStatus(c.id, action)
	}
	n.emitXferState(c)
	return nil
}

// xferRef 造一个只带身份和名字的快照给"结束"类事件。必须带 transfer_id：界面靠它删进度行，
// 「设备+文件名」在重名改名后必然对不上。
func xferRef(id, name, kind string) *XferInfo {
	return &XferInfo{ID: id, Name: name, Kind: kind}
}

// displayNameOf 从清单相对路径取给人看的名字（最后一段）：多级路径整条显示会被截断。
func displayNameOf(relPath string) string {
	s := strings.ReplaceAll(relPath, "\\", "/")
	s = strings.TrimRight(s, "/")
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	if s == "" {
		return relPath
	}
	return s
}

// kindOfTransfer 判断传的是什么，界面据此换图标和措辞。文件夹以 offer 的 Kind 为准
// （只有发送端知道选的是不是目录）；图片按扩展名认，这是不读内容的唯一可靠判据。
func kindOfTransfer(offerKind, relPath string) string {
	if offerKind == "folder" {
		return "folder"
	}
	ext := strings.ToLower(filepath.Ext(displayNameOf(relPath)))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".heic", ".heif", ".avif", ".svg", ".tif", ".tiff":
		return "image"
	case ".apk", ".exe", ".msi", ".ipa", ".appx", ".deb", ".rpm", ".dmg":
		// 安装包按"应用"显示：用户心里它就是一个 App，不是一份普通文件。
		return "app"
	}
	return "file"
}

// emitXferState 把控制动作结果推给界面。必须推送而非让界面猜：对端按的暂停，本机进度也要
// 变成"已暂停"，否则一条不动的进度条与卡死无异。
func (n *Node) emitXferState(c *xferCtl) {
	info := c.info()
	n.emit(Event{
		Kind:     "xfer_state",
		DeviceID: info.DeviceID,
		Msg:      info.State,
		Xfer:     &info,
	})
}
