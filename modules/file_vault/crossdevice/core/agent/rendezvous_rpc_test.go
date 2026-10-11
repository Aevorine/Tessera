package agent

import (
	"strings"
	"testing"
)

// TestRendezvousSettingsRoundTrip 确认跨网设置存得下、读得回、且改一项不冲掉另一项。
func TestRendezvousSettingsRoundTrip(t *testing.T) {
	a := newTestAgent(t)

	// 默认必须是关闭的：不配汇合点就一个包都不该打到公网上去。
	got, err := a.dispatch("set_options", params(t, map[string]any{}))
	if err != nil {
		t.Fatalf("读设置失败: %v", err)
	}
	m := got.(map[string]any)
	if m["rendezvous_addr"] != "" {
		t.Errorf("跨网默认应当是关闭的，实际 rendezvous_addr = %v", m["rendezvous_addr"])
	}
	if m["rendezvous_secret_set"] != false {
		t.Errorf("默认不该有口令，实际 %v", m["rendezvous_secret_set"])
	}

	if _, err := a.dispatch("set_options", params(t, map[string]any{
		"rendezvous_addr":   "rv.example.com:47820",
		"rendezvous_secret": "我的口令",
	})); err != nil {
		t.Fatalf("设置汇合点失败: %v", err)
	}
	opts := a.store.Options()
	if opts.RendezvousAddr != "rv.example.com:47820" {
		t.Errorf("汇合点地址没存下来: %q", opts.RendezvousAddr)
	}
	if opts.RendezvousSecret != "我的口令" {
		t.Errorf("汇合点口令没存下来: %q", opts.RendezvousSecret)
	}

	// 口令绝不能明文回传给界面：那只会多出一份可能被日志、截图、
	// 剪贴板带走的副本。只回传"设没设过"。
	res, err := a.dispatch("set_options", params(t, map[string]any{}))
	if err != nil {
		t.Fatalf("读回设置失败: %v", err)
	}
	m = res.(map[string]any)
	if m["rendezvous_secret_set"] != true {
		t.Errorf("应当报告口令已设置，实际 %v", m["rendezvous_secret_set"])
	}
	for k, v := range m {
		if s, ok := v.(string); ok && strings.Contains(s, "我的口令") {
			t.Errorf("口令明文被回传给界面了，字段 %s = %q", k, s)
		}
	}

	// 只改剪贴板开关，不能把汇合点设置清空——界面往往只提交改动的那一项。
	if _, err := a.dispatch("set_options", params(t, map[string]any{"clip_sync": false})); err != nil {
		t.Fatalf("改剪贴板开关失败: %v", err)
	}
	opts = a.store.Options()
	if opts.RendezvousAddr != "rv.example.com:47820" || opts.RendezvousSecret != "我的口令" {
		t.Errorf("改别的设置把跨网配置冲掉了：addr=%q secretSet=%v",
			opts.RendezvousAddr, opts.RendezvousSecret != "")
	}

	// 显式传空串是"关掉跨网"，必须生效。
	if _, err := a.dispatch("set_options", params(t, map[string]any{"rendezvous_addr": ""})); err != nil {
		t.Fatalf("关闭跨网失败: %v", err)
	}
	if a.store.Options().RendezvousAddr != "" {
		t.Errorf("传空串没能关掉跨网: %q", a.store.Options().RendezvousAddr)
	}
}

// TestRendezvousAddrValidation 确认填错的地址当场被挡，否则用户以为配好了，对着永远连不上的跨网却没
// 有任何错误提示。
func TestRendezvousAddrValidation(t *testing.T) {
	bad := []struct{ addr, why string }{
		{"rv.example.com", "少了端口"},
		{"rv.example.com:", "端口是空的"},
		{":47820", "少了域名"},
		{"rv.example.com:abc", "端口不是数字"},
		{"rv.example.com:0", "端口 0 不可用"},
		{"rv.example.com:70000", "端口超出 65535"},
		{"http://rv.example.com:47820", "带了协议前缀"},
	}
	for _, c := range bad {
		a := newTestAgent(t)
		if _, err := a.dispatch("set_options", params(t, map[string]any{"rendezvous_addr": c.addr})); err == nil {
			t.Errorf("%q（%s）应当被拒绝，却接受了", c.addr, c.why)
		} else if !strings.Contains(err.Error(), "汇合点") {
			t.Errorf("%q 的报错没说清是汇合点地址的问题: %v", c.addr, err)
		}
		if a.store.Options().RendezvousAddr != "" {
			t.Errorf("%q 被拒绝之后不该被存下来", c.addr)
		}
	}

	good := []string{"rv.example.com:47820", "1.2.3.4:47820", "[2001:db8::1]:47820"}
	for _, addr := range good {
		a := newTestAgent(t)
		if _, err := a.dispatch("set_options", params(t, map[string]any{"rendezvous_addr": addr})); err != nil {
			t.Errorf("%q 是合法地址，却被拒绝: %v", addr, err)
		}
	}
}
