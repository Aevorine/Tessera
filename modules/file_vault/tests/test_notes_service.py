"""notes/service.py 中不属于 storage.py 的文件处理逻辑（流式 txt 导入、disk_plain 文件生命周期）
的进程内测试。纯存储层行为留在 test_notes_storage.py；这里的 NotesService 会对 tmp_path 做真实
文件 I/O。"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, errors  # noqa: E402
from modules.file_vault.notes import segmented_content, storage  # noqa: E402
from modules.file_vault.notes import service as service_module  # noqa: E402
from modules.file_vault.notes.service import NotesService  # noqa: E402


def _make_service(tmp_path) -> NotesService:
    return NotesService(tmp_path / "data", crypto.generate_key())


def test_create_note_from_file_disk_plain_streams_content_matching_source(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    source_text = "line\n" * 700_000  # ~3.5MB - spans several _STREAM_CHUNK_CHARS iterations
    source.write_text(source_text, encoding="utf-8")

    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=False)

    assert note["content_storage_mode"] == "disk_plain"
    assert "content" not in note  # import flow refreshes a list, never needed the content read back

    fetched = service.get_note(note["id"])
    assert fetched["content"] == source_text
    assert fetched["content_length"] == len(source_text.encode("utf-8"))
    assert fetched["preview"] == source_text[: storage.PREVIEW_CHARS]


def test_create_note_from_file_disk_plain_falls_back_to_gbk(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "gbk.txt"
    source.write_bytes("你好世界，这是一段GBK编码的文本".encode("gbk"))

    note = service.create_note_from_file(title="gbk", category="", source_path=str(source), encrypt=False)

    fetched = service.get_note(note["id"])
    assert fetched["content"] == "你好世界，这是一段GBK编码的文本"


def test_create_note_from_file_disk_plain_reports_progress_up_to_completion(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    source.write_text("x" * 3_000_000, encoding="utf-8")
    progress_calls = []

    service.create_note_from_file(
        title="big",
        category="",
        source_path=str(source),
        encrypt=False,
        on_progress=lambda done, total: progress_calls.append((done, total)),
    )

    assert progress_calls
    last_done, last_total = progress_calls[-1]
    assert last_done == last_total == 3_000_000


def test_create_note_from_file_disk_plain_over_ceiling_cleans_up_partial_file(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "NOTE_BYTE_LIMIT", 100)
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    source.write_text("x" * 500, encoding="utf-8")

    with pytest.raises(errors.VaultError) as exc_info:
        service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=False)

    assert exc_info.value.code == "notes.content_too_large"
    assert list(service.texts_dir.glob("*.txt")) == []  # partial dest file removed, not left behind


def test_create_note_from_file_encrypted_db_still_reads_whole_file(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "secret.txt"
    source.write_text("secret content", encoding="utf-8")

    note = service.create_note_from_file(title="secret", category="", source_path=str(source), encrypt=True)

    assert note["content_storage_mode"] == "encrypted_db"
    assert "content" not in note
    fetched = service.get_note(note["id"])
    assert fetched["content"] == "secret content"


def test_create_note_from_file_missing_source_raises_read_failed(tmp_path):
    service = _make_service(tmp_path)
    missing = tmp_path / "does_not_exist.txt"

    with pytest.raises(errors.VaultError) as exc_info:
        service.create_note_from_file(title="x", category="", source_path=str(missing), encrypt=False)

    assert exc_info.value.code == "notes.import_read_failed"


# --- format（导入.md/.markdown自动打markdown标签，其余含.txt打plain）---


@pytest.mark.parametrize("suffix,encrypt", [(".txt", True), (".txt", False), (".md", True), (".md", False), (".markdown", True)])
def test_create_note_from_file_tags_format_by_source_extension(tmp_path, suffix, encrypt):
    service = _make_service(tmp_path)
    source = tmp_path / f"doc{suffix}"
    source.write_text("# heading\ntext", encoding="utf-8")

    note = service.create_note_from_file(title="doc", category="", source_path=str(source), encrypt=encrypt)

    expected = "markdown" if suffix in (".md", ".markdown") else "plain"
    fetched = service.get_note(note["id"])
    assert fetched["format"] == expected


def test_create_note_defaults_to_plain_format(tmp_path):
    service = _make_service(tmp_path)

    note = service.create_note(title="x", category="", content="hello")

    assert note["format"] == "plain"


def test_set_format_updates_existing_note(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="x", category="", content="# heading")

    updated = service.set_format(note["id"], "markdown")

    assert updated["format"] == "markdown"
    assert service.get_note(note["id"])["format"] == "markdown"


def test_set_format_rejects_invalid_value(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="x", category="", content="hello")

    with pytest.raises(errors.VaultError) as exc_info:
        service.set_format(note["id"], "html")

    assert exc_info.value.code == "notes.invalid_format"


def test_set_format_missing_note_returns_none(tmp_path):
    service = _make_service(tmp_path)

    assert service.set_format(999, "markdown") is None


def _read_all_chunks(service, note_id, max_chars):
    chunks = []
    cursor = None
    while True:
        result = service.get_content_chunk(note_id, cursor, max_chars)
        chunks.append(result["chunk"])
        cursor = result["next_cursor"]
        if result["eof"]:
            return "".join(chunks)


def test_get_content_chunk_disk_plain_round_trips_regardless_of_chunk_size(tmp_path):
    service = _make_service(tmp_path)
    original = "第一段很长的中文内容\n" * 5000 + "tail"
    note = service.create_note(title="t", category="", content=original, encrypt=False)

    assert _read_all_chunks(service, note["id"], max_chars=777) == original


def test_get_content_chunk_encrypted_db_round_trips_and_stays_cached(tmp_path):
    service = _make_service(tmp_path)
    original = "hello " * 100_000
    note = service.create_note(title="t", category="", content=original, encrypt=True)

    first = service.get_content_chunk(note["id"], None, max_chars=1000)
    assert first["eof"] is False
    assert note["id"] in service._chunk_read_cache  # cached after first partial read

    rest_chunks = [first["chunk"]]
    cursor = first["next_cursor"]
    while True:
        result = service.get_content_chunk(note["id"], cursor, max_chars=50_000)
        rest_chunks.append(result["chunk"])
        cursor = result["next_cursor"]
        if result["eof"]:
            break

    assert "".join(rest_chunks) == original
    # 读到底后故意留着缓存：用户会在几条笔记间来回跳，读完即丢则翻回来要重新从加密库读整篇。
    # 留存边界由条数、总字符数、存活时长三道闸门管（见 service.py 的 __init__），不是无限期。
    assert note["id"] in service._chunk_read_cache


def test_get_content_chunk_keeps_several_notes_and_drops_the_oldest(tmp_path):
    """换一条笔记不再把上一条挤掉——那正是"翻回去要重读整篇"的来源。
    超出条数上限时才按最久未用淘汰。"""
    service = _make_service(tmp_path)
    ids = [
        service.create_note(title=str(i), category="", content=str(i) * 5000, encrypt=True)["id"]
        for i in range(service_module._CHUNK_CACHE_MAX_ENTRIES + 1)
    ]
    for note_id in ids:
        service.get_content_chunk(note_id, None, max_chars=10)

    assert ids[0] not in service._chunk_read_cache, "最久没用的那条该被挤出去"
    for note_id in ids[1:]:
        assert note_id in service._chunk_read_cache


def test_get_content_chunk_cache_goes_stale_when_the_note_changes(tmp_path):
    """改过内容之后必须读到新的。旧内容在界面上跟对的内容长得一模一样，
    这类错一旦发生极难被发现，所以单独守一条。"""
    service = _make_service(tmp_path)
    note_id = service.create_note(title="t", category="", content="旧" * 3000, encrypt=True)["id"]
    service.get_content_chunk(note_id, None, max_chars=10)          # 进缓存
    service.update_note(note_id, content="新" * 3000)
    again = service.get_content_chunk(note_id, cursor=0, max_chars=10)
    assert again["chunk"] == "新" * 10


def test_get_content_chunk_missing_note_raises_not_found(tmp_path):
    service = _make_service(tmp_path)

    with pytest.raises(errors.VaultError) as exc_info:
        service.get_content_chunk(999, None, max_chars=100)

    assert exc_info.value.code == "notes.note_not_found"


def test_get_content_chunk_disk_plain_missing_file_raises_content_not_found(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="t", category="", content="x", encrypt=False)
    for f in service.texts_dir.glob("*.txt"):
        f.unlink()

    with pytest.raises(errors.VaultError) as exc_info:
        service.get_content_chunk(note["id"], None, max_chars=100)

    assert exc_info.value.code == "notes.content_not_found"


def _write_all_chunks(service, note_id, content, chunk_size):
    pieces = [content[i : i + chunk_size] for i in range(0, len(content), chunk_size)] or [""]
    result = None
    for i, piece in enumerate(pieces):
        result = service.write_content_chunk(
            note_id, piece, is_first=(i == 0), is_last=(i == len(pieces) - 1)
        )
    return result


def test_write_content_chunk_disk_plain_replaces_content_and_updates_metadata(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="t", category="", content="old content", encrypt=False)

    new_content = "brand new content\n" * 200
    result = _write_all_chunks(service, note["id"], new_content, chunk_size=37)

    assert result["done"] is True
    assert result["note"]["content_length"] == len(new_content.encode("utf-8"))
    fetched = service.get_note(note["id"])
    assert fetched["content"] == new_content
    assert fetched["preview"] == new_content[: storage.PREVIEW_CHARS]
    # 只有一份磁盘文件——落盘用的是原子替换，不是又新建一份
    assert len(list(service.texts_dir.glob("*.txt"))) == 1
    assert len(list(service.texts_dir.glob("*.tmp"))) == 0


def test_write_content_chunk_encrypted_db_replaces_content(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="t", category="", content="old content", encrypt=True)

    new_content = "全新的中文正文内容\n" * 300
    result = _write_all_chunks(service, note["id"], new_content, chunk_size=41)

    assert result["done"] is True
    fetched = service.get_note(note["id"])
    assert fetched["content"] == new_content
    assert fetched["content_length"] == len(new_content.encode("utf-8"))


def test_write_content_chunk_without_is_first_raises_write_session_not_found(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="t", category="", content="x", encrypt=False)

    with pytest.raises(errors.VaultError) as exc_info:
        service.write_content_chunk(note["id"], "chunk", is_first=False, is_last=True)

    assert exc_info.value.code == "notes.write_session_not_found"


def test_write_content_chunk_missing_note_raises_not_found(tmp_path):
    service = _make_service(tmp_path)

    with pytest.raises(errors.VaultError) as exc_info:
        service.write_content_chunk(999, "chunk", is_first=True, is_last=True)

    assert exc_info.value.code == "notes.note_not_found"


def test_write_content_chunk_disk_plain_over_ceiling_aborts_and_keeps_old_content(tmp_path, monkeypatch):
    service = _make_service(tmp_path)
    note = service.create_note(title="t", category="", content="old content", encrypt=False)
    monkeypatch.setattr(storage, "NOTE_BYTE_LIMIT", 10)

    with pytest.raises(errors.VaultError) as exc_info:
        service.write_content_chunk(note["id"], "x" * 11, is_first=True, is_last=True)

    assert exc_info.value.code == "notes.content_too_large"
    assert service.get_note(note["id"])["content"] == "old content"  # untouched - atomic swap never happened
    assert len(list(service.texts_dir.glob("*.tmp"))) == 0  # partial temp file cleaned up


def test_write_content_chunk_starting_a_different_note_aborts_the_previous_session(tmp_path):
    service = _make_service(tmp_path)
    note_a = service.create_note(title="a", category="", content="a content", encrypt=False)
    note_b = service.create_note(title="b", category="", content="b content", encrypt=False)

    service.write_content_chunk(note_a["id"], "half-written a", is_first=True, is_last=False)
    assert len(list(service.texts_dir.glob("*.tmp"))) == 1

    # 开始给 note_b 写入，note_a 那个没收尾的会话应该被清掉（关掉临时文件
    # 句柄、删掉临时文件），不留下孤儿文件，note_a 本身的内容也不受影响
    service.write_content_chunk(note_b["id"], "b new content", is_first=True, is_last=True)

    assert len(list(service.texts_dir.glob("*.tmp"))) == 0
    assert service.get_note(note_a["id"])["content"] == "a content"
    assert service.get_note(note_b["id"])["content"] == "b new content"


# --- 标签与全文检索（P1 M6/M7）---


def test_create_note_is_immediately_full_text_searchable(tmp_path):
    service = _make_service(tmp_path)

    note = service.create_note(title="部署清单", category="工作/发布", content="检查 API 密钥", encrypt=True)

    assert [row["id"] for row in service.search_notes(query="API")] == [note["id"]]


def test_set_note_tags_updates_note_and_fts_search(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="发布", category="工作", content="", encrypt=True)
    tag = service.create_tag("紧急", "normal")

    updated = service.set_note_tags(note["id"], [tag["id"]])

    assert updated["tags"] == ["紧急"]
    assert [row["id"] for row in service.search_notes(query="紧急")] == [note["id"]]


def test_segment_session_reads_and_updates_only_its_note(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("first", 5), ("second", 6)])

    opened = service.open_segment_session(note["id"])
    loaded = service.get_segment(opened["session_id"], 0)
    updated = service.put_segment(opened["session_id"], loaded["segment"]["id"], 1, "edited")

    assert opened["segment_count"] == 2
    assert loaded["segment"]["content"] == "first"
    assert updated["segment"]["content"] == "edited"
    assert updated["segment"]["revision"] == 2


def test_segment_session_expires_after_ttl(tmp_path, monkeypatch):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("first", 5)])

    fake_time = [1000.0]
    monkeypatch.setattr(service_module.time, "monotonic", lambda: fake_time[0])
    opened = service.open_segment_session(note["id"])

    fake_time[0] += service_module._SEGMENT_SESSION_TTL_SECONDS + 1
    with pytest.raises(errors.VaultError) as exc_info:
        service.get_segment(opened["session_id"], 0)

    assert exc_info.value.code == "notes.segment_session_not_found"


def test_segment_session_activity_extends_expiry(tmp_path, monkeypatch):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("first", 5)])

    fake_time = [1000.0]
    monkeypatch.setattr(service_module.time, "monotonic", lambda: fake_time[0])
    opened = service.open_segment_session(note["id"])

    fake_time[0] += service_module._SEGMENT_SESSION_TTL_SECONDS - 10
    service.get_segment(opened["session_id"], 0)  # activity resets the idle clock

    fake_time[0] += service_module._SEGMENT_SESSION_TTL_SECONDS - 10
    result = service.get_segment(opened["session_id"], 0)

    assert result["segment"]["content"] == "first"


def test_segment_session_caps_concurrent_sessions(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("first", 5)])

    session_ids = [
        service.open_segment_session(note["id"])["session_id"]
        for _ in range(service_module._MAX_SEGMENT_SESSIONS + 3)
    ]

    assert len(service._segment_sessions) == service_module._MAX_SEGMENT_SESSIONS
    for sid in session_ids[-service_module._MAX_SEGMENT_SESSIONS :]:
        assert sid in service._segment_sessions


def test_put_segment_reports_revision_conflict_distinctly(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("first", 5)])
    opened = service.open_segment_session(note["id"])
    loaded = service.get_segment(opened["session_id"], 0)

    with pytest.raises(errors.VaultError) as exc_info:
        service.put_segment(opened["session_id"], loaded["segment"]["id"], 999, "stale write")

    assert exc_info.value.code == "notes.segment_revision_conflict"


def test_put_segment_rejects_segment_from_another_note(tmp_path):
    service = _make_service(tmp_path)
    note_a = service.create_note(title="A", category="", content="", encrypt=True)
    note_b = service.create_note(title="B", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note_a["id"], [("a-content", 9)])
    storage.replace_segments(service.conn, note_b["id"], [("b-content", 9)])

    session_b = service.open_segment_session(note_b["id"])
    segment_a = service.get_segment(service.open_segment_session(note_a["id"])["session_id"], 0)["segment"]

    with pytest.raises(errors.VaultError) as exc_info:
        service.put_segment(session_b["session_id"], segment_a["id"], 1, "hijack attempt")

    assert exc_info.value.code == "notes.segment_session_not_found"


def test_get_segment_missing_ordinal_raises_segment_not_found(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("only", 4)])
    opened = service.open_segment_session(note["id"])

    with pytest.raises(errors.VaultError) as exc_info:
        service.get_segment(opened["session_id"], 5)

    assert exc_info.value.code == "notes.segment_not_found"


def test_get_segment_with_closed_session_raises_session_not_found(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("only", 4)])
    opened = service.open_segment_session(note["id"])
    service.close_segment_session(opened["session_id"])

    with pytest.raises(errors.VaultError) as exc_info:
        service.get_segment(opened["session_id"], 0)

    assert exc_info.value.code == "notes.segment_session_not_found"


def test_put_segment_over_ceiling_raises_segment_too_large(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Large", category="", content="", encrypt=True)
    storage.replace_segments(service.conn, note["id"], [("only", 4)])
    opened = service.open_segment_session(note["id"])
    loaded = service.get_segment(opened["session_id"], 0)

    oversized = "x" * (segmented_content.MAX_SEGMENT_BYTES + 1)
    with pytest.raises(errors.VaultError) as exc_info:
        service.put_segment(opened["session_id"], loaded["segment"]["id"], 1, oversized)

    assert exc_info.value.code == "notes.segment_too_large"


def test_open_segment_session_converts_disk_plain_note_via_streaming(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    lines = "".join(f"line {i}\n" for i in range(400_000))  # spans several _STREAM_CHUNK_CHARS reads
    source.write_text(lines, encoding="utf-8")
    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=False)
    assert note["content_storage_mode"] == "disk_plain"

    opened = service.open_segment_session(note["id"])

    assert opened["segment_count"] > 1
    reconstructed = "".join(
        service.get_segment(opened["session_id"], i)["segment"]["content"] for i in range(opened["segment_count"])
    )
    assert reconstructed == lines


def test_open_segment_session_converts_disk_plain_gbk_note_via_streaming(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "gbk.txt"
    text = "你好世界，这是一段GBK编码的文本\n" * 50_000
    source.write_bytes(text.encode("gbk"))
    note = service.create_note_from_file(title="gbk", category="", source_path=str(source), encrypt=False)

    opened = service.open_segment_session(note["id"])
    reconstructed = "".join(
        service.get_segment(opened["session_id"], i)["segment"]["content"] for i in range(opened["segment_count"])
    )

    assert reconstructed == text


def test_open_segment_session_disk_plain_missing_file_leaves_note_unconverted(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    source.write_text("some content\n" * 10, encoding="utf-8")
    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=False)
    for f in service.texts_dir.glob("*.txt"):
        f.unlink()

    with pytest.raises(errors.VaultError) as exc_info:
        service.open_segment_session(note["id"])

    assert exc_info.value.code == "notes.content_not_found"
    assert storage.count_segments(service.conn, note["id"]) == 0
    assert service.get_note_title(note["id"]) == "big"  # note itself is untouched, retryable


def test_export_note_text_reflects_segment_edits_not_stale_disk_plain_file(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    original = "original line\n" * 50_000
    source.write_text(original, encoding="utf-8")
    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=False)

    opened = service.open_segment_session(note["id"])
    first = service.get_segment(opened["session_id"], 0)
    service.put_segment(opened["session_id"], first["segment"]["id"], first["segment"]["revision"], "edited first segment\n")

    out_path = tmp_path / "exported.txt"
    assert service.export_note_text(note["id"], out_path) is True
    exported_text = out_path.read_text(encoding="utf-8")
    assert exported_text.startswith("edited first segment\n")
    assert exported_text != original  # not silently re-read from the now-stale source file


def test_export_note_text_uses_get_note_fallback_for_unsegmented_note(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="small", category="", content="hello world", encrypt=True)

    out_path = tmp_path / "small.txt"
    assert service.export_note_text(note["id"], out_path) is True
    assert out_path.read_text(encoding="utf-8") == "hello world"


def test_export_note_text_missing_note_returns_false(tmp_path):
    service = _make_service(tmp_path)

    assert service.export_note_text(999, tmp_path / "missing.txt") is False


def test_update_note_metadata_returns_list_shape_without_content(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="Draft", category="", content="body" * 100, encrypt=True)

    updated = service.update_note_metadata(note["id"], title="Renamed", category="work")

    assert updated is not None
    assert updated["title"] == "Renamed"
    assert updated["category"] == "work"
    assert "content" not in updated


def test_update_note_reindexes_changed_title_and_content(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="草稿", category="", content="旧正文", encrypt=True)

    updated = service.update_note(note["id"], title="发布计划", content="新的 API 正文")

    assert updated["title"] == "发布计划"
    assert [row["id"] for row in service.search_notes(query="API")] == [note["id"]]


def test_add_tag_bulk_reindexes_all_affected_notes(tmp_path):
    service = _make_service(tmp_path)
    first = service.create_note(title="一", category="", content="", encrypt=True)
    second = service.create_note(title="二", category="", content="", encrypt=True)
    tag = service.create_tag("待办", "normal")

    assert service.add_tag_bulk([first["id"], second["id"]], tag["id"]) == 2
    assert {row["id"] for row in service.search_notes(query="待办")} == {first["id"], second["id"]}


def test_delete_tag_removes_its_name_from_full_text_search(tmp_path):
    service = _make_service(tmp_path)
    note = service.create_note(title="发布", category="", content="", encrypt=True)
    tag = service.create_tag("过期标签", "normal")
    service.set_note_tags(note["id"], [tag["id"]])

    assert [row["id"] for row in service.search_notes(query="过期标签")] == [note["id"]]
    assert service.delete_tag(tag["id"]) is True

    assert service.search_notes(query="过期标签") == []


def test_restore_note_reindexes_a_note_that_was_never_indexed(tmp_path):
    # 模拟在 FTS 回填（_ensure_fts_index）运行前就进了回收站的笔记：fetch_list 只扫活跃笔记，
    # 它被跳过，在重新索引前没有 notes_fts 行。
    service = _make_service(tmp_path)
    note = service.create_note(title="旧笔记", category="", content="restoreneedle", encrypt=True)
    service.conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (note["id"],))
    service.conn.commit()
    service.delete_note(note["id"])

    assert service.restore_note(note["id"]) is True
    assert [row["id"] for row in service.search_notes(query="restoreneedle")] == [note["id"]]


def test_restore_notes_bulk_reindexes_notes_that_were_never_indexed(tmp_path):
    service = _make_service(tmp_path)
    first = service.create_note(title="一", category="", content="bulkrestoreneedle", encrypt=True)
    second = service.create_note(title="二", category="", content="bulkrestoreneedle", encrypt=True)
    service.conn.execute("DELETE FROM notes_fts WHERE rowid IN (?, ?)", (first["id"], second["id"]))
    service.conn.commit()
    service.delete_notes_bulk([first["id"], second["id"]])

    assert service.restore_notes_bulk([first["id"], second["id"]]) == 2
    assert {row["id"] for row in service.search_notes(query="bulkrestoreneedle")} == {first["id"], second["id"]}


def test_service_backfills_fts_for_notes_created_before_index(tmp_path):
    data_dir = tmp_path / "data"
    key = crypto.generate_key()
    initial = NotesService(data_dir, key)
    note = initial.create_note(title="旧笔记", category="", content="legacyneedle", encrypt=True)
    initial.conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (note["id"],))
    initial.conn.execute("DELETE FROM settings WHERE key = 'notes_fts_index_version'")
    initial.conn.commit()
    initial.stop()

    reopened = NotesService(data_dir, key)

    assert [row["id"] for row in reopened.search_notes(query="legacyneedle")] == [note["id"]]
    reopened.stop()


# --- import-time auto-classification (see notes/classifier.py) ---


def test_create_note_from_file_encrypted_db_auto_classifies_using_catalog_category_matched_in_title(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("旅行", "normal")
    source = tmp_path / "旅行计划.txt"
    source.write_text("随便写点什么", encoding="utf-8")

    note = service.create_note_from_file(title="旅行计划", category="", source_path=str(source), encrypt=True)

    assert note["category"] == "旅行"


def test_create_note_from_file_disk_plain_auto_classifies_using_keyword_matched_in_content(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("财务", "normal", keywords="发票, 报销")
    source = tmp_path / "q3.txt"
    source.write_text("附上本季度的发票和报销单据", encoding="utf-8")

    note = service.create_note_from_file(title="q3", category="", source_path=str(source), encrypt=False)

    assert note["category"] == "财务"


def test_create_note_from_file_does_not_override_an_explicit_category(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("旅行", "normal")
    source = tmp_path / "旅行计划.txt"
    source.write_text("内容无所谓", encoding="utf-8")

    note = service.create_note_from_file(title="旅行计划", category="工作", source_path=str(source), encrypt=True)

    assert note["category"] == "工作"


def test_create_note_from_file_auto_classifies_into_a_brand_new_custom_category_with_no_code_change(tmp_path):
    # 此功能的重点：代码写完之后才创建的分类（这里用 create_category）仍能被匹配，因为候选读自 DB
    # 而非硬编码。
    service = _make_service(tmp_path)
    service.create_category("报销单据专用分类XYZ", "normal")
    source = tmp_path / "note.txt"
    source.write_text("这是一份报销单据专用分类XYZ的说明", encoding="utf-8")

    note = service.create_note_from_file(title="note", category="", source_path=str(source), encrypt=True)

    assert note["category"] == "报销单据专用分类XYZ"


def test_create_note_from_file_auto_classifies_using_a_category_only_in_use_by_an_existing_note(tmp_path):
    # 覆盖前端预设分类按钮（工作/生活/学习/...）：它们从不经 create_category()，只是首次选中时作为
    # 纯文本写到笔记上，之后仍须能作为 classify() 候选。
    service = _make_service(tmp_path)
    service.create_note(title="existing", category="工作", content="", encrypt=True)
    source = tmp_path / "工作汇报.txt"
    source.write_text("本周工作总结", encoding="utf-8")

    note = service.create_note_from_file(title="工作汇报", category="", source_path=str(source), encrypt=True)

    assert note["category"] == "工作"


def test_create_note_from_file_leaves_category_empty_when_nothing_matches(tmp_path):
    service = _make_service(tmp_path)
    service.create_category("旅行", "normal")
    source = tmp_path / "untitled.txt"
    source.write_text("今天天气不错", encoding="utf-8")

    note = service.create_note_from_file(title="untitled", category="", source_path=str(source), encrypt=True)

    assert note["category"] == ""


# --- import-time eager segmentation (see _EAGER_SEGMENT_THRESHOLD_BYTES) ---


@pytest.mark.parametrize("encrypt", [True, False])
def test_service_startup_migrates_legacy_large_note_before_open(tmp_path, monkeypatch, encrypt):
    monkeypatch.setattr(service_module, "_EAGER_SEGMENT_THRESHOLD_BYTES", 100)
    data_dir = tmp_path / "data"
    key = crypto.generate_key()
    initial = NotesService(data_dir, key)
    text = "legacy content\n" * 100
    note = initial.create_note(title="legacy", category="", content=text, encrypt=encrypt)
    assert storage.count_segments(initial.conn, note["id"]) == 0
    initial.stop()

    reopened = NotesService(data_dir, key)
    reopened.migrate_legacy_large_notes()
    opened = reopened.open_segment_session(note["id"])

    assert storage.count_segments(reopened.conn, note["id"]) > 0
    assert opened["segment_count"] > 0
    first = reopened.get_segment(opened["session_id"], 0)["segment"]["content"]
    assert first == text[: len(first)]
    reopened.stop()


def test_create_note_from_file_encrypted_db_segments_eagerly_past_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "_EAGER_SEGMENT_THRESHOLD_BYTES", 100)
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    text = "line\n" * 100  # well over the 100-byte patched threshold
    source.write_text(text, encoding="utf-8")

    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=True)

    # Segments already exist right after import - no need to ever call
    # open_segment_session for count_segments to be > 0.
    assert storage.count_segments(service.conn, note["id"]) > 0
    legacy_row = storage.fetch_one(service.conn, note["id"])
    assert legacy_row["content"] == ""  # legacy body cleared, segments are now authoritative

    reconstructed = "".join(
        storage.fetch_segment(service.conn, note["id"], i)["content"]
        for i in range(storage.count_segments(service.conn, note["id"]))
    )
    assert reconstructed == text


def test_create_note_from_file_disk_plain_segments_eagerly_past_threshold(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "_EAGER_SEGMENT_THRESHOLD_BYTES", 100)
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    text = "line\n" * 100
    source.write_text(text, encoding="utf-8")

    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=False)

    assert storage.count_segments(service.conn, note["id"]) > 0
    reconstructed = "".join(
        storage.fetch_segment(service.conn, note["id"], i)["content"]
        for i in range(storage.count_segments(service.conn, note["id"]))
    )
    assert reconstructed == text


def test_create_note_from_file_stays_unsegmented_below_threshold(tmp_path):
    service = _make_service(tmp_path)
    source = tmp_path / "small.txt"
    source.write_text("just a small note", encoding="utf-8")

    note = service.create_note_from_file(title="small", category="", source_path=str(source), encrypt=True)

    assert storage.count_segments(service.conn, note["id"]) == 0


def test_create_note_from_file_eagerly_segmented_note_opens_without_reconversion_error(tmp_path, monkeypatch):
    # 若主动分段静默失败，open_segment_session 会回退到惰性转换；encrypted_db 下会读（已清空的）旧
    # `content` 列并抛 notes.content_not_found。能正常打开即证明读到的是导入留下的分段。
    monkeypatch.setattr(service_module, "_EAGER_SEGMENT_THRESHOLD_BYTES", 100)
    service = _make_service(tmp_path)
    source = tmp_path / "big.txt"
    text = "line\n" * 100
    source.write_text(text, encoding="utf-8")
    note = service.create_note_from_file(title="big", category="", source_path=str(source), encrypt=True)

    opened = service.open_segment_session(note["id"])
    first = service.get_segment(opened["session_id"], 0)

    assert opened["segment_count"] > 0
    assert first["segment"]["content"] == text[: len(first["segment"]["content"])]


def test_create_category_and_set_category_keywords_round_trip(tmp_path):
    service = _make_service(tmp_path)
    category = service.create_category("财务", "normal")
    assert category["keywords"] == ""

    updated = service.set_category_keywords(category["id"], "发票, 报销")

    assert updated["keywords"] == "发票, 报销"
    assert service.list_categories("normal")[0]["keywords"] == "发票, 报销"


def test_set_category_keywords_unknown_id_returns_none(tmp_path):
    service = _make_service(tmp_path)

    assert service.set_category_keywords(999999, "x") is None
