package agent

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 这组用例走真实入口（两个 Agent、真实配对、JSON 的 send_files、真实 QUIC 与落盘，回环当网络），
// 每条锁一个"文件/文件夹有时传不了"的根因：接收端晚点确认占住读循环致心跳不回、30 秒被断；
// 发送中源文件被改动致整体校验失败；成百上千文件严格串行致吞吐只有网速零头。

type e2ePair struct {
	host, guest *Agent
	hostEv      *eventLog
	guestEv     *eventLog
}

// eventLog 收一个 Agent 往外发的所有行，供断言"有没有出现错误事件"。
type eventLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *eventLog) sink(s string) {
	l.mu.Lock()
	l.lines = append(l.lines, s)
	l.mu.Unlock()
}

func (l *eventLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

// transferErrors 返回所有 transfer 事件里 kind=error 的那些。
func (l *eventLog) transferErrors() []string {
	var out []string
	for _, ln := range l.snapshot() {
		var ev struct {
			Event string         `json:"event"`
			Data  map[string]any `json:"data"`
		}
		if json.Unmarshal([]byte(ln), &ev) != nil || ev.Event != "transfer" {
			continue
		}
		if k, _ := ev.Data["kind"].(string); k == "error" {
			out = append(out, ln)
		}
	}
	return out
}

func newE2EPair(t *testing.T) *e2ePair {
	t.Helper()
	p := &e2ePair{hostEv: &eventLog{}, guestEv: &eventLog{}}

	var err error
	p.host, err = New(Config{DataDir: t.TempDir(), Name: "电脑", Addr: "127.0.0.1:0", Sink: p.hostEv.sink})
	if err != nil {
		t.Fatalf("电脑端启动失败: %v", err)
	}
	t.Cleanup(func() { _ = p.host.Close() })
	p.guest, err = New(Config{DataDir: t.TempDir(), Name: "手机", Addr: "127.0.0.1:0", Sink: p.guestEv.sink})
	if err != nil {
		t.Fatalf("手机端启动失败: %v", err)
	}
	t.Cleanup(func() { _ = p.guest.Close() })

	// 让配对码只公布回环地址，避免测试依赖真实网卡。
	p.guest.n.SetAdvertiseAddrs([]string{hostAddr(t, p.guest)})
	code, _, err := p.guest.n.ShowPairingCode("long", 0, nil)
	if err != nil {
		t.Fatalf("生成配对码失败: %v", err)
	}
	// 只在配对阶段自动点"一致"。包通用的 autoConfirm 会把**任何**待答复请求都点掉，
	// 连"是否接收文件"也一并点了，那就测不出用户迟迟不点的情形。
	pairing := make(chan struct{})
	for _, a := range []*Agent{p.host, p.guest} {
		go func(a *Agent) {
			for {
				select {
				case <-pairing:
					return
				case <-time.After(30 * time.Millisecond):
				}
				a.pendMu.Lock()
				ids := make([]string, 0, len(a.pending))
				for id := range a.pending {
					ids = append(ids, id)
				}
				a.pendMu.Unlock()
				for _, id := range ids {
					a.Handle(`{"id":99,"method":"pair_respond","params":{"request_id":` +
						jsonStr(id) + `,"accept":true,"mode":"long"}}`)
				}
			}
		}(a)
	}
	p.host.Handle(`{"id":2,"method":"pair_with_code","params":{"code":` + jsonStr(code) + `}}`)

	guestID := p.guest.id.DeviceID()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if s, ok := p.host.n.SessionFor(guestID); ok && s.Alive() {
			close(pairing)
			return p
		}
		time.Sleep(100 * time.Millisecond)
	}
	close(pairing)
	t.Fatal("配对之后电脑端与手机端之间没有建立会话")
	return nil
}

func (p *e2ePair) send(t *testing.T, paths ...string) {
	t.Helper()
	req := map[string]any{
		"id": 100, "method": "send_files",
		"params": map[string]any{"paths": paths, "device_ids": []string{p.guest.id.DeviceID()}},
	}
	b, _ := json.Marshal(req)
	p.host.Handle(string(b))
}

// treeDigest 把一个目录树变成「相对路径 → sha256」，用来逐字节比对两棵树。
func treeDigest(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		// 接收端收尾前的残片不算成品。
		if strings.HasSuffix(p, ".cbpart") || strings.HasSuffix(p, ".cbstate") {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out[filepath.ToSlash(rel)] = fmt.Sprintf("%x", h.Sum(nil))
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s 失败: %v", root, err)
	}
	return out
}

func writeRandom(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := io.CopyN(f, rand.Reader, int64(size)); err != nil {
		t.Fatal(err)
	}
}

// waitTree 等接收目录里长出和源一模一样的一棵树；途中出现发送错误就立刻失败。
func (p *e2ePair) waitTree(t *testing.T, want map[string]string, dest string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var got map[string]string
	for time.Now().Before(deadline) {
		if errs := p.hostEv.transferErrors(); len(errs) > 0 {
			t.Fatalf("发送端报了传输错误:\n%s", strings.Join(errs, "\n"))
		}
		// 先用便宜的办法判断"到齐没有"（只数文件个数，不读内容）：每 100 ms
		// 把整棵树哈希一遍会把磁盘和 CPU 都占满，量出来的速度就成了测试自己的。
		if _, err := os.Stat(dest); err == nil && countFiles(dest) >= len(want) {
			got = treeDigest(t, dest)
			if len(got) == len(want) {
				same := true
				for k, v := range want {
					if got[k] != v {
						same = false
						break
					}
				}
				if same {
					return
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	var missing, wrong []string
	for k, v := range want {
		g, ok := got[k]
		switch {
		case !ok:
			missing = append(missing, k)
		case g != v:
			wrong = append(wrong, k)
		}
	}
	t.Fatalf("超时：期望 %d 个文件，收到 %d 个；缺 %d 个、内容不对 %d 个\n缺: %v\n错: %v",
		len(want), len(got), len(missing), len(wrong), head(missing, 8), head(wrong, 8))
}

// countFiles 数成品文件个数（不含续传残片），不读内容。
func countFiles(root string) int {
	n := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !strings.HasSuffix(p, ".cbpart") && !strings.HasSuffix(p, ".cbstate") {
			n++
		}
		return nil
	})
	return n
}

func head(s []string, n int) []string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// ---------- F1：真实文件夹，成百上千个文件，逐字节一致 ----------

func TestF1_FolderWithManyFilesArrivesIntact(t *testing.T) {
	p := newE2EPair(t)

	src := filepath.Join(t.TempDir(), "项目 资料")
	sizes := []int{0, 1, 100, 4096, 65535, 65536, 70000, 200_000}
	// 400 个小文件：含空文件、跨 Noise 记录边界的大小、中文/空格/符号的名字、多级目录。
	for i := 0; i < 400; i++ {
		dir := filepath.Join(src, fmt.Sprintf("目录 %d", i%7), fmt.Sprintf("子目录-%d", i%3))
		name := fmt.Sprintf("文件 %03d (副本) #%d.dat", i, i%5)
		writeRandom(t, filepath.Join(dir, name), sizes[i%len(sizes)])
	}
	writeRandom(t, filepath.Join(src, "跨块.bin"), 5<<20+123)  // 两个 4 MiB 块，最后一块很短
	writeRandom(t, filepath.Join(src, "大文件", "a.bin"), 40<<20) // 走大文件车道
	writeRandom(t, filepath.Join(src, "大文件", "b.bin"), 36<<20)

	want := treeDigest(t, src)
	dest := filepath.Join(p.guest.downloadDir.Load().(string), filepath.Base(src))

	start := time.Now()
	p.send(t, src)
	p.waitTree(t, want, dest, 120*time.Second)
	el := time.Since(start)

	var total int64
	_ = filepath.WalkDir(src, func(_ string, d fs.DirEntry, _ error) error {
		if d != nil && !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	t.Logf("F1 ✅ %d 个文件、%.1f MiB，%v 内全部到齐且逐字节一致（%.1f MiB/s）",
		len(want), float64(total)/(1<<20), el.Round(time.Millisecond), float64(total)/(1<<20)/el.Seconds())
}

// ---------- F2：用户很久之后才点"接收"，传输不能被心跳判死 ----------

// 接收端设为"每次问"，用户 36 秒后才点接收（超过 3×10 秒心跳判活窗口）：
// 以前确认框阻塞读循环，心跳不回，发送端 30 秒就断连。同时锁住：一个文件夹只问一次。
func TestF2_SlowConfirmOnFolderAsksOnceAndKeepsConnection(t *testing.T) {
	if testing.Short() {
		t.Skip("要等 36 秒，-short 下跳过")
	}
	p := newE2EPair(t)

	// 接收端对这台设备「每次都问」。
	hostID := p.host.id.DeviceID()
	p.guest.Handle(`{"id":7,"method":"set_device_policy","params":{"device_id":` + jsonStr(hostID) + `,"file_policy":"ask"}}`)
	// Handle 是异步的：等策略真的落进存储再发，否则第一批 offer 可能抢在前面被自动接收。
	for i := 0; i < 100; i++ {
		if peer, err := p.guest.store.GetPeer(hostID); err == nil && peer.FilePolicy == "ask" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	src := filepath.Join(t.TempDir(), "要确认的文件夹")
	for i := 0; i < 24; i++ {
		writeRandom(t, filepath.Join(src, fmt.Sprintf("n%02d", i%4), fmt.Sprintf("f%02d.bin", i)), 30_000+i*1000)
	}
	want := treeDigest(t, src)
	dest := filepath.Join(p.guest.downloadDir.Load().(string), filepath.Base(src))

	var prompts atomic.Int32
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		seen := map[string]bool{}
		for {
			select {
			case <-stop:
				return
			case <-time.After(50 * time.Millisecond):
			}
			p.guest.pendMu.Lock()
			var fresh []string
			for id := range p.guest.pending {
				if !seen[id] {
					seen[id] = true
					fresh = append(fresh, id)
				}
			}
			p.guest.pendMu.Unlock()
			for _, id := range fresh {
				n := prompts.Add(1)
				go func(id string, first bool) {
					if first {
						time.Sleep(36 * time.Second) // 用户去倒了杯水
					}
					p.guest.Handle(`{"id":98,"method":"transfer_respond","params":{"request_id":` +
						jsonStr(id) + `,"accept":true}}`)
				}(id, n == 1)
			}
		}
	}()

	p.send(t, src)
	p.waitTree(t, want, dest, 120*time.Second)

	if n := prompts.Load(); n != 1 {
		t.Fatalf("同一个文件夹的 %d 个文件应当只弹一次确认框，实际 %d 次", len(want), n)
	}
	if s, ok := p.host.n.SessionFor(p.guest.id.DeviceID()); !ok || !s.Alive() {
		t.Fatal("等用户确认期间连接被判死了")
	}
	t.Logf("F2 ✅ 36 秒后才确认：%d 个文件全部到齐，确认框只弹了 1 次，连接没断", len(want))
}

// ---------- F3：发送途中源文件被改动 ----------

// offer 后、读完最后一块前文件末尾被追加（日志、下载中文件）：以前整份发完才校验失败、白传几 GB；
// 现在发送端当场发现并重算摘要重来。
func TestF3_SourceModifiedDuringSendIsRetried(t *testing.T) {
	p := newE2EPair(t)

	src := filepath.Join(t.TempDir(), "日志.bin")
	const size = 64 << 20
	writeRandom(t, src, size)
	dest := filepath.Join(p.guest.downloadDir.Load().(string), "日志.bin")

	// 一看到发送进度就改文件最后一块的内容（长度不变，所以 stat 看不出来）。
	var once sync.Once
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(2 * time.Millisecond):
			}
			for _, ln := range p.hostEv.snapshot() {
				if strings.Contains(ln, `"event":"progress"`) && strings.Contains(ln, `"direction":"send"`) {
					once.Do(func() {
						f, err := os.OpenFile(src, os.O_RDWR, 0)
						if err != nil {
							return
						}
						defer f.Close()
						patch := bytes.Repeat([]byte{0xAB}, 4096)
						_, _ = f.WriteAt(patch, int64(size)-int64(len(patch))-100)
					})
					return
				}
			}
		}
	}()

	p.send(t, src)

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if errs := p.hostEv.transferErrors(); len(errs) > 0 {
			t.Fatalf("文件被改动之后应当自动重发，实际报了错误:\n%s", strings.Join(errs, "\n"))
		}
		// 以最终的源文件为准：改动发生在发送途中，收到的必须是改动之后的版本。
		if st, err := os.Stat(dest); err == nil && st.Size() == size {
			want := treeDigest(t, filepath.Dir(src))["日志.bin"]
			got := treeDigest(t, filepath.Dir(dest))["日志.bin"]
			if want != "" && want == got {
				t.Log("F3 ✅ 发送途中源文件被改动：发送端当场发现并重发，收到的是改动之后的版本")
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("超时：文件被改动之后没有收到与源文件一致的版本")
}
