//go:build windows

package netif

import (
	"net"
	"slices"
	"testing"
)

// 一次取全表的结果必须与标准库逐卡取的一致（只比单播地址；标准库还会带任播）。
func TestEnumerateMatchesStdlib(t *testing.T) {
	got := map[int][]string{}
	for _, i := range enumerate() {
		a := append([]string(nil), i.Addrs...)
		slices.Sort(a)
		got[i.Index] = a
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		t.Skip(err)
	}
	if len(got) != len(ifaces) {
		t.Fatalf("网卡数不一致：%d vs %d", len(got), len(ifaces))
	}
	total := 0
	for _, ifi := range ifaces {
		addrs, _ := ifi.Addrs()
		var want []string
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsMulticast() {
				want = append(want, ipn.String())
			}
		}
		slices.Sort(want)
		for _, w := range want {
			if !slices.Contains(got[ifi.Index], w) {
				t.Errorf("%s 缺地址 %s，得到 %v", ifi.Name, w, got[ifi.Index])
			}
		}
		total += len(want)
	}
	t.Logf("%d 张网卡 %d 个地址一致", len(ifaces), total)
}

func BenchmarkEnumerate(b *testing.B) {
	for b.Loop() {
		enumerate()
	}
}
