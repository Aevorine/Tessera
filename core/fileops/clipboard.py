"""Windows 剪贴板文件列表读写（纯 ctypes），与资源管理器双向互通。

读写 CF_HDROP（DROPFILES + 双空结尾宽字符路径）和 "Preferred DropEffect"（COPY=5 / MOVE=2）。
供 file_clip 与 file_vault 共用，故放在 core/。注意：不是 file_vault/clipboard/ 的图片/文字历史。
"""

import ctypes
import time
from ctypes import wintypes
from typing import Callable, List, Optional, Tuple, TypeVar

from core.logging import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)

CF_HDROP = 15
GHND = 0x0042  # GMEM_MOVEABLE | GMEM_ZEROINIT

DROPEFFECT_COPY = 1
DROPEFFECT_MOVE = 2
DROPEFFECT_LINK = 4

_SIZE_T = ctypes.c_size_t

user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.restype = wintypes.BOOL
user32.EmptyClipboard.restype = wintypes.BOOL
user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
user32.RegisterClipboardFormatW.restype = wintypes.UINT

kernel32.GlobalAlloc.argtypes = [wintypes.UINT, _SIZE_T]
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalLock.restype = wintypes.LPVOID
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalUnlock.restype = wintypes.BOOL
kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalFree.restype = wintypes.HGLOBAL
kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalSize.restype = _SIZE_T

shell32.DragQueryFileW.argtypes = [
    wintypes.HANDLE,
    wintypes.UINT,
    wintypes.LPWSTR,
    wintypes.UINT,
]
shell32.DragQueryFileW.restype = wintypes.UINT


class ClipboardError(RuntimeError):
    pass


class _DROPFILES(ctypes.Structure):
    _fields_ = [
        ("pFiles", wintypes.DWORD),
        ("pt", wintypes.POINT),
        ("fNC", wintypes.BOOL),
        ("fWide", wintypes.BOOL),
    ]


def _drop_effect_format() -> int:
    fmt = user32.RegisterClipboardFormatW("Preferred DropEffect")
    if not fmt:
        raise ClipboardError("RegisterClipboardFormatW failed")
    return fmt


def _open_clipboard(retries: int = 20, delay: float = 0.05) -> None:
    """打开剪贴板。别的程序可能正占着它，所以带重试。"""
    for attempt in range(retries):
        if user32.OpenClipboard(None):
            return
        time.sleep(delay)
    raise ClipboardError(
        f"OpenClipboard failed after {retries} retries "
        f"(err={ctypes.get_last_error()}) —— 剪贴板被其他程序占用"
    )


# file_vault 常驻的剪贴板历史监听器（或 Win+V 等管理器）可能在 OpenClipboard 成功后
# 抢先 EmptyClipboard，导致 ERROR_CLIPBOARD_NOT_OPEN(1418)。_open_clipboard 只重试
# "打开"，防不住这种竞争，所以整次尝试（开→操作→关）一起重试。
_CLIPBOARD_RETRY_ATTEMPTS = 40
_CLIPBOARD_RETRY_DELAY = 0.05


def _with_clipboard_retry(attempt_fn: Callable[[], T]) -> T:
    last_exc: Optional[ClipboardError] = None
    for _ in range(_CLIPBOARD_RETRY_ATTEMPTS):
        try:
            return attempt_fn()
        except ClipboardError as exc:
            last_exc = exc
            time.sleep(_CLIPBOARD_RETRY_DELAY)
    raise last_exc


def get_file_drop() -> Optional[Tuple[List[str], bool]]:
    """读取剪贴板上的文件列表，返回 (paths, is_cut)；不是文件时返回 None。"""
    return _with_clipboard_retry(_get_file_drop_once)


def _get_file_drop_once() -> Optional[Tuple[List[str], bool]]:
    _open_clipboard()
    try:
        if not user32.IsClipboardFormatAvailable(CF_HDROP):
            return None
        hdrop = user32.GetClipboardData(CF_HDROP)
        if not hdrop:
            return None
        count = shell32.DragQueryFileW(hdrop, 0xFFFFFFFF, None, 0)
        paths = []
        for i in range(count):
            length = shell32.DragQueryFileW(hdrop, i, None, 0)
            buf = ctypes.create_unicode_buffer(length + 1)
            shell32.DragQueryFileW(hdrop, i, buf, length + 1)
            paths.append(buf.value)

        effect = DROPEFFECT_COPY | DROPEFFECT_LINK  # Explorer 复制时的默认值 5
        fmt = _drop_effect_format()
        if user32.IsClipboardFormatAvailable(fmt):
            handle = user32.GetClipboardData(fmt)
            if handle:
                ptr = kernel32.GlobalLock(handle)
                if ptr:
                    try:
                        effect = ctypes.cast(
                            ptr, ctypes.POINTER(wintypes.DWORD)
                        ).contents.value
                    finally:
                        kernel32.GlobalUnlock(handle)
        # 剪切时 Explorer 写 MOVE(2)；复制时写 COPY|LINK(5)。
        # 只有明确"允许移动且不允许复制"才当作剪切，含糊时按复制处理（更安全）。
        is_cut = bool(effect & DROPEFFECT_MOVE) and not (effect & DROPEFFECT_COPY)
        return paths, is_cut
    finally:
        user32.CloseClipboard()


def set_file_drop(paths: List[str], move: bool = False) -> None:
    """把文件列表放上剪贴板（move=True 为剪切），资源管理器可直接 Ctrl+V。"""
    if not paths:
        raise ClipboardError("empty path list")
    _with_clipboard_retry(lambda: _set_file_drop_once(paths, move))


def _set_file_drop_once(paths: List[str], move: bool) -> None:
    # CF_HDROP: DROPFILES 头 + 每条路径以 \0 结尾 + 整体再补一个 \0
    joined = "\0".join(paths) + "\0\0"
    encoded = joined.encode("utf-16-le")
    header_size = ctypes.sizeof(_DROPFILES)
    total = header_size + len(encoded)

    h_drop = kernel32.GlobalAlloc(GHND, total)
    if not h_drop:
        raise ClipboardError("GlobalAlloc failed for CF_HDROP")
    ptr = kernel32.GlobalLock(h_drop)
    if not ptr:
        kernel32.GlobalFree(h_drop)
        raise ClipboardError("GlobalLock failed for CF_HDROP")
    try:
        dropfiles = _DROPFILES.from_address(ptr)
        dropfiles.pFiles = header_size
        dropfiles.fNC = 0
        dropfiles.fWide = 1
        ctypes.memmove(ptr + header_size, encoded, len(encoded))
    finally:
        kernel32.GlobalUnlock(h_drop)

    # Preferred DropEffect: 一个 DWORD
    effect = DROPEFFECT_MOVE if move else (DROPEFFECT_COPY | DROPEFFECT_LINK)
    h_effect = kernel32.GlobalAlloc(GHND, ctypes.sizeof(wintypes.DWORD))
    if not h_effect:
        kernel32.GlobalFree(h_drop)
        raise ClipboardError("GlobalAlloc failed for DropEffect")
    ptr2 = kernel32.GlobalLock(h_effect)
    if not ptr2:
        kernel32.GlobalFree(h_drop)
        kernel32.GlobalFree(h_effect)
        raise ClipboardError("GlobalLock failed for DropEffect")
    try:
        ctypes.cast(ptr2, ctypes.POINTER(wintypes.DWORD)).contents.value = effect
    finally:
        kernel32.GlobalUnlock(h_effect)

    _open_clipboard()
    owned_by_clipboard = False
    try:
        if not user32.EmptyClipboard():
            raise ClipboardError(f"EmptyClipboard failed (err={ctypes.get_last_error()})")
        if not user32.SetClipboardData(CF_HDROP, h_drop):
            raise ClipboardError(f"SetClipboardData(CF_HDROP) failed (err={ctypes.get_last_error()})")
        owned_by_clipboard = True  # 从这里起 h_drop 归系统所有，不能再 free
        if not user32.SetClipboardData(_drop_effect_format(), h_effect):
            kernel32.GlobalFree(h_effect)
            raise ClipboardError(f"SetClipboardData(DropEffect) failed (err={ctypes.get_last_error()})")
    except Exception:
        if not owned_by_clipboard:
            kernel32.GlobalFree(h_drop)
            kernel32.GlobalFree(h_effect)
        raise
    finally:
        user32.CloseClipboard()
    logger.info("Clipboard set: %d item(s), %s", len(paths), "cut" if move else "copy")


def clear_clipboard() -> None:
    """清空剪贴板（剪切的文件粘贴完成后调用，和资源管理器行为一致）。"""
    _with_clipboard_retry(_clear_clipboard_once)


def _clear_clipboard_once() -> None:
    _open_clipboard()
    try:
        if not user32.EmptyClipboard():
            raise ClipboardError(f"EmptyClipboard failed (err={ctypes.get_last_error()})")
    finally:
        user32.CloseClipboard()
