package store

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "devices.json"))
	if err != nil {
		t.Fatalf("打开存储失败: %v", err)
	}
	return s
}

// 撤销一台临时设备必须算成功。它只在内存里，以前 Revoke 删完内存表之后去查
// 落盘表、查不到就报"设备不存在"——调用方据此提前返回，会话没断，界面报失败。
func TestRevokeTempPeerSucceeds(t *testing.T) {
	s := openTemp(t)
	if err := s.PutPeer(&Peer{DeviceID: "tmp", Trust: "temp", DHPub: []byte{1}, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := s.Revoke("tmp"); err != nil {
		t.Fatalf("撤销临时设备报错: %v", err)
	}
	if _, err := s.GetPeer("tmp"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("撤销后仍能查到: %v", err)
	}
	if err := s.Revoke("never-existed"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的设备应当报 ErrNotFound，实际 %v", err)
	}
}

// 同一台设备先配成临时、再配成长期：只能留一条记录，而且是新的那条。
func TestRepairingReplacesTheOtherTrustKind(t *testing.T) {
	s := openTemp(t)
	now := time.Now()
	_ = s.PutPeer(&Peer{DeviceID: "d", Trust: "temp", Name: "旧", ExpiresAt: now.Add(time.Minute)})
	_ = s.PutPeer(&Peer{DeviceID: "d", Trust: "long", Name: "新"})

	p, err := s.GetPeer("d")
	if err != nil || p.Trust != "long" || p.Name != "新" {
		t.Fatalf("长期配对被旧的临时记录遮住了: %+v, %v", p, err)
	}
	if n := len(s.ListPeers()); n != 1 {
		t.Fatalf("同一台设备出现了 %d 条记录", n)
	}

	// 反过来：撤销过的墓碑也不能留下来跟新的临时配对并存。
	_ = s.Revoke("d")
	_ = s.PutPeer(&Peer{DeviceID: "d", Trust: "temp", ExpiresAt: now.Add(time.Hour)})
	for _, p := range s.ListPeers() {
		if !p.Usable(now) {
			t.Fatalf("临时配对旁边还留着一条不可用的记录，维护循环会据此把它断开: %+v", p)
		}
	}
}

// PutPeer 存的是副本：调用方事后改自己手上那份，不能改到存储里去。
func TestPutPeerStoresACopy(t *testing.T) {
	s := openTemp(t)
	p := &Peer{DeviceID: "d", Trust: "long", Name: "A", CachedAddrs: []string{"1.2.3.4:5"}}
	_ = s.PutPeer(p)
	p.Name = "B"
	p.CachedAddrs[0] = "x"
	got, _ := s.GetPeer("d")
	if got.Name != "A" || got.CachedAddrs[0] != "1.2.3.4:5" {
		t.Fatalf("存储跟调用方共用了同一份数据: %+v", got)
	}
}

func TestPolicyNormalization(t *testing.T) {
	if NormalizeClipPolicy("") != ClipAll || NormalizeClipPolicy("bogus") != ClipAll {
		t.Fatal("未知的剪贴板策略必须回落到 all")
	}
	if NormalizeClipPolicy(ClipText) != ClipText || NormalizeClipPolicy(ClipOff) != ClipOff {
		t.Fatal("合法值被改掉了")
	}
	if NormalizeFilePolicy("") != FileInherit || NormalizeFilePolicy(FileAuto) != FileAuto {
		t.Fatal("文件策略归一不对")
	}
}
