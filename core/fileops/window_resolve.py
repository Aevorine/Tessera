"""把资源管理器/桌面窗口句柄解析成真实文件系统路径（粘贴目标目录、选中文件）的工具集合。
与钩子接管判定无关，file_clip 与 file_vault 共用。"""

import ctypes
import os
from ctypes import wintypes

from core.logging import get_logger

logger = get_logger(__name__)

user32 = ctypes.WinDLL("user32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)
ole32 = ctypes.WinDLL("ole32", use_last_error=True)

VK_V = 0x56
VK_CONTROL = 0x11
KEYEVENTF_KEYUP = 0x0002
INPUT_KEYBOARD = 1

DESKTOP_CLASSES = {"Progman", "WorkerW"}

ULONG_PTR = ctypes.c_size_t

user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class _INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("ki", _KEYBDINPUT)]

    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U), ("_pad", ctypes.c_byte * 8)]


def _inject_ctrl(vk: int) -> None:
    """注入带 INJECTED 标记的 Ctrl 组合键；低级钩子放行注入事件，故作为回退路径不会递归。"""
    seq = [
        (VK_CONTROL, 0),
        (vk, 0),
        (vk, KEYEVENTF_KEYUP),
        (VK_CONTROL, KEYEVENTF_KEYUP),
    ]
    arr = (_INPUT * len(seq))()
    for i, (vk, flags) in enumerate(seq):
        arr[i].type = INPUT_KEYBOARD
        arr[i].ki = _KEYBDINPUT(vk, 0, flags, 0, 0)
    user32.SendInput(len(seq), arr, ctypes.sizeof(_INPUT))


def _inject_ctrl_v() -> None:
    """重新注入一次 Ctrl+V（带 INJECTED 标记，钩子会放行）。"""
    _inject_ctrl(VK_V)


def inject_ctrl_c() -> None:
    """恢复一次原生 Ctrl+C（用于文件选择无法解析时的安全回退）。"""
    _inject_ctrl(0x43)


def inject_ctrl_x() -> None:
    """恢复一次原生 Ctrl+X（用于文件选择无法解析时的安全回退）。"""
    _inject_ctrl(0x58)


def _class_name(hwnd) -> str:
    if not hwnd:
        return ""
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _desktop_path():
    """真实桌面路径（照顾 OneDrive 重定向，不能拼 USERPROFILE\\Desktop 了事）。"""

    class _GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    folderid_desktop = _GUID(
        0xB4BFCC3A, 0xDB2C, 0x424C,
        (ctypes.c_ubyte * 8)(0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41),
    )
    ppath = ctypes.c_wchar_p()
    if shell32.SHGetKnownFolderPath(
        ctypes.byref(folderid_desktop), 0, None, ctypes.byref(ppath)
    ) == 0:
        try:
            return ppath.value
        finally:
            ole32.CoTaskMemFree(ppath)
    return None


def resolve_target_folder(hwnd, fg_class: str):
    """把资源管理器窗口/桌面解析成一个真实文件夹路径；解析不出返回 None。"""
    if fg_class in DESKTOP_CLASSES:
        return _desktop_path()
    try:
        import pythoncom
        import win32com.client

        pythoncom.CoInitialize()
        try:
            shell = win32com.client.Dispatch("Shell.Application")
            for w in shell.Windows():
                try:
                    if int(w.HWND) != int(hwnd):
                        continue
                    path = w.Document.Folder.Self.Path
                    if path and os.path.isdir(path):
                        return path
                    return None  # 「此电脑」等虚拟位置，没法往里粘贴文件
                except Exception:
                    continue
        finally:
            pythoncom.CoUninitialize()
    except Exception as exc:
        logger.warning("COM 解析窗口路径失败: %s", exc)
    return None


def resolve_selected_items(hwnd):
    """从资源管理器窗口句柄取当前选中的文件/文件夹绝对路径列表；取不到返回 []。"""
    paths = []
    try:
        import pythoncom
        import win32com.client

        pythoncom.CoInitialize()
        try:
            shell = win32com.client.Dispatch("Shell.Application")
            for w in shell.Windows():
                try:
                    if int(w.HWND) != int(hwnd):
                        continue
                    items = w.Document.SelectedItems()
                    for i in range(items.Count):
                        p = items.Item(i).Path
                        if p and os.path.exists(p):
                            paths.append(p)
                    break
                except Exception:
                    continue
        finally:
            pythoncom.CoUninitialize()
    except Exception as exc:
        logger.warning("COM 解析选中项失败: %s", exc)
    return paths
