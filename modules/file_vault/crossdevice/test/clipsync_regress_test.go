package test

// 剪贴板同步可靠性回归：长段英文 + 特殊符号、重复复制、手动重发、断线期间复制。
// 每一条都对应一种"发出去了但对面没反应"且不报错的真实失败方式。

import (
	"strings"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
)

// longSymbolText 生成 n 字节左右的长段英文，夹带排版符号、数学符号、Emoji、
// 行分隔符、不换行空格、BOM、制表符与 CRLF——网页、PDF、Word 复制出来的真实样貌。
func longSymbolText(n int) string {
	runes := []rune{
		'T', 'h', 'e', ' ', 'q', 'u', 'i', 'c', 'k', ' ', 0x2014, ' ', 0x201c, 'f', 'o', 'x', 0x201d, ' ',
		0x2018, 'j', 0x2019, 0x2026, ' ', 0x00a9, 0x00ae, 0x2122, 0x00a7, 0x00b6, 0x2020, 0x2021, 0x2022,
		' ', 0x2211, 0x222b, 0x221a, 0x221e, 0x2248, 0x2260, 0x2264, 0x2265, 0x00b1, 0x00d7, 0x00f7, 0x00b0,
		' ', 'x', 0x00b2, ' ', 'H', 0x2082, 'O', ' ', 0x03b1, 0x03b2, 0x0394, 0x03a9, ' ', 0x1F600, 0x1F52C,
		' ', '<', 'a', ' ', 'h', 'r', 'e', 'f', '=', '"', 'x', '"', '>', '&', 'a', 'm', 'p', ';', '<', '/', 'a', '>',
		' ', '{', '}', '[', ']', '|', '\\', '`', '~', '^', '$', '#', '@', '!', '%', '*', '(', ')', '_', '+', '=',
		' ', 0x00a0, 0x200b, 0x2028, 0x2029, 0xFEFF, '\t', '\r', '\n',
	}
	var b strings.Builder
	for b.Len() < n {
		for _, r := range runes {
			b.WriteRune(r)
		}
	}
	return strings.ToValidUTF8(b.String()[:n], "")
}

func clipProgressCount(tn *testNode) int {
	c := 0
	for _, p := range tn.progress() {
		if p.Kind == "clip" {
			c++
		}
	}
	return c
}

func waitNoSession(t *testing.T, tn *testNode, peerID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := tn.SessionFor(peerID); !ok {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s 的会话没有断开", tn.name)
}

// TestB1_LongEnglishWithSymbolsArrivesInOneFrame：长文本 + HTML 富格式一帧送达，
// 不再落进「先发元数据、再推正文」的两段式流程。
func TestB1_LongEnglishWithSymbolsArrivesInOneFrame(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	text := longSymbolText(24 << 10)
	html := "<html><body><p style=\"font-family:Times New Roman\">" + longSymbolText(96<<10) + "</p></body></html>"
	rtf := `{\rtf1\ansi\deff0 {\fonttbl {\f0 Times New Roman;}}\f0 ` + strings.Repeat(`The quick 舒? fox 舠?q舡? `, 2000) + `}`

	for _, dir := range [][2]*testNode{{pc, ph}, {ph, pc}} {
		from, to := dir[0], dir[1]
		tag := from.name
		it, err := from.LocalCopy(clipboard.MimeText, []clipboard.Rep{
			{Mime: clipboard.MimeText, Data: []byte(text + tag)},
			{Mime: clipboard.MimeHTML, Data: []byte(html + tag)},
			{Mime: clipboard.MimeRTF, Data: []byte(rtf + tag)},
		})
		if err != nil || it == nil {
			t.Fatalf("B1 失败：本地复制出错 %v", err)
		}
		if errs := from.BroadcastClip(it); len(errs) > 0 {
			t.Fatalf("B1 失败：广播出错 %v", errs)
		}
		items := to.waitClip(1, 10*time.Second)
		got := items[len(items)-1]
		if got.Text() != text+tag {
			t.Fatalf("B1 失败：%s→%s 纯文本不一致（%d vs %d 字节）", from.name, to.name, len(got.Text()), len(text+tag))
		}
		for _, m := range []string{clipboard.MimeHTML, clipboard.MimeRTF} {
			r, ok := got.Rep(m)
			if !ok || r.Data == nil {
				t.Fatalf("B1 失败：%s→%s 缺少 %s 表示", from.name, to.name, m)
			}
		}
		to.clipMu.Lock()
		to.clipGot = nil
		to.clipMu.Unlock()
	}
	if c := clipProgressCount(pc) + clipProgressCount(ph); c != 0 {
		t.Fatalf("B1 失败：长文本仍然走了正文推送通道（%d 次进度事件）", c)
	}
}

// TestB2_RecopyEarlierContentIsDeliveredAgain：复制 A、B 再复制 A，A 必须再次到达。
// 以前接收端按「最近 200 条」永久去重，第二次的 A 被当成重复静默丢弃。
func TestB2_RecopyEarlierContentIsDeliveredAgain(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	a := longSymbolText(9000)
	b := "short B"
	for i, s := range []string{a, b} {
		if _, errs := pc.CopyText(s); len(errs) > 0 {
			t.Fatal(errs)
		}
		ph.waitClip(i+1, 10*time.Second)
	}
	time.Sleep(clipboard.DedupTTL + 200*time.Millisecond)
	if _, errs := pc.CopyText(a); len(errs) > 0 {
		t.Fatal(errs)
	}
	items := ph.waitClip(3, 10*time.Second)
	if items[2].Text() != a {
		t.Fatal("B2 失败：第三次到达的不是 A")
	}
}

// TestB3_ForceResendBypassesDedup：用户手动重发同一内容，接收端不能因为
// "刚收到过"而吞掉。
func TestB3_ForceResendBypassesDedup(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	text := longSymbolText(6000)
	it, errs := pc.CopyText(text)
	if len(errs) > 0 || it == nil {
		t.Fatal(errs)
	}
	ph.waitClip(1, 10*time.Second)

	again := *it
	again.Force = true
	if errs := pc.BroadcastClip(&again); len(errs) > 0 {
		t.Fatal(errs)
	}
	items := ph.waitClip(2, 10*time.Second)
	if items[1].Text() != text {
		t.Fatal("B3 失败：手动重发的内容不一致")
	}
}

// TestB4_CopyWhileDisconnectedIsReplayed：断线期间复制的内容，重连后自动补到。
func TestB4_CopyWhileDisconnectedIsReplayed(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)
	sess.Close("模拟息屏断网")
	waitNoSession(t, pc, ph.Identity().DeviceID())
	waitNoSession(t, ph, pc.Identity().DeviceID())

	text := longSymbolText(12000)
	if _, errs := pc.CopyText(text); len(errs) > 0 {
		t.Fatal(errs)
	}
	connect(t, pc, ph)
	items := ph.waitClip(1, 10*time.Second)
	if items[0].Text() != text {
		t.Fatal("B4 失败：重连补发的内容不一致")
	}
	if !items[0].Replay {
		t.Fatal("B4 失败：补发没有带 Replay 标记")
	}
}

// TestB5_ReplayNeverOverwritesNewerContent：两边断线期间各复制了一次，
// 重连后较旧的那条不能把较新的盖掉。
func TestB5_ReplayNeverOverwritesNewerContent(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)
	sess.Close("模拟断网")
	waitNoSession(t, pc, ph.Identity().DeviceID())
	waitNoSession(t, ph, pc.Identity().DeviceID())

	if _, errs := pc.CopyText("older on pc"); len(errs) > 0 {
		t.Fatal(errs)
	}
	time.Sleep(20 * time.Millisecond)
	if _, errs := ph.CopyText("newer on phone"); len(errs) > 0 {
		t.Fatal(errs)
	}
	connect(t, pc, ph)

	items := pc.waitClip(1, 10*time.Second)
	if items[0].Text() != "newer on phone" {
		t.Fatalf("B5 失败：电脑没有收到较新的内容: %q", items[0].Text())
	}
	time.Sleep(500 * time.Millisecond)
	ph.clipMu.Lock()
	n := len(ph.clipGot)
	ph.clipMu.Unlock()
	if n != 0 {
		t.Fatal("B5 失败：较旧的补发把手机上较新的内容覆盖了")
	}
	if cur := ph.CurrentItem(); cur == nil || cur.Text() != "newer on phone" {
		t.Fatal("B5 失败：手机当前内容被改动")
	}
}

// TestB6_EmptyRepresentationDoesNotBlockDelivery：某个表示是 0 字节时整条不能卡住。
func TestB6_EmptyRepresentationDoesNotBlockDelivery(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	it, err := pc.LocalCopy(clipboard.MimeText, []clipboard.Rep{
		{Mime: clipboard.MimeText, Data: []byte(longSymbolText(5000))},
		{Mime: clipboard.MimeHTML, Data: []byte{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatal(errs)
	}
	ph.waitClip(1, 5*time.Second)
}

// TestB7_OversizedRichFormatNeverHoldsTextHostage：纯文本已到、只差超大富格式时，
// 最终拿到完整内容；中途可以先交付纯文本，但不能一直什么都不给。
func TestB7_OversizedRichFormatNeverHoldsTextHostage(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	text := longSymbolText(40 << 10)
	html := []byte("<html>" + longSymbolText(2<<20) + "</html>")
	it, err := pc.LocalCopy(clipboard.MimeText, []clipboard.Rep{
		{Mime: clipboard.MimeText, Data: []byte(text)},
		{Mime: clipboard.MimeHTML, Data: html},
	})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatal(errs)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		ph.clipMu.Lock()
		items := append([]*clipboard.Item(nil), ph.clipGot...)
		ph.clipMu.Unlock()
		for _, got := range items {
			if got.Text() != text {
				t.Fatal("B7 失败：交付的纯文本不一致")
			}
			if r, ok := got.Rep(clipboard.MimeHTML); ok && r.Data != nil && string(r.Data) == string(html) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("B7 失败：超大 HTML 始终没有到齐")
}

// TestB8_EndToEndLatencyMeasured：发送端能拿到"发出 → 对端写入并确认"的真实耗时。
func TestB8_EndToEndLatencyMeasured(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	if _, errs := pc.CopyText(longSymbolText(20000)); len(errs) > 0 {
		t.Fatal(errs)
	}
	ph.waitClip(1, 10*time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if lat, _, ok := pc.ClipLatency(ph.Identity().DeviceID()); ok {
			if lat < 0 || lat > 5*time.Second {
				t.Fatalf("B8 失败：延迟数值不合理 %v", lat)
			}
			t.Logf("B8 ✅ 端到端延迟 %v", lat)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("B8 失败：没有测到端到端延迟")
}
