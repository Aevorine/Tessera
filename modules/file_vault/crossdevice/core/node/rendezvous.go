package node

import (
	"bytes"
	"context"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base32"
	"strings"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/discovery"
)

// 同帐号自动发现（rendezvous 约定令牌）。问题：已配对设备换网后找不到对方——重连靠
// 记住的地址加 mDNS，地址一变失效，而许多路由器丢组播。
// 做法不引入新秘密、不加线上字段：双方各存对方静态公钥，独立算出同一令牌
//   token = base32(HKDF(sha256, ikm = 两把公钥按字典序拼接, info = 时间窗))[:N]
// 每台设备把对端令牌挂到信标并主动扫描，走既有定向广播 + 逐台单播（FindByCode），
// 不依赖组播。
// 安全边界同 6 位码：令牌只是定位符、不是凭据（由公钥推出，算得出的人本就知道公钥），
// 连上仍需 Noise_IK 握手（私钥）和双向 SAS；最坏只是多收几次连接尝试。
// 时间窗让令牌轮换，防长期观察者追踪某一对设备；窗口远大于扫描周期，边界附近两端
// 都接受上一窗口的值。
const (
	// 令牌长度。base32 之后 16 个字符 = 80 bit，随便撞不上，也短到能塞进
	// 信标查询包里。
	rendezvousCodeLen = 16
	// 令牌轮换周期。
	rendezvousWindow = 30 * time.Minute
	// 后台扫描间隔。比轮换周期短得多，所以正常情况下不会卡在窗口边界。
	rendezvousScanEvery = 45 * time.Second
	// 单次扫描的超时。扫 254 台实测约 3 秒。
	rendezvousScanTimeout = 4 * time.Second
	// 一轮最多为多少台对端发起扫描。每台都要扫一遍整个网段，设备多的时候
	// 全扫一轮会把时间和流量都撑爆；轮流来，几轮之内都能覆盖到。
	rendezvousPeersPerRound = 3
)

var rendezvousEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// rendezvousToken 算本机与对端在给定时间窗下的约定令牌。两把公钥必须按字典序拼接，
// 两边才得同一个值，不要改成"本机在前"。
func rendezvousToken(selfDHPub, peerDHPub []byte, window int64) string {
	a, b := selfDHPub, peerDHPub
	if bytes.Compare(a, b) > 0 {
		a, b = b, a
	}
	ikm := make([]byte, 0, len(a)+len(b))
	ikm = append(ikm, a...)
	ikm = append(ikm, b...)

	info := "tessera.rendezvous.v1|" + itoa(window)
	out, err := hkdf.Key(sha256.New, ikm, nil, info, 20)
	if err != nil {
		return ""
	}
	return rendezvousEncoding.EncodeToString(out)[:rendezvousCodeLen]
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [24]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func currentRendezvousWindow(now time.Time) int64 {
	return now.UnixNano() / int64(rendezvousWindow)
}

// rendezvousCodes 返回本机现在该应答的全部令牌，每个对端出当前窗口和上一窗口两个：
// 跨窗口时两设备时钟不一致，只挂当前窗口会出现互相找不到的空窗。
func (n *Node) rendezvousCodes(now time.Time) []string {
	peers := n.store.ListPeers()
	self := n.id.DHPub[:]
	w := currentRendezvousWindow(now)
	codes := make([]string, 0, len(peers)*2)
	for _, p := range peers {
		if len(p.DHPub) == 0 || !p.Usable(now) {
			continue
		}
		for _, win := range []int64{w, w - 1} {
			if c := rendezvousToken(self, p.DHPub, win); c != "" {
				codes = append(codes, c)
			}
		}
	}
	return codes
}

// runRendezvous 是后台自动发现循环：挂令牌 + 轮流扫描。只扫当前没连上的对端
// （扫描是几百个单播包，没必要为好端端的连接重复发）。
func (n *Node) runRendezvous() {
	ticker := time.NewTicker(rendezvousScanEvery)
	defer ticker.Stop()

	n.refreshRendezvousCodes()
	cursor := 0
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.refreshRendezvousCodes()
			cursor = n.rendezvousScanRound(cursor)
		}
	}
}

func (n *Node) refreshRendezvousCodes() {
	if n.beacon == nil {
		return
	}
	n.beacon.SetRendezvousCodes(n.rendezvousCodes(time.Now()))
}

// rendezvousScanRound 为最多 rendezvousPeersPerRound 个断开的对端各扫一遍，
// 返回下一轮该从哪里接着扫。
func (n *Node) rendezvousScanRound(cursor int) int {
	peers := n.store.ListPeers()
	if len(peers) == 0 {
		return 0
	}
	now := time.Now()
	self := n.id.DHPub[:]
	w := currentRendezvousWindow(now)

	picked, next := pickRendezvousRound(len(peers), cursor, rendezvousPeersPerRound, func(i int) bool {
		p := peers[i]
		if len(p.DHPub) == 0 || !p.Usable(now) {
			return false
		}
		st := n.State(p.DeviceID)
		return st != StateConnected && st != StateDegraded // 已经连着，不用找
	})
	for _, i := range picked {
		p := peers[i]
		n.rendezvousFind(p.DeviceID, rendezvousToken(self, p.DHPub, w))
	}
	return next
}

// pickRendezvousRound 从 start 起轮转挑最多 max 个需要找的对端，返回下标和下一轮起点。
// 曾因游标边走边改、下标又用改过的游标算而每步多跳一格（中间那台永远轮不到），故单独抽出测试。
func pickRendezvousRound(n, start, max int, want func(i int) bool) ([]int, int) {
	if n == 0 {
		return nil, 0
	}
	start %= n
	var picked []int
	next := start
	for k := 0; k < n && len(picked) < max; k++ {
		i := (start + k) % n
		next = (i + 1) % n
		if want(i) {
			picked = append(picked, i)
		}
	}
	return picked, next
}

// rendezvousFind 扫一个令牌，找到就把地址记下来并立刻重连。
func (n *Node) rendezvousFind(deviceID, code string) {
	if code == "" {
		return
	}
	ctx, cancel := context.WithTimeout(n.ctx, rendezvousScanTimeout)
	defer cancel()

	res, err := discovery.FindByCode(ctx, n.id.DeviceID(), code, rendezvousScanTimeout)
	if err != nil {
		return
	}
	for _, found := range res.Peers {
		// 令牌只是定位符，必须再核 device_id：知道两把公钥的旁观者也能算出令牌并抢答。
		// 真正把关在握手，这里只是不去连一个一眼就错的地址。
		if found.DeviceID != deviceID {
			continue
		}
		for _, addr := range found.Addrs {
			if strings.TrimSpace(addr) == "" {
				continue
			}
			n.store.RememberAddr(deviceID, addr)
		}
		// 交给既有的重连逻辑去连——它已经处理了同时互拨、退避和状态机。
		n.KeepConnected(deviceID)
		return
	}
}
