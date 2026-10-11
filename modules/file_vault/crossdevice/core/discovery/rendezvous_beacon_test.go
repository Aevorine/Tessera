package discovery

import "testing"

// 令牌算得再对，信标不应答就等于没做——而这种失败不报任何错，
// 表现只是"扫不到"，跟"对方没开机"长得一模一样。
func TestBeaconAnswersRegisteredRendezvousCodes(t *testing.T) {
	b := &Beacon{}

	if b.matchesPairingCode("ANYTHING") {
		t.Fatal("什么都没登记时不能应答带码查询——否则这台设备成了「谁在配对」的探测器")
	}

	b.SetRendezvousCodes([]string{"AAAABBBBCCCCDDDD", "EEEEFFFFGGGGHHHH"})
	for _, c := range []string{"AAAABBBBCCCCDDDD", "EEEEFFFFGGGGHHHH"} {
		if !b.matchesPairingCode(c) {
			t.Fatalf("登记过的令牌 %s 没被应答", c)
		}
	}
	if b.matchesPairingCode("AAAABBBBCCCCDDDE") {
		t.Fatal("差一位的令牌也被应答了")
	}
	if b.matchesPairingCode("aaaabbbbccccdddd") {
		t.Fatal("大小写不同也被应答了——两边算出的是同一串，不该做大小写折叠")
	}

	// 短配对码和约定令牌必须共存：用户正在用 6 位码配一台新设备时，
	// 已配对设备的自动发现不能因此瞎掉。
	b.SetPairingCode("123456")
	if !b.matchesPairingCode("123456") {
		t.Fatal("登记令牌之后短配对码不应答了")
	}
	if !b.matchesPairingCode("AAAABBBBCCCCDDDD") {
		t.Fatal("登记短配对码之后令牌不应答了")
	}

	// 整份替换，不是增量：一台被撤销信任的设备，它的令牌必须真的消失。
	b.SetRendezvousCodes([]string{"EEEEFFFFGGGGHHHH"})
	if b.matchesPairingCode("AAAABBBBCCCCDDDD") {
		t.Fatal("被移出集合的令牌仍在应答——撤销信任之后对方还能找到这台机器")
	}

	b.SetRendezvousCodes(nil)
	if b.matchesPairingCode("EEEEFFFFGGGGHHHH") {
		t.Fatal("清空之后仍在应答")
	}
	if !b.matchesPairingCode("123456") {
		t.Fatal("清空令牌把短配对码一起清掉了")
	}
}
