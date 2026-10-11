package transfer

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// 模拟真实收发路径：发送端 DigestFile，接收端 OpenReceiver(leaves=nil, root)
func roundTrip(t *testing.T, size int64, chunkSize int) {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	data := make([]byte, size)
	rand.Read(data)
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatal(err)
	}

	snd, err := OpenSender(src, chunkSize)
	if err != nil {
		t.Fatal(err)
	}
	defer snd.Close()

	dst := filepath.Join(dir, "out", "dst.bin")
	rx, err := OpenReceiver(dst, snd.Size(), chunkSize, nil, snd.Root())
	if err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, chunkSize)
	for i := 0; i < snd.ChunkCount(); i++ {
		chunk, err := snd.ReadChunk(i, buf)
		if err != nil {
			t.Fatal(err)
		}
		if err := rx.WriteChunk(i, chunk); err != nil {
			t.Fatalf("size=%d chunk=%d WriteChunk: %v", size, i, err)
		}
	}
	if err := rx.Finish(); err != nil {
		t.Fatalf("size=%d chunkSize=%d Finish: %v", size, chunkSize, err)
	}
	got, err := os.ReadFile(rx.FinalPath())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("size=%d 内容不一致", size)
	}
}

func TestRoundTripSizes(t *testing.T) {
	const cs = 64 << 10
	for _, size := range []int64{
		0, 1, cs - 1, cs, cs + 1,
		2 * cs, 2*cs + 7,
		3 * cs, 5 * cs, 11 * cs, 11*cs + 123,
	} {
		t.Run(fmt.Sprint(size), func(t *testing.T) { roundTrip(t, size, cs) })
	}
}

// 关键场景：ChunkCount 与 DigestFile 产出的叶子数必须一致
func TestChunkCountMatchesLeaves(t *testing.T) {
	const cs = 4096
	dir := t.TempDir()
	for _, size := range []int64{0, 1, cs - 1, cs, cs + 1, 3 * cs, 3*cs + 1} {
		p := filepath.Join(dir, fmt.Sprintf("f%d.bin", size))
		if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
		d, err := DigestFile(p, cs)
		if err != nil {
			t.Fatal(err)
		}
		if want := ChunkCount(size, cs); len(d.Leaves) != want {
			t.Errorf("size=%d: DigestFile 叶子数 %d，ChunkCount 说 %d", size, len(d.Leaves), want)
		}
	}
}

// 断点续传后再校验根
func TestResumeThenRootStillMatches(t *testing.T) {
	const cs = 64 << 10
	const size = 11*cs + 999
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	data := make([]byte, size)
	rand.Read(data)
	os.WriteFile(src, data, 0o600)

	snd, _ := OpenSender(src, cs)
	defer snd.Close()
	dst := filepath.Join(dir, "dst.bin")

	// 第一轮只收前 5 块，然后中断保留 part
	rx, err := OpenReceiver(dst, snd.Size(), cs, nil, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, cs)
	for i := 0; i < 5; i++ {
		c, _ := snd.ReadChunk(i, buf)
		if err := rx.WriteChunk(i, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx.Abort(true); err != nil {
		t.Fatal(err)
	}

	// 第二轮续上
	rx2, err := OpenReceiver(dst, snd.Size(), cs, nil, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	miss := rx2.Missing()
	if len(miss) != snd.ChunkCount()-5 {
		t.Fatalf("续传缺失块数 %d，期望 %d", len(miss), snd.ChunkCount()-5)
	}
	for _, i := range miss {
		c, _ := snd.ReadChunk(i, buf)
		if err := rx2.WriteChunk(i, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx2.Finish(); err != nil {
		t.Fatalf("续传后 Finish 失败: %v", err)
	}
}

func writeRand(t *testing.T, p string, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	rand.Read(b)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return b
}

// 缺陷 1：续传状态只绑定 (size, chunkSize)，不绑内容。
// 同名同长度的另一个文件续传时会把旧块当成新文件的块，最终 Merkle 根不匹配。
func TestResumeMustNotMixDifferentFiles(t *testing.T) {
	const cs = 64 << 10
	const size = 8*cs + 77
	dir := t.TempDir()

	a := filepath.Join(dir, "a.bin")
	b := filepath.Join(dir, "b.bin")
	writeRand(t, a, size)
	writeRand(t, b, size) // 同名场景：长度一样，内容不同

	sa, _ := OpenSender(a, cs)
	defer sa.Close()
	sb, _ := OpenSender(b, cs)
	defer sb.Close()

	dst := filepath.Join(dir, "dst.bin")
	buf := make([]byte, cs)

	// 第一轮：收文件 A 的前 4 块后断开，保留续传状态
	rx, err := OpenReceiver(dst, sa.Size(), cs, nil, sa.Root())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		c, _ := sa.ReadChunk(i, buf)
		if err := rx.WriteChunk(i, c); err != nil {
			t.Fatal(err)
		}
	}
	rx.Abort(true)

	// 第二轮：改传文件 B（长度相同）。绝不能复用 A 的块。
	rx2, err := OpenReceiver(dst, sb.Size(), cs, nil, sb.Root())
	if err != nil {
		t.Fatal(err)
	}
	miss := rx2.Missing()
	if len(miss) != sb.ChunkCount() {
		t.Errorf("缺陷1：换了文件却复用了旧进度——只要补 %d 块，本该补 %d 块",
			len(miss), sb.ChunkCount())
	}
	for _, i := range miss {
		c, _ := sb.ReadChunk(i, buf)
		if err := rx2.WriteChunk(i, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx2.Finish(); err != nil {
		t.Errorf("缺陷1 后果：%v", err)
	}
}

// 缺陷 2：Finish() 校验失败后残留 .cbpart/.cbstate（位图全满），
// 于是每一次重试都瞬间"完成"并报同一个错，用户永远传不过去。
func TestRootMismatchMustNotPoisonRetry(t *testing.T) {
	const cs = 64 << 10
	const size = 4*cs + 11
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	data := writeRand(t, src, size)

	snd, _ := OpenSender(src, cs)
	defer snd.Close()
	dst := filepath.Join(dir, "dst.bin")

	// 制造一次根不匹配：用错误的 root 打开接收器，写满所有块
	badRoot := make([]byte, 32)
	rx, err := OpenReceiver(dst, int64(size), cs, nil, badRoot)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, cs)
	for i := 0; i < snd.ChunkCount(); i++ {
		c, _ := snd.ReadChunk(i, buf)
		rx.WriteChunk(i, c)
	}
	if err := rx.Finish(); err == nil {
		t.Fatal("本该报根不匹配")
	}

	// 重试：这次给正确的 root，且重新发全部块，必须能成功
	rx2, err := OpenReceiver(dst, int64(size), cs, nil, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	if n := len(rx2.Missing()); n == 0 {
		t.Errorf("缺陷2：重试时位图仍是满的，一块都不会重传（残留状态毒化了重试）")
	}
	for _, i := range rx2.Missing() {
		c, _ := snd.ReadChunk(i, buf)
		rx2.WriteChunk(i, c)
	}
	if err := rx2.Finish(); err != nil {
		t.Errorf("缺陷2 后果：重试仍然失败 %v", err)
	} else {
		got, _ := os.ReadFile(rx2.FinalPath())
		if len(got) != len(data) {
			t.Errorf("落地长度不对")
		}
	}
}

// 续传回来的块不能被信任：Finish 用本次会话写盘时算的哈希拼根，但上次会话的块没经手，
// 必须从磁盘读回核对。两次会话之间磁盘数据被改坏（磁盘错误、杀软隔离、误改），收尾必须报
// 整体校验失败，不能把坏文件当成功落地。
func TestResumedChunksAreVerifiedFromDisk(t *testing.T) {
	const cs = 64 << 10
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	data := make([]byte, 8*cs)
	rand.Read(data)
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatal(err)
	}
	snd, err := OpenSender(src, cs)
	if err != nil {
		t.Fatal(err)
	}
	defer snd.Close()

	dst := filepath.Join(dir, "dst.bin")
	rx, err := OpenReceiver(dst, snd.Size(), cs, nil, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, cs)
	for i := 0; i < 4; i++ {
		c, _ := snd.ReadChunk(i, buf)
		if err := rx.WriteChunk(i, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx.Abort(true); err != nil { // 模拟进程被杀，进度落盘
		t.Fatal(err)
	}

	// 两次会话之间，已收到的第 2 块在磁盘上被改坏。
	part := dst + partSuffix
	f, err := os.OpenFile(part, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xFF, 0xFF, 0xFF, 0xFF}, 2*cs+100); err != nil {
		t.Fatal(err)
	}
	f.Close()

	rx2, err := OpenReceiver(dst, snd.Size(), cs, nil, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	if got := len(rx2.Missing()); got != 4 {
		t.Fatalf("应当恢复出 4 块进度，缺 %d 块（共 8 块）", got)
	}
	for _, i := range rx2.Missing() {
		c, _ := snd.ReadChunk(i, buf)
		if err := rx2.WriteChunk(i, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx2.Finish(); err != ErrRootMismatch {
		t.Fatalf("续传回来的块在磁盘上被改坏了，Finish 应当返回 ErrRootMismatch，实际 %v", err)
	}
	if _, err := os.Stat(dst); err == nil {
		t.Fatal("校验失败的文件不能落地")
	}
}
