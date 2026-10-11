package node

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// 三台断线的对端、每轮扫两台：每一台都要轮得到，下一轮从没扫到的那台接着来。
func TestPickRendezvousRoundVisitsEveryPeer(t *testing.T) {
	all := func(int) bool { return true }
	seen := map[int]int{}
	cursor := 0
	for round := 0; round < 3; round++ {
		picked, next := pickRendezvousRound(3, cursor, 2, all)
		if len(picked) != 2 {
			t.Fatalf("第 %d 轮只挑了 %d 台", round, len(picked))
		}
		for _, i := range picked {
			seen[i]++
		}
		cursor = next
	}
	for i := 0; i < 3; i++ {
		if seen[i] < 2 {
			t.Fatalf("对端 %d 三轮里只被扫了 %d 次: %v", i, seen[i], seen)
		}
	}

	// 已连上的不扫，也不占名额。
	picked, _ := pickRendezvousRound(4, 0, 2, func(i int) bool { return i%2 == 1 })
	if len(picked) != 2 || picked[0] != 1 || picked[1] != 3 {
		t.Fatalf("跳过已连接的对端后挑错了: %v", picked)
	}
	if p, next := pickRendezvousRound(0, 5, 2, all); p != nil || next != 0 {
		t.Fatal("没有对端时应当什么都不挑")
	}
}

func TestParseManualAddr(t *testing.T) {
	ok := []struct{ in, host, port string }{
		{"192.168.1.5:39421", "192.168.1.5", "39421"},
		{"１９２．１６８．１．５：３９４２１", "192.168.1.5", "39421"},
		{"192。168。1。5", "192.168.1.5", ""},
		{`"192.168.1.5:39421"`, "192.168.1.5", "39421"},
		{"tessera://192.168.1.5:39421/", "192.168.1.5", "39421"},
		{"[fe80::1%wlan0]:39421", "fe80::1%wlan0", "39421"},
		{"fe80::1", "fe80::1", ""},
		{"[fe80::1]", "fe80::1", ""},
		{"2001:db8::5:39421", "2001:db8::5", "39421"},
		{"desktop.local", "desktop.local", ""},
		{"  192.168.1.5  ", "192.168.1.5", ""},
	}
	for _, c := range ok {
		got, err := parseManualAddr(c.in)
		if err != nil || got.host != c.host || got.port != c.port {
			t.Errorf("parseManualAddr(%q) = %+v, %v；应为 host=%s port=%s", c.in, got, err, c.host, c.port)
		}
	}
	for _, bad := range []string{"", "  ", "192.168.1.5:0", "192.168.1.5:70000", ":39421", "a b", "host:port"} {
		if got, err := parseManualAddr(bad); err == nil {
			t.Errorf("parseManualAddr(%q) 应当报错，实际 %+v", bad, got)
		}
	}
}

// 一轮竞速里挑最能说明问题的那个原因：身份校验失败和对方没开软件是用户能动手修的。
func TestFailuresCodePrefersActionableReason(t *testing.T) {
	fails := []attemptFailure{
		{err: errors.New("dial: i/o timeout")},
		{err: errors.New("connection refused")},
		{err: errors.New("network unreachable")},
	}
	if got := failuresCode(fails); got != OfflineRefused {
		t.Fatalf("应当报 refused，实际 %s", got)
	}
	fails = append(fails, attemptFailure{err: errors.New("握手失败: bad static key")})
	if got := failuresCode(fails); got != OfflineAuth {
		t.Fatalf("应当报 auth，实际 %s", got)
	}
	if got := failuresCode(nil); got != OfflineOther {
		t.Fatalf("没有失败记录时应当是 other，实际 %s", got)
	}
}

// 发起方握手失败后能不能换下一个地址：确认之前的传输类失败可以，对方明确的答复和确认之后的失败不行。
func TestPairRetryable(t *testing.T) {
	ctx := context.Background()
	retry := []error{
		errors.New("timeout: no recent network activity"),
		fmt.Errorf("等待配对承诺失败: %w", errors.New("EOF")),
		fmt.Errorf("%w：连回了本机自己", errWrongPeer),
	}
	for _, err := range retry {
		if !pairRetryable(ctx, err) {
			t.Errorf("应当换下一个地址再试: %v", err)
		}
	}
	final := []error{
		ErrSASMismatch,
		ErrPairRejected,
		&peerAbortError{msg: "配对码已过期"},
		&confirmStageError{err: errors.New("写入失败")},
		&confirmStageError{err: ErrPairRejected},
	}
	for _, err := range final {
		if pairRetryable(ctx, err) {
			t.Errorf("这是终态，不该换地址重试: %v", err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if pairRetryable(cancelled, errors.New("任何错误")) {
		t.Error("调用方取消后不该再试")
	}
	if !errors.Is(&confirmStageError{err: ErrSASMismatch}, ErrSASMismatch) {
		t.Error("confirmStageError 要能透出原始错误")
	}
}
