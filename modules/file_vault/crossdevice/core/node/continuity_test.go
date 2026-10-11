package node

import (
	"testing"
	"time"
)

// 这几条守的都是"不会报错、只会让提示不准"的失效。一条不准的
// "电脑上还有一个没做完"比没有提示更糟——它会让人不再相信提示。

func TestContinuityStalenessUsesReceiveTimeNotPeerClock(t *testing.T) {
	// 手机时间不准很常见。若拿对端墙钟比本地：快两分钟则永不过期，慢两分钟则刚收到就过期，
	// 都只表现为"提示不对劲"，没有报错。
	now := time.Now()

	future := ContinuityItem{
		UpdatedAtMS: now.Add(2 * time.Hour).UnixMilli(), // 对面的表快了两小时
		receivedAt:  now.Add(-2 * ContinuityStaleAfter), // 但确实是很久以前收到的
	}
	if !future.staleAt(now) {
		t.Fatal("对端墙钟在未来，但收到已久 —— 必须判过期")
	}

	past := ContinuityItem{
		UpdatedAtMS: now.Add(-2 * time.Hour).UnixMilli(), // 对面的表慢了两小时
		receivedAt:  now,                                 // 刚刚收到
	}
	if past.staleAt(now) {
		t.Fatal("刚收到的提示不能因为对端时钟慢就被判过期")
	}
}

func TestContinuitiesDropsStaleAndSortsNewestFirst(t *testing.T) {
	st := newContinuityState()
	now := time.Now()
	st.peers["fresh-old"] = ContinuityItem{
		DeviceID: "fresh-old", Kind: ContinuityKindNote,
		UpdatedAtMS: 1000, receivedAt: now.Add(-time.Second),
	}
	st.peers["fresh-new"] = ContinuityItem{
		DeviceID: "fresh-new", Kind: ContinuityKindNote,
		UpdatedAtMS: 2000, receivedAt: now,
	}
	st.peers["stale"] = ContinuityItem{
		DeviceID: "stale", Kind: ContinuityKindNote,
		UpdatedAtMS: 9999, receivedAt: now.Add(-2 * ContinuityStaleAfter),
	}
	n := &Node{cont: st}

	got := n.Continuities()
	if len(got) != 2 {
		t.Fatalf("过期项没被丢掉，拿到 %d 条", len(got))
	}
	if got[0].DeviceID != "fresh-new" || got[1].DeviceID != "fresh-old" {
		t.Fatalf("排序不对：%s, %s", got[0].DeviceID, got[1].DeviceID)
	}
	// 过期项必须被**真的删掉**，不是每次查询都重新过滤一遍：
	// 只过滤不删的话，一台离线设备的记录会永远占着内存。
	if _, still := st.peers["stale"]; still {
		t.Fatal("过期项应该在查询时被顺手删掉")
	}
}

func TestContinuitiesHidesKindNone(t *testing.T) {
	// none 表示"我现在什么都没在做"。它是一条**主动收回提示**的消息，
	// 不该自己变成一条"某设备正在做 none"的提示显示出来。
	st := newContinuityState()
	st.peers["idle"] = ContinuityItem{
		DeviceID: "idle", Kind: ContinuityKindNone, receivedAt: time.Now(),
	}
	n := &Node{cont: st}
	if got := n.Continuities(); len(got) != 0 {
		t.Fatalf("kind=none 不该出现在列表里，拿到 %d 条", len(got))
	}
}

func TestDropContinuityRemovesDevice(t *testing.T) {
	st := newContinuityState()
	st.peers["gone"] = ContinuityItem{DeviceID: "gone", Kind: ContinuityKindNote, receivedAt: time.Now()}
	n := &Node{cont: st}
	n.dropContinuity("gone")
	if got := n.Continuities(); len(got) != 0 {
		t.Fatal("断开连接后必须立刻清掉那台设备的提示，不能等 90 秒自然过期")
	}
}

func TestContinuityShownHidesFinishedTransfersButKeepsUnknownProgress(t *testing.T) {
	cases := []struct {
		kind     string
		progress int
		want     bool
	}{
		{ContinuityKindNone, 0, false},
		{ContinuityKindTransfer, 100, false}, // 传完了：旧版手机留下的最后一帧
		{ContinuityKindTransfer, 250, false},
		{ContinuityKindTransfer, 99, true},
		{ContinuityKindTransfer, -1, true}, // -1 = 进度未知，不能当成"完成"
		{ContinuityKindNote, 100, true},    // 笔记没有"传完"这回事，progress 对它无意义
		{ContinuityKindNote, -1, true},
	}
	for _, c := range cases {
		if got := continuityShown(c.kind, c.progress); got != c.want {
			t.Errorf("continuityShown(%q, %d) = %v，想要 %v", c.kind, c.progress, got, c.want)
		}
	}
}

func TestContinuitiesHidesFinishedTransfer(t *testing.T) {
	st := newContinuityState()
	st.peers["honor"] = ContinuityItem{
		DeviceID: "honor", Kind: ContinuityKindTransfer, Title: "剪贴板图片",
		Progress: 100, receivedAt: time.Now(),
	}
	n := &Node{cont: st}
	if got := n.Continuities(); len(got) != 0 {
		t.Fatalf("已经 100%% 的传输不该出现在「还有一件没做完」里，拿到 %+v", got)
	}
}

func TestTransferClaimLiveFollowsTheRegistry(t *testing.T) {
	reg := newXferRegistry()
	reg.add(newXferCtl("file-1", "d", "对端", "send", "报告.pdf", "file", 100))
	reg.add(newXferCtl("clip-1", "d", "对端", "recv", "剪贴板图片", "clip", 100))
	n := &Node{xfers: reg}

	cases := []struct {
		name     string
		id       string
		progress int
		want     bool
	}{
		{"进行中的文件传输", "file-1", 40, true},
		{"进度未知的文件传输", "file-1", -1, true},
		{"走到 100% 就不再是没做完", "file-1", 100, false},
		{"剪贴板内部的正文推送从来不算", "clip-1", 40, false},
		{"已经不在注册表里（迟到的进度事件）", "gone", 40, false},
		{"没带 id", "", 40, false},
	}
	for _, c := range cases {
		if got := n.transferClaimLive(c.id, c.progress); got != c.want {
			t.Errorf("%s：transferClaimLive(%q, %d) = %v，想要 %v", c.name, c.id, c.progress, got, c.want)
		}
	}

	// 传输结束（摘出注册表）后，同一条播报立刻不再成立。
	reg.remove("file-1")
	if n.transferClaimLive("file-1", 40) {
		t.Error("传输离开注册表之后，它的播报必须不再成立")
	}
	if (&Node{}).transferClaimLive("file-1", 40) {
		t.Error("没有注册表时不能 panic，且不成立")
	}
}

func TestStaleWindowCoversAtLeastTwoMissedBroadcasts(t *testing.T) {
	// 这条把两个常量之间的关系钉住。有人把重播间隔调大、忘了同步调过期窗口时，
	// 表现是"提示每隔一会儿自己闪一下没了又回来"——很难联想到是这两个数的关系。
	if ContinuityStaleAfter < 2*ContinuityInterval {
		t.Fatalf("过期窗口 %v 容不下两次丢包（重播间隔 %v）", ContinuityStaleAfter, ContinuityInterval)
	}
}
