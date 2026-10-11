package test

// 剪贴板大图收完后，界面「剪贴板图片 100%」行必须消失，对端「接着刚才」提示条
// 也不能把已传完的传输当作未完成。

import (
	"bytes"
	"context"
	"crypto/rand"
	"path/filepath"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
)

// waitXferEnded 等某个节点发出一条指定方向的 xfer_state=ended。
func waitXferEnded(tn *testNode, direction, kind string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, e := range tn.events() {
			if e.Kind == "xfer_state" && e.Msg == node.XferEnded && e.Xfer != nil &&
				e.Xfer.Direction == direction && e.Xfer.Kind == kind {
				return true
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// TestA3g_ClipImageReceiverReportsEnded：接收端收完剪贴板大图后必须发 ended，
// 并且注册表里不能再留着这条传输。
func TestA3g_ClipImageReceiverReportsEnded(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "荣耀手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	img := make([]byte, 2<<20)
	if _, err := rand.Read(img); err != nil {
		t.Fatal(err)
	}
	copy(img, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})

	it, err := pc.LocalCopy(clipboard.MimePNG, []clipboard.Rep{{Mime: clipboard.MimePNG, Data: img}})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatalf("A3g 失败：广播出错 %v", errs)
	}
	items := ph.waitClip(1, 30*time.Second)
	rep, ok := items[0].Rep(clipboard.MimePNG)
	if !ok || !bytes.Equal(rep.Data, img) {
		t.Fatal("A3g 失败：手机没有完整收到这张图")
	}

	// 手机确实报告过接收进度（界面上才会出现那一行）……
	sawRecv := false
	for _, p := range ph.progress() {
		if p.Kind == "clip" && p.Direction == "recv" {
			sawRecv = true
		}
	}
	if !sawRecv {
		t.Fatal("A3g 失败：接收端没有上报剪贴板接收进度，前提不成立")
	}
	// ……那就必须在收完之后告诉界面这一行可以拿掉了。
	if !waitXferEnded(ph, "recv", "clip", 3*time.Second) {
		t.Fatal("A3g 失败：接收端收完剪贴板大图后没有发 xfer_state=ended，界面上的「剪贴板图片 100%」会永远留着")
	}
	if left := ph.ActiveTransfers(); len(left) != 0 {
		t.Fatalf("A3g 失败：收完之后注册表里还留着 %d 条传输", len(left))
	}
	// 发送端本来就会发（sendClipFile 的 defer），这里一并钉住，防止以后被改坏。
	if !waitXferEnded(pc, "send", "clip", 3*time.Second) {
		t.Fatal("A3g 失败：发送端没有发 xfer_state=ended")
	}
}

// TestA3h_ContinuityFollowsTheRealTransfer：手机播报「正在传 X」，电脑只在那条传输
// 真的还在进行时显示；传输一结束，核心自己收回——不靠界面记得发 none。
func TestA3h_ContinuityFollowsTheRealTransfer(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "荣耀手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, ph, pc)

	// 用够大的文件并在出现时暂停发送端，让传输稳定停在「进行中」以取得真实 transfer_id。
	// 不能卡住电脑端「是否接收」回调：它跑在会话读循环上，卡住会收不到提示帧。
	src := makeRandomFile(t, ph.dir, "报告.bin", 96<<20)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	sendDone := make(chan error, 1)
	go func() {
		_, err := sess.SendFile(ctx, src)
		sendDone <- err
	}()

	var id string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if act := ph.ActiveTransfers(); len(act) == 1 {
			id = act[0].ID
			break
		}
	}
	if id == "" {
		t.Fatal("A3h 失败：手机上没有出现进行中的传输，前提不成立")
	}
	if err := ph.PauseTransfer(id); err != nil {
		t.Fatalf("A3h 失败：暂停传输出错 %v", err)
	}

	waitCount := func(want int) []node.ContinuityItem {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			got := pc.Continuities()
			if len(got) == want || time.Now().After(deadline) {
				return got
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	// 进行中：应当显示。
	ph.SetContinuity("transfer", "报告.bin", id, 40)
	if got := waitCount(1); len(got) != 1 || got[0].Progress != 40 {
		t.Fatalf("A3h 失败：进行中的传输没有出现在对端提示里：%+v", got)
	}

	// 一条根本不存在（或者已经结束）的传输：迟到的进度事件、剪贴板内部推送都是这个形状。
	// 不能被当成"还有一件没做完"，并且要把上一条真实的播报顶掉而不是并存。
	ph.SetContinuity("transfer", "剪贴板图片", "not-a-live-transfer", 55)
	if got := waitCount(0); len(got) != 0 {
		t.Fatalf("A3h 失败：不存在的传输被当成没做完的事：%+v", got)
	}

	// 再次播报真实的那条，然后让传输自然结束。接下来**不再**调用任何 SetContinuity：
	// 对端的提示必须由核心自己撤掉。
	ph.SetContinuity("transfer", "报告.bin", id, 40)
	if got := waitCount(1); len(got) != 1 {
		t.Fatalf("A3h 失败：真实传输的播报没有恢复显示：%+v", got)
	}
	if err := ph.ResumeTransfer(id); err != nil {
		t.Fatalf("A3h 失败：继续传输出错 %v", err)
	}
	select {
	case err := <-sendDone:
		if err != nil {
			t.Fatalf("A3h 失败：传输本身出错 %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("A3h 失败：传输没有结束")
	}
	waitFile(t, filepath.Join(pc.dir, "downloads", "报告.bin"), 10*time.Second)
	if got := waitCount(0); len(got) != 0 {
		t.Fatalf("A3h 失败：传输已经结束，对端仍显示「还有一件没做完」：%+v", got)
	}
}
