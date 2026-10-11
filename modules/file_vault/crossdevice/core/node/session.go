package node

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/transfer"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

const (
	heartbeatInterval = 10 * time.Second
	heartbeatMiss     = 3
	fetchTimeout      = 30 * time.Second
)

// carrier 是承载会话的底层通道：直连时是 QUIC 连接，走中继时是到汇合点的流；
// 上层对此无感（docs/01 §L0）。必须是可比较类型，互拨决胜要用 != 判断胜出的是不是我这条。
type carrier interface {
	Close() error
}

// quicCarrier 把 QUIC 连接包成 carrier。
// 结构体里只有一个指针，所以整体可比较，满足上面的要求。
type quicCarrier struct{ conn *quic.Conn }

func (c quicCarrier) Close() error { return c.conn.CloseWithError(0, "") }

type Session struct {
	node      *Node
	peer      *store.Peer
	carrier   carrier
	sc        *crypto.SecureConn
	wc        *wire.Conn
	initiator bool

	// peerFeatures 是对端在握手 HELLO 公布的 ProtoFeature，握手后不变。剪贴板走文件传输通道
	// （wire.ClipXferFeature）看它；老版本不公布，就走 ClipFetch/ClipData 按需拉取。
	peerFeatures []string

	// via 记录会话靠哪条路建起来（缓存地址/局域网发现/公网打洞/中继…），不影响协议，纯给用户看：
	// 走中继时用户有权知道字节经过服务器，也只能靠它回答"为什么慢"。
	via string

	done     chan struct{}
	closeErr error
	once     sync.Once

	seq      atomic.Uint64
	lastRecv atomic.Uint64

	// histAsked：已向对端要过剪贴板时间线、回复还没到。只收要过的回复。
	histAsked atomic.Bool
	name      atomic.Value // string，见 PeerName
	missed    atomic.Int32
	rttMS     atomic.Int64
	// lastEcho 是最近一次收到心跳回声的时刻（UnixNano），probeLiveness 靠它判活。
	lastEcho atomic.Int64
	// lastActive 是最近一次这条连接上有字节流动的时刻（UnixNano）：收到任何一帧，或发出一个
	// 文件块（发块会被流控卡住，写得动说明对端在消费）。心跳判活只认回声，而对端忙着收大块时
	// 回声会晚到，不等于链路断了。
	lastActive atomic.Int64

	// pending 是等待 CLIP_DATA 回应的按需拉取请求。
	pmu     sync.Mutex
	pending map[string]*clipFetch

	// recvXfers 是进行中的接收任务，waiters 是发送端在等的应答，
	// 两者共用 xmu，key 都是 hex(transfer_id)。
	xmu       sync.Mutex
	recvXfers map[string]*recvTransfer
	waiters   map[string]chan *xferReply
}

func (s *Session) Peer() *store.Peer { return s.peer }

// PeerName 返回对端当前的显示名。名字会随心跳更新，所以不放在 s.peer 里原地改
// （那是多个 goroutine 共读的结构），而是单独原子存放。
func (s *Session) PeerName() string {
	if v, ok := s.name.Load().(string); ok && v != "" {
		return v
	}
	return s.peer.Name
}

// SetPeerName 更新对端显示名（心跳改名、用户在本机改备注）。
func (s *Session) SetPeerName(name string) { s.name.Store(name) }

// Via 返回会话靠哪条路建起来的。界面必须显示：走中继时用户有权知道字节经过服务器，
// 也只能靠它判断"慢"是功能坏了还是网络本来如此。
func (s *Session) Via() string { return s.via }

// Route 把 via 归成机器可读的三类，给界面查翻译表：direct / holepunch / relay。
// via 本身是中文短语（日志里直接用），界面拿它当键会把中文漏进另外五种语言。
func (s *Session) Route() string {
	switch s.via {
	case viaRelay:
		return "relay"
	case viaHolePunch:
		return "holepunch"
	}
	return "direct"
}

// preferred 判断互拨时这条连接是否胜出：device_id 字典序较小者作拨号方。两端各自算结果
// 一致，两条并存的连接恰有一条为 true。
func (s *Session) preferred() bool {
	shouldDial := s.node.id.DeviceID() < s.peer.DeviceID
	return s.initiator == shouldDial
}
func (s *Session) RTT() time.Duration {
	return time.Duration(s.rttMS.Load()) * time.Millisecond
}

// Done 在会话结束后关闭。
func (s *Session) Done() <-chan struct{} { return s.done }

// Alive 报告会话是否可用。close() 只关 done 通道，真正从 node.sessions 摘除的是 run() 的
// defer，二者间有窗口，SessionFor() 仍会返回已死的会话，拿到者须自己判断。
func (s *Session) Alive() bool {
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

// Close 主动断开这条会话。若该设备开了 KeepConnected，会立即触发重连竞速。
func (s *Session) Close(reason string) {
	if reason == "" {
		reason = "主动断开"
	}
	s.close(errors.New(reason))
}

func (s *Session) close(err error) {
	s.once.Do(func() {
		s.closeErr = err
		close(s.done)
		if s.carrier != nil {
			_ = s.carrier.Close()
		}
		s.xmu.Lock()
		ended := make([]*recvTransfer, 0, len(s.recvXfers))
		for key, rx := range s.recvXfers {
			// 保留 .cbpart，下次重连就能续传——这正是断点续传的意义。
			_ = rx.recv.Abort(true)
			// 但控制块要摘掉：连接都没了，界面上那条"暂停/取消"按不动，
			// 留着只会让用户对着一个死掉的按钮反复点。
			s.node.xfers.remove(key)
			ended = append(ended, rx)
		}
		s.recvXfers = make(map[string]*recvTransfer)
		s.xmu.Unlock()
		// 通知界面把这几行从"进行中"移除，否则掉线时进度永远停在断开的百分比，续传又新建一条，
		// 同一文件出现两行。在锁外发：emit 会进宿主回调，持 xmu 调外部代码会死锁。
		for _, rx := range ended {
			info := rx.ctl.info()
			info.State = XferEnded
			s.node.emit(Event{Kind: "xfer_state", DeviceID: s.peer.DeviceID, Msg: XferEnded, Xfer: &info})
		}
	})
}

// run 是会话主循环：读帧、分发、维持心跳。
func (s *Session) run() {
	go s.heartbeatLoop()
	defer func() {
		// 先收尾会话，再从 Node 会话索引移除：这样断线瞬间按取消仍能找到接收器并清残片；
		// 反过来先 dropSession 会出现控制块还在而 SessionFor 找不到会话的窗口，取消无声变成保留断点。
		s.close(errors.New("连接结束"))
		s.node.dropSession(s)
	}()

	for {
		f, err := s.wc.ReadFrame()
		if err != nil {
			if err != io.EOF {
				s.node.logf("与 %s 的连接中断: %v", s.PeerName(), err)
			}
			return
		}
		s.touch()
		if err := s.dispatch(f); err != nil {
			s.node.logf("处理 %s 帧出错: %v", f.Type, err)
			// 单条消息处理失败不应拖垮整条连接——除非是解密/帧结构错误，
			// 那种情况 ReadFrame 已经先报错并退出了。
		}
	}
}

func (s *Session) dispatch(f *wire.Frame) error {
	switch f.Type {
	case wire.TypeHeartbeat:
		return s.onHeartbeat(f)
	case wire.TypeClipAnnounce:
		return s.onClipAnnounce(f)
	case wire.TypeClipFetch:
		return s.onClipFetch(f)
	case wire.TypeClipData:
		return s.onClipData(f)
	case wire.TypeContinuity:
		return s.onContinuity(f)
	case wire.TypeClipHistoryReq:
		return s.onClipHistoryReq(f)
	case wire.TypeClipHistory:
		return s.onClipHistory(f)
	case wire.TypeXferOffer:
		return s.onXferOffer(f)
	case wire.TypeXferAccept:
		return s.onXferAccept(f)
	case wire.TypeXferReject:
		return s.onXferReject(f)
	case wire.TypeXferChunk:
		return s.onXferChunk(f)
	case wire.TypeXferStatus:
		return s.onXferStatus(f)
	case wire.TypeXferDone:
		return s.onXferDone(f)
	case wire.TypeAck:
		var ack wire.Ack
		if err := wire.Unmarshal(f.Payload, &ack); err != nil {
			return err
		}
		if len(ack.Ref) > 0 {
			s.node.noteClipAck(s.peer.DeviceID, ack.Ref)
		}
		return nil
	case wire.TypeHello:
		return nil
	case wire.TypeError:
		var e wire.Error
		if err := wire.Unmarshal(f.Payload, &e); err != nil {
			return err
		}
		s.node.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID,
			Msg: e.Msg, Err: fmt.Errorf("对端错误 %d", e.Code)})
		if e.Fatal() {
			s.close(fmt.Errorf("对端致命错误 %d: %s", e.Code, e.Msg))
		}
		return nil
	default:
		// 未知类型直接忽略：这是协议向前兼容的基础，新版本加的消息
		// 不应该让旧版本断开连接。
		return nil
	}
}

// ---------- 心跳 ----------

func (s *Session) heartbeatLoop() {
	t := time.NewTicker(heartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-s.node.ctx.Done():
			return
		case <-t.C:
			if err := s.sendHeartbeat(); err != nil {
				s.close(err)
				return
			}
			missed := s.missed.Add(1)
			if missed >= heartbeatMiss {
				if s.recentlyActive() {
					// 回声没回但连接上字节仍在流动（大文件收发中）：是对端读循环忙，不是链路断。
					// 把计数拉回"差一次"继续观察，真断了 30 秒内不会再有字节，下一轮就会判死。
					s.missed.Store(heartbeatMiss - 1)
					continue
				}
				// 连续 N 次没等到回声、且这段时间里一个字节都没动过，才判定链路已断。
				// 这比等 QUIC 空闲超时快，能更早触发重连竞速。
				s.node.setState(s.peer.DeviceID, StateReconnecting)
				s.close(errors.New("心跳超时"))
				return
			}
			if missed == 2 {
				// 上次心跳整整一个周期无回音：未断但链路明显有问题。DEGRADED 以前只有"恢复"半边，
				// 从没人设进去，界面「信号弱」永远不出现。
				s.node.setState(s.peer.DeviceID, StateDegraded)
			}
		}
	}
}

// touch 记一笔"这条连接刚刚有字节在动"。
func (s *Session) touch() { s.lastActive.Store(time.Now().UnixNano()) }

// recentlyActive 报告最近一个判活窗口（interval × miss）内是否有过字节流动。
func (s *Session) recentlyActive() bool {
	last := s.lastActive.Load()
	return last != 0 && time.Since(time.Unix(0, last)) < heartbeatInterval*heartbeatMiss
}

// sendHeartbeat 发一次心跳（非回声）。
func (s *Session) sendHeartbeat() error {
	return s.wc.WriteMsg(wire.TypeHeartbeat, wire.FlagUrgent, &wire.Heartbeat{
		UnixMS: time.Now().UnixMilli(), Nonce: uint64(time.Now().UnixNano()),
		// 捎带当前设备名，让对端能在不断线的情况下看到改名。
		Name: s.node.id.DisplayName(),
	})
}

// adoptPeerName 记录对端自报的名字，只在真的变化时写盘：心跳每 10 秒一次，每次写盘都是
// 临时文件 + rename 的原子替换。名字只是展示信息，不参与信任（认的是公钥），
// 仅做长度截断，防超长名字撑坏界面或存储。
func (s *Session) adoptPeerName(name string) {
	const maxNameLen = 64
	name = strings.TrimSpace(name)
	if name == "" || name == s.PeerName() {
		return
	}
	if len([]rune(name)) > maxNameLen {
		name = string([]rune(name)[:maxNameLen])
	}
	s.SetPeerName(name)
	p, err := s.node.store.GetPeer(s.peer.DeviceID)
	if err != nil {
		return
	}
	p.Name = name
	if err := s.node.store.PutPeer(p); err != nil {
		s.node.logf("更新对端名字失败: %v", err)
		return
	}
	// 通知 UI 刷新设备列表。不能用 "pair"：界面把它当"刚配对成功"，会收起配对面板、作废正在
	// 显示的短码。
	s.node.emit(Event{Kind: "peer_updated", DeviceID: s.peer.DeviceID})
}

func (s *Session) onHeartbeat(f *wire.Frame) error {
	var hb wire.Heartbeat
	if err := wire.Unmarshal(f.Payload, &hb); err != nil {
		return err
	}
	// 对端可能刚改过名字。这里更新的是"我给这台设备存的名字"，
	// 只在真的变了的时候写盘——心跳每 10 秒一次，每次都写会把存储刷爆。
	s.adoptPeerName(hb.Name)

	if !hb.Echo {
		hb.Echo = true
		// 回声也带上自己的名字，这样**双向**都能同步到改名：
		// 只在发起侧带的话，收到心跳的那一方改了名字，对面永远看不到。
		hb.Name = s.node.id.DisplayName()
		return s.wc.WriteMsg(wire.TypeHeartbeat, wire.FlagUrgent, &hb)
	}
	s.missed.Store(0)
	s.lastEcho.Store(time.Now().UnixNano())
	if rtt := time.Since(time.Unix(0, int64(hb.Nonce))); rtt > 0 && rtt < time.Minute {
		s.rttMS.Store(rtt.Milliseconds())
	}
	if s.node.State(s.peer.DeviceID) == StateDegraded {
		s.node.setState(s.peer.DeviceID, StateConnected)
	}
	return nil
}

// ---------- 剪贴板 ----------

// SendClip 把一条剪贴板内容发给对端（按这台设备的同步范围裁剪，见 clippolicy.go）。
func (s *Session) SendClip(it *clipboard.Item) error {
	_, err := s.sendClipFiltered(it)
	return err
}

// sendClipFiltered 返回的 bool 表示是否真的发了——策略不允许时静默跳过。
func (s *Session) sendClipFiltered(it *clipboard.Item) (bool, error) {
	it = s.node.filterClipFor(s.peer.DeviceID, it)
	if it == nil {
		return false, nil
	}
	if err := s.announce(it); err != nil {
		return false, err
	}
	// 对方支持时 announce 一发出就主动推大表示，不等它来问。旧对端不公布该能力则不做，
	// 它照旧发 ClipFetch，onClipFetch/onClipData 保留给这条回退路径。
	if s.supportsClipXfer() {
		for _, mime := range it.NonInlineReps() {
			go s.pushClipRep(it, mime)
		}
	}
	return true, nil
}

// sendAnnounce 只发 announce，不推送大表示正文（同样按同步范围裁剪）。
func (s *Session) sendAnnounce(it *clipboard.Item) error {
	it = s.node.filterClipFor(s.peer.DeviceID, it)
	if it == nil {
		return nil
	}
	return s.announce(it)
}

func (s *Session) announce(it *clipboard.Item) error {
	a := it.ToAnnounce(s.seq.Add(1), nil)
	s.node.noteClipSent(s.peer.DeviceID, it.ID)
	return s.wc.WriteMsg(wire.TypeClipAnnounce, wire.FlagAckReq, a)
}

func (s *Session) onClipAnnounce(f *wire.Frame) error {
	var a wire.ClipAnnounce
	if err := wire.Unmarshal(f.Payload, &a); err != nil {
		return err
	}
	// 防回环第一道：自己发出去的东西转了一圈回来，丢掉。
	if a.Source == s.node.id.DeviceID() {
		return nil
	}
	// 防回环第二道：同一内容刚交付过（DedupTTL 内）或本机当前就是它。
	// 只确认不交付；用户手动发送（Force）不受这道限制。
	if !a.Force && s.node.alreadyHas(a.ItemID) {
		_ = s.wc.WriteMsg(wire.TypeAck, 0, &wire.Ack{Seq: a.Seq, Ref: a.ItemID})
		return nil
	}
	s.lastRecv.Store(a.Seq)

	it, err := clipboard.FromAnnounce(&a)
	if err != nil {
		s.node.recordClipSyncResult(s.peer, a.ItemID, a.Preferred, false, err.Error())
		return err
	}
	if h, err := clipboard.ParseHLC(a.HLC); err == nil {
		s.node.clock.Observe(h)
	}
	// 本机给这台设备设了同步范围：裁掉不收的表示，一个不剩就只确认不交付。
	// 确认必须回：对端据此停止重连补发，也据此量延迟。
	if it = s.node.filterClipFor(s.peer.DeviceID, it); it == nil {
		_ = s.wc.WriteMsg(wire.TypeAck, 0, &wire.Ack{Seq: a.Seq, Ref: a.ItemID})
		return nil
	}
	if it.Replay {
		if cur := s.node.currentItem(); cur != nil && cur.HLC.After(it.HLC) {
			// 断线期间这边已经有了更新的内容，补发来的旧内容不能把它盖掉。
			// 但它确实是对方复制过的东西：记进时间线，用户想要时还能翻出来再粘贴。
			s.node.recordClipHistory(it, ClipViaSync, "")
			_ = s.wc.WriteMsg(wire.TypeAck, 0, &wire.Ack{Seq: a.Seq, Ref: a.ItemID})
			return nil
		}
	}

	// 只做信号，不做仲裁：这条内容是不是在对方完全不知道我这边现状的情况下
	// 产生的，只播报出去让用户自己判断，不影响下面照常交付。
	s.node.checkClipConflict(s.peer, it)

	missing := it.MissingReps()
	if len(missing) == 0 {
		s.deliverClip(it, a.Seq)
		return nil
	}

	if s.supportsClipXfer() {
		// 对方也支持文件传输通道：它会主动推每个缺的表示，这里只登记"还差哪些"，XFER_DONE 到齐
		// 再交付，不发 CLIP_FETCH。登记带期限：文本已到最多再等 partialClipGrace 就先交付，
		// 首选表示都没到最多等 clipAssemblyTTL。
		s.node.registerPendingClip(s.peer.DeviceID, it, a.Seq, missing)
		return nil
	}

	// 旧对端：保留原有按需拉取路径。拉取必须放到另一个 goroutine：这里是读循环，同步等
	// CLIP_DATA 而它只能由这个读循环收进来，会死锁（连接看似活着却不再动）。
	go func() {
		// 剪贴板项是多表示容器。发布到平台层前先拉全所有公布的表示，免得大 HTML/RTF 因纯文本
		// 是首选传输表示而悄悄降级成纯文本。只要有可用文本，某个表示没到就丢弃它，不拖垮整项。
		for _, mime := range missing {
			r, ok := it.Rep(mime)
			if !ok {
				continue
			}
			data, err := s.fetchRep(it.ID, mime, r.Size)
			if err == nil {
				err = it.SetRepData(mime, data)
			}
			if err != nil {
				s.node.recordClipSyncResult(s.peer, it.ID, mime, false, err.Error())
				if !it.HasUsableText() {
					return
				}
			}
		}
		ready := it.Available()
		if ready == nil {
			return
		}
		s.deliverClip(ready, a.Seq)
	}()
	return nil
}

// deliverClip 把一条完整内容交给平台层写入系统剪贴板，并向发送方确认。
func (s *Session) deliverClip(it *clipboard.Item, seq uint64) {
	s.node.deliverClipItem(s.peer.DeviceID, it, seq)
}

// deliverClipItem 是交付实体：登记去重与回声、更新当前内容、交平台层，最后经该设备当前
// 会话确认。不绑在某个 *Session 上：超时后的部分交付可能发生在原会话已断、新会话已建之后。
func (n *Node) deliverClipItem(deviceID string, it *clipboard.Item, seq uint64) {
	// 登记"已交付"必须在这里而不是收到 announce 时：没交付成功的内容不能挡住重发。
	n.track.Mark(it.ID)
	// 防回环第三道：写入本机剪贴板前登记内容哈希，
	// 本机监听器随后捕获到同样内容时判定为回声，不再广播出去。
	for _, r := range it.Reps {
		if r.Hash != nil {
			n.track.MarkWritten(r.Hash)
		}
	}
	n.setCurrent(it)
	n.recordClipHistory(it, ClipViaSync, "")
	if n.cfg.OnClip != nil {
		n.cfg.OnClip(it)
	}
	n.emit(Event{Kind: "clip", DeviceID: deviceID, Msg: it.Preferred})
	if s, ok := n.SessionFor(deviceID); ok {
		_ = s.wc.WriteMsg(wire.TypeAck, 0, &wire.Ack{Seq: seq, Ref: it.ID})
	}
}

// clipFetch 是一次进行中的有序表示下载。channel 刻意不加大缓冲：TCP/QUIC 自带背压，
// 曾因静默缓冲几块后丢弃余下的，让超过 8 MiB 的表示成功与否变成概率事件。
type clipFetch struct {
	chunks chan *wire.ClipData
	done   chan struct{}
}

func (s *Session) fetchRep(itemID []byte, mime string, expectedSize int64) ([]byte, error) {
	key := hex.EncodeToString(itemID) + "|" + mime
	req := &clipFetch{chunks: make(chan *wire.ClipData), done: make(chan struct{})}
	s.pmu.Lock()
	s.pending[key] = req
	s.pmu.Unlock()
	defer func() {
		s.pmu.Lock()
		delete(s.pending, key)
		s.pmu.Unlock()
		close(req.done)
	}()

	if err := s.wc.WriteMsg(wire.TypeClipFetch, 0, &wire.ClipFetch{ItemID: itemID, Mime: mime}); err != nil {
		return nil, err
	}

	if expectedSize < 0 {
		return nil, errors.New("剪贴板表示长度非法")
	}
	// Do not accept a peer-controlled unbounded allocation. The announce has
	// already authenticated the exact representation size.
	buf := make([]byte, 0, expectedSize)
	var offset int64
	deadline := time.After(fetchTimeout)
	for {
		select {
		case d := <-req.chunks:
			if d.Offset != offset {
				return nil, fmt.Errorf("剪贴板分片乱序或缺失：期望偏移 %d，收到 %d", offset, d.Offset)
			}
			if int64(len(d.Data)) > expectedSize-offset {
				return nil, errors.New("剪贴板分片超过声明长度")
			}
			buf = append(buf, d.Data...)
			offset += int64(len(d.Data))
			if d.IsLast {
				if offset != expectedSize {
					return nil, fmt.Errorf("剪贴板分片长度不完整：期望 %d，收到 %d", expectedSize, offset)
				}
				return buf, nil
			}
		case <-deadline:
			return nil, errors.New("拉取超时")
		case <-s.done:
			return nil, errors.New("连接已断开")
		}
	}
}

func (s *Session) onClipFetch(f *wire.Frame) error {
	var q wire.ClipFetch
	if err := wire.Unmarshal(f.Payload, &q); err != nil {
		return err
	}
	// 同步范围在拉取这条路上也要执行：announce 虽然只带了允许的表示，但条目 ID
	// 是同一个，对端（或一个被改过的客户端）照样可以按 ID 点名要图片。
	if !s.node.clipMimeAllowed(s.peer.DeviceID, q.Mime) {
		return s.wc.WriteMsg(wire.TypeError, 0, &wire.Error{
			Code: wire.ErrCodeRejected, Msg: "按这台设备的同步范围，不提供该内容", Ref: q.ItemID,
		})
	}
	it := s.node.itemForFetch(q.ItemID)
	if it == nil {
		// 短期缓存里没有了，但可能还在时间线上：对端正在「再次粘贴」它。
		it = s.node.ownHistoryItem(q.ItemID)
	}
	if it == nil {
		return s.wc.WriteMsg(wire.TypeError, 0, &wire.Error{
			Code: wire.ErrCodeRejected, Msg: "该内容已过期，无法重新拉取", Ref: q.ItemID,
		})
	}
	r, ok := it.Rep(q.Mime)
	if !ok || r.Data == nil {
		return s.wc.WriteMsg(wire.TypeError, 0, &wire.Error{
			Code: wire.ErrCodeRejected, Msg: "没有该表示", Ref: q.ItemID,
		})
	}

	// 分片发送：单帧上限 1 MiB，大图片要切开。
	const piece = 512 << 10
	data := r.Data
	for off := 0; off < len(data); off += piece {
		end := off + piece
		if end > len(data) {
			end = len(data)
		}
		if err := s.wc.WriteMsg(wire.TypeClipData, 0, &wire.ClipData{
			ItemID: q.ItemID, Mime: q.Mime, Offset: int64(off),
			Data: data[off:end], IsLast: end == len(data),
		}); err != nil {
			return err
		}
	}
	if len(data) == 0 {
		return s.wc.WriteMsg(wire.TypeClipData, 0, &wire.ClipData{
			ItemID: q.ItemID, Mime: q.Mime, IsLast: true,
		})
	}
	return nil
}

func (s *Session) onClipData(f *wire.Frame) error {
	var d wire.ClipData
	if err := wire.Unmarshal(f.Payload, &d); err != nil {
		return err
	}
	key := hex.EncodeToString(d.ItemID) + "|" + d.Mime
	s.pmu.Lock()
	req, ok := s.pending[key]
	s.pmu.Unlock()
	if !ok {
		return nil // 已超时或已取消，丢弃
	}
	select {
	case req.chunks <- &d:
		// fetch goroutine 消费该分片。跟不上时读循环在此等待，让传输层流控减慢发送端；
		// 剪贴板要么完整到达，要么不写。
	case <-req.done:
		// The request timed out or was cancelled between map lookup and send.
	}
	return nil
}

// ---------- 文件传输（接收侧） ----------

type recvTransfer struct {
	id       []byte
	entry    wire.FileEntry
	recv     *transfer.FileReceiver
	fileIdx  int
	manifest []wire.FileEntry
	destDir  string
	done     int
	// chunkSize / totalChunks 来自 offer。进度不能拿当前这一块的长度去推
	// （最后一块是短的），也不能只数这次收到的块（续传时前面的块没再传）。
	chunkSize   int
	totalChunks int

	// ctl 是这次接收在全局注册表里的控制块；display 是给人看的名字
	// （清单条目的基名，不是可能带着多级目录的 RelPath）。
	ctl     *xferCtl
	display string

	// isClip 为 true 时，这不是用户看得见的文件传输，而是剪贴板大表示借这条
	// 通道同步——onXferDone 收完之后要塞回 clipItemID/clipMime 对应的剪贴板
	// 条目，而不是当成"收到一个新文件"报给界面。见 clipxfer.go。
	isClip     bool
	clipItemID []byte
	clipMime   string

	// 进度上报的节流时间戳。跟发送端同理：4 MB 一块、千兆网下一秒几十块，
	// 每块都往 UI 推事件，界面光处理事件就忙不过来。
	lastReport time.Time
	lastDone   int64
	gotChunks  int
}

func (s *Session) onXferOffer(f *wire.Frame) error {
	var o wire.XferOffer
	if err := wire.Unmarshal(f.Payload, &o); err != nil {
		return err
	}

	// 剪贴板正文借这条通道推过来，走完全不同的一条路：不问用户、不落进
	// DownloadDir，收完直接塞回对应的剪贴板条目。见 clipxfer.go。
	if o.Kind == "clip" {
		return s.onClipXferOffer(&o)
	}

	// 文件 offer 必须离开读循环处理。其中有三件慢事：等用户点"接收"（最长两分钟）、读盘比对
	// 秒传、按全长预分配磁盘；而读循环是会话上所有帧的唯一消费者，被占住时心跳回声不回，
	// 发送端三次没等到回声（30 秒）就断连，传输"有时候"失败。
	// 对端收到 XFER_ACCEPT 前不发块，异步处理不会和块帧抢跑。
	go func() {
		if err := s.handleFileOffer(&o); err != nil {
			s.node.logf("处理 %s 的传输请求出错: %v", s.PeerName(), err)
		}
	}()
	return nil
}

// handleFileOffer 处理一个文件 offer：问用户、查秒传、开接收器、回应答。
// 在独立 goroutine 里跑，见 onXferOffer 的说明。
func (s *Session) handleFileOffer(o *wire.XferOffer) error {
	accept, destDir := true, s.node.cfg.DownloadDir
	if s.node.cfg.ConfirmTransfer != nil {
		accept, destDir = s.node.cfg.ConfirmTransfer(TransferOffer{
			TransferID: o.TransferID, From: s.peer.DeviceID, Name: o.Name,
			Kind: o.Kind, FileCount: o.FileCount, TotalSize: o.TotalSize, Files: o.Manifest,
		})
	}
	if !accept {
		return s.wc.WriteMsg(wire.TypeXferReject, 0, &wire.XferReject{
			TransferID: o.TransferID, Code: wire.ErrCodeRejected, Msg: "用户拒绝",
		})
	}
	if destDir == "" {
		destDir = "."
	}

	acc := &wire.XferAccept{TransferID: o.TransferID, DestHint: destDir}
	key := hex.EncodeToString(o.TransferID)

	// M1 一次处理一个文件；多文件在 M2 并行开多条 QUIC 流。
	if len(o.Manifest) == 0 {
		return s.wc.WriteMsg(wire.TypeXferReject, 0, &wire.XferReject{
			TransferID: o.TransferID, Code: wire.ErrCodeRejected, Msg: "清单为空",
		})
	}
	entry := o.Manifest[0]

	// 路径安全：这是接收侧最容易被攻破的地方，必须在落盘前拦住。
	dest, err := transfer.ResolveDest(destDir, entry.RelPath)
	if err != nil {
		s.node.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID,
			Msg: "拒绝了不安全的文件路径: " + entry.RelPath, Err: err})
		return s.wc.WriteMsg(wire.TypeXferReject, 0, &wire.XferReject{
			TransferID: o.TransferID, Code: wire.ErrCodePathUnsafe, Msg: err.Error(),
		})
	}

	// 秒传：已有内容相同的文件就不再传。判据是整份文件的 Merkle 根，不是文件名或时间戳
	// （见 transfer.FindIdentical）。放在 OpenReceiver 之前：它会创建 .cbpart 并按全长
	// 预分配磁盘，这条路不需要。
	if have, ok := transfer.FindIdentical(dest, entry.Size, o.ChunkSize, entry.MerkleRoot); ok {
		acc.SkipFiles = []int{0}
		// 这条事件绝不能带 Path：上层看到 Path 非空就判定为"收完一个新文件"（kind=recv_done），
		// Android 会把它再投递到保存目录，导致每次秒传多出一份副本。秒传是"什么都没发生"。
		s.node.emit(Event{Kind: "transfer", DeviceID: s.peer.DeviceID,
			Msg:  "已有相同文件，无需传输: " + filepath.Base(have),
			Code: "instant_skip",
			Xfer: xferRef(key, filepath.Base(have), kindOfTransfer(o.Kind, entry.RelPath))})
		// 不登记 recvXfer：这次传输在这里就结束了，发送端看到 SkipFiles
		// 也不会再发块，更不会发 XFER_DONE。
		return s.wc.WriteMsg(wire.TypeXferAccept, 0, acc)
	}

	rx, err := transfer.OpenReceiver(dest, entry.Size, o.ChunkSize, nil, entry.MerkleRoot)
	if err != nil {
		return s.wc.WriteMsg(wire.TypeXferReject, 0, &wire.XferReject{
			TransferID: o.TransferID, Code: wire.ErrCodeNoSpace, Msg: err.Error(),
		})
	}

	// 断点续传的关键一步：把"我已经有哪些块"告诉发送端，它只补缺失的。
	acc.Have = []wire.HaveBitmap{{FileIndex: 0, Bitmap: rx.Bitmap()}}

	// 显示名取清单条目的基名而非 RelPath：传文件夹时 RelPath 形如 `报告/图表/第一章.png`，
	// 整条显示会很长并被截断；用户要看的是「第一章.png」加"来自 报告 文件夹"。
	display := displayNameOf(entry.RelPath)
	ctl := newXferCtl(key, s.peer.DeviceID, s.PeerName(), "recv", display,
		kindOfTransfer(o.Kind, entry.RelPath), entry.Size)
	s.node.xfers.add(ctl)

	s.xmu.Lock()
	select {
	case <-s.done:
		// 等用户确认期间连接已断，close() 早已遍历过 recvXfers，此时登记就没人回收接收器：
		// 句柄一直开着，Windows 上 .cbpart 被锁死，重传同名文件删改都不行。自己收拾干净。
		s.xmu.Unlock()
		_ = rx.Abort(true)
		s.node.xfers.remove(key)
		return errors.New("连接已断开")
	default:
	}
	s.recvXfers[key] = &recvTransfer{
		id: o.TransferID, entry: entry, recv: rx, manifest: o.Manifest, destDir: destDir,
		ctl: ctl, display: display,
		chunkSize: o.ChunkSize, totalChunks: transfer.ChunkCount(entry.Size, o.ChunkSize),
	}
	s.xmu.Unlock()

	return s.wc.WriteMsg(wire.TypeXferAccept, 0, acc)
}

func (s *Session) onXferChunk(f *wire.Frame) error {
	// 帧结构：CBOR 头 + 原始数据，中间用 u32 长度分隔，
	// 避免把几 MB 的二进制塞进 CBOR 再编解码一遍。
	hdr, data, err := splitChunkFrame(f.Payload)
	if err != nil {
		return err
	}
	key := hex.EncodeToString(hdr.TransferID)
	s.xmu.Lock()
	rt, ok := s.recvXfers[key]
	s.xmu.Unlock()
	if !ok {
		return nil // 已取消
	}

	// 块哈希只算这一次：既用来核对发送端报的值，也交给接收器记在账上——
	// 收完之后的整体校验直接用它们拼 Merkle 根，不用再读一遍盘。
	leaf := transfer.HashChunk(data)
	if hdr.Hash != nil && !eqBytes(leaf, hdr.Hash) {
		return s.wc.WriteMsg(wire.TypeError, 0, &wire.Error{
			Code: wire.ErrCodeBadChunk, Msg: fmt.Sprintf("分块 %d 校验失败", hdr.ChunkIndex),
			Ref: hdr.TransferID,
		})
	}
	if err := rt.recv.WriteChunkHashed(hdr.ChunkIndex, data, leaf); err != nil {
		// 写盘失败（磁盘满、目标被占用…）不会自愈，后面每块都会同样失败。当场告诉发送端让它停，
		// 否则它会把剩下的几个 GB 照发，最后只收到莫名的"仍有分块未收到"。
		s.failRecvTransfer(key, rt, err)
		return nil
	}

	rt.gotChunks++
	if cb := s.node.cfg.OnProgress; cb != nil {
		now := time.Now()
		if now.Sub(rt.lastReport) >= progressInterval {
			// 已完成字节取接收器位图里已有的全部块，不是本次会话收到的块数：续传时前面的块不再重传，
			// 只数本次的话进度会从 0 重爬且永远到不了 100%。
			done, _ := rt.recv.Progress()
			var speed int64
			if !rt.lastReport.IsZero() {
				if el := now.Sub(rt.lastReport).Seconds(); el > 0 {
					speed = int64(float64(done-rt.lastDone) / el)
				}
			}
			rt.lastReport, rt.lastDone = now, done
			total := rt.totalChunks
			have := total - len(rt.recv.Missing())
			cb(Progress{
				ID: hex.EncodeToString(hdr.TransferID),
				// 名字用**显示名**：RelPath 在传文件夹时是多级路径，
				// 直接摆进界面只会被截断成一串看不出是什么的字符。
				DeviceID: s.peer.DeviceID, DeviceName: s.PeerName(),
				Name: rt.display, Kind: rt.ctl.kind, Direction: "recv",
				Done: done, Total: rt.entry.Size,
				Chunks: have, TotalChunk: total, Speed: speed,
			})
		}
	}
	return nil
}

func (s *Session) onXferDone(f *wire.Frame) error {
	var d wire.XferDone
	if err := wire.Unmarshal(f.Payload, &d); err != nil {
		return err
	}
	key := hex.EncodeToString(d.TransferID)
	s.xmu.Lock()
	rt, ok := s.recvXfers[key]
	if ok {
		delete(s.recvXfers, key)
	}
	s.xmu.Unlock()
	if !ok {
		// 不是我在收的任务，那就是对方在确认我发过去的东西 → 唤醒发送端。
		s.notifyXfer(d.TransferID, &xferReply{done: &d})
		return nil
	}
	// 收完（不论成败）都要从注册表里摘掉，否则界面上的"暂停/取消"按钮会一直
	// 挂在一条已经结束的传输上，点下去什么都不会发生。
	s.node.xfers.remove(key)

	// 收尾（刷盘、核对、改名、投递）不在读循环里做：最后的 fsync 在慢盘上可达几十秒，期间
	// 心跳回声不回，发送端三次没等到就断连，文件其实已收全却报"连接已断开"。
	go s.finishRecv(key, rt, d.TransferID)
	return nil
}

// finishRecv 完成一次接收：核对 → 落地 → 通知界面 → 回 XFER_DONE。
// 在独立 goroutine 里跑，见 onXferDone 的说明。
func (s *Session) finishRecv(key string, rt *recvTransfer, tid []byte) {
	// 摘除后还要通知界面移除这一行，所有出口一样（所以用 defer）。剪贴板正文走下面 isClip 路径，
	// 故意不发 transfer 事件，但界面只认 transfer 的 done/recv_done 或 xfer_state=ended 来删进度行，
	// 少这一句「剪贴板图片 100%」会永远挂在进行中。发送端（sendClipFile/sendFile 的 defer）已有。
	defer func() {
		info := rt.ctl.info()
		info.State = XferEnded
		s.node.emit(Event{Kind: "xfer_state", DeviceID: s.peer.DeviceID, Msg: XferEnded, Xfer: &info})
	}()
	reply := func(ok bool, msg string) {
		_ = s.wc.WriteMsg(wire.TypeXferDone, 0, &wire.XferDone{TransferID: tid, OK: ok, Msg: msg})
	}

	if err := rt.recv.Finish(); err != nil {
		if rt.isClip {
			s.node.recordClipSyncResult(s.peer, rt.clipItemID, rt.clipMime, false, err.Error())
		} else {
			s.node.emit(Event{Kind: "transfer", DeviceID: s.peer.DeviceID,
				Msg: "接收失败: " + rt.display, Err: err, Xfer: xferRef(key, rt.display, rt.ctl.kind)})
		}
		reply(false, err.Error())
		return
	}
	final := rt.recv.FinalPath()

	if rt.isClip {
		// 剪贴板正文：读回内存塞进对应条目，不当成"收到一个新文件"报给界面——
		// 界面看到的应该是剪贴板内容到齐了，而不是一条来路不明的传输记录。
		if err := s.deliverClipFromFile(rt.clipItemID, rt.clipMime, final, rt.entry.Size); err != nil {
			s.node.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID,
				Msg: "剪贴板正文校验失败", Err: err})
			s.node.recordClipSyncResult(s.peer, rt.clipItemID, rt.clipMime, false, err.Error())
			reply(false, err.Error())
			return
		}
		s.node.recordClipSyncResult(s.peer, rt.clipItemID, rt.clipMime, true, "")
		reply(true, "")
		return
	}

	// 名字用**真正落地的那个**：重名时接收端会改成 `报告 (1).pdf`，
	// 界面要是还显示原名，用户按图索骥就找不到文件。
	s.node.emit(Event{Kind: "transfer", DeviceID: s.peer.DeviceID,
		Msg:  "已接收 " + filepath.Base(final),
		Path: final, Xfer: xferRef(key, filepath.Base(final), rt.ctl.kind)})
	reply(true, "")
}

// failRecvTransfer 中止无法继续的接收并告知发送端原因。残片保留（keepPartial）：位图里
// 只有已验证写入的块，腾出磁盘后重发可接着补。
func (s *Session) failRecvTransfer(key string, rt *recvTransfer, cause error) {
	s.xmu.Lock()
	cur, ok := s.recvXfers[key]
	if ok && cur == rt {
		delete(s.recvXfers, key)
	} else {
		ok = false
	}
	s.xmu.Unlock()
	if !ok {
		return // 已经被取消 / 收尾了，别重复报
	}
	_ = rt.recv.Abort(true)
	s.node.xfers.remove(key)
	if rt.isClip {
		s.node.recordClipSyncResult(s.peer, rt.clipItemID, rt.clipMime, false, cause.Error())
	} else {
		s.node.emit(Event{Kind: "transfer", DeviceID: s.peer.DeviceID,
			Msg: "接收失败: " + rt.display, Err: cause, Xfer: xferRef(key, rt.display, rt.ctl.kind)})
	}
	info := rt.ctl.info()
	info.State = XferEnded
	s.node.emit(Event{Kind: "xfer_state", DeviceID: s.peer.DeviceID, Msg: XferEnded, Xfer: &info})
	_ = s.wc.WriteMsg(wire.TypeXferDone, 0, &wire.XferDone{
		TransferID: rt.id, OK: false, Msg: cause.Error(),
	})
}

func (s *Session) onXferReject(f *wire.Frame) error {
	var r wire.XferReject
	if err := wire.Unmarshal(f.Payload, &r); err != nil {
		return err
	}
	s.notifyXfer(r.TransferID, &xferReply{rejected: true, msg: r.Msg, code: r.Code})
	return nil
}

func (s *Session) onXferAccept(f *wire.Frame) error {
	var a wire.XferAccept
	if err := wire.Unmarshal(f.Payload, &a); err != nil {
		return err
	}
	s.notifyXfer(a.TransferID, &xferReply{accept: &a})
	return nil
}

// ---------- 传输控制（暂停 / 继续 / 取消） ----------

// sendXferStatus 把本机控制动作告诉对端。发不出去不当错误：本地已停，连接断开本身会让对端
// 收尾，为一条通知性消息关掉整条会话得不偿失。
func (s *Session) sendXferStatus(id, action string) {
	tid, err := hex.DecodeString(id)
	if err != nil {
		return
	}
	_ = s.wc.WriteMsg(wire.TypeXferStatus, wire.FlagUrgent, &wire.XferStatus{
		TransferID: tid, Action: action,
	})
}

// onXferStatus 处理对端的暂停/继续/取消：只改本地控制块，绝不回发 XFER_STATUS，
// 否则两端互相通知同一动作（幂等不死循环，但界面状态会闪两下）。
func (s *Session) onXferStatus(f *wire.Frame) error {
	var st wire.XferStatus
	if err := wire.Unmarshal(f.Payload, &st); err != nil {
		return err
	}
	id := hex.EncodeToString(st.TransferID)
	c, ok := s.node.xfers.get(id)
	if !ok {
		// 对端取消一个本机已经传完的传输：正常竞态，安静忽略。
		return nil
	}
	var changed bool
	switch st.Action {
	case "pause":
		changed = c.Pause()
	case "resume":
		changed = c.Resume()
	case "cancel":
		changed = c.Cancel()
		// 本机是接收方时要把残片清掉——对端不会再发块了，留着的 .cbpart
		// 只会占盘，而且下次同名文件传过来会命中一个不完整的续传状态。
		if changed && c.direction == "recv" {
			s.abortRecvTransfer(id, false)
			// abortRecvTransfer 已移除接收器和残片；控制块也必须离开 Node
			// 注册表，不然 active_transfers 会把已被对端取消的任务复活到界面。
			s.node.xfers.remove(id)
		}
	default:
		return nil // progress / resend 暂未使用，忽略而不是断连
	}
	if changed {
		s.node.emitXferState(c)
	}
	return nil
}

// abortRecvTransfer 中止一次接收。keepPartial 决定残片留不留：
// 连接断开留（下次续传），用户取消不留（他明确说了不要）。
func (s *Session) abortRecvTransfer(id string, keepPartial bool) {
	s.xmu.Lock()
	rt, ok := s.recvXfers[id]
	if ok {
		delete(s.recvXfers, id)
	}
	s.xmu.Unlock()
	if !ok {
		return
	}
	_ = rt.recv.Abort(keepPartial)
}
