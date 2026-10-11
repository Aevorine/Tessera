package store

import (
	"path/filepath"
	"testing"
)

// 接收目录这类偏好必须扛得住重启。曾只存在内存原子变量里，重启后悄悄回到默认目录，
// 文件收到了但用户找不到。
func TestOptionsSurviveReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devices.json")

	s1, err := Open(path)
	if err != nil {
		t.Fatalf("打开存储失败: %v", err)
	}
	off := false
	if err := s1.SetOptions(Options{DownloadDir: `D:\收到的文件`, ClipSync: &off}); err != nil {
		t.Fatalf("写入偏好失败: %v", err)
	}

	// 重新打开 = 模拟重启。
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("重新打开失败: %v", err)
	}
	got := s2.Options()
	if got.DownloadDir != `D:\收到的文件` {
		t.Errorf("接收目录没保住：%q", got.DownloadDir)
	}
	if got.ClipSync == nil || *got.ClipSync {
		t.Errorf("显式关掉的剪贴板同步被重置了：%v", got.ClipSync)
	}
	// 从没设过的项必须保持 nil，好让调用方区分"用户关了"和"还没设过"。
	if got.AutoAccept != nil {
		t.Errorf("没设过的项不该有值：%v", *got.AutoAccept)
	}
}

// 老版本存档里没有 options 键，读出来要是零值而不是报错。
func TestMissingOptionsBlockIsNotAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devices.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	got := s.Options()
	if got.DownloadDir != "" || got.ClipSync != nil || got.AutoAccept != nil {
		t.Errorf("全新存档的偏好应当全是零值，实际 %+v", got)
	}
}
