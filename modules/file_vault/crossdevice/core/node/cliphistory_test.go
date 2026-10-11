package node

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
)

func histItem(t *testing.T, clk *clipboard.Clock, source, text string) *clipboard.Item {
	t.Helper()
	it, err := clipboard.NewItem(clk, source, clipboard.MimeText,
		[]clipboard.Rep{{Mime: clipboard.MimeText, Data: []byte(text)}})
	if err != nil {
		t.Fatal(err)
	}
	return it
}

// 敏感内容与阅后即焚内容从不进时间线——这是时间线存在的前提。
func TestClipHistorySkipsSensitiveAndBurn(t *testing.T) {
	n := &Node{}
	clk := clipboard.NewClock("a")
	s := histItem(t, clk, "a", "hunter2")
	s.Sensitive = true
	b := histItem(t, clk, "a", "burn me")
	b.BurnAfter = true
	n.recordClipHistory(s, ClipViaLocal, "")
	n.recordClipHistory(b, ClipViaSync, "")
	if got := n.ClipHistory(); len(got) != 0 {
		t.Fatalf("敏感/阅后即焚内容进了时间线: %+v", got)
	}
}

// 条数与正文总量都有上限，超出从最旧的丢；同一内容再复制只留一条且移到最前。
func TestClipHistoryBoundsAndDedup(t *testing.T) {
	n := &Node{}
	clk := clipboard.NewClock("a")
	var first *clipboard.Item
	for i := 0; i < clipHistoryMax+10; i++ {
		it := histItem(t, clk, "a", fmt.Sprintf("item %d", i))
		if i == clipHistoryMax+5 {
			first = it
		}
		n.recordClipHistory(it, ClipViaLocal, "")
	}
	if got := len(n.ClipHistory()); got != clipHistoryMax {
		t.Fatalf("条数上限没生效: %d", got)
	}
	again := histItem(t, clk, "a", fmt.Sprintf("item %d", clipHistoryMax+5))
	if !bytes.Equal(again.ID, first.ID) {
		t.Fatal("同内容的 ID 应一致")
	}
	n.recordClipHistory(again, ClipViaLocal, "")
	h := n.ClipHistory()
	if len(h) != clipHistoryMax || !bytes.Equal(h[0].ItemID, again.ID) {
		t.Fatal("再次复制同一内容应只留一条并排在最前")
	}
	for _, e := range h[1:] {
		if bytes.Equal(e.ItemID, again.ID) {
			t.Fatal("同一内容出现了两次")
		}
	}

	big := strings.Repeat("x", clipHistoryRepMax/2+1)
	for i := 0; i < 5; i++ {
		n.recordClipHistory(histItem(t, clk, "a", fmt.Sprintf("%d%s", i, big)), ClipViaLocal, "")
	}
	n.clipHist.mu.Lock()
	total := n.clipHist.bytes
	n.clipHist.mu.Unlock()
	if total > clipHistoryBytes {
		t.Fatalf("正文总量超出预算: %d", total)
	}
}

// 摘要条目不能替换本机已有、正文齐全的同一条。
func TestClipHistoryPullNeverDowngrades(t *testing.T) {
	n := &Node{}
	clk := clipboard.NewClock("b")
	it := histItem(t, clk, "b", "full text")
	n.recordClipHistory(it, ClipViaSync, "")
	stub := *it
	stub.Reps = []clipboard.Rep{{Mime: it.Reps[0].Mime, Size: it.Reps[0].Size, Hash: it.Reps[0].Hash}}
	if n.clipHist.put(&stub, ClipViaPull, "full text") {
		t.Fatal("摘要把完整条目换掉了")
	}
	if h := n.ClipHistory(); len(h) != 1 || !h[0].Complete || h[0].Via != ClipViaSync {
		t.Fatalf("时间线被改动: %+v", h)
	}
}

func TestClampPreviewFoldsWhitespace(t *testing.T) {
	got := clampPreview("  a\r\n\tb c\x00d  ")
	if got != "a b c d" && got != "a b cd" {
		t.Fatalf("预览空白折叠不对: %q", got)
	}
	long := clampPreview(strings.Repeat("字", 500))
	if n := len([]rune(long)); n != clipHistoryPreview+1 || !strings.HasSuffix(long, "…") {
		t.Fatalf("预览截断不对: %d", n)
	}
}
