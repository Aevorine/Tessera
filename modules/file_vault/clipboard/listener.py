"""Windows 剪贴板监听器。

用 AddClipboardFormatListener 而非旧的 SetClipboardViewer 链：链式 API 在别的工具（如 Ditto）
忘记转发消息时会静默失效，而前者每个监听者独立收到 WM_CLIPBOARDUPDATE。
pywin32 没封装这两个调用，走 ctypes；窗口和消息循环仍用 win32gui。
"""

import ctypes
import hashlib
import io
import re
import struct
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import psutil
import win32api
import win32clipboard

# 只用 html_to_plain_text（纯字符串处理，不碰数据库）：少数程序复制富文本时不放 CF_UNICODETEXT，
# 需从 HTML 抽纯文本；放在 storage 是因为老数据迁移要用同一份实现。
from modules.file_vault.clipboard import storage
import win32con
import win32gui
import win32process
from PIL import Image

from core.logging import get_logger

logger = get_logger(__name__)

WM_CLIPBOARDUPDATE = 0x031D
HWND_MESSAGE = -3

_user32 = ctypes.windll.user32

# CF_HTML 头部：StartFragment/EndFragment 是 UTF-8 字节偏移，指向含 <!--StartFragment--> 标记的
# 位置，
# 不是正文开头；取该区间并跳过标记和头部。
_CF_HTML_START_RE = re.compile(r"StartFragment:(\d+)")
_CF_HTML_END_RE = re.compile(r"EndFragment:(\d+)")
_CF_HTML_FRAGMENT_BOUNDARY_RE = re.compile(r"<!--(?:Start|End)Fragment-->")


def parse_cf_html(raw_text: str) -> str:
    """从 CF_HTML 原始字符串提取正文片段，剥掉 Version/StartHTML/EndHTML/StartFragment/EndFragment/
    SourceURL 等头。偏移是 UTF-8 字节位置而非字符索引，须先 .encode('utf-8') 切片再解码。"""
    start_match = _CF_HTML_START_RE.search(raw_text)
    end_match = _CF_HTML_END_RE.search(raw_text)
    if not start_match or not end_match:
        # 不标准的 CF_HTML（缺少定位标记）——返回原始文本，不做破坏性的切分
        return raw_text
    start = int(start_match.group(1))
    end = int(end_match.group(1))
    encoded = raw_text.encode("utf-8")
    if start >= end or start < 0 or end > len(encoded):
        return raw_text
    body = encoded[start:end].decode("utf-8", errors="replace")
    # 进一步剥掉 <!--StartFragment--> 和 <!--EndFragment--> 注释标记本身
    body = _CF_HTML_FRAGMENT_BOUNDARY_RE.sub("", body)
    return body.strip()

# 复制操作有时会被别的程序（截图工具、Office 等）短暂占用剪贴板，读取会失败——
# 按用户方案 5.1 的要求：间隔 50ms 重试 3 次，而不是直接丢这条记录。
_OPEN_RETRY_COUNT = 3
_OPEN_RETRY_INTERVAL_S = 0.05

# 程序自己把内容写回剪贴板（例如"点击即粘贴"）之后，短时间内会再收到一次
# WM_CLIPBOARDUPDATE——这是我们自己触发的，不应该被当成新复制记录一遍。
_SELF_WRITE_SUPPRESS_WINDOW_S = 0.3


def _content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class ClipboardEntry:
    content_type: str  # 'image' | 'text' | ...(细分分类留给 classifier.py，这里只分 image/text/rich_text)
    content_format: Optional[str]  # 'plain' | 'rich'
    text: Optional[str]
    image_dib_bytes: Optional[bytes]
    raw_dib_len: int
    source_app: Optional[str]
    # "Rich Text Format" 原始字节，仅来源程序提供该格式时有值（Word 公式/特殊符号真正依赖它，
    # HTML/纯文本只是降级近似）；仅 content_format=='rich' 时有意义，'plain' 恒为 None。见 paste.py:
    # :write_text 的 rtf。
    rtf_bytes: Optional[bytes] = None
    # 富文本条目的 HTML 源，与 text 分开（text 永远是给人看的那段字）。
    # 否则粘贴到纯文本场所会得到满是 style= 的源码，搜索也会匹配到 CSS 属性名。仅 content_format=='r
    # ich' 时有值。
    html: Optional[str] = None


class _SelfWriteTracker:
    """自己写剪贴板前先调 mark(content)；is_self_write(content) 告诉监听器刚看到的变化是否出自自己。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hash: Optional[str] = None
        self._marked_at: float = 0.0

    def mark(self, data: bytes) -> None:
        with self._lock:
            self._hash = _content_hash(data)
            self._marked_at = time.monotonic()

    def is_self_write(self, data: bytes) -> bool:
        with self._lock:
            if self._hash is None:
                return False
            if time.monotonic() - self._marked_at > _SELF_WRITE_SUPPRESS_WINDOW_S:
                return False
            return _content_hash(data) == self._hash


def _get_source_app() -> Optional[str]:
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        if not pid:
            return None
        return psutil.Process(pid).name()
    except Exception:
        return None


def dib_to_png_bytes(dib: bytes) -> bytes:
    """CF_DIB 缺 .bmp 需要的 14 字节 BITMAPFILEHEADER，这里补上让 Pillow 能解码；
    BI_BITFIELDS（16/32 位截图）在头与像素间多 3 个 DWORD 掩码，需按 bfOffBits 跳过。"""
    header_size = struct.unpack_from("<I", dib, 0)[0]
    bit_count = struct.unpack_from("<H", dib, 14)[0] if header_size >= 40 else 0
    compression = struct.unpack_from("<I", dib, 16)[0] if header_size >= 40 else 0
    colors_used = struct.unpack_from("<I", dib, 32)[0] if header_size >= 40 else 0

    if bit_count <= 8:
        palette_colors = colors_used if colors_used else (1 << bit_count)
        extra = palette_colors * 4
    elif compression == 3:  # BI_BITFIELDS
        extra = 12
    else:
        extra = 0

    offset = 14 + header_size + extra
    file_header = struct.pack("<2sIHHI", b"BM", 14 + len(dib), 0, 0, offset)
    img = Image.open(io.BytesIO(file_header + dib))
    img.load()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def png_bytes_to_dib(png_bytes: bytes) -> bytes:
    """dib_to_png_bytes 的逆操作，供"点击即粘贴"把图写回 CF_DIB：PIL 只写整个 .bmp，CF_DIB 只要 DIB
    部分。"""
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="BMP")
    return buf.getvalue()[14:]


def open_clipboard_with_retry(hwnd: Optional[int] = None) -> bool:
    for attempt in range(_OPEN_RETRY_COUNT):
        try:
            win32clipboard.OpenClipboard(hwnd)
            return True
        except Exception:
            if attempt == _OPEN_RETRY_COUNT - 1:
                return False
            time.sleep(_OPEN_RETRY_INTERVAL_S)
    return False


def run_clipboard_transaction(operation, hwnd: Optional[int] = None):
    """把"打开 -> 操作 -> 关闭"整段作为一次事务重试，而非只重试打开。

    实测：open_clipboard_with_retry() 返回 True 后，Get/SetClipboardData 仍有约 2% 概率抛 1418
    （线程没有打开的剪贴板），因为别的进程（剪贴板管理器、Win+V、输入法、安全软件）可能在间隙抢走它。
    读、写两条路径共用这一份，否则写回只 return False 会让"点击即粘贴"在竞争下静默失败。
    `operation` 在剪贴板已打开时调用，返回值透传；全部尝试失败则抛最后一次异常，由调用方决定降级或上
    报。
    """
    last_exc = None
    for attempt in range(_OPEN_RETRY_COUNT):
        if not open_clipboard_with_retry(hwnd):
            last_exc = OSError("failed to open clipboard")
        else:
            try:
                return operation()
            except Exception as exc:  # noqa: BLE001 - 见下方 finally 的说明
                last_exc = exc
            finally:
                try:
                    win32clipboard.CloseClipboard()
                except Exception:
                    # 临界区已经被别人抢走时这里必然拿不到。关不上不该盖过上面
                    # 已经算出的结果，也不该在异常路径里再抛一次把重试顶掉。
                    pass
        if attempt < _OPEN_RETRY_COUNT - 1:
            time.sleep(_OPEN_RETRY_INTERVAL_S)
    raise last_exc if last_exc is not None else OSError("clipboard transaction failed")


def _read_rtf_bytes() -> Optional[bytes]:
    """RTF 是 Word/WPS 承载公式、特殊符号、复杂格式的真格式（HTML/纯文本只是降级近似）。
    仅来源程序提供时才有值，不影响 content_format 的判定（那只看 HTML）。"""
    rtf_fmt = win32clipboard.RegisterClipboardFormat("Rich Text Format")
    if not win32clipboard.IsClipboardFormatAvailable(rtf_fmt):
        return None
    raw = win32clipboard.GetClipboardData(rtf_fmt)
    if raw is None:
        return None
    return raw if isinstance(raw, bytes) else raw.encode("ascii", errors="ignore")


def _read_clipboard_entry_once() -> Optional[ClipboardEntry]:
    if not open_clipboard_with_retry():
        raise OSError("failed to open clipboard")
    try:
        source_app = _get_source_app()
        if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_DIB):
            dib = win32clipboard.GetClipboardData(win32clipboard.CF_DIB)
            return ClipboardEntry(
                content_type="image",
                content_format=None,
                text=None,
                image_dib_bytes=None if len(dib) == 0 else dib,  # 大小判断交给调用方(storage 阈值)，这里先把原始 DIB 传出去
                raw_dib_len=len(dib),
                source_app=source_app,
            )
        html_fmt = win32clipboard.RegisterClipboardFormat("HTML Format")
        if win32clipboard.IsClipboardFormatAvailable(html_fmt):
            raw = win32clipboard.GetClipboardData(html_fmt)
            html_text = raw.decode("utf-8", errors="ignore") if isinstance(raw, bytes) else raw
            # 修复：CF_HTML 原始数据带 Version/StartHTML/EndFragment 等头，不裁剪会把头存进历史、界面显示成
            # 乱码。
            html_text = parse_cf_html(html_text)
            # 同时读纯文本：复制富文本时 Windows 几乎总会附带 CF_UNICODETEXT（给人看的那段字）；
            # 少数程序只放 HTML 时才从 HTML 抽取。
            plain = None
            if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_UNICODETEXT):
                try:
                    plain = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
                except Exception:
                    plain = None
            if not plain:
                plain = storage.html_to_plain_text(html_text)
            return ClipboardEntry(
                content_type="text",
                content_format="rich",
                text=plain,
                html=html_text,
                image_dib_bytes=None,
                raw_dib_len=0,
                source_app=source_app,
                rtf_bytes=_read_rtf_bytes(),
            )
        if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_UNICODETEXT):
            text = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
            return ClipboardEntry(
                content_type="text",
                content_format="plain",
                text=text,
                image_dib_bytes=None,
                raw_dib_len=0,
                source_app=source_app,
            )
        return None  # 其他格式（比如 file_clip 用的 CF_HDROP 文件列表）不属于这个功能的记录范围
    finally:
        # CloseClipboard 在高频连续复制下可能失败（剪贴板被后一次复制抢走），必须吞掉：
        # finally 里抛异常会盖掉 try 里已成立的 return，白白丢一条读成功的记录。
        try:
            win32clipboard.CloseClipboard()
        except Exception:
            pass


def read_clipboard_entry() -> Optional[ClipboardEntry]:
    """按 图片 > 富文本/HTML > 纯文本 取一种主格式，一次变化只产生一条记录。
    打开成功后、读到数据前内容也可能被后一次复制抢走（GetClipboardData 失败），
    与"被占用"同类，应整个打开+读取序列重来，而非当作这次变化没有内容。"""
    last_exc = None
    for attempt in range(_OPEN_RETRY_COUNT):
        try:
            return _read_clipboard_entry_once()
        except Exception as exc:
            last_exc = exc
            if attempt < _OPEN_RETRY_COUNT - 1:
                time.sleep(_OPEN_RETRY_INTERVAL_S)
    logger.warning("giving up reading clipboard after %d attempts: %s", _OPEN_RETRY_COUNT, last_exc)
    return None


class ClipboardListener:
    """在独立线程跑隐藏的 message-only 窗口和消息循环；`on_change(entry)` 在该线程而非调用方线程回调，
    触碰共享状态（如别处打开的 DB 连接）的调用方要自行处理。"""

    def __init__(self, on_change: Callable[[ClipboardEntry], None]):
        self._on_change = on_change
        self._thread: Optional[threading.Thread] = None
        self._hwnd: Optional[int] = None
        self._ready = threading.Event()
        self.self_write_tracker = _SelfWriteTracker()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="clipboard-listener")
        self._thread.start()
        self._ready.wait(timeout=5)

    def stop(self) -> None:
        if self._hwnd:
            win32gui.PostMessage(self._hwnd, win32con.WM_CLOSE, 0, 0)
        if self._thread:
            self._thread.join(timeout=2)

    def _wnd_proc(self, hwnd, msg, wparam, lparam):
        if msg == WM_CLIPBOARDUPDATE:
            self._handle_clipboard_update()
            return 0
        if msg == win32con.WM_DESTROY:
            _user32.RemoveClipboardFormatListener(hwnd)
            win32gui.PostQuitMessage(0)
            return 0
        return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)

    def _handle_clipboard_update(self) -> None:
        entry = read_clipboard_entry()
        if entry is None:
            return
        probe = entry.image_dib_bytes if entry.image_dib_bytes is not None else (entry.text or "").encode("utf-8", errors="ignore")
        if self.self_write_tracker.is_self_write(probe):
            return
        self._on_change(entry)

    def _run(self) -> None:
        wc = win32gui.WNDCLASS()
        wc.lpszClassName = f"Ideal1ClipboardListener_{id(self)}"
        wc.lpfnWndProc = self._wnd_proc
        class_atom = win32gui.RegisterClass(wc)

        hwnd = win32gui.CreateWindow(
            class_atom, wc.lpszClassName, 0, 0, 0, 0, 0, HWND_MESSAGE, 0, win32api.GetModuleHandle(None), None
        )
        self._hwnd = hwnd
        if not _user32.AddClipboardFormatListener(hwnd):
            raise OSError("AddClipboardFormatListener failed: " + str(ctypes.get_last_error()))

        self._ready.set()
        win32gui.PumpMessages()
