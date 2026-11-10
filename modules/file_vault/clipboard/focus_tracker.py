"""跟踪最近一个不属于本应用进程树的前台窗口，供"点击即粘贴"在发 Ctrl+V 前恢复焦点。

150ms 轮询前台窗口句柄（一次系统调用，微秒级）；只有句柄变了才判断它属不属于自己。
判断要枚举全系统进程（psutil 的 children），曾经每轮都做，后端空闲时因此常占单核约 10%。
backend_server.py 是 Electron 主进程的子进程，可见窗口在兄弟 renderer 进程里，
所以"属于自己"要按"父进程的任意后代"判断，而不只是自身祖先链。
"""

import threading
from typing import Optional, Set

import psutil
import win32gui
import win32process

_POLL_INTERVAL_S = 0.15


def _collect_own_pids() -> Set[int]:
    pids = {psutil.Process().pid}
    try:
        parent = psutil.Process().parent()
        if parent is not None:
            pids.add(parent.pid)
            for child in parent.children(recursive=True):
                pids.add(child.pid)
    except Exception:
        pass
    return pids


class ForegroundTracker:
    def __init__(self) -> None:
        self._last_external_hwnd: Optional[int] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="clipboard-focus-tracker")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)

    def _run(self) -> None:
        last_hwnd = 0
        while not self._stop.is_set():
            try:
                hwnd = win32gui.GetForegroundWindow()
                # 句柄没变就不用再判：前台窗口不换，归属也不会变。
                if hwnd and hwnd != last_hwnd:
                    last_hwnd = hwnd
                    _, pid = win32process.GetWindowThreadProcessId(hwnd)
                    # 每次切换都重新计算进程家族而不缓存：Electron 的 renderer/GPU 子进程可能重启或新开。
                    if pid not in _collect_own_pids():
                        self._last_external_hwnd = hwnd
            except Exception:
                pass
            self._stop.wait(_POLL_INTERVAL_S)

    def get_last_external_hwnd(self) -> Optional[int]:
        hwnd = self._last_external_hwnd
        if hwnd and win32gui.IsWindow(hwnd):
            return hwnd
        return None
