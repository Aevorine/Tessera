package node

import (
	"fmt"
	"sync"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
	"github.com/Aevorine/Tessera/crossdevice/core/store"
)

// 每台设备的同步范围（store.Peer.ClipPolicy / FilePolicy）。
// 剪贴板策略两个方向都执行，只看本机一侧、不改线协议：发出前裁剪，空则不发；
// 收到的 announce 同样裁剪，空则只确认不交付；策略不允许的 XFER Kind=clip 正文
// 按「已经有了」回应，对端不报错也不传数据。

// ClipPolicyFor 返回跟某台设备之间的剪贴板同步范围。
func (n *Node) ClipPolicyFor(deviceID string) string {
	p, err := n.store.GetPeer(deviceID)
	if err != nil {
		return store.ClipAll
	}
	return store.NormalizeClipPolicy(p.ClipPolicy)
}

// filterClipFor 按策略裁剪一条剪贴板内容；返回 nil 表示这条不该跟这台设备同步。
func (n *Node) filterClipFor(deviceID string, it *clipboard.Item) *clipboard.Item {
	switch n.ClipPolicyFor(deviceID) {
	case store.ClipOff:
		return nil
	case store.ClipText:
		return it.TextOnly()
	}
	return it
}

// clipMimeAllowed 判断某个表示能不能跟这台设备同步。
func (n *Node) clipMimeAllowed(deviceID, mime string) bool {
	switch n.ClipPolicyFor(deviceID) {
	case store.ClipOff:
		return false
	case store.ClipText:
		return clipboard.IsTextual(mime)
	}
	return true
}

// SetPeerPolicy 改一台设备的同步范围。空串表示这一项不改。
func (n *Node) SetPeerPolicy(deviceID, clipPolicy, filePolicy string) (*store.Peer, error) {
	p, err := n.store.GetPeer(deviceID)
	if err != nil {
		return nil, err
	}
	if clipPolicy != "" {
		p.ClipPolicy = store.NormalizeClipPolicy(clipPolicy)
	}
	if filePolicy != "" {
		p.FilePolicy = store.NormalizeFilePolicy(filePolicy)
	}
	if err := n.store.PutPeer(p); err != nil {
		return nil, err
	}
	return p, nil
}

// BroadcastClipCount 同 BroadcastClip，另外返回真正发出去了几台——被策略跳过的
// 不算。界面据此说「已发到 N 台」，不能把按策略没发的也算进去。
// 各设备并行发：一台正在传大文件（写锁被数据块占着）或走中转很慢，不拖住其他设备。
func (n *Node) BroadcastClipCount(it *clipboard.Item, targets ...string) (int, []error) {
	sessions := n.Sessions()
	if len(targets) == 0 && n.store.Options().DefaultSendDevice != "" {
		targets = []string{n.store.Options().DefaultSendDevice}
	}
	if len(targets) > 0 {
		allowed := make(map[string]bool, len(targets))
		for _, id := range targets {
			allowed[id] = true
		}
		filtered := sessions[:0]
		for _, s := range sessions {
			if allowed[s.peer.DeviceID] {
				filtered = append(filtered, s)
			}
		}
		sessions = filtered
		if len(sessions) == 0 {
			return 0, []error{fmt.Errorf("没有在线的目标设备")}
		}
	}
	if len(sessions) == 1 {
		ok, err := sessions[0].sendClipFiltered(it)
		if err != nil {
			return 0, []error{wrapSendErr(sessions[0], err)}
		}
		if ok {
			return 1, nil
		}
		return 0, nil
	}
	type result struct {
		ok  bool
		err error
	}
	res := make([]result, len(sessions))
	var wg sync.WaitGroup
	for i, s := range sessions {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := s.sendClipFiltered(it)
			res[i] = result{ok, err}
		}()
	}
	wg.Wait()
	sent := 0
	var errs []error
	for i, r := range res {
		if r.err != nil {
			errs = append(errs, wrapSendErr(sessions[i], r.err))
		} else if r.ok {
			sent++
		}
	}
	return sent, errs
}
