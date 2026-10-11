package clipboard

import "testing"

// 「只同步文字」：图片表示被裁掉，首选表示跟着换成纯文本；身份字段不能变，
// 否则对端会把它当成一条新内容再广播一圈。
func TestTextOnlyDropsImagesAndKeepsIdentity(t *testing.T) {
	it := &Item{
		ID:        []byte{1, 2, 3},
		Preferred: "image/png",
		Reps: []Rep{
			{Mime: "image/png", Data: []byte{0x89}},
			{Mime: MimeText, Data: []byte("hi")},
			{Mime: "text/html", Data: []byte("<b>hi</b>")},
		},
	}
	got := it.TextOnly()
	if got == nil {
		t.Fatal("有文字表示时不该返回 nil")
	}
	if len(got.Reps) != 2 || got.Preferred != MimeText {
		t.Fatalf("裁剪结果不对: preferred=%s reps=%d", got.Preferred, len(got.Reps))
	}
	if string(got.ID) != string(it.ID) {
		t.Fatal("ID 被改了")
	}
	if len(it.Reps) != 3 || it.Preferred != "image/png" {
		t.Fatal("原条目被就地改掉了")
	}

	onlyImage := &Item{Preferred: "image/png", Reps: []Rep{{Mime: "image/png", Data: []byte{1}}}}
	if onlyImage.TextOnly() != nil {
		t.Fatal("只有图片时应当返回 nil（这条不同步）")
	}
}
