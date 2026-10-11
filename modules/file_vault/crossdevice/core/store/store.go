// Package store 持久化设备信任列表、剪贴板历史与传输进度。M1 用 JSON 文件 + 原子替换
// （零依赖）；M2 换 SQLite+SQLCipher（schema 见 docs/01-架构与技术原理.md §11），接口不变。
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Peer 是一台已配对设备。
type Peer struct {
	DeviceID  string    `json:"device_id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	DHPub     []byte    `json:"dh_pub"`
	SignPub   []byte    `json:"sign_pub"`
	Trust     string    `json:"trust"` // long | temp
	PairedAt  time.Time `json:"paired_at"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
	LastSeen  time.Time `json:"last_seen,omitempty"`

	// LastGoodAddr 是重连竞速的第 1 路，命中率最高，必须持久化。
	LastGoodAddr string   `json:"last_good_addr,omitempty"`
	CachedAddrs  []string `json:"cached_addrs,omitempty"`

	Caps       []string `json:"caps,omitempty"`
	Groups     []string `json:"groups,omitempty"`
	Method     string   `json:"method,omitempty"`
	Revoked    bool     `json:"revoked,omitempty"`
	HLC        string   `json:"hlc,omitempty"`
	LastRecv   uint64   `json:"last_recv_seq,omitempty"`
	AutoAccept bool     `json:"auto_accept,omitempty"`

	// ClipPolicy 是跟这台设备之间剪贴板同步什么，两个方向都按它过滤。
	// 空串等于 ClipAll：老存档里没有这个键，升级上来的设备行为不变。
	ClipPolicy string `json:"clip_policy,omitempty"`
	// FilePolicy 覆盖全局的「自动接收文件」开关。空串 = 跟随全局。
	FilePolicy string `json:"file_policy,omitempty"`
}

// 每台设备的剪贴板同步范围。
const (
	ClipAll  = "all"
	ClipText = "text" // 只同步文字类表示（纯文本、富文本、RTF），不同步图片
	ClipOff  = "off"
)

// 每台设备的收文件策略。
const (
	FileInherit = "inherit"
	FileAsk     = "ask"  // 每次都问，哪怕全局开着自动接收
	FileAuto    = "auto" // 自动接收，哪怕全局关着
)

// NormalizeClipPolicy 把未知值归一成 ClipAll：宁可多同步，也不能因为一个
// 拼错的值让剪贴板悄悄停掉。
func NormalizeClipPolicy(v string) string {
	switch v {
	case ClipText, ClipOff:
		return v
	}
	return ClipAll
}

// NormalizeFilePolicy 同理，未知值按「跟随全局」处理。
func NormalizeFilePolicy(v string) string {
	switch v {
	case FileAsk, FileAuto:
		return v
	}
	return FileInherit
}

// Expired 判断临时设备是否已到期。
// 到期判断只信本地时钟，绝不采信对端自报的时间。
func (p *Peer) Expired(now time.Time) bool {
	if p.Trust != "temp" {
		return false
	}
	return !p.ExpiresAt.IsZero() && now.After(p.ExpiresAt)
}

// clone 返回独立副本（切片也复制）。存储对外只给副本：曾直接交出内部指针，会话读循环在
// 心跳里原地改 Name，而界面和事件在别的 goroutine 读，竞态检测器让 CI 自 0.1.25 起一直红。
// 要改请改副本再 PutPeer。
func (p *Peer) clone() *Peer {
	cp := *p
	cp.DHPub = append([]byte(nil), p.DHPub...)
	cp.SignPub = append([]byte(nil), p.SignPub...)
	cp.CachedAddrs = append([]string(nil), p.CachedAddrs...)
	cp.Caps = append([]string(nil), p.Caps...)
	cp.Groups = append([]string(nil), p.Groups...)
	return &cp
}

// Usable 综合判断该设备现在是否还能连。
func (p *Peer) Usable(now time.Time) bool {
	return !p.Revoked && !p.Expired(now)
}

// Options 是用户可调的本机偏好，必须落盘：曾只在内存原子变量里，重启后接收目录之类的
// 设置悄悄回到默认值，用户找不到文件也不知道设置没保住。
type Options struct {
	// DeviceName 是用户起的本机名，空串表示没改过（调用方回落主机名）。必须持久化：
	// 宿主每次启动都把主机名当默认值传入，不存则用户改的名字重启后被盖掉。
	DeviceName string `json:"device_name,omitempty"`

	// DownloadDir 空串表示"还没设过"，由调用方回落到默认值。
	// 不在这里写死默认值：默认值依赖数据目录，而 store 不该知道那个。
	DownloadDir string `json:"download_dir,omitempty"`

	// 这两项默认开。用指针是为了区分"用户显式关掉了"和"这个字段还不存在"
	// （老版本存档里没有这两个键），否则升级上来的用户会被静默地重置成开。
	ClipSync   *bool `json:"clip_sync,omitempty"`
	AutoAccept *bool `json:"auto_accept,omitempty"`

	// ClipPlainOnly：剪贴板只同步纯文本与图片，不带 HTML/RTF。默认关（nil 视为关）。
	// 富格式常是纯文本十倍大，关掉更快，也更不易把网页隐藏样式、追踪链接带到别的设备。
	ClipPlainOnly *bool `json:"clip_plain_only,omitempty"`

	// RendezvousAddr 是跨网汇合点地址，如 "rv.example.com:47820"。空串 = 不启用跨网，只走局域网：
	// 不填就一个包都不会发到公网，无数据出境可能；是否使用、用谁的服务器由用户决定。
	RendezvousAddr string `json:"rendezvous_addr,omitempty"`

	// RendezvousSecret 是那台服务器的口令（服务器端设了才需要填）。
	RendezvousSecret string `json:"rendezvous_secret,omitempty"`

	// RelayOnMetered 决定计费网络（手机 4G/5G）下是否允许走中继。默认关且刻意：中继会把整个
	// 文件过一遍公网，自动重连也会走，用户看不见在花钱。打洞直连不受限（用户主动发文件才产生）。
	RelayOnMetered *bool `json:"relay_on_metered,omitempty"`
}

type data struct {
	Peers   map[string]*Peer `json:"peers"`
	Options Options          `json:"options"`
	Seq     uint64           `json:"seq"`
	Updated time.Time        `json:"updated"`
}

// Store 是线程安全的本地状态存储。
type Store struct {
	mu   sync.RWMutex
	path string
	d    data
	// 临时设备的密钥不落盘（见 docs/02 §14.3），只在内存里。
	ephemeral map[string]*Peer
}

var ErrNotFound = errors.New("设备不存在")

// Open 打开或创建存储。
func Open(path string) (*Store, error) {
	s := &Store{
		path:      path,
		d:         data{Peers: make(map[string]*Peer)},
		ephemeral: make(map[string]*Peer),
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("创建存储目录失败: %w", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, fmt.Errorf("读取存储失败: %w", err)
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &s.d); err != nil {
			return nil, fmt.Errorf("存储文件已损坏: %w", err)
		}
	}
	if s.d.Peers == nil {
		s.d.Peers = make(map[string]*Peer)
	}
	return s, nil
}

// PutPeer 写入或更新一台设备，临时设备只进内存；存的是副本，调用方之后再改或被别的
// goroutine 读都不会互踩。同一设备只能有一条记录：临时与长期互相重配时必须清掉另一边旧记录，
// 否则 GetPeer 先查临时表，旧临时记录会遮住新的长期配对，到期时维护循环还会把设备判为"已到期"并断开。
func (s *Store) PutPeer(p *Peer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := p.clone()
	if p.Trust == "temp" {
		s.ephemeral[p.DeviceID] = cp
		// 已撤销的墓碑也要清：维护循环按 ListPeers 逐条判到期，墓碑会被判成
		// "不可用"，于是每 10 秒把这台刚配好的临时设备断开一次。
		if _, ok := s.d.Peers[p.DeviceID]; ok {
			delete(s.d.Peers, p.DeviceID)
			return s.flushLocked()
		}
		return nil
	}
	delete(s.ephemeral, p.DeviceID)
	s.d.Peers[p.DeviceID] = cp
	return s.flushLocked()
}

// GetPeer 按 device_id 查找。
func (s *Store) GetPeer(id string) (*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if p, ok := s.ephemeral[id]; ok {
		return p.clone(), nil
	}
	if p, ok := s.d.Peers[id]; ok {
		return p.clone(), nil
	}
	return nil, ErrNotFound
}

// FindByDHPub 按 Noise 静态公钥反查设备，是 IK 握手响应方的关键路径：拿到对端静态公钥后
// 必须查到信任记录，查不到就断开。绝不能因"对方自称某设备"就放行。
func (s *Store) FindByDHPub(pub []byte) (*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, m := range []map[string]*Peer{s.ephemeral, s.d.Peers} {
		for _, p := range m {
			if len(p.DHPub) == len(pub) && constEq(p.DHPub, pub) {
				return p.clone(), nil
			}
		}
	}
	return nil, ErrNotFound
}

// ListPeers 返回所有设备，按名称排序，便于 UI 稳定展示。
func (s *Store) ListPeers() []*Peer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Peer, 0, len(s.d.Peers)+len(s.ephemeral))
	for _, p := range s.d.Peers {
		out = append(out, p.clone())
	}
	for _, p := range s.ephemeral {
		out = append(out, p.clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ActivePeers 返回当前仍可连接的设备（排除已撤销与已到期）。
func (s *Store) ActivePeers(now time.Time) []*Peer {
	all := s.ListPeers()
	out := all[:0]
	for _, p := range all {
		if p.Usable(now) {
			out = append(out, p)
		}
	}
	return out
}

// Revoke 撤销一台设备：删除凭据并标记，使其无法再握手成功。
func (s *Store) Revoke(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, wasTemp := s.ephemeral[id]
	delete(s.ephemeral, id)
	p, ok := s.d.Peers[id]
	if !ok {
		// 临时设备只活在内存里，删掉就是撤销完成。以前这里一律报"设备不存在"，
		// 调用方于是不再往下断开会话——界面提示撤销失败，那台设备却一直连着。
		if wasTemp {
			return nil
		}
		return ErrNotFound
	}
	// 密钥必须真的删掉而不是只打标记，否则一个 bug 就可能让撤销失效。
	p.Revoked = true
	p.DHPub = nil
	p.SignPub = nil
	p.LastGoodAddr = ""
	p.CachedAddrs = nil
	return s.flushLocked()
}

// PurgeExpired 清理已到期的临时设备，返回被清理的数量。
func (s *Store) PurgeExpired(now time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, p := range s.ephemeral {
		if p.Expired(now) {
			delete(s.ephemeral, id)
			n++
		}
	}
	for id, p := range s.d.Peers {
		if p.Expired(now) {
			delete(s.d.Peers, id)
			n++
		}
	}
	if n > 0 {
		_ = s.flushLocked()
	}
	return n
}

// RememberAddr 记住一次成功连接的地址，供下次重连第 1 路直接使用。
func (s *Store) RememberAddr(id, addr string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.d.Peers[id]
	if !ok {
		if p, ok = s.ephemeral[id]; !ok {
			return
		}
	}
	if p.LastGoodAddr == addr {
		return
	}
	p.LastGoodAddr = addr
	// 历史地址保留最近 5 个：设备常在 2~3 个网络间移动，多了没意义还拖慢竞速。
	addrs := []string{addr}
	for _, a := range p.CachedAddrs {
		if a != addr && len(addrs) < 5 {
			addrs = append(addrs, a)
		}
	}
	p.CachedAddrs = addrs
	p.LastSeen = time.Now()
	if p.Trust != "temp" {
		_ = s.flushLocked()
	}
}

// NextSeq 分配一个单调递增的消息序号。
func (s *Store) NextSeq() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Seq++
	_ = s.flushLocked()
	return s.d.Seq
}

// Options 返回当前持久化的偏好。
func (s *Store) Options() Options {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.d.Options
}

// SetOptions 覆盖并立即落盘。
func (s *Store) SetOptions(o Options) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Options = o
	return s.flushLocked()
}

// flushLocked 原子写盘：先写临时文件再 rename，
// 保证进程在任何时刻被杀都不会留下半个 JSON 文件。
func (s *Store) flushLocked() error {
	s.d.Updated = time.Now()
	b, err := json.MarshalIndent(&s.d, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化存储失败: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("写入存储失败: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("替换存储文件失败: %w", err)
	}
	return nil
}

func constEq(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}
