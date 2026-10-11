package node

import (
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
func (n *Node) BroadcastClipCount(it *clipboard.Item) (int, []error) {
	sent := 0
	var errs []error
	for _, s := range n.Sessions() {
		ok, err := s.sendClipFiltered(it)
		if err != nil {
			errs = append(errs, wrapSendErr(s, err))
			continue
		}
		if ok {
			sent++
		}
	}
	return sent, errs
}
