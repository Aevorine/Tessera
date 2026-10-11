package agent

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// 配对成功后发起方也必须拿到更新后的设备列表。真实故障：手机扫码配对后电脑能看到新设备、手机看不到
// ，
// 因 pair_with_code 响应只有单个设备对象而无 devices。本用例锁协议契约：发起方会收到带完整设备列表
// 的 paired 事件。
func TestInitiatorGetsPairedEventWithDeviceList(t *testing.T) {
	var mu sync.Mutex
	var aLines, bLines []string

	sinkA := func(s string) { mu.Lock(); aLines = append(aLines, s); mu.Unlock() }
	sinkB := func(s string) { mu.Lock(); bLines = append(bLines, s); mu.Unlock() }

	host, err := New(Config{DataDir: t.TempDir(), Name: "电脑", Addr: "127.0.0.1:0", Sink: sinkA})
	if err != nil {
		t.Fatalf("电脑端启动失败: %v", err)
	}
	defer host.Close()

	guest, err := New(Config{DataDir: t.TempDir(), Name: "手机", Addr: "127.0.0.1:0", Sink: sinkB})
	if err != nil {
		t.Fatalf("手机端启动失败: %v", err)
	}
	defer guest.Close()

	// 让配对码只公布回环地址，避免测试依赖真实网卡。
	host.n.SetAdvertiseAddrs([]string{hostAddr(t, host)})

	code, _, err := host.n.ShowPairingCode("long", 0, nil)
	if err != nil {
		t.Fatalf("生成配对码失败: %v", err)
	}

	// 两端都自动确认 SAS（真实产品里这一步是用户点的）。
	host.Handle(`{"id":1,"method":"status"}`)

	go autoConfirm(host)
	go autoConfirm(guest)

	guest.Handle(`{"id":2,"method":"pair_with_code","params":{"code":` + jsonStr(code) + `}}`)

	// 发起方（手机）必须收到带设备列表的 paired 事件。
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		joined := strings.Join(bLines, "\n")
		mu.Unlock()
		if strings.Contains(joined, `"event":"paired"`) {
			for _, line := range strings.Split(joined, "\n") {
				var ev struct {
					Event string `json:"event"`
					Data  struct {
						Devices []map[string]any `json:"devices"`
					} `json:"data"`
				}
				if json.Unmarshal([]byte(line), &ev) != nil || ev.Event != "paired" {
					continue
				}
				if len(ev.Data.Devices) == 0 {
					t.Fatal("paired 事件里没有设备列表——客户端只能再发一次 status 才知道配上了谁")
				}
				t.Logf("✅ 发起方收到 paired 事件，设备列表 %d 台", len(ev.Data.Devices))
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	mu.Lock()
	got := strings.Join(bLines, "\n")
	mu.Unlock()
	t.Fatalf("发起方没有收到 paired 事件。收到的是:\n%s", got)
}

func hostAddr(t *testing.T, a *Agent) string {
	t.Helper()
	return "127.0.0.1:" + itoa(a.n.Port())
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// autoConfirm 盯着事件流，遇到配对请求就自动点"一致"。
func autoConfirm(a *Agent) {
	for i := 0; i < 200; i++ {
		time.Sleep(50 * time.Millisecond)
		a.pendMu.Lock()
		ids := make([]string, 0, len(a.pending))
		for id := range a.pending {
			ids = append(ids, id)
		}
		a.pendMu.Unlock()
		for _, id := range ids {
			a.Handle(`{"id":99,"method":"pair_respond","params":{"request_id":` +
				jsonStr(id) + `,"accept":true,"mode":"long"}}`)
		}
	}
}
