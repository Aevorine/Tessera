"""Contract tests for the file-operation progress snapshots."""

import ctypes
from dataclasses import FrozenInstanceError, asdict
import pickle
import threading
import time

import pytest

from core.fileops import engine


def test_snapshot_is_frozen_and_does_not_share_error_storage():
    report = engine.TransferReport(operation="copy")
    report.add_error("first", "first failure")

    snapshot = report.snapshot()
    report.add_error("second", "later failure")

    assert isinstance(snapshot, engine.TaskProgress)
    assert snapshot.errors == (("first", "first failure"),)
    with pytest.raises(FrozenInstanceError):
        snapshot.files_done = 1


def test_transfer_report_remains_compatible_with_dataclass_serialization():
    report = engine.TransferReport(operation="copy")

    assert asdict(report) == {
        "operation": "copy",
        "files_total": 0,
        "bytes_total": 0,
        "files_done": 0,
        "bytes_done": 0,
        "fast_moved": [],
        "renamed": [],
        "skipped": [],
        "errors": [],
        "elapsed": 0.0,
        "cancelled": False,
    }


def test_transfer_report_pickle_roundtrip_keeps_snapshot_available():
    restored = pickle.loads(pickle.dumps(engine.TransferReport(operation="copy")))

    assert restored.snapshot().operation == "copy"


def test_copy_starts_while_scanning_and_totals_freeze_when_scan_completes(
    tmp_path, monkeypatch
):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    first_window_out = threading.Event()
    continue_scan = threading.Event()
    copy_started = threading.Event()
    finish_copy = threading.Event()
    reports = []

    def staged_tasks(src, dst, report, idx, item_error_count):
        for index in range(257):
            path = source / f"{index}.bin"
            report.note_scanned_file(str(path), 1)
            yield str(path), str(destination / path.name), 1, idx
        first_window_out.set()
        assert continue_scan.wait(2)
        report.note_scanned_file(str(source / "last.bin"), 5)
        yield str(source / "last.bin"), str(destination / "last.bin"), 5, idx

    def blocked_copy(src, dst, size, idx, overwrite, cancel_flag, progress, report, item_error_count):
        copy_started.set()
        assert finish_copy.wait(2)
        progress.add_bytes(size)
        progress.file_done()

    monkeypatch.setattr(engine, "_iter_copy_tasks", staged_tasks)
    monkeypatch.setattr(engine, "_copy_one", blocked_copy)

    thread = threading.Thread(
        target=lambda: reports.append(
            engine.transfer(
                [str(source)], str(destination), threads=1, live_progress=False,
                on_report=lambda report: reports.append(report),
            )
        )
    )
    thread.start()
    assert first_window_out.wait(2)
    assert copy_started.wait(2)
    live = reports[0]

    copying = live.snapshot()
    assert copying.phase == "running"
    assert copying.scan_complete is False
    assert copying.eta_seconds is None
    assert copying.files_total == 257

    continue_scan.set()
    finish_copy.set()
    thread.join(5)
    assert not thread.is_alive()
    final = reports[-1].snapshot()
    assert final.phase == "completed"
    assert final.scan_complete is True
    assert (final.files_done, final.files_total, final.bytes_total) == (258, 258, 262)


def test_copy_workers_start_before_enumeration_finishes(tmp_path, monkeypatch):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    enumeration_paused = threading.Event()
    finish_enumeration = threading.Event()
    worker_states = []

    def many_tasks(src, dst, report, idx, item_error_count):
        for index in range(300):
            path = source / f"{index}.bin"
            report.note_scanned_file(str(path), index + 1)
            if index == 299:
                enumeration_paused.set()
                assert finish_enumeration.wait(2)
            yield str(path), str(destination / path.name), index + 1, idx

    def record_copy(src, dst, size, idx, overwrite, cancel_flag, progress, report, item_error_count):
        snapshot = report.snapshot()
        worker_states.append((snapshot.phase, snapshot.scan_complete))
        progress.add_bytes(size)
        progress.file_done()

    monkeypatch.setattr(engine, "_iter_copy_tasks", many_tasks)
    monkeypatch.setattr(engine, "_copy_one", record_copy)

    thread = threading.Thread(
        target=lambda: engine.transfer(
            [str(source)], str(destination), threads=2, live_progress=False,
        )
    )
    thread.start()
    assert enumeration_paused.wait(2)
    deadline = time.monotonic() + 2
    while len(worker_states) < 256 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(worker_states) == 256
    assert {state for state in worker_states} == {("running", False)}

    finish_enumeration.set()
    thread.join(5)
    assert not thread.is_alive()
    assert len(worker_states) == 300


def test_snapshot_keeps_byte_totals_separate_from_fast_move_item_totals():
    report = engine.TransferReport(operation="move")
    report.note_scanned_file("payload.bin", 11)
    report.set_fast_move_total(2)
    report.note_fast_move("first")

    snapshot = report.snapshot()

    assert (snapshot.files_total, snapshot.bytes_total) == (1, 11)
    assert (snapshot.items_done, snapshot.items_total) == (1, 2)


def test_snapshot_limits_error_summaries_but_keeps_full_error_count():
    report = engine.TransferReport(operation="delete")
    for index in range(8):
        report.add_error(f"path-{index}", f"failure-{index}")

    snapshot = report.snapshot()

    assert snapshot.errors_count == 8
    assert snapshot.errors == tuple((f"path-{index}", f"failure-{index}") for index in range(6))


def test_same_volume_move_updates_independent_item_progress(tmp_path, monkeypatch):
    source_one = tmp_path / "one.txt"
    source_two = tmp_path / "two.txt"
    destination = tmp_path / "destination"
    source_one.write_text("one", encoding="utf-8")
    source_two.write_text("two", encoding="utf-8")
    destination.mkdir()
    entered_move = threading.Event()
    continue_move = threading.Event()
    reports = []

    monkeypatch.setattr(engine, "_same_volume", lambda _src, _dst: True)

    def fake_move(src, dst, flags):
        entered_move.set()
        assert continue_move.wait(2)
        return True

    monkeypatch.setattr(engine.kernel32, "MoveFileExW", fake_move)

    thread = threading.Thread(
        target=lambda: reports.append(
            engine.transfer(
                [str(source_one), str(source_two)], str(destination), move=True,
                live_progress=False, on_report=lambda report: reports.append(report),
            )
        )
    )
    thread.start()
    assert entered_move.wait(2)
    live = reports[0]

    running = live.snapshot()
    assert running.phase == "running"
    assert (running.files_total, running.bytes_total) == (0, 0)
    assert (running.items_done, running.items_total) == (0, 2)

    continue_move.set()
    thread.join(2)
    assert not thread.is_alive()
    completed = reports[-1].snapshot()
    assert completed.phase == "completed"
    assert (completed.items_done, completed.items_total) == (2, 2)


def test_same_volume_runtime_fallback_scans_before_entering_running(tmp_path, monkeypatch):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    scan_paused = threading.Event()
    finish_scan = threading.Event()
    reports = []

    monkeypatch.setattr(engine, "_same_volume", lambda _src, _dst: True)
    monkeypatch.setattr(engine.kernel32, "MoveFileExW", lambda _src, _dst, _flags: False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: engine.ERROR_NOT_SAME_DEVICE)

    def staged_tasks(src, dst, report, idx, item_error_count):
        report.note_scanned_file(str(source / "payload.bin"), 4)
        scan_paused.set()
        assert finish_scan.wait(2)
        yield str(source / "payload.bin"), str(destination / "payload.bin"), 4, idx

    def record_copy(src, dst, size, idx, overwrite, cancel_flag, progress, report, item_error_count):
        assert report.snapshot().phase == "running"
        progress.add_bytes(size)
        progress.file_done()

    monkeypatch.setattr(engine, "_iter_copy_tasks", staged_tasks)
    monkeypatch.setattr(engine, "_copy_one", record_copy)

    thread = threading.Thread(
        target=lambda: reports.append(
            engine.transfer(
                [str(source)], str(destination), move=True, threads=1,
                live_progress=False, on_report=lambda report: reports.append(report),
            )
        )
    )
    thread.start()
    assert scan_paused.wait(2)
    assert reports[0].snapshot().phase == "scanning"

    finish_scan.set()
    thread.join(2)
    assert not thread.is_alive()


def test_delete_enumeration_finishes_before_any_delete_worker_starts(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    enumeration_paused = threading.Event()
    finish_enumeration = threading.Event()
    worker_phases = []

    def many_files(src_dir, dirs, report):
        for index in range(257):
            path = source / f"{index}.bin"
            report.note_scanned_file(str(path), index + 1)
            if index == 256:
                enumeration_paused.set()
                assert finish_enumeration.wait(2)
            yield str(path), index + 1

    def record_delete(path, size, cancel_flag, progress, report):
        worker_phases.append(report.snapshot().phase)
        progress.add_bytes(size)
        progress.file_done()

    monkeypatch.setattr(engine, "_iter_delete_files", many_files)
    monkeypatch.setattr(engine, "_delete_one", record_delete)

    thread = threading.Thread(
        target=lambda: engine.delete_items([str(source)], threads=1, live_progress=False)
    )
    thread.start()
    assert enumeration_paused.wait(2)
    assert worker_phases == []

    finish_enumeration.set()
    thread.join(2)
    assert not thread.is_alive()
    assert worker_phases and set(worker_phases) == {"running"}
