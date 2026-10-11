package rendezvous

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"
)

func testKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	return pub, priv
}

func TestValidToken(t *testing.T) {
	cases := []struct {
		in   string
		want bool
		why  string
	}{
		{"ABCDEFGH23456723", true, "合法的 base32 暗号"},
		{"", false, "空串"},
		{"ABCDEFGH2345672", false, "少一位"},
		{"ABCDEFGH234567234", false, "多一位"},
		{"abcdefgh23456723", false, "小写不在 base32 标准字母表里"},
		{"ABCDEFGH01234567", false, "0 和 1 不在 base32 字母表里"},
		{"ABCDEFGH2345672!", false, "标点符号"},
		{"ABCDEFGH234567\x00", false, "NUL 字节"},
	}
	for _, c := range cases {
		if got := ValidToken(c.in); got != c.want {
			t.Errorf("ValidToken(%q) = %v，期望 %v（%s）", c.in, got, c.want, c.why)
		}
	}
}

// TestSignatureBindsEveryField：任一字段被改动，签名都必须失效。要防"字段边界串味"：
// 不带长度前缀时 token="AB"+nonce="C" 与 token="A"+nonce="BC" 拼接完全一样，可搬签名。
func TestSignatureBindsEveryField(t *testing.T) {
	pub, priv := testKey(t)
	token := "ABCDEFGH" + "23456723"
	dev := "DEVICE01"
	ts := time.Now().UnixMilli()
	nonce := []byte("nonce-0123456789")

	sig := Sign(priv, "hello", token, dev, ts, nonce)
	if err := VerifySig(pub, sig, "hello", token, dev, ts, nonce); err != nil {
		t.Fatalf("原样校验就该通过，却失败了: %v", err)
	}

	tampered := []struct {
		name             string
		kind, token, dev string
		ts               int64
		nonce            []byte
	}{
		{"换了用途", "relay", token, dev, ts, nonce},
		{"换了暗号", "hello", "ZZZZZZZZ23456712", dev, ts, nonce},
		{"换了设备", "hello", token, "DEVICE02", ts, nonce},
		{"换了时间", "hello", token, dev, ts + 1, nonce},
		{"换了随机数", "hello", token, dev, ts, []byte("nonce-9876543210")},
	}
	for _, c := range tampered {
		if err := VerifySig(pub, sig, c.kind, c.token, c.dev, c.ts, c.nonce); err == nil {
			t.Errorf("%s 之后签名仍然通过——字段没有被绑进签名", c.name)
		}
	}

	// 字段边界串味：把一个字符从 token 末尾挪到 nonce 开头。
	// 没有长度前缀的话这两组拼出来的字节完全相同，签名就能被搬过去用。
	shifted := Sign(priv, "hello", "ABCDEFGH2345672", dev, ts, append([]byte("3"), nonce...))
	if bytes.Equal(sig, shifted) {
		t.Error("字段边界串味：把字符从一个字段挪到下一个字段，签名居然一样")
	}
}

func TestWrongKeyRejected(t *testing.T) {
	_, priv := testKey(t)
	otherPub, _ := testKey(t)
	nonce := []byte("n")
	ts := time.Now().UnixMilli()
	sig := Sign(priv, "hello", "ABCDEFGH23456723", "DEV", ts, nonce)
	if err := VerifySig(otherPub, sig, "hello", "ABCDEFGH23456723", "DEV", ts, nonce); err == nil {
		t.Error("换一把公钥居然也验过了")
	}
}

func TestMalformedKeyOrSigRejected(t *testing.T) {
	_, priv := testKey(t)
	nonce := []byte("n")
	ts := time.Now().UnixMilli()
	sig := Sign(priv, "hello", "ABCDEFGH23456723", "DEV", ts, nonce)

	if err := VerifySig(nil, sig, "hello", "ABCDEFGH23456723", "DEV", ts, nonce); err == nil {
		t.Error("空公钥居然验过了")
	}
	if err := VerifySig(make([]byte, 7), sig, "hello", "ABCDEFGH23456723", "DEV", ts, nonce); err == nil {
		t.Error("长度不对的公钥居然验过了")
	}
	if err := VerifySig(priv.Public().(ed25519.PublicKey), []byte{1, 2, 3}, "hello", "ABCDEFGH23456723", "DEV", ts, nonce); err == nil {
		t.Error("长度不对的签名居然验过了")
	}
}

func TestCheckFreshness(t *testing.T) {
	now := time.Now()
	ok := []time.Duration{0, 30 * time.Second, -30 * time.Second, MaxClockSkew - time.Second}
	for _, d := range ok {
		if err := CheckFreshness(now.Add(d).UnixMilli(), now); err != nil {
			t.Errorf("偏差 %v 应当被接受，却被拒了: %v", d, err)
		}
	}
	bad := []time.Duration{MaxClockSkew + time.Second, -(MaxClockSkew + time.Second), time.Hour, -time.Hour}
	for _, d := range bad {
		if err := CheckFreshness(now.Add(d).UnixMilli(), now); err == nil {
			t.Errorf("偏差 %v 应当被拒绝（重放窗口），却通过了", d)
		}
	}
}

func TestSecretMAC(t *testing.T) {
	token, dev := "ABCDEFGH23456723", "DEV"
	ts := time.Now().UnixMilli()
	nonce := []byte("n")

	// 没配口令时一律放行，且不产生 MAC。
	if mac := SecretMAC("", token, dev, ts, nonce); mac != nil {
		t.Error("没配口令却算出了 MAC")
	}
	if err := CheckSecret("", token, dev, ts, nonce, nil); err != nil {
		t.Errorf("没配口令时应当放行: %v", err)
	}

	good := SecretMAC("正确口令", token, dev, ts, nonce)
	if err := CheckSecret("正确口令", token, dev, ts, nonce, good); err != nil {
		t.Errorf("正确口令应当通过: %v", err)
	}
	bad := SecretMAC("错误口令", token, dev, ts, nonce)
	if err := CheckSecret("正确口令", token, dev, ts, nonce, bad); err == nil {
		t.Error("错误口令居然通过了")
	}
	if err := CheckSecret("正确口令", token, dev, ts, nonce, nil); err == nil {
		t.Error("不带 MAC 居然通过了——服务器口令形同虚设")
	}
	// 同一个口令换个暗号，MAC 必须不同，否则 MAC 能被跨暗号复用。
	if bytes.Equal(good, SecretMAC("正确口令", "ZZZZZZZZ23456712", dev, ts, nonce)) {
		t.Error("换了暗号 MAC 却一样——MAC 可以被跨暗号复用")
	}
}

func TestNormalizeEndpoints(t *testing.T) {
	in := []Endpoint{
		{Addr: "1.2.3.4:1"},
		{Addr: "1.2.3.4:1"}, // 重复
		{Addr: "  "},        // 空白
		{Addr: ""},          // 空
		{Addr: "5.6.7.8:2"},
	}
	got := NormalizeEndpoints(in)
	if len(got) != 2 {
		t.Fatalf("去重去空之后应剩 2 条，实际 %d 条: %v", len(got), got)
	}

	// 超量必须被截断，否则一条畸形信令能撑爆服务器内存。
	many := make([]Endpoint, MaxEndpoints*3)
	for i := range many {
		many[i] = Endpoint{Addr: string(rune('a'+i%26)) + ".example:1"}
	}
	if n := len(NormalizeEndpoints(many)); n > MaxEndpoints {
		t.Errorf("地址数量没有被限制在 %d 以内，实际 %d", MaxEndpoints, n)
	}
}
