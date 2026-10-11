"""新建分类后回溯重跑自动分类（NotesService.reclassify_preview / _apply）。

刻意做成两步：预览列出"哪几篇从 X 改到 Y"，用户确认后才写库。分类器是规则打分器，不知道用户为何
手工归档；自动收纳会静默推翻手工归档，事后难发现更难撤销。所以测试重点是"什么情况下不该动"。
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.notes import storage
from modules.file_vault.notes.service import NotesService


def _make_service(tmp_path) -> NotesService:
    return NotesService(tmp_path / "data", crypto.generate_key())


def _category_of(service, note_id):
    return storage.fetch_metadata(service.conn, note_id)["category"]


# --- 预览 ----------------------------------------------------------------


def test_preview_suggests_a_category_for_an_uncategorized_note(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    note = service.create_note(title="项目A周报", category="", content="本周进展")

    result = service.reclassify_preview("normal")

    assert result["changes"] == [
        {"id": note["id"], "title": "项目A周报", "from_category": "", "to_category": "工作/项目A"}
    ]


def test_preview_never_writes_anything(tmp_path):
    """"预览"这两个字的全部意义——跑完之后库里必须一个字节都没变。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    note = service.create_note(title="项目A周报", category="", content="本周进展")

    service.reclassify_preview("normal")

    assert _category_of(service, note["id"]) == ""


def test_preview_leaves_already_categorized_notes_alone_by_default(tmp_path):
    """默认只看未分类的笔记，绝不碰任何已经有归属的——最安全的默认值。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    service.create_category("归档", "normal")
    service.create_note(title="项目A周报", category="归档", content="本周进展")

    result = service.reclassify_preview("normal")

    assert result["changes"] == []


def test_preview_includes_categorized_notes_only_when_explicitly_asked(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    service.create_category("归档", "normal")
    note = service.create_note(title="项目A周报", category="归档", content="本周进展")

    result = service.reclassify_preview("normal", include_categorized=True)

    assert [c["id"] for c in result["changes"]] == [note["id"]]
    assert result["changes"][0]["from_category"] == "归档"


def test_preview_skips_notes_whose_suggestion_equals_their_current_category(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    service.create_note(title="项目A周报", category="工作/项目A", content="本周进展")

    result = service.reclassify_preview("normal", include_categorized=True)

    assert result["changes"] == []


def test_preview_never_proposes_clearing_a_category(tmp_path):
    """分类器返回 None 表示"没有候选匹配得上"，**不是**"应该清空分类"。
    把它当成清空信号会让一次重分类把一批手工归档的笔记打回未分类。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    service.create_note(title="完全无关的东西", category="工作/项目A", content="毫不相干")

    result = service.reclassify_preview("normal", include_categorized=True)

    assert result["changes"] == []


def test_preview_returns_nothing_when_there_are_no_categories(tmp_path):
    service = _make_service(tmp_path)
    service.create_note(title="项目A周报", category="", content="本周进展")

    assert service.reclassify_preview("normal")["changes"] == []


def test_preview_marks_truncation_past_the_scan_limit(tmp_path):
    """扫描有上限：预览要读每篇的正文摘要打分，几万篇就该是带进度的后台任务了。
    命中上限时要如实告诉前端，而不是悄悄只处理一部分。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    for i in range(NotesService._RECLASSIFY_SCAN_LIMIT + 5):
        service.create_note(title=f"笔记{i}", category="", content="内容")

    result = service.reclassify_preview("normal")

    assert result["truncated"] is True
    assert result["scanned"] == NotesService._RECLASSIFY_SCAN_LIMIT


def test_preview_reads_disk_plain_note_bodies(tmp_path):
    """disk_plain 的笔记正文不在数据库里——不去磁盘读的话这类笔记永远只能靠
    标题打分，正文里的线索全丢了。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    source = tmp_path / "source.txt"
    source.write_text("这份文档属于项目A的范围", encoding="utf-8")
    note = service.create_note_from_file(
        title="无线索的标题", category="占位", source_path=str(source), encrypt=False
    )
    storage.update_note(service.conn, note["id"], category="")

    result = service.reclassify_preview("normal")

    assert [c["id"] for c in result["changes"]] == [note["id"]]


# --- 应用 ----------------------------------------------------------------


def test_apply_writes_the_confirmed_changes(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    note = service.create_note(title="项目A周报", category="", content="本周进展")

    applied = service.reclassify_apply(service.reclassify_preview("normal")["changes"])

    assert applied == 1
    assert _category_of(service, note["id"]) == "工作/项目A"


def test_apply_only_writes_the_rows_the_user_kept(tmp_path):
    """参数是预览返回的那份列表，前端可以剔掉不想要的行——用户确认的是他
    **看到的**那份具体改动，不是"再跑一遍分类器"。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    service.create_category("生活/旅行", "normal")
    keep = service.create_note(title="项目A周报", category="", content="进展")
    drop = service.create_note(title="旅行计划", category="", content="行程")

    changes = service.reclassify_preview("normal")["changes"]
    kept = [c for c in changes if c["id"] == keep["id"]]
    applied = service.reclassify_apply(kept)

    assert applied == 1
    assert _category_of(service, keep["id"]) == "工作/项目A"
    assert _category_of(service, drop["id"]) == ""  # 被剔掉的一行原样不动


def test_apply_skips_a_note_whose_category_changed_since_the_preview(tmp_path):
    """乐观并发校验：笔记分类在预览之后被改过（另一窗口或用户手工拖过）就跳过，不覆盖更新的值；
    用户确认的是"从空的改成 X"，不是"无论现在是什么都改成 X"。"""
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    note = service.create_note(title="项目A周报", category="", content="进展")
    changes = service.reclassify_preview("normal")["changes"]

    storage.update_note(service.conn, note["id"], category="我手工放的")

    applied = service.reclassify_apply(changes)

    assert applied == 0
    assert _category_of(service, note["id"]) == "我手工放的"


def test_apply_ignores_malformed_entries_instead_of_crashing(tmp_path):
    service = _make_service(tmp_path)
    service.create_note(title="笔记", category="", content="内容")

    applied = service.reclassify_apply(
        [{"id": "not-an-int", "to_category": "X"}, {"to_category": "X"}, {"id": 1}, "不是字典对象"]
    )

    assert applied == 0


def test_apply_rejects_an_invalid_target_path(tmp_path):
    """写入路径必须过校验——预览的结果理论上都是合法的，但这个 RPC 的入参
    是前端传回来的，不能假设它没被改过。"""
    service = _make_service(tmp_path)
    note = service.create_note(title="笔记", category="", content="内容")

    applied = service.reclassify_apply(
        [{"id": note["id"], "from_category": "", "to_category": "工作//项目A"}]
    )

    assert applied == 0
    assert _category_of(service, note["id"]) == ""


def test_apply_reindexes_fts_so_search_finds_the_new_category(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("工作/项目A", "normal")
    note = service.create_note(title="项目A周报", category="", content="进展")

    service.reclassify_apply(service.reclassify_preview("normal")["changes"])

    found = storage.search_notes(service.conn, query="项目A")
    assert note["id"] in [n["id"] for n in found]
