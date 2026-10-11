package rendezvous

import "testing"

// 暗号是客户端自己挑的，按来源地址再记一道账：IPv6 按 /64，同一户人家换地址后缀绕不过去。
func TestSourceKeyGroupsIPv6ByPrefix(t *testing.T) {
	cases := map[string]string{
		"203.0.113.7:5000":            "203.0.113.7",
		"[2001:db8:1:2::5]:5000":      "2001:db8:1:2::/64",
		"[2001:db8:1:2:ffff::9]:6000": "2001:db8:1:2::/64",
		"[::ffff:198.51.100.1]:1":     "198.51.100.1",
		"not-an-address":              "not-an-address",
	}
	for in, want := range cases {
		if got := sourceKey(in); got != want {
			t.Errorf("sourceKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRelayAdmissionCaps(t *testing.T) {
	s := NewServer(ServerConfig{MaxRelaysPerIP: 2, MaxRelays: 3})
	if !s.admitRelay("a") || !s.admitRelay("a") {
		t.Fatal("每个来源前两条应当放行")
	}
	if s.admitRelay("a") {
		t.Fatal("同一来源第三条应当被挡")
	}
	if !s.admitRelay("b") {
		t.Fatal("另一个来源应当还能进")
	}
	if s.admitRelay("c") {
		t.Fatal("全服务器上限到了应当被挡")
	}
	s.releaseRelay("a")
	if !s.admitRelay("c") {
		t.Fatal("释放一个名额之后应当能进")
	}
	s.releaseRelay("a")
	s.releaseRelay("b")
	s.releaseRelay("c")
	if s.nActive != 0 || len(s.active) != 0 {
		t.Fatalf("全部释放后计数没归零: total=%d per=%v", s.nActive, s.active)
	}
}

// 换一批新暗号绕不过来源地址那一道账。
func TestPerIPQuotaSurvivesFreshTokens(t *testing.T) {
	s := NewServer(ServerConfig{DailyRelayBytes: 100, DailyRelayBytesPerIP: 150})
	if !s.quotaAvailable("tok1") || !s.ipQuotaAvailable("1.2.3.4") {
		t.Fatal("初始应当有配额")
	}
	s.chargeQuota("tok1", 100)
	s.chargeIPQuota("1.2.3.4", 100)
	if s.quotaAvailable("tok1") {
		t.Fatal("暗号配额用完了")
	}
	s.chargeQuota("tok2", 60)
	s.chargeIPQuota("1.2.3.4", 60)
	if !s.quotaAvailable("tok3") {
		t.Fatal("新暗号自己的配额是满的")
	}
	if s.ipQuotaAvailable("1.2.3.4") {
		t.Fatal("同一来源换了暗号也不该再有配额")
	}
	if !s.ipQuotaAvailable("5.6.7.8") {
		t.Fatal("别的来源不受影响")
	}
}
