package agent

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/Aevorine/Tessera/crossdevice/core/clipboard"
)

// 收到敏感剪贴板时，Android 要据此把 ClipDescription 标成敏感，避免正文出现在
// 输入法和系统剪贴板预览里。字段名或类型错一个都不会报错，只会安静地失去保护。
func TestOnClipEmitsSensitiveBoolean(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	a, err := New(Config{
		DataDir: t.TempDir(), Name: "测试机", Addr: "127.0.0.1:0",
		Sink: func(line string) {
			mu.Lock()
			lines = append(lines, line)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("节点起不来: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })

	it, err := clipboard.NewItem(
		clipboard.NewClock("测试机"), "peer", clipboard.MimeText,
		[]clipboard.Rep{{Mime: clipboard.MimeText, Data: []byte("private")}},
	)
	if err != nil {
		t.Fatalf("构造剪贴板条目失败: %v", err)
	}
	it.Sensitive = true
	a.onClip(it)

	mu.Lock()
	defer mu.Unlock()
	for _, line := range lines {
		var event struct {
			Event string `json:"event"`
			Data  struct {
				Sensitive bool `json:"sensitive"`
				Reps      []struct {
					Mime string `json:"mime"`
					Data string `json:"data"`
				} `json:"reps"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil || event.Event != "clip" {
			continue
		}
		if !event.Data.Sensitive {
			t.Fatal("敏感状态必须以 JSON 布尔值发给平台层")
		}
		if len(event.Data.Reps) != 1 || event.Data.Reps[0].Mime != clipboard.MimeText {
			t.Fatalf("剪贴板表示丢失: %#v", event.Data.Reps)
		}
		if raw, err := base64.StdEncoding.DecodeString(event.Data.Reps[0].Data); err != nil || string(raw) != "private" {
			t.Fatalf("剪贴板正文编码不对: %q, %v", event.Data.Reps[0].Data, err)
		}
		return
	}
	t.Fatalf("没有收到 clip 事件，实际 %s", strings.Join(lines, "\n"))
}
