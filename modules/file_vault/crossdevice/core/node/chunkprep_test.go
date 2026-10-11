package node

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/transfer"
)

// 备料 goroutine 有三个独立出口：plan 走完、备料出错/取消、调用方提前 close(stop)。
// 漏任何一个都不报错，只会卡死或泄漏 goroutine，所以每个出口一条测试。

const testChunk = 1 << 20 // 1 MiB = MinChunkSize，够切出多块又不至于让测试很慢

func newTestSender(t *testing.T, chunks int) (*transfer.FileSender, []byte) {
	t.Helper()
	// 每块填不同的字节，这样"第 i 块的内容对不对"是可判的。
	payload := make([]byte, chunks*testChunk)
	for i := range payload {
		payload[i] = byte(i / testChunk)
	}
	path := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}
	snd, err := transfer.OpenSender(path, testChunk)
	if err != nil {
		t.Fatalf("OpenSender 失败: %v", err)
	}
	t.Cleanup(func() { _ = snd.Close() })
	return snd, payload
}

func drain(t *testing.T, ch <-chan preparedChunk) ([]preparedChunk, bool) {
	t.Helper()
	var got []preparedChunk
	for {
		select {
		case pc, ok := <-ch:
			if !ok {
				return got, true // channel 关闭了 = 备料 goroutine 已退出
			}
			got = append(got, pc)
		case <-time.After(5 * time.Second):
			t.Fatal("备料 channel 既没出料也没关闭——goroutine 挂住了")
			return nil, false
		}
	}
}

// 正常出口：按 plan 的顺序产出，一块不多一块不少，且内容就是对应块的内容。
// 顺序这条特别重要——流水线化的全部前提就是"顺序没变"。
func TestChunkPrepEmitsPlanOrder(t *testing.T) {
	snd, payload := newTestSender(t, 4)
	stop := make(chan struct{})
	defer close(stop)

	plan := []int{0, 1, 2, 3}
	ch := startChunkPrep(context.Background(), chunkPrepParams{
		plan: plan, snd: snd, chunkSize: testChunk, tid: []byte("tid"),
		ctl:  newXferCtl("k", "dev", "手机", "send", "payload.bin", "file", snd.Size()),
		stop: stop,
	})

	got, closed := drain(t, ch)
	if !closed {
		t.Fatal("备料结束后 channel 应当关闭")
	}
	if len(got) != len(plan) {
		t.Fatalf("产出 %d 块，期望 %d 块", len(got), len(plan))
	}
	for i, pc := range got {
		if pc.err != nil {
			t.Fatalf("第 %d 块意外出错: %v", i, pc.err)
		}
		h, data, err := splitChunkFrame(pc.frame)
		if err != nil {
			t.Fatalf("第 %d 块帧解析失败: %v", i, err)
		}
		if h.ChunkIndex != plan[i] {
			t.Fatalf("第 %d 个产出的是块 %d，期望块 %d——顺序变了", i, h.ChunkIndex, plan[i])
		}
		want := payload[plan[i]*testChunk : (plan[i]+1)*testChunk]
		if !bytes.Equal(data, want) {
			t.Fatalf("块 %d 内容不对", plan[i])
		}
	}
}

// plan 不是从 0 开始的连续序列时（续传只补缺的块）也必须照 plan 走。
func TestChunkPrepHonoursSparsePlan(t *testing.T) {
	snd, _ := newTestSender(t, 4)
	stop := make(chan struct{})
	defer close(stop)

	plan := []int{3, 1}
	ch := startChunkPrep(context.Background(), chunkPrepParams{
		plan: plan, snd: snd, chunkSize: testChunk, tid: []byte("tid"),
		ctl:  newXferCtl("k", "dev", "手机", "send", "payload.bin", "file", snd.Size()),
		stop: stop,
	})

	got, _ := drain(t, ch)
	if len(got) != 2 {
		t.Fatalf("产出 %d 块，期望 2 块", len(got))
	}
	for i, want := range plan {
		h, _, err := splitChunkFrame(got[i].frame)
		if err != nil {
			t.Fatalf("帧解析失败: %v", err)
		}
		if h.ChunkIndex != want {
			t.Fatalf("第 %d 个产出的是块 %d，期望块 %d", i, h.ChunkIndex, want)
		}
	}
}

// 取消出口：错误必须**送出去**而不是让 channel 静静关掉。发送循环靠这个错误
// 才知道要通知对端清残片；只关不送的话它会以为一切正常传完了。
func TestChunkPrepForwardsCancel(t *testing.T) {
	snd, _ := newTestSender(t, 4)
	stop := make(chan struct{})
	defer close(stop)

	ctl := newXferCtl("k", "dev", "手机", "send", "payload.bin", "file", snd.Size())
	ctl.Cancel()

	ch := startChunkPrep(context.Background(), chunkPrepParams{
		plan: []int{0, 1, 2, 3}, snd: snd, chunkSize: testChunk, tid: []byte("tid"),
		ctl: ctl, stop: stop,
	})

	got, closed := drain(t, ch)
	if !closed {
		t.Fatal("取消之后 channel 应当关闭")
	}
	if len(got) != 1 || got[0].err == nil {
		t.Fatalf("期望恰好一条错误产出，实际 %d 条", len(got))
	}
	if !errors.Is(got[0].err, ErrTransferCanceled) {
		t.Fatalf("错误应当是 ErrTransferCanceled，实际是 %v", got[0].err)
	}
}

// stop 出口：调用方提前退出（比如写网络失败）时，备料 goroutine 必须跟着结束。
// 它这时多半正阻塞在往满了的 channel 里送料上——只看 ctx 是醒不过来的。
func TestChunkPrepStopsWhenCallerLeaves(t *testing.T) {
	snd, _ := newTestSender(t, 8)
	stop := make(chan struct{})

	ch := startChunkPrep(context.Background(), chunkPrepParams{
		plan: []int{0, 1, 2, 3, 4, 5, 6, 7}, snd: snd, chunkSize: testChunk, tid: []byte("tid"),
		ctl:  newXferCtl("k", "dev", "手机", "send", "payload.bin", "file", snd.Size()),
		stop: stop,
	})

	// 只取一块就走人，剩下的把缓冲塞满，备料 goroutine 会卡在 emit 上。
	if pc := <-ch; pc.err != nil {
		t.Fatalf("第一块不该出错: %v", pc.err)
	}
	close(stop)

	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return // channel 关闭 = goroutine 已退出，正是要验的
			}
		case <-deadline:
			t.Fatal("close(stop) 之后备料 goroutine 没有退出——泄漏了")
		}
	}
}
