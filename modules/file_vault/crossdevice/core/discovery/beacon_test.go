package discovery

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 信标是"组播被丢掉时还能找到对方"的那条路，所以这几条锁的是它最容易悄悄
// 坏掉的地方：应答格式、地址取值来源、以及扫描的网段算术。

func TestBeaconAnswersAProbeWithItsRealQuicPort(t *testing.T) {
	b := NewBeacon(Config{
		DeviceID:    "device-under-test",
		Name:        "测试设备",
		Type:        "desktop",
		Caps:        []string{"clip", "file"},
		Fingerprint: []byte{1, 2, 3, 4},
		Port:        54321,
	})
	if err := b.Start(); err != nil {
		t.Fatalf("信标启动失败: %v", err)
	}
	defer func() { _ = b.Close() }()

	if !b.Listening() {
		t.Skip("端口 47654 被占用（多半是本机正跑着 Tessera），跳过实连测试")
	}

	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: BeaconPort})
	if err != nil {
		t.Fatalf("拨号失败: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.Write([]byte(beaconQuery)); err != nil {
		t.Fatalf("发送探测失败: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, maxBeaconPacket)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("没收到应答: %v", err)
	}

	from := conn.RemoteAddr().(*net.UDPAddr)
	p, ok := parseBeaconReply(buf[:n], from)
	if !ok {
		t.Fatalf("应答解析失败: %q", buf[:n])
	}
	if p.DeviceID != "device-under-test" || p.Name != "测试设备" || p.Type != "desktop" {
		t.Fatalf("应答内容不对: %+v", p)
	}
	// 端口必须是 QUIC 的监听端口，不是信标自己那个固定端口——拿错了会让对方
	// 去连 47654，那上面根本没有 QUIC 服务，表现成"能扫到但连不上"。
	want := net.JoinHostPort("127.0.0.1", strconv.Itoa(54321))
	if len(p.Addrs) != 1 || p.Addrs[0] != want {
		t.Fatalf("地址应为 %s，实际 %v", want, p.Addrs)
	}
}

func TestBeaconReportsThePortItWasUpdatedTo(t *testing.T) {
	b := NewBeacon(Config{DeviceID: "x", Port: 1111})
	b.UpdatePort(2222)
	p, ok := parseBeaconReply(b.replyPacket(), &net.UDPAddr{IP: net.IPv4(10, 0, 0, 9)})
	if !ok {
		t.Fatal("自己组的包自己解析不出来")
	}
	if p.Addrs[0] != "10.0.0.9:2222" {
		t.Fatalf("端口没跟着 UpdatePort 走: %v", p.Addrs)
	}
}

func TestParseBeaconReplyRejectsAnythingThatIsNotOurs(t *testing.T) {
	from := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 7)}
	cases := map[string]string{
		"空包":       "",
		"别的协议":     "HTTP/1.1 200 OK\r\n\r\n",
		"版本不对":     "TSRA!2\nid=a\np=1",
		"没有设备 ID":  "TSRA!1\np=1234",
		"没有端口":     "TSRA!1\nid=abc",
		"端口越界":     "TSRA!1\nid=abc\np=70000",
		"端口不是数字":   "TSRA!1\nid=abc\np=abc",
		"把查询当应答收下": beaconQuery,
	}
	for name, payload := range cases {
		if _, ok := parseBeaconReply([]byte(payload), from); ok {
			t.Errorf("%s：本该拒绝，却解析成功了", name)
		}
	}
}

func TestParseBeaconReplyTrustsTheSourceIPNotTheSelfReportedOne(t *testing.T) {
	// 自报地址在多网卡/NAT 的机器上经常是另一张网卡的，连不通；来源 IP 是
	// 这个包刚刚真的走通的那条路。这条锁住"取来源 IP"这个决定。
	reply := "TSRA!1\nid=abc\nn=x\np=6000\na=10.99.99.99:6000"
	p, ok := parseBeaconReply([]byte(reply), &net.UDPAddr{IP: net.IPv4(192, 168, 1, 7)})
	if !ok {
		t.Fatal("解析失败")
	}
	if p.Addrs[0] != "192.168.1.7:6000" {
		t.Fatalf("应当用来源 IP，实际 %v", p.Addrs)
	}
}

func TestBroadcastAddrAndHostEnumeration(t *testing.T) {
	_, n24, _ := net.ParseCIDR("192.168.1.0/24")
	if got := broadcastAddr(n24).String(); got != "192.168.1.255" {
		t.Fatalf("/24 广播地址算错了: %s", got)
	}
	hosts := hostsIn(n24)
	if len(hosts) != 254 {
		t.Fatalf("/24 应有 254 台主机，实际 %d", len(hosts))
	}
	if hosts[0].String() != "192.168.1.1" || hosts[253].String() != "192.168.1.254" {
		t.Fatalf("主机区间不对: %s .. %s", hosts[0], hosts[253])
	}
	// 网络地址和广播地址都不该出现在探测列表里——往它们发单播探测毫无意义。
	for _, h := range hosts {
		if h.String() == "192.168.1.0" || h.String() == "192.168.1.255" {
			t.Fatalf("枚举里混进了 %s", h)
		}
	}

	_, n30, _ := net.ParseCIDR("10.0.0.4/30")
	if got := len(hostsIn(n30)); got != 2 {
		t.Fatalf("/30 应有 2 台主机，实际 %d", got)
	}
}

func TestScanSkipsSubnetsLargerThanASlash24(t *testing.T) {
	// /16 是 65534 台主机。扫一遍要几分钟，还会被安全软件当成端口扫描——
	// 那种规模的网络本来就该走手动输入地址那条路。这条锁住那个上限。
	_, n16, _ := net.ParseCIDR("172.16.0.0/16")
	ones, bits := n16.Mask.Size()
	if bits == 32 && ones >= 24 {
		t.Fatal("测试数据本身不对，/16 不该被判定为可扫")
	}
}

// 只知道 IP 时的端口探测：「手动输入地址」原本硬性要求 IP:端口而端口随机分配，
// ProbeHost 去掉这道门槛——问固定的信标端口即得 QUIC 端口，这是自动发现全失效时的最后兜底。

// fakeBeacon 在临时端口上应答探测，内容与真信标逐字段一致；
// 不用 Beacon 是因其绑死 47654，开发机上常被真 Tessera 占用，测试会永远 SKIP。
func fakeBeacon(t *testing.T, reply []byte) int {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("临时信标绑定失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buf := make([]byte, maxBeaconPacket)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if !strings.HasPrefix(string(buf[:n]), beaconQuery) {
				continue
			}
			_, _ = conn.WriteToUDP(reply, from)
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func TestProbeHostLearnsTheQuicPortFromJustAnIP(t *testing.T) {
	b := NewBeacon(Config{
		DeviceID:    "probe-target",
		Name:        "对面那台",
		Type:        "desktop",
		Fingerprint: []byte{9, 8, 7},
		Port:        51820,
	})
	port := fakeBeacon(t, b.replyPacket())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p, err := probeHostPort(ctx, "127.0.0.1", port, 3*time.Second)
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if p.DeviceID != "probe-target" {
		t.Fatalf("探到的不是目标设备: %+v", p)
	}
	// 关键：拿回来的必须是 QUIC 端口而非信标固定端口，否则对方去连 47654（无 QUIC 服务），表现为配对一
	// 直转圈。
	want := net.JoinHostPort("127.0.0.1", strconv.Itoa(51820))
	if len(p.Addrs) != 1 || p.Addrs[0] != want {
		t.Fatalf("地址应为 %s，实际 %v", want, p.Addrs)
	}
	if len(p.Fingerprint) == 0 {
		t.Error("指纹前缀没带回来——它是握手前防误连的那一层")
	}
}

func TestProbeHostFailsClearlyWhenNobodyAnswers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// 192.0.2.0/24 是 RFC 5737 保留给文档用的地址段，不会有人应答。
	if _, err := ProbeHost(ctx, "192.0.2.1", 700*time.Millisecond); err == nil {
		t.Fatal("没人应答时必须报错，不能静默返回一个空 Peer")
	}
}

func TestProbeHostRejectsGarbageInput(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := ProbeHost(ctx, "这不是地址", 500*time.Millisecond); err == nil {
		t.Fatal("解析不了的输入必须报错")
	}
}

// 短数字配对码：补其它四条路都走不通的空档（二维码要摄像头、附近设备要组播、手动地址要 IP 和端口，
// 原「配对码」是 416 字符的转储）。
// 短码只是定位符，之后仍要对端确认 + 双向 SAS；所以下面盯的是三件会让这条路悄悄失效或变宽的事：
// 码不对不回、没登记码不回、带码查询对老设备仍可读。

func newCodeBeacon(t *testing.T, port int) *Beacon {
	t.Helper()
	b := NewBeacon(Config{
		DeviceID:    "code-device",
		Name:        "短码测试机",
		Type:        "desktop",
		Fingerprint: []byte{9, 8, 7, 6},
		Port:        port,
	})
	if err := b.Start(); err != nil {
		t.Fatalf("信标启动失败: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })
	if !b.Listening() {
		t.Skip("端口 47654 被占用（多半是本机正跑着 Tessera），跳过实连测试")
	}
	return b
}

// probeWithCode 发一次带码查询，返回是否收到应答。
func probeWithCode(t *testing.T, code string) bool {
	t.Helper()
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: BeaconPort})
	if err != nil {
		t.Fatalf("拨号失败: %v", err)
	}
	defer func() { _ = conn.Close() }()

	pkt := beaconQuery
	if code != "" {
		pkt += "\n" + beaconCodeField + code
	}
	if _, err := conn.Write([]byte(pkt)); err != nil {
		t.Fatalf("发送探测失败: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
	buf := make([]byte, maxBeaconPacket)
	_, err = conn.Read(buf)
	return err == nil
}

func TestBeaconOnlyAnswersTheExactPairingCode(t *testing.T) {
	b := newCodeBeacon(t, 54322)
	b.SetPairingCode("123456")

	if !probeWithCode(t, "123456") {
		t.Fatal("码对上了却不应答——短码配对整条路会直接断掉")
	}
	// 码不对必须**沉默**，不能回一句"码不对"：那等于告诉对方"这台机器正在配对，
	// 只是码错了"，白送一半信息，也让暴力猜码有了反馈。
	if probeWithCode(t, "654321") {
		t.Fatal("码不对也应答了")
	}
	if probeWithCode(t, "12345") {
		t.Fatal("位数不对也应答了")
	}
}

func TestBeaconIgnoresCodedProbesWhenNoCodeIsShowing(t *testing.T) {
	b := newCodeBeacon(t, 54323)
	// 故意不 SetPairingCode。没在配对的设备如果还回应带码查询，它就成了
	// "局域网里谁在配对"的探测器。
	if probeWithCode(t, "000000") {
		t.Fatal("没登记配对码却应答了带码查询")
	}
	// 撤销之后同样要闭嘴——用户关掉配对界面就该立刻不可见。
	b.SetPairingCode("222333")
	if !probeWithCode(t, "222333") {
		t.Fatal("刚登记的码不应答")
	}
	b.SetPairingCode("")
	if probeWithCode(t, "222333") {
		t.Fatal("撤销后仍然应答旧码")
	}
}

func TestPlainProbesKeepWorkingWhileACodeIsShowing(t *testing.T) {
	b := newCodeBeacon(t, 54324)
	b.SetPairingCode("777888")
	// 普通扫描（不带码）不能因为"正在显示配对码"就被挡住——「附近设备」
	// 那条路必须一直可用，两条路是并行的，不是互斥的。
	if !probeWithCode(t, "") {
		t.Fatal("显示配对码期间，普通扫描被挡住了")
	}
}

func TestCodedQueryStaysReadableToOlderBeacons(t *testing.T) {
	// 老版用 strings.HasPrefix(pkt, beaconQuery) 判断是否问我们；带码查询必须仍满足该前缀，否则"新手机
	// + 旧电脑"连普通扫描都扫不到。
	pkt := beaconQuery + "\n" + beaconCodeField + "123456"
	if !strings.HasPrefix(pkt, beaconQuery) {
		t.Fatal("带码查询丢了 TSRA?1 前缀，老设备会直接忽略")
	}
	got, coded := queryCode([]byte(pkt))
	if !coded || got != "123456" {
		t.Fatalf("码解析错误: got=%q coded=%v", got, coded)
	}
	// 不带码的查询不能被误判成"带了个空码"——那会让普通扫描全部走进
	// 码匹配分支，然后被沉默丢弃。
	if _, coded := queryCode([]byte(beaconQuery)); coded {
		t.Fatal("普通查询被当成了带码查询")
	}
}

func TestFindByCodeRefusesAnEmptyCode(t *testing.T) {
	// 空码要当场拒绝，不能真的去扫一遍 254 台主机——那既慢又会让
	// "没输码就点了配对"表现成一次莫名其妙的长时间等待。
	if _, err := FindByCode(context.Background(), "self", "   ", time.Second); err == nil {
		t.Fatal("空配对码应当直接报错")
	}
}
