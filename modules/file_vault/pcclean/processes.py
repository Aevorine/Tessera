"""进程占用探测：浏览器开着时缓存、Cookie、扩展目录文件被独占，删除会静默少删且不报错。

从 `junk.py` 提到公共层：原版只服务垃圾清理、硬依赖 psutil（缺失时提示永久静默关闭）、
无缓存。ctypes (`CreateToolhelp32Snapshot`，约 3ms/300 进程) 优先，psutil 兜底，加短 TTL 缓存。
任何一层都探不到时返回空集合（当作没在跑），避免满屏警告被用户全部忽略。
"""

from __future__ import annotations

import os
import threading
import time
from typing import Dict, FrozenSet, Iterable, Optional, Sequence, Tuple

# 九个 scanner 并行各问一次进程表，2 秒 TTL 合并成一次调用，又不会让"关掉浏览器再重试"读到过期结果。
_TTL_S = 2.0

_lock = threading.Lock()
_cached_at: float = 0.0
_cached_names: FrozenSet[str] = frozenset()


def _snapshot_ctypes() -> Optional[FrozenSet[str]]:
    """CreateToolhelp32Snapshot。失败返回 None（区别于"没有进程"的空集合）。"""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:  # pragma: no cover - 非 Windows
        return None

    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    MAX_PATH = 260

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * MAX_PATH),
        ]

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    except (OSError, AttributeError):  # pragma: no cover
        return None

    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE,
                                         ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE,
                                        ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snapshot or snapshot == INVALID_HANDLE_VALUE:
        return None

    names = set()
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return None
        while True:
            name = (entry.szExeFile or "").lower()
            if name:
                names.add(name)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    except Exception:  # pragma: no cover - API 行为异常，交给兜底
        return None
    finally:
        try:
            kernel32.CloseHandle(snapshot)
        except Exception:
            pass
    return frozenset(names)


def _snapshot_psutil() -> Optional[FrozenSet[str]]:
    try:
        import psutil
    except ImportError:
        return None
    try:
        return frozenset(
            (p.info.get("name") or "").lower()
            for p in psutil.process_iter(["name"])
            if p.info.get("name")
        )
    except Exception:
        return None


def running_names(*, force: bool = False) -> FrozenSet[str]:
    """当前在跑的可执行文件名集合（小写），探不到为空集合；`force=True` 跳过缓存，供"关掉浏览器后
    重试"。"""
    global _cached_at, _cached_names

    now = time.monotonic()
    with _lock:
        if not force and now - _cached_at < _TTL_S:
            return _cached_names

    names = _snapshot_ctypes()
    if names is None:
        names = _snapshot_psutil()
    if names is None:
        names = frozenset()

    with _lock:
        _cached_at = now
        _cached_names = names
    return names


# 谁占着谁

# 浏览器显示名 → 可执行文件名。显示名的真相源是 `paths.browser_profile_roots()`，
# 两边必须对得上，否则这里查不到就等于永远不提示。守卫见
# `tests/test_pcclean_processes.py::test_every_browser_label_has_a_process_name`。
BROWSER_PROCESSES: Dict[str, Tuple[str, ...]] = {
    "Google Chrome": ("chrome.exe",),
    "Microsoft Edge": ("msedge.exe",),
    "Mozilla Firefox": ("firefox.exe",),
    "Brave": ("brave.exe",),
    "Vivaldi": ("vivaldi.exe",),
    "Opera": ("opera.exe",),
    "360 极速浏览器": ("360chromex.exe", "360se.exe"),
    "QQ 浏览器": ("qqbrowser.exe",),
    "Sogou 浏览器": ("sogouexplorer.exe",),
}


def browser_running(label: str, *, names: Optional[Iterable[str]] = None) -> str:
    """浏览器是否在跑：返回正在跑的进程名（没跑为空串），界面要说「请先关闭 chrome.exe」而非笼统的
    "有程序占用"。"""
    wanted = BROWSER_PROCESSES.get(label)
    if not wanted:
        return ""
    pool = frozenset(n.lower() for n in names) if names is not None else running_names()
    for exe in wanted:
        if exe in pool:
            return exe
    return ""


def annotate_browser_items(items: Sequence, *, label_key: str = "browser") -> int:
    """给一批条目补上占用信息，返回被标记的条目数；只查一次进程表，不在循环里依赖缓存。

    写入 `detail`：`blocking_process`（占用进程名，空串=没跑）；`browser_running` 是 `junk.py` 和
    界面在用的旧字段，并存不覆盖。
    """
    pool = running_names()
    if not pool:
        return 0
    marked = 0
    for item in items:
        detail = getattr(item, "detail", None)
        if not isinstance(detail, dict):
            continue
        label = str(detail.get(label_key) or "")
        exe = browser_running(label, names=pool)
        detail["blocking_process"] = exe
        detail["browser_running"] = bool(exe)
        if exe:
            marked += 1
    return marked
