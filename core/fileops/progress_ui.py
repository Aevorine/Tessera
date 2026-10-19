"""Non-activating native task cards for FileHook operations.
A best-effort observer: losing the display must never affect the running transfer."""

import ctypes
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from ctypes import wintypes
from typing import Optional

from core.fileops import clipboard, engine, progress_preferences
from core.logging import get_logger


logger = get_logger(__name__)

# 热键触发的文件操作必须总是显示任务卡，哪怕小文件 0.3 秒内完成，
# 否则 Ctrl+V/Delete 看起来像没反应。
DELAY_SHOW_SECS = 0
CARD_WIDTH = 440  # 96 DPI 下的像素，运行时按屏幕 DPI 放大；高度按字体行高算
CJK_FAMILY = "SimSun"  # 宋体
LATIN_FAMILY = "Times New Roman"
FONT_SIZE = 12  # 小四
FULL_BODY_LINES = 5
COMPACT_BODY_LINES = 2
SAFE_MARGIN = 16
MAX_CARD_SLOTS = 4
MAX_ERROR_DETAILS = 6
TICK_INTERVAL_MS = 250

GWL_EXSTYLE = -20
GWLP_WNDPROC = -4
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WM_MOUSEACTIVATE = 0x0021
MA_NOACTIVATE = 3
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def configure_win32_prototypes(kernel32, user32):
    """Apply exact 64-bit-safe ctypes signatures before any native call."""
    kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.ReleaseMutex.argtypes = (wintypes.HANDLE,)
    kernel32.ReleaseMutex.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    user32.GetWindowLongPtrW.argtypes = (wintypes.HWND, ctypes.c_int)
    user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    user32.SetWindowLongPtrW.argtypes = (wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t)
    user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
    user32.SetWindowPos.argtypes = (
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, wintypes.UINT,
    )
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.CallWindowProcW.argtypes = (
        ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    )
    user32.CallWindowProcW.restype = ctypes.c_ssize_t
    user32.MonitorFromWindow.argtypes = (wintypes.HWND, wintypes.DWORD)
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = (wintypes.HANDLE, ctypes.POINTER(MONITORINFO))
    user32.GetMonitorInfoW.restype = wintypes.BOOL


if os.name == "nt":
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    configure_win32_prototypes(_kernel32, _user32)
else:
    _kernel32 = _user32 = None


def card_origin(position, work_area, card_size, margin=SAFE_MARGIN):
    """Return a card's upper-left corner for one of the preference nine-grid cells."""
    left, top, right, bottom = work_area
    width, height = card_size
    x_positions = {
        "left": left + margin,
        "center": left + (right - left - width) // 2,
        "right": right - width - margin,
    }
    y_positions = {
        "top": top + margin,
        "center": top + (bottom - top - height) // 2,
        "bottom": bottom - height - margin,
    }
    row, column = position.split("-", 1) if "-" in position else ("center", "center")
    if position == "center":
        row = column = "center"
    return x_positions[column], y_positions[row]


def stacked_card_origin(position, work_area, card_size, margin, slot):
    """Keep the four per-session cards stacked toward the nearest safe edge."""
    x, y = card_origin(position, work_area, card_size, margin)
    step = card_size[1] + 8
    return x, y - slot * step if position.startswith("bottom-") else y + slot * step


class SpeedSmoother:
    """Calculate a rolling average using no more than the latest two seconds."""

    def __init__(self, window_seconds=2.0):
        self.window_seconds = window_seconds
        self._samples = deque()

    def observe(self, bytes_done, now):
        self._samples.append((now, bytes_done))
        cutoff = now - self.window_seconds
        while len(self._samples) > 1 and self._samples[0][0] < cutoff:
            self._samples.popleft()
        first_time, first_bytes = self._samples[0]
        elapsed = now - first_time
        return (bytes_done - first_bytes) / elapsed if elapsed > 0 else 0.0


def progress_eta(snapshot, speed, running_elapsed=None):
    """ETA starts one second after entering ``running``, never task start."""
    if running_elapsed is None:
        running_elapsed = snapshot.elapsed_seconds
    if (
        snapshot.phase != "running"
        or not snapshot.scan_complete
        or running_elapsed < 1.0
        or snapshot.bytes_total <= snapshot.bytes_done
        or speed <= 0
    ):
        return None
    return (snapshot.bytes_total - snapshot.bytes_done) / speed


def _fmt_eta(seconds):
    return f"ETA {max(1, round(seconds))}s" if seconds is not None else ""


def _fmt_bytes(value):
    if value >= 1024 ** 3:
        return f"{value / 1024 / 1024 / 1024:,.1f} GB"
    return f"{value / 1024 / 1024:,.1f} MB"


def _operation_label(snapshot):
    return {
        "copy": "复制", "move": "移动", "delete": "删除", "recycle": "移入回收站",
    }.get(snapshot.operation, "处理")


def _progress_counts(snapshot):
    if snapshot.items_total:
        return snapshot.items_done, snapshot.items_total
    return snapshot.files_done, snapshot.files_total


def progress_fraction(snapshot):
    """Return the units used by the progress bar, preferring transfer bytes.

    同盘改名是瞬间完成的，混合移动（部分改名 + 部分跨盘拷）若按条目算会先显示 100%。"""
    if snapshot.operation in ("copy", "move") and snapshot.bytes_total:
        return snapshot.bytes_done, snapshot.bytes_total
    if snapshot.items_total:
        return snapshot.items_done, snapshot.items_total
    return snapshot.files_done, snapshot.files_total


def progress_bar_value(snapshot):
    done, total = progress_fraction(snapshot)
    return min(1000, done * 1000 // total) if total else 0


def _progress_percent(snapshot):
    done, total = progress_fraction(snapshot)
    return int(done * 100 / total) if total else 0


def _progress_units(snapshot):
    if snapshot.operation in ("delete", "recycle") or snapshot.items_total:
        return _progress_counts(snapshot)[0]
    return snapshot.bytes_done


def card_is_determinate(snapshot):
    """Only the legacy Shell fallback is intentionally indeterminate."""
    return (
        snapshot.phase == "running"
        and snapshot.scan_complete
        and not snapshot.indeterminate
        and bool(progress_fraction(snapshot)[1])
    )


def card_can_cancel(snapshot, compact):
    return not compact and (not snapshot.recycle or snapshot.can_cancel)


def format_progress(snapshot, compact, speed, running_elapsed=None):
    """Render operation-aware content without leaking paths in compact mode."""
    if snapshot.phase == "scanning":
        if snapshot.files_total:
            return f"{_operation_label(snapshot)} 正在扫描… 已发现 {snapshot.files_total:,} 个"
        return f"{_operation_label(snapshot)} 正在扫描…"
    if snapshot.phase == "cleanup":
        return f"{_operation_label(snapshot)} 正在清理源文件…"
    if snapshot.recycle and snapshot.indeterminate:
        return "移入回收站 系统处理中…"
    if not snapshot.scan_complete:
        # 边扫边拷：总量还在长，只报已完成量与速度，不报百分比和剩余时间。
        rate = f"{_fmt_bytes(speed)}/s" if speed else ""
        found = f"{snapshot.files_done:,}/{snapshot.files_total:,}+"
        primary = "  ".join(part for part in (
            _operation_label(snapshot), found, _fmt_bytes(snapshot.bytes_done), rate,
            f"用时 {snapshot.elapsed_seconds:.1f}s",
        ) if part)
        if compact:
            return primary
        path = os.path.basename(snapshot.current_path) or snapshot.current_path
        return "\n".join(part for part in (path, primary, "仍在统计总量…") if part)
    done, total = _progress_counts(snapshot)
    count = f"{done:,}/{total:,}" if total else ""
    percent = f"{_progress_percent(snapshot)}%" if total else ""
    elapsed = f"用时 {snapshot.elapsed_seconds:.1f}s"
    deleting = snapshot.operation in ("delete", "recycle")
    rate = f"{speed:,.1f} 项/秒" if deleting or snapshot.items_total else (
        f"{_fmt_bytes(speed)}/s" if speed else "")
    eta = _fmt_eta(progress_eta(snapshot, speed, running_elapsed))
    primary = "  ".join(part for part in (_operation_label(snapshot), count, percent, rate, elapsed) if part)
    if compact:
        compact_primary = "  ".join(
            part for part in (_operation_label(snapshot), percent, rate, elapsed, eta) if part
        )
        return compact_primary or f"{_operation_label(snapshot)} 正在处理…"
    path = os.path.basename(snapshot.current_path) or snapshot.current_path
    released = f"已释放 {_fmt_bytes(snapshot.bytes_done)}" if deleting else ""
    total_bytes = f"总计 {_fmt_bytes(snapshot.bytes_total)}" if snapshot.bytes_total else ""
    return "\n".join(part for part in (path, primary, total_bytes, released, eta) if part) or "正在处理…"


@dataclass(frozen=True)
class FinalCardState:
    kind: str
    summary: str
    details: tuple
    auto_hide_seconds: Optional[int]


def final_card_state(snapshot, auto_hide_seconds):
    """Return an honest persistent final state for successful and partial operations."""
    if snapshot.errors_count:
        details = tuple(f"{path}: {message}" for path, message in snapshot.errors[:MAX_ERROR_DETAILS])
        first = details[0] if details else "未知错误"
        return FinalCardState("partial-failure", f"失败 {snapshot.errors_count} 项：{first}", details, None)
    if snapshot.cancel_requested:
        return FinalCardState("cancelled", "已取消", (), None)
    done, total = _progress_counts(snapshot)
    label = _operation_label(snapshot)
    summary = f"{label}完成 {done:,}/{total:,} 项，用时 {snapshot.elapsed_seconds:.2f}s" if total else f"{label}完成，用时 {snapshot.elapsed_seconds:.2f}s"
    if snapshot.operation == "delete":
        summary += f"，已释放 {_fmt_bytes(snapshot.bytes_done)}"
    if snapshot.elapsed_seconds > 0:
        if snapshot.operation == "delete" or snapshot.items_total:
            summary += f"，平均 {done / snapshot.elapsed_seconds:,.1f} 项/秒"
        elif snapshot.bytes_done:
            summary += f"，平均 {_fmt_bytes(snapshot.bytes_done / snapshot.elapsed_seconds)}/s"
    return FinalCardState("success", summary, (), auto_hide_seconds)


_fallback_slot_lock = threading.Lock()
_fallback_slots = set()


def _claim_named_card_slot(slot):
    """Claim one cross-process Win32 mutex; return its handle or ``None``."""
    if os.name != "nt":
        with _fallback_slot_lock:
            if slot in _fallback_slots:
                return None
            _fallback_slots.add(slot)
        return ("fallback", slot)
    handle = _kernel32.CreateMutexW(None, False, f"Local\\Ideal1FileVaultProgressCard-{slot}")
    if not handle:
        return None
    if _kernel32.WaitForSingleObject(handle, 0) in (0, 0x80):
        return handle
    _kernel32.CloseHandle(handle)
    return None


def claim_card_slot():
    for slot in range(MAX_CARD_SLOTS):
        handle = _claim_named_card_slot(slot)
        if handle is not None:
            return type("CardSlot", (), {"slot": slot, "handle": handle})()
    return None


def _release_card_slot(card_slot):
    if card_slot is None:
        return
    handle = card_slot.handle
    if isinstance(handle, tuple):
        with _fallback_slot_lock:
            _fallback_slots.discard(card_slot.slot)
        return
    try:
        _kernel32.ReleaseMutex(handle)
    finally:
        _kernel32.CloseHandle(handle)


def _trigger_work_area(hwnd):
    """Use the triggering Explorer monitor's *work* area, never cursor position."""
    if os.name != "nt":
        return (0, 0, 1920, 1080)
    monitor = _user32.MonitorFromWindow(hwnd or 0, 2)
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(info)
    if monitor and _user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        work = info.rcWork
        return work.left, work.top, work.right, work.bottom
    return (0, 0, 1920, 1080)


_previous_wndprocs = {}


def _window_long_functions(user32):
    return user32.GetWindowLongPtrW, user32.SetWindowLongPtrW


def _set_noactivate_ex_style(hwnd):
    if os.name != "nt":
        return
    get_long, set_long = _window_long_functions(_user32)
    set_long(hwnd, GWL_EXSTYLE, get_long(hwnd, GWL_EXSTYLE) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)


def _install_mouseactivate_noactivate(hwnd):
    if os.name != "nt":
        return
    get_long, set_long = _window_long_functions(_user32)
    previous = get_long(hwnd, GWLP_WNDPROC)
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

    @callback_type
    def wndproc(window, message, wparam, lparam):
        if message == WM_MOUSEACTIVATE:
            return MA_NOACTIVATE
        return _user32.CallWindowProcW(previous, window, message, wparam, lparam)

    _previous_wndprocs[hwnd] = (previous, wndproc)
    set_long(hwnd, GWLP_WNDPROC, ctypes.cast(wndproc, ctypes.c_void_p).value)


def restore_mouseactivate_wndproc(hwnd):
    """Restore Tk's WNDPROC before releasing the callback reference."""
    previous = _previous_wndprocs.pop(hwnd, None)
    if previous is None or os.name != "nt":
        return
    _get_long, set_long = _window_long_functions(_user32)
    set_long(hwnd, GWLP_WNDPROC, previous[0])


def _show_noactivate(hwnd, x, y, width, height):
    if os.name != "nt":
        return
    _user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW)


def show_non_activating(root, x, y, width, height):
    """First-show sequence without taking focus from the triggering app."""
    root.withdraw()
    hwnd = root.winfo_id()
    _set_noactivate_ex_style(hwnd)
    _install_mouseactivate_noactivate(hwnd)
    # ``withdraw`` 是 Tk 状态，单靠 SWP_SHOWWINDOW 无法显示被 withdraw 的 toplevel。
    # 须在装好 no-activate 样式之后再 deiconify，再由 Win32 无焦点显示。
    root.deiconify()
    _show_noactivate(hwnd, x, y, width, height)


def _is_cjk(ch):
    o = ord(ch)
    return (
        0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF
        or 0xFE30 <= o <= 0xFE4F or 0xFF00 <= o <= 0xFFEF
        or 0x20000 <= o <= 0x2FA1F
    )


def font_runs(text):
    """切成 (片段, 是否中文)：中文走宋体，英文、数字、标点走 Times New Roman。"""
    runs = []
    for ch in text:
        cjk = _is_cjk(ch)
        if runs and runs[-1][1] == cjk:
            runs[-1][0].append(ch)
        else:
            runs.append(([ch], cjk))
    return [("".join(chars), cjk) for chars, cjk in runs]


class _MixedText:
    """只读多行文字，按字符分字体（Tk Label 只能一种字体）。"""

    def __init__(self, parent, lines, bold=False):
        import tkinter as tk

        weight = "bold" if bold else "normal"
        self.widget = tk.Text(
            parent, height=lines, borderwidth=0, highlightthickness=0, wrap="none",
            cursor="arrow", takefocus=0, background=parent.cget("background"),
            font=(LATIN_FAMILY, FONT_SIZE, weight), padx=0, pady=0,
        )
        self.widget.tag_configure("cjk", font=(CJK_FAMILY, FONT_SIZE, weight))
        self.widget.tag_configure("latin", font=(LATIN_FAMILY, FONT_SIZE, weight))
        self.widget.configure(state="disabled")
        self._text = None

    def pack(self, **kwargs):
        self.widget.pack(**kwargs)

    def config(self, text=None, foreground=None):
        if foreground is not None:
            for tag in ("cjk", "latin"):
                self.widget.tag_configure(tag, foreground=foreground)
        if text is None or text == self._text:
            return
        self._text = text
        self.widget.configure(state="normal")
        self.widget.delete("1.0", "end")
        for chunk, cjk in font_runs(text):
            self.widget.insert("end", chunk, "cjk" if cjk else "latin")
        self.widget.configure(state="disabled")


def _card_size(root, compact):
    """按实际字体行高与屏幕 DPI 算卡片尺寸，高 DPI 下文字不被截断。"""
    import tkinter.font as tkfont

    line = max(
        tkfont.Font(root=root, family=family, size=FONT_SIZE).metrics("linespace")
        for family in (CJK_FAMILY, LATIN_FAMILY)
    )
    scale = max(1.0, root.winfo_fpixels("1i") / 96.0)
    body_lines = COMPACT_BODY_LINES if compact else FULL_BODY_LINES
    chrome = (12 + 6 + 14 + 6 + 8 + 34 + 12) * scale  # 上下留白、进度条、按钮
    return int(CARD_WIDTH * scale), int(line * (1 + body_lines) + chrome), scale


class _ProgressWindow:
    def __init__(self, headline, cancel_flag, final, preferences, trigger_hwnd, card_slot):
        import tkinter as tk
        from tkinter import ttk

        self.cancel_flag, self.final, self.preferences, self.card_slot = cancel_flag, final, preferences, card_slot
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("FileHook")
        self.root.resizable(False, False)
        self.root.attributes("-topmost", True)
        ttk.Style(self.root).configure("TButton", font=(CJK_FAMILY, FONT_SIZE))
        width, height, scale = _card_size(self.root, preferences["compact"])
        pad = int(14 * scale)
        self.head = _MixedText(self.root, 1, bold=True)
        self.head.config(text=headline)
        self.head.pack(fill="x", padx=pad, pady=(int(12 * scale), int(6 * scale)))
        self.bar = ttk.Progressbar(self.root, length=width - 2 * pad, mode="indeterminate")
        self.bar.pack(padx=pad, pady=(0, int(6 * scale)))
        self.bar.start(12)
        self.body = _MixedText(self.root, COMPACT_BODY_LINES if preferences["compact"] else FULL_BODY_LINES)
        self.body.config(text="正在扫描…")
        self.body.pack(fill="x", padx=pad)
        self.btn = None
        self._running_started_at = None
        live_report = final.get("live_report")
        initial_snapshot = live_report.snapshot() if live_report is not None else None
        if initial_snapshot is None or card_can_cancel(initial_snapshot, preferences["compact"]):
            self.btn = ttk.Button(self.root, text="取消", command=self._on_cancel)
            self.btn.pack(pady=(2, 10))
        self.root.protocol("WM_DELETE_WINDOW", self._on_cancel)
        x, y = stacked_card_origin(
            preferences["position"], _trigger_work_area(trigger_hwnd),
            (width, height), SAFE_MARGIN, card_slot.slot,
        )
        show_non_activating(self.root, x, y, width, height)
        self._hwnd = self.root.winfo_id()
        self.smoothing = SpeedSmoother()

    def _on_cancel(self):
        if "report" in self.final or "exc" in self.final:
            self._close()
            return
        live_report = self.final.get("live_report")
        snapshot = live_report.snapshot() if live_report is not None else None
        if snapshot is not None and not card_can_cancel(snapshot, self.preferences["compact"]):
            return
        self.cancel_flag.value = 1
        if self.btn is not None:
            self.btn.config(text="正在取消…", state="disabled")

    def _tick(self):
        try:
            self._tick_once()
        except Exception:
            logger.exception("progress card tick failed; closing card without affecting operation")
            self._close()

    def _tick_once(self):
        report = self.final.get("live_report")
        snapshot = report.snapshot() if report is not None else None
        done = "report" in self.final or "exc" in self.final
        if snapshot is not None and not done:
            now = time.perf_counter()
            if snapshot.phase == "running" and getattr(self, "_running_started_at", None) is None:
                self._running_started_at = now
            if card_is_determinate(snapshot) and str(self.bar["mode"]) != "determinate":
                self.bar.stop()
                self.bar.config(mode="determinate", maximum=1000)
            if card_is_determinate(snapshot):
                self.bar["value"] = progress_bar_value(snapshot)
            speed = self.smoothing.observe(_progress_units(snapshot), now)
            running_started_at = getattr(self, "_running_started_at", None)
            running_elapsed = None if running_started_at is None else now - running_started_at
            self.body.config(text=format_progress(snapshot, self.preferences["compact"], speed, running_elapsed))
            button = getattr(self, "btn", None)
            if button is not None and not card_can_cancel(snapshot, self.preferences["compact"]):
                button.config(text="系统操作中…", state="disabled")
        if done:
            self._show_final()
            return
        self.root.after(TICK_INTERVAL_MS, self._tick)

    def _show_final(self):
        self.bar.stop()
        exc = self.final.get("exc")
        if exc is not None:
            state = FinalCardState("failure", f"引擎异常：{exc}", (), None)
        else:
            state = final_card_state(self.final["report"].snapshot(), self.preferences["auto_hide_seconds"])
        self.head.config(text={"success": "✅ 完成", "partial-failure": "❌ 部分失败", "cancelled": "⚠ 已取消"}.get(state.kind, "❌ 失败"))
        self.body.config(text="\n".join((state.summary,) + state.details), foreground="#b00020" if state.kind != "success" else "")
        if state.auto_hide_seconds is None:
            if self.btn is None:
                self.btn = self._make_close_button()
            self.btn.config(text="关闭", state="normal", command=self._close)
        else:
            self._countdown(state.auto_hide_seconds)

    def _countdown(self, seconds):
        if self.btn is None:
            self.btn = self._make_close_button()
        self.btn.config(text=f"关闭（{seconds}s 后自动）", command=self._close)
        if seconds <= 0:
            self._close()
        else:
            self.root.after(1000, lambda: self._countdown(seconds - 1))

    def run(self):
        self.root.after(100, self._tick)
        try:
            self.root.mainloop()
            return self.final.get("report")
        finally:
            restore_mouseactivate_wndproc(getattr(self, "_hwnd", None))

    def _make_close_button(self):
        from tkinter import ttk
        button = ttk.Button(self.root, text="关闭", command=self._close)
        button.pack(pady=(2, 10))
        return button

    def _close(self):
        try:
            try:
                hwnd = getattr(self, "_hwnd", None)
                if hwnd is None:
                    hwnd = self.root.winfo_id()
                restore_mouseactivate_wndproc(hwnd)
            finally:
                self.root.destroy()
        except Exception:
            logger.exception("progress card close failed")


def _run_with_progress(headline, work, trigger_hwnd=None):
    """Run work independently, observing it with a best-effort non-activating card."""
    preferences = progress_preferences.load_preferences()  # exactly once per task
    cancel_flag = wintypes.BOOL(0)
    final = {}

    def on_report(report):
        # Keep the thread-safe report, not a one-time snapshot: the UI creates a
        # fresh immutable view on every tick as the worker advances.
        final["live_report"] = report

    def run_work():
        try:
            final["report"] = work(cancel_flag, on_report)
        except Exception as exc:
            final["exc"] = exc

    worker = threading.Thread(target=run_work, name="file-operation-worker", daemon=False)
    worker.start()
    deadline = time.perf_counter() + DELAY_SHOW_SECS
    while time.perf_counter() < deadline and "report" not in final and "exc" not in final:
        time.sleep(0.01)
    report = final.get("report")
    if report is not None and report.ok:
        return report
    card_slot = claim_card_slot()
    if card_slot is not None:
        ui_result = None
        try:
            ui_result = _ProgressWindow(
                headline, cancel_flag, final, preferences, trigger_hwnd, card_slot,
            ).run()
        except Exception:
            logger.exception("progress card UI failed; waiting for file operation result")
        finally:
            _release_card_slot(card_slot)
        if ui_result is not None:
            return ui_result
    worker.join()
    return final.get("report")


def _notice(title, text):
    import tkinter as tk
    from tkinter import messagebox
    root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
    messagebox.showinfo(title, text, parent=root); root.destroy()


def _confirm_permanent_delete(paths):
    import tkinter as tk
    from tkinter import messagebox
    preview = "\n".join(f"· {os.path.basename(p.rstrip(chr(92))) or p}" for p in paths[:6])
    root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
    ok = messagebox.askyesno("file_clip 高速删除（永久）", f"将永久删除以下 {len(paths)} 个条目：\n\n{preview}\n\n⚠ 不进回收站，删除后无法恢复！确定吗？", icon="warning", default="no", parent=root)
    root.destroy()
    return ok


def gui_paste(dest, on_conflict="rename", threads=None, trigger_hwnd=None):
    got = clipboard.get_file_drop()
    if got is None:
        _notice("file_clip", "剪贴板上没有文件。\n先复制/剪切文件，再高速粘贴。")
        return 1
    paths, is_cut = got
    headline = f"{'移动' if is_cut else '复制'} {len(paths)} 个条目 → {os.path.basename(dest.rstrip(chr(92))) or dest}"
    def work(cancel_flag, on_report):
        return engine.transfer(paths, dest, move=is_cut, on_conflict=on_conflict, threads=threads, live_progress=False, cancel_flag=cancel_flag, on_report=on_report)
    report = _run_with_progress(headline, work, trigger_hwnd)
    if report is None:
        return 2
    if is_cut and report.ok:
        clipboard.clear_clipboard()
    return 0 if report.ok else 2


def gui_delete(paths, recycle=False, assume_yes=False, trigger_hwnd=None):
    if not paths:
        return 0
    if not recycle and not assume_yes and not _confirm_permanent_delete(paths):
        return 1
    headline = f"{'移入回收站' if recycle else '永久删除'} {len(paths)} 个条目"
    def work(cancel_flag, on_report):
        return engine.delete_items(paths, recycle=recycle, live_progress=False, cancel_flag=cancel_flag, on_report=on_report)
    report = _run_with_progress(headline, work, trigger_hwnd)
    return 0 if report is not None and report.ok else 2
