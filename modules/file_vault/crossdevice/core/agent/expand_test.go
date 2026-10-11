package agent

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// 文件夹在这之前是**完全不支持**的：OpenSender 对一个目录调 Read 直接失败，
// 用户得到一句"是一个目录"，而界面上没有任何地方说过不能选文件夹。

func TestExpandPathsWalksFolder(t *testing.T) {
	root := t.TempDir()
	folder := filepath.Join(root, "报告")
	sub := filepath.Join(folder, "图表")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(p string) {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(folder, "封面.png"))
	write(filepath.Join(sub, "第一章.png"))

	items, bad := expandPaths([]string{folder})
	if len(bad) != 0 {
		t.Fatalf("不该有跳过项：%v", bad)
	}
	if len(items) != 2 {
		t.Fatalf("应当展开出 2 个文件，实际 %d", len(items))
	}

	var rels []string
	for _, it := range items {
		rels = append(rels, it.relPath)
		if it.folder != "报告" {
			t.Errorf("folder 字段应当是「报告」，实际 %q", it.folder)
		}
		// 接收端可能是安卓，反斜杠在那边不是分隔符，会变成文件名里的普通字符——
		// 表现是收到一个叫 `报告\图表\第一章.png` 的文件，平铺在目录里。
		if strings.Contains(it.relPath, `\`) {
			t.Errorf("相对路径必须用正斜杠，实际 %q", it.relPath)
		}
	}
	sort.Strings(rels)
	want := []string{"报告/图表/第一章.png", "报告/封面.png"}
	sort.Strings(want)
	for i := range want {
		if rels[i] != want[i] {
			t.Errorf("相对路径 = %v，期望 %v", rels, want)
			break
		}
	}
}

func TestExpandPathsKeepsPlainFiles(t *testing.T) {
	root := t.TempDir()
	f := filepath.Join(root, "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	items, bad := expandPaths([]string{f})
	if len(bad) != 0 || len(items) != 1 {
		t.Fatalf("单个文件应当原样通过，得到 items=%d bad=%v", len(items), bad)
	}
	if items[0].relPath != "a.txt" {
		t.Errorf("单个文件的相对路径应当是基名，实际 %q", items[0].relPath)
	}
	if items[0].folder != "" {
		t.Errorf("单个文件不属于任何文件夹，实际 %q", items[0].folder)
	}
}

// 空文件夹和不存在的路径要被报出来，不能悄悄消失——
// "我明明选了东西，怎么什么都没发生" 是最难排查的一类表现。
func TestExpandPathsReportsUnsendable(t *testing.T) {
	root := t.TempDir()
	empty := filepath.Join(root, "空文件夹")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	items, bad := expandPaths([]string{empty, filepath.Join(root, "不存在.txt")})
	if len(items) != 0 {
		t.Fatalf("没有可发送的文件，实际 %d", len(items))
	}
	if len(bad) != 2 {
		t.Fatalf("空文件夹和不存在的路径都该被报出来，实际 %v", bad)
	}
}
