package test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/identity"
)

// TestStressLargeFile 验证大文件传输时内存不随文件大小增长（对应验收「20 GB 内存 < 200 MB」）。
// 本地跑 200 MiB，看内存是否恒定而非速度；单独运行：go test ./test/ -run TestStress -v，-short 跳过。
func TestStressLargeFile(t *testing.T) {
	if testing.Short() {
		t.Skip("大文件压测在 -short 模式下跳过")
	}

	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)

	const size = 200 << 20 // 200 MiB
	src := makeRandomFile(t, pc.dir, "压测.bin", size)

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	res, err := sess.SendFile(ctx, src)
	if err != nil {
		t.Fatalf("大文件传输失败: %v", err)
	}

	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	peakMB := float64(after.TotalAlloc-before.TotalAlloc) / (1 << 20)
	liveMB := float64(after.HeapAlloc) / (1 << 20)

	dst := filepath.Join(ph.dir, "downloads", "压测.bin")
	waitFile(t, dst, 2*time.Minute)
	assertSameFile(t, src, dst)

	st, _ := os.Stat(dst)
	t.Logf("压测 ✅ %d MiB / %d 块，耗时 %v，%.1f MB/s",
		size>>20, res.Chunks, res.Elapsed.Round(time.Millisecond),
		float64(size)/res.Elapsed.Seconds()/(1<<20))
	t.Logf("        落地 %d 字节，Merkle 根一致", st.Size())
	t.Logf("        传输期间常驻堆 %.1f MB（累计分配 %.0f MB）—— 与文件大小无关即为达标",
		liveMB, peakMB)

	// 常驻堆应当远小于文件大小。若实现退化成"整文件读进内存"，这里会直接爆掉。
	if liveMB > 128 {
		t.Fatalf("内存占用 %.1f MB 过高，可能有整文件缓冲", liveMB)
	}
}
