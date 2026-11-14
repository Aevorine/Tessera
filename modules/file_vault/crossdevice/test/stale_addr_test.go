package test

// 对端在别的网络里用过的过期地址（手机热点网段、蜂窝 IPv6）。实况（2026-11-14 日志）：
// 电脑开着 sing-box TUN，发往网外地址的 TCP 被 TUN 本地秒接，Noise 握手干等 13 秒，
// 界面每 5 分钟闪一次「验证中→离线」；这一次失败还把这台手机的 TCP 整体拉黑 5 分钟，
// 手机回来后只能走慢的 QUIC。

import (
	"context"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
)

// 10.255.255.7 不在任何本机网段：有 TUN 的机器上 TCP 被假接通，没有的机器上超时——两种都要扛住。
const offLinkAddr = "10.255.255.7:39421"

func TestS1_StaleOffLinkAddressDoesNotPoisonTCP(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := mobileNode(t, "手机")
	pair(t, pc, ph)
	peerID := ph.Identity().DeviceID()

	p, err := pc.Store().GetPeer(peerID)
	if err != nil {
		t.Fatal(err)
	}
	realAddr := p.LastGoodAddr
	if realAddr == "" {
		t.Fatal("配对后没有记下对端地址")
	}

	// 第一轮：手机「不在」——只剩一条网外过期地址。
	p.LastGoodAddr = offLinkAddr
	p.CachedAddrs = []string{offLinkAddr}
	if err := pc.Store().PutPeer(p); err != nil {
		t.Fatal(err)
	}
	pc.resetStateLog()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	start := time.Now()
	_, err = pc.Connect(ctx, peerID)
	cancel()
	if err == nil {
		t.Fatal("只有网外假地址也连上了，测试前提不成立")
	}
	pc.stateMu.Lock()
	seq := append([]node.State(nil), pc.stateLog...)
	pc.stateMu.Unlock()
	for _, st := range seq {
		if st == node.StateAuthenticating {
			t.Fatalf("S1 失败：网外过期地址进入了「验证中」（TCP 被假接通），序列 %v", seq)
		}
	}
	t.Logf("S1 过期地址这一轮 %v 失败，状态序列 %v", time.Since(start).Round(time.Millisecond), seq)

	// 第二轮：手机回到局域网。必须马上走 TCP 快路，不能被上一轮拉黑成 QUIC。
	p, _ = pc.Store().GetPeer(peerID)
	p.LastGoodAddr = realAddr
	p.CachedAddrs = []string{offLinkAddr, realAddr}
	if err := pc.Store().PutPeer(p); err != nil {
		t.Fatal(err)
	}
	sess := connect(t, pc, ph)
	if got := sess.Carrier(); got != "tcp" {
		t.Fatalf("S1 失败：手机回到局域网后走的是 %s，应为 tcp（被过期地址连累拉黑了）", got)
	}
	t.Logf("S1 手机回来后承载 = %s", sess.Carrier())
}

// TestS2：手机连上过、随后在同一网段里没了回应（后台被系统停掉）——设备卡片要说「手机上的
// Tessera 被暂停了，去手机上打开一次」，而不是「多半不在同一个网络」。
func TestS2_SilentPhoneOnLANIsExplained(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := mobileNode(t, "手机")
	pair(t, pc, ph)
	connect(t, pc, ph)
	peerID := ph.Identity().DeviceID()
	waitState(t, pc, peerID, node.StateConnected, 5*time.Second)

	_ = ph.Close() // 手机上的 Tessera 被系统停掉
	pc.KeepConnected(peerID)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if r, ok := pc.LastOfflineReason(peerID); ok {
			if r.Code != node.OfflineMobileAsleep {
				t.Fatalf("S2 失败：原因码 %q，应为 %q（%s）", r.Code, node.OfflineMobileAsleep, r.Msg)
			}
			t.Logf("S2 原因码 = %s", r.Code)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("S2 失败：20 秒内没有记下连不上的原因")
}

// TestS3：电脑之间对端没开软件，仍报原来的原因码，不误报成「手机被暂停」。
func TestS3_DesktopPeerKeepsPlainReason(t *testing.T) {
	a := newTestNode(t, "电脑甲", identity.TypePC)
	b := newTestNode(t, "电脑乙", identity.TypePC)
	pair(t, a, b)
	connect(t, a, b)
	peerID := b.Identity().DeviceID()
	waitState(t, a, peerID, node.StateConnected, 5*time.Second)

	_ = b.Close()
	a.KeepConnected(peerID)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if r, ok := a.LastOfflineReason(peerID); ok {
			if r.Code == node.OfflineMobileAsleep {
				t.Fatalf("S3 失败：电脑对端被误报成 %q", r.Code)
			}
			t.Logf("S3 原因码 = %s", r.Code)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("S3 失败：20 秒内没有记下连不上的原因")
}
