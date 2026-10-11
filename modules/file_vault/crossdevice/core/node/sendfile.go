package node

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/crypto"
	"github.com/Aevorine/Tessera/crossdevice/core/transfer"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

var (
	// ErrPeerRejected：对端明确回绝（用户拒绝或确认超时）。调用方据此区分"这个文件不行"与
	// "用户不要这批东西"，后者不必把文件夹剩下几百个文件挨个再问。
	ErrPeerRejected = errors.New("对方拒绝接收")

	// ErrSourceChanged：发送途中源文件被改动（边传边写的日志、下载中、被截断）。已发的块与
	// offer 的 Merkle 根对不上，继续发最终会被接收端整份丢弃。
	ErrSourceChanged = errors.New("源文件在传输期间被修改")
)

// FolderInfo 是发送端对整个文件夹的概括，随每个文件的 offer 带去，仅供接收端确认框
// 显示「文件夹 报告 · 87 个文件 · 1.2 GB」。
type FolderInfo struct {
	Files int
	Bytes int64
}

// digestCache 缓存按 (路径, 大小, 修改时间, 块大小) 算出的分块摘要：摘要要读整个文件，
// 而同一文件常被反复发（第二台设备、续传、重试）。安全网：发送时对每块再核对叶子哈希
// （见 startChunkPrep），即使 mtime 没变而内容变了，也只会按"源文件被修改"重来，
// 不会发出错误数据。
var digestCache = struct {
	mu sync.Mutex
	m  map[digestKey]*transfer.FileDigest
}{m: make(map[digestKey]*transfer.FileDigest)}

type digestKey struct {
	path    string
	size    int64
	mtimeNS int64
	chunk   int
}

const digestCacheMax = 256

func openSenderCached(path string, chunkSize int) (*transfer.FileSender, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("打开文件失败: %w", err)
	}
	if st.IsDir() {
		return nil, fmt.Errorf("打开文件失败: %s 是一个目录", filepath.Base(path))
	}
	key := digestKey{path: path, size: st.Size(), mtimeNS: st.ModTime().UnixNano(), chunk: chunkSize}
	digestCache.mu.Lock()
	d := digestCache.m[key]
	digestCache.mu.Unlock()
	if d != nil {
		if snd, err := transfer.OpenSenderWithDigest(path, d); err == nil {
			return snd, nil
		}
	}
	snd, err := transfer.OpenSender(path, chunkSize)
	if err != nil {
		return nil, err
	}
	// 摘要读到的才是这份内容的真实长度（stat 与读取之间文件可能又长了）。
	// 长度对不上就不入缓存：这个键下的 mtime 对应的不是这份摘要。
	if snd.Size() == key.size {
		digestCache.mu.Lock()
		if len(digestCache.m) >= digestCacheMax {
			for k := range digestCache.m { // 随便丢一个：这里不值得做 LRU
				delete(digestCache.m, k)
				break
			}
		}
		digestCache.m[key] = snd.Digest()
		digestCache.mu.Unlock()
	}
	return snd, nil
}

// forgetDigest 丢掉某个路径的全部缓存摘要（发现源文件变了的时候）。
func forgetDigest(path string) {
	digestCache.mu.Lock()
	for k := range digestCache.m {
		if k.path == path {
			delete(digestCache.m, k)
		}
	}
	digestCache.mu.Unlock()
}

// framePool 复用分块帧的缓冲。一个 4 MiB 的块每发一次就 new 一块 4 MiB，
// 千兆网下每秒几十块，全是 GC 压力——而帧写出去之后缓冲就没人再用了。
var framePool sync.Pool // *[]byte

func getFrameBuf(n int) []byte {
	if v := framePool.Get(); v != nil {
		if b := *(v.(*[]byte)); cap(b) >= n {
			return b[:n]
		}
	}
	return make([]byte, n)
}

func putFrameBuf(b []byte) {
	if cap(b) >= 64<<10 {
		framePool.Put(&b)
	}
}

// xferReply 是发送端等待的对端应答。
type xferReply struct {
	accept   *wire.XferAccept
	rejected bool
	done     *wire.XferDone
	msg      string
	code     int
}

// SendFileResult 汇报一次发送的结果。
type SendFileResult struct {
	// ID 是 transfer_id（hex）。界面用它把"结束"和"进度"对上号。
	ID   string
	Name string // 显示名（基名）
	Kind string // file | folder | image | app

	Path       string
	Size       int64
	Chunks     int
	SentChunks int // 实际发送的块数；断点续传时会小于 Chunks
	// Skipped：对方已有相同内容，整份跳过（秒传，0 字节）。SentChunks==0 区分不出"秒传"
	// 和"对方本来就收齐了"，界面措辞不同，所以单设字段。
	Skipped bool
	Elapsed time.Duration
}

// SendFile 把一个文件发给对端，支持断点续传。内存恒定为一个块大小，与文件大小无关。
// Progress 是一次传输的进度快照，收发共用一个结构，UI 只处理一种形状。
type Progress struct {
	// ID 是这次传输的 transfer_id（hex）。界面必须靠它配对进度和结束事件，不能靠「设备+文件名」：
	// 接收端进度用清单 RelPath，结束事件用落地真名，重名会变成 `报告 (1).pdf`，key 对不上，
	// 进度条就永远停在 99%。
	ID         string
	DeviceID   string
	DeviceName string
	Name       string // 显示名（基名，不含目录）
	Kind       string // file | folder | image
	Direction  string // send | recv
	Done       int64  // 已完成字节
	Total      int64  // 总字节
	Chunks     int    // 已完成分块
	TotalChunk int    // 总分块
	// Speed 是最近窗口的平均速度（字节/秒）。ETA 由界面用 Done/Total 自己算；放进协议会两端
	// 各算一份、显示不一致。
	Speed int64
}

// progressInterval 是两次进度回调的最小间隔。不能每块都回调：千兆网下 4 MB 块每秒几十块，
// 界面处理事件会卡顿；250 ms 对人眼已连续。
const progressInterval = 250 * time.Millisecond

// sendPipelineDepth 是「已备好、等写出」的块数上限。2 足够让读盘+算哈希与写网络重叠；
// 更大只会在暂停/取消时多占内存（每块一个 chunkSize 的帧），吞吐受限于较慢的一环。
const sendPipelineDepth = 2

// preparedChunk 是备料 goroutine 交给发送循环的一块。
// frame 已经是可以直接写出去的完整帧；err 非空表示备料中断（出错或被取消）。
type preparedChunk struct {
	frame []byte
	err   error
}

type chunkPrepParams struct {
	plan      []int
	snd       *transfer.FileSender
	chunkSize int
	tid       []byte
	ctl       *xferCtl
	sessDone  <-chan struct{}
	stop      <-chan struct{}
}

// startChunkPrep 起 goroutine 按 plan 顺序备料（读盘、算哈希、拼帧）。单独抽出便于直接测：
// 有三个独立出口（走完、备料出错、调用方提前 close(stop)），漏任一个会让 goroutine 永挂或
// channel 不关，都不报错、只表现为"传输卡住"。调用方必须在结束时 close(stop)；
// 返回的 channel 在备料结束时关闭。
func startChunkPrep(ctx context.Context, p chunkPrepParams) <-chan preparedChunk {
	out := make(chan preparedChunk, sendPipelineDepth)
	go func() {
		defer close(out)
		// 备料复用同一块读缓冲：buildChunkFrame 会把数据复制进新帧，帧拼好即可读下一块。
		// 缓冲不超过文件大小，避免上千个小文件各 new 一块 4 MiB 造成 GC 压力。
		bufSize := p.chunkSize
		if sz := p.snd.Size(); sz < int64(bufSize) {
			bufSize = int(sz)
		}
		buf := make([]byte, bufSize)
		leaves := p.snd.Digest().Leaves
		emit := func(pc preparedChunk) bool {
			select {
			case out <- pc:
				return true
			case <-p.stop:
				return false
			}
		}
		for _, idx := range p.plan {
			// 暂停就停在这里，取消就带着 ErrTransferCanceled 退出。
			// 仍然放在读块**之前**：暂停时不该还占着读缓冲继续往下读。
			if err := p.ctl.Gate(ctx, p.sessDone); err != nil {
				emit(preparedChunk{err: err})
				return
			}
			data, err := p.snd.ReadChunk(idx, buf)
			if err != nil {
				// 读到文件尾之前就 EOF：文件在摘要算完之后被截短了。
				if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
					err = fmt.Errorf("%w: %v", ErrSourceChanged, err)
				}
				emit(preparedChunk{err: err})
				return
			}
			// 块哈希本就要算（放进帧头供接收端核对），顺手与 offer 承诺的叶子比对。对不上说明源文件
			// 在摘要后被改，现在就停，免得发完几个 GB 再被整体校验整份丢弃。
			leaf := transfer.HashChunk(data)
			if idx < len(leaves) && !bytes.Equal(leaf, leaves[idx]) {
				emit(preparedChunk{err: fmt.Errorf("%w: 块 %d 的内容与摘要不符", ErrSourceChanged, idx)})
				return
			}
			frame, err := buildChunkFrameInto(&wire.ChunkHeader{
				TransferID: p.tid, FileIndex: 0, ChunkIndex: idx,
				ChunkLen: len(data), Hash: leaf,
			}, data)
			if err != nil {
				emit(preparedChunk{err: err})
				return
			}
			if !emit(preparedChunk{frame: frame}) {
				return
			}
		}
	}()
	return out
}

func (s *Session) SendFile(ctx context.Context, path string) (*SendFileResult, error) {
	return s.SendFileAs(ctx, path, filepath.Base(path))
}

// SendFileIn 以「文件夹里的一个文件」发送。relPath 带文件夹名（`报告/图表/第一章.png`），
// 接收端据此重建目录；offerKind 传 "folder" 让界面显示为「正在接收文件夹 报告」。
func (s *Session) SendFileIn(ctx context.Context, path, relPath, folder string) (*SendFileResult, error) {
	return s.sendFile(ctx, path, relPath, "folder", folder, FolderInfo{})
}

// SendFileInFolder 同 SendFileIn，并附带整个文件夹的概括（文件数、总字节），
// 让接收端的确认框能说清楚"这是一个多大的文件夹"。
func (s *Session) SendFileInFolder(ctx context.Context, path, relPath, folder string, info FolderInfo) (*SendFileResult, error) {
	return s.sendFile(ctx, path, relPath, "folder", folder, info)
}

// SendFileAs 以指定的相对路径发送文件（传文件夹时每个文件带各自的相对路径）。
// 接收端会独立清洗这个路径，发送端给什么都不会导致对方越界写盘。
func (s *Session) SendFileAs(ctx context.Context, path, relPath string) (*SendFileResult, error) {
	return s.sendFile(ctx, path, relPath, "file", "", FolderInfo{})
}

// sourceChangedRetries 是源文件在发送途中被改动时，最多发送的次数。
const sourceChangedRetries = 3

// sendFile 发一个文件；源文件途中被改动则重新算摘要再发，最多几次。正在写入的文件
// （日志、下载中、数据库）会让传输作废，此前表现为发完整个文件后接收端整体校验失败、整份丢弃。
func (s *Session) sendFile(ctx context.Context, path, relPath, offerKind, groupName string, fi FolderInfo) (*SendFileResult, error) {
	var lastErr error
	for attempt := 1; attempt <= sourceChangedRetries; attempt++ {
		res, err := s.sendFileOnce(ctx, path, relPath, offerKind, groupName, fi)
		if err == nil || !errors.Is(err, ErrSourceChanged) {
			return res, err
		}
		lastErr = err
		forgetDigest(path)
		// 等写入方告一段落再重算摘要；退避一点，别在一个持续写入的文件上空转。
		select {
		case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.done:
			return nil, errors.New("连接已断开")
		}
	}
	return nil, fmt.Errorf("%s 在传输期间一直在被修改，已尝试 %d 次: %w",
		filepath.Base(path), sourceChangedRetries, lastErr)
}

func (s *Session) sendFileOnce(ctx context.Context, path, relPath, offerKind, groupName string, fi FolderInfo) (*SendFileResult, error) {
	start := time.Now()
	// 块大小固定。不按带宽动态挑——那会换掉 Merkle 的切法，进而废掉断点续传，
	// 理由写在 transfer/merkle.go 里删掉 TuneChunkSize 的那段注释处。
	chunkSize := transfer.DefaultChunkSize

	snd, err := openSenderCached(path, chunkSize)
	if err != nil {
		return nil, err
	}
	defer snd.Close()

	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	tid, err := crypto.RandomBytes(16)
	if err != nil {
		return nil, err
	}
	key := hex.EncodeToString(tid)
	ch := s.registerWaiter(key)
	defer s.unregisterWaiter(key)

	// 显示名和种类在这里定一次，后面所有事件都用同一份——
	// 进度、结束、错误三种事件各自算一遍名字，迟早会算出三个不一样的结果。
	display := filepath.Base(path)
	kind := kindOfTransfer(offerKind, relPath)
	offerName := display
	if offerKind == "folder" && groupName != "" {
		offerName = groupName
	}

	// 登记进注册表，用户这才有得暂停/取消。
	// defer 摘除：不论是传完、出错还是被取消，这条控制块都不该留在界面上。
	ctl := newXferCtl(key, s.peer.DeviceID, s.PeerName(), "send", display, kind, snd.Size())
	s.node.xfers.add(ctl)
	// 摘除并通知界面这条已结束。不能省，也不能只靠上层 done/error 事件：那条错误事件在
	// SendFile 返回后才发，手里没有本函数生成的 transfer_id，界面按 id 删不掉那一行，
	// 进度条会永远停在出错的百分比。
	defer func() {
		s.node.xfers.remove(key)
		info := ctl.info()
		info.State = XferEnded
		s.node.emit(Event{Kind: "xfer_state", DeviceID: s.peer.DeviceID, Msg: XferEnded, Xfer: &info})
	}()

	offer := &wire.XferOffer{
		TransferID: tid,
		FileCount:  1,
		TotalSize:  snd.Size(),
		ChunkSize:  chunkSize,
		Kind:       offerKind,
		Name:       offerName,
		Manifest: []wire.FileEntry{{
			RelPath:    relPath,
			Size:       snd.Size(),
			MerkleRoot: snd.Root(),
			ModTimeMS:  st.ModTime().UnixMilli(),
			Mode:       uint32(st.Mode().Perm()),
		}},
	}
	// 文件夹里的文件：把整个文件夹规模报给对端，确认框显示「文件夹 · N 个文件 · M 字节」。
	// 接收端只用这两个字段做展示，实际收几个由后续 offer 决定。
	if fi.Files > 0 {
		offer.FileCount = fi.Files
		offer.TotalSize = fi.Bytes
	}
	if err := s.wc.WriteMsg(wire.TypeXferOffer, 0, offer); err != nil {
		return nil, err
	}

	var acc *wire.XferAccept
	select {
	case r := <-ch:
		if r.rejected {
			return nil, fmt.Errorf("%w（错误码 %d）: %s", ErrPeerRejected, r.code, r.msg)
		}
		acc = r.accept
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.done:
		return nil, errors.New("连接已断开")
	}

	total := snd.ChunkCount()

	// 秒传：对方已有相同内容。直接返回，既不发块也不发 XFER_DONE——接收端这条路上没登记
	// 接收任务，收到 XFER_DONE 会当成对我方发送内容的确认，去唤醒一个不存在的等待者。
	for _, idx := range acc.SkipFiles {
		if idx != 0 {
			continue
		}
		if s.node.cfg.OnProgress != nil {
			// 补一次 100% 的进度，否则界面上会留下一条永远停在 0% 的记录。
			s.node.cfg.OnProgress(Progress{
				ID: key, DeviceID: s.peer.DeviceID, DeviceName: s.PeerName(),
				Name: display, Kind: kind, Direction: "send",
				Done: snd.Size(), Total: snd.Size(),
				Chunks: total, TotalChunk: total,
			})
		}
		return &SendFileResult{
			ID: key, Name: display, Kind: kind,
			Path: path, Size: snd.Size(), Chunks: total,
			SentChunks: 0, Skipped: true, Elapsed: time.Since(start),
		}, nil
	}

	// 只发对方缺的块。首次传输时 bitmap 全 0，等于发全部。
	var have *transfer.Bitmap
	for _, hb := range acc.Have {
		if hb.FileIndex == 0 {
			if bm, err := transfer.UnmarshalBitmap(hb.Bitmap); err == nil && bm.Len() == total {
				have = bm
			}
		}
	}
	plan := transfer.PlanChunks(total, have)
	// 续传时对方已经有的块。进度要把它们算进去，否则续传的进度条从 0 爬起、
	// 最后停在"这次补了多少"上（比如 40%），然后整行消失，看起来像传坏了。
	already := total - len(plan)

	// 进度上报按时间节流，见 progressInterval 的说明。首块之前先报一次 0，
	// 让界面立刻出现进度条，而不是等第一个 250 ms 窗口过去才出现。
	lastReport := time.Time{}
	lastDone := int64(0)
	sentChunks := 0
	report := func(force bool) {
		if s.node.cfg.OnProgress == nil {
			return
		}
		now := time.Now()
		if !force && now.Sub(lastReport) < progressInterval {
			return
		}
		done := int64(already+sentChunks) * int64(chunkSize)
		if done > snd.Size() {
			done = snd.Size()
		}
		// 速度取相邻两次上报之间的增量。用「总量/总耗时」的话，暂停十分钟
		// 再继续，速度会显示成一个荒谬的小数字，而且很久都回不来。
		var speed int64
		if !lastReport.IsZero() {
			if el := now.Sub(lastReport).Seconds(); el > 0 {
				speed = int64(float64(done-lastDone) / el)
			}
		}
		lastReport, lastDone = now, done
		s.node.cfg.OnProgress(Progress{
			ID: key, DeviceID: s.peer.DeviceID, DeviceName: s.PeerName(),
			Name: display, Kind: kind, Direction: "send",
			Done: done, Total: snd.Size(),
			Chunks: already + sentChunks, TotalChunk: total, Speed: speed,
		})
	}
	report(true)

	// 备料与发送分两步：原先严格串行（读盘→哈希→拼帧→写网络），磁盘和网络轮流干等。
	// 现由一个 goroutine 专门备料、主循环只管写出，两件事重叠。前提是 buildChunkFrame
	// 会把数据复制进新帧缓冲，读缓冲不被在发的帧引用。顺序、协议、分块内容、Merkle 校验不变。
	stop := make(chan struct{})
	defer close(stop) // 主循环无论怎么退出，备料 goroutine 都跟着结束，不留悬挂
	prepared := startChunkPrep(ctx, chunkPrepParams{
		plan: plan, snd: snd, chunkSize: chunkSize, tid: tid,
		ctl: ctl, sessDone: s.done, stop: stop,
	})

	for pc := range prepared {
		if pc.err != nil {
			if errors.Is(pc.err, ErrTransferCanceled) || errors.Is(pc.err, ErrSourceChanged) {
				// 告诉对端别等了，让它把残片清掉。源文件被改动的情况下，
				// 残片对应的是旧摘要，留着只会占盘。
				s.sendXferStatus(key, "cancel")
			}
			return nil, pc.err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.done:
			return nil, errors.New("连接已断开")
		case r := <-ch:
			// 块在流动期间对端主动报失败（磁盘满了、目标被占用…）：立刻停。
			// 不停的话剩下的几个 GB 照样发完，对端一块都不会收。
			if r.done != nil && !r.done.OK {
				return nil, fmt.Errorf("对方中止了接收: %s", r.done.Msg)
			}
		default:
		}
		if err := s.wc.WriteFrame(&wire.Frame{Type: wire.TypeXferChunk, Payload: pc.frame}); err != nil {
			return nil, err
		}
		putFrameBuf(pc.frame)
		// 块写得出去，说明对端在消费（QUIC 流控会卡住不读的一方）。算作这条
		// 连接上有字节在动——见 heartbeatLoop 里对 recentlyActive 的使用。
		s.touch()
		sentChunks++
		report(false)
	}
	report(true) // 收尾时强制报一次，保证进度条走到 100% 而不是停在 97%

	if err := s.wc.WriteMsg(wire.TypeXferDone, 0, &wire.XferDone{TransferID: tid, OK: true}); err != nil {
		return nil, err
	}

	// 等对端确认。慢盘上收尾（刷盘、改名）耗时，耐心随文件大小增长：固定 5 分钟对 20 GB 不够，
	// 超时后发送端报失败而文件已落地，用户看到"失败了但文件在"。
	ackWait := 5*time.Minute + time.Duration(snd.Size()>>23)*time.Second
	timer := time.NewTimer(ackWait)
	defer timer.Stop()
	for {
		select {
		case r := <-ch:
			if r.done == nil {
				continue // 不是 XFER_DONE，继续等
			}
			if !r.done.OK {
				return nil, fmt.Errorf("对方校验失败: %s", r.done.Msg)
			}
			return &SendFileResult{
				ID: key, Name: display, Kind: kind,
				Path: path, Size: snd.Size(), Chunks: total,
				SentChunks: len(plan), Elapsed: time.Since(start),
			}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.done:
			return nil, errors.New("连接已断开")
		case <-timer.C:
			return nil, errors.New("等待对方确认超时")
		}
	}
}

// ---------- 应答等待 ----------

func (s *Session) registerWaiter(key string) chan *xferReply {
	ch := make(chan *xferReply, 4)
	s.xmu.Lock()
	if s.waiters == nil {
		s.waiters = make(map[string]chan *xferReply)
	}
	s.waiters[key] = ch
	s.xmu.Unlock()
	return ch
}

func (s *Session) unregisterWaiter(key string) {
	s.xmu.Lock()
	delete(s.waiters, key)
	s.xmu.Unlock()
}

func (s *Session) notifyXfer(tid []byte, r *xferReply) {
	key := hex.EncodeToString(tid)
	s.xmu.Lock()
	ch, ok := s.waiters[key]
	s.xmu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- r:
	default:
	}
}

// 分块帧格式：[u32 头长度][CBOR 头][原始数据]。数据不进 CBOR，省去几 MB 的编解码与拷贝。

func buildChunkFrame(h *wire.ChunkHeader, data []byte) ([]byte, error) {
	hb, err := wire.Marshal(h)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 4+len(hb)+len(data))
	binary.BigEndian.PutUint32(out, uint32(len(hb)))
	copy(out[4:], hb)
	copy(out[4+len(hb):], data)
	return out, nil
}

// buildChunkFrameInto 同 buildChunkFrame，但帧缓冲取自 framePool。
// 帧写完之后调用方负责 putFrameBuf 还回去。
func buildChunkFrameInto(h *wire.ChunkHeader, data []byte) ([]byte, error) {
	hb, err := wire.Marshal(h)
	if err != nil {
		return nil, err
	}
	out := getFrameBuf(4 + len(hb) + len(data))
	binary.BigEndian.PutUint32(out, uint32(len(hb)))
	copy(out[4:], hb)
	copy(out[4+len(hb):], data)
	return out, nil
}

func splitChunkFrame(p []byte) (*wire.ChunkHeader, []byte, error) {
	if len(p) < 4 {
		return nil, nil, errors.New("分块帧过短")
	}
	n := int(binary.BigEndian.Uint32(p))
	if n <= 0 || 4+n > len(p) {
		return nil, nil, errors.New("分块帧头长度非法")
	}
	var h wire.ChunkHeader
	if err := wire.Unmarshal(p[4:4+n], &h); err != nil {
		return nil, nil, err
	}
	data := p[4+n:]
	if h.ChunkLen != len(data) {
		return nil, nil, fmt.Errorf("分块长度不符：头称 %d，实际 %d", h.ChunkLen, len(data))
	}
	return &h, data, nil
}
