package node

// 连接自检：回答"为什么看不到另一台设备"。空列表至少有六种成因（监听没起、防火墙挡入站、
// 路由器丢组播、不同网段、对方没开应用、对方睡眠）。能自动判定的逐项给结论，
// 判不了的（如对方是否开着应用）不假装判，留给界面写提示。

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/discovery"
	"github.com/Aevorine/Tessera/crossdevice/core/netif"
)

// DiagStatus 是单项检查结论。前三档说本机这项好不好，DiagInfo 只是观测结果、无好坏。
// "看到 0 台设备"、"扫描没扫到"不是本机毛病（对方没开机、只有一台电脑都会如此），
// 报 warn 会误导用户去改防火墙。规则：本机可控的项才用 warn/fail，观测数量只是 info；
// 仅当本机确有配置问题（如信标端口没占上）才把观测升级成 warn。
const (
	DiagOK   = "ok"   // 这一项没问题
	DiagInfo = "info" // 只是一条观测结果，没有好坏之分
	DiagWarn = "warn" // 能用，但很可能就是它导致对方看不到你
	DiagFail = "fail" // 这一项断了，不修好后面都白搭
)

// DiagCheck 是自检报告的一行，有意不带人类可读句子：文案出六种语言，归界面管；
// Values 放要填进文案的数字/地址（端口、网段、扫到几台）。
type DiagCheck struct {
	ID     string            `json:"id"`
	Status string            `json:"status"`
	Values map[string]string `json:"values,omitempty"`
}

// DiagReport 是一次完整自检的结果。
type DiagReport struct {
	Checks []DiagCheck `json:"checks"`
	// Endpoints 是本机地址，界面直接显示出来让用户抄到另一台设备上。
	Endpoints []string `json:"endpoints"`
}

// Diagnose 跑一遍连接自检。会真发局域网扫描，耗时以秒计（默认 3 秒），
// 只能放在用户主动点击之后，不能界面打开时自动跑。
func (n *Node) Diagnose(ctx context.Context) DiagReport {
	rep := DiagReport{Checks: []DiagCheck{}, Endpoints: n.LocalEndpoints()}

	add := func(id, status string, values map[string]string) {
		rep.Checks = append(rep.Checks, DiagCheck{ID: id, Status: status, Values: values})
	}

	// 1. 监听器起来了没。这一项挂了别的都不用看——没人能连进来。
	if addr := n.Addr(); addr != nil {
		add("listening", DiagOK, map[string]string{"addr": addr.String()})
	} else {
		add("listening", DiagFail, nil)
		return rep // 后面几项都依赖它，继续跑只会产生一串误导性的结论
	}

	// 1.5 网卡清单本身。排在最前：它一挂，后面全以"一切正常但找不到设备"的样子静默失败
	// （地址、网段空，组播组没加入）。安卓 11+ 的 net.Interfaces() 一律 permission denied
	// （golang/go#40569），清单只能由平台层灌入，灌没灌、灌几张是排查第一现场。
	{
		usable := netif.Usable()
		multicast := 0
		for _, i := range usable {
			if i.Multicast {
				multicast++
			}
		}
		src := "system"
		if provided, _ := netif.Provided(); provided {
			src = "host"
		}
		vals := map[string]string{
			"usable":    strconv.Itoa(len(usable)),
			"multicast": strconv.Itoa(multicast),
			"source":    src,
		}
		switch {
		case len(usable) == 0:
			add("interfaces", DiagFail, vals)
		case multicast == 0:
			// 有网卡但一张都不支持组播 = 通常只剩 VPN 的 TUN。mDNS 这条路走不通，
			// 但主动扫描和手动地址还有救，所以是 warn 不是 fail。
			add("interfaces", DiagWarn, vals)
		default:
			add("interfaces", DiagOK, vals)
		}
	}

	// 2. 有没有可对外公布的地址。一条都没有通常意味着只剩回环网卡
	//    （网线拔了 / Wi-Fi 断了），或者只剩 VPN 的 TUN 网卡。
	switch len(rep.Endpoints) {
	case 0:
		add("endpoints", DiagFail, nil)
	default:
		add("endpoints", DiagOK, map[string]string{"count": strconv.Itoa(len(rep.Endpoints))})
	}

	// 3. mDNS 公布是否成功。失败常见（严格防火墙、容器、AP 隔离）且不致命（信标与手动地址
	// 不依赖它），但它是"对方自动看到你"的主通路，单独报一行。
	publishOK := n.disc != nil && n.disc.Published()
	if publishOK {
		add("mdns_publish", DiagOK, nil)
	} else {
		add("mdns_publish", DiagWarn, nil)
	}

	// 4. 信标端口占上了没。没占上说明本机不应答主动扫描，对方那边"扫描局域网"
	//    会扫不到你——但你扫别人仍然有效，所以是 warn 不是 fail。
	beaconOK := n.beacon != nil && n.beacon.Listening()
	if beaconOK {
		add("beacon", DiagOK, map[string]string{"port": strconv.Itoa(discovery.BeaconPort)})
	} else {
		add("beacon", DiagWarn, map[string]string{"port": strconv.Itoa(discovery.BeaconPort)})
	}

	// 本机一侧全正常时，"看到几台"只描述对面情况，不报本机警告；公布或信标有问题时
	// 0 台才可能是本机造成，才升级成 warn。
	localHealthy := publishOK && beaconOK

	// 5. mDNS 当前看到几台。
	seen := len(n.DiscoveredPeers())
	switch {
	case seen > 0:
		add("mdns_peers", DiagOK, map[string]string{"count": strconv.Itoa(seen)})
	case localHealthy:
		add("mdns_peers", DiagInfo, map[string]string{"count": "0"})
	default:
		add("mdns_peers", DiagWarn, map[string]string{"count": "0"})
	}

	// 6. 真扫一次：扫描走广播和单播绕开组播，是唯一能区分"组播被丢"与"对方不在"的一项。
	// 扫到 → 问题在组播，提示用扫描或手动地址；没扫到 → 多半不同网段或对方没开。
	scanCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	res, err := discovery.Scan(scanCtx, n.id.DeviceID(), 3*time.Second)
	if err != nil {
		add("lan_scan", DiagFail, nil)
	} else {
		status := DiagWarn
		switch {
		case len(res.Peers) > 0:
			status = DiagOK
		case localHealthy:
			// 扫完一整个网段一台没有，而本机一切正常——这就是"对面不在"，
			// 一个再正常不过的结果。它不是本机的故障，不该挂个感叹号。
			status = DiagInfo
		}
		add("lan_scan", status, map[string]string{
			"found":   strconv.Itoa(len(res.Peers)),
			"probed":  strconv.Itoa(res.Probed),
			"subnets": strings.Join(res.Subnets, ", "),
		})
	}

	return rep
}
