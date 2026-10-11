package agent

import (
	"testing"
)

// 改一个设置不能顺手抹掉另一个。SetOptions 是整体替换（s.d.Options = o），
// set_options 曾构造只带三个字段的新结构体，致 DeviceName 被清零且随心跳同步给所有设备，全程无报错
// ；
// 这类 bug 只能靠断言"别的字段没被动过"来挡。
func TestChangingOneOptionKeepsTheOthers(t *testing.T) {
	a := newTestAgent(t)

	if _, err := a.dispatch("set_device_name", params(t, map[string]any{"name": "书房电脑"})); err != nil {
		t.Fatalf("改设备名失败: %v", err)
	}
	if got := a.store.Options().DeviceName; got != "书房电脑" {
		t.Fatalf("设备名没存下来: %q", got)
	}

	dir := t.TempDir()
	if _, err := a.dispatch("set_options", params(t, map[string]any{
		"download_dir": dir,
		"clip_sync":    false,
	})); err != nil {
		t.Fatalf("改选项失败: %v", err)
	}

	opts := a.store.Options()
	if opts.DeviceName != "书房电脑" {
		t.Errorf("改接收目录把设备名冲掉了：现在是 %q", opts.DeviceName)
	}
	if opts.DownloadDir != dir {
		t.Errorf("接收目录没存进去: %q", opts.DownloadDir)
	}
	if opts.ClipSync == nil || *opts.ClipSync {
		t.Errorf("剪贴板开关没关掉: %v", opts.ClipSync)
	}

	// 反过来也要成立：改完选项之后再改名字，不能把刚设好的目录冲掉。
	if _, err := a.dispatch("set_device_name", params(t, map[string]any{"name": "客厅电脑"})); err != nil {
		t.Fatalf("再次改名失败: %v", err)
	}
	opts = a.store.Options()
	if opts.DownloadDir != dir {
		t.Errorf("改名把接收目录冲掉了：现在是 %q", opts.DownloadDir)
	}
	if opts.ClipSync == nil || *opts.ClipSync {
		t.Errorf("改名把剪贴板开关冲回默认了: %v", opts.ClipSync)
	}
}
