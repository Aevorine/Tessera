package agent

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

// 这几条锁的是「附近的设备一直是空的」那条修复链上，最容易悄悄退化的几个点。

func newTestAgent(t *testing.T) *Agent {
	t.Helper()
	var mu sync.Mutex
	sink := func(string) { mu.Lock(); mu.Unlock() }
	a, err := New(Config{DataDir: t.TempDir(), Name: "测试机", Addr: "127.0.0.1:0", Sink: sink})
	if err != nil {
		t.Fatalf("节点起不来: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func params(t *testing.T, v map[string]any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("参数编码失败: %v", err)
	}
	return b
}

func TestLocalEndpointsIsAlwaysAList(t *testing.T) {
	// 界面把它当"念给对方的地址"用。nil 会编码成 JSON null，前端 `.map` 会炸，而这是自动发现全败时的兜
	// 底。
	a := newTestAgent(t)
	res, err := a.dispatch("local_endpoints", nil)
	if err != nil {
		t.Fatalf("local_endpoints 不该报错: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("返回结构不对: %T", res)
	}
	eps, ok := m["endpoints"].([]string)
	if !ok {
		t.Fatalf("endpoints 必须是字符串数组，实际 %T", m["endpoints"])
	}
	if eps == nil {
		t.Fatal("endpoints 不许是 nil，空也要给一个空数组")
	}
	// 绑到 127.0.0.1 的测试节点必须公布这一个地址，而不是回环之外的网卡。
	if len(eps) != 1 || !strings.HasPrefix(eps[0], "127.0.0.1:") {
		t.Fatalf("绑定到具体 IP 时只该公布那个 IP，实际 %v", eps)
	}
}

func TestPairNearbyFallsBackToTheCallerSuppliedAddress(t *testing.T) {
	// 扫描发现的设备不在 mDNS 缓存（DiscoveredPeers）里，只查缓存会"扫描能看到、点配对说不在了"。
	// 这里给必然连不上的地址：只要错误不是"已经不在附近了"，就说明调用方给的地址被采纳并走到了拨号。
	a := newTestAgent(t)
	_, err := a.dispatch("pair_nearby", params(t, map[string]any{
		"device_id": "ghost-device",
		"address":   "127.0.0.1:1", // 端口 1 上不会有 QUIC 服务
	}))
	if err == nil {
		t.Fatal("连一个不存在的服务不该成功")
	}
	if strings.Contains(err.Error(), "不在附近") {
		t.Fatalf("调用方给了地址却仍被判成设备不在，说明回落没生效: %v", err)
	}
}

func TestPairNearbyStillRefusesWhenItHasNoAddressAtAll(t *testing.T) {
	// 没有地址就是真的没法连。这时候要明确说"不在附近了，刷新重试"，
	// 而不是拿一个空地址去拨号然后报一句看不懂的网络错误。
	a := newTestAgent(t)
	_, err := a.dispatch("pair_nearby", params(t, map[string]any{"device_id": "ghost-device"}))
	if err == nil || !strings.Contains(err.Error(), "不在附近") {
		t.Fatalf("应当明确回「设备不在附近」，实际: %v", err)
	}
}

func TestDiagnoseAlwaysReportsListeningFirst(t *testing.T) {
	// 监听没起来时后面几项全是误导性的结论，所以它必须排第一。
	a := newTestAgent(t)
	res, err := a.dispatch("net_diagnose", nil)
	if err != nil {
		t.Fatalf("net_diagnose 不该报错: %v", err)
	}
	m := res.(map[string]any)
	checks, ok := m["checks"].([]map[string]any)
	if !ok || len(checks) == 0 {
		t.Fatalf("checks 必须是非空数组，实际 %T", m["checks"])
	}
	if checks[0]["id"] != "listening" {
		t.Fatalf("第一项必须是 listening，实际 %v", checks[0]["id"])
	}
	if checks[0]["status"] != "ok" {
		t.Fatalf("测试节点确实在监听，这项应当是 ok，实际 %v", checks[0]["status"])
	}
}

func TestLanScanAlwaysReturnsAListEvenWhenNothingIsFound(t *testing.T) {
	// 同 local_endpoints：界面对结果做 .map，null 会炸。而"一台都没扫到"
	// 恰恰是这个功能最常见的结果——它就是拿来诊断"确实没有设备"的。
	a := newTestAgent(t)
	res, err := a.dispatch("lan_scan", nil)
	if err != nil {
		t.Fatalf("lan_scan 不该报错: %v", err)
	}
	m := res.(map[string]any)
	if _, ok := m["nearby"].([]map[string]any); !ok {
		t.Fatalf("nearby 必须是数组，实际 %T", m["nearby"])
	}
	if _, ok := m["probed"].(int); !ok {
		t.Fatalf("probed 必须有，界面要显示探测了几个地址，实际 %T", m["probed"])
	}
}
