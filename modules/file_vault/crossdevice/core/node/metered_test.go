package node

import (
	"strings"
	"testing"

	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// 跨网会自动花用户手机流量：切到 4G 后台重连会连汇合点，打不通还走中继，把整个文件过
// 一遍公网，用户到月底才知道。这些断言钉住防止它发生的那道闸。

func TestMeteredDefaultsToUnmetered(t *testing.T) {
	n := &Node{}
	if n.Metered() {
		t.Error("平台侧没报过的时候应当按不计费处理（桌面端就该是这样）")
	}
	if n.RelayOnMetered() {
		t.Error("「计量网络下允许中继」必须默认关闭——默认花用户的钱是不可接受的")
	}
}

func TestRelayBlockedOnMeteredByDefault(t *testing.T) {
	n := &Node{}
	// 造一个"中继可用"的状态：client 为 nil 时 RelayAvailable 就是 false，
	// 所以这里直接验策略那一半——计量开启后，无论中继本身可不可用，都不该放行。
	n.SetMetered(true)
	if n.relayAllowedNow() {
		t.Error("计量网络下默认不该允许中继")
	}

	// 用户显式打开之后才允许（此处中继本身不可用，所以仍是 false，
	// 但策略这一层不该再是拦截方）。
	n.SetRelayOnMetered(true)
	if n.metered.Load() && !n.relayOnMetered.Load() {
		t.Error("显式允许之后，计量这一层不该继续拦截")
	}
}

func TestUnmeteredAlwaysAllowsPolicy(t *testing.T) {
	n := &Node{}
	n.SetMetered(false)
	// 不计费的网络下，策略层永远不该是拦截方。
	if n.metered.Load() {
		t.Error("SetMetered(false) 之后不该还是计量状态")
	}
}

// 被流量策略挡住时提示必须说明是"主动省流量"，否则"Wi-Fi 能连、流量不行"像 bug，
// 用户会反复重装、重配对。
func TestMeteredBlockExplainsItself(t *testing.T) {
	peer := &store.Peer{DeviceID: "DEV1", Name: "家里电脑"}

	n := &Node{}
	n.crossnet.Store(&crossnetState{}) // 跨网已启用
	n.SetMetered(true)

	msg := n.noRouteError(peer).Error()
	if !strings.Contains(msg, "流量") {
		t.Errorf("被流量策略挡住时必须点明原因，实际：%q", msg)
	}
	if !strings.Contains(msg, "Wi-Fi") {
		t.Errorf("应当告诉用户「接上 Wi-Fi 就能连」这个立刻可行的动作，实际：%q", msg)
	}

	// 允许之后就不该再报这条了，否则用户改了设置还看到同样的话会以为没生效。
	n.SetRelayOnMetered(true)
	msg2 := n.noRouteError(peer).Error()
	if strings.Contains(msg2, "已自动跳过中转") {
		t.Errorf("用户已经允许用流量中转了，不该还说跳过了中转：%q", msg2)
	}
}
