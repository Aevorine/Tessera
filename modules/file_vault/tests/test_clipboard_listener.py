"""Rich Text Format 捕获/恢复路径的往返测试：listener.py 读、paste.py 写、service.py 串起存储。
需要真实 OS 剪贴板（win32 剪贴板链路没有别的验证办法）。"""

import base64
import sys
from pathlib import Path

import win32clipboard

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.clipboard import listener, paste, service, storage

# 结构合法、与 HTML/纯文本不同的一段 RTF，用来确认字节被原样带过捕获->存储->写回；
# 能否被 Word 解析成公式只能人工验证。
SAMPLE_RTF = rb"{\rtf1\ansi\deff0 {\moMath x^2+y^2=z^2}}"
SAMPLE_HTML = (
    "Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000165\r\n"
    "StartFragment:0000000141\r\nEndFragment:0000000153\r\n"
    "<html><body><!--StartFragment-->x²+y²=z²<!--EndFragment--></body></html>"
)


def _set_clipboard(text, html=None, rtf=None):
    # 测试辅助函数改走与生产代码相同的 run_clipboard_transaction（整段重试）：打开成功后剪贴板
    # 仍可能被别的进程抢走（压测约 2% 抛 1418），原写法会间歇性挂。
    def _op():
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
        if html:
            html_fmt = win32clipboard.RegisterClipboardFormat("HTML Format")
            win32clipboard.SetClipboardData(html_fmt, html.encode("utf-8"))
        if rtf:
            rtf_fmt = win32clipboard.RegisterClipboardFormat("Rich Text Format")
            win32clipboard.SetClipboardData(rtf_fmt, rtf)

    listener.run_clipboard_transaction(_op)


def _read_clipboard_rtf():
    def _op():
        rtf_fmt = win32clipboard.RegisterClipboardFormat("Rich Text Format")
        if not win32clipboard.IsClipboardFormatAvailable(rtf_fmt):
            return None
        return win32clipboard.GetClipboardData(rtf_fmt)

    return listener.run_clipboard_transaction(_op)


def test_read_clipboard_entry_captures_rtf_alongside_html():
    _set_clipboard("x2+y2=z2", html=SAMPLE_HTML, rtf=SAMPLE_RTF)
    entry = listener.read_clipboard_entry()
    assert entry is not None
    assert entry.content_format == "rich"
    assert entry.rtf_bytes == SAMPLE_RTF


def test_read_clipboard_entry_rtf_none_when_html_absent():
    _set_clipboard("plain text only, no html/rtf sibling formats on the clipboard")
    entry = listener.read_clipboard_entry()
    assert entry is not None
    assert entry.content_format == "plain"
    assert entry.rtf_bytes is None


def test_write_text_writes_rtf_back_to_clipboard():
    ok = paste.write_text("x2+y2=z2", html=SAMPLE_HTML, rtf=SAMPLE_RTF)
    assert ok
    assert _read_clipboard_rtf() == SAMPLE_RTF


def test_write_text_without_rtf_leaves_no_stale_rtf_on_clipboard():
    _set_clipboard("old entry with rtf", rtf=SAMPLE_RTF)
    ok = paste.write_text("new entry, no rtf this time", html=None, rtf=None)
    assert ok
    assert _read_clipboard_rtf() is None


def test_paste_entry_restores_rtf_via_service(tmp_path):
    svc = service.ClipboardService(tmp_path, crypto.generate_key())
    try:
        rtf_b64 = base64.b64encode(SAMPLE_RTF).decode("ascii")
        entry_id = storage.insert_entry(
            svc.conn,
            content_type="text",
            content_format="rich",
            content_text=SAMPLE_HTML,
            content_rtf_b64=rtf_b64,
        )

        result = svc.paste_entry(entry_id, auto_paste=False)

        assert result["ok"]
        assert _read_clipboard_rtf() == SAMPLE_RTF
    finally:
        svc.conn.close()


def test_paste_entry_without_stored_rtf_still_pastes_text(tmp_path):
    svc = service.ClipboardService(tmp_path, crypto.generate_key())
    try:
        entry_id = storage.insert_entry(
            svc.conn,
            content_type="text",
            content_format="plain",
            content_text="no rtf here",
        )

        result = svc.paste_entry(entry_id, auto_paste=False)

        assert result["ok"]
        assert _read_clipboard_rtf() is None
    finally:
        svc.conn.close()
