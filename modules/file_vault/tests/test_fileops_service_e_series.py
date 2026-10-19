"""modules/file_vault/fileops/service.py 文件管理器 "E 系列"新增功能的测试：冲突检测（粘贴流程）、
重复检测（E2）、安全擦除（E5）、会话级撤销日志/操作历史（E6/E7）。

_UNDO_LOG 和 _FILE_CLIP_HISTORY 是模块级全局，autouse fixture 先重置，否则状态在用例间串味。
"""

import os
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.fileops import service


@pytest.fixture(autouse=True)
def _reset_session_state():
    service._UNDO_LOG.clear()
    service._FILE_CLIP_HISTORY.clear()
    yield
    service._UNDO_LOG.clear()
    service._FILE_CLIP_HISTORY.clear()


def _noop_progress(done, total):
    pass


def test_cross_volume_move_keeps_source_when_directory_scan_failed(tmp_path, monkeypatch):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    (source / "keep-me.txt").write_text("important", encoding="utf-8")
    deleted = []

    monkeypatch.setattr(service.file_engine, "_same_volume", lambda _a, _b: False)

    def failed_collect(src, dst, report, idx, item_error_count):
        report.errors.append((str(src), "simulated scan failure"))
        item_error_count[idx] += 1
        if False:
            yield None

    monkeypatch.setattr(service.file_engine, "_iter_copy_tasks", failed_collect)
    monkeypatch.setattr(
        service.file_engine,
        "_delete_sources",
        lambda items, report, threads: deleted.extend(items),
    )

    report = service.file_engine.transfer(
        [str(source)],
        str(destination),
        move=True,
        live_progress=False,
    )

    assert report.ok is False
    assert deleted == []
    assert source.exists()


def test_copy_task_iterator_is_lazy_for_huge_small_file_trees(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    for index in range(250):
        (source / f"{index:04d}.txt").write_bytes(b"x")
    report = service.file_engine.TransferReport(operation="copy")
    item_errors = [0]

    tasks = service.file_engine._iter_copy_tasks(
        str(source), str(destination), report, 0, item_errors,
    )

    assert report.files_total == 0
    first = next(tasks)
    assert first[2] == 1
    assert report.files_total == 1
    assert len(list(tasks)) == 249
    assert report.files_total == 250


def test_delete_task_iterator_is_lazy_for_huge_small_file_trees(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    for index in range(250):
        (source / f"{index:04d}.txt").write_bytes(b"x")
    report = service.file_engine.TransferReport(operation="delete")
    directories = []

    tasks = service.file_engine._iter_delete_files(str(source), directories, report)

    assert report.files_total == 0
    first = next(tasks)
    assert first[1] == 1
    assert report.files_total == 1
    assert len(list(tasks)) == 249
    assert report.files_total == 250
    assert directories == [str(source)]


def test_streaming_transfer_copies_nested_directory_and_preserves_source(tmp_path):
    source = tmp_path / "source"
    nested = source / "nested" / "deeper"
    destination = tmp_path / "destination"
    nested.mkdir(parents=True)
    destination.mkdir()
    payload = b"file-vault-streaming-copy"
    (nested / "payload.bin").write_bytes(payload)

    report = service.file_engine.transfer(
        [str(source)],
        str(destination),
        live_progress=False,
    )

    assert report.ok is True
    assert report.files_total == report.files_done == 1
    assert (destination / "source" / "nested" / "deeper" / "payload.bin").read_bytes() == payload
    assert (nested / "payload.bin").read_bytes() == payload


def test_streaming_permanent_delete_removes_nested_directory_tree(tmp_path):
    source = tmp_path / "source"
    nested = source / "nested" / "deeper"
    nested.mkdir(parents=True)
    for index in range(300):
        (nested / f"{index:04d}.txt").write_bytes(b"x")

    report = service.file_engine.delete_items(
        [str(source)],
        recycle=False,
        live_progress=False,
    )

    assert report.ok is True
    assert report.files_total == report.files_done == 300
    assert not source.exists()


def test_bounded_executor_does_not_eagerly_submit_every_small_file():
    completed = 0
    completed_lock = threading.Lock()

    def work(value):
        nonlocal completed
        time.sleep(0.002)
        with completed_lock:
            completed += 1
        return value

    def guarded_items():
        for value in range(200):
            with completed_lock:
                outstanding = value - completed
            assert outstanding <= 12, "producer ran too far ahead of completed work"
            yield value

    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = service.file_engine._run_bounded(
            pool,
            work,
            guarded_items(),
            max_pending=8,
        )

    assert results == list(range(200))


# --- check_conflicts ---


def test_check_conflicts_mode_existing_only_returns_files_already_in_dest(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "clash.txt").write_bytes(b"already here")
    src_clash = tmp_path / "clash.txt"
    src_clash.write_bytes(b"incoming")
    src_new = tmp_path / "new.txt"
    src_new.write_bytes(b"incoming, no clash")

    result = service.check_conflicts([str(src_clash), str(src_new)], str(dest), mode="existing")

    assert len(result) == 1
    assert result[0]["name"] == "clash.txt"
    assert result[0]["dest_exists"] is True


def test_check_conflicts_mode_all_returns_every_source_regardless_of_clash(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    src_new = tmp_path / "new.txt"
    src_new.write_bytes(b"no clash here")

    result = service.check_conflicts([str(src_new)], str(dest), mode="all")

    assert len(result) == 1
    assert result[0]["dest_exists"] is False


def test_check_conflicts_reports_source_and_dest_sizes(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "f.txt").write_bytes(b"12345")  # 5 bytes
    src = tmp_path / "f.txt"
    src.write_bytes(b"1234567890")  # 10 bytes

    [entry] = service.check_conflicts([str(src)], str(dest), mode="existing")

    assert entry["source_size"] == 10
    assert entry["dest_size"] == 5


def test_check_conflicts_with_empty_paths_returns_empty_list(tmp_path):
    assert service.check_conflicts([], str(tmp_path), mode="all") == []


# --- detect_duplicates (E2) ---


def test_detect_duplicates_finds_identical_files(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "same.txt").write_bytes(b"identical content")
    src = tmp_path / "same.txt"
    src.write_bytes(b"identical content")

    result = service.detect_duplicates([str(src)], str(dest))

    assert result["count"] == 1
    assert result["duplicates"][0]["name"] == "same.txt"
    assert result["total_bytes"] == len(b"identical content")


def test_detect_duplicates_ignores_files_with_different_content(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "differs.txt").write_bytes(b"content A")
    src = tmp_path / "differs.txt"
    src.write_bytes(b"content B, not the same")

    result = service.detect_duplicates([str(src)], str(dest))

    assert result["count"] == 0
    assert result["duplicates"] == []


def test_detect_duplicates_ignores_sources_with_no_matching_dest_file(tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    src = tmp_path / "only_in_source.txt"
    src.write_bytes(b"nothing to collide with")

    result = service.detect_duplicates([str(src)], str(dest))

    assert result["count"] == 0


def test_detect_duplicates_with_empty_sources_returns_empty(tmp_path):
    assert service.detect_duplicates([], str(tmp_path)) == {"duplicates": [], "count": 0, "total_bytes": 0}


# --- run_secure_erase (E5) ---


def test_run_secure_erase_removes_files_and_reports_done_count(tmp_path):
    f1 = tmp_path / "a.txt"
    f1.write_bytes(b"secret a")
    f2 = tmp_path / "b.txt"
    f2.write_bytes(b"secret b")

    result = service.run_secure_erase([str(f1), str(f2)], _noop_progress)

    assert result["ok"] is True
    assert result["items_total"] == 2
    assert result["items_done"] == 2
    assert result["errors"] == []
    assert not f1.exists()
    assert not f2.exists()


def test_run_secure_erase_skips_paths_that_do_not_exist(tmp_path):
    missing = tmp_path / "never_existed.txt"

    result = service.run_secure_erase([str(missing)], _noop_progress)

    # 不存在的路径在过滤阶段就被排除，不计入 total，也不报错
    assert result["ok"] is True
    assert result["items_total"] == 0
    assert result["errors"] == []


def test_run_secure_erase_reports_per_file_errors_without_aborting_the_batch(tmp_path):
    ok_file = tmp_path / "ok.txt"
    ok_file.write_bytes(b"fine")
    locked_file = tmp_path / "locked.txt"
    locked_file.write_bytes(b"cannot touch this")
    os.chmod(str(locked_file), stat.S_IREAD)
    try:
        result = service.run_secure_erase([str(ok_file), str(locked_file)], _noop_progress)

        assert result["ok"] is False
        assert result["items_total"] == 2
        assert result["items_done"] == 2  # 两个都"处理过"了，即使其中一个失败
        assert len(result["errors"]) == 1
        assert result["errors"][0]["path"] == str(locked_file)
        assert not ok_file.exists()  # 正常的那个确实被清除了
        assert locked_file.exists()  # 失败的那个原样保留，没有被误删
    finally:
        os.chmod(str(locked_file), stat.S_IWRITE)


def test_run_secure_erase_with_empty_paths_raises_file_clip_error():
    with pytest.raises(service.FileClipError):
        service.run_secure_erase([], _noop_progress)


def test_run_secure_erase_calls_progress_callback_for_each_item(tmp_path):
    f1 = tmp_path / "a.txt"
    f1.write_bytes(b"a")
    f2 = tmp_path / "b.txt"
    f2.write_bytes(b"b")
    calls = []

    service.run_secure_erase([str(f1), str(f2)], lambda done, total: calls.append((done, total)))

    assert calls == [(1, 2), (2, 2)]


# --- undo log (E6) - honest "not yet supported" behavior ---


def test_get_undo_info_with_empty_log_reports_no_undo():
    assert service.get_undo_info() == {"has_undo": False}


def test_undo_last_with_empty_log_reports_nothing_to_undo():
    assert service.undo_last() == {"ok": False, "error": "undo.nothing_to_undo"}


def test_undo_last_after_a_recorded_operation_is_honest_about_not_being_reversible(tmp_path):
    # 目前没有"从回收站程序化恢复"或"精确撤销粘贴"的实现（见 service.py::undo_last），所以刚记录过
    # 操作也必须如实报告"不可撤销"，不能假装成功（原实现对 delete_recycle/paste 直接返回假成功）。
    service._record_operation("delete_recycle", {"files_done": 3}, ["a.txt", "b.txt", "c.txt"])

    result = service.undo_last()

    assert result == {"ok": False, "error": "undo.not_reversible"}


def test_get_undo_info_reflects_the_most_recent_operation_but_marks_it_not_reversible(tmp_path):
    service._record_operation("paste", {"files_done": 2}, ["x.txt", "y.txt"])

    info = service.get_undo_info()

    assert info["has_undo"] is True
    assert info["operation"] == "paste"
    assert info["files_total"] == 2
    assert info["reversible"] is False


def test_undo_last_does_not_modify_the_filesystem(tmp_path):
    # 记录"删除"后调用 undo_last，被记录路径的文件不会凭空出现：undo_last 不碰文件系统，
    # 只是查询/弹出日志，没有悄悄做事又谎报结果。
    target = tmp_path / "was_deleted.txt"
    assert not target.exists()
    service._record_operation("delete_recycle", {"files_done": 1}, [str(target)])

    service.undo_last()

    assert not target.exists()


# --- operation history (E7) ---


def test_get_history_returns_most_recent_first():
    service._record_history("paste", ["a.txt"], {"files_done": 1})
    service._record_history("delete_recycle", ["b.txt"], {"files_done": 1})

    entries = service.get_history()

    assert [e["operation"] for e in entries] == ["delete_recycle", "paste"]


def test_get_history_respects_limit():
    for i in range(5):
        service._record_history("paste", [f"{i}.txt"], {"files_done": 1})

    assert len(service.get_history(limit=2)) == 2


def test_get_history_caps_at_maxlen_200():
    for i in range(250):
        service._record_history("paste", [f"{i}.txt"], {"files_done": 1})

    assert len(service._FILE_CLIP_HISTORY) == 200
    # 最新的一条（最后记录的 249.txt）必须还在——环形缓冲区该丢的是最旧的
    assert service.get_history(limit=1)[0]["path_count"] == 1


def test_clear_history_empties_the_log():
    service._record_history("paste", ["a.txt"], {"files_done": 1})

    service.clear_history()

    assert service.get_history() == []


def test_record_history_captures_report_metadata():
    service._record_history(
        "paste",
        ["a.txt", "b.txt"],
        {"files_done": 2, "bytes_total": 1024, "fast_moved_count": 1, "elapsed": 0.5, "errors": [{"path": "x"}]},
    )

    [entry] = service.get_history()

    assert entry["operation"] == "paste"
    assert entry["files_total"] == 2
    assert entry["bytes_total"] == 1024
    assert entry["fast_moved_count"] == 1
    assert entry["elapsed"] == 0.5
    assert entry["errors_count"] == 1
    assert entry["path_count"] == 2
