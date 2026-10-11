package transfer

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const (
	partSuffix  = ".cbpart"
	stateSuffix = ".cbstate"

	// persistEvery 是后台协程把数据 + 进度位图刷盘的周期，决定进程被杀后最多回退两秒内的块。
	// 刷盘不能在收块路径上做：fsync 几十毫秒到几秒，曾每 16 块在 WriteChunk（会话读循环内）
	// 同步 fsync，刷盘期间网络一字节不读，吞吐被拖住，心跳回声也停。
	persistEvery = 2 * time.Second
)

var (
	ErrChunkHashMismatch = errors.New("分块校验失败")
	ErrRootMismatch      = errors.New("文件整体校验失败：Merkle 根不匹配")
	ErrChunkRange        = errors.New("分块索引越界")
	ErrNotComplete       = errors.New("仍有分块未收到")
)

// FileReceiver 接收单个文件，支持断点续传。先写 <目标>.cbpart，收齐并校验 Merkle 根后
// 原子 rename，磁盘上不会出现"看起来完整其实只有一半"的文件。
type FileReceiver struct {
	mu sync.Mutex

	destPath  string
	partPath  string
	statePath string

	size      int64
	chunkSize int
	leaves    [][]byte
	root      []byte

	f      *os.File
	bitmap *Bitmap

	// got[i] 是本次会话第 i 块写盘时顺手算出的哈希；nil 表示该块是上次会话留下的（位图有但
	// 哈希不在手上），Finish 时从磁盘读回补算。最终 Merkle 根由它们拼出，不必收完再整文件重读
	// （曾在读循环里跑，几 GB 要几十秒，心跳停摆，发送端三次没回音就断连）。
	got [][]byte

	sinceSync int
	closed    bool

	// shut 与 closed 同步置位，可不拿 mu 读：后台刷盘协程靠它判断接收器已收尾、别再写状态文件，
	// 避免 Finish 删掉状态文件后又写回一份满位图的陈旧状态（会让下次同名接收误以为全部已到）。
	shut    atomic.Bool
	stateMu sync.Mutex // 串行化状态文件的写入与删除
	// stateMaybe 表示磁盘上可能有这个接收的状态文件（续传时读过、或这次写过）。
	// 没有的话收尾就不必白白去删两个不存在的文件。受 stateMu 保护。
	stateMaybe  bool
	stopOnce    sync.Once
	stopPersist chan struct{}
}

// OpenReceiver 打开（或续上）一个接收任务。leaves 是发送端给的每块哈希，可为 nil，
// 此时只在最后比对整体 Merkle 根、失去边收边验，故仅在发送端未提供分块哈希时才如此。
func OpenReceiver(destPath string, size int64, chunkSize int, leaves [][]byte, root []byte) (*FileReceiver, error) {
	if chunkSize < MinChunkSize && size > int64(chunkSize) {
		// 允许小文件用小块，但不允许异常小的块大小把一个大文件切成几百万块。
		if ChunkCount(size, chunkSize) > 1<<22 {
			return nil, fmt.Errorf("块大小 %d 对 %d 字节的文件过小", chunkSize, size)
		}
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建目标目录失败: %w", err)
	}

	r := &FileReceiver{
		destPath:  destPath,
		partPath:  destPath + partSuffix,
		statePath: destPath + stateSuffix,
		size:      size,
		chunkSize: chunkSize,
		leaves:    leaves,
		root:      root,

		stopPersist: make(chan struct{}),
	}
	n := ChunkCount(size, chunkSize)

	// 先用 O_EXCL 新建：成功说明是全新接收、不可能有可续传进度，不必探测状态文件
	// （文件夹里几千个小文件各省几次系统调用）；已存在才退回普通打开并读回进度。
	fresh := true
	f, err := os.OpenFile(r.partPath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		fresh = false
		f, err = os.OpenFile(r.partPath, os.O_RDWR|os.O_CREATE, 0o600)
	}
	if err != nil {
		return nil, fmt.Errorf("创建临时文件失败: %w", err)
	}
	r.f = f
	// 预分配：提前暴露"磁盘空间不够"，而不是传到 90% 才失败。
	if err := f.Truncate(size); err != nil {
		f.Close()
		return nil, fmt.Errorf("预分配 %d 字节失败（磁盘空间可能不足）: %w", size, err)
	}

	if fresh {
		r.bitmap = NewBitmap(n)
	} else {
		r.bitmap = r.loadState(n)
		r.stateMaybe = true
	}
	r.got = make([][]byte, n)
	go r.persistLoop()
	return r, nil
}

// 状态文件头：[u64 size][u32 chunkSize][u32 rootLen][root...]，其后是位图。
// 必须写入 Merkle 根：只比 (size, chunkSize) 不够，同名同大小的另一份内容（重新构建的
// 安装包）会命中，上次的旧块被当新文件的块留下，最后整体校验必败且莫名其妙。
// 根不同即另一份内容，旧进度全部作废。
const stateHeaderLen = 16

// loadState 尝试恢复已有进度；任何异常都退化为"从头开始"，不冒险采信坏状态。
func (r *FileReceiver) loadState(n int) *Bitmap {
	b, err := os.ReadFile(r.statePath)
	if err != nil || len(b) < stateHeaderLen {
		return NewBitmap(n)
	}
	if int64(binary.BigEndian.Uint64(b[:8])) != r.size ||
		int(binary.BigEndian.Uint32(b[8:12])) != r.chunkSize {
		return NewBitmap(n)
	}
	rootLen := int(binary.BigEndian.Uint32(b[12:16]))
	if rootLen < 0 || stateHeaderLen+rootLen > len(b) {
		return NewBitmap(n)
	}
	if !eq(b[stateHeaderLen:stateHeaderLen+rootLen], r.root) {
		return NewBitmap(n)
	}
	bm, err := UnmarshalBitmap(b[stateHeaderLen+rootLen:])
	if err != nil || bm.Len() != n {
		return NewBitmap(n)
	}
	return bm
}

// Bitmap 返回当前进度位图，重连时发给发送端以便只补缺失块。
func (r *FileReceiver) Bitmap() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bitmap.Marshal()
}

// Missing 返回仍缺失的块索引。
func (r *FileReceiver) Missing() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bitmap.Missing()
}

// Progress 返回 (已收字节, 总字节)。
func (r *FileReceiver) Progress() (int64, int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	done := int64(r.bitmap.Count()) * int64(r.chunkSize)
	if done > r.size {
		done = r.size
	}
	return done, r.size
}

// WriteChunk 写入一块。已经有的块直接跳过（幂等），
// 这保证了重复消息不会造成重复写入或进度错乱。
func (r *FileReceiver) WriteChunk(index int, data []byte) error {
	return r.WriteChunkHashed(index, data, nil)
}

// WriteChunkHashed 同 WriteChunk，但可传入已算好的块哈希：收块路径本就要算一次
// （核对发送端报的值），WriteChunk 内部重算对 4 MiB 块是白白多读一遍。leaf 为 nil 才自己算。
func (r *FileReceiver) WriteChunkHashed(index int, data, leaf []byte) error {
	// 哈希放在锁外算：持锁算 4 MiB 的哈希会让 Progress()/Bitmap() 这类
	// 只读查询跟着排队。
	if leaf == nil {
		leaf = HashChunk(data)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("接收器已关闭")
	}
	if index < 0 || index >= r.bitmap.Len() {
		return fmt.Errorf("%w: %d (共 %d 块)", ErrChunkRange, index, r.bitmap.Len())
	}
	if r.bitmap.Has(index) {
		return nil
	}

	off := int64(index) * int64(r.chunkSize)
	want := r.chunkSize
	if rem := r.size - off; rem < int64(want) {
		want = int(rem)
	}
	if len(data) != want {
		return fmt.Errorf("分块 %d 长度错误：期望 %d，实际 %d", index, want, len(data))
	}

	// 边收边验：坏块当场拒绝，不写盘、不置位，发送端会重传。
	if r.leaves != nil && index < len(r.leaves) {
		if !eq(leaf, r.leaves[index]) {
			return fmt.Errorf("%w: 分块 %d", ErrChunkHashMismatch, index)
		}
	}

	if _, err := r.f.WriteAt(data, off); err != nil {
		return fmt.Errorf("写入分块 %d 失败: %w", index, err)
	}
	r.bitmap.Set(index)
	r.got[index] = leaf
	r.sinceSync++
	return nil
}

// snapshotLocked 序列化当前进度：[头][根][位图]。
func (r *FileReceiver) snapshotLocked() []byte {
	hdr := make([]byte, stateHeaderLen+len(r.root))
	binary.BigEndian.PutUint64(hdr, uint64(r.size))
	binary.BigEndian.PutUint32(hdr[8:], uint32(r.chunkSize))
	binary.BigEndian.PutUint32(hdr[12:], uint32(len(r.root)))
	copy(hdr[stateHeaderLen:], r.root)
	return append(hdr, r.bitmap.Marshal()...)
}

// writeState 原子替换状态文件：进程恰在写时被杀，半个状态文件会让下次恢复读到错误进度。
// 持 stateMu 且先看 shut——接收器收尾后后台协程不许再写回状态文件。
func (r *FileReceiver) writeState(buf []byte) error {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	if r.shut.Load() {
		return nil
	}
	r.stateMaybe = true
	tmp := r.statePath + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o600); err != nil {
		return fmt.Errorf("写入进度状态失败: %w", err)
	}
	if err := os.Rename(tmp, r.statePath); err != nil {
		return fmt.Errorf("替换进度状态失败: %w", err)
	}
	return nil
}

// syncLocked 同步刷盘并落状态。只在 Abort / Finish 这类"本来就要停下"的地方用，
// 收块的热路径走 persistLoop。
func (r *FileReceiver) syncLocked() error {
	if err := r.f.Sync(); err != nil {
		return fmt.Errorf("刷盘失败: %w", err)
	}
	if err := r.writeState(r.snapshotLocked()); err != nil {
		return err
	}
	r.sinceSync = 0
	return nil
}

// persistLoop 周期性地把数据与进度刷到盘上，直到接收器收尾。
func (r *FileReceiver) persistLoop() {
	t := time.NewTicker(persistEvery)
	defer t.Stop()
	for {
		select {
		case <-r.stopPersist:
			return
		case <-t.C:
			r.persistOnce()
		}
	}
}

// persistOnce 做一次后台刷盘。顺序是关键：先取位图快照，再 fsync 数据，最后写状态。
// 状态里只含快照时已写入的块，且它们随后的 fsync 已落盘；反过来掉电后状态会声称有未落盘的块。
func (r *FileReceiver) persistOnce() {
	r.mu.Lock()
	if r.closed || r.sinceSync == 0 {
		r.mu.Unlock()
		return
	}
	snap := r.snapshotLocked()
	pending := r.sinceSync
	f := r.f
	r.mu.Unlock()

	if err := f.Sync(); err != nil {
		return // 句柄在途中被 Finish/Abort 关了，或盘有问题；收尾路径会自己处理
	}
	if err := r.writeState(snap); err != nil {
		return
	}
	r.mu.Lock()
	if r.sinceSync >= pending {
		r.sinceSync -= pending
	} else {
		r.sinceSync = 0
	}
	r.mu.Unlock()
}

// Sync 强制把进度落盘（暂停、断连、程序退出前调用）。
func (r *FileReceiver) Sync() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	return r.syncLocked()
}

// Finish 校验完整性并原子落地。无论成败返回时句柄必已关闭：Windows 上句柄不关 .cbpart
// 就被锁，重命名删除都做不了，一次失败会把文件永久卡死。调用方不要在会话读循环里直接调：
// fsync 加读回续传的块，慢盘上可达几十秒。
func (r *FileReceiver) Finish() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("接收器已关闭")
	}
	if !r.bitmap.Complete() {
		// 不完整不算"坏"，只是还没传完——保留 .cbpart 与进度，下次接着补。
		err := fmt.Errorf("%w: %d/%d", ErrNotComplete, r.bitmap.Count(), r.bitmap.Len())
		_ = r.syncLocked()
		r.closeHandleLocked()
		return err
	}
	if err := r.f.Sync(); err != nil {
		r.closeHandleLocked()
		return err
	}

	// 最终整体校验：用每一块写盘时算出的哈希拼 Merkle 根，只把「上次会话留下、
	// 这次没经手」的那些块从磁盘读回来补算。
	if r.root != nil {
		leaves, err := r.collectLeavesLocked()
		if err != nil {
			r.closeHandleLocked()
			return err
		}
		if got := MerkleRoot(leaves); !eq(got, r.root) {
			// 内容确实是错的。残骸必须整份丢掉——留着的话，位图是满的，
			// 下一次重试会"瞬间完成"再报同一个错，一个字节都不会重传。
			r.discardLocked()
			return ErrRootMismatch
		}
	}

	r.shutLocked()
	if err := r.f.Close(); err != nil {
		r.closed = true
		return err
	}
	r.closed = true

	final, err := uniquePath(r.destPath)
	if err != nil {
		return err
	}
	if err := os.Rename(r.partPath, final); err != nil {
		return fmt.Errorf("落地文件失败: %w", err)
	}
	r.destPath = final
	r.removeStateFile()
	return nil
}

// shutLocked 标记收尾并让后台刷盘协程退出。之后 writeState 一律空操作。
func (r *FileReceiver) shutLocked() {
	r.shut.Store(true)
	r.stopOnce.Do(func() { close(r.stopPersist) })
}

// removeStateFile 删掉状态文件。持 stateMu 是为了等一个已经通过 shut 检查、
// 正在写文件的 writeState 先写完，不然它的 rename 会在我们删除之后把文件放回来。
func (r *FileReceiver) removeStateFile() {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	if !r.stateMaybe {
		return
	}
	_ = os.Remove(r.statePath)
	_ = os.Remove(r.statePath + ".tmp")
}

// closeHandleLocked 关句柄但保留残片，供下次续传。
func (r *FileReceiver) closeHandleLocked() {
	r.shutLocked()
	_ = r.f.Close()
	r.closed = true
}

// discardLocked 关句柄并把残片和进度一起删掉，让下一次从零开始。
func (r *FileReceiver) discardLocked() {
	r.closeHandleLocked()
	_ = os.Remove(r.partPath)
	r.removeStateFile()
}

// FinalPath 返回实际落地的路径（可能因同名冲突而改过名）。
func (r *FileReceiver) FinalPath() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.destPath
}

// collectLeavesLocked 凑齐全部块哈希：本次会话经手的取内存值，其余（续传继承的）从磁盘
// 读回重算，保住"不信任上次留下的位图，以磁盘真实内容为准"的规矩。
func (r *FileReceiver) collectLeavesLocked() ([][]byte, error) {
	n := r.bitmap.Len()
	leaves := make([][]byte, n)
	var buf []byte
	for i := 0; i < n; i++ {
		if r.got[i] != nil {
			leaves[i] = r.got[i]
			continue
		}
		if buf == nil {
			buf = make([]byte, r.chunkSize)
		}
		off := int64(i) * int64(r.chunkSize)
		sz := r.chunkSize
		if rem := r.size - off; rem < int64(sz) {
			sz = int(rem)
		}
		if _, err := r.f.ReadAt(buf[:sz], off); err != nil {
			return nil, fmt.Errorf("校验读取失败: %w", err)
		}
		leaves[i] = HashChunk(buf[:sz])
	}
	return leaves, nil
}

// Abort 放弃接收。keepPartial=true 时保留 .cbpart 以便下次续传。
func (r *FileReceiver) Abort(keepPartial bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	if keepPartial {
		// 先落一次盘再收尾：此时还没 shut，writeState 才会真的写。
		_ = r.syncLocked()
		r.shutLocked()
		r.closed = true
		return r.f.Close()
	}
	r.shutLocked()
	r.closed = true
	_ = r.f.Close()
	_ = os.Remove(r.partPath)
	r.removeStateFile()
	return nil
}

// uniquePath 处理同名冲突：a.txt → a (1).txt → a (2).txt。
// 绝不静默覆盖已有文件——覆盖是用户数据丢失的常见来源。
func uniquePath(p string) (string, error) {
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p, nil
	}
	dir := filepath.Dir(p)
	base := filepath.Base(p)
	ext := filepath.Ext(base)
	stem := base[:len(base)-len(ext)]
	for i := 1; i < 10000; i++ {
		cand := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		if _, err := os.Stat(cand); os.IsNotExist(err) {
			return cand, nil
		}
	}
	return "", errors.New("同名文件过多，无法生成唯一文件名")
}

func eq(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
