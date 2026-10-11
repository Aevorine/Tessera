"""T2 的排序那一半：四种排序方式 + 手动拖拽落盘。分类已有测试（test_notes_classifier*.py、
test_notes_category_tree.py），只覆盖 sort_order 列、order_clause 分流、set_manual_order。"""

import sys
from pathlib import Path

import pytest
from sqlcipher3 import dbapi2 as sqlcipher

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, ui_settings
from modules.file_vault.notes import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "notes.db", crypto.generate_key())


def _ids(rows):
    return [row["id"] for row in rows]


def test_sort_mode_lists_stay_in_sync_between_layers():
    """ui_settings 不 import notes.storage（会拉 sqlcipher），两处模式列表靠此断言防漂移；漏改一处
    会表现为某模式界面能选、后端却悄悄退回默认排序。"""
    assert ui_settings.NOTE_SORT_MODES == storage.SORT_MODES
    assert ui_settings.DEFAULT_NOTE_SORT_MODE == storage.DEFAULT_SORT_MODE


def test_default_sort_matches_pre_feature_ordering(tmp_path):
    """默认必须跟"能选排序"之前的硬编码顺序完全一致，升级上来的用户不该看到
    列表自己重排过。"""
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")
    c = storage.insert_note(conn, title="c")
    storage.set_pinned(conn, a, True)

    assert _ids(storage.fetch_list(conn)) == [a, c, b]
    assert _ids(storage.fetch_list(conn, sort="created")) == [a, c, b]


def test_title_sort_is_case_insensitive_and_keeps_pinned_on_top(tmp_path):
    conn = _connect(tmp_path)
    banana = storage.insert_note(conn, title="banana")
    apple = storage.insert_note(conn, title="Apple")
    cherry = storage.insert_note(conn, title="cherry")
    storage.set_pinned(conn, cherry, True)

    # 置顶的 cherry 在最前，剩下两条 Apple < banana 说明用的是 NOCASE
    # （二进制比较里大写 'A'(65) 和小写 'b'(98) 也是这个序，所以再补一条反例）
    assert _ids(storage.fetch_list(conn, sort="title")) == [cherry, apple, banana]

    zebra = storage.insert_note(conn, title="Zebra")
    apricot = storage.insert_note(conn, title="apricot")
    order = _ids(storage.fetch_list(conn, sort="title"))
    # 二进制比较会把所有大写排在所有小写之前 → Zebra 会跑到 apricot 前面
    assert order.index(apricot) < order.index(zebra)


def test_updated_sort_follows_edits_not_creation_order(tmp_path):
    conn = _connect(tmp_path)
    first = storage.insert_note(conn, title="first")
    second = storage.insert_note(conn, title="second")

    # updated_at 只精确到秒，直接改列比 sleep 1 秒可靠也快
    conn.execute("UPDATE notes SET updated_at = ? WHERE id = ?", ("2020-01-01T00:00:00", second))
    conn.execute("UPDATE notes SET updated_at = ? WHERE id = ?", ("2030-01-01T00:00:00", first))
    conn.commit()

    assert _ids(storage.fetch_list(conn, sort="updated")) == [first, second]
    # 创建序不受影响，两种模式是真的分流了
    assert _ids(storage.fetch_list(conn, sort="created")) == [second, first]


def test_manual_sort_puts_never_placed_notes_on_top(tmp_path):
    """sort_order 默认 0、发号从 1 开始，所以新建的笔记浮在手动列表最上面，
    而不是掉到队尾让人以为没创建成功。"""
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")
    storage.set_manual_order(conn, [a, b])

    fresh = storage.insert_note(conn, title="fresh")

    assert _ids(storage.fetch_list(conn, sort="manual")) == [fresh, a, b]


def test_manual_order_round_trips_and_reports_moved_count(tmp_path):
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")
    c = storage.insert_note(conn, title="c")

    moved = storage.set_manual_order(conn, [c, a, b])

    assert moved == 3
    assert _ids(storage.fetch_list(conn, sort="manual")) == [c, a, b]
    # 重放同一个顺序不该产生写入——拖拽 UI 会乐观地重发，白写一遍就是白脏一遍
    assert storage.set_manual_order(conn, [c, a, b]) == 0


def test_manual_order_does_not_bump_updated_at(tmp_path):
    """拖一下不算编辑：改了 updated_at 会让"按更新时间排"被自己搅乱，
    也会让跨设备同步把纯显示操作当成内容变更推出去。"""
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")
    before = {row["id"]: row["updated_at"] for row in storage.fetch_list(conn)}

    storage.set_manual_order(conn, [b, a])

    after = {row["id"]: row["updated_at"] for row in storage.fetch_list(conn)}
    assert after == before


def test_manual_order_skips_unknown_and_trashed_ids(tmp_path):
    """拖拽 UI 手上的列表可能落后一个版本（别处刚删了一条）。这时候应该把
    剩下的排好，而不是整个手势失败。"""
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")
    gone = storage.insert_note(conn, title="gone")
    storage.soft_delete(conn, gone)

    moved = storage.set_manual_order(conn, [b, gone, 999999, a])

    assert moved == 2
    assert _ids(storage.fetch_list(conn, sort="manual")) == [b, a]


def test_unknown_sort_mode_falls_back_instead_of_raising(tmp_path):
    """排序是显示偏好，存坏了不该让整个笔记列表打不开。"""
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")

    assert _ids(storage.fetch_list(conn, sort="nonsense")) == [b, a]
    assert _ids(storage.fetch_list(conn, sort=None)) == [b, a]
    assert storage.order_clause("nonsense") == storage.order_clause("created")


def test_sort_mode_is_not_string_interpolated_from_caller(tmp_path):
    """order_clause 的返回值直接拼进 SQL，所以它只能从固定表里取。这条挡住
    "以后有人改成 f-string 拼 sort" 的回归——那是一个直通 SQL 注入的口子。"""
    conn = _connect(tmp_path)
    storage.insert_note(conn, title="a")

    # 带引号的注入串必须走不通默认分支，且绝不能执行
    rows = storage.fetch_list(conn, sort="created'; DROP TABLE notes; --")

    assert len(rows) == 1
    assert conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 1


def test_search_without_query_follows_sort_mode(tmp_path):
    """纯筛选（选了分类但没打字）没有相关度可言，必须跟随排序方式——
    否则"按标题排"一点开分类就悄悄失效。"""
    conn = _connect(tmp_path)
    banana = storage.insert_note(conn, title="banana", category="work")
    apple = storage.insert_note(conn, title="Apple", category="work")

    rows = storage.search_notes(conn, category="work", sort="title")

    assert _ids(rows) == [apple, banana]


def test_search_with_query_keeps_relevance_ordering(tmp_path):
    """有查询词时 bm25 相关度优先，排序方式不该把最相关的挤下去。

    insert_note 不会自己进 FTS 索引，须显式 reindex_note_fts，否则搜索恒返回空列表，断言以"没搜到"
    失败，看起来像排序坏了，实为夹具没搭对。
    """
    conn = _connect(tmp_path)
    weak = storage.insert_note(conn, title="zzz unrelated", content="budget")
    storage.reindex_note_fts(conn, weak, title="zzz unrelated", content="budget", category="", tags=[])
    bullseye = storage.insert_note(conn, title="budget", content="budget budget budget")
    storage.reindex_note_fts(
        conn, bullseye, title="budget", content="budget budget budget", category="", tags=[]
    )

    rows = storage.search_notes(conn, query="budget", sort="title")

    # 按标题排的话 "budget" < "zzz"，恰好同序；用 title 降序无法区分，所以直接
    # 断言相关度最高的在最前，并确认两条都在结果里（不是只剩一条造成的假通过）
    assert len(rows) == 2
    assert rows[0]["id"] == bullseye


def test_migration_adds_sort_order_to_a_pre_feature_database(tmp_path):
    """老库升级：补出的列全为 0，手动模式下仍按 id 序。
    SQLite 3.34 无 DROP COLUMN，故直接按旧形状建表。"""
    db_path = tmp_path / "notes.db"
    key = crypto.generate_key()

    raw = sqlcipher.connect(str(db_path))
    raw.execute(f'PRAGMA key = "{storage._hex_key(key)}"')
    raw.executescript(
        """
        CREATE TABLE notes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            title          TEXT NOT NULL DEFAULT '',
            category       TEXT NOT NULL DEFAULT '',
            content        TEXT NOT NULL DEFAULT '',
            content_storage_mode TEXT NOT NULL DEFAULT 'encrypted_db',
            content_path   TEXT,
            format         TEXT NOT NULL DEFAULT 'plain',
            preview        TEXT NOT NULL DEFAULT '',
            content_length INTEGER NOT NULL DEFAULT 0,
            is_pinned      INTEGER DEFAULT 0,
            is_hidden      INTEGER DEFAULT 0,
            is_deleted     INTEGER DEFAULT 0,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );
        INSERT INTO notes (title, created_at, updated_at)
            VALUES ('a', '2020-01-01T00:00:00', '2020-01-01T00:00:00');
        INSERT INTO notes (title, created_at, updated_at)
            VALUES ('b', '2020-01-01T00:00:00', '2020-01-01T00:00:00');
        """
    )
    raw.commit()
    assert "sort_order" not in {r[1] for r in raw.execute("PRAGMA table_info(notes)")}
    raw.close()

    conn = storage.connect(db_path, key)

    assert "sort_order" in {r[1] for r in conn.execute("PRAGMA table_info(notes)")}
    assert [r[0] for r in conn.execute("SELECT sort_order FROM notes ORDER BY id")] == [0, 0]
    a, b = [r[0] for r in conn.execute("SELECT id FROM notes ORDER BY id")]
    # 全 0 时决胜键是 id DESC，跟升级前的顺序一致——不是随机乱序
    assert _ids(storage.fetch_list(conn, sort="manual")) == [b, a]


def test_note_sort_mode_preference_round_trips(tmp_path):
    assert ui_settings.load_note_sort_mode(tmp_path) == "created"

    ui_settings.save_note_sort_mode(tmp_path, "manual")

    assert ui_settings.load_note_sort_mode(tmp_path) == "manual"


def test_corrupt_sort_preference_falls_back_to_default(tmp_path):
    ui_settings.note_sort_settings_path(tmp_path).write_text("{not json", encoding="utf-8")

    assert ui_settings.load_note_sort_mode(tmp_path) == "created"


def test_saving_an_invalid_sort_mode_is_rejected(tmp_path):
    with pytest.raises(ValueError):
        ui_settings.save_note_sort_mode(tmp_path, "by_vibes")
