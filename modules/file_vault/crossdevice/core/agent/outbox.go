package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/Aevorine/Tessera/crossdevice/core/node"
)

// 发件箱：等满时限对方仍不在线的文件记到磁盘，对方一连上就自动补发；守护进程重启也不丢。

const (
	outboxTTL   = 7 * 24 * time.Hour
	outboxMax   = 5000
	outboxSweep = 30 * time.Second // 兜底：错过 CONNECTED 事件（入队与上线同时发生）也能补发
)

type outboxEntry struct {
	ID         string `json:"id"`
	DeviceID   string `json:"device_id"`
	Path       string `json:"path"`
	RelPath    string `json:"rel_path,omitempty"`
	Folder     string `json:"folder,omitempty"`
	GroupFiles int    `json:"group_files,omitempty"`
	GroupBytes int64  `json:"group_bytes,omitempty"`
	CreatedMs  int64  `json:"created_ms"`
}

func (e outboxEntry) item() sendItem {
	var size int64
	if st, err := os.Stat(e.Path); err == nil {
		size = st.Size()
	}
	return sendItem{
		path: e.Path, relPath: e.RelPath, folder: e.Folder, size: size,
		group: node.FolderInfo{Files: e.GroupFiles, Bytes: e.GroupBytes}, outboxID: e.ID,
	}
}

type outbox struct {
	mu       sync.Mutex
	path     string
	items    []outboxEntry
	draining map[string]bool
}

func openOutbox(path string) *outbox {
	o := &outbox{path: path, draining: make(map[string]bool)}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &o.items)
	}
	o.mu.Lock()
	if o.pruneLocked(time.Now()) {
		_ = o.saveLocked()
	}
	o.mu.Unlock()
	return o
}

func (o *outbox) pruneLocked(now time.Time) bool {
	cut := now.Add(-outboxTTL).UnixMilli()
	kept := o.items[:0]
	for _, e := range o.items {
		if e.CreatedMs >= cut && e.ID != "" && e.DeviceID != "" && e.Path != "" {
			kept = append(kept, e)
		}
	}
	changed := len(kept) != len(o.items)
	o.items = kept
	return changed
}

func (o *outbox) saveLocked() error {
	b, err := json.Marshal(o.items)
	if err != nil {
		return err
	}
	tmp := o.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, o.path)
}

// add 入队；同一设备同一文件已在队里则不重复。
func (o *outbox) add(dev string, it sendItem) bool {
	if it.outboxID != "" {
		return false // 本来就是从发件箱取出来补发的
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, e := range o.items {
		if e.DeviceID == dev && e.Path == it.path && e.RelPath == it.relPath && e.Folder == it.folder {
			return false
		}
	}
	if len(o.items) >= outboxMax {
		return false
	}
	var id [8]byte
	_, _ = rand.Read(id[:])
	o.items = append(o.items, outboxEntry{
		ID: hex.EncodeToString(id[:]), DeviceID: dev, Path: it.path, RelPath: it.relPath, Folder: it.folder,
		GroupFiles: it.group.Files, GroupBytes: it.group.Bytes, CreatedMs: time.Now().UnixMilli(),
	})
	_ = o.saveLocked()
	return true
}

func (o *outbox) forDevice(dev string) []outboxEntry {
	o.mu.Lock()
	defer o.mu.Unlock()
	var out []outboxEntry
	for _, e := range o.items {
		if e.DeviceID == dev {
			out = append(out, e)
		}
	}
	return out
}

func (o *outbox) countFor(dev string) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	n := 0
	for _, e := range o.items {
		if e.DeviceID == dev {
			n++
		}
	}
	return n
}

func (o *outbox) devices() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	seen := make(map[string]bool)
	var out []string
	for _, e := range o.items {
		if !seen[e.DeviceID] {
			seen[e.DeviceID] = true
			out = append(out, e.DeviceID)
		}
	}
	return out
}

func (o *outbox) list() []outboxEntry {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]outboxEntry(nil), o.items...)
}

// remove 按 ID 删；cancel 按 ID 集合或整台设备删。返回删掉的条数。
func (o *outbox) remove(id string) {
	if id == "" {
		return
	}
	o.cancel([]string{id}, "")
}

func (o *outbox) cancel(ids []string, dev string) int {
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	kept := o.items[:0]
	n := 0
	for _, e := range o.items {
		if want[e.ID] || (dev != "" && e.DeviceID == dev) {
			n++
			continue
		}
		kept = append(kept, e)
	}
	o.items = kept
	if n > 0 {
		_ = o.saveLocked()
	}
	return n
}

func (o *outbox) beginDrain(dev string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.draining[dev] {
		return false
	}
	o.draining[dev] = true
	return true
}

func (o *outbox) endDrain(dev string) {
	o.mu.Lock()
	delete(o.draining, dev)
	o.mu.Unlock()
}

// drainOutbox 把这台设备排队的文件补发出去；再次掉线的留在队里等下一次。
func (d *Agent) drainOutbox(dev string) {
	if d.ob == nil || !d.ob.beginDrain(dev) {
		return
	}
	defer d.ob.endDrain(dev)
	entries := d.ob.forDevice(dev)
	if len(entries) == 0 {
		return
	}
	var items []sendItem
	for _, e := range entries {
		if st, err := os.Stat(e.Path); err != nil || st.IsDir() {
			d.ob.remove(e.ID)
			d.emit("transfer", map[string]any{
				"kind": "error", "direction": "send", "device_id": dev, "device_name": d.peerName(dev),
				"name": e.RelPath, "error": "源文件已不在，已从待发列表移除", "code": "outbox_source_missing",
			})
			continue
		}
		items = append(items, e.item())
	}
	if len(items) == 0 {
		d.emitOutboxChanged(dev)
		return
	}
	d.emit("transfer", map[string]any{
		"kind": "outbox_drain", "direction": "send", "device_id": dev, "device_name": d.peerName(dev),
		"count": len(items),
	})
	d.sendBatch(dev, items, func(it sendItem, oc sendOutcome) {
		if oc != outcomeOffline {
			d.ob.remove(it.outboxID)
		}
	})
	d.emitOutboxChanged(dev)
}

func (d *Agent) emitOutboxChanged(dev string) {
	d.emit("state", map[string]any{"device_id": dev, "state": string(d.n.State(dev)), "devices": d.devices()})
}

// outboxLoop 定时兜底：对方已在线而队里还有东西就补发。
func (d *Agent) outboxLoop() {
	t := time.NewTicker(outboxSweep)
	defer t.Stop()
	for {
		select {
		case <-d.quit:
			return
		case <-t.C:
			for _, dev := range d.ob.devices() {
				if s, ok := d.n.SessionFor(dev); ok && s.Alive() {
					go d.drainOutbox(dev)
				}
			}
		}
	}
}

func (d *Agent) outboxJSON() []map[string]any {
	list := d.ob.list()
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		out = append(out, map[string]any{
			"id": e.ID, "device_id": e.DeviceID, "device_name": d.peerName(e.DeviceID),
			"name": e.RelPath, "path": e.Path, "folder": e.Folder, "created_at": e.CreatedMs,
		})
	}
	return out
}
