import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.clipboard import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "clipboard.db", crypto.generate_key())


def _insert(conn, text):
    return storage.insert_entry(conn, content_type="text", content_text=text)


def test_soft_delete_bulk_marks_all_given_ids_deleted(tmp_path):
    conn = _connect(tmp_path)
    ids = [_insert(conn, f"entry {i}") for i in range(3)]

    deleted_count = storage.soft_delete_bulk(conn, ids)

    assert deleted_count == 3
    assert storage.fetch_recent(conn) == []
    assert {e["id"] for e in storage.fetch_deleted(conn)} == set(ids)


def test_soft_delete_bulk_only_affects_the_given_ids(tmp_path):
    conn = _connect(tmp_path)
    keep_id = _insert(conn, "keep me")
    delete_id = _insert(conn, "delete me")

    deleted_count = storage.soft_delete_bulk(conn, [delete_id])

    assert deleted_count == 1
    remaining_ids = {e["id"] for e in storage.fetch_recent(conn)}
    assert remaining_ids == {keep_id}


def test_soft_delete_bulk_ignores_already_deleted_and_unknown_ids(tmp_path):
    conn = _connect(tmp_path)
    already_deleted_id = _insert(conn, "already gone")
    storage.soft_delete(conn, already_deleted_id)
    unknown_id = 999999

    deleted_count = storage.soft_delete_bulk(conn, [already_deleted_id, unknown_id])

    assert deleted_count == 0


def test_soft_delete_bulk_clears_pinned_flag_like_single_delete(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "pinned entry")
    storage.set_pinned(conn, entry_id, True)

    storage.soft_delete_bulk(conn, [entry_id])

    [row] = storage.fetch_deleted(conn)
    assert row["is_pinned"] == 0


def test_soft_delete_bulk_with_empty_list_is_a_no_op(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "untouched")

    deleted_count = storage.soft_delete_bulk(conn, [])

    assert deleted_count == 0
    assert {e["id"] for e in storage.fetch_recent(conn)} == {entry_id}


def test_set_hidden_toggles_flag_and_is_reflected_in_fetch_recent(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "secret note")

    assert storage.set_hidden(conn, entry_id, True) is True
    [row] = storage.fetch_recent(conn)
    assert row["is_hidden"] == 1

    assert storage.set_hidden(conn, entry_id, False) is True
    [row] = storage.fetch_recent(conn)
    assert row["is_hidden"] == 0


def test_set_hidden_returns_false_for_deleted_or_unknown_entry(tmp_path):
    conn = _connect(tmp_path)
    deleted_id = _insert(conn, "gone")
    storage.soft_delete(conn, deleted_id)

    assert storage.set_hidden(conn, deleted_id, True) is False
    assert storage.set_hidden(conn, 999999, True) is False


def test_migrate_clipboard_hidden_column_backfills_pre_existing_database(tmp_path):
    db_path = tmp_path / "clipboard.db"
    key = crypto.generate_key()
    conn = storage.connect(db_path, key)
    entry_id = _insert(conn, "predates is_hidden")
    # 模拟"is_hidden 列引入之前"的旧库——手动把这一列从表里去掉，重新走一遍
    # connect() 触发迁移，验证旧数据不丢、新列正确补上默认值 0。
    conn.execute("ALTER TABLE clipboard_history RENAME TO clipboard_history_new")
    conn.execute(
        """
        CREATE TABLE clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, content_type TEXT NOT NULL, content_text TEXT,
            content_format TEXT, image_path TEXT, thumbnail_path TEXT, source_app TEXT,
            is_pinned INTEGER DEFAULT 0, is_sensitive INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0,
            is_truncated INTEGER DEFAULT 0, copy_count INTEGER DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO clipboard_history SELECT id, content_type, content_text, content_format, image_path, "
        "thumbnail_path, source_app, is_pinned, is_sensitive, is_deleted, is_truncated, copy_count, "
        "created_at, updated_at FROM clipboard_history_new"
    )
    conn.execute("DROP TABLE clipboard_history_new")
    conn.commit()
    conn.close()

    reopened = storage.connect(db_path, key)

    [row] = storage.fetch_recent(reopened)
    assert row["id"] == entry_id
    assert row["is_hidden"] == 0


def test_restore_bulk_moves_entries_back_out_of_trash(tmp_path):
    conn = _connect(tmp_path)
    ids = [_insert(conn, f"entry {i}") for i in range(3)]
    storage.soft_delete_bulk(conn, ids)

    restored_count = storage.restore_bulk(conn, ids)

    assert restored_count == 3
    assert {e["id"] for e in storage.fetch_recent(conn)} == set(ids)
    assert storage.fetch_deleted(conn) == []


def test_restore_bulk_only_restores_the_given_ids(tmp_path):
    conn = _connect(tmp_path)
    stay_in_trash_id = _insert(conn, "stays trashed")
    restore_id = _insert(conn, "gets restored")
    storage.soft_delete_bulk(conn, [stay_in_trash_id, restore_id])

    restored_count = storage.restore_bulk(conn, [restore_id])

    assert restored_count == 1
    assert {e["id"] for e in storage.fetch_recent(conn)} == {restore_id}
    assert {e["id"] for e in storage.fetch_deleted(conn)} == {stay_in_trash_id}


def test_restore_bulk_ignores_already_active_and_unknown_ids(tmp_path):
    conn = _connect(tmp_path)
    already_active_id = _insert(conn, "never trashed")
    unknown_id = 999999

    restored_count = storage.restore_bulk(conn, [already_active_id, unknown_id])

    assert restored_count == 0


def test_restore_bulk_with_empty_list_is_a_no_op(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "trashed")
    storage.soft_delete(conn, entry_id)

    restored_count = storage.restore_bulk(conn, [])

    assert restored_count == 0
    assert {e["id"] for e in storage.fetch_deleted(conn)} == {entry_id}


def test_hard_delete_removes_row_entirely(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "trashed")
    storage.soft_delete(conn, entry_id)

    ok, _image_path, _thumbnail_path = storage.hard_delete(conn, entry_id)

    assert ok
    assert storage.fetch_one(conn, entry_id) is None


def test_hard_delete_returns_false_for_unknown_id(tmp_path):
    conn = _connect(tmp_path)

    ok, image_path, thumbnail_path = storage.hard_delete(conn, 999999)

    assert ok is False
    assert image_path is None
    assert thumbnail_path is None


def test_hard_delete_reports_image_and_thumbnail_paths(tmp_path):
    conn = _connect(tmp_path)
    entry_id = storage.insert_entry(
        conn, content_type="image", image_path="/tmp/img.png", thumbnail_path="/tmp/thumb.png"
    )
    storage.soft_delete(conn, entry_id)

    ok, image_path, thumbnail_path = storage.hard_delete(conn, entry_id)

    assert ok
    assert image_path == "/tmp/img.png"
    assert thumbnail_path == "/tmp/thumb.png"


def test_hard_delete_bulk_removes_all_given_ids(tmp_path):
    conn = _connect(tmp_path)
    ids = [_insert(conn, f"entry {i}") for i in range(3)]
    storage.soft_delete_bulk(conn, ids)

    removed = storage.hard_delete_bulk(conn, ids)

    assert {row["id"] for row in removed} == set(ids)
    for entry_id in ids:
        assert storage.fetch_one(conn, entry_id) is None


def test_hard_delete_bulk_reports_image_and_thumbnail_paths(tmp_path):
    conn = _connect(tmp_path)
    entry_id = storage.insert_entry(
        conn, content_type="image", image_path="/tmp/img.png", thumbnail_path="/tmp/thumb.png"
    )
    storage.soft_delete(conn, entry_id)

    [removed] = storage.hard_delete_bulk(conn, [entry_id])

    assert removed["image_path"] == "/tmp/img.png"
    assert removed["thumbnail_path"] == "/tmp/thumb.png"


def test_hard_delete_bulk_with_empty_list_is_a_no_op(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "untouched")

    removed = storage.hard_delete_bulk(conn, [])

    assert removed == []
    assert storage.fetch_one(conn, entry_id) is not None


def test_insert_entry_with_is_snippet_marks_row_as_snippet(tmp_path):
    conn = _connect(tmp_path)

    entry_id = storage.insert_entry(conn, content_type="text", content_text="signature block", is_snippet=True)

    row = storage.fetch_one(conn, entry_id)
    assert row["is_snippet"] == 1


def test_fetch_recent_excludes_snippets(tmp_path):
    conn = _connect(tmp_path)
    history_id = _insert(conn, "real clipboard capture")
    storage.insert_entry(conn, content_type="text", content_text="my signature", is_snippet=True)

    assert {e["id"] for e in storage.fetch_recent(conn)} == {history_id}


def test_fetch_snippets_returns_only_snippets(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn, "real clipboard capture")
    snippet_id = storage.insert_entry(conn, content_type="text", content_text="my signature", is_snippet=True)

    assert {e["id"] for e in storage.fetch_snippets(conn)} == {snippet_id}


def test_fetch_snippets_excludes_deleted(tmp_path):
    conn = _connect(tmp_path)
    snippet_id = storage.insert_entry(conn, content_type="text", content_text="old address", is_snippet=True)
    storage.soft_delete(conn, snippet_id)

    assert storage.fetch_snippets(conn) == []


def test_update_snippet_text_changes_content(tmp_path):
    conn = _connect(tmp_path)
    snippet_id = storage.insert_entry(conn, content_type="text", content_text="v1", is_snippet=True)

    assert storage.update_snippet_text(conn, snippet_id, "v2") is True

    row = storage.fetch_one(conn, snippet_id)
    assert row["content_text"] == "v2"


def test_update_snippet_text_returns_false_for_non_snippet_entry(tmp_path):
    conn = _connect(tmp_path)
    history_id = _insert(conn, "not a snippet")

    assert storage.update_snippet_text(conn, history_id, "hijacked") is False
    row = storage.fetch_one(conn, history_id)
    assert row["content_text"] == "not a snippet"


def test_update_snippet_text_returns_false_for_deleted_or_unknown(tmp_path):
    conn = _connect(tmp_path)
    deleted_id = storage.insert_entry(conn, content_type="text", content_text="gone", is_snippet=True)
    storage.soft_delete(conn, deleted_id)

    assert storage.update_snippet_text(conn, deleted_id, "new text") is False
    assert storage.update_snippet_text(conn, 999999, "new text") is False


def test_migrate_clipboard_snippet_column_backfills_pre_existing_database(tmp_path):
    db_path = tmp_path / "clipboard.db"
    key = crypto.generate_key()
    conn = storage.connect(db_path, key)
    entry_id = _insert(conn, "predates is_snippet")
    # 模拟"is_snippet 列引入之前，但 is_hidden 已经存在"的旧库——只去掉
    # is_snippet 这一列，重新走一遍 connect() 触发迁移。
    conn.execute("ALTER TABLE clipboard_history RENAME TO clipboard_history_new")
    conn.execute(
        """
        CREATE TABLE clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, content_type TEXT NOT NULL, content_text TEXT,
            content_format TEXT, image_path TEXT, thumbnail_path TEXT, source_app TEXT,
            is_pinned INTEGER DEFAULT 0, is_sensitive INTEGER DEFAULT 0, is_hidden INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0, is_truncated INTEGER DEFAULT 0, copy_count INTEGER DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO clipboard_history SELECT id, content_type, content_text, content_format, image_path, "
        "thumbnail_path, source_app, is_pinned, is_sensitive, is_hidden, is_deleted, is_truncated, copy_count, "
        "created_at, updated_at FROM clipboard_history_new"
    )
    conn.execute("DROP TABLE clipboard_history_new")
    conn.commit()
    conn.close()

    reopened = storage.connect(db_path, key)

    [row] = storage.fetch_recent(reopened)
    assert row["id"] == entry_id
    assert row["is_snippet"] == 0


def test_fetch_recent_orders_by_id_regardless_of_pinned_state(tmp_path):
    conn = _connect(tmp_path)
    first_id = _insert(conn, "oldest")
    second_id = _insert(conn, "middle")
    third_id = _insert(conn, "newest")
    # 把最早插入的那条置顶——如果排序仍然按 is_pinned 优先，它会被排到
    # 最前面；现在的预期行为是纯粹按 id 从新到旧，置顶与否不影响顺序。
    storage.set_pinned(conn, first_id, True)

    ids_in_order = [e["id"] for e in storage.fetch_recent(conn)]

    assert ids_in_order == [third_id, second_id, first_id]


# --- content_rtf（Word 公式等粘贴回原程序时用的附加格式，见 listener.py::_read_rtf_bytes）---


def test_insert_entry_with_rtf_round_trips_through_fetch_rtf_payload(tmp_path):
    conn = _connect(tmp_path)
    entry_id = storage.insert_entry(
        conn, content_type="text", content_format="rich", content_text="<b>x</b>", content_rtf_b64="ZmFrZS1ydGY="
    )

    assert storage.fetch_rtf_payload(conn, entry_id) == "ZmFrZS1ydGY="


def test_fetch_rtf_payload_is_none_when_not_stored(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "plain text, never had rtf")

    assert storage.fetch_rtf_payload(conn, entry_id) is None


def test_fetch_rtf_payload_is_none_for_unknown_id(tmp_path):
    conn = _connect(tmp_path)

    assert storage.fetch_rtf_payload(conn, 999999) is None


def test_content_rtf_not_leaked_into_list_or_detail_views(tmp_path):
    # content_rtf 只该被 fetch_rtf_payload 这个窄查询读到：fetch_recent/fetch_one 的结果会整个经
    # JSON-RPC 推给前端或塞进"新记录"推送，混进大 Base64 纯属浪费（见 storage.py 的注释）。
    conn = _connect(tmp_path)
    entry_id = storage.insert_entry(
        conn, content_type="text", content_format="rich", content_text="<b>x</b>", content_rtf_b64="ZmFrZS1ydGY="
    )

    assert "content_rtf" not in storage.fetch_one(conn, entry_id)
    assert all("content_rtf" not in row for row in storage.fetch_recent(conn))


def test_migrate_clipboard_rtf_column_backfills_pre_existing_database(tmp_path):
    db_path = tmp_path / "clipboard.db"
    key = crypto.generate_key()
    conn = storage.connect(db_path, key)
    entry_id = _insert(conn, "predates content_rtf")
    # 模拟 content_rtf 列引入前的旧库：去掉该列再走 connect() 触发迁移，写法同上面
    # test_migrate_clipboard_snippet_column_backfills_pre_existing_database。
    conn.execute("ALTER TABLE clipboard_history RENAME TO clipboard_history_new")
    conn.execute(
        """
        CREATE TABLE clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, content_type TEXT NOT NULL, content_text TEXT,
            content_format TEXT, image_path TEXT, thumbnail_path TEXT, source_app TEXT,
            is_pinned INTEGER DEFAULT 0, is_sensitive INTEGER DEFAULT 0, is_hidden INTEGER DEFAULT 0,
            is_snippet INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0, is_truncated INTEGER DEFAULT 0,
            copy_count INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO clipboard_history SELECT id, content_type, content_text, content_format, image_path, "
        "thumbnail_path, source_app, is_pinned, is_sensitive, is_hidden, is_snippet, is_deleted, is_truncated, "
        "copy_count, created_at, updated_at FROM clipboard_history_new"
    )
    conn.execute("DROP TABLE clipboard_history_new")
    conn.commit()
    conn.close()

    reopened = storage.connect(db_path, key)

    [row] = storage.fetch_recent(reopened)
    assert row["id"] == entry_id
    assert storage.fetch_rtf_payload(reopened, entry_id) is None


# --- 全文搜索（FTS5）---


def test_fetch_search_matches_content_text(tmp_path):
    conn = _connect(tmp_path)
    match_id = _insert(conn, "quarterly budget report draft")
    _insert(conn, "grocery list for saturday")

    results = storage.fetch_search(conn, "budget")

    assert {e["id"] for e in results} == {match_id}


def test_fetch_search_with_blank_query_falls_back_to_recent(tmp_path):
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "anything")

    results = storage.fetch_search(conn, "   ")

    assert {e["id"] for e in results} == {entry_id}


def test_fetch_search_excludes_deleted_and_snippets(tmp_path):
    conn = _connect(tmp_path)
    deleted_id = _insert(conn, "budget deleted entry")
    storage.soft_delete(conn, deleted_id)
    storage.insert_entry(conn, content_type="text", content_text="budget snippet", is_snippet=True)
    live_id = _insert(conn, "budget still active")

    results = storage.fetch_search(conn, "budget")

    assert {e["id"] for e in results} == {live_id}


def test_fetch_search_reflects_updates_via_trigger(tmp_path):
    # clipboard_history_au 触发器要在 UPDATE 时同步 FTS 索引——用置顶(会触发
    # UPDATE)之后原关键词仍能搜到,间接验证触发器没有把索引搞坏。
    conn = _connect(tmp_path)
    entry_id = _insert(conn, "budget entry to be pinned")

    storage.set_pinned(conn, entry_id, True)
    results = storage.fetch_search(conn, "budget")

    assert {e["id"] for e in results} == {entry_id}


def test_fetch_search_no_match_returns_empty(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn, "something else entirely")

    assert storage.fetch_search(conn, "nonexistentword") == []


def test_fetch_search_finds_chinese_word_inside_a_run_of_characters(tmp_path):
    """中文搜索回归：clipboard_history_fts 用 unicode61 分词，无标点的整段中文是一个 token，
    只靠 MATCH 时"预算"搜不到"本季度预算超支了三千元"，且不报错。"""
    conn = _connect(tmp_path)
    run_id = _insert(conn, "本季度预算超支了三千元")
    punctuated_id = _insert(conn, "本季度，预算 超支了")
    _insert(conn, "完全无关的一条")

    assert {e["id"] for e in storage.fetch_search(conn, "预算")} == {run_id, punctuated_id}
    assert {e["id"] for e in storage.fetch_search(conn, "季度")} == {run_id, punctuated_id}
    # 多个词仍然是 AND
    assert {e["id"] for e in storage.fetch_search(conn, "预算 三千")} == {run_id}
    assert storage.fetch_search(conn, "报销") == []


def test_fetch_search_invalid_fts_syntax_does_not_masquerade_as_results(tmp_path):
    """语法不合法时不能把"最近几条"当搜索结果端上来（旧实现回落到 fetch_recent，用户看到的是一串
    与查询无关的记录且无从知晓）。"""
    conn = _connect(tmp_path)
    matching_id = _insert(conn, "value is (draft) today")
    _insert(conn, "totally unrelated line")

    results = storage.fetch_search(conn, "(draft")

    assert {e["id"] for e in results} == {matching_id}


# --- 按最大条目数清理 ---


def test_enforce_max_entries_removes_oldest_over_the_cap(tmp_path):
    conn = _connect(tmp_path)
    ids = [_insert(conn, f"entry {i}") for i in range(5)]

    removed = storage.enforce_max_entries(conn, max_entries=3)

    assert removed == 2
    remaining_ids = {e["id"] for e in storage.fetch_recent(conn)}
    assert remaining_ids == set(ids[2:])  # the 2 oldest (ids[0], ids[1]) are gone


def test_enforce_max_entries_is_a_no_op_when_under_the_cap(tmp_path):
    conn = _connect(tmp_path)
    ids = [_insert(conn, f"entry {i}") for i in range(3)]

    removed = storage.enforce_max_entries(conn, max_entries=10)

    assert removed == 0
    assert {e["id"] for e in storage.fetch_recent(conn)} == set(ids)


def test_enforce_max_entries_never_removes_pinned_or_hidden_entries(tmp_path):
    conn = _connect(tmp_path)
    pinned_id = _insert(conn, "oldest but pinned")
    storage.set_pinned(conn, pinned_id, True)
    hidden_id = _insert(conn, "oldest but hidden")
    storage.set_hidden(conn, hidden_id, True)
    plain_id = _insert(conn, "newest plain entry, the only removable one")

    # cap=1 通常会把 3 条压到 1 条，但置顶/隐藏必须豁免——真正被清理的只能是
    # 那唯一不受保护的 plain_id，即使它其实是三者中最新的一条。
    removed = storage.enforce_max_entries(conn, max_entries=1)

    assert removed == 1
    remaining_ids = {e["id"] for e in storage.fetch_recent(conn)}
    assert remaining_ids == {pinned_id, hidden_id}


def test_enforce_max_entries_does_not_count_snippets_toward_the_cap(tmp_path):
    conn = _connect(tmp_path)
    for i in range(10):
        storage.insert_entry(conn, content_type="text", content_text=f"snippet {i}", is_snippet=True)
    ids = [_insert(conn, f"entry {i}") for i in range(3)]

    # 10 个片段 + 3 条真实历史。片段不算"历史记录"的一部分（跟 fetch_recent
    # 口径一致），cap=5 时不应该因为片段数量被误判为超限。
    removed = storage.enforce_max_entries(conn, max_entries=5)

    assert removed == 0
    assert {e["id"] for e in storage.fetch_recent(conn)} == set(ids)


def test_enforce_max_entries_reads_configured_setting_when_not_passed_explicitly(tmp_path):
    conn = _connect(tmp_path)
    storage.update_settings(conn, {"max_entries": 100})
    ids = [_insert(conn, f"entry {i}") for i in range(3)]

    removed = storage.enforce_max_entries(conn)  # no explicit max_entries -> reads setting (100)

    assert removed == 0
    assert {e["id"] for e in storage.fetch_recent(conn)} == set(ids)


# --- 按保留天数清理（自动清理周期）---


def test_enforce_age_cleanup_soft_deletes_entries_older_than_cutoff(tmp_path):
    conn = _connect(tmp_path)
    old_id = _insert(conn, "ancient entry")
    conn.execute("UPDATE clipboard_history SET created_at = '2000-01-01T00:00:00' WHERE id = ?", (old_id,))
    conn.commit()
    fresh_id = _insert(conn, "brand new entry")

    removed = storage.enforce_age_cleanup(conn, cleanup_days=7)

    assert removed == 1
    assert {e["id"] for e in storage.fetch_recent(conn)} == {fresh_id}
    assert {e["id"] for e in storage.fetch_deleted(conn)} == {old_id}  # 进回收站，不是硬删除


def test_enforce_age_cleanup_disabled_when_cleanup_days_is_zero(tmp_path):
    conn = _connect(tmp_path)
    old_id = _insert(conn, "ancient entry")
    conn.execute("UPDATE clipboard_history SET created_at = '2000-01-01T00:00:00' WHERE id = ?", (old_id,))
    conn.commit()

    removed = storage.enforce_age_cleanup(conn, cleanup_days=0)

    assert removed == 0
    assert {e["id"] for e in storage.fetch_recent(conn)} == {old_id}


def test_enforce_age_cleanup_exempts_pinned_hidden_and_snippet_entries(tmp_path):
    conn = _connect(tmp_path)
    pinned_id = _insert(conn, "old but pinned")
    storage.set_pinned(conn, pinned_id, True)
    hidden_id = _insert(conn, "old but hidden")
    storage.set_hidden(conn, hidden_id, True)
    for entry_id in (pinned_id, hidden_id):
        conn.execute("UPDATE clipboard_history SET created_at = '2000-01-01T00:00:00' WHERE id = ?", (entry_id,))
    conn.commit()

    removed = storage.enforce_age_cleanup(conn, cleanup_days=7)

    assert removed == 0
    remaining_ids = {e["id"] for e in storage.fetch_recent(conn)}
    assert {pinned_id, hidden_id} <= remaining_ids


def test_enforce_age_cleanup_reads_configured_setting_when_not_passed_explicitly(tmp_path):
    conn = _connect(tmp_path)
    storage.update_settings(conn, {"cleanup_days": 0})  # 默认"永不"
    old_id = _insert(conn, "ancient entry")
    conn.execute("UPDATE clipboard_history SET created_at = '2000-01-01T00:00:00' WHERE id = ?", (old_id,))
    conn.commit()

    removed = storage.enforce_age_cleanup(conn)

    assert removed == 0
    assert {e["id"] for e in storage.fetch_recent(conn)} == {old_id}


# --- 设置（最大条目数 / 清理周期）---


def test_get_all_settings_returns_defaults_on_fresh_database(tmp_path):
    conn = _connect(tmp_path)

    settings = storage.get_all_settings(conn)

    assert settings == {"max_entries": 500, "cleanup_days": 0, "cleanup_hours": "04:00", "sensitive_ttl_minutes": 0}


def test_update_settings_round_trips_through_get_all_settings(tmp_path):
    conn = _connect(tmp_path)

    storage.update_settings(conn, {"max_entries": 1000, "cleanup_days": 30, "cleanup_hours": "02:30", "sensitive_ttl_minutes": 0})

    assert storage.get_all_settings(conn) == {"max_entries": 1000, "cleanup_days": 30, "cleanup_hours": "02:30", "sensitive_ttl_minutes": 0}


def test_update_settings_clamps_max_entries_to_valid_range(tmp_path):
    conn = _connect(tmp_path)

    storage.update_settings(conn, {"max_entries": 1})  # below the 50 floor
    assert storage.get_all_settings(conn)["max_entries"] == 50

    storage.update_settings(conn, {"max_entries": 999999})  # above the 5000 ceiling
    assert storage.get_all_settings(conn)["max_entries"] == 5000


def test_update_settings_clamps_cleanup_days_to_valid_range(tmp_path):
    conn = _connect(tmp_path)

    storage.update_settings(conn, {"cleanup_days": -5})
    assert storage.get_all_settings(conn)["cleanup_days"] == 0

    storage.update_settings(conn, {"cleanup_days": 9999})
    assert storage.get_all_settings(conn)["cleanup_days"] == 365


def test_update_settings_rejects_malformed_cleanup_hours(tmp_path):
    conn = _connect(tmp_path)

    storage.update_settings(conn, {"cleanup_hours": "not-a-time"})

    # 非法格式静默忽略，保留默认值，而不是存进一个坏值
    assert storage.get_all_settings(conn)["cleanup_hours"] == "04:00"


def test_update_settings_ignores_unknown_keys_without_raising(tmp_path):
    conn = _connect(tmp_path)

    storage.update_settings(conn, {"totally_unknown_setting": "value"})  # should not raise

    assert storage.get_all_settings(conn) == {"max_entries": 500, "cleanup_days": 0, "cleanup_hours": "04:00", "sensitive_ttl_minutes": 0}


# --- 敏感内容标记（is_sensitive 列）---


def test_insert_entry_with_is_sensitive_marks_row(tmp_path):
    conn = _connect(tmp_path)

    entry_id = storage.insert_entry(conn, content_type="text", content_text="ghp_" + "a" * 36, is_sensitive=True)

    row = storage.fetch_one(conn, entry_id)
    assert row["is_sensitive"] == 1


def test_insert_entry_without_is_sensitive_defaults_to_not_sensitive(tmp_path):
    conn = _connect(tmp_path)

    entry_id = _insert(conn, "just a normal note")

    row = storage.fetch_one(conn, entry_id)
    assert row["is_sensitive"] == 0
