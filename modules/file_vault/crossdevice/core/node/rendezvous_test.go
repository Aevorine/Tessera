package node

import (
	"crypto/rand"
	"testing"
	"time"
)

func randPub(t *testing.T) []byte {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("随机数失败: %v", err)
	}
	return b
}

func TestRendezvousTokenIsTheSameFromBothSides(t *testing.T) {
	// 整套机制就靠这一条成立。接反了不会报任何错——两台设备各挂各的令牌，
	// 各扫各的，永远扫不到对方，表现成"这个功能没用"。
	a, b := randPub(t), randPub(t)
	const w = 12345
	if got, want := rendezvousToken(a, b, w), rendezvousToken(b, a, w); got != want {
		t.Fatalf("两侧算出的令牌不一致:\n  A 侧 %s\n  B 侧 %s", got, want)
	}
}

func TestRendezvousTokenShape(t *testing.T) {
	tok := rendezvousToken(randPub(t), randPub(t), 1)
	if len(tok) != rendezvousCodeLen {
		t.Fatalf("令牌长度 %d，期望 %d", len(tok), rendezvousCodeLen)
	}
	for _, r := range tok {
		if !(r >= 'A' && r <= 'Z') && !(r >= '2' && r <= '7') {
			t.Fatalf("令牌里出现了非 base32 字符 %q（信标查询包按文本处理）", r)
		}
	}
}

func TestRendezvousTokenVariesByPeerAndWindow(t *testing.T) {
	self := randPub(t)
	p1, p2 := randPub(t), randPub(t)

	if rendezvousToken(self, p1, 1) == rendezvousToken(self, p2, 1) {
		t.Fatal("不同对端算出了同一个令牌——那样一台设备的令牌会把别人的也应答掉")
	}
	if rendezvousToken(self, p1, 1) == rendezvousToken(self, p1, 2) {
		t.Fatal("换了时间窗令牌没变——轮换是为了不让旁观者长期追踪同一对设备")
	}
	// 同一对 + 同一窗口必须稳定，否则每次刷新都换一个，两边永远对不上。
	if rendezvousToken(self, p1, 7) != rendezvousToken(self, p1, 7) {
		t.Fatal("同样的输入算出了不同的令牌")
	}
}

func TestRendezvousTokenDoesNotLeakTheKeys(t *testing.T) {
	// 令牌是公开的（要塞进探测包里）。它不该能反推出输入——虽然输入本身是
	// 公钥，但把公钥直接印在广播包里等于向全网公布"这台设备属于谁"。
	a, b := randPub(t), randPub(t)
	tok := rendezvousToken(a, b, 99)
	raw := string(a) + string(b)
	if len(tok) >= len(raw) {
		t.Fatal("令牌不比输入短，可能不是摘要")
	}
	for i := 0; i+8 <= len(raw); i++ {
		if len(tok) >= 8 && raw[i:i+8] == tok[:8] {
			t.Fatal("令牌里出现了输入的明文片段")
		}
	}
}

func TestCurrentRendezvousWindowAdvances(t *testing.T) {
	now := time.Now()
	if currentRendezvousWindow(now) != currentRendezvousWindow(now.Add(time.Second)) {
		t.Fatal("一秒之内窗口就变了——那样两边几乎不可能落在同一个窗口里")
	}
	if currentRendezvousWindow(now) == currentRendezvousWindow(now.Add(2*rendezvousWindow)) {
		t.Fatal("过了两个周期窗口还没变")
	}
}

func TestRendezvousScanIsSlowerThanTheWindowRotates(t *testing.T) {
	// 扫描周期必须远短于轮换周期，否则每次扫描都可能正好卡在窗口边界，
	// 而"边界那一下互相找不到"是最难复现的那种偶发失败。
	if rendezvousScanEvery >= rendezvousWindow/4 {
		t.Fatalf("扫描间隔 %v 相对轮换周期 %v 太长", rendezvousScanEvery, rendezvousWindow)
	}
}
