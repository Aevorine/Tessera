package agent

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/node"
)

// 对方离线超过等待时限：文件进发件箱（不是失败）；发送端守护进程重启后队列还在；对方回来自动送达、内容一致。
func TestOutbox_OfflinePeerGetsFileWhenBack(t *testing.T) {
	old := node.SendWaitOnline
	node.SendWaitOnline = 1500 * time.Millisecond
	t.Cleanup(func() { node.SendWaitOnline = old })

	// 接收端用固定端口，重启后发送端缓存的地址仍然有效
	l, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	guestAddr := l.LocalAddr().String()
	_ = l.Close()

	hostDir, guestDir := t.TempDir(), t.TempDir()
	hostEv, guestEv := &eventLog{}, &eventLog{}
	host, err := New(Config{DataDir: hostDir, Name: "电脑", Addr: "127.0.0.1:0", Sink: hostEv.sink})
	if err != nil {
		t.Fatal(err)
	}
	guest, err := New(Config{DataDir: guestDir, Name: "手机", Addr: guestAddr, Sink: guestEv.sink})
	if err != nil {
		t.Fatal(err)
	}
	p := &e2ePair{host: host, guest: guest, hostEv: hostEv, guestEv: guestEv}
	pairAgents(t, p)
	guestID := guest.id.DeviceID()
	dest := filepath.Join(guest.downloadDir.Load().(string), "离线补发.bin")

	_ = guest.Close() // 对方离线
	waitUntil(t, 10*time.Second, "发送端察觉对方离线", func() bool {
		s, ok := host.n.SessionFor(guestID)
		return !ok || !s.Alive()
	})

	src := filepath.Join(t.TempDir(), "离线补发.bin")
	writeRandom(t, src, 3<<20+77)
	want := treeDigest(t, filepath.Dir(src))["离线补发.bin"]
	p.send(t, src)

	waitUntil(t, 15*time.Second, "出现 queued 事件", func() bool { return hasTransferKind(hostEv, "queued") })
	if errs := hostEv.transferErrors(); len(errs) > 0 {
		t.Fatalf("对方离线不该报失败: %v", errs)
	}
	if n := host.ob.countFor(guestID); n != 1 {
		t.Fatalf("发件箱应有 1 条，实际 %d", n)
	}

	// 发送端守护进程重启：队列从磁盘恢复
	_ = host.Close()
	hostEv2 := &eventLog{}
	host2, err := New(Config{DataDir: hostDir, Name: "电脑", Addr: "127.0.0.1:0", Sink: hostEv2.sink})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host2.Close() })
	if n := host2.ob.countFor(guestID); n != 1 {
		t.Fatalf("重启后发件箱应有 1 条，实际 %d", n)
	}

	// 对方回来
	guest2, err := New(Config{DataDir: guestDir, Name: "手机", Addr: guestAddr, Sink: guestEv.sink})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guest2.Close() })
	back := time.Now()

	waitUntil(t, 60*time.Second, "文件自动送达且内容一致", func() bool {
		if _, err := os.Stat(dest); err != nil {
			return false
		}
		return treeDigest(t, filepath.Dir(dest))["离线补发.bin"] == want
	})
	el := time.Since(back)
	waitUntil(t, 5*time.Second, "发件箱清空", func() bool { return host2.ob.countFor(guestID) == 0 })
	if errs := hostEv2.transferErrors(); len(errs) > 0 {
		t.Fatalf("补发报错: %v", errs)
	}
	t.Logf("✅ 离线→排队→发送端重启→对方上线 %v 内自动送达，逐字节一致；drain 事件=%v", el.Round(time.Millisecond), hasTransferKind(hostEv2, "outbox_drain"))
}

func pairAgents(t *testing.T, p *e2ePair) {
	t.Helper()
	p.guest.n.SetAdvertiseAddrs([]string{hostAddr(t, p.guest)})
	code, _, err := p.guest.n.ShowPairingCode("long", 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	for _, a := range []*Agent{p.host, p.guest} {
		go func(a *Agent) {
			for {
				select {
				case <-stop:
					return
				case <-time.After(30 * time.Millisecond):
				}
				a.pendMu.Lock()
				ids := make([]string, 0, len(a.pending))
				for id := range a.pending {
					ids = append(ids, id)
				}
				a.pendMu.Unlock()
				for _, id := range ids {
					a.Handle(`{"id":99,"method":"pair_respond","params":{"request_id":` + jsonStr(id) + `,"accept":true,"mode":"long"}}`)
				}
			}
		}(a)
	}
	defer close(stop)
	p.host.Handle(`{"id":2,"method":"pair_with_code","params":{"code":` + jsonStr(code) + `}}`)
	waitUntil(t, 20*time.Second, "配对后建立会话", func() bool {
		s, ok := p.host.n.SessionFor(p.guest.id.DeviceID())
		return ok && s.Alive()
	})
}

func waitUntil(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("超时：%s", what)
}

func hasTransferKind(l *eventLog, kind string) bool {
	for _, ln := range l.snapshot() {
		var ev struct {
			Event string         `json:"event"`
			Data  map[string]any `json:"data"`
		}
		if json.Unmarshal([]byte(ln), &ev) == nil && ev.Event == "transfer" {
			if k, _ := ev.Data["kind"].(string); k == kind {
				return true
			}
		}
	}
	return false
}
