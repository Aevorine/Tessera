package node

import (
	"errors"
	"strings"
	"testing"

	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// 连接失败提示必须能指导下一步。这些断言防止重构把话换回"所有路径均不可达"之类的
// 技术黑话（编译和测试照过，用户却只能重试，而真因可能是"跨网没配"）。

func TestNoRouteErrorTellsUserWhatToDo(t *testing.T) {
	peer := &store.Peer{DeviceID: "DEV1", Name: "小米手机"}

	// 没开跨网时，必须点明"要连外面的设备得先配中转点"。
	n := &Node{}
	err := n.noRouteError(peer)
	msg := err.Error()
	if !strings.Contains(msg, "小米手机") {
		t.Errorf("提示里没有设备名，用户不知道说的是哪台：%q", msg)
	}
	if !strings.Contains(msg, "跨网络连接") {
		t.Errorf("跨网未启用时应当指路到「跨网络连接」设置，实际：%q", msg)
	}

	// 开了跨网还是找不到，说明是对方没上线，别再让用户去翻设置。
	n2 := &Node{}
	n2.crossnet.Store(&crossnetState{})
	msg2 := n2.noRouteError(peer).Error()
	if strings.Contains(msg2, "跨网络连接") {
		t.Errorf("跨网已经开了，不该再让用户去配它：%q", msg2)
	}
	if !strings.Contains(msg2, "中转点") {
		t.Errorf("应当说明中转点那边也没看到对方：%q", msg2)
	}
}

func TestExplainFailuresNamesEveryPath(t *testing.T) {
	peer := &store.Peer{DeviceID: "DEV1", Name: "书房电脑"}
	fails := []attemptFailure{
		{via: viaCachedLAN, addr: "192.168.1.5:47821", err: errors.New("dial: i/o timeout")},
		{via: viaHistory, addr: "10.0.0.9:47821", err: errors.New("connect: connection refused")},
		{via: viaHolePunch, addr: "1.2.3.4:5678", err: errors.New("dial: i/o timeout")},
		{via: viaRelay, err: errors.New("中继被拒绝: 已超出今日中继流量配额")},
	}
	msg := explainFailures(peer, fails).Error()

	for _, want := range []string{"书房电脑", viaCachedLAN, viaHistory, viaHolePunch, viaRelay} {
		if !strings.Contains(msg, want) {
			t.Errorf("诊断里缺了 %q：%q", want, msg)
		}
	}
	// 底层的英文报错不该原样漏给用户——那些词他看不懂，也判断不出该做什么。
	for _, leak := range []string{"i/o timeout", "connection refused", "dial:"} {
		if strings.Contains(msg, leak) {
			t.Errorf("底层英文报错 %q 漏给用户了：%q", leak, msg)
		}
	}
}

func TestExplainFailuresMergesDuplicatePaths(t *testing.T) {
	peer := &store.Peer{DeviceID: "DEV1", Name: "平板"}
	// 一台多网卡设备会有好几个历史地址，全都失败。
	fails := make([]attemptFailure, 0, 6)
	for i := 0; i < 6; i++ {
		fails = append(fails, attemptFailure{via: viaHistory, err: errors.New("i/o timeout")})
	}
	msg := explainFailures(peer, fails).Error()
	if got := strings.Count(msg, viaHistory); got != 1 {
		t.Errorf("同一条路重复了 %d 次，应当合并成 1 次：%q", got, msg)
	}
}

func TestExplainFailuresWithNoAttempts(t *testing.T) {
	peer := &store.Peer{DeviceID: "DEV1", Name: "手机"}
	// 竞速被上层取消时可能一条失败都没收集到，不能因此产出一句空话或者 panic。
	msg := explainFailures(peer, nil).Error()
	if !strings.Contains(msg, "手机") || msg == "" {
		t.Errorf("没有任何尝试记录时也要给出一句能读的话：%q", msg)
	}
}

func TestShortReasonTranslatesCommonFailures(t *testing.T) {
	cases := []struct{ in, wantContains string }{
		{"dial tcp: connection refused", "没有在监听"},
		{"dial: i/o timeout", "超时"},
		{"context deadline exceeded", "超时"},
		{"connect: network is unreachable", "不可达"},
		{"跨网未启用", "没有配置中转点"},
		{"中继被拒绝: 配额用尽", "中转点拒绝"},
		{"握手失败: bad static key", "重新配对"},
	}
	for _, c := range cases {
		got := shortReason(errors.New(c.in))
		if !strings.Contains(got, c.wantContains) {
			t.Errorf("shortReason(%q) = %q，应当包含 %q", c.in, got, c.wantContains)
		}
	}
	if shortReason(nil) == "" {
		t.Error("shortReason(nil) 不该返回空串")
	}
}
