package node

import (
	"net"
	"testing"
)

// 锁住一个真实故障：电脑开着 VPN/代理时，其 TUN 地址（172.18.0.1）排在配对码公布地址
// 第一位，真正的局域网地址排第二，手机逐个连时白等超时，表现为"扫了没反应"。
// 判据用接口能力而非网卡名：VPN 的 singbox_tun 是 `up|running`（无 broadcast/multicast），
// 真实 WLAN 带 multicast；设备发现靠 mDNS 组播，无组播的接口没用。按名字维护黑名单追不完。

func TestVirtualIfaceNameBlacklist(t *testing.T) {
	virtual := []string{
		"VMware Network Adapter VMnet1",
		"VirtualBox Host-Only Network",
		"vEthernet (Default Switch)",
		"docker0",
		"WSL (Hyper-V firewall)",
	}
	for _, name := range virtual {
		if !isVirtualIface(name) {
			t.Errorf("%q 应当被认成虚拟网卡", name)
		}
	}

	real := []string{"WLAN", "以太网", "Wi-Fi", "eth0", "Ethernet 2"}
	for _, name := range real {
		if isVirtualIface(name) {
			t.Errorf("%q 是真实网卡，不该被降权", name)
		}
	}
}

// scoreFor 复刻 localEndpoints 里的打分逻辑，用来在不依赖本机真实网卡的前提下
// 断言排序意图。改了 localEndpoints 的评分就要同步改这里——两边一起动才有意义。
func scoreFor(ip net.IP, flags net.Flags, ifaceName string) int {
	v4 := ip.To4()
	score := 0
	switch {
	case v4 != nil && ip.IsPrivate():
		score = 100
	case v4 != nil:
		score = 50
	default:
		score = 10
	}
	if flags&net.FlagMulticast == 0 {
		score -= 200
	}
	if isVirtualIface(ifaceName) {
		score -= 80
	}
	return score
}

func TestLanAddressOutranksVpnTunnel(t *testing.T) {
	const realFlags = net.FlagUp | net.FlagBroadcast | net.FlagMulticast | net.FlagRunning
	const tunFlags = net.FlagUp | net.FlagRunning // VPN 的 TUN：没有组播

	lan := scoreFor(net.ParseIP("192.168.1.10"), realFlags, "WLAN")
	vpn := scoreFor(net.ParseIP("172.18.0.1"), tunFlags, "singbox_tun")

	if vpn >= lan {
		t.Fatalf("VPN 的 TUN 地址不该排在局域网地址前面：lan=%d vpn=%d", lan, vpn)
	}
	// 必须是负分，才能保证在只取前 3 个地址时被彻底挤出去，
	// 而不是"排在后面但仍然占了一个名额"。
	if vpn >= 0 {
		t.Errorf("没有组播能力的接口应当被判成负分，实际 %d", vpn)
	}
}

func TestMulticastCapableVirtualAdapterStillDemoted(t *testing.T) {
	// VMware 的 host-only 网卡确实支持组播，能力检测筛不掉它，
	// 所以名字黑名单这条不能删。
	const realFlags = net.FlagUp | net.FlagBroadcast | net.FlagMulticast | net.FlagRunning
	lan := scoreFor(net.ParseIP("192.168.1.10"), realFlags, "WLAN")
	vm := scoreFor(net.ParseIP("192.168.56.1"), realFlags, "VMware Network Adapter VMnet1")
	if vm >= lan {
		t.Errorf("VMware 虚拟网卡不该和真实局域网并列：lan=%d vm=%d", lan, vm)
	}
}

func TestIPv6RanksBelowPrivateIPv4(t *testing.T) {
	const realFlags = net.FlagUp | net.FlagBroadcast | net.FlagMulticast | net.FlagRunning
	v4 := scoreFor(net.ParseIP("192.168.1.10"), realFlags, "WLAN")
	v6 := scoreFor(net.ParseIP("2001:db8::1"), realFlags, "WLAN")
	if v6 >= v4 {
		t.Errorf("IPv6 应当排在私有 IPv4 之后（很多环境配了但不通）：v4=%d v6=%d", v4, v6)
	}
}
