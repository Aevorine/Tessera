package transfer

import (
	"fmt"
	"os"
	"sync"
)

// FileSender 按需从磁盘读块。绝不把整个文件读进内存：20 GB 文件也只占一个块大小。
type FileSender struct {
	mu sync.Mutex

	path   string
	f      *os.File
	digest *FileDigest
}

// OpenSender 打开待发文件并计算分块摘要。摘要要整文件读一遍，开销可观，调用方应按
// 路径+大小+mtime 缓存，重复发送时复用，这也是秒传的前提。
func OpenSender(path string, chunkSize int) (*FileSender, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开文件失败: %w", err)
	}
	d, err := digestOpenFile(f, chunkSize)
	if err != nil {
		f.Close()
		return nil, err
	}
	return &FileSender{path: path, f: f, digest: d}, nil
}

// OpenSenderWithDigest 用已算好的摘要打开文件，跳过整文件读取。调用方负责保证摘要对应
// 该内容（按 路径+大小+mtime 缓存）；这里只做最便宜的核对：长度对不上就拒绝，让调用方重算。
func OpenSenderWithDigest(path string, d *FileDigest) (*FileSender, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开文件失败: %w", err)
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() || st.Size() != d.Size {
		f.Close()
		return nil, fmt.Errorf("缓存的摘要与文件不符: %s", path)
	}
	return &FileSender{path: path, f: f, digest: d}, nil
}

func (s *FileSender) Digest() *FileDigest { return s.digest }
func (s *FileSender) Size() int64         { return s.digest.Size }
func (s *FileSender) ChunkSize() int      { return s.digest.ChunkSize }
func (s *FileSender) ChunkCount() int     { return len(s.digest.Leaves) }
func (s *FileSender) Root() []byte        { return s.digest.Root }

// ReadChunk 读取第 index 块。buf 由调用方复用，避免每块都分配 4 MB。
func (s *FileSender) ReadChunk(index int, buf []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if index < 0 || index >= len(s.digest.Leaves) {
		return nil, fmt.Errorf("%w: %d", ErrChunkRange, index)
	}
	off := int64(index) * int64(s.digest.ChunkSize)
	n := s.digest.ChunkSize
	if rem := s.digest.Size - off; rem < int64(n) {
		n = int(rem)
	}
	if cap(buf) < n {
		buf = make([]byte, n)
	}
	buf = buf[:n]
	if _, err := s.f.ReadAt(buf, off); err != nil {
		return nil, fmt.Errorf("读取分块 %d 失败: %w", index, err)
	}
	return buf, nil
}

func (s *FileSender) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.f.Close()
}

// PlanChunks 根据接收端的位图算出还需要发哪些块。
// 位图为空（全新传输）时返回全部块。
func PlanChunks(total int, have *Bitmap) []int {
	if have == nil {
		out := make([]int, total)
		for i := range out {
			out[i] = i
		}
		return out
	}
	var out []int
	for i := 0; i < total; i++ {
		if !have.Has(i) {
			out = append(out, i)
		}
	}
	return out
}
