package test

// 跨设备剪贴板时间线与延迟曲线回归。

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
)

func findHistory(tn *testNode, id []byte) (node.ClipHistoryEntry, bool) {
	for _, e := range tn.ClipHistory() {
		if bytes.Equal(e.ItemID, id) {
			return e, true
		}
	}
	return node.ClipHistoryEntry{}, false
}

func waitHistory(t *testing.T, tn *testNode, id []byte, what string) node.ClipHistoryEntry {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if e, ok := findHistory(tn, id); ok {
			return e
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s 的时间线里始终没有 %s", tn.name, what)
	return node.ClipHistoryEntry{}
}

// TestT1_TimelineRecordsLocalAndSynced：本机复制与对端同步来的内容都进时间线，
// 来源、来路、预览都对。
func TestT1_TimelineRecordsLocalAndSynced(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	text := "Hello\n\n  world — “quoted” ∑ x² " + longSymbolText(3000)
	it, errs := pc.CopyText(text)
	if len(errs) > 0 || it == nil {
		t.Fatalf("复制失败: %v", errs)
	}
	ph.waitClip(1, 10*time.Second)

	own, ok := findHistory(pc, it.ID)
	if !ok || own.Via != node.ClipViaLocal || own.Source != pc.Identity().DeviceID() {
		t.Fatalf("T1 失败：电脑时间线里的本机复制不对: %+v", own)
	}
	got := waitHistory(t, ph, it.ID, "同步来的内容")
	if got.Via != node.ClipViaSync || got.Source != pc.Identity().DeviceID() || !got.Complete {
		t.Fatalf("T1 失败：手机时间线条目不对: %+v", got)
	}
	if !strings.HasPrefix(got.Preview, "Hello world — “quoted” ∑ x²") {
		t.Fatalf("T1 失败：预览没有折叠空白: %q", got.Preview)
	}
	if n := len([]rune(got.Preview)); n > 201 {
		t.Fatalf("T1 失败：预览太长（%d 字）", n)
	}
}

// TestT2_CopiesWhileDisconnectedArePulled：断线期间对端的多条复制重连后都在时间线上；
// 无内联正文的长文本可按需拉取；来源不在线时明确报「来源不在线」而非超时或空内容。
func TestT2_CopiesWhileDisconnectedArePulled(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)
	sess.Close("模拟息屏断网")
	waitNoSession(t, pc, ph.Identity().DeviceID())
	waitNoSession(t, ph, pc.Identity().DeviceID())

	bigA := "A:" + longSymbolText(100<<10)
	bigC := "C:" + longSymbolText(100<<10)
	var ids [][]byte
	for _, s := range []string{bigA, bigC, "latest B"} {
		it, _ := pc.CopyText(s)
		if it == nil {
			t.Fatal("复制失败")
		}
		ids = append(ids, it.ID)
		time.Sleep(2 * time.Millisecond)
	}
	connect(t, pc, ph)

	a := waitHistory(t, ph, ids[0], "断线期间复制的 A")
	c := waitHistory(t, ph, ids[1], "断线期间复制的 C")
	waitHistory(t, ph, ids[2], "最新的 B")
	if a.Via != node.ClipViaPull || a.Complete || a.Usable {
		t.Fatalf("T2 失败：长文本 A 应是只有摘要的拉取条目: %+v", a)
	}
	if !strings.HasPrefix(a.Preview, "A:The quick") || !strings.HasPrefix(c.Preview, "C:The quick") {
		t.Fatalf("T2 失败：拉取条目缺少预览: %q / %q", a.Preview, c.Preview)
	}
	hist := ph.ClipHistory()
	for i := 1; i < len(hist); i++ {
		if hist[i].At.After(hist[i-1].At) {
			t.Fatal("T2 失败：时间线不是新的在前")
		}
	}

	got, errs, err := ph.ApplyClipHistory(ids[0], false)
	if err != nil || len(errs) > 0 {
		t.Fatalf("T2 失败：再次粘贴 A 出错: %v %v", err, errs)
	}
	if got.Text() != bigA {
		t.Fatalf("T2 失败：拉回来的 A 不一致（%d vs %d 字节）", len(got.Text()), len(bigA))
	}
	if e, _ := findHistory(ph, ids[0]); !e.Complete {
		t.Fatal("T2 失败：拉取到的正文没有补进时间线")
	}

	pc.Close()
	waitNoSession(t, ph, pc.Identity().DeviceID())
	if _, _, err := ph.ApplyClipHistory(ids[1], false); !errors.Is(err, node.ErrClipSourceOffline) {
		t.Fatalf("T2 失败：来源离线时应报 ErrClipSourceOffline，实际 %v", err)
	}
	// 已经拉过的 A 离线也能粘贴。
	if got, _, err := ph.ApplyClipHistory(ids[0], false); err != nil || got.Text() != bigA {
		t.Fatalf("T2 失败：已拉取的 A 离线粘贴失败: %v", err)
	}
}

// TestT3_ApplyLocalDoesNotRebroadcast：只粘到本机时，平台层写入后监听器捕获到
// 同一内容要判为回声；选择「发给所有设备」时对端必须收到。
func TestT3_ApplyLocalDoesNotRebroadcast(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	it, _ := ph.CopyText("from phone " + longSymbolText(2000))
	pc.waitClip(1, 10*time.Second)
	if _, errs := ph.CopyText("something newer"); len(errs) > 0 {
		t.Fatal(errs)
	}
	pc.waitClip(2, 10*time.Second)

	got, _, err := pc.ApplyClipHistory(it.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	reps := make([]clipboard.Rep, len(got.Reps))
	for i, r := range got.Reps {
		reps[i] = clipboard.Rep{Mime: r.Mime, Data: r.Data}
	}
	if echo, err := pc.LocalCopy(got.Preferred, reps); err != nil || echo != nil {
		t.Fatalf("T3 失败：本机再次粘贴后被当成新复制广播了 (%v)", err)
	}

	if _, errs, err := pc.ApplyClipHistory(it.ID, true); err != nil || len(errs) > 0 {
		t.Fatalf("T3 失败：发给所有设备出错 %v %v", err, errs)
	}
	items := ph.waitClip(1, 10*time.Second)
	if !strings.HasPrefix(items[0].Text(), "from phone ") {
		t.Fatal("T3 失败：手机没收到重新发出的内容")
	}
}

// TestT4_LatencyHistoryKeepsEverySample：每次确认都进延迟曲线，按时间先后排列。
func TestT4_LatencyHistoryKeepsEverySample(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	peer := ph.Identity().DeviceID()
	for i := 0; i < 4; i++ {
		if _, errs := pc.CopyText(longSymbolText(1000 + i*500)); len(errs) > 0 {
			t.Fatal(errs)
		}
		ph.waitClip(i+1, 10*time.Second)
		deadline := time.Now().Add(5 * time.Second)
		for len(pc.ClipLatencyHistory(peer)) < i+1 && time.Now().Before(deadline) {
			time.Sleep(2 * time.Millisecond)
		}
	}
	hist := pc.ClipLatencyHistory(peer)
	if len(hist) != 4 {
		t.Fatalf("T4 失败：应有 4 个样本，实际 %d", len(hist))
	}
	for i, h := range hist {
		// 本机回环上一次来回可能不到 1 ms；Windows 的单调时钟按系统时钟中断计时，
		// 这时读数就是 0。负数或离谱的大数才是错。
		if h.Latency < 0 || h.Latency > 5*time.Second {
			t.Fatalf("T4 失败：第 %d 个样本不合理 %v", i, h.Latency)
		}
		if i > 0 && h.At.Before(hist[i-1].At) {
			t.Fatal("T4 失败：样本不是旧的在前")
		}
	}
}
