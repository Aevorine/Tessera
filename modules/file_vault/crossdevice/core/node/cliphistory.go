package node

// 跨设备剪贴板时间线：内存里保留最近复制的内容（本机的、对端同步来的、重连时向对端
// 补要的）。只在内存、不落盘；敏感内容（密码管理器标记）与阅后即焚内容从不进入。

import (
	"bytes"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

const (
	// clipHistoryMax 是时间线最多保留的条数。
	clipHistoryMax = 50
	// clipHistoryBytes 是时间线里正文的总预算；超出时从最旧的一条开始整条丢掉。
	clipHistoryBytes = 16 << 20
	// clipHistoryRepMax：单个表示超过它就只留元数据，要用时再向来源设备拉取。
	clipHistoryRepMax = 8 << 20
	// clipHistoryShare 是一次回复给对端的最多条数。
	clipHistoryShare = 30
	// clipHistoryPreview 是预览最多保留的字符数。
	clipHistoryPreview = 200
	// clipHistInlineRep / clipHistInlineTotal：回复里内联正文的单条与总量上限。
	// 总量必须远低于 wire.MaxFrameSize（1 MiB），给 CBOR 头与预览留足余量。
	clipHistInlineRep   = 64 << 10
	clipHistInlineTotal = 640 << 10
)

// 时间线条目的来路。
const (
	ClipViaLocal = "local" // 本机复制
	ClipViaSync  = "sync"  // 对端复制后实时同步过来
	ClipViaPull  = "pull"  // 连上对端时向它要来的摘要（断线期间对方复制的）
)

// ClipHistoryEntry 是时间线上的一条，供界面列出。
type ClipHistoryEntry struct {
	ItemID    []byte
	Source    string // 最初复制它的设备
	Via       string
	Preferred string
	At        time.Time // 复制发生的时刻（HLC 墙钟）
	Preview   string
	Kinds     []ClipHistoryKind
	// Complete：所有表示的正文都在本机。
	Complete bool
	// Usable：首选表示或纯文本的正文在本机，不用联网就能再次粘贴。
	Usable bool
}

// ClipHistoryKind 是一条内容的一种表示。
type ClipHistoryKind struct {
	Mime  string
	Size  int64
	Ready bool // 正文在本机
}

type clipHistEntry struct {
	item    *clipboard.Item
	via     string
	preview string
	bytes   int
}

type clipHistory struct {
	mu      sync.Mutex
	entries []*clipHistEntry // 新的在前（按 HLC）
	bytes   int
}

// recordClipHistory 把一条内容记进时间线。改变了时间线就广播一次 clip_timeline 事件。
func (n *Node) recordClipHistory(it *clipboard.Item, via, preview string) {
	if it == nil || it.Sensitive || it.BurnAfter || len(it.ID) == 0 {
		return
	}
	if n.clipHist.put(it, via, preview) {
		n.emit(Event{Kind: "clip_timeline", DeviceID: it.Source})
	}
}

func (h *clipHistory) put(it *clipboard.Item, via, preview string) bool {
	cp := *it
	cp.Replay, cp.Force = false, false
	cp.Reps = make([]clipboard.Rep, len(it.Reps))
	size := 0
	for i, r := range it.Reps {
		cp.Reps[i] = clipboard.Rep{Mime: r.Mime, Size: r.Size, Hash: r.Hash}
		if r.Data != nil && len(r.Data) <= clipHistoryRepMax {
			cp.Reps[i].Data = r.Data
			size += len(r.Data)
		}
	}
	if p := previewOf(&cp); p != "" {
		preview = p
	}
	e := &clipHistEntry{item: &cp, via: via, preview: preview, bytes: size}

	h.mu.Lock()
	defer h.mu.Unlock()
	for i, old := range h.entries {
		if !bytes.Equal(old.item.ID, cp.ID) {
			continue
		}
		if via == ClipViaPull {
			// 本机已有这条（多半是实时同步来的，正文齐全），摘要不能把它换掉。
			return false
		}
		// 同一内容又复制了一次：移到它新的时间位置上，正文取两份里更全的。
		for j := range cp.Reps {
			if cp.Reps[j].Data == nil {
				if r, ok := old.item.Rep(cp.Reps[j].Mime); ok && r.Data != nil && bytes.Equal(r.Hash, cp.Reps[j].Hash) {
					cp.Reps[j].Data = r.Data
					e.bytes += len(r.Data)
				}
			}
		}
		h.bytes -= old.bytes
		h.entries = slices.Delete(h.entries, i, i+1)
		break
	}
	pos, _ := slices.BinarySearchFunc(h.entries, e, func(a, b *clipHistEntry) int {
		// 新的在前：a 比 b 新时 a 应排在前面。
		switch {
		case a.item.HLC.After(b.item.HLC):
			return -1
		case b.item.HLC.After(a.item.HLC):
			return 1
		}
		return 0
	})
	h.entries = slices.Insert(h.entries, pos, e)
	h.bytes += e.bytes
	for len(h.entries) > clipHistoryMax || (h.bytes > clipHistoryBytes && len(h.entries) > 1) {
		last := h.entries[len(h.entries)-1]
		h.bytes -= last.bytes
		h.entries = h.entries[:len(h.entries)-1]
	}
	return slices.Contains(h.entries, e)
}

// previewOf 取纯文本开头一小段，空白折叠成单个空格。没有纯文本正文时返回空串。
func previewOf(it *clipboard.Item) string {
	var text []byte
	for _, r := range it.Reps {
		if strings.HasPrefix(r.Mime, "text/plain") && r.Data != nil {
			text = r.Data
			break
		}
	}
	if text == nil {
		return ""
	}
	return clampPreview(string(text))
}

func clampPreview(s string) string {
	var b strings.Builder
	space := false
	count := 0
	for _, r := range s {
		if r == utf8.RuneError || unicode.IsControl(r) && !unicode.IsSpace(r) {
			continue
		}
		if unicode.IsSpace(r) {
			space = b.Len() > 0
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
			count++
		}
		b.WriteRune(r)
		count++
		if count >= clipHistoryPreview {
			b.WriteString("…")
			break
		}
	}
	return b.String()
}

// ClipHistory 返回时间线快照，新的在前。过期的内容不列出。
func (n *Node) ClipHistory() []ClipHistoryEntry {
	now := time.Now()
	n.clipHist.mu.Lock()
	defer n.clipHist.mu.Unlock()
	out := make([]ClipHistoryEntry, 0, len(n.clipHist.entries))
	for _, e := range n.clipHist.entries {
		it := e.item
		if !it.ExpiresAt.IsZero() && now.After(it.ExpiresAt) {
			continue
		}
		x := ClipHistoryEntry{
			ItemID: append([]byte(nil), it.ID...), Source: it.Source, Via: e.via,
			Preferred: it.Preferred, At: it.HLC.Time(), Preview: e.preview, Complete: true,
		}
		for _, r := range it.Reps {
			ready := r.Data != nil
			x.Complete = x.Complete && ready
			x.Kinds = append(x.Kinds, ClipHistoryKind{Mime: r.Mime, Size: r.Size, Ready: ready})
		}
		x.Usable = it.HasUsableText()
		out = append(out, x)
	}
	return out
}

// RemoveClipHistory 从时间线删掉一条。
func (n *Node) RemoveClipHistory(itemID []byte) bool {
	h := &n.clipHist
	h.mu.Lock()
	removed := false
	for i, e := range h.entries {
		if bytes.Equal(e.item.ID, itemID) {
			h.bytes -= e.bytes
			h.entries = slices.Delete(h.entries, i, i+1)
			removed = true
			break
		}
	}
	h.mu.Unlock()
	if removed {
		n.emit(Event{Kind: "clip_timeline"})
	}
	return removed
}

// ClearClipHistory 清空时间线。
func (n *Node) ClearClipHistory() {
	h := &n.clipHist
	h.mu.Lock()
	h.entries, h.bytes = nil, 0
	h.mu.Unlock()
	n.emit(Event{Kind: "clip_timeline"})
}

// historyItem 返回时间线里某条内容的副本（表示的正文可能不全）。
func (n *Node) historyItem(itemID []byte) *clipboard.Item {
	h := &n.clipHist
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, e := range h.entries {
		if bytes.Equal(e.item.ID, itemID) {
			cp := *e.item
			cp.Reps = slices.Clone(e.item.Reps)
			return &cp
		}
	}
	return nil
}

// ownHistoryItem 供 CLIP_FETCH 兜底：内容已不在短期缓存，但仍在时间线上且是本机自己
// 复制的。从第三台设备收到的内容不转手（理由同 ClipHistory 消息的注释）。
func (n *Node) ownHistoryItem(itemID []byte) *clipboard.Item {
	it := n.historyItem(itemID)
	if it == nil || it.Source != n.id.DeviceID() {
		return nil
	}
	return it
}

// fillHistoryData 把按需拉取回来的正文补进时间线，下次再粘贴就不用再拉。
func (h *clipHistory) fillHistoryData(itemID []byte, mime string, data []byte) {
	if len(data) > clipHistoryRepMax {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, e := range h.entries {
		if !bytes.Equal(e.item.ID, itemID) {
			continue
		}
		// 条目的表示切片可能正被 historyItem 的调用方读着（浅拷贝），换一份新的再改。
		reps := slices.Clone(e.item.Reps)
		for i := range reps {
			if reps[i].Mime == mime && reps[i].Data == nil {
				reps[i].Data = data
				e.bytes += len(data)
				h.bytes += len(data)
			}
		}
		cp := *e.item
		cp.Reps = reps
		e.item = &cp
		if e.preview == "" {
			e.preview = previewOf(&cp)
		}
		return
	}
}

// ErrClipSourceOffline 表示要再次粘贴的内容正文不在本机，来源设备又不在线。
var ErrClipSourceOffline = errors.New("clip_source_offline")

// ClipHistoryContent 取时间线上一条内容的完整正文。缺的表示向来源设备按需拉取；
// 只要纯文本或首选表示到手就返回（其余表示拉不到不拖累整条）。
func (n *Node) ClipHistoryContent(itemID []byte) (*clipboard.Item, error) {
	it := n.historyItem(itemID)
	if it == nil {
		return nil, errors.New("clip_not_found")
	}
	missing := it.MissingReps()
	if len(missing) > 0 {
		if s, ok := n.SessionFor(it.Source); ok {
			for _, mime := range missing {
				r, _ := it.Rep(mime)
				data, err := s.fetchRep(it.ID, mime, r.Size)
				if err == nil {
					err = it.SetRepData(mime, data)
				}
				if err != nil {
					n.logf("时间线拉取 %s 的 %s 失败: %v", it.Source, mime, err)
					continue
				}
				n.clipHist.fillHistoryData(it.ID, mime, data)
			}
		}
	}
	avail := it.Available()
	if avail == nil || (len(avail.Reps) < len(it.Reps) && !avail.HasUsableText()) {
		if _, online := n.SessionFor(it.Source); !online {
			return nil, ErrClipSourceOffline
		}
		return nil, errors.New("clip_fetch_failed")
	}
	return avail, nil
}

// ApplyClipHistory 把时间线上一条内容准备好写入本机剪贴板。
// broadcast=false：只放本机，先登记回声以免监听器把它当新复制广播出去。
// broadcast=true：当手动发送推给所有在线设备（Force，接收端不去重）。
func (n *Node) ApplyClipHistory(itemID []byte, broadcast bool, targets ...string) (*clipboard.Item, []error, error) {
	it, err := n.ClipHistoryContent(itemID)
	if err != nil {
		return nil, nil, err
	}
	if !broadcast {
		for _, r := range it.Reps {
			if r.Hash != nil {
				n.track.MarkWritten(r.Hash)
			}
		}
		return it, nil, nil
	}
	reps := make([]clipboard.Rep, len(it.Reps))
	for i, r := range it.Reps {
		reps[i] = clipboard.Rep{Mime: r.Mime, Data: r.Data}
	}
	fresh, err := n.ManualCopy(it.Preferred, reps)
	if err != nil {
		return nil, nil, err
	}
	for _, r := range fresh.Reps {
		n.track.MarkWritten(r.Hash)
	}
	_, errs := n.BroadcastClipCount(fresh, targets...)
	return fresh, errs, nil
}

// ---------- 与对端交换时间线 ----------

func (s *Session) supportsClipHist() bool {
	return slices.Contains(s.peerFeatures, wire.ClipHistFeature)
}

// requestClipHistory 向对端要它自己最近复制过的内容摘要。
func (s *Session) requestClipHistory() {
	if !s.supportsClipHist() || s.node.ClipPolicyFor(s.peer.DeviceID) == store.ClipOff {
		return
	}
	s.histAsked.Store(true)
	if err := s.wc.WriteMsg(wire.TypeClipHistoryReq, 0, &wire.ClipHistoryReq{Limit: clipHistoryShare}); err != nil {
		s.histAsked.Store(false)
		s.node.logf("向 %s 请求剪贴板时间线失败: %v", s.PeerName(), err)
	}
}

// RefreshClipHistory 向所有在线且支持时间线的对端重新要一次摘要。
// 回复异步到达，到了会发 clip_timeline 事件。
func (n *Node) RefreshClipHistory() int {
	asked := 0
	for _, s := range n.Sessions() {
		if s.supportsClipHist() {
			go s.requestClipHistory()
			asked++
		}
	}
	return asked
}

func (s *Session) onClipHistoryReq(f *wire.Frame) error {
	var q wire.ClipHistoryReq
	if err := wire.Unmarshal(f.Payload, &q); err != nil {
		return err
	}
	limit := q.Limit
	if limit <= 0 || limit > clipHistoryShare {
		limit = clipHistoryShare
	}
	self := s.node.id.DeviceID()
	now := time.Now()
	h := &s.node.clipHist
	h.mu.Lock()
	var picked []*clipHistEntry
	for _, e := range h.entries {
		if len(picked) >= limit {
			break
		}
		it := e.item
		if it.Source != self || (!it.ExpiresAt.IsZero() && now.After(it.ExpiresAt)) {
			continue
		}
		picked = append(picked, e)
	}
	h.mu.Unlock()

	resp := &wire.ClipHistory{Entries: make([]wire.ClipHistoryEntry, 0, len(picked))}
	budget := clipHistInlineTotal
	for _, e := range picked {
		// 时间线也按同步范围给：不同步剪贴板的设备拿不到本机复制过什么。
		it := s.node.filterClipFor(s.peer.DeviceID, e.item)
		if it == nil {
			continue
		}
		a := wire.ClipAnnounce{
			ItemID: it.ID, HLC: it.HLC.String(), Source: it.Source, Preferred: it.Preferred,
		}
		if !it.ExpiresAt.IsZero() {
			a.ExpiresAt = it.ExpiresAt.UnixMilli()
		}
		for _, r := range it.Reps {
			wr := wire.Rep{Mime: r.Mime, Size: r.Size, Hash: r.Hash}
			if r.Data != nil && len(r.Data) <= clipHistInlineRep && len(r.Data) <= budget &&
				(strings.HasPrefix(r.Mime, "text/") || len(r.Data) <= clipboard.InlineLimit) {
				wr.Inline = r.Data
				budget -= len(r.Data)
			}
			a.Reps = append(a.Reps, wr)
		}
		resp.Entries = append(resp.Entries, wire.ClipHistoryEntry{Item: a, Preview: e.preview})
	}
	return s.wc.WriteMsg(wire.TypeClipHistory, 0, resp)
}

func (s *Session) onClipHistory(f *wire.Frame) error {
	// 只收自己要过的回复：对端不请自来地塞一大堆条目进时间线，没有正当理由。
	if !s.histAsked.CompareAndSwap(true, false) {
		return nil
	}
	var h wire.ClipHistory
	if err := wire.Unmarshal(f.Payload, &h); err != nil {
		return err
	}
	if len(h.Entries) > clipHistoryShare {
		h.Entries = h.Entries[:clipHistoryShare]
	}
	changed := false
	for i := range h.Entries {
		a := &h.Entries[i].Item
		// 对端只能替自己作证：冒充别的设备来源的条目一律丢掉。
		if a.Source != s.peer.DeviceID || a.Sensitive || a.BurnAfter {
			continue
		}
		it, err := clipboard.FromAnnounce(a)
		if err != nil || len(it.Reps) == 0 {
			continue
		}
		if it = s.node.filterClipFor(s.peer.DeviceID, it); it == nil {
			continue
		}
		if hlc, err := clipboard.ParseHLC(a.HLC); err == nil {
			s.node.clock.Observe(hlc)
		}
		if s.node.clipHist.put(it, ClipViaPull, clampPreview(h.Entries[i].Preview)) {
			changed = true
		}
	}
	if changed {
		s.node.emit(Event{Kind: "clip_timeline", DeviceID: s.peer.DeviceID})
	}
	return nil
}
