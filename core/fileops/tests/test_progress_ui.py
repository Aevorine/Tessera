"""Behavioural contract for the non-activating FileHook task cards."""

import ctypes
from ctypes import wintypes
from types import SimpleNamespace
import time

import pytest

from core.fileops import engine, hook_cli, progress_ui


def _snapshot(**changes):
    values = dict(
        operation="copy", phase="running", current_path="", files_done=2,
        files_total=4, bytes_done=200, bytes_total=400, started_at=0.0,
        elapsed_seconds=2.0, speed_bytes_per_second=100.0, eta_seconds=2.0,
        items_done=0, items_total=0, errors_count=0, errors=(),
        cancel_requested=False, recycle=False,
    )
    values.update(changes)
    return engine.TaskProgress(**values)


@pytest.mark.parametrize(
    ("position", "expected"),
    [
        ("top-left", (16, 16)), ("top-center", (400, 16)),
        ("top-right", (784, 16)), ("center-left", (16, 260)),
        ("center", (400, 260)), ("center-right", (784, 260)),
        ("bottom-left", (16, 504)), ("bottom-center", (400, 504)),
        ("bottom-right", (784, 504)),
    ],
)
def test_nine_grid_places_card_inside_work_area_safe_margin(position, expected):
    assert progress_ui.card_origin(position, (0, 0, 1000, 600), (200, 80), 16) == expected


def test_compact_and_full_progress_formats_are_purposefully_different():
    snapshot = _snapshot(current_path=r"D:\in\report.pdf")

    compact = progress_ui.format_progress(snapshot, compact=True, speed=100.0)
    full = progress_ui.format_progress(snapshot, compact=False, speed=100.0)

    assert "report.pdf" not in compact
    assert "50%" in compact
    assert "report.pdf" in full
    assert "ETA" in full


def test_speed_is_smoothed_over_a_two_second_window():
    smoothing = progress_ui.SpeedSmoother(window_seconds=2.0)

    assert smoothing.observe(0, 0.0) == 0.0
    assert smoothing.observe(100, 1.0) == 100.0
    assert smoothing.observe(500, 2.0) == 250.0
    assert smoothing.observe(700, 3.0) == 300.0


def test_eta_is_hidden_until_one_second_and_totals_are_frozen():
    scanning = _snapshot(phase="scanning", elapsed_seconds=5.0, files_total=4, bytes_total=400)
    under_one_second = _snapshot(elapsed_seconds=0.9)
    running = _snapshot(elapsed_seconds=1.1)

    assert progress_ui.progress_eta(scanning, 100.0) is None
    assert progress_ui.progress_eta(under_one_second, 100.0) is None
    assert progress_ui.progress_eta(running, 100.0) == 2.0


def test_four_named_card_slots_are_available_and_a_fifth_is_cardless(monkeypatch):
    acquired = []
    occupied = set()

    def claim(slot):
        if slot < 4 and slot not in occupied:
            occupied.add(slot)
            token = SimpleNamespace(slot=slot)
            acquired.append(token)
            return token
        return None

    monkeypatch.setattr(progress_ui, "_claim_named_card_slot", claim)

    slots = [progress_ui.claim_card_slot() for _ in range(5)]

    assert [slot.slot for slot in slots[:4]] == [0, 1, 2, 3]
    assert slots[4] is None
    assert len(acquired) == 4


def test_bottom_cards_stack_upward_inside_the_trigger_work_area():
    origins = [
        progress_ui.stacked_card_origin("bottom-right", (0, 0, 1000, 600), (200, 80), 16, slot)
        for slot in range(4)
    ]

    assert origins == [(784, 504), (784, 416), (784, 328), (784, 240)]


def test_partial_failure_final_state_includes_first_error_and_bounded_details():
    snapshot = _snapshot(
        phase="completed", errors_count=8,
        errors=tuple((f"path-{n}", f"failure-{n}") for n in range(6)),
    )

    final = progress_ui.final_card_state(snapshot, auto_hide_seconds=5)

    assert final.kind == "partial-failure"
    assert "path-0" in final.summary and "failure-0" in final.summary
    assert len(final.details) == progress_ui.MAX_ERROR_DETAILS
    assert final.auto_hide_seconds is None


def test_first_show_releases_tk_withdrawal_before_win32_noactivate_show(monkeypatch):
    calls = []

    class Root:
        def withdraw(self):
            calls.append("withdraw")

        def winfo_id(self):
            calls.append("hwnd")
            return 42

        def deiconify(self):
            calls.append("deiconify")

    monkeypatch.setattr(progress_ui, "_set_noactivate_ex_style", lambda hwnd: calls.append(("style", hwnd)))
    monkeypatch.setattr(progress_ui, "_install_mouseactivate_noactivate", lambda hwnd: calls.append(("mouseactivate", hwnd)))
    monkeypatch.setattr(progress_ui, "_show_noactivate", lambda hwnd, x, y, w, h: calls.append(("show", hwnd, x, y, w, h)))

    progress_ui.show_non_activating(Root(), 10, 20, 300, 80)

    assert calls == [
        "withdraw", "hwnd", ("style", 42), ("mouseactivate", 42),
        "deiconify",
        ("show", 42, 10, 20, 300, 80),
    ]


def test_every_global_file_operation_shows_a_task_card_without_a_delay_threshold():
    assert progress_ui.DELAY_SHOW_SECS == 0


def test_progress_ui_exception_is_logged_and_worker_result_is_still_returned(monkeypatch, caplog):
    report = engine.TransferReport(operation="copy")
    report.elapsed = 1.0
    released = []
    monkeypatch.setattr(progress_ui, "DELAY_SHOW_SECS", 0)
    monkeypatch.setattr(progress_ui, "claim_card_slot", lambda: SimpleNamespace(slot=0, handle=("fallback", 0)))
    monkeypatch.setattr(progress_ui, "_release_card_slot", released.append)
    monkeypatch.setattr(progress_ui, "_ProgressWindow", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no display")))

    result = progress_ui._run_with_progress(
        "copy", lambda _cancel, _report: (time.sleep(0.05), report)[1]
    )

    assert result is report
    assert "progress card UI failed" in caplog.text
    assert len(released) == 1


def test_hook_passes_trigger_window_to_progress_card(monkeypatch):
    captured = {}
    monkeypatch.setattr(hook_cli, "resolve_target_folder", lambda *_args: r"D:\target")
    monkeypatch.setattr(hook_cli, "_class_name", lambda _hwnd: "CabinetWClass")
    monkeypatch.setattr(
        progress_ui, "gui_paste",
        lambda destination, **kwargs: captured.update(destination=destination, **kwargs) or 0,
    )

    assert hook_cli.cmd_paste_window("456", "rename", None) == 0
    assert captured == {
        "destination": r"D:\target", "on_conflict": "rename",
        "threads": None, "trigger_hwnd": 456,
    }


def test_card_tick_reads_a_fresh_snapshot_after_scanning_totals_freeze(monkeypatch):
    class Bar(dict):
        def __init__(self):
            super().__init__(mode="indeterminate")
            self.stopped = False

        def stop(self):
            self.stopped = True

        def config(self, **kwargs):
            self.update(kwargs)

    class Body:
        def __init__(self):
            self.text = []

        def config(self, **kwargs):
            self.text.append(kwargs["text"])

    class Root:
        def __init__(self):
            self.after_calls = []

        def after(self, *_args):
            self.after_calls.append(_args)

    report = engine.TransferReport(operation="copy")
    state = engine._report_state(report)
    clock = iter((state.started_perf + 1, state.started_perf + 2))  # 只喂卡片自己的时钟；引擎快照用自己的时钟
    monkeypatch.setattr(progress_ui.time, "perf_counter", lambda: next(clock))
    card = object.__new__(progress_ui._ProgressWindow)
    card.final = {"live_report": report}
    card.bar = Bar()
    card.body = Body()
    card.root = Root()
    card.smoothing = progress_ui.SpeedSmoother()
    card.preferences = {"compact": False}

    card._tick()
    report.note_scanned_file("later.bin", 400)
    report.mark_running()
    with report._lock:
        report.bytes_done = 200
        report.files_done = 1
    card._tick()

    assert card.bar.stopped and card.bar["mode"] == "determinate"
    assert card.body.text[0] == "复制 正在扫描…"
    assert "MB/s" in card.body.text[-1] and "ETA" not in card.body.text[-1]
    assert all(delay >= 200 for delay, _callback in card.root.after_calls)


def test_win32_apis_use_pointer_safe_prototypes_before_they_are_called():
    class Function:
        pass

    kernel32 = SimpleNamespace(**{
        name: Function() for name in (
            "CreateMutexW", "WaitForSingleObject", "ReleaseMutex", "CloseHandle",
        )
    })
    user32 = SimpleNamespace(**{
        name: Function() for name in (
            "GetWindowLongPtrW", "SetWindowLongPtrW", "SetWindowPos", "CallWindowProcW",
            "MonitorFromWindow", "GetMonitorInfoW",
        )
    })

    progress_ui.configure_win32_prototypes(kernel32, user32)

    assert kernel32.CreateMutexW.restype is wintypes.HANDLE
    assert kernel32.WaitForSingleObject.argtypes == (wintypes.HANDLE, wintypes.DWORD)
    assert user32.GetWindowLongPtrW.restype is ctypes.c_ssize_t
    assert user32.SetWindowLongPtrW.argtypes[-1] is ctypes.c_ssize_t
    assert user32.CallWindowProcW.restype is ctypes.c_ssize_t
    assert user32.MonitorFromWindow.argtypes == (wintypes.HWND, wintypes.DWORD)
    assert user32.GetMonitorInfoW.argtypes[1] == ctypes.POINTER(progress_ui.MONITORINFO)


def test_recycle_card_is_indeterminate_and_has_no_cancel_control():
    recycle = _snapshot(operation="recycle", recycle=True, phase="running", indeterminate=True)

    assert not progress_ui.card_is_determinate(recycle)
    assert not progress_ui.card_can_cancel(recycle, compact=False)
    assert "系统处理中" in progress_ui.format_progress(recycle, compact=False, speed=10)


def test_observable_recycle_card_is_determinate_but_still_has_no_cancel_control():
    recycle = _snapshot(
        operation="recycle", recycle=True, phase="running", indeterminate=False,
        items_done=1, items_total=2,
    )

    assert progress_ui.card_is_determinate(recycle)
    assert not progress_ui.card_can_cancel(recycle, compact=False)
    assert "1/2" in progress_ui.format_progress(recycle, compact=False, speed=1)


def test_operation_specific_compact_rendering_has_only_operation_percent_speed_and_elapsed():
    copy = _snapshot(operation="copy", current_path=r"D:\private\secret.bin")
    move = _snapshot(operation="move", files_total=0, bytes_total=0, items_done=1, items_total=2)
    delete = _snapshot(operation="delete", files_done=1, files_total=2, bytes_done=100, bytes_total=200)

    compact = progress_ui.format_progress(copy, compact=True, speed=100 * 1024 * 1024)
    assert "复制" in compact and "50%" in compact and "100.0 MB/s" in compact and "用时" in compact
    assert "secret.bin" not in compact and "ETA" in compact
    assert "1/2" in progress_ui.format_progress(move, compact=False, speed=1)
    assert "项/秒" in progress_ui.format_progress(delete, compact=False, speed=2)
    assert "已释放" in progress_ui.format_progress(delete, compact=False, speed=2)


def test_copy_progress_uses_bytes_not_file_counts_for_a_huge_plus_small_transfer():
    snapshot = _snapshot(
        files_done=1, files_total=2, bytes_done=100, bytes_total=10_100,
    )

    assert progress_ui.progress_fraction(snapshot) == (100, 10_100)
    assert progress_ui.progress_bar_value(snapshot) == 9


def test_full_shows_total_bytes_and_final_state_shows_average_speed():
    snapshot = _snapshot(bytes_done=400 * 1024 * 1024, bytes_total=800 * 1024 * 1024, elapsed_seconds=4.0)

    assert "总计 800.0 MB" in progress_ui.format_progress(snapshot, compact=False, speed=100 * 1024 * 1024)
    assert "平均 100.0 MB/s" in progress_ui.final_card_state(snapshot, auto_hide_seconds=5).summary


def test_large_file_sizes_switch_from_mb_to_gb():
    assert progress_ui._fmt_bytes(1023 * 1024 * 1024) == "1,023.0 MB"
    assert progress_ui._fmt_bytes(1024 * 1024 * 1024) == "1.0 GB"


def test_eta_waits_one_second_after_running_begins_even_after_a_long_scan():
    long_scan = _snapshot(phase="running", elapsed_seconds=120.0)

    assert progress_ui.progress_eta(long_scan, 100.0, running_elapsed=0.9) is None
    assert progress_ui.progress_eta(long_scan, 100.0, running_elapsed=1.0) == 2.0


def test_restore_mouseactivate_reinstates_original_wndproc_and_drops_callback(monkeypatch):
    calls = []
    user32 = SimpleNamespace()
    monkeypatch.setattr(progress_ui, "_user32", user32)
    monkeypatch.setattr(progress_ui, "_window_long_functions", lambda _user32: (None, lambda *args: calls.append(args)))
    progress_ui._previous_wndprocs[77] = (1234, object())

    progress_ui.restore_mouseactivate_wndproc(77)

    assert calls == [(77, progress_ui.GWLP_WNDPROC, 1234)]
    assert 77 not in progress_ui._previous_wndprocs


def test_tick_render_exception_is_logged_and_closes_the_card(monkeypatch, caplog):
    class Root:
        def __init__(self):
            self.destroyed = False

        def destroy(self):
            self.destroyed = True

    card = object.__new__(progress_ui._ProgressWindow)
    card.root = Root()
    card.final = {"live_report": SimpleNamespace(snapshot=lambda: (_ for _ in ()).throw(RuntimeError("render boom")))}

    card._tick()

    assert card.root.destroyed
    assert "progress card tick failed" in caplog.text


def test_closed_card_still_waits_for_the_worker_result(monkeypatch):
    report = engine.TransferReport(operation="copy")
    monkeypatch.setattr(progress_ui, "DELAY_SHOW_SECS", 0)
    monkeypatch.setattr(progress_ui, "claim_card_slot", lambda: SimpleNamespace(slot=0, handle=("fallback", 0)))
    monkeypatch.setattr(progress_ui, "_release_card_slot", lambda _slot: None)

    class ClosingCard:
        def run(self):
            return None

    monkeypatch.setattr(progress_ui, "_ProgressWindow", lambda *_args: ClosingCard())

    result = progress_ui._run_with_progress(
        "copy", lambda _cancel, _report: (time.sleep(0.02), report)[1]
    )

    assert result is report
