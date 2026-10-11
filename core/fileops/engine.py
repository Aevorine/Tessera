r"""高速文件拷贝/移动引擎（纯 ctypes 调 Win32 API）。

单文件用 CopyFileExW（内核级、释放 GIL）；海量小文件线程池并行；>=256MB 加
COPY_FILE_NO_BUFFERING；同盘剪切用 MoveFileExW 改名；内部统一 \\?\ 长路径。
"""

import ctypes
import hashlib
import json
import os
import random
import tempfile
import threading
import time
import weakref
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from ctypes import wintypes
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Tuple

from core.logging import get_logger
from core.fileops import shell_recycle

logger = get_logger(__name__)

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ---- Win32 常量 ----
COPY_FILE_FAIL_IF_EXISTS = 0x0001
COPY_FILE_NO_BUFFERING = 0x1000
MOVEFILE_REPLACE_EXISTING = 0x0001
ERROR_NOT_SAME_DEVICE = 17
ERROR_ACCESS_DENIED = 5
ERROR_REQUEST_ABORTED = 1235
FILE_ATTRIBUTE_NORMAL = 0x80
PROGRESS_CONTINUE = 0

NO_BUFFERING_THRESHOLD = 256 * 1024 * 1024  # 大于此值用无缓冲直写
PROGRESS_CB_THRESHOLD = 32 * 1024 * 1024  # 大于此值挂进度回调
SECURE_ERASE_PASSES = 3  # 安全擦除覆写次数

LPPROGRESS_ROUTINE = ctypes.WINFUNCTYPE(
    wintypes.DWORD,
    ctypes.c_longlong,  # TotalFileSize
    ctypes.c_longlong,  # TotalBytesTransferred
    ctypes.c_longlong,  # StreamSize
    ctypes.c_longlong,  # StreamBytesTransferred
    wintypes.DWORD,  # dwStreamNumber
    wintypes.DWORD,  # dwCallbackReason
    wintypes.HANDLE,  # hSourceFile
    wintypes.HANDLE,  # hDestinationFile
    ctypes.c_void_p,  # lpData
)

kernel32.CopyFileExW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.LPCWSTR,
    LPPROGRESS_ROUTINE,
    ctypes.c_void_p,
    ctypes.POINTER(wintypes.BOOL),
    wintypes.DWORD,
]
kernel32.CopyFileExW.restype = wintypes.BOOL
kernel32.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
kernel32.MoveFileExW.restype = wintypes.BOOL
kernel32.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
kernel32.SetFileAttributesW.restype = wintypes.BOOL

_NULL_PROGRESS = ctypes.cast(None, LPPROGRESS_ROUTINE)


# ---- 路径工具：内部统一扩展路径，展示时还原 ----

def _internal(path: str) -> str:
    r"""转成 \\?\ 扩展路径（绝对、不受 260 字符限制）。"""
    p = os.path.abspath(path)
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):  # UNC 网络路径
        return "\\\\?\\UNC" + p[1:]
    return "\\\\?\\" + p


def _disp(path: str) -> str:
    """还原成用户可读的普通路径。"""
    if path.startswith("\\\\?\\UNC"):
        return "\\" + path[7:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def _same_volume(a: str, b: str) -> bool:
    da = os.path.splitdrive(_disp(a))[0].casefold()
    db = os.path.splitdrive(_disp(b))[0].casefold()
    return da == db and da != ""


def _win_err_msg(err: int) -> str:
    try:
        return f"[WinError {err}] {ctypes.FormatError(err).strip()}"
    except Exception:
        return f"[WinError {err}]"


# ---- 结果报告 ----

@dataclass(frozen=True)
class TaskProgress:
    """A consistent, immutable view of an in-flight file operation."""

    operation: str
    phase: str
    current_path: str
    files_done: int
    files_total: int
    bytes_done: int
    bytes_total: int
    started_at: float
    elapsed_seconds: float
    speed_bytes_per_second: float
    eta_seconds: Optional[float]
    items_done: int
    items_total: int
    errors_count: int
    errors: Tuple[Tuple[str, str], ...]
    cancel_requested: bool
    recycle: bool
    indeterminate: bool = False
    can_cancel: bool = False


@dataclass
class _ReportProgressState:
    """Non-serializable progress state kept outside TransferReport fields."""

    lock: threading.RLock = field(default_factory=threading.RLock)
    phase: str = "scanning"
    current_path: str = ""
    items_done: int = 0
    items_total: int = 0
    started_at: float = field(default_factory=time.time)
    started_perf: float = field(default_factory=time.perf_counter)
    indeterminate: bool = False
    can_cancel: bool = False


_REPORT_STATES: Dict[int, _ReportProgressState] = {}
_REPORT_STATES_LOCK = threading.Lock()


def _discard_report_state(report_id: int) -> None:
    with _REPORT_STATES_LOCK:
        _REPORT_STATES.pop(report_id, None)


def _register_report_state(report: "TransferReport") -> None:
    report_id = id(report)
    with _REPORT_STATES_LOCK:
        _REPORT_STATES[report_id] = _ReportProgressState()
    weakref.finalize(report, _discard_report_state, report_id)


def _report_state(report: "TransferReport") -> _ReportProgressState:
    with _REPORT_STATES_LOCK:
        return _REPORT_STATES[id(report)]


@dataclass
class TransferReport:
    operation: str  # "copy" / "move"
    files_total: int = 0  # 需要搬数据的文件数（不含同盘快速改名）
    bytes_total: int = 0
    files_done: int = 0
    bytes_done: int = 0
    fast_moved: List[Tuple[str, str]] = field(default_factory=list)  # 同盘瞬间改名的条目
    renamed: List[Tuple[str, str]] = field(default_factory=list)  # 因重名自动改名的条目
    skipped: List[str] = field(default_factory=list)
    errors: List[Tuple[str, str]] = field(default_factory=list)
    elapsed: float = 0.0
    cancelled: bool = False

    def __post_init__(self) -> None:
        _register_report_state(self)

    def __setstate__(self, state: dict) -> None:
        self.__dict__.update(state)
        _register_report_state(self)

    @property
    def _lock(self) -> threading.RLock:
        return _report_state(self).lock

    @property
    def ok(self) -> bool:
        return not self.errors and not self.cancelled

    def snapshot(self) -> TaskProgress:
        """Return one lock-consistent state snapshot; it owns no mutable report state,
        so it can be rendered after the lock is released."""
        state = _report_state(self)
        with state.lock:
            elapsed = self.elapsed or max(0.0, time.perf_counter() - state.started_perf)
            speed = self.bytes_done / elapsed if elapsed > 0 else 0.0
            eta = None
            if (
                state.phase == "running"
                and elapsed >= 1.0
                and self.bytes_total > self.bytes_done
                and speed > 0
            ):
                eta = (self.bytes_total - self.bytes_done) / speed
            return TaskProgress(
                operation=self.operation,
                phase=state.phase,
                current_path=state.current_path,
                files_done=self.files_done,
                files_total=self.files_total,
                bytes_done=self.bytes_done,
                bytes_total=self.bytes_total,
                started_at=state.started_at,
                elapsed_seconds=elapsed,
                speed_bytes_per_second=speed,
                eta_seconds=eta,
                items_done=state.items_done,
                items_total=state.items_total,
                errors_count=len(self.errors),
                errors=tuple(self.errors[:6]),
                cancel_requested=self.cancelled,
                recycle=self.operation == "recycle",
                indeterminate=state.indeterminate,
                can_cancel=state.can_cancel,
            )

    def note_scanned_file(self, path: str, size: int) -> None:
        state = _report_state(self)
        with state.lock:
            state.current_path = _disp(path)
            self.files_total += 1
            self.bytes_total += size

    def set_fast_move_total(self, count: int) -> None:
        state = _report_state(self)
        with state.lock:
            state.items_total = count

    def note_fast_move(self, path: str) -> None:
        state = _report_state(self)
        with state.lock:
            state.current_path = _disp(path)
            state.items_done += 1

    def set_recycle_capabilities(self, indeterminate: bool, can_cancel: bool = False) -> None:
        """Describe the active recycle implementation without inventing capability."""
        state = _report_state(self)
        with state.lock:
            state.indeterminate = indeterminate
            state.can_cancel = can_cancel

    def note_recycle_item_started(self, path: str) -> None:
        state = _report_state(self)
        with state.lock:
            state.current_path = _disp(path)
            state.items_total += 1

    def note_recycle_item_done(self, path: str) -> None:
        state = _report_state(self)
        with state.lock:
            state.current_path = _disp(path)
            state.items_done += 1
            self.files_done += 1

    def remove_fast_move_candidate(self) -> None:
        state = _report_state(self)
        with state.lock:
            state.items_total = max(state.items_done, state.items_total - 1)

    def set_current_path(self, path: str) -> None:
        state = _report_state(self)
        with state.lock:
            state.current_path = _disp(path)

    def add_error(self, path: str, message: str) -> None:
        state = _report_state(self)
        with state.lock:
            self.errors.append((path, message))

    def mark_running(self) -> None:
        state = _report_state(self)
        with state.lock:
            if state.phase == "scanning":
                state.phase = "running"

    def mark_scanning(self) -> None:
        state = _report_state(self)
        with state.lock:
            if state.phase == "running":
                state.phase = "scanning"

    def mark_cancelled(self) -> None:
        state = _report_state(self)
        with state.lock:
            self.cancelled = True

    def finish(self) -> None:
        state = _report_state(self)
        with state.lock:
            self.elapsed = time.perf_counter() - state.started_perf
            if self.cancelled:
                state.phase = "cancelled"
            elif self.errors:
                state.phase = "failed"
            else:
                state.phase = "completed"


class _Progress:
    """线程安全的进度计数器 + 可选的终端实时进度条。"""

    def __init__(self, report: TransferReport, live: bool):
        self.report = report
        self.lock = report._lock
        self.live = live
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._t0 = time.perf_counter()

    def add_bytes(self, n: int) -> None:
        with self.lock:
            self.report.bytes_done += n

    def file_done(self) -> None:
        with self.lock:
            self.report.files_done += 1

    def set_current_path(self, path: str) -> None:
        self.report.set_current_path(path)

    def start(self) -> None:
        if self.live:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self.live and self._thread:
            self._thread.join(timeout=2)
            print("\r" + " " * 79 + "\r", end="", flush=True)

    def _loop(self) -> None:
        while not self._stop.wait(0.5):
            snapshot = self.report.snapshot()
            fd, ft = snapshot.files_done, snapshot.files_total
            bd, bt = snapshot.bytes_done, snapshot.bytes_total
            elapsed = snapshot.elapsed_seconds
            speed = bd / elapsed / 1024 / 1024 if elapsed > 0 else 0
            pct = bd * 100 // bt if bt else (fd * 100 // ft if ft else 100)
            line = (
                f"\r[{pct:3d}%] {fd}/{ft} 个文件  "
                f"{bd / 1024 / 1024:,.0f}/{bt / 1024 / 1024:,.0f} MB  "
                f"{speed:,.0f} MB/s"
            )
            print(line[:79], end="", flush=True)


def _run_bounded(pool, fn, items, max_pending: int, collect_results: bool = True):
    """Submit at most ``max_pending`` futures ahead of completion."""
    iterator = iter(items)
    pending = {}
    results = {}
    next_index = 0
    exhausted = False
    while pending or not exhausted:
        while not exhausted and len(pending) < max_pending:
            try:
                item = next(iterator)
            except StopIteration:
                exhausted = True
                break
            future = pool.submit(fn, item)
            pending[future] = next_index
            next_index += 1
        if not pending:
            continue
        done, _ = wait(pending, return_when=FIRST_COMPLETED)
        for future in done:
            index = pending.pop(future)
            value = future.result()
            if collect_results:
                results[index] = value
    if not collect_results:
        return []
    return [results[index] for index in range(next_index)]


def _buffered_size_priority(
    items: Iterable[Tuple[str, str, int, int]],
    buffer_size: int = 256,
) -> Iterator[Tuple[str, str, int, int]]:
    """在固定大小窗口内让大文件优先，不物化整棵目录树。"""
    iterator = iter(items)
    while True:
        batch = []
        for _ in range(buffer_size):
            try:
                batch.append(next(iterator))
            except StopIteration:
                break
        if not batch:
            return
        batch.sort(key=lambda task: task[2], reverse=True)
        yield from batch


# ---- 冲突解决 ----

def _free_name(dst: str, is_dir: bool) -> str:
    """dst 已被占用时，找一个「name (2)」式的空闲名字。"""
    parent, name = os.path.split(dst)
    if is_dir:
        stem, ext = name, ""
    else:
        stem, ext = os.path.splitext(name)
    n = 2
    while True:
        cand = os.path.join(parent, f"{stem} ({n}){ext}")
        if not os.path.lexists(cand):
            return cand
        n += 1


# ---- 核心 API ----

def transfer(
    sources: List[str],
    dest_dir: str,
    move: bool = False,
    on_conflict: str = "rename",  # rename / skip / overwrite
    threads: Optional[int] = None,
    live_progress: bool = True,
    cancel_flag: Optional["wintypes.BOOL"] = None,
    on_report: Optional[Callable[["TransferReport"], None]] = None,
) -> TransferReport:
    """复制/移动 sources 到 dest_dir。on_conflict: rename/skip/overwrite；cancel_flag 为外部取消旗；
    on_report 在创建报告后立即回调一次，供轮询进度。"""
    if on_conflict not in ("rename", "skip", "overwrite"):
        raise ValueError(f"invalid on_conflict: {on_conflict}")
    report = TransferReport(operation="move" if move else "copy")
    if on_report:
        on_report(report)

    dest_dir = _internal(dest_dir)
    os.makedirs(dest_dir, exist_ok=True)

    # 1) 源规整：绝对化、去重、存在性检查、防止把文件夹拷进它自己内部
    items: List[Tuple[str, str, bool]] = []  # (src, dst, is_dir)
    seen = set()
    dest_cmp = os.path.normcase(_disp(dest_dir)) + os.sep
    for raw in sources:
        src = _internal(raw)
        key = os.path.normcase(src)
        if key in seen:
            continue
        seen.add(key)
        if not os.path.lexists(src):
            report.add_error(_disp(src), "源不存在")
            continue
        is_dir = os.path.isdir(src)
        if is_dir and dest_cmp.startswith(os.path.normcase(_disp(src)) + os.sep):
            report.add_error(_disp(src), "目标文件夹在源文件夹内部，会无限嵌套，已拒绝")
            continue
        dst = os.path.join(dest_dir, os.path.basename(_disp(src)))
        if move and os.path.normcase(src) == os.path.normcase(dst):
            with report._lock:
                report.skipped.append(_disp(src) + "（源与目标相同）")
            continue
        items.append((src, dst, is_dir))

    # 2) 重名解决（在顶层条目上，与资源管理器行为一致）
    resolved: List[Tuple[str, str, bool]] = []
    merge_dirs: List[Tuple[str, str]] = []  # overwrite 策略下需要「合并」的目录
    for src, dst, is_dir in items:
        if os.path.lexists(dst):
            if on_conflict == "skip":
                with report._lock:
                    report.skipped.append(_disp(src))
                continue
            if on_conflict == "rename":
                new = _free_name(dst, is_dir)
                with report._lock:
                    report.renamed.append((_disp(dst), _disp(new)))
                dst = new
            else:  # overwrite
                if is_dir and os.path.isdir(dst):
                    merge_dirs.append((src, dst))
                    continue
                if not is_dir and os.path.isdir(dst):
                    report.add_error(_disp(src), "目标位置有同名文件夹，无法用文件覆盖")
                    continue
                if not is_dir:
                    pass  # 文件覆盖文件：交给 CopyFileExW/MoveFileExW 的 replace
                else:
                    report.add_error(_disp(src), "目标位置有同名文件，无法用文件夹覆盖")
                    continue
        resolved.append((src, dst, is_dir))

    # 3) 移动的同盘快速路径：改名即完成，不搬数据
    copy_items: List[Tuple[str, str, bool]] = []
    if move:
        has_copy_scan = any(
            not _same_volume(src, dst) for src, dst, _ in resolved
        ) or any(not _same_volume(src, dst) for src, dst in merge_dirs)
        report.set_fast_move_total(
            sum(1 for src, dst, _ in resolved if _same_volume(src, dst))
            + sum(1 for src, dst in merge_dirs if _same_volume(src, dst))
        )
        if not has_copy_scan:
            report.mark_running()
        for src, dst, is_dir in resolved:
            if _same_volume(src, dst):
                flags = MOVEFILE_REPLACE_EXISTING if (not is_dir and on_conflict == "overwrite") else 0
                if kernel32.MoveFileExW(src, dst, flags):
                    with report._lock:
                        report.fast_moved.append((_disp(src), _disp(dst)))
                    report.note_fast_move(src)
                    continue
                err = ctypes.get_last_error()
                if err == ERROR_NOT_SAME_DEVICE:
                    report.remove_fast_move_candidate()
                    report.mark_scanning()
                    copy_items.append((src, dst, is_dir))  # 盘符相同但实际跨卷（挂载点等）
                else:
                    report.add_error(_disp(src), f"移动失败 {_win_err_msg(err)}")
            else:
                copy_items.append((src, dst, is_dir))
        # overwrite 策略下同盘目录合并：逐文件快速改名
        for src, dst in merge_dirs:
            if _same_volume(src, dst):
                _move_merge_same_volume(src, dst, report)
            else:
                copy_items.append((src, dst, True))
    else:
        copy_items = resolved
        copy_items += [(s, d, True) for s, d in merge_dirs]

    # 4) 准备流式拷贝任务。目录树不再一次性展开进列表，避免巨量小文件
    # 在真正开始复制前占用大量内存并长时间无反馈。
    item_error_count: List[int] = []
    item_srcs: List[Tuple[str, bool]] = []
    for src, dst, is_dir in copy_items:
        item_srcs.append((src, is_dir))
        item_error_count.append(0)

    def iter_tasks() -> Iterator[Tuple[str, str, int, int]]:
        for idx, (src, dst, is_dir) in enumerate(copy_items):
            if is_dir:
                yield from _iter_copy_tasks(
                    src, dst, report, idx, item_error_count,
                )
                continue
            try:
                size = os.stat(src).st_size
            except OSError as exc:
                report.add_error(_disp(src), str(exc))
                item_error_count[idx] += 1
                continue
            report.note_scanned_file(src, size)
            yield src, dst, size, idx

    # 先把流式枚举写入临时任务清单：无需二次扫描或物化整棵目录树，即可在首个
    # CopyFileExW 前冻结总量；排序只占 _buffered_size_priority 固定窗口，清单结束后自动删除。
    if threads is None:
        threads = min(16, max(4, (os.cpu_count() or 4) * 2))
    if cancel_flag is None:
        cancel_flag = wintypes.BOOL(0)
    progress = _Progress(report, live=live_progress and _stdout_is_tty())
    progress.start()
    overwrite = on_conflict == "overwrite"
    pool = ThreadPoolExecutor(max_workers=threads) if copy_items else None
    try:
        if copy_items:
            with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as task_spool:
                for task in _buffered_size_priority(iter_tasks()):
                    task_spool.write(json.dumps(task, ensure_ascii=False) + "\n")
                report.mark_running()
                task_spool.seek(0)

                def spooled_tasks() -> Iterator[Tuple[str, str, int, int]]:
                    for line in task_spool:
                        src, dst, size, idx = json.loads(line)
                        yield src, dst, size, idx

                if pool:
                    _run_bounded(
                        pool,
                        lambda task: _copy_one(
                            task[0], task[1], task[2], task[3], overwrite,
                            cancel_flag, progress, report, item_error_count,
                        ),
                        spooled_tasks(),
                        max_pending=max(threads * 2, 8),
                        collect_results=False,
                    )
    except KeyboardInterrupt:
        # 先立起取消旗，正在拷贝的 CopyFileExW 会立即中止并清掉半成品文件
        cancel_flag.value = 1
        report.mark_cancelled()
        logger.warning("用户中断，已停止拷贝")
    finally:
        if pool:
            pool.shutdown(wait=True, cancel_futures=True)
        progress.stop()
    if cancel_flag.value and not report.cancelled:
        report.mark_cancelled()  # 外部（GUI 取消按钮）置旗

    # 6) 跨盘移动：拷贝全部成功的条目，删除源
    if move and not report.cancelled:
        for idx, (src, is_dir) in enumerate(item_srcs):
            if item_error_count[idx] > 0:
                report.add_error(_disp(src), "有文件拷贝失败，为安全起见源文件保留未删")
                continue
            _delete_source(src, is_dir, report)

    report.finish()
    logger.info(
        "%s done: %d files, %.1f MB, %.2fs, %d errors",
        report.operation, report.files_done,
        report.bytes_done / 1024 / 1024, report.elapsed, len(report.errors),
    )
    return report


def delete_items(
    sources: List[str],
    recycle: bool = False,
    threads: Optional[int] = None,
    live_progress: bool = True,
    cancel_flag: Optional["wintypes.BOOL"] = None,
    on_report: Optional[Callable[["TransferReport"], None]] = None,
) -> TransferReport:
    """删除 sources。永久删除并行 DeleteFileW 后自底向上清目录；回收站优先走 IFileOperation
    逐项回调，Shell COM 不可用才降级为无进度/不可取消的 SHFileOperation。"""
    report = TransferReport(operation="recycle" if recycle else "delete")
    recycle_support = None
    if recycle:
        recycle_support = shell_recycle.availability()
        if recycle_support.available:
            report.set_recycle_capabilities(indeterminate=False)
        else:
            shell_recycle.unavailable_fallback(report, recycle_support.reason)
    if on_report:
        on_report(report)

    items: List[str] = []
    seen = set()
    for raw in sources:
        src = _internal(raw)
        key = os.path.normcase(src)
        if key in seen:
            continue
        seen.add(key)
        if not os.path.lexists(src):
            report.add_error(_disp(src), "源不存在")
            continue
        items.append(src)

    if recycle:
        report.mark_running()
        used_shell_adapter = False
        if recycle_support.available and items:
            used_shell_adapter = shell_recycle.recycle_items(
                [_disp(path) for path in items], report,
            )
            if not used_shell_adapter:
                # COM failed before it performed any Shell work.  This is the
                # only point at which retrying through the legacy API is safe.
                shell_recycle.unavailable_fallback(report, "IFileOperation initialization failed")
        if not used_shell_adapter and items:
            try:
                from win32com.shell import shell, shellcon  # pywin32，本机已装

                with report._lock:
                    report.files_total = len(items)
                flags = (
                    shellcon.FOF_ALLOWUNDO
                    | shellcon.FOF_NOCONFIRMATION
                    | shellcon.FOF_SILENT
                    | shellcon.FOF_NOERRORUI
                )
                # SHFileOperation 不认 \\?\ 扩展路径，用普通绝对路径
                pfrom = "\0".join(_disp(p) for p in items)
                rc, aborted = shell.SHFileOperation(
                    (0, shellcon.FO_DELETE, pfrom, None, flags, None, None)
                )
                if rc == 0 and not aborted:
                    with report._lock:
                        report.files_done = len(items)
                else:
                    report.add_error(
                        "回收站", f"SHFileOperation 返回 {rc}"
                        + ("（被中止）" if aborted else "")
                    )
            except Exception as exc:
                report.add_error("回收站", str(exc))
        report.finish()
        logger.info("recycle done: %d items, %.2fs, %d errors",
                    report.files_done, report.elapsed, len(report.errors))
        return report

    # ---- 永久删除 ----
    # 文件本身流式扫描和提交；只保留目录列表供最后自底向上清理。
    dirs: List[str] = []

    def iter_files() -> Iterator[Tuple[str, int]]:
        for src in items:
            if os.path.isdir(src):
                yield from _iter_delete_files(src, dirs, report)
                continue
            try:
                size = os.stat(src).st_size
            except OSError:
                size = 0
            report.note_scanned_file(src, size)
            yield src, size

    if threads is None:
        threads = min(16, max(4, (os.cpu_count() or 4) * 2))
    if cancel_flag is None:
        cancel_flag = wintypes.BOOL(0)
    progress = _Progress(report, live=live_progress and _stdout_is_tty())
    progress.start()
    pool = ThreadPoolExecutor(max_workers=threads) if items else None
    try:
        if items:
            with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as task_spool:
                for item in iter_files():
                    task_spool.write(json.dumps(item, ensure_ascii=False) + "\n")
                report.mark_running()
                task_spool.seek(0)

                def spooled_files() -> Iterator[Tuple[str, int]]:
                    for line in task_spool:
                        path, size = json.loads(line)
                        yield path, size

                if pool:
                    _run_bounded(
                        pool,
                        lambda item: _delete_one(
                            item[0], item[1], cancel_flag, progress, report
                        ),
                        spooled_files(),
                        max_pending=max(threads * 2, 8),
                        collect_results=False,
                    )
    except KeyboardInterrupt:
        cancel_flag.value = 1
        report.mark_cancelled()
    finally:
        if pool:
            pool.shutdown(wait=True, cancel_futures=True)
        progress.stop()
    if cancel_flag.value and not report.cancelled:
        report.mark_cancelled()

    if not report.cancelled:
        # 文件已清空，自底向上删目录（子目录在前）
        for d in sorted(dirs, key=lambda p: p.count("\\"), reverse=True):
            if not kernel32.RemoveDirectoryW(d):
                err = ctypes.get_last_error()
                report.add_error(_disp(d), f"删目录失败 {_win_err_msg(err)}")

    report.finish()
    logger.info("delete done: %d/%d files, %.1f MB freed, %.2fs, %d errors",
                report.files_done, report.files_total,
                report.bytes_done / 1024 / 1024, report.elapsed, len(report.errors))
    return report


def _iter_delete_files(
    src_dir: str,
    dirs: List[str],
    report: TransferReport,
) -> Iterator[Tuple[str, int]]:
    """流式遍历待删目录，只缓存目录名，不缓存巨量文件任务。"""
    pending_dirs = [src_dir]
    while pending_dirs:
        current = pending_dirs.pop()
        dirs.append(current)
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending_dirs.append(entry.path)
                            continue
                        size = entry.stat(follow_symlinks=False).st_size
                        report.note_scanned_file(entry.path, size)
                        yield entry.path, size
                    except OSError as exc:
                        report.add_error(_disp(entry.path), str(exc))
        except OSError as exc:
            report.add_error(_disp(current), str(exc))


def _delete_one(
    path: str,
    size: int,
    cancel_flag: "wintypes.BOOL",
    progress: _Progress,
    report: TransferReport,
) -> None:
    if cancel_flag.value:
        return
    progress.set_current_path(path)
    if not kernel32.DeleteFileW(path):
        err = ctypes.get_last_error()
        if err == ERROR_ACCESS_DENIED:
            kernel32.SetFileAttributesW(path, FILE_ATTRIBUTE_NORMAL)  # 去只读再试
            if not kernel32.DeleteFileW(path):
                err = ctypes.get_last_error()
                report.add_error(_disp(path), _win_err_msg(err))
                return
        else:
            report.add_error(_disp(path), _win_err_msg(err))
            return
    progress.add_bytes(size)
    progress.file_done()


kernel32.DeleteFileW.argtypes = [wintypes.LPCWSTR]
kernel32.DeleteFileW.restype = wintypes.BOOL
kernel32.RemoveDirectoryW.argtypes = [wintypes.LPCWSTR]
kernel32.RemoveDirectoryW.restype = wintypes.BOOL


# ---- 内部实现 ----

def _stdout_is_tty() -> bool:
    try:
        import sys

        return sys.stdout.isatty()
    except Exception:
        return False


def _iter_copy_tasks(
    src_dir: str,
    dst_dir: str,
    report: TransferReport,
    idx: int,
    item_error_count: List[int],
) -> Iterator[Tuple[str, str, int, int]]:
    """边扫描边生成拷贝任务，目录创建或扫描失败会阻止跨卷源删除。"""
    pending_dirs = [(src_dir, dst_dir)]
    while pending_dirs:
        current_src, current_dst = pending_dirs.pop()
        try:
            os.makedirs(current_dst, exist_ok=True)
        except OSError as exc:
            report.add_error(_disp(current_dst), f"建目录失败: {exc}")
            item_error_count[idx] += 1
            continue
        try:
            with os.scandir(current_src) as entries:
                for entry in entries:
                    target = os.path.join(current_dst, entry.name)
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending_dirs.append((entry.path, target))
                            continue
                        size = entry.stat(follow_symlinks=False).st_size
                        report.note_scanned_file(entry.path, size)
                        yield entry.path, target, size, idx
                    except OSError as exc:
                        report.add_error(_disp(entry.path), str(exc))
                        item_error_count[idx] += 1
        except OSError as exc:
            report.add_error(_disp(current_src), str(exc))
            item_error_count[idx] += 1


def _copy_one(
    src: str,
    dst: str,
    size: int,
    idx: int,
    overwrite: bool,
    cancel_flag: "wintypes.BOOL",
    progress: _Progress,
    report: TransferReport,
    item_error_count: List[int],
) -> None:
    if cancel_flag.value:
        return
    progress.set_current_path(src)
    flags = 0 if overwrite else COPY_FILE_FAIL_IF_EXISTS
    if size >= NO_BUFFERING_THRESHOLD:
        flags |= COPY_FILE_NO_BUFFERING

    callback = _NULL_PROGRESS
    counted = {"v": 0}
    if size >= PROGRESS_CB_THRESHOLD:
        callback = _make_progress_cb(progress, counted)

    ok = kernel32.CopyFileExW(src, dst, callback, None, ctypes.byref(cancel_flag), flags)
    if not ok:
        err = ctypes.get_last_error()
        if err == ERROR_ACCESS_DENIED and overwrite and os.path.lexists(dst):
            # 目标是只读文件：去掉只读属性重试一次
            kernel32.SetFileAttributesW(dst, FILE_ATTRIBUTE_NORMAL)
            ok = kernel32.CopyFileExW(
                src, dst, callback, None, ctypes.byref(cancel_flag), flags
            )
            if not ok:
                err = ctypes.get_last_error()
        if not ok:
            if err != ERROR_REQUEST_ABORTED:
                with progress.lock:
                    report.add_error(_disp(src), _win_err_msg(err))
                    item_error_count[idx] += 1
            return

    # 廉价完整性校验：目标文件大小必须和源一致
    try:
        actual = os.stat(dst).st_size
    except OSError as exc:
        with progress.lock:
            report.add_error(_disp(dst), f"校验失败: {exc}")
            item_error_count[idx] += 1
        return
    if actual != size:
        with progress.lock:
            report.add_error(_disp(dst), f"校验失败: 大小不一致 (源 {size} vs 目标 {actual})")
            item_error_count[idx] += 1
        return

    progress.add_bytes(size - counted["v"])
    progress.file_done()


def _make_progress_cb(progress: _Progress, counted: dict) -> "LPPROGRESS_ROUTINE":
    @LPPROGRESS_ROUTINE
    def cb(total, transferred, ss, st, stream_num, reason, hsrc, hdst, data):
        delta = transferred - counted["v"]
        if delta > 0:
            counted["v"] = transferred
            progress.add_bytes(delta)
        return PROGRESS_CONTINUE

    return cb


def _move_merge_same_volume(src: str, dst: str, report: TransferReport) -> None:
    """同盘 + overwrite 策略下的目录合并移动：逐文件快速改名，然后清掉空源目录。"""
    moved = 0
    failed = 0
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target_root = dst if rel == "." else os.path.join(dst, rel)
        try:
            os.makedirs(target_root, exist_ok=True)
        except OSError as exc:
            report.add_error(_disp(target_root), f"建目录失败: {exc}")
            failed += 1
            continue
        for name in files:
            s = os.path.join(root, name)
            d = os.path.join(target_root, name)
            if os.path.lexists(d):
                kernel32.SetFileAttributesW(d, FILE_ATTRIBUTE_NORMAL)
            if kernel32.MoveFileExW(s, d, MOVEFILE_REPLACE_EXISTING):
                moved += 1
            else:
                report.add_error(_disp(s), f"合并移动失败 {_win_err_msg(ctypes.get_last_error())}")
                failed += 1
    if failed == 0:
        _remove_empty_tree(src, report)
        report.note_fast_move(src)
    else:
        report.add_error(_disp(src), "有文件合并失败，源目录保留未删")
    with report._lock:
        report.fast_moved.append((_disp(src), _disp(dst) + f"（合并 {moved} 个文件）"))


def _delete_source(src: str, is_dir: bool, report: TransferReport) -> None:
    """跨盘移动的收尾：拷贝成功后删除源。"""
    try:
        if is_dir:
            for root, dirs, files in os.walk(src, topdown=False):
                for name in files:
                    p = os.path.join(root, name)
                    kernel32.SetFileAttributesW(p, FILE_ATTRIBUTE_NORMAL)
                    os.unlink(p)
                os.rmdir(root)
        else:
            kernel32.SetFileAttributesW(src, FILE_ATTRIBUTE_NORMAL)
            os.unlink(src)
    except OSError as exc:
        report.add_error(_disp(src), f"删除源失败（目标已拷好）: {exc}")


def _remove_empty_tree(src: str, report: TransferReport) -> None:
    try:
        for root, dirs, files in os.walk(src, topdown=False):
            os.rmdir(root)
    except OSError as exc:
        report.add_error(_disp(src), f"清理源目录失败: {exc}")


# ---- 安全擦除 (E5)：多次覆写后删除 ----

_SECURE_ERASE_CHUNK = 2 * 1024 * 1024  # 2 MiB 分块写入


def secure_erase(path: str, passes: int = SECURE_ERASE_PASSES) -> None:
    """安全擦除：覆写 passes 次（0x00、0xFF、其后随机数据）再删除；目录逐文件擦除后清空。"""
    if not os.path.lexists(path):
        return
    if os.path.isdir(path):
        for root, dirs, files in os.walk(path, topdown=False):
            for name in files:
                secure_erase(os.path.join(root, name), passes)
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass
        try:
            os.rmdir(path)
        except OSError:
            pass
        return

    size = os.path.getsize(path)
    if size <= 0:
        os.unlink(path)
        return

    failed_pass: Optional[int] = None
    for p in range(passes):
        pattern = b'\x00' if p == 0 else (b'\xFF' if p == 1 else None)
        try:
            with open(path, 'wb') as f:
                written = 0
                while written < size:
                    chunk_size = min(_SECURE_ERASE_CHUNK, size - written)
                    if pattern is not None:
                        chunk = pattern * chunk_size
                    else:
                        # random.randbytes 是 C 批量生成，逐字节 randint 慢两个数量级，大文件会卡几分钟。
                        chunk = random.randbytes(chunk_size)
                    f.write(chunk)
                    written += chunk_size
                f.flush()
                os.fsync(f.fileno())
        except OSError:
            logger.exception("secure_erase pass %d failed for %s", p + 1, path)
            failed_pass = p + 1
    if failed_pass is not None:
        # 覆写未全部成功就不删文件：否则调用方会以为已安全清除，而原始内容仍可能可恢复。
        # 保留文件并报错，由调用方决定重试还是退回普通删除。
        raise OSError(f"安全擦除第 {failed_pass} 遍覆写失败，文件未删除，可重试或改用普通删除")
    # 全部覆写成功后才删除
    try:
        kernel32.SetFileAttributesW(_internal(path), FILE_ATTRIBUTE_NORMAL)
        os.unlink(path)
    except OSError as exc:
        raise OSError(f"安全擦除后删除失败: {exc}") from exc


# ---- 智能去重 (E2)：哈希快速比对 ----

# 优先用文件大小做初筛，只对候选文件做哈希
# 避免对全部文件都做昂贵的哈希运算
DEDUP_HASH_FIRST_N = 4 * 1024  # 只对前 4KB 做快速哈希


def fast_dedup_hash(file_path: str) -> Optional[str]:
    """快速哈希（只读前 4KB），判断两文件是否"看起来一样"；None 表示读不了（上层按不确定处理）。
    前 4KB 相同再比全量哈希，比全文件 SHA-256 快两个数量级。"""
    try:
        with open(file_path, 'rb') as f:
            chunk = f.read(DEDUP_HASH_FIRST_N)
            # 不能 "if not chunk: return None"：空文件的 chunk 也是 b''，会把两个空文件误判成
            # 不确定而永不算重复。sha256(b'') 本身良定义，直接算。
            return hashlib.sha256(chunk).hexdigest()
    except OSError:
        return None


def full_dedup_hash(file_path: str) -> Optional[str]:
    """全文件 SHA-256 哈希，在 fast_dedup_hash 匹配后做最终确认。"""
    try:
        h = hashlib.sha256()
        with open(file_path, 'rb') as f:
            while True:
                chunk = f.read(64 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def is_duplicate(source_path: str, dest_path: str) -> bool:
    """判断 dest_path 是否与 source_path 内容重复（大小→快速哈希→全量哈希）；IO 错误返回 False。"""
    try:
        s_size = os.path.getsize(source_path)
        d_size = os.path.getsize(dest_path)
        if s_size != d_size:
            return False
    except OSError:
        return False
    fh1 = fast_dedup_hash(source_path)
    fh2 = fast_dedup_hash(dest_path)
    if fh1 is None or fh2 is None or fh1 != fh2:
        return False
    # 快速哈希匹配，再全量确认
    f1 = full_dedup_hash(source_path)
    f2 = full_dedup_hash(dest_path)
    return f1 is not None and f2 is not None and f1 == f2
