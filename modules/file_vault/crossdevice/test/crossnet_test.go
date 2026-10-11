package test

// 跨网用例：证明互不知道地址的两台设备只靠汇合点就能连上并传完文件。
// 单机造不出 NAT，所以掐死全部局域网路径（不开 mDNS、清空缓存与历史地址），
// 重连竞速的路 1/2/3 无地址可拨，能连上只可能是路 4（汇合点）或路 5（中继）。
// 真正的 NAT 打洞、CGNAT 需人工实测（见方案书 V1/V2），这里不冒充该结论。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
	"github.com/Aevorine/Tessera/crossdevice/core/rendezvous"
)

// startRendezvous 起一台测试用的汇合点服务器。
func startRendezvous(t *testing.T, secret string, disableRelay bool) string {
	t.Helper()
	srv := rendezvous.NewServer(rendezvous.ServerConfig{
		Addr:         "127.0.0.1:0",
		Secret:       secret,
		DisableRelay: disableRelay,
		Logger:       log.New(os.Stderr, "[rv] ", 0),
	})
	if err := srv.Start(); err != nil {
		t.Fatalf("启动汇合点失败: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv.Addr().String()
}

// blindThem 清空两台设备的缓存与历史地址，掐断局域网路径；
// 配对会记下对方地址，不清则走不到跨网那几路。
func blindThem(t *testing.T, nodes ...*testNode) {
	t.Helper()
	for _, n := range nodes {
		for _, p := range n.Store().ListPeers() {
			p.LastGoodAddr = ""
			p.CachedAddrs = nil
			if err := n.Store().PutPeer(p); err != nil {
				t.Fatalf("清空 %s 的缓存地址失败: %v", n.name, err)
			}
		}
	}
}

// rvConfig 组装接了汇合点的节点配置。allowLoopback 决定回环地址是否可拨：
// true 验证能直连就直连，false 滤掉直连地址只剩中继。必须分开测，
// 否则中继兜底使用例永远绿，直连链路死活看不出来。
func rvConfig(rvAddr, secret, tag string, allowLoopback bool) func(*node.Config) {
	return func(c *node.Config) {
		c.RendezvousAddr = rvAddr
		c.RendezvousSecret = secret
		c.AllowLoopbackPeers = allowLoopback
		c.Logger = log.New(os.Stderr, "["+tag+"] ", 0)
	}
}

// blindAndConnect 掐掉所有局域网路径，然后等两台设备靠汇合点连上，返回胜出的会话。
func blindAndConnect(t *testing.T, pc, ph *testNode, timeout time.Duration) *node.Session {
	t.Helper()
	peerID := ph.Identity().DeviceID()

	// 断开配对时顺带建立的连接，并抹掉双方记住的一切地址。
	if s, ok := pc.SessionFor(peerID); ok {
		s.Close("用例要求从零开始")
	}
	blindThem(t, pc, ph)

	// 确认地址真的清干净了——不然后面测的其实还是局域网那条路。
	p, err := pc.Store().GetPeer(peerID)
	if err != nil {
		t.Fatalf("取对端记录失败: %v", err)
	}
	if p.LastGoodAddr != "" || len(p.CachedAddrs) != 0 {
		t.Fatalf("局域网路径没掐干净：LastGoodAddr=%q CachedAddrs=%v", p.LastGoodAddr, p.CachedAddrs)
	}

	pc.KeepConnected(peerID)
	ph.KeepConnected(pc.Identity().DeviceID())
	waitState(t, pc, peerID, node.StateConnected, timeout)

	sess, ok := pc.SessionFor(peerID)
	if !ok {
		t.Fatal("状态是 CONNECTED 但没有会话")
	}
	if !sess.Alive() {
		t.Fatal("会话已经是关闭状态")
	}
	return sess
}

// TestCrossnet_DirectWinsWhenReachable 验证第一条跨网路径：
// 汇合点交换地址之后**直连**，服务器不参与数据传输。
func TestCrossnet_DirectWinsWhenReachable(t *testing.T) {
	rvAddr := startRendezvous(t, "测试口令", false)
	pc := newTestNodeWith(t, "电脑", identity.TypePC, rvConfig(rvAddr, "测试口令", "电脑", true))
	ph := newTestNodeWith(t, "手机", identity.TypePhone, rvConfig(rvAddr, "测试口令", "手机", true))
	pair(t, pc, ph)

	sess := blindAndConnect(t, pc, ph, 40*time.Second)

	if sess.Via() == "中继转发" {
		t.Fatalf("对端地址明明可拨，却退到了中继——公网直连那一路没起作用")
	}
	t.Logf("跨网 ✅ 没有任何局域网地址，靠汇合点换址后直连成功，经由：%s", sess.Via())
}

// TestCrossnet_RelayTakesOverWhenDirectFails 验证第二条跨网路径：
// 直连地址一条都拨不通时（真实世界里的对称型 NAT / CGNAT），中继必须兜住。
func TestCrossnet_RelayTakesOverWhenDirectFails(t *testing.T) {
	rvAddr := startRendezvous(t, "测试口令", false)
	// allowLoopback=false：对端报来的地址全被判为不可拨，直连那一路无地址可用。
	pc := newTestNodeWith(t, "电脑", identity.TypePC, rvConfig(rvAddr, "测试口令", "电脑", false))
	ph := newTestNodeWith(t, "手机", identity.TypePhone, rvConfig(rvAddr, "测试口令", "手机", false))
	pair(t, pc, ph)

	sess := blindAndConnect(t, pc, ph, 40*time.Second)

	if sess.Via() != "中继转发" {
		t.Fatalf("直连地址应当全部不可用，却经由 %s 连上了——用例没有真的把直连掐死", sess.Via())
	}
	t.Log("跨网 ✅ 直连完全打不通时，中继成功兜底，且界面能如实显示「中继转发」")
}

// TestCrossnet_TransfersFileIntact：比对 SHA-256 证明跨网传完后文件完整，且直连与中继两条路各测一遍，
// 中继是裸字节管道，可靠性与 QUIC 直连不同，风险更高。
func TestCrossnet_TransfersFileIntact(t *testing.T) {
	for _, tc := range []struct {
		name          string
		allowLoopback bool
		wantVia       string
	}{
		{"公网直连", true, ""},
		{"中继转发", false, "中继转发"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			crossnetFileRoundTrip(t, tc.allowLoopback, tc.wantVia)
		})
	}
}

func crossnetFileRoundTrip(t *testing.T, allowLoopback bool, wantVia string) {
	t.Helper()
	rvAddr := startRendezvous(t, "", false)
	pc := newTestNodeWith(t, "电脑", identity.TypePC, rvConfig(rvAddr, "", "电脑", allowLoopback))
	ph := newTestNodeWith(t, "手机", identity.TypePhone, rvConfig(rvAddr, "", "手机", allowLoopback))
	pair(t, pc, ph)

	blindAndConnect(t, pc, ph, 40*time.Second)
	peerID := ph.Identity().DeviceID()

	// 造一个 4 MiB 的文件，内容有规律但不可压缩成常数，避免"传了个全零也看不出来"。
	src := filepath.Join(t.TempDir(), "样本.bin")
	data := make([]byte, 4<<20)
	for i := range data {
		data[i] = byte(i*31 + i/251)
	}
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatalf("写样本文件失败: %v", err)
	}
	want := sha256.Sum256(data)

	sess, ok := pc.SessionFor(peerID)
	if !ok {
		t.Fatal("状态是 CONNECTED 但没有会话")
	}
	if wantVia != "" && sess.Via() != wantVia {
		t.Fatalf("本用例要测的是 %s，实际却经由 %s——测的不是想测的那条路", wantVia, sess.Via())
	}
	t.Logf("本次传输经由：%s", sess.Via())

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := sess.SendFile(ctx, src); err != nil {
		t.Fatalf("跨网发送文件失败: %v", err)
	}

	got := waitForFile(t, filepath.Join(ph.dir, "downloads", "样本.bin"), int64(len(data)), 60*time.Second)
	if got != want {
		t.Fatalf("跨网传输后文件损坏\n期望 SHA-256: %s\n实际 SHA-256: %s",
			hex.EncodeToString(want[:]), hex.EncodeToString(got[:]))
	}
	t.Logf("跨网 ✅ 4 MiB 文件传输后 SHA-256 一致: %s", hex.EncodeToString(want[:])[:16]+"…")
}

// TestCrossnet_ServerDownDoesNotBreakLAN：汇合点只是加速手段，不能成为局域网单点故障。
// 汇合点地址不可达时局域网必须照常工作且不变慢。
func TestCrossnet_ServerDownDoesNotBreakLAN(t *testing.T) {
	// 127.0.0.1:1 上不会有任何东西在听。
	withDeadRV := func(c *node.Config) { c.RendezvousAddr = "127.0.0.1:1" }

	pc := newTestNodeWith(t, "电脑", identity.TypePC, withDeadRV)
	ph := newTestNodeWith(t, "手机", identity.TypePhone, withDeadRV)
	pair(t, pc, ph)
	peerID := ph.Identity().DeviceID()

	if s, ok := pc.SessionFor(peerID); ok {
		s.Close("用例要求重连一次")
	}

	start := time.Now()
	pc.KeepConnected(peerID)
	waitState(t, pc, peerID, node.StateConnected, 15*time.Second)
	elapsed := time.Since(start)

	// 局域网重连的目标是 3 秒内（见 A6）。汇合点连不上时那两路只是白等定时器，
	// 竞速里第一条成功的立即胜出，所以这个数字不该被拖慢。
	if elapsed > 3*time.Second {
		t.Fatalf("汇合点不可达时局域网重连被拖慢到 %v（应当 <3s）", elapsed)
	}
	sess, _ := pc.SessionFor(peerID)
	t.Logf("跨网 ✅ 汇合点完全不可达时，局域网重连仍然只用了 %v（经由 %s）",
		elapsed.Round(time.Millisecond), sess.Via())
}

// TestCrossnet_WrongSecretRejected 确认服务器口令真的挡得住人。
func TestCrossnet_WrongSecretRejected(t *testing.T) {
	rvAddr := startRendezvous(t, "正确口令", false)

	pc := newTestNodeWith(t, "电脑", identity.TypePC, rvConfig(rvAddr, "错误口令", "电脑", true))
	ph := newTestNodeWith(t, "手机", identity.TypePhone, rvConfig(rvAddr, "错误口令", "手机", true))
	pair(t, pc, ph)
	peerID := ph.Identity().DeviceID()

	if s, ok := pc.SessionFor(peerID); ok {
		s.Close("用例要求从零开始")
	}
	blindThem(t, pc, ph)

	pc.KeepConnected(peerID)
	ph.KeepConnected(pc.Identity().DeviceID())

	// 口令不对，服务器应当一直拒绝，所以永远连不上。
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if pc.State(peerID) == node.StateConnected {
			t.Fatal("口令错误却连上了——服务器口令没有起作用")
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Log("跨网 ✅ 口令不对时汇合点持续拒绝，设备连不上")
}

// waitForFile 等文件出现并达到期望大小，返回它的 SHA-256。
func waitForFile(t *testing.T, path string, wantSize int64, timeout time.Duration) [32]byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fi, err := os.Stat(path); err == nil && fi.Size() == wantSize {
			b, err := os.ReadFile(path)
			if err == nil && int64(len(b)) == wantSize {
				return sha256.Sum256(b)
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	var have string
	if fi, err := os.Stat(path); err == nil {
		have = fmt.Sprintf("当前 %d 字节", fi.Size())
	} else {
		have = "文件根本没出现"
	}
	t.Fatalf("等待 %s 达到 %d 字节超时（%s）", path, wantSize, have)
	return [32]byte{}
}
