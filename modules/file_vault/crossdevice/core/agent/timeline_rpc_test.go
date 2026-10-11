package agent

import (
	"encoding/base64"
	"testing"
)

// 时间线 RPC 的形状就是界面和安卓端的契约：字段名、类型错一个都只会安静地坏掉。
func TestClipTimelineRPCRoundTrip(t *testing.T) {
	a := newTestAgent(t)
	text := "long English — with “symbols” ∑∫√∞ <&>"
	if _, err := a.dispatch("send_clip", params(t, map[string]any{
		"preferred": "text/plain;charset=utf-8",
		"reps": []map[string]any{{
			"mime": "text/plain;charset=utf-8",
			"data": base64.StdEncoding.EncodeToString([]byte(text)),
		}},
	})); err != nil {
		t.Fatalf("send_clip 失败: %v", err)
	}

	res, err := a.dispatch("clip_timeline", params(t, map[string]any{"refresh": true}))
	if err != nil {
		t.Fatal(err)
	}
	items := res.(map[string]any)["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("时间线应有 1 条，实际 %d", len(items))
	}
	it := items[0]
	if it["local"] != true || it["available"] != true || it["via"] != "local" {
		t.Fatalf("本机复制的条目字段不对: %+v", it)
	}
	if it["preview"] != text || it["source_name"] != "测试机" {
		t.Fatalf("预览或来源名不对: %+v", it)
	}
	id, _ := it["item_id"].(string)

	res, err = a.dispatch("clip_timeline_apply", params(t, map[string]any{"item_id": id}))
	if err != nil {
		t.Fatalf("再次粘贴失败: %v", err)
	}
	reps := res.(map[string]any)["reps"].([]map[string]any)
	raw, _ := base64.StdEncoding.DecodeString(reps[0]["data"].(string))
	if string(raw) != text {
		t.Fatalf("再次粘贴取回的正文不对: %q", raw)
	}

	if _, err := a.dispatch("clip_timeline_apply", params(t, map[string]any{"item_id": "zz"})); err == nil {
		t.Fatal("非法 item_id 应报错")
	}
	if _, err := a.dispatch("clip_timeline_clear", nil); err != nil {
		t.Fatal(err)
	}
	res, _ = a.dispatch("clip_timeline", nil)
	if n := len(res.(map[string]any)["items"].([]map[string]any)); n != 0 {
		t.Fatalf("清空后仍有 %d 条", n)
	}
}
