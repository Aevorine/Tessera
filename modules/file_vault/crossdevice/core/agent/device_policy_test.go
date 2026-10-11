package agent

import (
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// 每台设备的同步范围要能从界面改、改完能读回来，而且只改传了的那一项。
func TestSetDevicePolicyRoundTrip(t *testing.T) {
	a := newTestAgent(t)
	if err := a.store.PutPeer(&store.Peer{DeviceID: "phone", Name: "手机", Trust: "long"}); err != nil {
		t.Fatal(err)
	}

	res, err := a.dispatch("set_device_policy", params(t, map[string]any{
		"device_id": "phone", "clip_policy": "text",
	}))
	if err != nil {
		t.Fatalf("设置同步范围失败: %v", err)
	}
	m := res.(map[string]any)
	if m["clip_policy"] != store.ClipText || m["file_policy"] != store.FileInherit {
		t.Fatalf("回传的策略不对: clip=%v file=%v", m["clip_policy"], m["file_policy"])
	}

	// 只改收文件策略，剪贴板策略必须原样保留。
	if _, err := a.dispatch("set_device_policy", params(t, map[string]any{
		"device_id": "phone", "file_policy": "ask",
	})); err != nil {
		t.Fatal(err)
	}
	p, _ := a.store.GetPeer("phone")
	if p.ClipPolicy != store.ClipText || p.FilePolicy != store.FileAsk {
		t.Fatalf("改一项把另一项冲掉了: %+v", p)
	}

	// 列表里也要带上，界面靠它显示当前选中的那一档。
	for _, d := range a.devices() {
		if d["device_id"] == "phone" && d["clip_policy"] != store.ClipText {
			t.Fatalf("设备列表里没带同步范围: %v", d)
		}
	}

	if _, err := a.dispatch("set_device_policy", params(t, map[string]any{
		"device_id": "nobody", "clip_policy": "off",
	})); err == nil {
		t.Fatal("不存在的设备应当报错")
	}
}

// 设备自己的收文件策略压过全局开关；跟随全局时临时设备一律要问。
func TestPerDeviceFilePolicyOverridesGlobal(t *testing.T) {
	a := newTestAgent(t)
	now := time.Now()
	peers := []*store.Peer{
		{DeviceID: "long", Trust: "long"},
		{DeviceID: "temp", Trust: "temp", ExpiresAt: now.Add(time.Hour)},
		{DeviceID: "ask", Trust: "long", FilePolicy: store.FileAsk},
		{DeviceID: "auto", Trust: "temp", ExpiresAt: now.Add(time.Hour), FilePolicy: store.FileAuto},
		{DeviceID: "gone", Trust: "long", FilePolicy: store.FileAuto, Revoked: true},
	}
	for _, p := range peers {
		if err := a.store.PutPeer(p); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		global bool
		want   map[string]bool
	}{
		{true, map[string]bool{"long": true, "temp": false, "ask": false, "auto": true, "gone": false, "unknown": false}},
		{false, map[string]bool{"long": false, "temp": false, "ask": false, "auto": true, "gone": false, "unknown": false}},
	}
	for _, c := range cases {
		a.autoAccept.Store(c.global)
		for id, want := range c.want {
			if got := a.shouldAutoAccept(id); got != want {
				t.Errorf("全局自动接收=%v 时 %s: 得到 %v，应为 %v", c.global, id, got, want)
			}
		}
	}
}
