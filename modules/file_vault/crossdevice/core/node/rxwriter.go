package node

import (
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/transfer"
	"github.com/Aevorine/Tessera/crossdevice/core/wire"
)

// rxQueueDepth 是读循环与写盘协程之间排队的块数。原先读循环自己算哈希、写盘，网络读与磁盘写轮流
// 干等：手机 UFS 上写一块 4 MiB 加 BLAKE3 要十几到几十毫秒，这段时间 QUIC 流不被读，流控窗口很快
// 填满，发送端随之停摆。排 4 块（≤16 MiB 内存）就能把两边重叠起来；再多只是多占内存，吞吐受限于
// 较慢的一环。满了读循环会阻塞，等于把背压原样交还给 QUIC 流控，不会无限堆内存。
const rxQueueDepth = 4

type rxChunk struct {
	hdr  *wire.ChunkHeader
	data []byte // 指向 ReadFrame 新分配的帧缓冲，交出后读循环不再碰它
}

// rxWriter 是一次接收的写盘协程。三种结束：
//   - close()：发送端报完（XFER_DONE），写完队列里剩下的块再结束，finishRecv 等它；
//   - stop()：取消、失败、会话断开，丢掉剩余块立即结束；
//   - 会话 done：同 stop。
type rxWriter struct {
	q         chan rxChunk
	closeOnce sync.Once
	stopOnce  sync.Once
	stopped   chan struct{}
	finished  chan struct{}
}

// writerFor 取（必要时启动）这次接收的写盘协程。只在读循环里调用，所以惰性创建不需要额外的锁之外的同步；
// 用 rt 自带的 once 是为了 abort 路径在别的协程里也能安全地 stop。
func (s *Session) writerFor(key string, rt *recvTransfer) *rxWriter {
	rt.wOnce.Do(func() {
		w := &rxWriter{
			q:        make(chan rxChunk, rxQueueDepth),
			stopped:  make(chan struct{}),
			finished: make(chan struct{}),
		}
		rt.writer = w
		go s.runRxWriter(key, rt, w)
	})
	return rt.writer
}

// enqueue 把一块交给写盘协程；写盘协程已停止或会话断开时直接丢弃（这次接收已经作废）。
func (s *Session) enqueue(w *rxWriter, c rxChunk) {
	select {
	case w.q <- c:
	case <-w.stopped:
	case <-s.done:
	}
}

func (w *rxWriter) close() { w.closeOnce.Do(func() { close(w.q) }) }
func (w *rxWriter) stop()  { w.stopOnce.Do(func() { close(w.stopped) }) }

// wait 等写盘协程把已排队的块全部落盘（或因停止/断线退出）。
func (w *rxWriter) wait(sessDone <-chan struct{}) {
	select {
	case <-w.finished:
	case <-sessDone:
	}
}

// stopWriter 在任何「这次接收不要了」的路径上调用；没启动过写盘协程就什么也不做。
func (rt *recvTransfer) stopWriter() {
	rt.wOnce.Do(func() {}) // 之后不会再启动
	if rt.writer != nil {
		rt.writer.stop()
	}
}

// closeWriter 在 XFER_DONE 到达时调用：不再有新块，写完剩下的就结束。
func (rt *recvTransfer) closeWriter() {
	rt.wOnce.Do(func() {})
	if rt.writer != nil {
		rt.writer.close()
	}
}

// waitWriter 供 finishRecv 在核对之前调用，确保最后几块已经写进文件。
func (rt *recvTransfer) waitWriter(sessDone <-chan struct{}) {
	if rt.writer != nil {
		rt.writer.wait(sessDone)
	}
}

func (s *Session) runRxWriter(key string, rt *recvTransfer, w *rxWriter) {
	defer close(w.finished)
	failed := false
	for {
		var c rxChunk
		var ok bool
		select {
		case c, ok = <-w.q:
			if !ok {
				return
			}
		case <-w.stopped:
			return
		case <-s.done:
			return
		}
		if failed {
			continue // 写盘已失败：剩下的块只消费不处理，读循环不至于卡住
		}
		if err := s.writeRxChunk(key, rt, c); err != nil {
			failed = true
			s.failRecvTransfer(key, rt, err)
		}
	}
}

// writeRxChunk 是原 onXferChunk 的后半段：核对哈希 → 写盘 → 进度。返回非 nil 表示写盘失败，
// 这次接收要整体中止；坏块（哈希不符）只回错误让发送端重传，不算写盘失败。
func (s *Session) writeRxChunk(key string, rt *recvTransfer, c rxChunk) error {
	hdr, data := c.hdr, c.data
	// 块哈希只算这一次：既用来核对发送端报的值，也交给接收器记在账上——
	// 收完之后的整体校验直接用它们拼 Merkle 根，不用再读一遍盘。
	leaf := transfer.HashChunk(data)
	if hdr.Hash != nil && !eqBytes(leaf, hdr.Hash) {
		_ = s.wc.WriteMsg(wire.TypeError, 0, &wire.Error{
			Code: wire.ErrCodeBadChunk, Msg: fmt.Sprintf("分块 %d 校验失败", hdr.ChunkIndex),
			Ref: hdr.TransferID,
		})
		return nil
	}
	if err := rt.recv.WriteChunkHashed(hdr.ChunkIndex, data, leaf); err != nil {
		// 写盘失败（磁盘满、目标被占用…）不会自愈，后面每块都会同样失败。当场告诉发送端让它停，
		// 否则它会把剩下的几个 GB 照发，最后只收到莫名的"仍有分块未收到"。
		return err
	}

	rt.gotChunks++
	if cb := s.node.cfg.OnProgress; cb != nil {
		now := time.Now()
		if now.Sub(rt.lastReport) >= progressInterval {
			// 已完成字节取接收器位图里已有的全部块，不是本次会话收到的块数：续传时前面的块不再重传，
			// 只数本次的话进度会从 0 重爬且永远到不了 100%。
			done, _ := rt.recv.Progress()
			var speed int64
			if !rt.lastReport.IsZero() {
				if el := now.Sub(rt.lastReport).Seconds(); el > 0 {
					speed = int64(float64(done-rt.lastDone) / el)
				}
			}
			rt.lastReport, rt.lastDone = now, done
			total := rt.totalChunks
			have := total - len(rt.recv.Missing())
			cb(Progress{
				ID: hex.EncodeToString(hdr.TransferID),
				// 名字用**显示名**：RelPath 在传文件夹时是多级路径，
				// 直接摆进界面只会被截断成一串看不出是什么的字符。
				DeviceID: s.peer.DeviceID, DeviceName: s.PeerName(),
				Name: rt.display, Kind: rt.ctl.kind, Direction: "recv",
				Done: done, Total: rt.entry.Size,
				Chunks: have, TotalChunk: total, Speed: speed,
			})
		}
	}
	return nil
}
