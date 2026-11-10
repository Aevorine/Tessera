package test

// 手机对端的判活与后台重试的状态播报。对应日志里的实况：手机息屏后整秒不应答，
// 电脑 1.4 秒就拆链，一天上百次；对端不在时每轮重试都翻一次「连接中 → 离线」。

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
)

func mobileNode(t *testing.T, name string) *testNode {
	return newTestNodeWith(t, name, identity.TypePhone, func(c *node.Config) { c.Mobile = true })
}

func linkDowns(tn *testNode) int {
	c := 0
	for _, e := range tn.events() {
		if e.Kind == "link_down" {
			c++
		}
	}
	return c
}

// TestL1：手机卡住 3 秒（跨过一次心跳），连接不拆，期间发的剪贴板在它醒来后送达。
func TestL1_MobileStallKeepsLinkAndDeliversClip(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := mobileNode(t, "手机")
	pair(t, pc, ph)
	sess := connect(t, pc, ph)
	peerID := ph.Identity().DeviceID()
	waitState(t, pc, peerID, node.StateConnected, 5*time.Second)

	// 手机会话的心跳每 5 秒一次：冻结窗口 4.6 s–7.6 s 盖住第一次心跳及旧判据的 1.4 s 判死点。
	time.Sleep(4600 * time.Millisecond)
	pc.resetEvents()
	ph.Freeze(3 * time.Second)
	time.Sleep(1500 * time.Millisecond)

	it, err := pc.LocalCopy("text/plain", []clipboard.Rep{{Mime: "text/plain", Data: []byte("息屏期间复制的内容")}})
	if err != nil || it == nil {
		t.Fatalf("本机复制失败: %v", err)
	}
	sent := time.Now()
	if n, errs := pc.BroadcastClipCount(it); n != 1 || len(errs) > 0 {
		t.Fatalf("发送失败: sent=%d errs=%v", n, errs)
	}
	got := ph.waitClip(1, 8*time.Second)
	t.Logf("L1 息屏期间的剪贴板在 %v 后送达", time.Since(sent).Round(time.Millisecond))
	if string(got[0].Reps[0].Data) != "息屏期间复制的内容" {
		t.Fatalf("内容不对: %q", got[0].Reps[0].Data)
	}

	time.Sleep(2500 * time.Millisecond)
	if n := linkDowns(pc); n != 0 {
		t.Fatalf("L1 失败：手机只是卡了 3 秒，电脑却拆了 %d 次链", n)
	}
	cur, ok := pc.SessionFor(peerID)
	if !ok || cur != sess || !cur.Alive() {
		t.Fatal("L1 失败：原会话没有保住")
	}
	waitState(t, pc, peerID, node.StateConnected, 3*time.Second)
}

// TestL2：手机真的没了（一直不应答），在耐心窗口内判死，不会永远挂着。
func TestL2_MobileGoneIsStillDetected(t *testing.T) {
	if testing.Short() {
		t.Skip("要等满判死窗口")
	}
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := mobileNode(t, "手机")
	pair(t, pc, ph)
	connect(t, pc, ph)
	peerID := ph.Identity().DeviceID()
	waitState(t, pc, peerID, node.StateConnected, 5*time.Second)

	pc.resetEvents()
	ph.Freeze(time.Minute)
	start := time.Now()
	deadline := start.Add(40 * time.Second)
	for time.Now().Before(deadline) && linkDowns(pc) == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	took := time.Since(start)
	if linkDowns(pc) == 0 {
		t.Fatal("L2 失败：对端 40 秒不应答仍未判死")
	}
	if took < 15*time.Second || took > 30*time.Second {
		t.Fatalf("L2 失败：判死用了 %v，应在 20 秒耐心窗口附近", took)
	}
	t.Logf("L2 对端失联后 %v 判死", took.Round(100*time.Millisecond))
}

// TestL3：电脑之间仍是秒级判死，耐心只给手机。
func TestL3_DesktopPeersStillDetectFast(t *testing.T) {
	a := newTestNode(t, "电脑甲", identity.TypePC)
	b := newTestNode(t, "电脑乙", identity.TypePC)
	pair(t, a, b)
	connect(t, a, b)
	peerID := b.Identity().DeviceID()
	waitState(t, a, peerID, node.StateConnected, 5*time.Second)

	a.resetEvents()
	b.Freeze(time.Minute)
	start := time.Now()
	for time.Since(start) < 8*time.Second && linkDowns(a) == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if linkDowns(a) == 0 || time.Since(start) > 5*time.Second {
		t.Fatalf("L3 失败：电脑之间判死用了 %v（应 ≤ 约 3.4 秒）", time.Since(start))
	}
	t.Logf("L3 电脑之间 %v 判死", time.Since(start).Round(10*time.Millisecond))
}

// TestL4：对端不在时，后台重试只在头几次播报「连接中」，之后安静地试。
func TestL4_AbsentPeerRetriesQuietly(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := mobileNode(t, "手机")
	pair(t, pc, ph)
	peerID := ph.Identity().DeviceID()
	_ = ph.Close()

	pc.resetStateLog()
	pc.KeepConnected(peerID)
	time.Sleep(9 * time.Second) // 退避 0.2/0.4/0.8/1.5/3 s：这段时间里至少重试 6 轮

	pc.stateMu.Lock()
	seq := append([]node.State(nil), pc.stateLog...)
	pc.stateMu.Unlock()
	connecting := 0
	for _, st := range seq {
		if st == node.StateConnecting {
			connecting++
		}
	}
	if connecting == 0 || connecting > 3 {
		t.Fatalf("L4 失败：播报了 %d 次「连接中」（应为 1–3 次），序列 %v", connecting, seq)
	}
	t.Logf("L4 9 秒内只播报 %d 次「连接中」，状态序列 %v", connecting, seq)
}

// TestL5：已连接时一条文本从「本机复制」到「对端交付」的耗时（回环，含加密、成帧、去重登记）。
func TestL5_ClipDeliveryLatency(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := mobileNode(t, "手机")
	pair(t, pc, ph)
	connect(t, pc, ph)
	waitState(t, pc, ph.Identity().DeviceID(), node.StateConnected, 5*time.Second)

	const rounds = 200
	lat := make([]time.Duration, 0, rounds)
	for i := range rounds {
		data := []byte(fmt.Sprintf("延迟样本 %d", i))
		start := time.Now()
		it, err := pc.LocalCopy("text/plain", []clipboard.Rep{{Mime: "text/plain", Data: data}})
		if err != nil || it == nil {
			t.Fatalf("第 %d 次复制失败: %v", i, err)
		}
		if n, errs := pc.BroadcastClipCount(it); n != 1 || len(errs) > 0 {
			t.Fatalf("第 %d 次发送失败: %v", i, errs)
		}
		ph.waitClip(i+1, 5*time.Second)
		lat = append(lat, time.Since(start))
	}
	slices.Sort(lat)
	p50, p99 := lat[rounds/2], lat[rounds*99/100]
	t.Logf("L5 剪贴板端到端延迟：p50 %v · p99 %v · 最大 %v（%d 次）", p50, p99, lat[rounds-1], rounds)
	if p50 > 5*time.Millisecond {
		t.Fatalf("L5 失败：p50 %v 超过 5 ms", p50)
	}
}
