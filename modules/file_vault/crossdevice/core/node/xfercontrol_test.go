package node

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Gate 是整个暂停功能的核心：它决定发送循环是继续、是等着、还是退出。
// 四个出口少任何一个，对应场景下的表现都是"传输卡住但没有任何报错"。

func TestGatePassesWhenRunning(t *testing.T) {
	c := newXferCtl("id", "dev", "Dev", "send", "a.txt", "file", 10)
	if err := c.Gate(context.Background(), make(chan struct{})); err != nil {
		t.Fatalf("没暂停时 Gate 不该拦住：%v", err)
	}
}

func TestGateBlocksUntilResume(t *testing.T) {
	c := newXferCtl("id", "dev", "Dev", "send", "a.txt", "file", 10)
	if !c.Pause() {
		t.Fatal("第一次 Pause 应当改变状态")
	}
	if c.Pause() {
		t.Fatal("重复 Pause 不该再报「变了」——否则界面会重复推送同一条状态")
	}

	passed := make(chan error, 1)
	go func() { passed <- c.Gate(context.Background(), make(chan struct{})) }()

	select {
	case <-passed:
		t.Fatal("暂停中 Gate 必须阻塞")
	case <-time.After(80 * time.Millisecond):
	}

	if !c.Resume() {
		t.Fatal("Resume 应当改变状态")
	}
	select {
	case err := <-passed:
		if err != nil {
			t.Fatalf("继续之后 Gate 应当放行：%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Resume 之后 Gate 没有被唤醒")
	}
}

// 「先暂停、再决定不要了」是最自然的操作顺序。取消如果唤不醒暂停中的 Gate，
// 用户按下取消之后那条传输会永远挂着，界面上删也删不掉。
func TestCancelWakesPausedGate(t *testing.T) {
	c := newXferCtl("id", "dev", "Dev", "send", "a.txt", "file", 10)
	c.Pause()

	got := make(chan error, 1)
	go func() { got <- c.Gate(context.Background(), make(chan struct{})) }()

	time.Sleep(30 * time.Millisecond)
	if !c.Cancel() {
		t.Fatal("Cancel 应当改变状态")
	}
	select {
	case err := <-got:
		if !errors.Is(err, ErrTransferCanceled) {
			t.Fatalf("暂停中被取消，Gate 应当返回 ErrTransferCanceled，实际 %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消没有唤醒暂停中的 Gate")
	}
}

func TestGateExitsOnSessionClose(t *testing.T) {
	c := newXferCtl("id", "dev", "Dev", "send", "a.txt", "file", 10)
	c.Pause()
	done := make(chan struct{})

	got := make(chan error, 1)
	go func() { got <- c.Gate(context.Background(), done) }()

	time.Sleep(30 * time.Millisecond)
	close(done) // 对端掉线
	select {
	case err := <-got:
		if err == nil {
			t.Fatal("连接断开时 Gate 必须返回错误，否则这个 goroutine 永远挂着")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("连接断开没有唤醒暂停中的 Gate")
	}
}

func TestGateExitsOnContextCancel(t *testing.T) {
	c := newXferCtl("id", "dev", "Dev", "send", "a.txt", "file", 10)
	c.Pause()
	ctx, cancel := context.WithCancel(context.Background())

	got := make(chan error, 1)
	go func() { got <- c.Gate(ctx, make(chan struct{})) }()

	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case err := <-got:
		if err == nil {
			t.Fatal("上下文取消时 Gate 必须返回错误")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("上下文取消没有唤醒暂停中的 Gate")
	}
}

// 已取消的传输不能再被暂停/继续折腾出别的状态——那会让界面显示成
// 「已取消」但按钮却是「继续」。
func TestCanceledIsTerminal(t *testing.T) {
	c := newXferCtl("id", "dev", "Dev", "send", "a.txt", "file", 10)
	c.Cancel()
	if c.Pause() || c.Resume() {
		t.Fatal("已取消的传输不该再改变状态")
	}
	if c.Cancel() {
		t.Fatal("重复取消不该再报「变了」")
	}
	if got := c.info().State; got != XferCanceled {
		t.Fatalf("状态应当是 %s，实际 %s", XferCanceled, got)
	}
}

func TestRegistryListAndCancelForDevice(t *testing.T) {
	r := newXferRegistry()
	r.add(newXferCtl("a", "dev1", "D1", "send", "1.txt", "file", 1))
	r.add(newXferCtl("b", "dev1", "D1", "recv", "2.txt", "file", 1))
	r.add(newXferCtl("c", "dev2", "D2", "send", "3.txt", "file", 1))

	if len(r.list()) != 3 {
		t.Fatalf("注册表应当有 3 条，实际 %d", len(r.list()))
	}
	hit := r.cancelAllFor("dev1")
	if len(hit) != 2 {
		t.Fatalf("撤销 dev1 应当命中 2 条，实际 %d", len(hit))
	}
	if c, _ := r.get("c"); c.Canceled() {
		t.Fatal("不该动到别的设备的传输")
	}
}

// 接收方取消后，Session 已经丢掉 receiver 和 .cbpart，但 Node 的注册表也必须
// 同步摘掉控制块。否则页面重新打开时 active_transfers 会把已取消任务重新画回来。
func TestCanceledReceiverIsRemovedFromRegistry(t *testing.T) {
	r := newXferRegistry()
	recv := newXferCtl("recv", "dev", "D", "recv", "a.txt", "file", 1)
	r.add(recv)
	if !recv.Cancel() {
		t.Fatal("第一次取消应当改变状态")
	}
	r.remove(recv.id)
	if _, ok := r.get(recv.id); ok {
		t.Fatal("已取消的接收任务不应继续出现在 active_transfers 注册表")
	}
}

// 传文件夹时清单里是多级相对路径。把整条路径当文件名显示，界面上就是一行
// 被截断成看不出是什么的字符——用户要认的是最后那一段。
func TestDisplayNameOf(t *testing.T) {
	cases := map[string]string{
		"a.txt":                "a.txt",
		"报告/图表/第一章.png":        "第一章.png",
		"报告\\图表\\第一章.png":      "第一章.png",
		"folder/sub/":          "sub",
		"":                     "",
		"/leading/slash/x.bin": "x.bin",
	}
	for in, want := range cases {
		if got := displayNameOf(in); got != want {
			t.Errorf("displayNameOf(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestKindOfTransfer(t *testing.T) {
	cases := []struct{ offerKind, rel, want string }{
		{"file", "a.txt", "file"},
		{"file", "photo.JPG", "image"},
		{"file", "图.png", "image"},
		{"file", "Tessera.apk", "app"},
		{"file", "setup.exe", "app"},
		// 文件夹以发送端声明的为准：只有它知道用户选的是不是目录。
		{"folder", "报告/图表/第一章.png", "folder"},
	}
	for _, c := range cases {
		if got := kindOfTransfer(c.offerKind, c.rel); got != c.want {
			t.Errorf("kindOfTransfer(%q, %q) = %q，期望 %q", c.offerKind, c.rel, got, c.want)
		}
	}
}
