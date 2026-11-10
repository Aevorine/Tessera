//go:build !windows

package netif

import "net"

func enumerate() []Iface {
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

// osWatch 这些平台没有接系统通知，清单不缓存，监视循环照旧轮询。
func osWatch() bool { return false }
