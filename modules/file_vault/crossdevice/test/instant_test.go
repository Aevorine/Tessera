package test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/identity"
)

// 秒传：同一个文件发第二遍时应当 0 字节完成，而不是再走一遍网络。
func TestInstantTransferSkipsAnIdenticalFile(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)

	const size = 12 << 20 // 3 个 4 MiB 块
	src := makeRandomFile(t, pc.dir, "包.apk", size)
	dst := filepath.Join(ph.dir, "downloads", "包.apk")

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	first, err := sess.SendFile(ctx, src)
	if err != nil {
		t.Fatalf("第一次发送失败: %v", err)
	}
	if first.Skipped {
		t.Fatal("第一次就秒传了——对方本来什么都没有")
	}
	if first.SentChunks == 0 {
		t.Fatal("第一次一块都没发")
	}
	waitFile(t, dst, 30*time.Second)
	assertSameFile(t, src, dst)

	// 第二遍：内容一模一样，应当整份跳过。
	second, err := sess.SendFile(ctx, src)
	if err != nil {
		t.Fatalf("第二次发送失败: %v", err)
	}
	if !second.Skipped {
		t.Errorf("第二次没有秒传：实际发了 %d/%d 块", second.SentChunks, second.Chunks)
	}
	if second.SentChunks != 0 {
		t.Errorf("秒传却发了 %d 块", second.SentChunks)
	}
	// 进度必须走到 100%，否则界面上会留一条永远停在 0% 的记录。
	if second.Size != int64(size) || second.Chunks != first.Chunks {
		t.Errorf("秒传的结果没有如实报告大小/块数: %+v", second)
	}

	// 关键：秒传不能在对方那里多留一份副本。
	extra := filepath.Join(ph.dir, "downloads", "包 (1).apk")
	if _, err := os.Stat(extra); err == nil {
		t.Errorf("秒传却又落了一份 %s", extra)
	}
	// 也不能留下 .cbpart / .cbstate：秒传这条路根本不该开接收器。
	for _, junk := range []string{dst + ".cbpart", dst + ".cbstate"} {
		if _, err := os.Stat(junk); err == nil {
			t.Errorf("秒传却创建了 %s", junk)
		}
	}
}

// 秒传通知绝不能带落地路径：上层以 Path 非空判定收完新文件（kind=recv_done），
// 安卓据此投递到保存目录，秒传带 Path 会导致每传一次就复制一份。
func TestInstantTransferTellsNobodyAFileArrived(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)

	src := makeRandomFile(t, pc.dir, "重复.bin", 5<<20)
	dst := filepath.Join(ph.dir, "downloads", "重复.bin")

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if _, err := sess.SendFile(ctx, src); err != nil {
		t.Fatalf("第一次发送失败: %v", err)
	}
	waitFile(t, dst, 30*time.Second)

	ph.resetEvents()
	res, err := sess.SendFile(ctx, src)
	if err != nil {
		t.Fatalf("第二次发送失败: %v", err)
	}
	if !res.Skipped {
		t.Fatal("第二次没有秒传")
	}
	for _, e := range ph.events() {
		if e.Kind == "transfer" && e.Path != "" {
			t.Errorf("秒传的事件带了落地路径 %q——安卓会把已有文件再投递一次", e.Path)
		}
	}
}

// 同名、同长度、**不同内容**时绝不能跳过——那会直接造成数据丢失：
// 用户以为新版本传过去了，对方手上还是旧的。
func TestInstantTransferDoesNotSkipDifferentContent(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)

	const size = 6 << 20
	first := makeRandomFile(t, pc.dir, "同名.bin", size)
	dst := filepath.Join(ph.dir, "downloads", "同名.bin")

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if _, err := sess.SendFile(ctx, first); err != nil {
		t.Fatalf("第一次发送失败: %v", err)
	}
	waitFile(t, dst, 30*time.Second)

	// 换一份同样长度、内容不同的文件，用同一个文件名再发。
	second := makeRandomFile(t, filepath.Join(pc.dir, "v2"), "同名.bin", size)
	res, err := sess.SendFile(ctx, second)
	if err != nil {
		t.Fatalf("第二次发送失败: %v", err)
	}
	if res.Skipped {
		t.Fatal("内容不同却秒传了——对方会一直拿着旧文件，而界面报的是成功")
	}
	if res.SentChunks == 0 {
		t.Fatal("内容不同却一块都没发")
	}
	// 不覆盖，落成改名后的那一份。
	renamed := filepath.Join(ph.dir, "downloads", "同名 (1).bin")
	waitFile(t, renamed, 30*time.Second)
	assertSameFile(t, second, renamed)
	// 原来那份必须还在，且仍是第一份的内容。
	assertSameFile(t, first, dst)
}
