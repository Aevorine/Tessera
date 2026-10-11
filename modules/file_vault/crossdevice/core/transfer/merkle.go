// Package transfer 实现分块文件传输：Merkle 校验、位图断点续传、路径安全。
// 设计见 docs/01-架构与技术原理.md §10。
package transfer

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"lukechampine.com/blake3"
)

const (
	DefaultChunkSize = 4 << 20 // 4 MiB
	MinChunkSize     = 1 << 20
	MaxChunkSize     = 16 << 20
)

// ChunkCount 计算文件按给定块大小切成多少块。
func ChunkCount(size int64, chunkSize int) int {
	if size == 0 {
		return 0
	}
	return int((size + int64(chunkSize) - 1) / int64(chunkSize))
}

// 不要加回按带宽自适应的块大小（曾有从未被调用的 TuneChunkSize，已删）：块大小是 Merkle 树
// 的切法，改它就换了内容标识；断点续传状态绑在 Merkle 根上（见 receiver.go），4 MiB 与
// 16 MiB 切出的根不同，续传时接收端判定非同一内容并丢弃已收部分，不报错，大文件更易中招。
// 动态块大小只摊薄微不足道的每块开销，却牺牲续传。真正的吞吐提升在发送流水线
// （node/sendfile.go 的 startChunkPrep），不改切法。
// Min/MaxChunkSize 保留作为 OpenReceiver/OpenSender 的合法性校验边界。

// HashChunk 计算单块哈希，作为 Merkle 树的叶子。
func HashChunk(data []byte) []byte {
	sum := blake3.Sum256(data)
	return sum[:]
}

// MerkleRoot 由叶子哈希自底向上算根。选 Merkle 而非整文件 SHA-256：可边传边验，
// 只重传坏块，并可先比根做秒传去重。
func MerkleRoot(leaves [][]byte) []byte {
	if len(leaves) == 0 {
		sum := blake3.Sum256(nil)
		return sum[:]
	}
	level := make([][]byte, len(leaves))
	copy(level, leaves)
	for len(level) > 1 {
		next := make([][]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			if i+1 == len(level) {
				// 奇数个节点时最后一个直接上提，而不是和自己配对——
				// 自配对会让 [a,b,c] 和 [a,b,c,c] 算出同一个根（第二原像问题）。
				next = append(next, level[i])
				continue
			}
			h := blake3.New(32, nil)
			h.Write([]byte{0x01}) // 内部节点前缀，与叶子域分离
			h.Write(level[i])
			h.Write(level[i+1])
			next = append(next, h.Sum(nil))
		}
		level = next
	}
	return level[0]
}

// FileDigest 是一个文件的分块摘要。
type FileDigest struct {
	Size      int64
	ChunkSize int
	Leaves    [][]byte
	Root      []byte
}

// DigestFile 流式读取文件并算出每块哈希与 Merkle 根。
// 全程只占用一个块大小的内存，20 GB 文件也不会撑爆。
func DigestFile(path string, chunkSize int) (*FileDigest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开文件失败: %w", err)
	}
	defer f.Close()
	return digestOpenFile(f, chunkSize)
}

// digestOpenFile 对已打开的文件算分块摘要（从头读，不关）。让 OpenSender 只开一次文件：
// 此前先 DigestFile 开读再关、再 os.Open，文件夹里几千个小文件各多一次系统调用。
func digestOpenFile(f *os.File, chunkSize int) (*FileDigest, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	d := &FileDigest{Size: st.Size(), ChunkSize: chunkSize}
	// 缓冲不超过文件本身：小文件不必为 4 MiB 的块分配一块 4 MiB 的内存。
	bufSize := chunkSize
	if st.Size() < int64(bufSize) {
		bufSize = int(st.Size())
	}
	if bufSize == 0 {
		d.Root = MerkleRoot(nil)
		return d, nil
	}
	buf := make([]byte, bufSize)
	var off int64
	for {
		n, err := f.ReadAt(buf, off)
		if n > 0 {
			d.Leaves = append(d.Leaves, HashChunk(buf[:n]))
			off += int64(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("读取文件失败: %w", err)
		}
		if n == 0 {
			break
		}
	}
	d.Size = off // 以真正读到的字节数为准：stat 之后文件可能又变了
	d.Root = MerkleRoot(d.Leaves)
	return d, nil
}

// FindIdentical 在目标位置附近找内容与 root 相同的已有文件，是秒传的判据：最常见的重发是
// 同一文件又发一遍。先 stat 再算哈希（长度不同必非同一份；只有长度撞上才读文件算根）。
// 除目标路径外还要看 uniquePath 的改名变体（`a (1).apk`），否则原位有同名异内容文件时，
// 第一次落到 `a (1).apk`，第二次仍只比对 `a.apk` 不匹配，又落 `a (2).apk`，越发越多。
func FindIdentical(destPath string, size int64, chunkSize int, root []byte) (string, bool) {
	if len(root) == 0 || chunkSize <= 0 {
		return "", false
	}
	// 目标位置本身不存在就没有"已有一份"，绝大多数新文件如此，只花一次 stat。改名变体只在
	// 原名被占用时才产生，原名不存在就不逐个试（此前每个新文件白白 stat 九次）。
	if st, err := os.Stat(destPath); err != nil || st.IsDir() {
		return "", false
	}
	for _, cand := range candidatePaths(destPath) {
		st, err := os.Stat(cand)
		if err != nil || st.IsDir() || st.Size() != size {
			continue
		}
		d, err := DigestFile(cand, chunkSize)
		if err != nil {
			continue
		}
		if eq(d.Root, root) {
			return cand, true
		}
	}
	return "", false
}

// candidatePaths 列出 uniquePath 可能已经用掉的那些名字。
// 上限刻意很小：真出现十几份同名文件时，多读几个大文件的代价开始压过收益。
func candidatePaths(destPath string) []string {
	const variants = 8
	out := make([]string, 0, variants+1)
	out = append(out, destPath)
	dir := filepath.Dir(destPath)
	base := filepath.Base(destPath)
	ext := filepath.Ext(base)
	stem := base[:len(base)-len(ext)]
	for i := 1; i <= variants; i++ {
		out = append(out, filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext)))
	}
	return out
}

// ---------- 位图 ----------

// Bitmap 记录"哪些块已经收到"，是断点续传的载体。
// 20 GB / 4 MB = 5120 块 = 640 字节，重连时发过去几乎不占带宽。
type Bitmap struct {
	n    int
	bits []byte
}

func NewBitmap(n int) *Bitmap {
	return &Bitmap{n: n, bits: make([]byte, (n+7)/8)}
}

func (b *Bitmap) Len() int { return b.n }

func (b *Bitmap) Set(i int) {
	if i < 0 || i >= b.n {
		return
	}
	b.bits[i/8] |= 1 << uint(i%8)
}

func (b *Bitmap) Has(i int) bool {
	if i < 0 || i >= b.n {
		return false
	}
	return b.bits[i/8]&(1<<uint(i%8)) != 0
}

// Count 返回已置位数量。
func (b *Bitmap) Count() int {
	n := 0
	for i := 0; i < b.n; i++ {
		if b.Has(i) {
			n++
		}
	}
	return n
}

func (b *Bitmap) Complete() bool { return b.Count() == b.n }

// Missing 返回所有缺失块的索引，发送端据此只发这些块。
func (b *Bitmap) Missing() []int {
	var out []int
	for i := 0; i < b.n; i++ {
		if !b.Has(i) {
			out = append(out, i)
		}
	}
	return out
}

// Marshal 序列化为 [u32 块数][位图字节]。
func (b *Bitmap) Marshal() []byte {
	out := make([]byte, 4+len(b.bits))
	binary.BigEndian.PutUint32(out, uint32(b.n))
	copy(out[4:], b.bits)
	return out
}

var ErrBadBitmap = errors.New("位图数据损坏")

func UnmarshalBitmap(p []byte) (*Bitmap, error) {
	if len(p) < 4 {
		return nil, ErrBadBitmap
	}
	n := int(binary.BigEndian.Uint32(p))
	if n < 0 || (n+7)/8 != len(p)-4 {
		return nil, ErrBadBitmap
	}
	b := &Bitmap{n: n, bits: make([]byte, len(p)-4)}
	copy(b.bits, p[4:])
	return b, nil
}
