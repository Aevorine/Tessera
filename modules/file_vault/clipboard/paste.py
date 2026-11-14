""""点击即粘贴"：把内容写回系统剪贴板，并尽力恢复原焦点窗口后发送 Ctrl+V。

Windows 禁止后台进程抢前台（SetForegroundWindow 可能静默失效），此时退回
"内容已在剪贴板，请自行粘贴"，这个降级本身总是正确的。
"""

import time
from typing import Optional

import win32api
import win32clipboard
import win32con
import win32gui

from core.logging import get_logger
from modules.file_vault.clipboard.listener import clipboard_holder, run_clipboard_transaction

logger = get_logger(__name__)

# 点击即粘贴写回剪贴板的等待上限。用户在等结果，1.5 秒内拿不到锁再报「被谁占着」。
WRITE_BUDGET_S = 1.5

# 最近一次写回失败时占着剪贴板的程序（进程名），给 service 拼错误信息用；成功则清空。
last_write_holder: Optional[str] = None

_FOCUS_SETTLE_S = 0.08


def write_text(text: str, html: Optional[str] = None, rtf: Optional[bytes] = None) -> bool:
    """写回纯文本，可附带 HTML/RTF，三种格式一起放上剪贴板，由粘贴目标自己挑最丰富的（RTF 是
    Word 公式/特殊符号还原的关键，见 listener.py::_read_rtf_bytes）。
    走 run_clipboard_transaction：打开成功后 SetClipboardData 仍可能因被抢走抛 1418，
    需整段重来；只重试打开会让点击即粘贴约 2% 概率静默失效。"""

    def _write():
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
        if html:
            html_fmt = win32clipboard.RegisterClipboardFormat("HTML Format")
            win32clipboard.SetClipboardData(html_fmt, html.encode("utf-8"))
        if rtf:
            rtf_fmt = win32clipboard.RegisterClipboardFormat("Rich Text Format")
            win32clipboard.SetClipboardData(rtf_fmt, rtf)
        return True

    # 重试全部用完才失败。函数签名承诺的是 bool，不该让这类外部竞争以异常的形式
    # 一路崩到"点击粘贴"这个功能的调用方那边。
    return _write_with_budget(_write)


def write_image_dib(dib: bytes) -> bool:
    """图片写回。跟 write_text 同样走整段事务重试——理由见那边的长注释。"""

    def _write():
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32clipboard.CF_DIB, dib)
        return True

    return _write_with_budget(_write)


def _write_with_budget(write) -> bool:
    global last_write_holder
    started = time.monotonic()
    try:
        ok = bool(run_clipboard_transaction(write, budget_s=WRITE_BUDGET_S))
        last_write_holder = None
        return ok
    except Exception as exc:  # noqa: BLE001
        last_write_holder = clipboard_holder()
        # 以前这里什么都不记，故障日志只有一句「调用失败」，看不出原因。只记异常类型、错误码与占用方进程名。
        logger.warning(
            "clipboard write failed after %.2fs: %s (winerror=%s) holder=%s",
            time.monotonic() - started, type(exc).__name__,
            getattr(exc, "winerror", None) or (exc.args[0] if exc.args else None), last_write_holder,
        )
        return False


def send_paste_to(hwnd: int) -> bool:
    """尽力而为，失败返回 False 而不抛异常：前台锁限制是预期失败，不是要上报的错误。"""
    try:
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(_FOCUS_SETTLE_S)
        if win32gui.GetForegroundWindow() != hwnd:
            return False
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        win32api.keybd_event(ord("V"), 0, 0, 0)
        win32api.keybd_event(ord("V"), 0, win32con.KEYEVENTF_KEYUP, 0)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
        return True
    except Exception:
        return False
