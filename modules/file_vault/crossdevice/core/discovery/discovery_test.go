package discovery

import (
	"encoding/base64"
	"io"
	"log"
	"net"
	"os"
	"testing"
	"time"

	"github.com/grandcat/zeroconf"
)

func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// ---------- TXT 解析 ----------

func TestParseEntry(t *testing.T) {
	fp := []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	e := &zeroconf.ServiceEntry{
		HostName: "CB7K3M8F.local.",
		Port:     39421,
		Text: []string{
			"v=1",
			"id=CB7K3M8FQ2X",
			"fp=" + base64.RawStdEncoding.EncodeToString(fp),
			"n=小明的手机",
			"t=phone",
			"c=clip,file,folder",
			"p=39421",
		},
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.7")},
	}

	p, ok := parseEntry(e)
	if !ok {
		t.Fatal("应当解析成功")
	}
	if p.DeviceID != "CB7K3M8FQ2X" {
		t.Errorf("device_id = %q", p.DeviceID)
	}
	if p.Name != "小明的手机" {
		t.Errorf("设备名被破坏: %q（TXT 必须按 UTF-8 原样透传）", p.Name)
	}
	if p.Type != "phone" {
		t.Errorf("type = %q", p.Type)
	}
	if len(p.Caps) != 3 {
		t.Errorf("caps = %v", p.Caps)
	}
	if string(p.Fingerprint) != string(fp) {
		t.Errorf("指纹解码不一致")
	}
	if len(p.Addrs) != 1 || p.Addrs[0] != "192.168.1.7:39421" {
		t.Errorf("addrs = %v", p.Addrs)
	}
}

func TestParseEntryRejectsIncomplete(t *testing.T) {
	cases := []struct {
		name  string
		entry *zeroconf.ServiceEntry
	}{
		{"没有 device_id", &zeroconf.ServiceEntry{
			Port:     1234,
			Text:     []string{"v=1", "n=x"},
			AddrIPv4: []net.IP{net.ParseIP("10.0.0.2")},
		}},
		{"没有任何可用地址", &zeroconf.ServiceEntry{
			Port: 1234,
			Text: []string{"id=ABC"},
		}},
		{"端口为 0", &zeroconf.ServiceEntry{
			Port:     0,
			Text:     []string{"id=ABC", "p=0"},
			AddrIPv4: []net.IP{net.ParseIP("10.0.0.2")},
		}},
		{"只有回环地址", &zeroconf.ServiceEntry{
			Port:     1234,
			Text:     []string{"id=ABC"},
			AddrIPv4: []net.IP{net.ParseIP("127.0.0.1")},
		}},
		{"只有链路本地 IPv6（没 zone 连不上）", &zeroconf.ServiceEntry{
			Port:     1234,
			Text:     []string{"id=ABC"},
			AddrIPv6: []net.IP{net.ParseIP("fe80::1")},
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, ok := parseEntry(c.entry); ok {
				t.Error("这种应答不该被接受")
			}
		})
	}
}

// TXT 里的 p= 必须压过 SRV 端口——SRV 在某些代理场景会被改写。
func TestTXTPortOverridesSRV(t *testing.T) {
	e := &zeroconf.ServiceEntry{
		Port:     1111,
		Text:     []string{"id=ABC", "p=2222"},
		AddrIPv4: []net.IP{net.ParseIP("10.0.0.5")},
	}
	p, ok := parseEntry(e)
	if !ok {
		t.Fatal("应当解析成功")
	}
	if p.Addrs[0] != "10.0.0.5:2222" {
		t.Errorf("addrs = %v，TXT 的 p= 应当优先于 SRV 端口", p.Addrs)
	}
}

// ---------- 地址合并 ----------

// 同一台设备的 A 记录和 AAAA 记录会分成多条应答到达，
// 后到的那条不能把先到的地址冲掉。
func TestAbsorbMergesAddrsAcrossAnswers(t *testing.T) {
	s := New(Config{DeviceID: "SELF", Logger: quietLogger()})

	s.absorb(&zeroconf.ServiceEntry{
		Port:     9000,
		Text:     []string{"id=PEER", "n=平板"},
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.20")},
	})
	s.absorb(&zeroconf.ServiceEntry{
		Port:     9000,
		Text:     []string{"id=PEER", "n=平板"},
		AddrIPv6: []net.IP{net.ParseIP("2001:db8::5")},
	})

	got := s.AddrsFor("PEER")
	if len(got) != 2 {
		t.Fatalf("两条应答的地址应当合并，实际 = %v", got)
	}
	has := func(a string) bool {
		for _, g := range got {
			if g == a {
				return true
			}
		}
		return false
	}
	if !has("192.168.1.20:9000") || !has("[2001:db8::5]:9000") {
		t.Errorf("地址合并结果不对: %v", got)
	}
}

// 自己的广播自己也会收到，必须丢掉——否则设备列表里会冒出"自己"，
// 重连逻辑还会试着跟自己握手。
func TestAbsorbIgnoresSelf(t *testing.T) {
	s := New(Config{DeviceID: "SELF", Logger: quietLogger()})
	s.absorb(&zeroconf.ServiceEntry{
		Port:     9000,
		Text:     []string{"id=SELF"},
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.9")},
	})
	if len(s.Peers()) != 0 {
		t.Error("不该把自己收进设备列表")
	}
}

func TestOnPeerCallbackFires(t *testing.T) {
	got := make(chan Peer, 1)
	s := New(Config{
		DeviceID: "SELF",
		Logger:   quietLogger(),
		OnPeer:   func(p Peer) { got <- p },
	})
	s.absorb(&zeroconf.ServiceEntry{
		Port:     9000,
		Text:     []string{"id=PEER", "n=手机"},
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.20")},
	})
	select {
	case p := <-got:
		if p.DeviceID != "PEER" {
			t.Errorf("回调拿到的是 %q", p.DeviceID)
		}
	case <-time.After(time.Second):
		t.Fatal("OnPeer 没有被调用——重连循环就收不到'对端出现了'的信号")
	}
}

// ---------- 换地址：这是加发现层的全部意义 ----------

// 对端换了 Wi-Fi / 路由器重发 DHCP 之后，旧地址彻底作废。
// 发现层必须给出新地址，否则两台早就配对过的设备永远连不上。
func TestAddrsFollowPeerToNewAddress(t *testing.T) {
	s := New(Config{DeviceID: "SELF", Logger: quietLogger()})

	s.absorb(&zeroconf.ServiceEntry{
		Port:     9000,
		Text:     []string{"id=PEER"},
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.20")},
	})
	if got := s.AddrsFor("PEER"); len(got) != 1 || got[0] != "192.168.1.20:9000" {
		t.Fatalf("初始地址不对: %v", got)
	}

	// 换网了：Refresh 清空缓存（旧地址已经全废，留着只会白等一轮超时）。
	s.Refresh()
	if got := s.AddrsFor("PEER"); len(got) != 0 {
		t.Fatalf("换网后必须先清掉旧地址，实际还剩 %v", got)
	}

	// 新网段上重新发现同一台设备。
	s.absorb(&zeroconf.ServiceEntry{
		Port:     9100,
		Text:     []string{"id=PEER"},
		AddrIPv4: []net.IP{net.ParseIP("10.20.0.33")},
	})
	got := s.AddrsFor("PEER")
	if len(got) != 1 || got[0] != "10.20.0.33:9100" {
		t.Fatalf("换网后应当只剩新地址，实际 = %v", got)
	}
}

func TestExpireDropsStalePeers(t *testing.T) {
	s := New(Config{DeviceID: "SELF", Logger: quietLogger()})
	s.absorb(&zeroconf.ServiceEntry{
		Port:     9000,
		Text:     []string{"id=PEER"},
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.20")},
	})

	// 把"最后看到"的时间推到 TTL 之前。
	s.mu.Lock()
	p := s.peers["PEER"]
	p.SeenAt = time.Now().Add(-2 * peerTTL)
	s.peers["PEER"] = p
	s.mu.Unlock()

	s.expire()
	if len(s.AddrsFor("PEER")) != 0 {
		t.Error("超时未再出现的设备应当被清掉")
	}
}

// Refresh 绝不能阻塞：调用方（Node.NetworkChanged）可能正拿着锁。
func TestRefreshNeverBlocks(t *testing.T) {
	s := New(Config{DeviceID: "SELF", Logger: quietLogger()})
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			s.Refresh()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Refresh 阻塞了")
	}
}

// ---------- 真实 mDNS 往返 ----------

// 这条会往真实局域网发组播，默认不跑：单元测试不该惊动用户网络里的其他设备，
// 且 CI / 容器 / 严格防火墙下组播被丢是常态会假失败。实测时设 TESSERA_MDNS_E2E=1。
func TestRealMDNSRoundTrip(t *testing.T) {
	if os.Getenv("TESSERA_MDNS_E2E") != "1" {
		t.Skip("跳过真实 mDNS 往返测试（设 TESSERA_MDNS_E2E=1 开启）")
	}

	adv := New(Config{
		DeviceID:    "E2ETESTDEVICE01",
		Name:        "测试发布方",
		Type:        "pc",
		Fingerprint: []byte{9, 9, 9, 9},
		Port:        45123,
		Logger:      quietLogger(),
	})
	if err := adv.Start(); err != nil {
		t.Fatalf("公布失败: %v", err)
	}
	defer adv.Close()

	found := make(chan Peer, 4)
	obs := New(Config{
		DeviceID: "E2EOBSERVER02",
		Name:     "测试观察方",
		Type:     "phone",
		Port:     45124,
		Logger:   quietLogger(),
		OnPeer: func(p Peer) {
			if p.DeviceID == "E2ETESTDEVICE01" {
				select {
				case found <- p:
				default:
				}
			}
		},
	})
	if err := obs.Start(); err != nil {
		t.Fatalf("浏览方启动失败: %v", err)
	}
	defer obs.Close()

	select {
	case p := <-found:
		t.Logf("✅ 真实 mDNS 发现成功：%s (%s) @ %v", p.Name, p.Type, p.Addrs)
		if len(p.Addrs) == 0 {
			t.Error("发现了设备但没有地址，无法用于重连")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("20 秒内没有通过真实 mDNS 发现对端")
	}
}

// ---------- 常驻监听：重连快慢的关键 ----------

// 浏览必须常驻，不能"隔一阵开个短窗口"：设备重新上线立刻发 mDNS 通告，短窗口会错过它，
// 自动重连从毫秒级劣化到几十秒。这里断言重启周期远大于任何合理轮询间隔，它只用来自愈静默失效。
func TestBrowseIsContinuousNotPolled(t *testing.T) {
	if restartInterval < time.Minute {
		t.Fatalf(
			"restartInterval = %v，太短了。这个常量是常驻浏览的自愈重启周期，"+
				"不是轮询间隔；调到分钟以下说明有人把常驻监听改回了轮询，"+
				"那会让对端重新上线的通告被漏掉，重连从毫秒级掉到几十秒。",
			restartInterval,
		)
	}
}

// Refresh 必须能立刻打断当前常驻浏览：换网后旧套接字绑在消失的接口上，不打断就一直用收不到任何东西
// 的连接，
// 表现为"换了 Wi-Fi 之后再也发现不了设备"。
func TestRefreshInterruptsTheStandingBrowse(t *testing.T) {
	s := New(Config{DeviceID: "SELF", Logger: quietLogger()})

	// wake 是容量 1 的合并信道：连按多次不该阻塞，也不该丢掉唤醒。
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			s.Refresh()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Refresh 阻塞了——它会被 Node.NetworkChanged 在持锁时调用")
	}

	// 至少有一次唤醒留在信道里，浏览循环下一次 select 就能收到。
	select {
	case <-s.wake:
	default:
		t.Fatal("Refresh 之后 wake 信道是空的，常驻浏览不会被打断")
	}
}
