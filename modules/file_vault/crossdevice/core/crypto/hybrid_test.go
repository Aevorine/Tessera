package crypto

import (
	"bytes"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// 起一对已握完手的 SecureConn，用真 socket 而非 net.Pipe：混合升级有边写边读的来回，无缓冲的
// net.Pipe 会变成死锁。
func pairedConns(t *testing.T) (*SecureConn, *SecureConn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer ln.Close()

	iPriv, iPub := mustKeypair(t)
	rPriv, rPub := mustKeypair(t)
	prologue := Prologue("test", "i", "r")

	type out struct {
		sc  *SecureConn
		err error
	}
	done := make(chan out, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- out{nil, err}
			return
		}
		res, err := HandshakeXXResponder(conn, StaticKey(rPriv, rPub), prologue,
			func([]byte) []byte { return nil })
		if err != nil {
			done <- out{nil, err}
			return
		}
		done <- out{NewSecureConn(conn, res), nil}
	}()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("连接失败: %v", err)
	}
	res, err := HandshakeXXInitiator(conn, StaticKey(iPriv, iPub), prologue, nil,
		func([]byte) []byte { return nil })
	if err != nil {
		t.Fatalf("发起方握手失败: %v", err)
	}
	r := <-done
	if r.err != nil {
		t.Fatalf("响应方握手失败: %v", r.err)
	}
	return NewSecureConn(conn, res), r.sc
}

func mustKeypair(t *testing.T) ([32]byte, [32]byte) {
	t.Helper()
	kp, err := Suite().GenerateKeypair(nil)
	if err != nil {
		t.Fatalf("生成密钥对失败: %v", err)
	}
	var priv, pub [32]byte
	copy(priv[:], kp.Private)
	copy(pub[:], kp.Public)
	return priv, pub
}

func upgradeBoth(t *testing.T, ini, res *SecureConn) error {
	t.Helper()
	errc := make(chan error, 1)
	go func() { errc <- UpgradeToHybrid(res, false) }()
	if err := UpgradeToHybrid(ini, true); err != nil {
		return err
	}
	select {
	case err := <-errc:
		return err
	case <-time.After(10 * time.Second):
		return errors.New("响应方升级超时")
	}
}

func TestHybridUpgradeKeepsTheChannelWorking(t *testing.T) {
	ini, res := pairedConns(t)
	if err := upgradeBoth(t, ini, res); err != nil {
		t.Fatalf("升级失败: %v", err)
	}

	// 双向都要通：收发方向派生的是两把不同的密钥，只测一个方向的话，
	// 把 i2r/r2i 接反了照样能过。
	for _, tc := range []struct {
		name     string
		from, to *SecureConn
		msg      []byte
	}{
		{"发起方 -> 响应方", ini, res, []byte("hello from initiator")},
		{"响应方 -> 发起方", res, ini, bytes.Repeat([]byte("x"), 4096)},
	} {
		if err := tc.from.WriteRecord(tc.msg); err != nil {
			t.Fatalf("%s 写入失败: %v", tc.name, err)
		}
		got, err := tc.to.ReadRecord()
		if err != nil {
			t.Fatalf("%s 读取失败: %v", tc.name, err)
		}
		if !bytes.Equal(got, tc.msg) {
			t.Fatalf("%s 内容不符", tc.name)
		}
	}
}

func TestHybridUpgradeActuallyChangesTheKeys(t *testing.T) {
	// 最要命的那种失败：升级"成功"了，密钥却没换。所有功能测试照样全绿，
	// 而流量仍然只被 X25519 保护着——也就是说这个功能等于没做，且看不出来。
	ini, res := pairedConns(t)
	before := ini.res.send.UnsafeKey()
	if err := upgradeBoth(t, ini, res); err != nil {
		t.Fatalf("升级失败: %v", err)
	}
	after := ini.res.send.UnsafeKey()
	if before == after {
		t.Fatal("升级之后传输密钥没变——后量子层没有真正生效")
	}
	if ini.res.send.UnsafeKey() == ini.res.recv.UnsafeKey() {
		t.Fatal("收发用了同一把密钥——两个方向必须独立派生")
	}
}

func TestHybridKeysAgreeAcrossTheTwoSides(t *testing.T) {
	ini, res := pairedConns(t)
	if err := upgradeBoth(t, ini, res); err != nil {
		t.Fatalf("升级失败: %v", err)
	}
	// 发起方的发送密钥必须等于响应方的接收密钥，反之亦然。角色接反是这段代码
	// 最容易犯的错，而它的表现是"连上了但每条消息都解密失败"——很难从现象倒推。
	if ini.res.send.UnsafeKey() != res.res.recv.UnsafeKey() {
		t.Fatal("发起方发送密钥与响应方接收密钥不一致")
	}
	if res.res.send.UnsafeKey() != ini.res.recv.UnsafeKey() {
		t.Fatal("响应方发送密钥与发起方接收密钥不一致")
	}
}

func TestHybridKeysDifferPerSession(t *testing.T) {
	// 两条独立会话不能派生出同一把密钥，否则 ML-KEM 那一轮就是摆设。
	a1, a2 := pairedConns(t)
	if err := upgradeBoth(t, a1, a2); err != nil {
		t.Fatalf("第一条会话升级失败: %v", err)
	}
	b1, b2 := pairedConns(t)
	if err := upgradeBoth(t, b1, b2); err != nil {
		t.Fatalf("第二条会话升级失败: %v", err)
	}
	if a1.res.send.UnsafeKey() == b1.res.send.UnsafeKey() {
		t.Fatal("两条会话派生出了相同的密钥")
	}
}

func TestSupportsPQ(t *testing.T) {
	for _, tc := range []struct {
		features []string
		want     bool
	}{
		{nil, false},                     // 老设备：字段整个缺席
		{[]string{}, false},              // 老设备：空数组
		{[]string{"pq1"}, true},          //
		{[]string{"other", "pq1"}, true}, // 顺序无关
		{[]string{"pq2"}, false},         // 前缀相近的将来版本不能误判成支持
		{[]string{"PQ1"}, false},         // 大小写不同不算
	} {
		if got := SupportsPQ(tc.features); got != tc.want {
			t.Fatalf("SupportsPQ(%v) = %v, 期望 %v", tc.features, got, tc.want)
		}
	}
}

func TestHybridRejectsWrongSizedKeyMaterial(t *testing.T) {
	// 降级攻击的入口：中间人把 ML-KEM 公钥换成一段垃圾，指望响应方"算了不升级了"
	// 继续用纯 X25519。必须报错断连，绝不能悄悄退回去。
	ini, res := pairedConns(t)
	go func() { _ = ini.WriteRecord([]byte("not a real ML-KEM key")) }()
	err := UpgradeToHybrid(res, false)
	if err == nil {
		t.Fatal("长度不对的公钥必须被拒绝，而不是静默降级")
	}
	if !errors.Is(err, errPQBadLength) {
		t.Fatalf("期望长度错误，实际: %v", err)
	}
}

func TestHybridSurvivesRecordsLargerThanOneNoiseFrame(t *testing.T) {
	// 升级后走的是全新的 CipherState，nonce 从 0 重新计数。分片写入会连续用掉
	// 多个 nonce，这里确认分片路径在换钥之后仍然对得上。
	ini, res := pairedConns(t)
	if err := upgradeBoth(t, ini, res); err != nil {
		t.Fatalf("升级失败: %v", err)
	}
	big := bytes.Repeat([]byte("A"), 200_000) // 远超单条 Noise 记录上限
	go func() { _ = ini.WriteRecord(big) }()
	got := make([]byte, 0, len(big))
	for len(got) < len(big) {
		rec, err := res.ReadRecord()
		if err != nil && !errors.Is(err, io.EOF) {
			t.Fatalf("读取分片失败: %v", err)
		}
		got = append(got, rec...)
	}
	if !bytes.Equal(got, big) {
		t.Fatal("分片重组后内容不符")
	}
}
