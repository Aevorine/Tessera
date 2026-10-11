// Package netif 是取「本机网卡及地址」的唯一入口，不要直接调 net.Interfaces()。
//
// Android 11+ 禁止应用走 NETLINK RTM_GETLINK（golang/go#40569），net.Interfaces() 和
// net.InterfaceAddrs() 一律报 `netlinkrib: permission denied`。后果是静默失效：
// localEndpoints/localIPv4Subnets 返回空，zeroconf 传 nil 自行枚举也失败，设备发现全死。
//
// 解法：网卡清单可替换。桌面端走 net.Interfaces()；安卓端由 Kotlin 用 NetworkInterface
// 枚举后经 mobile 绑定层灌入，且必须在启动节点之前设好。
package netif

import (
	"net"
	"strings"
	"sync"
)

// Iface 是网卡的最小描述，刻意不含 MAC（用不上，且正是 Android 封掉的内容）。
type Iface struct {
	// Index 是内核的接口序号。zeroconf 加入组播组时要用它定位接口，
	// 填错会 join 到别的网卡上——不报错，但收不到任何东西。
	Index int
	Name  string
	// Up / Loopback / Multicast 对应 net.Flags。不支持组播的接口几乎必是 VPN/代理 TUN，
	// 往那儿广播只会白等超时（见 node/reconnect.go）。
	Up        bool
	Loopback  bool
	Multicast bool
	// Addrs 是 CIDR 写法的地址，如 "192.168.1.7/24"、"fe80::1/64"。
	// 用 CIDR 而不是裸 IP：算网段要掩码，而「扫描局域网」整条路都建立在网段上。
	Addrs []string
}

// IPNets 把 Addrs 解析成 *net.IPNet。解析不了的静默跳过——
// 这份数据可能来自另一个运行时（安卓的 Java 层），不能假设它永远规整。
func (i Iface) IPNets() []*net.IPNet {
	out := make([]*net.IPNet, 0, len(i.Addrs))
	for _, s := range i.Addrs {
		ip, ipnet, err := net.ParseCIDR(strings.TrimSpace(s))
		if err != nil || ip == nil || ipnet == nil {
			continue
		}
		// ParseCIDR 的第二个返回值是**网段**（主机位已清零），而调用方要的是
		// 「这张网卡上的那个具体地址 + 掩码」。把 IP 换回未掩码的那个。
		out = append(out, &net.IPNet{IP: ip, Mask: ipnet.Mask})
	}
	return out
}

// netFlags 还原成标准库的 Flags，好让原有的按位判断一个字都不用改。
func (i Iface) netFlags() net.Flags {
	var f net.Flags
	if i.Up {
		f |= net.FlagUp
	}
	if i.Loopback {
		f |= net.FlagLoopback
	}
	if i.Multicast {
		f |= net.FlagMulticast
	}
	return f
}

var (
	mu       sync.RWMutex
	provided []Iface
	hasProv  bool
)

// SetProvided 由宿主灌入网卡清单。空切片 = 「枚举到零张」，不得回退 net.Interfaces()
// （安卓上是死路）；「没设过」才回退。
func SetProvided(list []Iface) {
	mu.Lock()
	defer mu.Unlock()
	provided = append([]Iface(nil), list...)
	hasProv = true
}

// Clear 撤回外部清单，回到标准库那一路。测试和桌面端用。
func Clear() {
	mu.Lock()
	defer mu.Unlock()
	provided = nil
	hasProv = false
}

// Provided 报告当前是否在用外部灌进来的清单。诊断报告要显示这一条——
// 「扫不到设备」时，第一件要确认的事就是网卡清单到底是不是空的。
func Provided() (bool, int) {
	mu.RLock()
	defer mu.RUnlock()
	return hasProv, len(provided)
}

// List 返回当前的网卡清单。
func List() []Iface {
	mu.RLock()
	if hasProv {
		out := append([]Iface(nil), provided...)
		mu.RUnlock()
		return out
	}
	mu.RUnlock()
	return fromStdlib()
}

func fromStdlib() []Iface {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := make([]Iface, 0, len(ifaces))
	for _, ifi := range ifaces {
		addrs, err := ifi.Addrs()
		if err != nil {
			// 单张网卡取地址失败不该带走整份清单——多网卡机器上很常见。
			continue
		}
		cidrs := make([]string, 0, len(addrs))
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				cidrs = append(cidrs, ipn.String())
			}
		}
		out = append(out, Iface{
			Index:     ifi.Index,
			Name:      ifi.Name,
			Up:        ifi.Flags&net.FlagUp != 0,
			Loopback:  ifi.Flags&net.FlagLoopback != 0,
			Multicast: ifi.Flags&net.FlagMulticast != 0,
			Addrs:     cidrs,
		})
	}
	return out
}

// Usable 是「可用于设备发现的网卡」的唯一定义：已启用、非回环、支持组播。
func Usable() []Iface {
	all := List()
	out := make([]Iface, 0, len(all))
	for _, i := range all {
		if !i.Up || i.Loopback {
			continue
		}
		out = append(out, i)
	}
	return out
}

// MulticastInterfaces 把可用网卡转成 zeroconf 需要的 []net.Interface。
// 必须显式传给 zeroconf、不能传 nil：它会自己调 net.Interfaces()，在安卓上失败只 log
// 一句，注册照常"成功"。返回 nil 表示不知道网卡，此时传 nil 才对（桌面端由它自己枚举）。
func MulticastInterfaces() []net.Interface {
	list := Usable()
	out := make([]net.Interface, 0, len(list))
	for _, i := range list {
		if !i.Multicast {
			continue
		}
		out = append(out, net.Interface{
			Index: i.Index,
			Name:  i.Name,
			Flags: i.netFlags(),
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
