// Package clipboard 实现跨设备剪贴板的多表示模型、去重与回环抑制，设计见 docs/01-架构与技术原理.md
// §8。
package clipboard

import (
	"errors"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
	"lukechampine.com/blake3"

	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

const (
	// InlineLimit：二进制表示（图片等）小于此值才内联在 announce 里；
	// 更大的只发 hash，正文走文件传输通道或按需拉取。
	InlineLimit = 4 << 10

	// InlineTextBudget：文本类表示（纯文本 / HTML / RTF / 公式）合计不超此值则全部内联、一帧送达。
	// 网页或 Word 复制的长文本常达几十 KiB，按 4 KiB 切会进入"先元数据、再推正文、到齐才交付"的两段式，
	// 任一段卡住就不落地。
	// 留 256 KiB 给帧头与其余字段，保证整帧不超过 wire.MaxFrameSize。
	InlineTextBudget = 768 << 10

	// DedupWindow：记住最近 N 条 item_id。
	DedupWindow = 200

	// DedupTTL：已交付内容在此时间内再到达视为回环并丢弃；超时的同内容是用户真的又复制了，须照常交付。
	// 以前按"最近 200 条"永久去重，复制 A、B 再复制 A 会让 A 永远同步不过去。
	DedupTTL = 3 * time.Second

	// EchoSuppress：写入本机剪贴板后此窗口内本机监听器再见同样内容，视为自己刚写的、不再广播。
	// 5 秒是权衡：太短挡不住慢剪贴板回调，太长会让用户手动再复制同样内容失效。
	EchoSuppress = 5 * time.Second
)

// 常用 MIME。
const (
	MimeText   = "text/plain;charset=utf-8"
	MimeHTML   = "text/html"
	MimeRTF    = "application/rtf"
	MimeLaTeX  = "text/x-tex"
	MimeMathML = "application/mathml+xml"
	MimePNG    = "image/png"
	MimeJPEG   = "image/jpeg"
)

// Rep 是同一份内容的一种表示。
type Rep struct {
	Mime string
	Size int64
	Hash []byte
	Data []byte // 大表示时为 nil，需按需拉取
}

// Item 是一条剪贴板内容。
type Item struct {
	ID        []byte
	HLC       HLC
	Source    string
	Preferred string
	Sensitive bool
	BurnAfter bool
	ExpiresAt time.Time
	Reps      []Rep

	// CausalRef 是创建方复制前最后见过的那条内容的 ID，由 Node.LocalCopy 填入（见 node.go）；
	// 本包不计算，"最后见过"是节点状态。
	CausalRef []byte

	// Replay：重连后补发的内容。接收端若已有更新的内容就不覆盖。
	Replay bool
	// Force：用户手动发送，接收端跳过回环去重。
	Force bool
}

// isTextual 报告一个表示是否是文本类（可安全整段内联）。
func isTextual(mime string) bool {
	return strings.HasPrefix(mime, "text/") || mime == MimeRTF || mime == MimeMathML
}

// IsTextual 是 isTextual 的导出版本：按设备过滤「只同步文字」时用同一个判据。
func IsTextual(mime string) bool { return isTextual(mime) }

// TextOnly 返回只含文字类表示的浅拷贝（ID、HLC 等身份字段不变），一个文字类
// 表示都没有时返回 nil。首选表示被滤掉时改用纯文本，没有纯文本就用剩下的第一个。
func (it *Item) TextOnly() *Item {
	kept := make([]Rep, 0, len(it.Reps))
	for _, r := range it.Reps {
		if isTextual(r.Mime) {
			kept = append(kept, r)
		}
	}
	if len(kept) == 0 {
		return nil
	}
	cp := *it
	cp.Reps = kept
	if _, ok := cp.Rep(cp.Preferred); !ok {
		cp.Preferred = kept[0].Mime
		if _, ok := cp.Rep(MimeText); ok {
			cp.Preferred = MimeText
		}
	}
	return &cp
}

// inlinePlan 决定每个表示是否内联。ToAnnounce 与 NonInlineReps 必须共用这一判据，否则发送端漏推或重
// 推。
// 首选表示优先占文本预算，其余文本表示按序填入，二进制表示只在很小时内联。
func (it *Item) inlinePlan() []bool {
	plan := make([]bool, len(it.Reps))
	var used int64
	order := make([]int, 0, len(it.Reps))
	for i, r := range it.Reps {
		if r.Mime == it.Preferred {
			order = append([]int{i}, order...)
		} else {
			order = append(order, i)
		}
	}
	for _, i := range order {
		r := it.Reps[i]
		if r.Data == nil {
			continue
		}
		switch {
		case r.Size <= InlineLimit:
			plan[i] = true
			used += r.Size
		case isTextual(r.Mime) && used+r.Size <= InlineTextBudget:
			plan[i] = true
			used += r.Size
		}
	}
	return plan
}

// Rep 按 MIME 查找某个表示。
func (it *Item) Rep(mime string) (Rep, bool) {
	for _, r := range it.Reps {
		if r.Mime == mime {
			return r, true
		}
	}
	return Rep{}, false
}

// Text 返回纯文本表示，UI 预览与兜底粘贴都用它。
func (it *Item) Text() string {
	if r, ok := it.Rep(MimeText); ok && r.Data != nil {
		return string(r.Data)
	}
	return ""
}

// Canonical 规范化文本后再哈希。必须用 NFC 而非 NFKC/NFKD：NFKD 会把 ² 拆成 2，"m/s²" 变 "m/s2"，
// 正是"物理符号粘贴变形"的根因；NFC 只做规范组合，符号原样保留。
func Canonical(mime string, data []byte) []byte {
	if !strings.HasPrefix(mime, "text/") && mime != MimeMathML {
		// 图片等二进制内容绝不做任何"规范化"，直接哈希原始字节。
		return data
	}
	s := norm.NFC.String(string(data))
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.TrimRightFunc(s, unicode.IsSpace)
	return []byte(s)
}

// HashRep 计算一个表示的内容哈希。
func HashRep(mime string, data []byte) []byte {
	sum := blake3.Sum256(Canonical(mime, data))
	return sum[:]
}

// NewItem 由若干表示构造一条剪贴板条目。item_id 取自首选表示规范化哈希（内容寻址），同样内容在任何
// 设备上 ID 相同，是跨设备去重的基础。
func NewItem(clk *Clock, source, preferred string, reps []Rep) (*Item, error) {
	if len(reps) == 0 {
		return nil, errors.New("剪贴板条目至少要有一种表示")
	}
	for i := range reps {
		if reps[i].Hash == nil && reps[i].Data != nil {
			reps[i].Hash = HashRep(reps[i].Mime, reps[i].Data)
		}
		if reps[i].Size == 0 && reps[i].Data != nil {
			reps[i].Size = int64(len(reps[i].Data))
		}
	}
	it := &Item{
		HLC:       clk.Now(),
		Source:    source,
		Preferred: preferred,
		Reps:      reps,
	}
	pref, ok := it.Rep(preferred)
	if !ok {
		pref = reps[0]
		it.Preferred = pref.Mime
	}
	it.ID = append([]byte(nil), pref.Hash[:16]...)
	return it, nil
}

// ToAnnounce 转成线上消息。按 inlinePlan 内联，其余只发元数据。
func (it *Item) ToAnnounce(seq uint64, targets []string) *wire.ClipAnnounce {
	a := &wire.ClipAnnounce{
		ItemID:    it.ID,
		HLC:       it.HLC.String(),
		Source:    it.Source,
		Preferred: it.Preferred,
		Sensitive: it.Sensitive,
		Targets:   targets,
		Seq:       seq,
		BurnAfter: it.BurnAfter,
		CausalRef: it.CausalRef,
		Replay:    it.Replay,
		Force:     it.Force,
	}
	if !it.ExpiresAt.IsZero() {
		a.ExpiresAt = it.ExpiresAt.UnixMilli()
	}
	plan := it.inlinePlan()
	for i, r := range it.Reps {
		wr := wire.Rep{Mime: r.Mime, Size: r.Size, Hash: r.Hash}
		if plan[i] {
			wr.Inline = r.Data
		}
		a.Reps = append(a.Reps, wr)
	}
	return a
}

// FromAnnounce 由线上消息还原条目。
func FromAnnounce(a *wire.ClipAnnounce) (*Item, error) {
	h, err := ParseHLC(a.HLC)
	if err != nil {
		return nil, err
	}
	it := &Item{
		ID:        a.ItemID,
		HLC:       h,
		Source:    a.Source,
		Preferred: a.Preferred,
		Sensitive: a.Sensitive,
		BurnAfter: a.BurnAfter,
		CausalRef: a.CausalRef,
		Replay:    a.Replay,
		Force:     a.Force,
	}
	if a.ExpiresAt > 0 {
		it.ExpiresAt = time.UnixMilli(a.ExpiresAt)
	}
	for _, r := range a.Reps {
		if r.Size < 0 {
			return nil, errors.New("剪贴板表示长度非法")
		}
		rep := Rep{Mime: r.Mime, Size: r.Size, Hash: r.Hash}
		if r.Size == 0 && r.Inline == nil {
			// omitempty 会把空正文编码成"没有 Inline"，不能把它当成待拉取——
			// 发送端不会为 0 字节的表示推送任何东西，接收端会永远等下去。
			r.Inline = []byte{}
		}
		if r.Inline != nil {
			// 内联数据必须校验哈希：否则一个被篡改的表示会被静默接受。
			if got := HashRep(r.Mime, r.Inline); !equalBytes(got, r.Hash) {
				return nil, errors.New("内联表示哈希不匹配，内容可能已损坏")
			}
			rep.Data = r.Inline
		}
		it.Reps = append(it.Reps, rep)
	}
	if len(it.Reps) == 0 {
		return nil, errors.New("剪贴板消息不含任何表示")
	}
	return it, nil
}

// MissingReps 返回需要向对端拉取正文的表示。只对接收端重建的条目有意义：
// FromAnnounce 只给内联表示填 Data，其余为 nil 即"还没到手"；发送端自己的 Item 的 Data 始终是满的，
// 调用必得空列表。
// 要知道对端会不会内联收到，用 NonInlineReps。
func (it *Item) MissingReps() []string {
	var out []string
	for _, r := range it.Reps {
		if r.Data == nil {
			out = append(out, r.Mime)
		}
	}
	return out
}

// NonInlineReps 返回 ToAnnounce 不会内联、对端收到时处于"缺失"状态的表示。
// 判据与 ToAnnounce 共用 inlinePlan，对不上则发送端漏推表示（接收端在等而发送端以为已内联），或徒劳
// 重传。
func (it *Item) NonInlineReps() []string {
	var out []string
	plan := it.inlinePlan()
	for i, r := range it.Reps {
		if !plan[i] && r.Data != nil {
			out = append(out, r.Mime)
		}
	}
	return out
}

// HasUsableText 报告条目里是否已经有可以直接写进剪贴板的内容：首选表示已到，
// 或者纯文本已到。用于「其余表示迟迟不到时先交付已有的」。
func (it *Item) HasUsableText() bool {
	for _, r := range it.Reps {
		if r.Data == nil {
			continue
		}
		if r.Mime == it.Preferred || strings.HasPrefix(r.Mime, "text/plain") {
			return true
		}
	}
	return false
}

// Available 返回只含已到手表示的副本，一个都没有时返回 nil；首选表示缺席时改用第一个已到的。
// 原条目不变，后续到达的表示仍可 SetRepData 进原条目。
func (it *Item) Available() *Item {
	cp := *it
	cp.Reps = make([]Rep, 0, len(it.Reps))
	for _, r := range it.Reps {
		if r.Data != nil {
			cp.Reps = append(cp.Reps, r)
		}
	}
	if len(cp.Reps) == 0 {
		return nil
	}
	if _, ok := cp.Rep(cp.Preferred); !ok {
		cp.Preferred = cp.Reps[0].Mime
	}
	return &cp
}

// SetRepData 填入按需拉取回来的正文，并校验哈希。
func (it *Item) SetRepData(mime string, data []byte) error {
	for i := range it.Reps {
		if it.Reps[i].Mime != mime {
			continue
		}
		if got := HashRep(mime, data); !equalBytes(got, it.Reps[i].Hash) {
			return errors.New("拉取到的表示哈希不匹配")
		}
		it.Reps[i].Data = data
		return nil
	}
	return errors.New("没有这种表示: " + mime)
}

// ---------- 去重与回环抑制 ----------

// Tracker 打破"A 复制 → B 写入 → B 误判为新复制 → 传回 A"的无限循环，三重防护（见 docs/01 §8.1）：
// 1. seen：最近 N 条 item_id，重复直接丢
// 2. written：本机刚写入系统剪贴板的内容哈希，本机监听器再见到不广播
// 3. Source 检查：由调用方判断，收到自己发的直接丢
type Tracker struct {
	mu      sync.Mutex
	seen    map[string]time.Time
	order   []string
	written map[string]time.Time
}

func NewTracker() *Tracker {
	return &Tracker{
		seen:    make(map[string]time.Time),
		written: make(map[string]time.Time),
	}
}

// Seen 登记一个 item_id，返回 true 表示 DedupTTL 内已经见过（应当丢弃）。
func (t *Tracker) Seen(id []byte) bool {
	if t.Recent(id) {
		return true
	}
	t.Mark(id)
	return false
}

// Recent 报告 item_id 是否在 DedupTTL 内登记过，不改变状态。
func (t *Tracker) Recent(id []byte) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	ts, ok := t.seen[string(id)]
	return ok && time.Since(ts) < DedupTTL
}

// Mark 登记（或刷新）item_id 的交付时间，只在内容真正交付或本机创建时调用：
// 以前收到 announce 就登记，校验失败、正文未到齐的内容也被记成"见过"，之后重发多少次都当重复丢掉。
func (t *Tracker) Mark(id []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	k := string(id)
	if _, ok := t.seen[k]; !ok {
		t.order = append(t.order, k)
	}
	t.seen[k] = time.Now()
	for len(t.order) > DedupWindow {
		delete(t.seen, t.order[0])
		t.order = t.order[1:]
	}
}

// MarkWritten 在把内容写进系统剪贴板之前调用。
func (t *Tracker) MarkWritten(hash []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.gcWrittenLocked()
	t.written[string(hash)] = time.Now()
}

// IsEcho 判断本机剪贴板监听器捕获到的内容是不是"我们自己刚写进去的"。
func (t *Tracker) IsEcho(hash []byte) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.gcWrittenLocked()
	ts, ok := t.written[string(hash)]
	return ok && time.Since(ts) < EchoSuppress
}

func (t *Tracker) gcWrittenLocked() {
	for k, ts := range t.written {
		if time.Since(ts) >= EchoSuppress {
			delete(t.written, k)
		}
	}
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
