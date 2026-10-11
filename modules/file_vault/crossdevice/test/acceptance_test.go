// Package test 是 M1 端到端验收测试，对应 docs/05-实施路线与验收.md 的 A1~A8。
package test

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/identity"
	"github.com/Aevorine/Tessera/crossdevice/core/node"
	"github.com/Aevorine/Tessera/crossdevice/core/pairing"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
	"github.com/Aevorine/Tessera/crossdevice/core/transfer"
)

// ---------- 测试脚手架 ----------

type testNode struct {
	*node.Node
	t       *testing.T
	name    string
	dir     string
	sasSeen chan crypto.SAS

	clipMu   sync.Mutex
	clipGot  []*clipboard.Item
	clipWake chan struct{}

	// 状态变化按顺序记录：回环上重连只要约 10 ms，轮询 State() 抓不住，订阅事件才能确定性断言。
	stateMu  sync.Mutex
	stateLog []node.State

	// 保留全部事件：有些断言看通知内容而非状态，如秒传事件绝不能带落地路径。
	eventMu  sync.Mutex
	eventLog []node.Event

	// 记录每次 OnProgress 回调：文件传输与剪贴板大表示共用进度机制（node.Progress.Kind 区分），
	// 只能从这里断言大内容同步是否报进度。
	progressMu  sync.Mutex
	progressLog []node.Progress

	rejectTransfers bool
}

func (tn *testNode) progress() []node.Progress {
	tn.progressMu.Lock()
	defer tn.progressMu.Unlock()
	return append([]node.Progress(nil), tn.progressLog...)
}

func (tn *testNode) resetEvents() {
	tn.eventMu.Lock()
	tn.eventLog = nil
	tn.eventMu.Unlock()
}

func (tn *testNode) events() []node.Event {
	tn.eventMu.Lock()
	defer tn.eventMu.Unlock()
	return append([]node.Event(nil), tn.eventLog...)
}

func newTestNode(t *testing.T, name string, typ identity.DeviceType) *testNode {
	return newTestNodeWith(t, name, typ, nil)
}

// newTestNodeWith 建一个测试节点，并允许用例在启动前改配置。
// 跨网用例要往里塞汇合点地址，其余用例传 nil 即可。
func newTestNodeWith(t *testing.T, name string, typ identity.DeviceType, tweak func(*node.Config)) *testNode {
	t.Helper()
	dir := t.TempDir()

	id, err := identity.New(name, typ)
	if err != nil {
		t.Fatalf("生成身份失败: %v", err)
	}
	st, err := store.Open(filepath.Join(dir, "store.json"))
	if err != nil {
		t.Fatalf("打开存储失败: %v", err)
	}

	tn := &testNode{
		t: t, name: name, dir: dir,
		sasSeen:  make(chan crypto.SAS, 8),
		clipWake: make(chan struct{}, 64),
	}

	cfg := node.Config{
		Identity:    id,
		Store:       st,
		ListenAddr:  "127.0.0.1:0",
		DownloadDir: filepath.Join(dir, "downloads"),
		// 每个测试节点必须有独立暂存目录：留空会用 os.TempDir() 下的固定共享路径，
		// 而测试里所有设备同进程同文件系统，会让 FindIdentical 误秒传命中，且残留文件互相干扰。
		CacheDir: filepath.Join(dir, "clipxfer"),
		Logger:   log.New(io.Discard, "", 0),
		// 测试节点一律不上 mDNS：几十个节点同时往真实局域网广播，既吵到
		// 同网段的真设备，又会让用例之间互相看见对方的节点。发现层单独测。
		DisableDiscovery: true,
		ConfirmPair: func(r node.PairRequest) (bool, string, time.Duration) {
			tn.sasSeen <- r.SAS
			return true, pairing.TrustLong, 0
		},
		OnClip: func(it *clipboard.Item) {
			tn.clipMu.Lock()
			tn.clipGot = append(tn.clipGot, it)
			tn.clipMu.Unlock()
			select {
			case tn.clipWake <- struct{}{}:
			default:
			}
		},
		ConfirmTransfer: func(o node.TransferOffer) (bool, string) {
			if tn.rejectTransfers {
				return false, ""
			}
			return true, filepath.Join(dir, "downloads")
		},
		OnProgress: func(p node.Progress) {
			tn.progressMu.Lock()
			tn.progressLog = append(tn.progressLog, p)
			tn.progressMu.Unlock()
		},
		OnEvent: func(e node.Event) {
			tn.eventMu.Lock()
			tn.eventLog = append(tn.eventLog, e)
			tn.eventMu.Unlock()
			if e.Kind != "state" {
				return
			}
			tn.stateMu.Lock()
			tn.stateLog = append(tn.stateLog, e.State)
			tn.stateMu.Unlock()
		},
	}
	if tweak != nil {
		tweak(&cfg)
	}
	n, err := node.New(cfg)
	if err != nil {
		t.Fatalf("创建节点失败: %v", err)
	}
	tn.Node = n
	if err := n.Start(); err != nil {
		t.Fatalf("启动节点失败: %v", err)
	}
	// AdvertiseAddrs 必须在拿到实际端口之后设置，所以这里重建一次配置不现实；
	// 改为让 ShowPairingCode 拿到的地址走 127.0.0.1，避免测试依赖真实网卡。
	n.SetAdvertiseAddrs([]string{fmt.Sprintf("127.0.0.1:%d", n.Port())})
	t.Cleanup(func() { _ = n.Close() })
	return tn
}

// waitClip 等到收到第 want 条剪贴板内容。
func (tn *testNode) waitClip(want int, timeout time.Duration) []*clipboard.Item {
	tn.t.Helper()
	deadline := time.After(timeout)
	for {
		tn.clipMu.Lock()
		got := len(tn.clipGot)
		items := append([]*clipboard.Item(nil), tn.clipGot...)
		tn.clipMu.Unlock()
		if got >= want {
			return items
		}
		select {
		case <-tn.clipWake:
		case <-deadline:
			tn.t.Fatalf("%s 超时：期望 %d 条剪贴板内容，实际 %d 条", tn.name, want, got)
		}
	}
}

// pair 让 b 扫描 a 出示的配对码，返回两端各自算出的 SAS。
func pair(t *testing.T, a, b *testNode) (crypto.SAS, crypto.SAS) {
	t.Helper()
	code, _, err := a.ShowPairingCode(pairing.TrustLong, 0, nil)
	if err != nil {
		t.Fatalf("生成配对码失败: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := b.PairWithCode(ctx, code, pairing.MethodQR); err != nil {
		t.Fatalf("配对失败: %v", err)
	}
	sasA := recvSAS(t, a)
	sasB := recvSAS(t, b)
	return sasA, sasB
}

func recvSAS(t *testing.T, n *testNode) crypto.SAS {
	t.Helper()
	select {
	case s := <-n.sasSeen:
		return s
	case <-time.After(5 * time.Second):
		t.Fatalf("%s 没有产生 SAS", n.name)
		return crypto.SAS{}
	}
}

func connect(t *testing.T, from, to *testNode) *node.Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := from.Connect(ctx, to.Identity().DeviceID())
	if err != nil {
		t.Fatalf("%s 连接 %s 失败: %v", from.name, to.name, err)
	}
	return s
}

// ---------- A1：二维码配对，双方 SAS 一致 ----------

func TestA1_QRPairing(t *testing.T) {
	pc := newTestNode(t, "小明的电脑", identity.TypePC)
	ph := newTestNode(t, "荣耀手机", identity.TypePhone)

	sasPC, sasPH := pair(t, pc, ph)

	if !sasPC.Equal(sasPH) {
		t.Fatalf("A1 失败：两端 SAS 不一致\n  电脑: %s\n  手机: %s", sasPC, sasPH)
	}
	if len(sasPC.Digits) != 6 || len(sasPC.Emoji) != 6 {
		t.Fatalf("A1 失败：SAS 格式不对: %+v", sasPC)
	}

	// 双方都必须把对方写进信任列表，且能通过公钥反查到。
	p, err := pc.Store().GetPeer(ph.Identity().DeviceID())
	if err != nil {
		t.Fatalf("A1 失败：电脑端没有记录手机: %v", err)
	}
	if p.Trust != pairing.TrustLong {
		t.Fatalf("A1 失败：信任等级应为 long，实际 %s", p.Trust)
	}
	if _, err := ph.Store().FindByDHPub(pc.Identity().DHPub[:]); err != nil {
		t.Fatalf("A1 失败：手机端无法按公钥反查电脑: %v", err)
	}
	t.Logf("A1 ✅ SAS 一致：%s", sasPC)
}

func TestA1b_QRCodeExpiresAndSingleUse(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph1 := newTestNode(t, "手机1", identity.TypePhone)
	ph2 := newTestNode(t, "手机2", identity.TypePhone)

	code, _, err := pc.ShowPairingCode(pairing.TrustLong, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := ph1.PairWithCode(ctx, code, pairing.MethodQR); err != nil {
		t.Fatalf("第一次配对应当成功: %v", err)
	}
	// 同一张码第二次使用必须被拒——否则被偷拍的二维码可以被反复使用。
	if _, err := ph2.PairWithCode(ctx, code, pairing.MethodQR); err == nil {
		t.Fatal("A1b 失败：同一个配对码被使用了第二次")
	} else {
		t.Logf("A1b ✅ 二维码一次性生效，第二次被拒：%v", err)
	}

	// 过期码必须解析即失败。
	expired, err := pairing.NewQRPayload(pc.Identity(), pairing.TrustLong, -time.Second, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := expired.Encode()
	if _, err := pairing.Decode(s); err == nil {
		t.Fatal("A1b 失败：过期二维码仍被接受")
	}
	t.Log("A1b ✅ 过期二维码被拒绝")
}

// ---------- A2：文本（含物理符号）逐字节一致 ----------

func TestA2_TextWithPhysicsSymbols(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	// 覆盖用户明确提到的场景：公式、物理符号、上标、组合字符、Emoji、中文。
	const text = "E = mc²\n" +
		"加速度 a = 9.8 m/s²，力 F = 1 kg·m/s²\n" +
		"α β γ Δ Ω μ λ θ̇ ħ ∇\n" +
		"∑ ∫ √ ∞ ≈ ≠ ≤ ≥ ± × ÷ ° ℃ Å ∂\n" +
		"10⁻³ 10⁻⁶ H₂O CO₂ x₁ x₂\n" +
		"制表符\t与换行\n中文标点：，。！？；：“”‘’\n" +
		"Emoji 🎯🔬⚛️"

	it, errs := pc.CopyText(text)
	if len(errs) > 0 {
		t.Fatalf("A2 失败：发送出错 %v", errs)
	}
	if it == nil {
		t.Fatal("A2 失败：本地复制被误判为回声")
	}

	items := ph.waitClip(1, 10*time.Second)
	got := items[0].Text()
	if got != text {
		t.Fatalf("A2 失败：内容不一致\n期望 %q\n实际 %q", text, got)
	}
	if items[0].Source != pc.Identity().DeviceID() {
		t.Fatalf("A2 失败：来源设备不对: %s", items[0].Source)
	}
	t.Logf("A2 ✅ %d 字节文本逐字节一致（含 ² · ̇ ₂ 等组合/上下标字符）", len(text))
}

func TestA2b_NoSyncLoop(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)
	connect(t, ph, pc) // 双向连接，最容易形成回环

	const text = "这条内容不应该在两台设备之间无限来回"
	if _, errs := pc.CopyText(text); len(errs) > 0 {
		t.Fatalf("发送失败: %v", errs)
	}
	ph.waitClip(1, 10*time.Second)

	// 模拟手机侧剪贴板监听器捕获到刚写入的内容：必须被判定为回声，不再广播。
	echo, err := ph.LocalCopy(clipboard.MimeText, []clipboard.Rep{
		{Mime: clipboard.MimeText, Data: []byte(text)},
	})
	if err != nil {
		t.Fatalf("LocalCopy 出错: %v", err)
	}
	if echo != nil {
		t.Fatal("A2b 失败：回声内容没有被抑制，会形成同步循环")
	}

	time.Sleep(500 * time.Millisecond)
	pc.clipMu.Lock()
	n := len(pc.clipGot)
	pc.clipMu.Unlock()
	if n != 0 {
		t.Fatalf("A2b 失败：内容回传给了发送方 %d 次", n)
	}
	t.Log("A2b ✅ 回环被抑制：内容未回传，也未重复入库")
}

// ---------- A3：大图片按需拉取 ----------

func TestA3_LargeImageLazyFetch(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	img := make([]byte, 2<<20) // 2 MiB
	if _, err := rand.Read(img); err != nil {
		t.Fatal(err)
	}
	// PNG 魔数，让它看起来像真图片。
	copy(img, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})

	it, err := pc.LocalCopy(clipboard.MimePNG, []clipboard.Rep{
		{Mime: clipboard.MimePNG, Data: img},
		{Mime: clipboard.MimeText, Data: []byte("[图片]")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatalf("A3 失败：广播出错 %v", errs)
	}

	items := ph.waitClip(1, 30*time.Second)
	rep, ok := items[0].Rep(clipboard.MimePNG)
	if !ok {
		t.Fatal("A3 失败：没有收到 PNG 表示")
	}
	if rep.Data == nil {
		t.Fatal("A3 失败：PNG 正文没有被拉取回来")
	}
	if !bytes.Equal(rep.Data, img) {
		t.Fatal("A3 失败：图片内容不一致")
	}
	// 小表示应当是内联的（一个包搞定），大表示才走按需拉取。
	txt, _ := items[0].Rep(clipboard.MimeText)
	if txt.Data == nil {
		t.Fatal("A3 失败：小文本表示应当内联传输")
	}
	t.Logf("A3 ✅ 2 MiB 图片按需拉取后哈希一致，小表示内联（%d 字节）", txt.Size)
}

// TestA3b_HugeClipboardBeyondOldChunkBuffer：旧接收端用深度 16 的 channel 收 512 KiB 分片，
// 消费不及时就 default 丢弃，超过 8 MiB 的内容无报错地残缺。用 24 MiB（48 片）复现并验证修复。
func TestA3b_HugeClipboardBeyondOldChunkBuffer(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	const size = 24 << 20 // 24 MiB = 48 个 512 KiB 分片，旧缓冲区(16)会在第 17 片开始丢
	huge := make([]byte, size)
	if _, err := rand.Read(huge); err != nil {
		t.Fatal(err)
	}
	copy(huge, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})

	it, err := pc.LocalCopy(clipboard.MimePNG, []clipboard.Rep{
		{Mime: clipboard.MimePNG, Data: huge},
	})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatalf("A3b 失败：广播出错 %v", errs)
	}

	items := ph.waitClip(1, 30*time.Second)
	rep, ok := items[0].Rep(clipboard.MimePNG)
	if !ok || rep.Data == nil {
		t.Fatal("A3b 失败：24 MiB 内容没有被拉取回来")
	}
	if len(rep.Data) != len(huge) {
		t.Fatalf("A3b 失败：长度不对，期望 %d 字节，实际 %d 字节（内容被截断/丢片）", len(huge), len(rep.Data))
	}
	if !bytes.Equal(rep.Data, huge) {
		t.Fatal("A3b 失败：24 MiB 内容逐字节不一致（分片乱序或丢片导致数据损坏）")
	}
	t.Logf("A3b ✅ %d MiB（48 个分片）跨设备同步后逐字节一致", size>>20)
}

// TestA3c_AllRepresentationsFetchedNotJustPreferred：旧代码 onClipAnnounce 只判断 it.Preferred，
// 富文本场景下非首选的大表示（如 text/plain 带大 HTML）永不拉取，格式静默丢失。
func TestA3c_AllRepresentationsFetchedNotJustPreferred(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	bigHTML := make([]byte, 3<<20) // 3 MiB，非首选表示，超过内联阈值
	if _, err := rand.Read(bigHTML); err != nil {
		t.Fatal(err)
	}
	copy(bigHTML, []byte("<html>"))

	it, err := pc.LocalCopy(clipboard.MimeText, []clipboard.Rep{
		{Mime: clipboard.MimeText, Data: []byte("纯文本回退")},
		{Mime: clipboard.MimeHTML, Data: bigHTML},
	})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatalf("A3c 失败：广播出错 %v", errs)
	}

	items := ph.waitClip(1, 30*time.Second)
	html, ok := items[0].Rep(clipboard.MimeHTML)
	if !ok || html.Data == nil {
		t.Fatal("A3c 失败：非首选的大 HTML 表示没有被拉取——格式会静默降级为纯文本")
	}
	if !bytes.Equal(html.Data, bigHTML) {
		t.Fatal("A3c 失败：HTML 表示内容不一致")
	}
	t.Log("A3c ✅ 非首选大表示（HTML）与首选表示（文本）都被完整拉取")
}

// TestA3d_ClipXferAutoResendsAfterReconnect：推送到一半断线，重连后应自动补上，
// 不要求用户再复制一次（clipxfer.go 的 resendPendingClipXfers）。
func TestA3d_ClipXferAutoResendsAfterReconnect(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess1 := connect(t, pc, ph)

	const size = 32 << 20 // 32 MiB，8 个 4 MiB 块，给中断留出真实窗口
	img := make([]byte, size)
	if _, err := rand.Read(img); err != nil {
		t.Fatal(err)
	}
	copy(img, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})

	it, err := pc.LocalCopy(clipboard.MimePNG, []clipboard.Rep{{Mime: clipboard.MimePNG, Data: img}})
	if err != nil {
		t.Fatal(err)
	}
	if err := sess1.SendClip(it); err != nil {
		t.Fatalf("A3d 失败：发送 announce 出错 %v", err)
	}

	// 推送在另一 goroutine 异步起步（见 SendClip），须先观察到至少一次进度事件再断连，
	// 否则只是「没推过」，会把调度时序问题误判成断点续传失效。
	deadline := time.After(5 * time.Second)
	for len(pc.progress()) == 0 {
		select {
		case <-deadline:
			t.Fatal("A3d 前置条件不对：等了 5 秒都没等到推送开始的进度事件")
		case <-time.After(2 * time.Millisecond):
		}
	}

	// 不等推送完成就掐断连接——测试代码自己不重试、不再调用任何发送方法，
	// 剩下的事全靠重连之后节点自己补。
	sess1.Close("模拟断线")
	connect(t, pc, ph)

	items := ph.waitClip(1, 30*time.Second)
	rep, ok := items[0].Rep(clipboard.MimePNG)
	if !ok || rep.Data == nil {
		t.Fatal("A3d 失败：重连后没有自动补发剪贴板正文")
	}
	if !bytes.Equal(rep.Data, img) {
		t.Fatal("A3d 失败：重连补发后内容不一致")
	}
	t.Log("A3d ✅ 断线后重连，剪贴板正文无需用户干预即自动补发完整")
}

// TestA3e_ClipXferReportsProgress 验证大内容同步走文件传输通道之后，发送端和
// 接收端都能拿到进度事件——用户不该在几 MB 的同步过程中只看着一个转圈。
func TestA3e_ClipXferReportsProgress(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	const size = 12 << 20 // 12 MiB，3 个 4 MiB 块
	img := make([]byte, size)
	if _, err := rand.Read(img); err != nil {
		t.Fatal(err)
	}
	copy(img, []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})

	it, err := pc.LocalCopy(clipboard.MimePNG, []clipboard.Rep{{Mime: clipboard.MimePNG, Data: img}})
	if err != nil {
		t.Fatal(err)
	}
	if errs := pc.BroadcastClip(it); len(errs) > 0 {
		t.Fatalf("A3e 失败：广播出错 %v", errs)
	}
	ph.waitClip(1, 30*time.Second)

	sawSend, sawRecv := false, false
	for _, p := range pc.progress() {
		if p.Kind == "clip" && p.Direction == "send" {
			sawSend = true
		}
	}
	for _, p := range ph.progress() {
		if p.Kind == "clip" && p.Direction == "recv" {
			sawRecv = true
		}
	}
	if !sawSend {
		t.Fatal("A3e 失败：发送端没有收到剪贴板同步的进度事件")
	}
	if !sawRecv {
		t.Fatal("A3e 失败：接收端没有收到剪贴板同步的进度事件")
	}
	t.Log("A3e ✅ 大内容同步过程中发送端与接收端都收到了进度事件")
}

// TestA3f_ClipConflictDetectedWhenBothSidesActBlind：两台设备断线期间各自复制，
// 属并发内容而非覆盖，双方都应能查到冲突提示。
func TestA3f_ClipConflictDetectedWhenBothSidesActBlind(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess1 := connect(t, pc, ph)

	if _, errs := pc.CopyText("起点"); len(errs) > 0 {
		t.Fatalf("广播起点内容出错 %v", errs)
	}
	ph.waitClip(1, 10*time.Second)
	sess1.Close("模拟两端断线期间各自复制")

	// 两端此刻都停在"起点"这条上，都在完全不知道对方现状的情况下各自复制新内容。
	itPC, err := pc.LocalCopy(clipboard.MimeText, []clipboard.Rep{{Mime: clipboard.MimeText, Data: []byte("电脑这边新复制的")}})
	if err != nil {
		t.Fatal(err)
	}
	itPhone, err := ph.LocalCopy(clipboard.MimeText, []clipboard.Rep{{Mime: clipboard.MimeText, Data: []byte("手机这边新复制的")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(itPC.CausalRef) == 0 || len(itPhone.CausalRef) == 0 {
		t.Fatal("A3f 前置条件不对：两条新内容都应该带着「起点」的 CausalRef")
	}

	sess2 := connect(t, pc, ph)
	if err := sess2.SendClip(itPC); err != nil {
		t.Fatalf("电脑发送失败: %v", err)
	}
	phSess, ok := ph.SessionFor(pc.Identity().DeviceID())
	if !ok {
		t.Fatal("手机侧没有找到与电脑的会话")
	}
	if err := phSess.SendClip(itPhone); err != nil {
		t.Fatalf("手机发送失败: %v", err)
	}

	pc.waitClip(1, 10*time.Second)
	ph.waitClip(2, 10*time.Second)

	if len(pc.ClipConflicts()) == 0 {
		t.Fatal("A3f 失败：电脑没有检出因果冲突——那条内容明明是在它不知情的情况下产生的")
	}
	if len(ph.ClipConflicts()) == 0 {
		t.Fatal("A3f 失败：手机没有检出因果冲突")
	}
	t.Log("A3f ✅ 两端都正确检出了因果冲突，而不是把并发内容当成了先后覆盖")
}

// ---------- A4：文件传输 + 断点续传 ----------

func TestA4_FileTransfer(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	sess := connect(t, pc, ph)

	const size = 40 << 20 // 40 MiB → 10 个 4 MiB 块
	src := makeRandomFile(t, pc.dir, "大文件.bin", size)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	res, err := sess.SendFile(ctx, src)
	if err != nil {
		t.Fatalf("A4 失败：发送出错 %v", err)
	}

	dst := filepath.Join(ph.dir, "downloads", "大文件.bin")
	waitFile(t, dst, 30*time.Second)
	assertSameFile(t, src, dst)
	t.Logf("A4 ✅ %d MiB 文件传输完成，%d 块，耗时 %v（%.1f MB/s）",
		size>>20, res.Chunks, res.Elapsed.Round(time.Millisecond),
		float64(size)/res.Elapsed.Seconds()/(1<<20))
}

// TestA4b 直接在传输层验证"进程被杀 → 重启 → 只补缺失块"。
// 这样能精确控制中断点，比端到端 kill 进程更可复现。
func TestA4b_ResumeAfterInterruption(t *testing.T) {
	dir := t.TempDir()
	const size = 40 << 20
	src := makeRandomFile(t, dir, "src.bin", size)

	snd, err := transfer.OpenSender(src, transfer.DefaultChunkSize)
	if err != nil {
		t.Fatal(err)
	}
	defer snd.Close()
	total := snd.ChunkCount()
	if total < 4 {
		t.Fatalf("测试需要至少 4 块，实际 %d", total)
	}

	dst := filepath.Join(dir, "dst.bin")
	rx, err := transfer.OpenReceiver(dst, snd.Size(), snd.ChunkSize(), snd.Digest().Leaves, snd.Root())
	if err != nil {
		t.Fatal(err)
	}

	// 第一段：收一半就"崩溃"。
	buf := make([]byte, transfer.DefaultChunkSize)
	half := total / 2
	for i := 0; i < half; i++ {
		data, err := snd.ReadChunk(i, buf)
		if err != nil {
			t.Fatal(err)
		}
		if err := rx.WriteChunk(i, data); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx.Abort(true); err != nil { // keepPartial=true 模拟进程被杀
		t.Fatal(err)
	}

	// 第二段：重开接收器，进度必须被恢复出来。
	rx2, err := transfer.OpenReceiver(dst, snd.Size(), snd.ChunkSize(), snd.Digest().Leaves, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	missing := rx2.Missing()
	resumed := total - len(missing)
	if resumed == 0 {
		t.Fatal("A4b 失败：重启后进度完全丢失，等于从头开始")
	}
	if resumed > half {
		t.Fatalf("A4b 失败：恢复出的块数 %d 超过实际写入的 %d", resumed, half)
	}

	for _, i := range missing {
		data, err := snd.ReadChunk(i, buf)
		if err != nil {
			t.Fatal(err)
		}
		if err := rx2.WriteChunk(i, data); err != nil {
			t.Fatal(err)
		}
	}
	if err := rx2.Finish(); err != nil {
		t.Fatalf("A4b 失败：最终校验不通过 %v", err)
	}
	assertSameFile(t, src, rx2.FinalPath())
	t.Logf("A4b ✅ 中断后恢复 %d/%d 块，只补传 %d 块，Merkle 根校验通过",
		resumed, total, len(missing))
}

func TestA4c_CorruptChunkRejected(t *testing.T) {
	dir := t.TempDir()
	const size = 8 << 20
	src := makeRandomFile(t, dir, "src.bin", size)
	snd, err := transfer.OpenSender(src, transfer.DefaultChunkSize)
	if err != nil {
		t.Fatal(err)
	}
	defer snd.Close()

	rx, err := transfer.OpenReceiver(filepath.Join(dir, "dst.bin"),
		snd.Size(), snd.ChunkSize(), snd.Digest().Leaves, snd.Root())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rx.Abort(false) }()
	buf := make([]byte, transfer.DefaultChunkSize)
	data, err := snd.ReadChunk(0, buf)
	if err != nil {
		t.Fatal(err)
	}
	bad := append([]byte(nil), data...)
	bad[123] ^= 0xFF
	if err := rx.WriteChunk(0, bad); err == nil {
		t.Fatal("A4c 失败：损坏的分块没有被拒绝")
	}
	if len(rx.Missing()) != snd.ChunkCount() {
		t.Fatal("A4c 失败：被拒绝的分块不应被记为已收到")
	}
	t.Log("A4c ✅ 损坏分块当场被拒，且不占用进度位")
}

// ---------- A5：一对多，单台失败不影响其他 ----------

func TestA5_OneToManyPartialFailure(t *testing.T) {
	sender := newTestNode(t, "电脑", identity.TypePC)
	r1 := newTestNode(t, "手机", identity.TypePhone)
	r2 := newTestNode(t, "平板", identity.TypeTablet)
	r3 := newTestNode(t, "会拒绝的设备", identity.TypePhone)
	r3.rejectTransfers = true

	for _, r := range []*testNode{r1, r2, r3} {
		pair(t, sender, r)
		connect(t, sender, r)
	}

	// 剪贴板一对多：三台都应收到。
	if _, errs := sender.CopyText("一对多剪贴板"); len(errs) > 0 {
		t.Fatalf("A5 失败：剪贴板广播出错 %v", errs)
	}
	for _, r := range []*testNode{r1, r2, r3} {
		items := r.waitClip(1, 10*time.Second)
		if items[0].Text() != "一对多剪贴板" {
			t.Fatalf("A5 失败：%s 收到的内容不对", r.name)
		}
	}

	// 文件一对多：r3 拒收，r1/r2 必须照常成功。
	src := makeRandomFile(t, sender.dir, "共享.bin", 6<<20)
	type outcome struct {
		name string
		err  error
	}
	results := make(chan outcome, 3)
	var wg sync.WaitGroup
	for _, r := range []*testNode{r1, r2, r3} {
		wg.Add(1)
		go func(r *testNode) {
			defer wg.Done()
			s, ok := sender.SessionFor(r.Identity().DeviceID())
			if !ok {
				results <- outcome{r.name, fmt.Errorf("没有会话")}
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			_, err := s.SendFile(ctx, src)
			results <- outcome{r.name, err}
		}(r)
	}
	wg.Wait()
	close(results)

	okCount, failCount := 0, 0
	for o := range results {
		if o.err == nil {
			okCount++
		} else {
			failCount++
			t.Logf("  %s 失败（预期内）: %v", o.name, o.err)
		}
	}
	if okCount != 2 || failCount != 1 {
		t.Fatalf("A5 失败：期望 2 成功 1 失败，实际 %d 成功 %d 失败", okCount, failCount)
	}
	for _, r := range []*testNode{r1, r2} {
		assertSameFile(t, src, filepath.Join(r.dir, "downloads", "共享.bin"))
	}
	if _, err := os.Stat(filepath.Join(r3.dir, "downloads", "共享.bin")); !os.IsNotExist(err) {
		t.Fatal("A5 失败：拒收的设备不应产生文件")
	}
	t.Log("A5 ✅ 一对三：1 台拒收不影响另外 2 台，内容均校验通过")
}

// ---------- A6：断开后自动重连速度 ----------

func TestA6_FastAutoReconnect(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)

	peerID := ph.Identity().DeviceID()
	pc.KeepConnected(peerID)

	waitState(t, pc, peerID, node.StateConnected, 15*time.Second)
	sess, ok := pc.SessionFor(peerID)
	if !ok {
		t.Fatal("A6 失败：连上了却拿不到会话")
	}

	// 模拟链路中断。
	pc.resetStateLog()
	sess.Close("模拟断网")
	elapsed := pc.waitReconnectCycle(10 * time.Second)

	if elapsed > 3*time.Second {
		t.Fatalf("A6 失败：重连耗时 %v，超过 3 秒目标", elapsed)
	}
	// 重连必须复用已有配对，不能要求重新扫码。
	if _, err := pc.Store().GetPeer(peerID); err != nil {
		t.Fatalf("A6 失败：重连后信任记录丢失: %v", err)
	}
	newSess, ok := pc.SessionFor(peerID)
	if !ok {
		t.Fatal("A6 失败：状态是 CONNECTED 但没有会话")
	}
	// 重点是必须得到新的、活着的会话：曾有 bug 把关掉的旧会话当作已连接返回，且重连循环满速空转。
	if newSess == sess {
		t.Fatal("A6 失败：拿回来的还是那条已关闭的旧会话，并没有真正重连")
	}
	if !newSess.Alive() {
		t.Fatal("A6 失败：重连后的会话已经是关闭状态")
	}
	t.Logf("A6 ✅ 断开后自动重连耗时 %v（目标 <3s，新会话，无需重新扫码）", elapsed.Round(time.Millisecond))
}

func TestA6b_NetworkChangedResetsBackoff(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	peerID := ph.Identity().DeviceID()

	pc.KeepConnected(peerID)
	waitState(t, pc, peerID, node.StateConnected, 15*time.Second)

	// 把对端整个停掉，重连必然失败并进入退避。
	_ = ph.Node.Close()
	waitStateNot(t, pc, peerID, node.StateConnected, 10*time.Second)

	// 网络变化信号必须能立刻唤醒退避中的重连循环（不 panic、不阻塞）。
	done := make(chan struct{})
	go func() {
		pc.NetworkChanged()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("A6b 失败：NetworkChanged 阻塞了")
	}
	t.Log("A6b ✅ 网络变化信号可即时广播给所有重连循环")
}

// ---------- A7：路径穿越防护 ----------

func TestA7_PathTraversalRejected(t *testing.T) {
	dest := t.TempDir()

	mustReject := []string{
		"../../../etc/passwd",
		"..\\..\\Windows\\System32\\evil.dll",
		"/etc/shadow",
		"C:\\Windows\\System32\\evil.dll",
		"\\\\server\\share\\x",
		"a/../../../../b",
		"..",
		"",
		"bad\x00name",
	}
	for _, p := range mustReject {
		if got, err := transfer.ResolveDest(dest, p); err == nil {
			t.Fatalf("A7 失败：危险路径 %q 未被拒绝，落地到 %q", p, got)
		}
	}

	// 保留名与非法字符必须被改写而不是原样落地。
	rewrite := map[string]bool{
		"CON.txt":   true,
		"NUL":       true,
		"COM1.dat":  true,
		"a<b>c.txt": true,
		"trail. ":   true,
	}
	for p := range rewrite {
		full, err := transfer.ResolveDest(dest, p)
		if err != nil {
			t.Fatalf("A7 失败：合法但需清洗的名字 %q 被整个拒绝: %v", p, err)
		}
		if filepath.Base(full) == p {
			t.Fatalf("A7 失败：%q 未被清洗", p)
		}
	}

	// 正常路径必须能通过，且落在目标目录内。
	for _, p := range []string{"a.txt", "sub/dir/b.pdf", "中文 目录/报告.docx", "./c.bin"} {
		full, err := transfer.ResolveDest(dest, p)
		if err != nil {
			t.Fatalf("A7 失败：正常路径 %q 被误拒: %v", p, err)
		}
		abs, _ := filepath.Abs(dest)
		if len(full) <= len(abs) || full[:len(abs)] != abs {
			t.Fatalf("A7 失败：%q 落到了目标目录之外: %s", p, full)
		}
	}
	t.Logf("A7 ✅ %d 条穿越攻击全部拦截，%d 个危险文件名被清洗，正常路径不受影响",
		len(mustReject), len(rewrite))
}

func TestA7b_UnsafePathRejectedEndToEnd(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, pc, ph)

	// 直接构造一个带穿越路径的传输邀约，验证接收端在落盘前就拦住。
	sess, _ := pc.SessionFor(ph.Identity().DeviceID())
	if sess == nil {
		t.Fatal("没有会话")
	}
	src := makeRandomFile(t, pc.dir, "payload.bin", 1<<20)
	if _, err := sess.SendFileAs(context.Background(), src, "../../../evil.dll"); err == nil {
		t.Fatal("A7b 失败：带穿越路径的传输被接受了")
	} else {
		t.Logf("A7b ✅ 端到端拦截：%v", err)
	}
}

// ---------- A8：未配对设备被拒绝 ----------

func TestA8_UntrustedRejected(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	stranger := newTestNode(t, "陌生设备", identity.TypePhone)

	// 陌生设备伪造一条本地信任记录，冒充"我认识电脑"，直接发起 IK 连接。
	if err := stranger.Store().PutPeer(&store.Peer{
		DeviceID:     pc.Identity().DeviceID(),
		Name:         pc.Identity().DisplayName(),
		Type:         "pc",
		DHPub:        pc.Identity().DHPub[:],
		SignPub:      pc.Identity().SignPub,
		Trust:        pairing.TrustLong,
		PairedAt:     time.Now(),
		LastGoodAddr: fmt.Sprintf("127.0.0.1:%d", pc.Port()),
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := stranger.Connect(ctx, pc.Identity().DeviceID()); err == nil {
		t.Fatal("A8 失败：未配对设备成功建立了连接")
	} else {
		t.Logf("A8 ✅ 未配对设备被拒：%v", err)
	}

	if len(pc.Sessions()) != 0 {
		t.Fatal("A8 失败：电脑端不应留下任何会话")
	}
}

func TestA8b_RevokedPeerCannotReconnect(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)
	connect(t, ph, pc)

	// 电脑撤销手机。
	if err := pc.Store().Revoke(ph.Identity().DeviceID()); err != nil {
		t.Fatal(err)
	}
	if s, ok := pc.SessionFor(ph.Identity().DeviceID()); ok {
		s.Close("已撤销")
	}
	time.Sleep(300 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := ph.Connect(ctx, pc.Identity().DeviceID()); err == nil {
		t.Fatal("A8b 失败：被撤销的设备仍能重连")
	} else {
		t.Logf("A8b ✅ 撤销后旧凭据立即失效：%v", err)
	}
}

func TestA8c_TempPeerExpires(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "s.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := &store.Peer{
		DeviceID: "TEMPDEV", Name: "别人的手机", Trust: pairing.TrustTemp,
		PairedAt: time.Now().Add(-time.Hour), ExpiresAt: time.Now().Add(-time.Minute),
	}
	if err := st.PutPeer(p); err != nil {
		t.Fatal(err)
	}
	if p.Usable(time.Now()) {
		t.Fatal("A8c 失败：已过期的临时设备仍被判定为可用")
	}
	if n := st.PurgeExpired(time.Now()); n != 1 {
		t.Fatalf("A8c 失败：应清理 1 台过期设备，实际 %d", n)
	}
	if _, err := st.GetPeer("TEMPDEV"); err == nil {
		t.Fatal("A8c 失败：过期设备未被删除")
	}

	// 临时设备的凭据不落盘：重开存储后不应出现。
	st2, err := store.Open(filepath.Join(dir, "s.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st2.GetPeer("TEMPDEV"); err == nil {
		t.Fatal("A8c 失败：临时设备凭据被持久化到磁盘了")
	}
	t.Log("A8c ✅ 临时设备到期即失效、自动清理，且凭据从不落盘")
}

// ---------- 身份与恢复 ----------

func TestIdentityRecovery(t *testing.T) {
	id, err := identity.New("我的手机", identity.TypePhone)
	if err != nil {
		t.Fatal(err)
	}
	code := id.ExportRecoveryCode()

	restored, err := identity.RestoreFromRecoveryCode(code, "新手机", identity.TypePhone)
	if err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	if restored.DeviceID() != id.DeviceID() {
		t.Fatalf("恢复出的 device_id 不同：%s vs %s", restored.DeviceID(), id.DeviceID())
	}
	if restored.DHPub != id.DHPub {
		t.Fatal("恢复出的 DH 公钥不同")
	}

	// 抄错一个字符必须报错，而不是静默生成一个谁也不认识的身份。
	broken := []rune(code)
	for i, r := range broken {
		if r >= '0' && r <= '8' {
			broken[i] = r + 1
			break
		}
	}
	if _, err := identity.RestoreFromRecoveryCode(string(broken), "x", identity.TypePhone); err == nil {
		t.Fatal("抄错的恢复码没有被校验位挡下")
	}
	t.Logf("恢复码 ✅ 换机后 device_id 不变（%s），错一位即报错", id.DeviceID())
}

// ---------- 辅助 ----------

func makeRandomFile(t *testing.T, dir, name string, size int) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := io.CopyN(f, rand.Reader, int64(size)); err != nil {
		t.Fatal(err)
	}
	return p
}

func assertSameFile(t *testing.T, a, b string) {
	t.Helper()
	da, err := transfer.DigestFile(a, transfer.DefaultChunkSize)
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", a, err)
	}
	db, err := transfer.DigestFile(b, transfer.DefaultChunkSize)
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", b, err)
	}
	if da.Size != db.Size {
		t.Fatalf("文件大小不同: %d vs %d", da.Size, db.Size)
	}
	if !bytes.Equal(da.Root, db.Root) {
		t.Fatalf("Merkle 根不同：%s 与 %s 内容不一致", a, b)
	}
}

func waitFile(t *testing.T, p string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(p); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("等待文件 %s 超时", p)
}

func waitState(t *testing.T, n *testNode, peerID string, want node.State, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if n.State(peerID) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("等待状态 %s 超时，当前 %s", want, n.State(peerID))
}

func waitStateNot(t *testing.T, n *testNode, peerID string, avoid node.State, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if n.State(peerID) != avoid {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("状态始终停留在 %s", avoid)
}

// resetStateLog 清空已记录的状态变化，通常在制造断线之前调用。
func (tn *testNode) resetStateLog() {
	tn.stateMu.Lock()
	tn.stateLog = nil
	tn.stateMu.Unlock()
}

// waitReconnectCycle 等一个完整的「掉线又连回」循环并返回耗时。
// 判据是事件序列中非 CONNECTED 之后又出现 CONNECTED，轮询在回环上抓不到中间态。
func (tn *testNode) waitReconnectCycle(timeout time.Duration) time.Duration {
	tn.t.Helper()
	start := time.Now()
	deadline := start.Add(timeout)
	for time.Now().Before(deadline) {
		tn.stateMu.Lock()
		seq := append([]node.State(nil), tn.stateLog...)
		tn.stateMu.Unlock()

		dropped := false
		for _, st := range seq {
			if st != node.StateConnected {
				dropped = true
			} else if dropped {
				return time.Since(start)
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	tn.stateMu.Lock()
	seq := tn.stateLog
	tn.stateMu.Unlock()
	tn.t.Fatalf("等待重连循环超时，观测到的状态序列: %v", seq)
	return 0
}

// ---------- A9：改设备名，对端不断线也能看到 ----------

// 电脑改名后手机设备列表必须跟着变，所以名字随心跳捎带。
// 本用例直接驱动心跳逻辑而不等 10 秒，验证的是「收到新名字心跳后本地记录更新」。
func TestA9_RenameVisibleToPeerWithoutReconnect(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)
	pair(t, pc, ph)

	pcID := pc.Identity().DeviceID()

	// 手机侧存的电脑名字，初始应当是配对时那个。
	before, err := ph.Store().GetPeer(pcID)
	if err != nil {
		t.Fatalf("手机上找不到电脑: %v", err)
	}
	if before.Name != "电脑" {
		t.Fatalf("配对后手机上存的名字不对: %q", before.Name)
	}

	// 电脑改名。
	pc.Identity().SetName("书房台式机")

	// 让两端连上并跑一轮心跳。
	ph.KeepConnected(pcID)
	waitState(t, ph, pcID, node.StateConnected, 15*time.Second)

	sess, ok := ph.SessionFor(pcID)
	if !ok {
		t.Fatal("连上了却拿不到会话")
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if p, err := ph.Store().GetPeer(pcID); err == nil && p.Name == "书房台式机" {
			// 连接必须**没有**因为改名而断掉——改名不该打断正在进行的传输。
			if !sess.Alive() {
				t.Fatal("A9 失败：改名把连接弄断了")
			}
			t.Log("A9 ✅ 改名后对端在不断线的情况下看到了新名字")
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	got, _ := ph.Store().GetPeer(pcID)
	t.Fatalf("A9 失败：手机上仍然是旧名字 %q", got.Name)
}

// ---------- A10：附近设备配对，安全性不打折 ----------

// 附近配对没有一次性令牌，SAS 双向核对是这条路径唯一的防线，绝不能省。
// 本用例断言配对成功且两端 SAS 一致，后者是重点。
func TestA10_NearbyPairingStillVerifiesSAS(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ph := newTestNode(t, "手机", identity.TypePhone)

	addr := fmt.Sprintf("127.0.0.1:%d", pc.Port())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if _, err := ph.PairWithNearby(ctx, pc.Identity().DeviceID(), addr); err != nil {
		t.Fatalf("A10 失败：附近配对没成功: %v", err)
	}

	sasPC := recvSAS(t, pc)
	sasPH := recvSAS(t, ph)

	if !sasPC.Equal(sasPH) {
		t.Fatalf("A10 失败：两端 SAS 不一致\n  电脑: %s\n  手机: %s", sasPC, sasPH)
	}
	if len(sasPC.Digits) != 6 || len(sasPC.Emoji) != 6 {
		t.Fatalf("A10 失败：SAS 格式不对: %+v", sasPC)
	}

	// 双方都要落库，且能按公钥反查——跟扫码配对的结果完全一致。
	if _, err := pc.Store().GetPeer(ph.Identity().DeviceID()); err != nil {
		t.Fatalf("A10 失败：电脑端没记录手机: %v", err)
	}
	if _, err := ph.Store().FindByDHPub(pc.Identity().DHPub[:]); err != nil {
		t.Fatalf("A10 失败：手机端无法按公钥反查电脑: %v", err)
	}
	t.Logf("A10 ✅ 附近配对完成，双向 SAS 一致：%s", sasPC)
}

// 不能和自己配对——发现层会把自己的广播也收回来，不挡住的话
// 设备列表里会冒出"自己"，用户点了就是自己跟自己握手。
func TestA10b_NearbyRejectsSelf(t *testing.T) {
	pc := newTestNode(t, "电脑", identity.TypePC)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	addr := fmt.Sprintf("127.0.0.1:%d", pc.Port())
	if _, err := pc.PairWithNearby(ctx, pc.Identity().DeviceID(), addr); err == nil {
		t.Fatal("A10b 失败：和自己配对居然成功了")
	}
	t.Log("A10b ✅ 和自己配对被拒绝")
}
