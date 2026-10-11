package clipboard

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HLC 是混合逻辑时钟。只用本地时间会因设备时钟偏差把后复制的排在前面；只用 Lamport 计数器又无法在
// UI 展示复制时间。
// HLC 物理部分与真实时间大致对齐，逻辑部分给同一毫秒内的事件确定顺序，device_id 作最终 tiebreaker
// 保证全局唯一定序。
type HLC struct {
	WallMS  int64
	Counter uint32
	Node    string
}

// Clock 是一台设备上的 HLC 时钟源。
type Clock struct {
	mu   sync.Mutex
	node string
	last HLC
}

func NewClock(node string) *Clock {
	if len(node) > 8 {
		node = node[:8]
	}
	return &Clock{node: node}
}

// Now 产生一个新的本地时间戳。
func (c *Clock) Now() HLC {
	c.mu.Lock()
	defer c.mu.Unlock()
	wall := time.Now().UnixMilli()
	if wall > c.last.WallMS {
		c.last = HLC{WallMS: wall, Counter: 0, Node: c.node}
	} else {
		// 物理时钟没走（同一毫秒内）或者回拨了，用逻辑计数器保证单调递增。
		// 时钟回拨在手机上很常见（NTP 校时、用户手动改时间），必须扛住。
		c.last.Counter++
		c.last.Node = c.node
	}
	return c.last
}

// Observe 收到对端时间戳时推进本地时钟，使因果顺序得以保持。
func (c *Clock) Observe(remote HLC) HLC {
	c.mu.Lock()
	defer c.mu.Unlock()
	wall := time.Now().UnixMilli()
	maxWall := wall
	if remote.WallMS > maxWall {
		maxWall = remote.WallMS
	}
	if c.last.WallMS > maxWall {
		maxWall = c.last.WallMS
	}

	switch {
	case maxWall == c.last.WallMS && maxWall == remote.WallMS:
		if remote.Counter > c.last.Counter {
			c.last.Counter = remote.Counter
		}
		c.last.Counter++
	case maxWall == c.last.WallMS:
		c.last.Counter++
	case maxWall == remote.WallMS:
		c.last.Counter = remote.Counter + 1
	default:
		c.last.Counter = 0
	}
	c.last.WallMS = maxWall
	c.last.Node = c.node
	return c.last
}

// Compare 返回 -1/0/1。定序规则：物理时间 → 逻辑计数 → 节点 ID。
func (h HLC) Compare(o HLC) int {
	switch {
	case h.WallMS < o.WallMS:
		return -1
	case h.WallMS > o.WallMS:
		return 1
	case h.Counter < o.Counter:
		return -1
	case h.Counter > o.Counter:
		return 1
	case h.Node < o.Node:
		return -1
	case h.Node > o.Node:
		return 1
	}
	return 0
}

func (h HLC) After(o HLC) bool  { return h.Compare(o) > 0 }
func (h HLC) Before(o HLC) bool { return h.Compare(o) < 0 }

// String 编码为 "<wall>.<counter>.<node>"，线协议里就传这个字符串。
func (h HLC) String() string {
	return fmt.Sprintf("%d.%d.%s", h.WallMS, h.Counter, h.Node)
}

func (h HLC) Time() time.Time { return time.UnixMilli(h.WallMS) }

// ParseHLC 解析线上的时间戳字符串。
func ParseHLC(s string) (HLC, error) {
	var h HLC
	parts := strings.SplitN(s, ".", 3)
	if len(parts) != 3 {
		return h, fmt.Errorf("HLC 格式错误: %q", s)
	}
	w, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return h, fmt.Errorf("HLC 物理部分错误: %w", err)
	}
	c, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil {
		return h, fmt.Errorf("HLC 逻辑部分错误: %w", err)
	}
	return HLC{WallMS: w, Counter: uint32(c), Node: parts[2]}, nil
}
