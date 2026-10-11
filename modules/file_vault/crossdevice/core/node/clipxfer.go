// 剪贴板大表示复用文件传输通道（分片哈希、位图续传、进度），不另写一套协议。
// 双方 HELLO 都公布 wire.ClipXferFeature 才走这条；否则 session.go 退回
// ClipFetch/ClipData 按需拉取。另含断线重连后补发（resendPendingClipXfers）
// 与因果冲突检测（checkClipConflict，见 wire.ClipAnnounce.CausalRef）。
package node

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"lukechampine.com/blake3"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/transfer"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

// clipXferFileTTL：暂存目录中文件无人访问多久后清掉。10 分钟远超正常重连等待，
// 且不比 clipCache（2 分钟）的原件活得太久。
const clipXferFileTTL = 10 * time.Minute

// ---------- 发送侧：把一个表示当"文件"推过去 ----------

// clipXferPath 算出某表示在暂存目录的路径。用 blake3(mime) 前 8 字节命名：
// mime 来自对端、不可信，含斜杠和分号，直接拼进路径有路径穿越风险。
func (n *Node) clipXferPath(itemID []byte, mime string) string {
	h := blake3.Sum256([]byte(mime))
	name := hex.EncodeToString(itemID) + "-" + hex.EncodeToString(h[:8]) + ".clip"
	return filepath.Join(n.clipXferDir, name)
}

// spoolClipRep 把表示正文落到暂存文件供 transfer.OpenSender 使用（它只认文件路径）。
// 内容寻址：文件已存在且长度一致就复用。
func (n *Node) spoolClipRep(itemID []byte, mime string, data []byte) (string, error) {
	path := n.clipXferPath(itemID, mime)
	if st, err := os.Stat(path); err == nil && st.Size() == int64(len(data)) {
		return path, nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return "", fmt.Errorf("暂存剪贴板正文失败: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", fmt.Errorf("暂存剪贴板正文失败: %w", err)
	}
	return path, nil
}

// pushClipRep 把一个缺失的表示推给对端。由 SendClip 在对端支持 clipxfer1 时
// 为每个 MissingReps() 起一个 goroutine 调用。
func (s *Session) pushClipRep(it *clipboard.Item, mime string) {
	r, ok := it.Rep(mime)
	if !ok || r.Data == nil {
		return
	}
	path, err := s.node.spoolClipRep(it.ID, mime, r.Data)
	if err != nil {
		s.node.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID, Msg: "准备剪贴板正文失败", Err: err})
		return
	}
	s.node.trackOutboundClip(s.peer.DeviceID, it.ID, mime, path, r.Size)
	if err := s.sendClipFile(it.ID, mime, path, r.Size); err != nil {
		s.node.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID, Msg: "剪贴板正文发送失败", Err: err})
	}
}

// sendClipFile 把暂存文件当文件传输发给对端，Kind="clip" 并带 ClipItemID/ClipMime，
// 让对端 onXferOffer 走 onClipXferOffer 而不弹确认框。
// 逻辑照抄 sendFile（同备料、位图续传、进度节流），但语义不同（无 ConfirmTransfer、
// relPath、多文件清单），合并只会处处多一句"是不是剪贴板"。
func (s *Session) sendClipFile(itemID []byte, mime, path string, size int64) error {
	chunkSize := transfer.DefaultChunkSize
	if size > 0 && size < int64(chunkSize) {
		chunkSize = int(size)
	}
	if chunkSize < transfer.MinChunkSize {
		chunkSize = transfer.MinChunkSize
	}

	snd, err := transfer.OpenSender(path, chunkSize)
	if err != nil {
		return err
	}
	defer snd.Close()

	tid, err := crypto.RandomBytes(16)
	if err != nil {
		return err
	}
	key := hex.EncodeToString(tid)
	ch := s.registerWaiter(key)
	defer s.unregisterWaiter(key)

	display := clipDisplayName(mime)
	ctl := newXferCtl(key, s.peer.DeviceID, s.PeerName(), "send", display, "clip", snd.Size())
	s.node.xfers.add(ctl)
	defer func() {
		s.node.xfers.remove(key)
		info := ctl.info()
		info.State = XferEnded
		s.node.emit(Event{Kind: "xfer_state", DeviceID: s.peer.DeviceID, Msg: XferEnded, Xfer: &info})
	}()

	offer := &wire.XferOffer{
		TransferID: tid, FileCount: 1, TotalSize: snd.Size(), ChunkSize: chunkSize,
		Kind: "clip", Name: display,
		Manifest:   []wire.FileEntry{{RelPath: display, Size: snd.Size(), MerkleRoot: snd.Root()}},
		ClipItemID: itemID, ClipMime: mime,
	}
	if err := s.wc.WriteMsg(wire.TypeXferOffer, 0, offer); err != nil {
		return err
	}

	var acc *wire.XferAccept
	select {
	case r := <-ch:
		if r.rejected {
			return fmt.Errorf("对方拒绝了剪贴板正文（错误码 %d）: %s", r.code, r.msg)
		}
		acc = r.accept
	case <-s.done:
		return errors.New("连接已断开")
	case <-time.After(fetchTimeout):
		return errors.New("等待对方应答超时")
	}

	if len(acc.SkipFiles) > 0 {
		// 秒传：对方本地缓存已经有一模一样的正文（比如同一条内容之前已经拉过）。
		s.node.markOutboundClipDone(s.peer.DeviceID, itemID, mime)
		return nil
	}

	total := snd.ChunkCount()
	var have *transfer.Bitmap
	for _, hb := range acc.Have {
		if hb.FileIndex == 0 {
			if bm, err := transfer.UnmarshalBitmap(hb.Bitmap); err == nil && bm.Len() == total {
				have = bm
			}
		}
	}
	plan := transfer.PlanChunks(total, have)
	already := total - len(plan)

	lastReport := time.Time{}
	lastDone := int64(0)
	sentChunks := 0
	report := func(force bool) {
		if s.node.cfg.OnProgress == nil {
			return
		}
		now := time.Now()
		if !force && now.Sub(lastReport) < progressInterval {
			return
		}
		done := int64(already+sentChunks) * int64(chunkSize)
		if done > snd.Size() {
			done = snd.Size()
		}
		var speed int64
		if !lastReport.IsZero() {
			if el := now.Sub(lastReport).Seconds(); el > 0 {
				speed = int64(float64(done-lastDone) / el)
			}
		}
		lastReport, lastDone = now, done
		s.node.cfg.OnProgress(Progress{
			ID: key, DeviceID: s.peer.DeviceID, DeviceName: s.PeerName(),
			Name: display, Kind: "clip", Direction: "send",
			Done: done, Total: snd.Size(),
			Chunks: already + sentChunks, TotalChunk: total, Speed: speed,
		})
	}
	report(true)

	stop := make(chan struct{})
	defer close(stop)
	prepared := startChunkPrep(context.Background(), chunkPrepParams{
		plan: plan, snd: snd, chunkSize: chunkSize, tid: tid,
		ctl: ctl, sessDone: s.done, stop: stop,
	})
	for pc := range prepared {
		if pc.err != nil {
			if errors.Is(pc.err, ErrTransferCanceled) {
				s.sendXferStatus(key, "cancel")
			}
			return pc.err
		}
		if err := s.wc.WriteFrame(&wire.Frame{Type: wire.TypeXferChunk, Payload: pc.frame}); err != nil {
			return err
		}
		sentChunks++
		report(false)
	}
	report(true)

	if err := s.wc.WriteMsg(wire.TypeXferDone, 0, &wire.XferDone{TransferID: tid, OK: true}); err != nil {
		return err
	}

	select {
	case r := <-ch:
		if r.done != nil && !r.done.OK {
			return fmt.Errorf("对方校验失败: %s", r.done.Msg)
		}
	case <-s.done:
		return errors.New("连接已断开")
	case <-time.After(5 * time.Minute):
		return errors.New("等待对方确认超时")
	}

	s.node.markOutboundClipDone(s.peer.DeviceID, itemID, mime)
	return nil
}

// ---------- 接收侧：把收到的"文件"塞回剪贴板条目 ----------

// pendingClipAssembly 是正在等文件传输通道把大表示送回来的剪贴板条目。
// remaining 记的是还差哪些 mime；每收完一个就从里面摘掉一个，摘空了才交付。
type pendingClipAssembly struct {
	item      *clipboard.Item
	seq       uint64
	remaining map[string]bool
	timer     *time.Timer
	// partial 为 true 表示已经先交付过"已到的部分"，剩下的表示到齐后只在
	// 这条内容仍是本机当前内容时才补写一次完整版。
	partial bool
}

const (
	// partialClipGrace：纯文本已到、只差 HTML/RTF 等富格式时，最多等这么久就先写入已有内容，
	// 不能让大富格式拖住纯文本的粘贴。
	partialClipGrace = 1500 * time.Millisecond

	// clipAssemblyTTL：连首选表示都没到（大图片等）时最多等多久。超时即放弃并
	// 在同步状态面板里记一条失败，而不是让账本条目永远挂着。
	clipAssemblyTTL = clipXferFileTTL
)

// supportsClipXfer 报告对端是否在握手时公布了 wire.ClipXferFeature。
func (s *Session) supportsClipXfer() bool {
	return slices.Contains(s.peerFeatures, wire.ClipXferFeature)
}

// clipAssemblyKey 拼出 pendingClipAssembly 账本键（对端设备 + 内容哈希）。按设备而非
// 会话记账，以扛住断线重连（见 Node 的 clipAssemblyMu 注释）。
func clipAssemblyKey(deviceID string, itemID []byte) string {
	return deviceID + "|" + hex.EncodeToString(itemID)
}

// registerPendingClip 登记一条正在等待按需推送的剪贴板条目。
func (n *Node) registerPendingClip(deviceID string, it *clipboard.Item, seq uint64, missing []string) {
	rem := make(map[string]bool, len(missing))
	for _, m := range missing {
		rem[m] = true
	}
	key := clipAssemblyKey(deviceID, it.ID)
	wait := clipAssemblyTTL
	if it.HasUsableText() {
		wait = partialClipGrace
	}
	n.clipAssemblyMu.Lock()
	defer n.clipAssemblyMu.Unlock()
	if _, ok := n.pendingClipAssembly[key]; ok {
		// 同一内容的重复 announce（重连补发、用户重按发送）：沿用正在等的那份，
		// 已经到手的表示不能因为重新登记而丢掉。
		return
	}
	pc := &pendingClipAssembly{item: it, seq: seq, remaining: rem}
	pc.timer = time.AfterFunc(wait, func() { n.onPendingClipTimeout(deviceID, key, pc) })
	n.pendingClipAssembly[key] = pc
}

// onPendingClipTimeout 处理等待超时：文本已到就先交付已有的部分并继续等富格式，
// 否则放弃并记录失败。
func (n *Node) onPendingClipTimeout(deviceID, key string, pc *pendingClipAssembly) {
	n.clipAssemblyMu.Lock()
	if cur, ok := n.pendingClipAssembly[key]; !ok || cur != pc {
		n.clipAssemblyMu.Unlock()
		return
	}
	if !pc.partial && pc.item.HasUsableText() {
		pc.partial = true
		part := pc.item.Available()
		pc.timer = time.AfterFunc(clipAssemblyTTL, func() { n.onPendingClipTimeout(deviceID, key, pc) })
		n.clipAssemblyMu.Unlock()
		n.deliverClipItem(deviceID, part, pc.seq)
		return
	}
	delete(n.pendingClipAssembly, key)
	missing := make([]string, 0, len(pc.remaining))
	for m := range pc.remaining {
		missing = append(missing, m)
	}
	n.clipAssemblyMu.Unlock()
	if peer, err := n.store.GetPeer(deviceID); err == nil {
		for _, m := range missing {
			n.recordClipSyncResult(peer, pc.item.ID, m, false, "等待正文超时")
		}
	}
}

// fulfillPendingClip 用收到的正文填一个表示，所有表示到齐后才交付平台层（MissingReps
// 的规矩，换通道也不能丢）。账本挂 Node 按设备记账，重连后新 *Session 补发也能找到记录。
func (s *Session) fulfillPendingClip(itemID []byte, mime string, data []byte) error {
	key := clipAssemblyKey(s.peer.DeviceID, itemID)
	n := s.node
	n.clipAssemblyMu.Lock()
	pc, ok := n.pendingClipAssembly[key]
	if !ok {
		n.clipAssemblyMu.Unlock()
		return nil // 已经交付过，或是一次重复的 XFER_DONE，安静忽略
	}
	if err := pc.item.SetRepData(mime, data); err != nil {
		n.clipAssemblyMu.Unlock()
		return err
	}
	delete(pc.remaining, mime)
	done := len(pc.remaining) == 0
	if done {
		delete(n.pendingClipAssembly, key)
		if pc.timer != nil {
			pc.timer.Stop()
		}
	}
	n.clipAssemblyMu.Unlock()
	if !done {
		return nil
	}
	if pc.partial {
		// 文本早已交付。只有这条仍是本机当前内容时才补写完整版——用户在
		// 这期间复制了别的，就不能用旧内容的富格式把它盖掉。
		if cur := n.currentItem(); cur != nil && bytes.Equal(cur.ID, pc.item.ID) {
			n.deliverClipItem(s.peer.DeviceID, pc.item, pc.seq)
		}
		return nil
	}
	s.deliverClip(pc.item, pc.seq)
	return nil
}

// deliverClipFromFile 读回一个已经收完的暂存文件，喂给 fulfillPendingClip。
func (s *Session) deliverClipFromFile(itemID []byte, mime, path string, size int64) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取剪贴板正文暂存文件失败: %w", err)
	}
	if int64(len(data)) != size {
		return fmt.Errorf("剪贴板正文长度不符：期望 %d，实际 %d", size, len(data))
	}
	return s.fulfillPendingClip(itemID, mime, data)
}

// onClipXferOffer 处理 Kind=="clip" 的 XFER_OFFER：协议内部消息，自动接受不弹确认框，
// 落私有暂存目录而非 DownloadDir。
func (s *Session) onClipXferOffer(o *wire.XferOffer) error {
	if len(o.Manifest) != 1 || len(o.ClipItemID) == 0 || o.ClipMime == "" {
		return s.wc.WriteMsg(wire.TypeXferReject, 0, &wire.XferReject{
			TransferID: o.TransferID, Code: wire.ErrCodeRejected, Msg: "剪贴板传输参数不完整",
		})
	}
	entry := o.Manifest[0]
	dest := s.node.clipXferPath(o.ClipItemID, o.ClipMime)
	key := hex.EncodeToString(o.TransferID)
	display := clipDisplayName(o.ClipMime)

	acc := &wire.XferAccept{TransferID: o.TransferID}

	if !s.node.clipMimeAllowed(s.peer.DeviceID, o.ClipMime) {
		// 本机不收该设备的这类内容（见 clippolicy.go）：回「已经有了」而非拒绝——拒绝会让对端
		// 弹"发送失败"，秒传回应则让它安静记为已送达且不传数据。
		acc.SkipFiles = []int{0}
		return s.wc.WriteMsg(wire.TypeXferAccept, 0, acc)
	}

	if have, ok := transfer.FindIdentical(dest, entry.Size, o.ChunkSize, entry.MerkleRoot); ok {
		// 秒传：暂存目录里已经有一模一样的正文（比如上一轮同步已经拉取过、
		// 这次只是重发 announce）。
		acc.SkipFiles = []int{0}
		if err := s.deliverClipFromFile(o.ClipItemID, o.ClipMime, have, entry.Size); err != nil {
			s.node.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID, Msg: "剪贴板正文校验失败", Err: err})
			s.node.recordClipSyncResult(s.peer, o.ClipItemID, o.ClipMime, false, err.Error())
		} else {
			s.node.recordClipSyncResult(s.peer, o.ClipItemID, o.ClipMime, true, "")
		}
		return s.wc.WriteMsg(wire.TypeXferAccept, 0, acc)
	}

	rx, err := transfer.OpenReceiver(dest, entry.Size, o.ChunkSize, nil, entry.MerkleRoot)
	if err != nil {
		return s.wc.WriteMsg(wire.TypeXferReject, 0, &wire.XferReject{
			TransferID: o.TransferID, Code: wire.ErrCodeNoSpace, Msg: err.Error(),
		})
	}
	acc.Have = []wire.HaveBitmap{{FileIndex: 0, Bitmap: rx.Bitmap()}}

	ctl := newXferCtl(key, s.peer.DeviceID, s.PeerName(), "recv", display, "clip", entry.Size)
	s.node.xfers.add(ctl)

	s.xmu.Lock()
	s.recvXfers[key] = &recvTransfer{
		id: o.TransferID, entry: entry, recv: rx, manifest: o.Manifest, destDir: filepath.Dir(dest),
		ctl: ctl, display: display,
		isClip: true, clipItemID: o.ClipItemID, clipMime: o.ClipMime,
		chunkSize: o.ChunkSize, totalChunks: transfer.ChunkCount(entry.Size, o.ChunkSize),
	}
	s.xmu.Unlock()

	return s.wc.WriteMsg(wire.TypeXferAccept, 0, acc)
}

// clipDisplayName 给界面一个人话的名字，而不是直接把 MIME 字符串糊上去
// （"text/plain;charset=utf-8" 对用户没有任何意义）。
func clipDisplayName(mime string) string {
	switch mime {
	case clipboard.MimePNG, clipboard.MimeJPEG:
		return "剪贴板图片"
	case clipboard.MimeHTML:
		return "剪贴板富文本"
	case clipboard.MimeRTF:
		return "剪贴板 RTF"
	case clipboard.MimeText:
		return "剪贴板文本"
	default:
		return "剪贴板内容"
	}
}

// ---------- 断线期间复制的内容：重连后补发 ----------

// clipReplayWindow：重连只补发这么新的本机内容，更旧的会让人困惑。与 clipFetchCacheTTL
// 对齐，老版本对端按需拉取时发送端仍有原件。
const clipReplayWindow = clipFetchCacheTTL

// clipSend 记一次发送的时刻（clipSentAt）或一次测得的端到端延迟（clipLatency）。
type clipSend struct {
	itemID  []byte
	at      time.Time
	latency time.Duration
}

// noteClipSent 记下向某台设备发出 announce 的时刻，供确认回来时算延迟。
func (n *Node) noteClipSent(deviceID string, itemID []byte) {
	n.clipAckMu.Lock()
	n.clipSentAt[deviceID] = clipSend{itemID: append([]byte(nil), itemID...), at: time.Now()}
	n.clipAckMu.Unlock()
}

// noteClipAck 记下对端确认收到的内容 ID，并在对得上最近一次发送时记下端到端延迟：
// 从本机发出到对端把内容写进剪贴板、回来确认，整条链路的真实耗时。
func (n *Node) noteClipAck(deviceID string, itemID []byte) {
	n.clipAckMu.Lock()
	n.clipAcked[deviceID] = append([]byte(nil), itemID...)
	sent, ok := n.clipSentAt[deviceID]
	measured := ok && bytes.Equal(sent.itemID, itemID)
	if measured {
		now := time.Now()
		lat := now.Sub(sent.at)
		n.clipLatency[deviceID] = clipSend{itemID: sent.itemID, at: now, latency: lat}
		delete(n.clipSentAt, deviceID)
		hist := append(n.clipLatHist[deviceID], LatencySample{At: now, Latency: lat})
		if len(hist) > clipLatencyKeep {
			hist = slices.Clone(hist[len(hist)-clipLatencyKeep:])
		}
		n.clipLatHist[deviceID] = hist
	}
	n.clipAckMu.Unlock()
	if measured {
		n.emit(Event{Kind: "clip_ack", DeviceID: deviceID})
	}
}

// ClipLatency 返回最近一次测得的剪贴板端到端延迟与测得时刻。
func (n *Node) ClipLatency(deviceID string) (time.Duration, time.Time, bool) {
	n.clipAckMu.Lock()
	defer n.clipAckMu.Unlock()
	l, ok := n.clipLatency[deviceID]
	return l.latency, l.at, ok
}

// clipLatencyKeep 是每台设备保留的延迟样本数（迷你曲线的点数）。
const clipLatencyKeep = 30

// LatencySample 是一次测得的剪贴板端到端延迟。
type LatencySample struct {
	At      time.Time
	Latency time.Duration
}

// ClipLatencyHistory 返回某台设备最近的延迟样本，旧的在前。只在内存里，重启清零。
func (n *Node) ClipLatencyHistory(deviceID string) []LatencySample {
	n.clipAckMu.Lock()
	defer n.clipAckMu.Unlock()
	return slices.Clone(n.clipLatHist[deviceID])
}

// replayCurrentClip 在会话建立后补发本机最新、对端未确认的内容。BroadcastClip 只发给
// 在线会话，断线期间的复制会丢。带 Replay 标记，接收端若已有更新内容则只确认不覆盖。
func (n *Node) replayCurrentClip(s *Session) {
	cur := n.currentItem()
	if cur == nil || cur.Source != n.id.DeviceID() {
		return
	}
	if time.Since(cur.HLC.Time()) > clipReplayWindow {
		return
	}
	n.clipAckMu.Lock()
	acked := n.clipAcked[s.peer.DeviceID]
	n.clipAckMu.Unlock()
	if bytes.Equal(acked, cur.ID) {
		return
	}
	replay := *cur
	replay.Replay = true
	replay.Force = false
	send := s.SendClip
	if n.hasOutboundClip(s.peer.DeviceID, cur.ID) {
		// 正文推送已经在账本里，随后由 resendPendingClipXfers 补推，这里只补 announce。
		send = s.sendAnnounce
	}
	if err := send(&replay); err != nil {
		n.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID, Msg: "重连后补发剪贴板失败", Err: err})
	}
}

// ---------- 断线重连后的自动补发 ----------

// outClipXfer 记录尚未确认送达的推送供重连重试。只在内存：剪贴板内容本就是"最近的"，
// 重启丢失可接受，不值得加持久化（同 clipCache）。
type outClipXfer struct {
	deviceID string
	itemID   []byte
	mime     string
	path     string
	size     int64
	done     bool
}

const maxOutClipXfers = 200

func (n *Node) trackOutboundClip(deviceID string, itemID []byte, mime, path string, size int64) {
	n.clipXferMu.Lock()
	defer n.clipXferMu.Unlock()
	n.outClipXfers = append(n.outClipXfers, &outClipXfer{
		deviceID: deviceID, itemID: append([]byte(nil), itemID...),
		mime: mime, path: path, size: size,
	})
	if len(n.outClipXfers) > maxOutClipXfers {
		n.outClipXfers = n.outClipXfers[len(n.outClipXfers)-maxOutClipXfers:]
	}
}

// hasOutboundClip 报告某条内容是否还有没确认送达的正文推送。
func (n *Node) hasOutboundClip(deviceID string, itemID []byte) bool {
	n.clipXferMu.Lock()
	defer n.clipXferMu.Unlock()
	for _, x := range n.outClipXfers {
		if !x.done && x.deviceID == deviceID && bytes.Equal(x.itemID, itemID) {
			return true
		}
	}
	return false
}

func (n *Node) markOutboundClipDone(deviceID string, itemID []byte, mime string) {
	n.clipXferMu.Lock()
	defer n.clipXferMu.Unlock()
	for _, x := range n.outClipXfers {
		if x.deviceID == deviceID && x.mime == mime && bytes.Equal(x.itemID, itemID) {
			x.done = true
		}
	}
}

// resendPendingClipXfers 重连后重推未确认的剪贴板正文（断线时 sendClipFile 因 s.done
// 关闭报错，但内容应继续到达）。暂存路径内容寻址，接收端在同一 destPath 找到 .cbpart
// 和位图，只补缺失部分。
func (n *Node) resendPendingClipXfers(s *Session) {
	n.clipXferMu.Lock()
	var pending []*outClipXfer
	for _, x := range n.outClipXfers {
		if !x.done && x.deviceID == s.peer.DeviceID {
			pending = append(pending, x)
		}
	}
	n.clipXferMu.Unlock()

	for _, x := range pending {
		if _, err := os.Stat(x.path); err != nil {
			continue // 暂存文件已经过期清理，这条内容太旧，不必再补
		}
		if !n.clipMimeAllowed(x.deviceID, x.mime) {
			// 断线期间用户把这台设备改成了不同步这类内容。
			n.markOutboundClipDone(x.deviceID, x.itemID, x.mime)
			continue
		}
		if err := s.sendClipFile(x.itemID, x.mime, x.path, x.size); err != nil {
			n.emit(Event{Kind: "error", DeviceID: s.peer.DeviceID, Msg: "重连后补发剪贴板正文失败", Err: err})
		}
	}
}

// purgeStaleClipXferFiles 清理暂存目录里久未使用的文件。
// 挂在 maintenanceLoop 的 10 秒 tick 上，跟设备到期清理共用同一个节奏。
func (n *Node) purgeStaleClipXferFiles(now time.Time) {
	entries, err := os.ReadDir(n.clipXferDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) < clipXferFileTTL {
			continue
		}
		_ = os.Remove(filepath.Join(n.clipXferDir, e.Name()))
	}
}

// ---------- 同步状态与因果冲突：供界面查询的历史 ----------

// ClipSyncEntry 是一次剪贴板正文同步（发送或接收完成）的结果快照。
type ClipSyncEntry struct {
	DeviceID   string
	DeviceName string
	Mime       string
	ItemID     string // hex(item_id)
	OK         bool
	Error      string
	At         time.Time
}

const maxClipLogEntries = 100

// recordClipSyncResult 记一条正文同步结果供状态面板回放：active_transfers 只含进行中的
// 传输，完成后即摘除，故单独留一份有界历史。
func (n *Node) recordClipSyncResult(peer *store.Peer, itemID []byte, mime string, ok bool, errMsg string) {
	entry := ClipSyncEntry{
		DeviceID: peer.DeviceID, DeviceName: peer.Name, Mime: mime,
		ItemID: hex.EncodeToString(itemID), OK: ok, Error: errMsg, At: time.Now(),
	}
	n.clipLogMu.Lock()
	n.clipSyncLog = append(n.clipSyncLog, entry)
	if len(n.clipSyncLog) > maxClipLogEntries {
		n.clipSyncLog = n.clipSyncLog[len(n.clipSyncLog)-maxClipLogEntries:]
	}
	n.clipLogMu.Unlock()
	// 只推一个信号，完整历史让界面回头查一次——事件里塞完整列表的话，
	// 每次同步都要把最近 100 条历史再序列化一遍。
	n.emit(Event{Kind: "clip_sync", DeviceID: peer.DeviceID})
}

// ClipSyncLog 返回最近的剪贴板正文同步历史，供界面挂载时补齐现状。
func (n *Node) ClipSyncLog() []ClipSyncEntry {
	n.clipLogMu.Lock()
	defer n.clipLogMu.Unlock()
	out := make([]ClipSyncEntry, len(n.clipSyncLog))
	copy(out, n.clipSyncLog)
	return out
}

// ClipConflictEntry 记一次"这条内容是在对方不知道我这边现状的情况下产生的"。
type ClipConflictEntry struct {
	DeviceID    string
	DeviceName  string
	IncomingHLC string
	LocalHLC    string
	At          time.Time
}

const maxClipConflicts = 50

// checkClipConflict 判断新收到的内容与本机当前内容是否无因果关系。
// 用单指针因果链（CausalRef 指向发出方创建前最后见过的那条），不用向量时钟：本机当前
// 剪贴板只有一个值，指针比对是精确判据。HLC 只保证可排序，不等于因果。
// 只播报不仲裁（同 wire.Continuity）：先到先生效，仅告知用户这两条是并发的。
func (n *Node) checkClipConflict(peer *store.Peer, incoming *clipboard.Item) {
	mine := n.lastSeen()
	if len(mine) == 0 {
		return // 本机还没有任何剪贴板内容，谈不上冲突
	}
	if bytes.Equal(mine, incoming.ID) {
		return // 同一条内容（比如重复的 announce），不是冲突
	}
	if bytes.Equal(incoming.CausalRef, mine) {
		return // 对方是在看到我这条之后才复制的新内容——正常的先后关系
	}

	entry := ClipConflictEntry{
		DeviceID: peer.DeviceID, DeviceName: peer.Name,
		IncomingHLC: incoming.HLC.String(), At: time.Now(),
	}
	if cur := n.currentItem(); cur != nil {
		entry.LocalHLC = cur.HLC.String()
	}
	n.clipLogMu.Lock()
	n.clipConflicts = append(n.clipConflicts, entry)
	if len(n.clipConflicts) > maxClipConflicts {
		n.clipConflicts = n.clipConflicts[len(n.clipConflicts)-maxClipConflicts:]
	}
	n.clipLogMu.Unlock()
	n.emit(Event{Kind: "clip_conflict", DeviceID: peer.DeviceID})
}

// ClipConflicts 返回最近检测到的因果冲突，供界面挂载时补齐现状。
func (n *Node) ClipConflicts() []ClipConflictEntry {
	n.clipLogMu.Lock()
	defer n.clipLogMu.Unlock()
	out := make([]ClipConflictEntry, len(n.clipConflicts))
	copy(out, n.clipConflicts)
	return out
}
