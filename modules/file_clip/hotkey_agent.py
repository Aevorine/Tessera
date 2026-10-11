#!/usr/bin/env python
"""file_clip 后台热键代理：资源管理器里按 Ctrl+V 由高速引擎接管粘贴。

只在同时满足时接管，否则放行原始按键：前台是资源管理器/桌面；剪贴板是文件（CF_HDROP）；
焦点在文件列表区（重命名框/地址栏放行）。目标目录经 Shell.Application COM 解析，
解析不出就重新注入 Ctrl+V（带 LLKHF_INJECTED，钩子放行不死循环）；回调内任何异常都放行，
宁可不加速也不弄坏系统粘贴。--dry-run 只打印"本应接管"的时机，不吞键不粘贴。
共享函数已提升到 core.fileops.window_resolve，这里做薄重导出。
"""

import argparse
import ctypes
import os
import queue
import subprocess
import sys
import threading
from ctypes import wintypes
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops.window_resolve import (  # noqa: E402
    _class_name,
    _desktop_path,
    _inject_ctrl_v,
    resolve_selected_items,
    resolve_target_folder,
)
from core.logging import get_logger  # noqa: E402

logger = get_logger(__name__)

_CLI = str(Path(__file__).with_name("cli.py"))
_pyw = Path(sys.executable).with_name("pythonw.exe")
_PYTHON_GUI = str(_pyw) if _pyw.exists() else sys.executable

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WH_KEYBOARD_LL = 13
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
VK_V = 0x56
VK_CONTROL = 0x11
VK_SHIFT = 0x10
VK_MENU = 0x12  # Alt
VK_LWIN = 0x5B
VK_RWIN = 0x5C
LLKHF_INJECTED = 0x10
CF_HDROP = 15
PM_REMOVE = 0x0001
QS_ALLINPUT = 0x04FF

EXPLORER_CLASSES = {"CabinetWClass", "ExploreWClass"}
DESKTOP_CLASSES = {"Progman", "WorkerW"}
FOCUS_OK_CLASSES = {"DirectUIHWND", "SysListView32"}

ULONG_PTR = ctypes.c_size_t
LRESULT = ctypes.c_ssize_t

HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
user32.UnhookWindowsHookEx.restype = wintypes.BOOL
user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
user32.CallNextHookEx.restype = LRESULT
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE


class _KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class _GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("hwndActive", wintypes.HWND),
        ("hwndFocus", wintypes.HWND),
        ("hwndCapture", wintypes.HWND),
        ("hwndMenuOwner", wintypes.HWND),
        ("hwndMoveSize", wintypes.HWND),
        ("hwndCaret", wintypes.HWND),
        ("rcCaret", wintypes.RECT),
    ]


def _focus_class_of(hwnd) -> str:
    tid = user32.GetWindowThreadProcessId(hwnd, None)
    info = _GUITHREADINFO()
    info.cbSize = ctypes.sizeof(_GUITHREADINFO)
    if not user32.GetGUIThreadInfo(tid, ctypes.byref(info)):
        return ""
    return _class_name(info.hwndFocus)


def _key_down(vk: int) -> bool:
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


def decide(
    vk: int,
    injected: bool,
    ctrl: bool,
    shift: bool,
    alt_or_win: bool,
    fg_class: str,
    has_files: bool,
    focus_class: str,
) -> bool:
    """纯逻辑判定：这次按键是否应该由我们接管。单元测试覆盖此函数。"""
    if vk != VK_V or injected:
        return False
    if not ctrl or shift or alt_or_win:  # 只接管「纯 Ctrl+V」
        return False
    if fg_class not in EXPLORER_CLASSES and fg_class not in DESKTOP_CLASSES:
        return False
    if not has_files:
        return False
    if focus_class not in FOCUS_OK_CLASSES:  # 重命名框/地址栏等编辑区 → 放行
        return False
    return True


class HotkeyAgent:
    def __init__(self, on_conflict: str = "rename", threads=None, dry_run: bool = False):
        self.on_conflict = on_conflict
        self.threads = threads
        self.dry_run = dry_run
        self.hook = None
        self._proc_ref = None  # 防止回调被垃圾回收
        self.jobs: "queue.Queue" = queue.Queue(maxsize=4)
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self._worker_loop, daemon=True)

    # ---- 钩子回调：必须快、必须绝不抛异常 ----

    def _hook_proc(self, n_code, w_param, l_param):
        try:
            if n_code == 0 and w_param in (WM_KEYDOWN, WM_SYSKEYDOWN):
                kb = ctypes.cast(l_param, ctypes.POINTER(_KBDLLHOOKSTRUCT)).contents
                if kb.vkCode == VK_V:
                    hwnd = user32.GetForegroundWindow()
                    fg_class = _class_name(hwnd)
                    should = decide(
                        vk=kb.vkCode,
                        injected=bool(kb.flags & LLKHF_INJECTED),
                        ctrl=_key_down(VK_CONTROL),
                        shift=_key_down(VK_SHIFT),
                        alt_or_win=bool(kb.flags & 0x20)
                        or _key_down(VK_MENU)
                        or _key_down(VK_LWIN)
                        or _key_down(VK_RWIN),
                        fg_class=fg_class,
                        has_files=bool(user32.IsClipboardFormatAvailable(CF_HDROP)),
                        focus_class=_focus_class_of(hwnd),
                    )
                    if should:
                        if self.dry_run:
                            print(f"[dry-run] 本应接管这次 Ctrl+V（窗口类 {fg_class}），已放行")
                        else:
                            try:
                                self.jobs.put_nowait((hwnd, fg_class))
                                return 1  # 吞掉按键，由 worker 接管
                            except queue.Full:
                                print("任务排队已满，这次 Ctrl+V 交回系统处理")
        except Exception as exc:  # 钩子里绝不让异常外逸
            logger.error("hook error (已放行按键): %s", exc)
        return user32.CallNextHookEx(None, n_code, w_param, l_param)

    # ---- 粘贴工人 ----

    def _worker_loop(self):
        while not self.stop_event.is_set():
            try:
                hwnd, fg_class = self.jobs.get(timeout=0.3)
            except queue.Empty:
                continue
            try:
                self._do_paste(hwnd, fg_class)
            except Exception as exc:
                logger.error("粘贴任务失败: %s", exc)
                print(f"粘贴失败：{exc}")

    def _do_paste(self, hwnd, fg_class):
        target = resolve_target_folder(hwnd, fg_class)
        if not target:
            print("无法确定目标文件夹（可能是「此电脑」等虚拟位置），交回系统正常粘贴")
            _inject_ctrl_v()
            return
        # 粘贴交给独立 GUI 子进程：进度小窗实时显示速度，代理本体保持轻量，
        # 子进程崩了也不影响钩子（cli 会自己读剪贴板并处理剪切语义）。
        print(f"\n>>> 粘贴 → {target}（进度小窗已弹出）")
        cmd = [
            _PYTHON_GUI, "-X", "utf8", _CLI, "paste", target,
            "--gui", "--on-conflict", self.on_conflict,
        ]
        if self.threads:
            cmd += ["--threads", str(self.threads)]
        rc = subprocess.run(cmd).returncode
        print(f">>> {'完成' if rc == 0 else f'有失败（返回码 {rc}），详见小窗'}。继续待命（Ctrl+C 退出）")

    # ---- 生命周期 ----

    def start(self):
        self._proc_ref = HOOKPROC(self._hook_proc)
        self.hook = user32.SetWindowsHookExW(
            WH_KEYBOARD_LL, self._proc_ref, kernel32.GetModuleHandleW(None), 0
        )
        if not self.hook:
            raise OSError(f"安装键盘钩子失败 (err={ctypes.get_last_error()})")
        self.worker.start()
        logger.info("hotkey agent started (dry_run=%s)", self.dry_run)

    def stop(self):
        self.stop_event.set()
        if self.hook:
            user32.UnhookWindowsHookEx(self.hook)
            self.hook = None
        if self.worker.is_alive():
            self.worker.join(timeout=2)
        logger.info("hotkey agent stopped")

    def pump(self, duration: float = None):
        """消息循环。duration=None 一直跑到 Ctrl+C；给秒数则跑够即返回（测试用）。"""
        import time

        msg = wintypes.MSG()
        deadline = time.monotonic() + duration if duration else None
        try:
            while True:
                if deadline and time.monotonic() >= deadline:
                    return
                user32.MsgWaitForMultipleObjectsEx(0, None, 200, QS_ALLINPUT, 0x4)
                while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
        except KeyboardInterrupt:
            pass


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="file_clip 后台热键代理（Ctrl+V 高速接管）")
    parser.add_argument("--on-conflict", choices=["rename", "skip", "overwrite"], default="rename")
    parser.add_argument("--threads", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true", help="只观察不接管（验证用）")
    args = parser.parse_args(argv)

    agent = HotkeyAgent(args.on_conflict, args.threads, args.dry_run)
    agent.start()
    mode = "观察模式（不接管）" if args.dry_run else "已就绪"
    print(f"file_clip 热键代理{mode}：在资源管理器/桌面按 Ctrl+V 即高速粘贴。")
    print(f"重名策略：{args.on_conflict}。退出：在本窗口按 Ctrl+C。")
    try:
        agent.pump()
    finally:
        agent.stop()
        print("已退出，系统粘贴行为恢复原样。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
