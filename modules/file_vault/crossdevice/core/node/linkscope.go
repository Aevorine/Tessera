package node

import (
	"net"
	"strings"

	"github.com/Aevorine/Tessera/crossdevice/core/netif"
)

// onLink 报告 addr（host:port）是否落在本机某张真实网卡的网段里（含回环与 IPv6 链路本地）。
//
// 为什么要分：设备记着对端在别的网络里用过的地址（手机热点网段、蜂窝 IPv6 等）。本机开着
// 代理 / VPN 的 TUN（sing-box、Clash、WireGuard 全局模式）时，发往这些网外地址的 TCP 会被
// TUN 本地「秒接」——实测 1~13 ms 就显示连上，连一个根本不存在的 10.255.255.7 也一样——随后
// Noise 握手干等到超时：界面每 5 分钟闪一次「验证中」13 秒，还把这台设备的 TCP 整体拉黑 5 分钟，
// 连真正的局域网地址也只能退回慢的 QUIC。QUIC 不受影响：它的 TLS 必须由真对端完成，TUN 伪造不了。
//
// 判定只认支持组播的已启用网卡（netif 约定：不支持组播的几乎都是 VPN/代理 TUN），
// 所以 TUN 自己那个 /30 不会把网外地址误判为同网段。拿不到网卡清单时返回 true，保持旧行为。
func onLink(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if i := strings.IndexByte(host, '%'); i >= 0 {
		host = host[:i] // fe80::1%eth0
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return true // 主机名：交给系统解析，不在这里拦
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return true
	}
	list := netif.List()
	if len(list) == 0 {
		return true
	}
	for _, it := range list {
		if !it.Up || (!it.Multicast && !it.Loopback) {
			continue
		}
		for _, n := range it.IPNets() {
			if n.Contains(ip) {
				return true
			}
		}
	}
	return false
}
