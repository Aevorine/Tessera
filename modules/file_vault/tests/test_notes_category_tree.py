"""递归分类在存储层的行为：父路径补建、两种删除语义、子树重命名/移动。关注数据会不会被改坏：
一次删除或改名可能连带几十篇笔记的归属，而物化路径下数据库自身对这些关系一无所知。"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, errors
from modules.file_vault.notes import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "notes.db", crypto.generate_key())


def _note(conn, title, category, hidden=False):
    note_id = storage.insert_note(conn, title=title, category=category, content=f"{title} 的正文", is_hidden=hidden)
    return note_id


def _category_names(conn, scope="normal"):
    # 排序后返回：SQLite 的 COLLATE NOCASE 对中文按码点排（"工作" 在 "生活" 前），与拼音序不一致；
    # 断言关心有哪些分类而非展示顺序，统一 sorted 免得变成在校验排序规则。
    return sorted(row["name"] for row in storage.list_categories(conn, scope))


def _category_id(conn, name, scope="normal"):
    return next(row["id"] for row in storage.list_categories(conn, scope) if row["name"] == name)


def _category_of(conn, note_id):
    return storage.fetch_metadata(conn, note_id)["category"]


# --- 父路径自动补建 -------------------------------------------------------


def test_creating_a_nested_category_backfills_every_ancestor(tmp_path):
    """不补父级会出现有子无父的悬空节点：前端能从子路径推出 `工作` 层并渲染，表里却没有对应行，
    点它/加关键词/删它都会异常。"""
    conn = _connect(tmp_path)

    storage.create_category(conn, "工作/项目A/需求", "normal")

    assert _category_names(conn) == ["工作", "工作/项目A", "工作/项目A/需求"]


def test_backfilled_ancestors_do_not_overwrite_an_existing_ones_keywords(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作", "normal", keywords="办公,公司")

    storage.create_category(conn, "工作/项目A", "normal", keywords="Alpha")

    rows = {row["name"]: row["keywords"] for row in storage.list_categories(conn, "normal")}
    assert rows["工作"] == "办公,公司"  # 原有关键词原样保留
    assert rows["工作/项目A"] == "Alpha"


def test_creating_a_category_normalizes_the_path(tmp_path):
    conn = _connect(tmp_path)

    created = storage.create_category(conn, " 工作 / 项目A ", "normal")

    assert created["name"] == "工作/项目A"


def test_creating_a_category_with_an_empty_segment_is_rejected(tmp_path):
    conn = _connect(tmp_path)

    with pytest.raises(errors.VaultError) as exc:
        storage.create_category(conn, "工作//项目A", "normal")
    assert exc.value.code == "notes.category_empty_segment"


# --- 影响范围预览 ---------------------------------------------------------


def test_category_impact_counts_children_and_notes_separately(tmp_path):
    """直接笔记和子孙笔记要分开数——两种删除语义下它们的命运不同，
    确认框得能分别说清楚。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    storage.create_category(conn, "工作/项目A/设计", "normal")
    _note(conn, "直接的", "工作/项目A")
    _note(conn, "子孙的一", "工作/项目A/需求")
    _note(conn, "子孙的二", "工作/项目A/设计")
    _note(conn, "无关的", "生活")

    impact = storage.category_impact(conn, _category_id(conn, "工作/项目A"))

    assert impact["child_count"] == 2
    assert sorted(impact["children"]) == sorted(["工作/项目A/需求", "工作/项目A/设计"])
    assert impact["direct_note_count"] == 1
    assert impact["descendant_note_count"] == 2


def test_category_impact_returns_none_for_a_missing_category(tmp_path):
    conn = _connect(tmp_path)
    assert storage.category_impact(conn, 9999) is None


# --- 删除语义：promote（子类提升到父级）----------------------------------


def test_delete_promote_lifts_children_one_level_up(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")

    storage.delete_category(conn, _category_id(conn, "工作/项目A"), "promote")

    assert _category_names(conn) == ["工作", "工作/需求"]


def test_delete_promote_never_loses_a_note(tmp_path):
    """promote 的核心承诺：笔记一篇不丢，只是路径少了一层。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    direct = _note(conn, "直接的", "工作/项目A")
    descendant = _note(conn, "子孙的", "工作/项目A/需求")

    storage.delete_category(conn, _category_id(conn, "工作/项目A"), "promote")

    assert _category_of(conn, direct) == "工作"  # 归到父级
    assert _category_of(conn, descendant) == "工作/需求"  # 少了一层


def test_delete_promote_of_a_top_level_category_moves_notes_to_uncategorized(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A", "normal")
    direct = _note(conn, "直接的", "工作")
    descendant = _note(conn, "子孙的", "工作/项目A")

    storage.delete_category(conn, _category_id(conn, "工作"), "promote")

    assert _category_of(conn, direct) == ""  # 顶级的父级就是未分类
    assert _category_of(conn, descendant) == "项目A"  # 提升成顶级
    assert _category_names(conn) == ["项目A"]


# --- 删除语义：cascade（删整棵子树）--------------------------------------


def test_delete_cascade_removes_the_whole_subtree(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    storage.create_category(conn, "生活", "normal")

    storage.delete_category(conn, _category_id(conn, "工作/项目A"), "cascade")

    assert _category_names(conn) == sorted(["生活", "工作"])


def test_delete_cascade_uncategorizes_notes_but_never_deletes_them(tmp_path):
    """分类只是标签，删标签不该删内容——笔记必须还在，只是失去归属。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    direct = _note(conn, "直接的", "工作/项目A")
    descendant = _note(conn, "子孙的", "工作/项目A/需求")

    storage.delete_category(conn, _category_id(conn, "工作/项目A"), "cascade")

    assert _category_of(conn, direct) == ""
    assert _category_of(conn, descendant) == ""
    assert storage.fetch_metadata(conn, direct)["is_deleted"] == 0
    assert storage.fetch_metadata(conn, descendant)["is_deleted"] == 0


def test_delete_rejects_an_unknown_mode(tmp_path):
    """没有默认成 cascade，也不接受笔误的 mode——两种语义的破坏力差一个量级，
    绝不能因为拼错一个字符串就走到更危险的那条路上。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作", "normal")

    with pytest.raises(errors.VaultError) as exc:
        storage.delete_category(conn, _category_id(conn, "工作"), "nuke")
    assert exc.value.code == "notes.invalid_category_delete_mode"


def test_delete_does_not_touch_a_similarly_named_sibling(tmp_path):
    """`工作台` 不是 `工作` 的子孙。裸前缀匹配会把它一起删掉。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作", "normal")
    storage.create_category(conn, "工作台", "normal")
    note_id = _note(conn, "在工作台", "工作台")

    storage.delete_category(conn, _category_id(conn, "工作"), "cascade")

    assert _category_names(conn) == ["工作台"]
    assert _category_of(conn, note_id) == "工作台"


def test_delete_does_not_touch_the_other_scope(tmp_path):
    """普通笔记和隐藏笔记是两套独立的分类池（见 categories.scope）。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作", "normal")
    storage.create_category(conn, "工作", "hidden")
    hidden_note = _note(conn, "隐藏的", "工作", hidden=True)

    storage.delete_category(conn, _category_id(conn, "工作", "normal"), "cascade")

    assert _category_names(conn, "hidden") == ["工作"]
    assert _category_of(conn, hidden_note) == "工作"


# --- 重命名 / 移动 --------------------------------------------------------


def test_rename_moves_the_whole_subtree_and_its_notes(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    direct = _note(conn, "直接的", "工作/项目A")
    descendant = _note(conn, "子孙的", "工作/项目A/需求")

    storage.rename_category(conn, _category_id(conn, "工作/项目A"), "工作/项目B")

    assert "工作/项目B" in _category_names(conn)
    assert "工作/项目B/需求" in _category_names(conn)
    assert _category_of(conn, direct) == "工作/项目B"
    assert _category_of(conn, descendant) == "工作/项目B/需求"


def test_rename_to_a_different_parent_is_the_same_operation_as_a_move(tmp_path):
    """物化路径下重命名和移动就是同一件事——换一段路径前缀。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    note_id = _note(conn, "子孙的", "工作/项目A/需求")

    storage.rename_category(conn, _category_id(conn, "工作/项目A"), "归档/项目A")

    assert _category_of(conn, note_id) == "归档/项目A/需求"
    # 新父级不存在时要补建，否则又是悬空节点
    assert "归档" in _category_names(conn)


def test_rename_blocks_moving_a_subtree_into_its_own_descendant(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")

    with pytest.raises(errors.VaultError) as exc:
        storage.rename_category(conn, _category_id(conn, "工作/项目A"), "工作/项目A/子集")
    assert exc.value.code == "notes.category_move_into_self"


def test_rename_onto_an_existing_category_is_rejected_with_a_readable_error(tmp_path):
    """与其让 UNIQUE(name, scope) 在事务中途炸出一个数据库层的报错，
    不如提前给一个用户看得懂的错误码。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A", "normal")
    storage.create_category(conn, "工作/项目B", "normal")

    with pytest.raises(errors.VaultError) as exc:
        storage.rename_category(conn, _category_id(conn, "工作/项目A"), "工作/项目B")
    assert exc.value.code == "notes.category_already_exists"


def test_rename_does_not_touch_a_similarly_named_sibling(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作", "normal")
    storage.create_category(conn, "工作台", "normal")
    note_id = _note(conn, "在工作台", "工作台")

    storage.rename_category(conn, _category_id(conn, "工作"), "办公")

    assert _category_of(conn, note_id) == "工作台"
    assert "工作台" in _category_names(conn)


def test_rename_is_a_noop_when_the_name_is_unchanged(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作", "normal")
    category_id = _category_id(conn, "工作")

    result = storage.rename_category(conn, category_id, "工作")

    assert result["name"] == "工作"


def test_rename_rebuilds_the_fts_index_so_search_follows_the_new_path(tmp_path):
    """category 是 notes_fts 的一列，而这张 FTS 表手动维护（无触发器）；不重建会出现按新分类名搜不到、
    按旧名反而能搜到的"搜索结果和列表对不上"。"""
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A", "normal")
    note_id = _note(conn, "周报", "工作/项目A")
    storage.reindex_note_fts(conn, note_id, title="周报", content="周报的正文", category="工作/项目A", tags=[])

    storage.rename_category(conn, _category_id(conn, "工作/项目A"), "归档/项目B")

    found_new = storage.search_notes(conn, query="项目B")
    found_old = storage.search_notes(conn, query="项目A")
    assert [n["id"] for n in found_new] == [note_id]
    assert found_old == []


def test_delete_promote_rebuilds_the_fts_index_too(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "工作/项目A/需求", "normal")
    note_id = _note(conn, "需求单", "工作/项目A/需求")
    storage.reindex_note_fts(conn, note_id, title="需求单", content="正文", category="工作/项目A/需求", tags=[])

    storage.delete_category(conn, _category_id(conn, "工作/项目A"), "promote")

    # 提升之后分类是 `工作/需求`，旧的中间层 `项目A` 不该还留在索引里
    assert storage.search_notes(conn, query="项目A") == []
