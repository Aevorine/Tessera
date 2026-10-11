package agent

import (
	"strings"
	"sync"
	"testing"
)

// 固定端口被占用时必须退到系统分配端口而不是整个起不来（39421 被别的软件占、上个实例没退净、开了两
// 份都常见）；
// 端口不固定不影响任何东西，配对码和 mDNS 公布的是实际监听端口。
func TestFallsBackToEphemeralPortWhenFixedPortIsTaken(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	sink := func(s string) { mu.Lock(); lines = append(lines, s); mu.Unlock() }

	// 先占住一个固定端口。
	first, err := New(Config{DataDir: t.TempDir(), Name: "占位", Addr: "127.0.0.1:45999", Sink: sink})
	if err != nil {
		t.Fatalf("第一个节点应当能起来: %v", err)
	}
	defer first.Close()

	// 第二个要同一个端口，必须退到随机端口而不是失败。
	second, err := New(Config{DataDir: t.TempDir(), Name: "后来的", Addr: "127.0.0.1:45999", Sink: sink})
	if err != nil {
		t.Fatalf("端口被占用时应当退到随机端口，而不是直接失败: %v", err)
	}
	defer second.Close()

	if p := second.n.Port(); p == 0 || p == 45999 {
		t.Fatalf("第二个节点应当拿到一个不同的可用端口，实际 %d", p)
	}

	// ready 事件里公布的必须是实际端口——对端照着它连。
	mu.Lock()
	joined := strings.Join(lines, "\n")
	mu.Unlock()
	if !strings.Contains(joined, `"event":"ready"`) {
		t.Error("没有发出 ready 事件")
	}
}
