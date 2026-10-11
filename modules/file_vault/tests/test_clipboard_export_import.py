"""剪贴板导入导出流式化（v2 NDJSON）：导出逐行写盘，导入首行嗅探格式，旧 v1 大 JSON 走兼容路径。
只测文件/数据库路径（tmp_path 隔离库），不碰系统剪贴板。"""

import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.clipboard import service as clipboard_service
from modules.file_vault.clipboard import storage


def _make_service(tmp_path):
    return clipboard_service.ClipboardService(tmp_path, crypto.generate_key())


def _png_bytes(color=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", (24, 16), color).save(buf, format="PNG")
    return buf.getvalue()


def _insert_text(svc, text, **kwargs):
    storage.insert_entry(svc.conn, content_type="text", content_text=text, **kwargs)


def test_export_writes_ndjson_header_plus_one_line_per_entry(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "第一条")
        _insert_text(svc, "second", is_pinned=True)
        out = tmp_path / "backup.json"
        count = svc.export_to_json(out)
        assert count == 2
        lines = out.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 3
        header = json.loads(lines[0])
        assert header["format"] == clipboard_service.EXPORT_FORMAT_NAME
        assert header["format_version"] == clipboard_service.EXPORT_FORMAT_VERSION
        entries = [json.loads(line) for line in lines[1:]]
        assert {e["content_text"] for e in entries} == {"第一条", "second"}
        assert not (tmp_path / "backup.json.part").exists()  # 原子替换不留半成品
    finally:
        svc.conn.close()


def test_export_then_import_round_trips_text_and_image(tmp_path):
    svc = _make_service(tmp_path / "src")
    try:
        _insert_text(svc, "hello", is_pinned=True, is_hidden=True)
        image_path, thumb_path = svc._write_image_files(_png_bytes())
        storage.insert_entry(
            svc.conn, content_type="image", image_path=image_path, thumbnail_path=thumb_path
        )
        out = tmp_path / "backup.json"
        assert svc.export_to_json(out) == 2
    finally:
        svc.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:
        assert dst.import_from_json(out)["imported"] == 2
        rows = storage.fetch_recent(dst.conn, limit=10)
        by_type = {row["content_type"]: row for row in rows}
        # hidden 条目不出现在 fetch_recent 默认列表里？——fetch_recent 只过滤
        # is_snippet/is_deleted，hidden 靠前端过滤，这里两条都应在。
        assert by_type["text"]["content_text"] == "hello"
        assert bool(by_type["text"]["is_pinned"]) is True
        assert bool(by_type["text"]["is_hidden"]) is True
        imported_image = Path(by_type["image"]["image_path"])
        assert imported_image.exists()
        # 图片字节完整还原（重新编码前后的 PNG 内容一致）
        assert Image.open(imported_image).size == (24, 16)
    finally:
        dst.conn.close()


def test_import_v1_legacy_format_still_works(tmp_path):
    payload = {
        "format_version": 1,
        "exported_at": "2026-01-01T00:00:00",
        "entries": [
            {"content_type": "text", "content_text": "old backup", "is_pinned": True},
            {
                "content_type": "image",
                "image_base64": base64.b64encode(_png_bytes((10, 120, 10))).decode("ascii"),
            },
        ],
    }
    legacy = tmp_path / "legacy.json"
    legacy.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    svc = _make_service(tmp_path / "data")
    try:
        assert svc.import_from_json(legacy)["imported"] == 2
        rows = storage.fetch_recent(svc.conn, limit=10)
        by_type = {row["content_type"]: row for row in rows}
        assert by_type["text"]["content_text"] == "old backup"
        assert Path(by_type["image"]["image_path"]).exists()
    finally:
        svc.conn.close()


def test_import_v1_minified_single_line_falls_back_correctly(tmp_path):
    # 单行压缩版 v1：首行能整体 json.loads 成 dict 但没有 format 标记，必须
    # 走兼容路径而不是被误判成 NDJSON。
    payload = {"format_version": 1, "entries": [{"content_type": "text", "content_text": "minified"}]}
    legacy = tmp_path / "mini.json"
    legacy.write_text(json.dumps(payload), encoding="utf-8")
    svc = _make_service(tmp_path / "data")
    try:
        assert svc.import_from_json(legacy)["imported"] == 1
        assert storage.fetch_recent(svc.conn, limit=5)[0]["content_text"] == "minified"
    finally:
        svc.conn.close()


def test_import_ndjson_tolerates_blank_lines(tmp_path):
    src = _make_service(tmp_path / "src")
    try:
        _insert_text(src, "a")
        _insert_text(src, "b")
        out = tmp_path / "backup.json"
        src.export_to_json(out)
    finally:
        src.conn.close()
    content = out.read_text(encoding="utf-8").replace("\n", "\n\n", 1)
    out.write_text(content, encoding="utf-8")

    dst = _make_service(tmp_path / "dst")
    try:
        assert dst.import_from_json(out)["imported"] == 2
    finally:
        dst.conn.close()


# --- 导出范围：只导置顶 / 只导隐藏 / 只导勾选的那几条 ---


def _exported_texts(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    return {json.loads(line)["content_text"] for line in lines[1:]}


def test_export_can_be_limited_to_pinned_or_hidden(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "普通")
        _insert_text(svc, "置顶的", is_pinned=True)
        _insert_text(svc, "隐藏的", is_hidden=True)

        pinned = tmp_path / "pinned.json"
        assert svc.export_to_json(pinned, only_pinned=True) == 1
        assert _exported_texts(pinned) == {"置顶的"}

        hidden = tmp_path / "hidden.json"
        assert svc.export_to_json(hidden, only_hidden=True) == 1
        assert _exported_texts(hidden) == {"隐藏的"}

        every = tmp_path / "all.json"
        assert svc.export_to_json(every) == 3
    finally:
        svc.conn.close()


def test_export_by_ids_covers_multi_select_and_select_all(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "a")
        _insert_text(svc, "b")
        _insert_text(svc, "c")
        all_ids = [row["id"] for row in storage.fetch_all_for_export(svc.conn)]

        two = tmp_path / "two.json"
        assert svc.export_to_json(two, ids=all_ids[:2]) == 2
        assert _exported_texts(two) == {"a", "b"}

        every = tmp_path / "every.json"
        assert svc.export_to_json(every, ids=all_ids) == 3
    finally:
        svc.conn.close()


def test_empty_id_list_exports_nothing_rather_than_everything(tmp_path):
    """`ids=[]` 表示用户一条都没勾，必须导出 0 条；写成 `if ids:` 会把空列表当"不筛"，
    静默导出整库。"""
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "机密一")
        _insert_text(svc, "机密二")
        out = tmp_path / "nothing.json"
        assert svc.export_to_json(out, ids=[]) == 0
        assert _exported_texts(out) == set()
    finally:
        svc.conn.close()


def test_export_filters_combine_with_and_semantics(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "既置顶又隐藏", is_pinned=True, is_hidden=True)
        _insert_text(svc, "只置顶", is_pinned=True)
        out = tmp_path / "both.json"
        assert svc.export_to_json(out, only_pinned=True, only_hidden=True) == 1
        assert _exported_texts(out) == {"既置顶又隐藏"}
    finally:
        svc.conn.close()


# 富文本格式载荷必须扛过一次导出+导入：content_rtf 和 content_html 曾不在导出列里，
# 导入后文字还在但格式全丢（Word 公式粘回 Office 变纯文本），全程不报错。


def test_rich_text_survives_an_export_import_round_trip(tmp_path):
    src = _make_service(tmp_path / "src")
    dst = _make_service(tmp_path / "dst")
    try:
        html = '<h1 style="color:red">标题</h1>'
        rtf_b64 = "e1xydGYxfQ=="  # 随便一段合法 base64，只验证它原样过去
        storage.insert_entry(
            src.conn,
            content_type="text",
            content_format="rich",
            content_text="标题",
            content_html=html,
            content_rtf_b64=rtf_b64,
        )
        backup = tmp_path / "rich.json"
        assert src.export_to_json(backup) == 1

        assert dst.import_from_json(backup)["imported"] == 1
        rows = storage.fetch_recent(dst.conn, limit=10)
        assert len(rows) == 1
        new_id = rows[0]["id"]
        assert rows[0]["content_text"] == "标题"
        assert rows[0]["content_format"] == "rich"
        # 关键：两份格式载荷都得在，否则粘回 Word 就只剩纯文本了
        assert storage.fetch_html_payload(dst.conn, new_id) == html
        assert storage.fetch_rtf_payload(dst.conn, new_id) == rtf_b64
    finally:
        src.conn.close()
        dst.conn.close()


def test_plain_entries_carry_no_format_payload_after_round_trip(tmp_path):
    """纯文本条目不该凭空长出 HTML——那会让它在粘贴时走富文本那条路。"""
    src = _make_service(tmp_path / "src")
    dst = _make_service(tmp_path / "dst")
    try:
        _insert_text(src, "就是一句普通文字")
        backup = tmp_path / "plain.json"
        src.export_to_json(backup)
        dst.import_from_json(backup)
        new_id = storage.fetch_recent(dst.conn, limit=10)[0]["id"]
        assert storage.fetch_html_payload(dst.conn, new_id) is None
        assert storage.fetch_rtf_payload(dst.conn, new_id) is None
    finally:
        src.conn.close()
        dst.conn.close()
