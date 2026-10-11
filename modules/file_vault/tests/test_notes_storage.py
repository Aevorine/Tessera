import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, errors
from modules.file_vault.notes import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "notes.db", crypto.generate_key())


def test_insert_and_fetch_one_round_trips_full_content(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Todo", category="work", content="line1\nline2")

    row = storage.fetch_one(conn, note_id)

    assert row["title"] == "Todo"
    assert row["category"] == "work"
    assert row["content"] == "line1\nline2"
    assert row["content_length"] == len("line1\nline2".encode("utf-8"))


def test_fetch_list_never_includes_full_content(tmp_path):
    conn = _connect(tmp_path)
    storage.insert_note(conn, title="Todo", content="x" * 5000)

    [row] = storage.fetch_list(conn)

    assert "content" not in row
    assert row["preview"] == "x" * storage.PREVIEW_CHARS


def test_fetch_list_orders_pinned_first_then_newest(tmp_path):
    conn = _connect(tmp_path)
    a = storage.insert_note(conn, title="a")
    b = storage.insert_note(conn, title="b")
    c = storage.insert_note(conn, title="c")
    storage.set_pinned(conn, a, True)

    ids = [row["id"] for row in storage.fetch_list(conn)]

    assert ids == [a, c, b]


def test_fetch_metadata_returns_list_shape_without_content(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Large", category="work", content="body" * 100)

    row = storage.fetch_metadata(conn, note_id)

    assert row is not None
    assert row["title"] == "Large"
    assert row["content_length"] == len(("body" * 100).encode("utf-8"))
    assert "content" not in row


def test_update_note_partial_update_only_changes_given_fields(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="old title", category="cat1", content="old content")

    ok = storage.update_note(conn, note_id, title="new title")

    assert ok
    row = storage.fetch_one(conn, note_id)
    assert row["title"] == "new title"
    assert row["category"] == "cat1"
    assert row["content"] == "old content"


def test_update_note_content_recomputes_preview_and_length(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t", content="short")

    storage.update_note(conn, note_id, content="a much longer replacement body")

    row = storage.fetch_one(conn, note_id)
    assert row["content"] == "a much longer replacement body"
    assert row["preview"] == "a much longer replacement body"
    assert row["content_length"] == len("a much longer replacement body".encode("utf-8"))


def test_update_note_on_missing_id_returns_false(tmp_path):
    conn = _connect(tmp_path)

    assert storage.update_note(conn, 999999, title="x") is False


def test_update_note_on_soft_deleted_note_returns_false(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")
    storage.soft_delete(conn, note_id)

    assert storage.update_note(conn, note_id, title="new") is False


def test_insert_note_over_byte_limit_raises_vault_error(tmp_path, monkeypatch):
    # 生产中 NOTE_BYTE_LIMIT 为 2GiB，这里改小以便用几个字节越界。
    monkeypatch.setattr(storage, "NOTE_BYTE_LIMIT", 10)
    conn = _connect(tmp_path)

    with pytest.raises(errors.VaultError) as exc_info:
        storage.insert_note(conn, title="huge", content="x" * 11)

    assert exc_info.value.code == "notes.content_too_large"


def test_update_note_over_byte_limit_raises_and_does_not_modify_row(tmp_path, monkeypatch):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t", content="fine")

    monkeypatch.setattr(storage, "NOTE_BYTE_LIMIT", 10)
    with pytest.raises(errors.VaultError):
        storage.update_note(conn, note_id, content="x" * 11)

    row = storage.fetch_one(conn, note_id)
    assert row["content"] == "fine"


def test_insert_note_with_content_byte_size_override_skips_deriving_from_content(tmp_path):
    # create_note_from_file 的 disk_plain 路径：调用方已知真实大小/预览，`content` 只是占位，
    # 持久化的 preview/content_length 必须取自 override 参数。
    conn = _connect(tmp_path)
    note_id = storage.insert_note(
        conn,
        title="big file",
        content="",
        content_storage_mode="disk_plain",
        content_path="/fake/path.txt",
        content_byte_size=123_456_789,
        content_preview="first two hundred chars go here",
    )

    row = storage.fetch_one(conn, note_id)
    assert row["content_length"] == 123_456_789
    assert row["preview"] == "first two hundred chars go here"
    assert row["content"] == ""  # disk_plain always persists an empty content column


def test_insert_note_with_content_byte_size_override_still_enforces_the_ceiling(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "NOTE_BYTE_LIMIT", 10)
    conn = _connect(tmp_path)

    with pytest.raises(errors.VaultError) as exc_info:
        storage.insert_note(
            conn,
            title="huge file",
            content="",
            content_storage_mode="disk_plain",
            content_path="/fake/path.txt",
            content_byte_size=11,
            content_preview="",
        )

    assert exc_info.value.code == "notes.content_too_large"


def test_set_pinned_bulk_updates_all_given_ids(tmp_path):
    conn = _connect(tmp_path)
    ids = [storage.insert_note(conn, title=f"n{i}") for i in range(3)]

    count = storage.set_pinned_bulk(conn, ids, True)

    assert count == 3
    assert all(row["is_pinned"] == 1 for row in storage.fetch_list(conn))


def test_set_hidden_bulk_updates_all_given_ids(tmp_path):
    conn = _connect(tmp_path)
    ids = [storage.insert_note(conn, title=f"n{i}") for i in range(3)]

    count = storage.set_hidden_bulk(conn, ids, True)

    assert count == 3
    assert all(row["is_hidden"] == 1 for row in storage.fetch_list(conn))


def test_set_hidden_bulk_with_empty_list_is_a_no_op(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="n")

    count = storage.set_hidden_bulk(conn, [], True)

    assert count == 0
    assert storage.fetch_list(conn)[0]["is_hidden"] == 0
    assert note_id  # keep referenced


def test_soft_delete_moves_note_out_of_list_and_into_trash(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")

    ok = storage.soft_delete(conn, note_id)

    assert ok
    assert storage.fetch_list(conn) == []
    assert {row["id"] for row in storage.fetch_deleted(conn)} == {note_id}


def test_soft_delete_bulk_clears_pinned_flag(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")
    storage.set_pinned(conn, note_id, True)

    storage.soft_delete_bulk(conn, [note_id])

    [row] = storage.fetch_deleted(conn)
    assert row["is_pinned"] == 0


def test_restore_moves_note_back_out_of_trash(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")
    storage.soft_delete(conn, note_id)

    ok = storage.restore(conn, note_id)

    assert ok
    assert {row["id"] for row in storage.fetch_list(conn)} == {note_id}
    assert storage.fetch_deleted(conn) == []


def test_hard_delete_removes_row_entirely(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")
    storage.soft_delete(conn, note_id)

    ok, _removed_images, _removed_content_paths = storage.hard_delete(conn, note_id)

    assert ok
    assert storage.fetch_one(conn, note_id) is None


def test_hard_delete_bulk_removes_all_given_ids(tmp_path):
    conn = _connect(tmp_path)
    ids = [storage.insert_note(conn, title=f"n{i}") for i in range(3)]
    for note_id in ids:
        storage.soft_delete(conn, note_id)

    count, _removed_images, _removed_content_paths = storage.hard_delete_bulk(conn, ids)

    assert count == 3
    for note_id in ids:
        assert storage.fetch_one(conn, note_id) is None


def test_purge_expired_deleted_removes_only_old_trash(tmp_path):
    conn = _connect(tmp_path)
    old_id = storage.insert_note(conn, title="old")
    storage.soft_delete(conn, old_id)
    # Backdate updated_at past the retention window directly - simulates
    # "this was trashed 8 days ago" without sleeping in the test.
    old_cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 8 * 86400))
    conn.execute("UPDATE notes SET updated_at = ? WHERE id = ?", (old_cutoff, old_id))
    conn.commit()

    recent_id = storage.insert_note(conn, title="recent")
    storage.soft_delete(conn, recent_id)

    purged_count, _removed_images, _removed_content_paths = storage.purge_expired_deleted(conn, days=7)

    assert purged_count == 1
    assert storage.fetch_one(conn, old_id) is None
    assert storage.fetch_one(conn, recent_id) is not None


def test_create_category_then_list_is_scoped_and_sorted(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "旅行", "normal")
    storage.create_category(conn, "阅读", "normal")
    storage.create_category(conn, "证件信息", "hidden")

    normal = storage.list_categories(conn, "normal")
    hidden = storage.list_categories(conn, "hidden")

    assert [c["name"] for c in normal] == ["旅行", "阅读"]
    assert [c["name"] for c in hidden] == ["证件信息"]


def test_create_category_is_idempotent_per_name_and_scope(tmp_path):
    conn = _connect(tmp_path)
    first = storage.create_category(conn, "旅行", "normal")
    second = storage.create_category(conn, "旅行", "normal")

    assert first["id"] == second["id"]
    assert len(storage.list_categories(conn, "normal")) == 1


def test_create_category_same_name_different_scope_are_independent(tmp_path):
    conn = _connect(tmp_path)
    normal_cat = storage.create_category(conn, "其他", "normal")
    hidden_cat = storage.create_category(conn, "其他", "hidden")

    assert normal_cat["id"] != hidden_cat["id"]
    assert len(storage.list_categories(conn, "normal")) == 1
    assert len(storage.list_categories(conn, "hidden")) == 1


def test_create_category_rejects_blank_name(tmp_path):
    conn = _connect(tmp_path)

    with pytest.raises(errors.VaultError) as exc_info:
        storage.create_category(conn, "   ", "normal")

    assert exc_info.value.code == "notes.category_name_required"


def test_delete_category_reassigns_notes_instead_of_leaving_orphan_category_text(tmp_path):
    """delete_category 契约已有意改变（见 test_notes_category_tree.py）：
    删一级分类时笔记归到父级（promote，默认）或整棵子树连笔记清掉（cascade），不留悬空引用。"""
    conn = _connect(tmp_path)
    category = storage.create_category(conn, "旅行", "normal")
    note_id = storage.insert_note(conn, title="t", category="旅行")

    impact = storage.delete_category(conn, category["id"])

    assert impact is not None
    assert storage.list_categories(conn, "normal") == []
    # 顶级分类的父级就是"未分类"——笔记还在，只是失去归属，不会指向一个已经
    # 不存在的分类
    assert storage.fetch_one(conn, note_id)["category"] == ""


def test_delete_category_unknown_id_returns_none(tmp_path):
    conn = _connect(tmp_path)

    assert storage.delete_category(conn, 999999) is None


# --- categories.keywords（导入文件自动分类用，见 notes/classifier.py）---


def test_create_category_defaults_to_empty_keywords(tmp_path):
    conn = _connect(tmp_path)
    category = storage.create_category(conn, "旅行", "normal")

    assert category["keywords"] == ""
    assert storage.list_categories(conn, "normal")[0]["keywords"] == ""


def test_create_category_with_keywords_persists_them(tmp_path):
    conn = _connect(tmp_path)
    category = storage.create_category(conn, "财务", "normal", keywords="发票, 报销")

    assert category["keywords"] == "发票, 报销"
    assert storage.list_categories(conn, "normal")[0]["keywords"] == "发票, 报销"


def test_create_category_idempotent_call_does_not_overwrite_existing_keywords(tmp_path):
    conn = _connect(tmp_path)
    storage.create_category(conn, "财务", "normal", keywords="发票, 报销")

    second = storage.create_category(conn, "财务", "normal", keywords="should not apply")

    assert second["keywords"] == "发票, 报销"


def test_set_category_keywords_updates_existing_category(tmp_path):
    conn = _connect(tmp_path)
    category = storage.create_category(conn, "财务", "normal")

    updated = storage.set_category_keywords(conn, category["id"], "发票, 报销")

    assert updated["keywords"] == "发票, 报销"
    assert storage.list_categories(conn, "normal")[0]["keywords"] == "发票, 报销"


def test_set_category_keywords_unknown_id_returns_none(tmp_path):
    conn = _connect(tmp_path)

    assert storage.set_category_keywords(conn, 999999, "x") is None


def test_legacy_categories_schema_migrates_and_defaults_existing_rows_to_empty_keywords(tmp_path):
    # 模拟 categories.keywords 出现之前的老库：
    # connect() 原地加列不丢行，旧行 keywords == ''。
    key = crypto.generate_key()
    conn = storage.connect(tmp_path / "notes.db", key)
    conn.executescript(
        """
        DROP TABLE categories;
        CREATE TABLE categories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            scope      TEXT NOT NULL CHECK (scope IN ('normal', 'hidden')),
            created_at TEXT NOT NULL,
            UNIQUE (name, scope)
        );
        """
    )
    conn.execute(
        "INSERT INTO categories (name, scope, created_at) VALUES (?, ?, ?)",
        ("旅行", "normal", "2026-01-01T00:00:00"),
    )
    conn.commit()
    conn.close()

    migrated_conn = storage.connect(tmp_path / "notes.db", key)

    [row] = storage.list_categories(migrated_conn, "normal")
    assert row["name"] == "旅行"
    assert row["keywords"] == ""


# --- list_categories_in_use（把"手动用过但没建进分类目录"的分类名也纳入
# 分类器候选，见 notes/classifier.py 与 notes/service.py）---


def test_list_categories_in_use_returns_distinct_non_empty_categories(tmp_path):
    conn = _connect(tmp_path)
    storage.insert_note(conn, title="a", category="工作")
    storage.insert_note(conn, title="b", category="工作")
    storage.insert_note(conn, title="c", category="生活")
    storage.insert_note(conn, title="d", category="")

    assert storage.list_categories_in_use(conn, "normal") == ["工作", "生活"]


def test_list_categories_in_use_excludes_deleted_notes(tmp_path):
    conn = _connect(tmp_path)
    trashed_id = storage.insert_note(conn, title="a", category="工作")
    storage.soft_delete(conn, trashed_id)

    assert storage.list_categories_in_use(conn, "normal") == []


def test_list_categories_in_use_scopes_by_hidden_flag(tmp_path):
    conn = _connect(tmp_path)
    storage.insert_note(conn, title="a", category="工作", is_hidden=False)
    storage.insert_note(conn, title="b", category="账号密码", is_hidden=True)

    assert storage.list_categories_in_use(conn, "normal") == ["工作"]
    assert storage.list_categories_in_use(conn, "hidden") == ["账号密码"]


def _insert_db_image(conn, note_id, image_data=b"full-bytes", thumbnail_data=b"thumb-bytes", mime_type="image/png"):
    return storage.insert_image(
        conn,
        note_id,
        mime_type=mime_type,
        byte_size=len(image_data),
        storage_mode="encrypted_db",
        image_data=image_data,
        thumbnail_data=thumbnail_data,
    )


def _insert_disk_image(conn, note_id, image_path, thumbnail_path, byte_size=123, mime_type="image/png"):
    return storage.insert_image(
        conn,
        note_id,
        mime_type=mime_type,
        byte_size=byte_size,
        storage_mode="disk_plain",
        image_path=image_path,
        thumbnail_path=thumbnail_path,
    )


def test_insert_image_encrypted_db_then_list_excludes_full_data_get_includes_it(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")

    image = _insert_db_image(conn, note_id)
    assert image["storage_mode"] == "encrypted_db"

    [listed] = storage.list_images(conn, note_id)
    assert "image_data" not in listed
    assert listed["thumbnail_data"] == b"thumb-bytes"

    full = storage.get_image(conn, image["id"])
    assert full["image_data"] == b"full-bytes"
    assert full["mime_type"] == "image/png"


def test_insert_image_disk_plain_stores_paths_not_bytes(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")

    image = _insert_disk_image(conn, note_id, str(tmp_path / "a.png"), str(tmp_path / "a_thumb.png"))
    assert image["storage_mode"] == "disk_plain"
    assert image["thumbnail_path"] == str(tmp_path / "a_thumb.png")
    assert image["thumbnail_data"] is None

    full = storage.get_image(conn, image["id"])
    assert full["image_path"] == str(tmp_path / "a.png")
    assert full["image_data"] is None


def test_insert_image_over_byte_limit_raises_vault_error(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")

    with pytest.raises(errors.VaultError) as exc_info:
        _insert_db_image(conn, note_id, image_data=b"x" * (storage.NOTE_IMAGE_BYTE_LIMIT + 1), thumbnail_data=b"thumb")

    assert exc_info.value.code == "notes.image_too_large"
    assert storage.list_images(conn, note_id) == []


def test_delete_image_removes_row_and_returns_path_info(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")
    image = _insert_disk_image(conn, note_id, "img.png", "thumb.png")

    removed = storage.delete_image(conn, image["id"])

    assert removed == {"id": image["id"], "storage_mode": "disk_plain", "image_path": "img.png", "thumbnail_path": "thumb.png"}
    assert storage.get_image(conn, image["id"]) is None


def test_delete_image_unknown_id_returns_none(tmp_path):
    conn = _connect(tmp_path)

    assert storage.delete_image(conn, 999999) is None


def test_hard_delete_also_removes_its_images_and_reports_disk_paths(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="t")
    image = _insert_disk_image(conn, note_id, "img.png", "thumb.png")
    storage.soft_delete(conn, note_id)

    ok, removed_images, _removed_content_paths = storage.hard_delete(conn, note_id)

    assert ok
    assert [r["id"] for r in removed_images] == [image["id"]]
    assert removed_images[0]["image_path"] == "img.png"
    assert storage.get_image(conn, image["id"]) is None


def test_hard_delete_bulk_also_removes_their_images(tmp_path):
    conn = _connect(tmp_path)
    ids = [storage.insert_note(conn, title=f"n{i}") for i in range(2)]
    images = [_insert_db_image(conn, note_id) for note_id in ids]
    for note_id in ids:
        storage.soft_delete(conn, note_id)

    _count, removed_images, _removed_content_paths = storage.hard_delete_bulk(conn, ids)

    assert {r["id"] for r in removed_images} == {image["id"] for image in images}
    for image in images:
        assert storage.get_image(conn, image["id"]) is None


def test_purge_expired_deleted_also_removes_images_of_purged_notes(tmp_path):
    conn = _connect(tmp_path)
    old_id = storage.insert_note(conn, title="old")
    image = _insert_db_image(conn, old_id)
    storage.soft_delete(conn, old_id)
    old_cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 8 * 86400))
    conn.execute("UPDATE notes SET updated_at = ? WHERE id = ?", (old_cutoff, old_id))
    conn.commit()

    purged_count, removed_images, _removed_content_paths = storage.purge_expired_deleted(conn, days=7)

    assert purged_count == 1
    assert [r["id"] for r in removed_images] == [image["id"]]
    assert storage.get_image(conn, image["id"]) is None


def test_legacy_note_images_schema_migrates_and_keeps_existing_rows_readable(tmp_path):
    # 模拟 storage_mode/image_path 出现之前的 note_images：
    # connect() 原地升级不丢行，旧行标为 'encrypted_db'。
    key = crypto.generate_key()
    conn = storage.connect(tmp_path / "notes.db", key)
    note_id = storage.insert_note(conn, title="t")
    conn.executescript(
        """
        DROP TABLE note_images;
        CREATE TABLE note_images (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id        INTEGER NOT NULL,
            image_data     BLOB NOT NULL,
            thumbnail_data BLOB NOT NULL,
            mime_type      TEXT NOT NULL,
            byte_size      INTEGER NOT NULL,
            created_at     TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO note_images (note_id, image_data, thumbnail_data, mime_type, byte_size, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (note_id, b"old-full", b"old-thumb", "image/png", 8, "2026-01-01T00:00:00"),
    )
    conn.commit()
    conn.close()

    migrated_conn = storage.connect(tmp_path / "notes.db", key)

    [row] = storage.list_images(migrated_conn, note_id)
    assert row["storage_mode"] == "encrypted_db"
    assert row["thumbnail_data"] == b"old-thumb"
    full = storage.get_image(migrated_conn, row["id"])
    assert full["image_data"] == b"old-full"


# --- content_storage_mode（笔记正文加密/明文双模式，仿 note_images.storage_mode）---


def test_legacy_notes_schema_migrates_and_defaults_existing_rows_to_encrypted_db(tmp_path):
    # 模拟 content_storage_mode/content_path 出现之前的老库：
    # connect() 原地加列不丢行，旧行标为 'encrypted_db'。
    key = crypto.generate_key()
    conn = storage.connect(tmp_path / "notes.db", key)
    conn.executescript(
        """
        DROP TABLE notes;
        CREATE TABLE notes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            title          TEXT NOT NULL DEFAULT '',
            category       TEXT NOT NULL DEFAULT '',
            content        TEXT NOT NULL DEFAULT '',
            preview        TEXT NOT NULL DEFAULT '',
            content_length INTEGER NOT NULL DEFAULT 0,
            is_pinned      INTEGER DEFAULT 0,
            is_hidden      INTEGER DEFAULT 0,
            is_deleted     INTEGER DEFAULT 0,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO notes (title, category, content, preview, content_length, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("Old note", "", "old text", "old text", len(b"old text"), "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
    )
    conn.commit()
    conn.close()

    migrated_conn = storage.connect(tmp_path / "notes.db", key)

    [row] = storage.fetch_list(migrated_conn)
    assert row["content_storage_mode"] == "encrypted_db"
    full = storage.fetch_one(migrated_conn, row["id"])
    assert full["content"] == "old text"
    assert full["content_path"] is None


# --- format（笔记正文是纯文本还是Markdown）---


def test_legacy_notes_schema_migrates_and_defaults_existing_rows_to_plain_format(tmp_path):
    # 模拟 format 列出现之前的老库：connect() 原地加列不丢行，旧行标为 'plain'。
    key = crypto.generate_key()
    conn = storage.connect(tmp_path / "notes.db", key)
    conn.executescript(
        """
        DROP TABLE notes;
        CREATE TABLE notes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            title          TEXT NOT NULL DEFAULT '',
            category       TEXT NOT NULL DEFAULT '',
            content        TEXT NOT NULL DEFAULT '',
            content_storage_mode TEXT NOT NULL DEFAULT 'encrypted_db',
            content_path   TEXT,
            preview        TEXT NOT NULL DEFAULT '',
            content_length INTEGER NOT NULL DEFAULT 0,
            is_pinned      INTEGER DEFAULT 0,
            is_hidden      INTEGER DEFAULT 0,
            is_deleted     INTEGER DEFAULT 0,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO notes (title, category, content, preview, content_length, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("Old note", "", "old text", "old text", len(b"old text"), "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
    )
    conn.commit()
    conn.close()

    migrated_conn = storage.connect(tmp_path / "notes.db", key)

    [row] = storage.fetch_list(migrated_conn)
    assert row["format"] == "plain"


def test_insert_note_defaults_to_plain_format(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Todo", content="x")

    assert storage.fetch_one(conn, note_id)["format"] == "plain"


def test_insert_note_accepts_markdown_format(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Doc", content="# heading", format="markdown")

    assert storage.fetch_one(conn, note_id)["format"] == "markdown"


def test_update_note_changes_format(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Todo", content="x")

    storage.update_note(conn, note_id, format="markdown")

    assert storage.fetch_one(conn, note_id)["format"] == "markdown"


def test_insert_note_disk_plain_mode_keeps_content_column_empty_but_preview_intact(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(
        conn,
        title="Plain",
        content="secret-ish plain text",
        content_storage_mode="disk_plain",
        content_path="/fake/path.txt",
    )

    row = storage.fetch_one(conn, note_id)
    assert row["content_storage_mode"] == "disk_plain"
    assert row["content_path"] == "/fake/path.txt"
    assert row["content"] == ""  # real text isn't persisted in the encrypted db column
    assert row["preview"] == "secret-ish plain text"
    assert row["content_length"] == len("secret-ish plain text".encode("utf-8"))


def test_update_note_disk_plain_mode_recomputes_preview_but_keeps_content_column_empty(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(
        conn, title="Plain", content="v1", content_storage_mode="disk_plain", content_path="/fake/path.txt"
    )

    ok = storage.update_note(conn, note_id, content="v2 updated")

    assert ok
    row = storage.fetch_one(conn, note_id)
    assert row["content"] == ""
    assert row["preview"] == "v2 updated"
    assert row["content_length"] == len("v2 updated".encode("utf-8"))
    assert row["content_storage_mode"] == "disk_plain"  # unchanged - immutable per row


def test_update_note_encrypted_db_mode_still_stores_real_content(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Enc", content="v1")

    storage.update_note(conn, note_id, content="v2")

    row = storage.fetch_one(conn, note_id)
    assert row["content"] == "v2"
    assert row["content_storage_mode"] == "encrypted_db"


def test_update_note_content_on_nonexistent_note_returns_false(tmp_path):
    conn = _connect(tmp_path)
    assert storage.update_note(conn, 999999, content="x") is False


def test_hard_delete_reports_disk_plain_content_path(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(
        conn, title="Plain", content="text", content_storage_mode="disk_plain", content_path="/fake/note.txt"
    )
    storage.soft_delete(conn, note_id)

    ok, removed_images, removed_content_paths = storage.hard_delete(conn, note_id)

    assert ok
    assert removed_images == []
    assert removed_content_paths == ["/fake/note.txt"]


def test_hard_delete_encrypted_db_note_reports_no_content_paths(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="Enc", content="text")
    storage.soft_delete(conn, note_id)

    _ok, _removed_images, removed_content_paths = storage.hard_delete(conn, note_id)

    assert removed_content_paths == []


def test_purge_expired_deleted_reports_disk_plain_content_paths(tmp_path):
    conn = _connect(tmp_path)
    old_id = storage.insert_note(
        conn, title="old", content="text", content_storage_mode="disk_plain", content_path="/fake/old.txt"
    )
    storage.soft_delete(conn, old_id)
    old_cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 8 * 86400))
    conn.execute("UPDATE notes SET updated_at = ? WHERE id = ?", (old_cutoff, old_id))
    conn.commit()

    purged_count, _removed_images, removed_content_paths = storage.purge_expired_deleted(conn, days=7)

    assert purged_count == 1
    assert removed_content_paths == ["/fake/old.txt"]


# --- 标签与全文检索（P1 M6/M7）---


def test_create_tag_is_idempotent_per_name_and_scope(tmp_path):
    conn = _connect(tmp_path)

    first = storage.create_tag(conn, "项目", "normal")
    second = storage.create_tag(conn, "项目", "normal")

    assert first["id"] == second["id"]
    assert [tag["name"] for tag in storage.list_tags(conn, "normal")] == ["项目"]


def test_create_tag_rejects_blank_name(tmp_path):
    conn = _connect(tmp_path)

    with pytest.raises(errors.VaultError) as exc_info:
        storage.create_tag(conn, "   ", "normal")

    assert exc_info.value.code == "notes.tag_name_required"


def test_set_note_tags_replaces_tag_set_and_lists_tag_names(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="路线图")
    first = storage.create_tag(conn, "后端", "normal")
    second = storage.create_tag(conn, "紧急", "normal")

    storage.set_note_tags(conn, note_id, [first["id"], second["id"]])
    storage.set_note_tags(conn, note_id, [second["id"]])

    assert storage.get_tags_for_note(conn, note_id) == [{"id": second["id"], "name": "紧急"}]
    assert storage.get_tag_names_for_notes(conn, [note_id]) == {note_id: ["紧急"]}


def test_delete_tag_removes_assignments(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="路线图")
    tag = storage.create_tag(conn, "后端", "normal")
    storage.set_note_tags(conn, note_id, [tag["id"]])

    assert storage.delete_tag(conn, tag["id"])
    assert storage.get_tags_for_note(conn, note_id) == []


def test_search_notes_matches_title_content_and_tag_with_combined_filters(tmp_path):
    conn = _connect(tmp_path)
    matched_id = storage.insert_note(
        conn,
        title="发布计划",
        category="工作/项目A",
        content="本周完成 API 联调",
        updated_at="2026-07-10T09:00:00",
    )
    wrong_category_id = storage.insert_note(
        conn,
        title="发布计划",
        category="生活",
        content="本周完成 API 联调",
        updated_at="2026-07-10T09:00:00",
    )
    tag = storage.create_tag(conn, "紧急", "normal")
    storage.set_note_tags(conn, matched_id, [tag["id"]])
    storage.reindex_note_fts(
        conn,
        matched_id,
        title="发布计划",
        content="本周完成 API 联调",
        category="工作/项目A",
        tags=["紧急"],
    )
    storage.reindex_note_fts(
        conn,
        wrong_category_id,
        title="发布计划",
        content="本周完成 API 联调",
        category="生活",
        tags=[],
    )

    results = storage.search_notes(
        conn,
        query="API",
        category="工作/项目A",
        tag="紧急",
        date_from="2026-07-01T00:00:00",
        date_to="2026-07-31T23:59:59",
    )

    assert [row["id"] for row in results] == [matched_id]


def test_search_notes_finds_chinese_word_inside_a_run_of_characters(tmp_path):
    """中文搜索回归：notes_fts 的 unicode61 把无标点中文当一个 token，
    仅靠 MATCH 搜"预算""季度"会返回空而不报错。"""
    conn = _connect(tmp_path)
    run_id = storage.insert_note(conn, title="季度小结", content="本季度预算超支了三千元，需要复盘。")
    punctuated_id = storage.insert_note(conn, title="带标点", content="本季度，预算 超支了。")
    storage.reindex_note_fts(conn, run_id, title="季度小结", content="本季度预算超支了三千元，需要复盘。", category="", tags=[])
    storage.reindex_note_fts(conn, punctuated_id, title="带标点", content="本季度，预算 超支了。", category="", tags=[])

    # 夹在连续汉字中间的词：以前只能找到被标点隔开的那一条
    assert {row["id"] for row in storage.search_notes(conn, query="预算")} == {run_id, punctuated_id}
    # 以前一条都找不到
    assert {row["id"] for row in storage.search_notes(conn, query="季度")} == {run_id, punctuated_id}
    # 多个词仍然是 AND，不因为多走一遍子串就变成 OR
    assert {row["id"] for row in storage.search_notes(conn, query="预算 复盘")} == {run_id}
    # 都没有的词还是空
    assert storage.search_notes(conn, query="报销") == []


def test_search_notes_substring_pass_respects_narrowing_filters(tmp_path):
    """子串那一遍必须跟 FTS 那一遍受同样的分类/时间限制，不能绕过筛选。"""
    conn = _connect(tmp_path)
    wanted = storage.insert_note(
        conn, title="甲", category="工作", content="本季度预算超支", updated_at="2026-07-10T09:00:00"
    )
    other_category = storage.insert_note(
        conn, title="乙", category="生活", content="本季度预算超支", updated_at="2026-07-10T09:00:00"
    )
    storage.reindex_note_fts(conn, wanted, title="甲", content="本季度预算超支", category="工作", tags=[])
    storage.reindex_note_fts(conn, other_category, title="乙", content="本季度预算超支", category="生活", tags=[])

    assert [row["id"] for row in storage.search_notes(conn, query="预算", category="工作")] == [wanted]
    assert storage.search_notes(conn, query="预算", category="工作", date_from="2026-08-01T00:00:00") == []


def test_search_notes_substring_pass_escapes_like_wildcards(tmp_path):
    """搜 `100%` 不能被当成通配符，否则会把所有笔记都"搜"出来。"""
    conn = _connect(tmp_path)
    literal_id = storage.insert_note(conn, title="占比", content="完成度100%达标了")
    unrelated_id = storage.insert_note(conn, title="别的", content="完全无关的中文内容")
    storage.reindex_note_fts(conn, literal_id, title="占比", content="完成度100%达标了", category="", tags=[])
    storage.reindex_note_fts(conn, unrelated_id, title="别的", content="完全无关的中文内容", category="", tags=[])

    assert [row["id"] for row in storage.search_notes(conn, query="度100%达")] == [literal_id]


def test_find_notes_mentioning_title_matches_content_containing_title(tmp_path):
    conn = _connect(tmp_path)
    target_id = storage.insert_note(conn, title="项目会议纪要", content="标题本身")
    storage.reindex_note_fts(conn, target_id, title="项目会议纪要", content="标题本身", category="", tags=[])
    mentioning_id = storage.insert_note(conn, title="周报", content="详见项目会议纪要的结论")
    storage.reindex_note_fts(conn, mentioning_id, title="周报", content="详见项目会议纪要的结论", category="", tags=[])
    unrelated_id = storage.insert_note(conn, title="购物清单", content="牛奶、鸡蛋")
    storage.reindex_note_fts(conn, unrelated_id, title="购物清单", content="牛奶、鸡蛋", category="", tags=[])

    results = storage.find_notes_mentioning_title(conn, target_id, "项目会议纪要")

    assert [row["id"] for row in results] == [mentioning_id]


def test_find_notes_mentioning_title_matches_english_phrase_in_content(tmp_path):
    conn = _connect(tmp_path)
    target_id = storage.insert_note(conn, title="Release Plan", content="details")
    storage.reindex_note_fts(conn, target_id, title="Release Plan", content="details", category="", tags=[])
    mentioning_id = storage.insert_note(conn, title="Weekly Notes", content="See the Release Plan for details")
    storage.reindex_note_fts(
        conn, mentioning_id, title="Weekly Notes", content="See the Release Plan for details", category="", tags=[]
    )

    results = storage.find_notes_mentioning_title(conn, target_id, "Release Plan")

    assert [row["id"] for row in results] == [mentioning_id]


def test_find_notes_mentioning_title_excludes_the_note_itself(tmp_path):
    conn = _connect(tmp_path)
    # 笔记正文里恰好也提到了自己的标题——不应该把自己列进"被谁提到"里。
    note_id = storage.insert_note(conn, title="自省", content="今天继续写自省这篇笔记")
    storage.reindex_note_fts(conn, note_id, title="自省", content="今天继续写自省这篇笔记", category="", tags=[])

    assert storage.find_notes_mentioning_title(conn, note_id, "自省") == []


def test_find_notes_mentioning_title_excludes_deleted_notes(tmp_path):
    conn = _connect(tmp_path)
    target_id = storage.insert_note(conn, title="项目会议纪要", content="")
    storage.reindex_note_fts(conn, target_id, title="项目会议纪要", content="", category="", tags=[])
    mentioning_id = storage.insert_note(conn, title="周报", content="详见项目会议纪要")
    storage.reindex_note_fts(conn, mentioning_id, title="周报", content="详见项目会议纪要", category="", tags=[])
    storage.soft_delete(conn, mentioning_id)

    assert storage.find_notes_mentioning_title(conn, target_id, "项目会议纪要") == []


def test_find_notes_mentioning_title_does_not_match_title_only_occurrence(tmp_path):
    conn = _connect(tmp_path)
    target_id = storage.insert_note(conn, title="项目会议纪要", content="")
    storage.reindex_note_fts(conn, target_id, title="项目会议纪要", content="", category="", tags=[])
    # 另一篇笔记自己的标题恰好同名，但正文里没有这几个字——不该被当成
    # "正文里提到了"，即使 FTS5 索引里同一个词确实存在于它的 title 列。
    same_title_id = storage.insert_note(conn, title="项目会议纪要", content="不相关的内容")
    storage.reindex_note_fts(conn, same_title_id, title="项目会议纪要", content="不相关的内容", category="", tags=[])

    assert storage.find_notes_mentioning_title(conn, target_id, "项目会议纪要") == []


def test_find_notes_mentioning_title_returns_empty_for_blank_title(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="", content="正文")
    storage.reindex_note_fts(conn, note_id, title="", content="正文", category="", tags=[])

    assert storage.find_notes_mentioning_title(conn, note_id, "   ") == []


def test_search_notes_treats_fts_operators_as_literal_text(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="AND 复盘", content="literal query operator")
    storage.reindex_note_fts(conn, note_id, title="AND 复盘", content="literal query operator", category="", tags=[])

    assert [row["id"] for row in storage.search_notes(conn, query="AND")] == [note_id]


def test_hard_delete_removes_fts_and_tag_rows(tmp_path):
    conn = _connect(tmp_path)
    note_id = storage.insert_note(conn, title="待删除", content="searchable")
    tag = storage.create_tag(conn, "归档", "normal")
    storage.set_note_tags(conn, note_id, [tag["id"]])
    storage.reindex_note_fts(conn, note_id, title="待删除", content="searchable", category="", tags=["归档"])
    storage.soft_delete(conn, note_id)

    storage.hard_delete(conn, note_id)

    assert conn.execute("SELECT count(*) FROM notes_fts WHERE rowid = ?", (note_id,)).fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM note_tags WHERE note_id = ?", (note_id,)).fetchone()[0] == 0


def test_update_category_bulk_changes_only_active_notes(tmp_path):
    conn = _connect(tmp_path)
    active_id = storage.insert_note(conn, title="active", category="old")
    deleted_id = storage.insert_note(conn, title="deleted", category="old")
    storage.soft_delete(conn, deleted_id)

    assert storage.update_category_bulk(conn, [active_id, deleted_id], "工作/项目A") == 1
    assert storage.fetch_one(conn, active_id)["category"] == "工作/项目A"
    assert storage.fetch_one(conn, deleted_id)["category"] == "old"


def test_restore_bulk_restores_only_trashed_notes(tmp_path):
    conn = _connect(tmp_path)
    trashed_id = storage.insert_note(conn, title="trashed")
    active_id = storage.insert_note(conn, title="active")
    storage.soft_delete(conn, trashed_id)

    assert storage.restore_bulk(conn, [trashed_id, active_id]) == 1
    assert storage.fetch_one(conn, trashed_id)["is_deleted"] == 0


def test_add_tag_bulk_tags_only_active_notes(tmp_path):
    conn = _connect(tmp_path)
    active_id = storage.insert_note(conn, title="active")
    deleted_id = storage.insert_note(conn, title="deleted")
    storage.soft_delete(conn, deleted_id)
    tag = storage.create_tag(conn, "待办", "normal")

    assert storage.add_tag_bulk(conn, [active_id, deleted_id], tag["id"]) == 1
    assert storage.get_tags_for_note(conn, active_id) == [{"id": tag["id"], "name": "待办"}]
    assert storage.get_tags_for_note(conn, deleted_id) == []


def test_reindex_notes_fts_bulk_indexes_every_entry_in_one_batch(tmp_path):
    conn = _connect(tmp_path)
    first_id = storage.insert_note(conn, title="一")
    second_id = storage.insert_note(conn, title="二")

    storage.reindex_notes_fts_bulk(
        conn,
        [
            (first_id, "一", "batchneedle-one", "", []),
            (second_id, "二", "batchneedle-two", "", []),
        ],
    )

    assert {row["id"] for row in storage.search_notes(conn, query="batchneedle")} == {first_id, second_id}
