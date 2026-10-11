package node

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/netif"
)

// 网络变化的自动感知。NetworkChanged 是"立刻重连"的总开关（唤醒退避重连、重开发现层、
// 跨网重新报到、探测旧会话），但此前没有任何平台调用它，换网/休眠醒来只能靠退避计时器
// 和 30 秒心跳超时慢慢恢复。现在节点每隔 netWatchInterval 检查网卡 IPv4 是否变化，
// 并检测墙钟跳变（休眠）；平台主动调用会同步基线，不会重复触发。

const (
	netWatchInterval = 2 * time.Second
	// 两次检查之间墙上时间走了这么久，就当系统睡过一觉。单调时钟在 Windows 上
	// 不计休眠时间，所以这里必须比墙上时间。
	sleepGap = 15 * time.Second
	// 网络变化后现有会话多久没有回音就判死。局域网往返是毫秒级，中继也在几百
	// 毫秒以内；4 秒足够宽，又比心跳连丢三次（约 30 秒）快得多。
	networkProbeTimeout = 4 * time.Second
)

type netWatchState struct {
	mu   sync.Mutex
	last string
}

// netFingerprint 是"当前在哪张网"的摘要：每张开着的非回环网卡的名字和 IPv4。
// 不含 IPv6：Windows 临时 IPv6 会定期轮换，算进来会无谓地重开发现层。
func netFingerprint() string {
	var parts []string
	for _, ifi := range netif.Usable() {
		for _, ipn := range ifi.IPNets() {
			if v4 := ipn.IP.To4(); v4 != nil && !v4.IsLinkLocalUnicast() {
				parts = append(parts, ifi.Name+"|"+v4.String())
			}
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// netWatchSync 把基线设成当前网络。主动调用 NetworkChanged 时同步一次，
// 免得后台循环两秒后又把同一次变化再报一遍。
func (n *Node) netWatchSync() {
	fp := netFingerprint()
	n.netWatch.mu.Lock()
	n.netWatch.last = fp
	n.netWatch.mu.Unlock()
}

func (n *Node) netWatchLoop() {
	defer n.wg.Done()
	n.netWatchSync()
	t := time.NewTicker(netWatchInterval)
	defer t.Stop()
	lastTick := time.Now().Round(0)
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
		}
		now := time.Now().Round(0) // 去掉单调时钟读数，比的是墙上时间
		slept := now.Sub(lastTick) > sleepGap
		lastTick = now

		fp := netFingerprint()
		n.netWatch.mu.Lock()
		changed := fp != n.netWatch.last
		n.netWatch.mu.Unlock()

		switch {
		case slept:
			n.logf("系统刚从休眠中恢复，立即检查连接")
			n.NetworkChanged()
		case changed:
			n.NetworkChanged()
		}
	}
}

// probeLiveness 立刻发一次心跳，timeout 内无回音就断开会话。只在刚换网时用：
// 旧连接绑在已不存在的地址上，不报错，只静默收不到东西。
func (s *Session) probeLiveness(timeout time.Duration) {
	if !s.Alive() {
		return
	}
	start := time.Now()
	if err := s.sendHeartbeat(); err != nil {
		s.close(err)
		return
	}
	select {
	case <-s.done:
		return
	case <-s.node.ctx.Done():
		return
	case <-time.After(timeout):
	}
	if s.lastEcho.Load() < start.UnixNano() {
		s.node.logf("网络变化后 %s 的连接没有回音，断开重连", s.PeerName())
		s.close(errors.New("网络变化后链路无响应"))
	}
}

// ---------- 连不上的原因 ----------

// 连不上的原因码。给界面查翻译表用——守护进程不知道界面是什么语言，
// 中文原句只进日志。
const (
	OfflineNotFound         = "not_found"          // 局域网里找不到，也没配跨网
	OfflineNotFoundCrossnet = "not_found_crossnet" // 配了跨网，但中转点也没看到它
	OfflineMetered          = "metered"            // 计量网络下按策略跳过了中继
	OfflineRefused          = "refused"            // 地址通，但对方没在监听（软件没开）
	OfflineTimeout          = "timeout"            // 没有回应（多半不在这个网络里）
	OfflineUnreachable      = "unreachable"        // 网络不可达
	OfflineAuth             = "auth"               // 连上了但身份校验没过，多半要重新配对
	OfflineRevoked          = "revoked"
	OfflineOther            = "other"
)

// ConnectError 是 Connect 失败时的结构化错误：Code 给界面，Err 是给人看的中文。
type ConnectError struct {
	Code string
	Err  error
}

func (e *ConnectError) Error() string { return e.Err.Error() }
func (e *ConnectError) Unwrap() error { return e.Err }

// OfflineReason 是某台设备最近一次自动重连失败的原因。
type OfflineReason struct {
	Code string
	Msg  string
	At   time.Time
}

// reasonCode 把一次拨号失败归到一个原因码。判断依据跟 shortReason 一致。
func reasonCode(err error) string {
	if err == nil {
		return OfflineOther
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "握手失败"):
		return OfflineAuth
	case strings.Contains(s, "refused"):
		return OfflineRefused
	case strings.Contains(s, "timeout") || strings.Contains(s, "deadline exceeded"):
		return OfflineTimeout
	case strings.Contains(s, "no route") || strings.Contains(s, "unreachable"):
		return OfflineUnreachable
	}
	return OfflineOther
}

// failuresCode 从一轮竞速里所有路的失败中挑最能说明问题的那个：
// 身份校验失败 > 对方没开软件 > 超时 > 不可达。前两个是用户能动手修的。
func failuresCode(fails []attemptFailure) string {
	rank := map[string]int{OfflineAuth: 5, OfflineRefused: 4, OfflineTimeout: 3, OfflineUnreachable: 2, OfflineOther: 1}
	best := OfflineOther
	for _, f := range fails {
		if c := reasonCode(f.err); rank[c] > rank[best] {
			best = c
		}
	}
	return best
}

// noteConnectFailure 记下自动重连失败的原因，界面在设备详情里显示。
func (n *Node) noteConnectFailure(deviceID string, err error) {
	if err == nil {
		return
	}
	code := OfflineOther
	var ce *ConnectError
	if errors.As(err, &ce) {
		code = ce.Code
	}
	n.offMu.Lock()
	n.offline[deviceID] = OfflineReason{Code: code, Msg: err.Error(), At: time.Now()}
	n.offMu.Unlock()
}

func (n *Node) clearOfflineReason(deviceID string) {
	n.offMu.Lock()
	delete(n.offline, deviceID)
	n.offMu.Unlock()
}

// LastOfflineReason 返回某台设备最近一次连不上的原因；连上之后清空。
func (n *Node) LastOfflineReason(deviceID string) (OfflineReason, bool) {
	n.offMu.Lock()
	defer n.offMu.Unlock()
	r, ok := n.offline[deviceID]
	return r, ok
}
