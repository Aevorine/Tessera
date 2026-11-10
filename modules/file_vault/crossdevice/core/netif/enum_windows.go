//go:build windows

package netif

import (
	"net"
	"os"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 标准库的 (*net.Interface).Addrs() 每张网卡各调一次 GetAdaptersAddresses（取全表再过滤），
// 二十张网卡就是二十一次；网络监视每 2 秒查一遍，守护进程空闲时因此常占 5% 以上的单核。
// 这里一次系统调用取全表，按接口序号分发。
func enumerate() []Iface {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	addrs := unicastByIndex()
	out := make([]Iface, 0, len(ifaces))
	for _, ifi := range ifaces {
		out = append(out, Iface{
			Index:     ifi.Index,
			Name:      ifi.Name,
			Up:        ifi.Flags&net.FlagUp != 0,
			Loopback:  ifi.Flags&net.FlagLoopback != 0,
			Multicast: ifi.Flags&net.FlagMulticast != 0,
			Addrs:     addrs[ifi.Index],
		})
	}
	return out
}

func unicastByIndex() map[int][]string {
	const flags = windows.GAA_FLAG_SKIP_ANYCAST | windows.GAA_FLAG_SKIP_MULTICAST | windows.GAA_FLAG_SKIP_DNS_SERVER
	size := uint32(15000) // 微软建议的起始缓冲
	var buf []byte
	for range 4 {
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, flags, 0,
			(*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		if err == nil {
			break
		}
		if err != windows.ERROR_BUFFER_OVERFLOW || size == 0 {
			return nil
		}
		buf = nil
	}
	if buf == nil {
		return nil
	}
	out := map[int][]string{}
	for aa := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); aa != nil; aa = aa.Next {
		idx := int(aa.IfIndex)
		if idx == 0 {
			idx = int(aa.Ipv6IfIndex)
		}
		for ua := aa.FirstUnicastAddress; ua != nil; ua = ua.Next {
			ip := ua.Address.IP()
			if ip == nil {
				continue
			}
			bits := 128
			if v4 := ip.To4(); v4 != nil {
				ip, bits = v4, 32
			}
			// buf 会被回收：拷一份再用。
			ipn := net.IPNet{IP: append(net.IP(nil), ip...), Mask: net.CIDRMask(int(ua.OnLinkPrefixLength), bits)}
			out[idx] = append(out[idx], ipn.String())
		}
	}
	return out
}

var (
	watchOnce sync.Once
	watchOK   atomic.Bool
	watchKeep []windows.Handle // 句柄活到进程结束
)

// osWatch 向系统订阅「地址 / 接口变化」通知，变化时调 notifyChanged。订阅成功后清单可以放心缓存，
// 监视循环不必再轮询系统。
func osWatch() bool {
	watchOnce.Do(func() {
		if os.Getenv("TESSERA_NETIF_POLL") == "1" {
			return
		}
		cb := windows.NewCallback(func(ctx, row unsafe.Pointer, kind uint32) uintptr {
			notifyChanged()
			return 0
		})
		var h1, h2 windows.Handle
		e1 := windows.NotifyUnicastIpAddressChange(windows.AF_UNSPEC, cb, nil, false, &h1)
		e2 := windows.NotifyIpInterfaceChange(windows.AF_UNSPEC, cb, nil, false, &h2)
		if e1 == nil && e2 == nil {
			watchKeep = []windows.Handle{h1, h2}
			watchOK.Store(true)
			return
		}
		if e1 == nil {
			_ = windows.CancelMibChangeNotify2(h1)
		}
		if e2 == nil {
			_ = windows.CancelMibChangeNotify2(h2)
		}
	})
	return watchOK.Load()
}
