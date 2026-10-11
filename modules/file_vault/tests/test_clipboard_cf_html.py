"""listener.py::parse_cf_html（剥 CF_HTML 头部）的纯函数测试，不需要真实剪贴板。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.clipboard import listener


def _build_cf_html(fragment: str, prefix: str = "<html><body>", suffix: str = "</body></html>") -> str:
    """构造自洽的 CF_HTML：StartFragment/EndFragment 偏移按 UTF-8 字节长度算出，不手工数。"""
    marker_start = "<!--StartFragment-->"
    marker_end = "<!--EndFragment-->"
    body = f"{prefix}{marker_start}{fragment}{marker_end}{suffix}"
    header_tmpl = (
        "Version:0.9\r\nStartHTML:{sh:010d}\r\nEndHTML:{eh:010d}\r\n"
        "StartFragment:{sf:010d}\r\nEndFragment:{ef:010d}\r\n"
    )
    header_len = len(header_tmpl.format(sh=0, eh=0, sf=0, ef=0).encode("utf-8"))
    start_html = header_len
    end_html = header_len + len(body.encode("utf-8"))
    start_frag = header_len + len((prefix + marker_start).encode("utf-8"))
    end_frag = start_frag + len(fragment.encode("utf-8"))
    header = header_tmpl.format(sh=start_html, eh=end_html, sf=start_frag, ef=end_frag)
    return header + body


def test_parse_cf_html_extracts_fragment_and_strips_wrapper_header():
    raw = _build_cf_html("x²+y²=z²")

    result = listener.parse_cf_html(raw)

    assert result == "x²+y²=z²"
    # 回归原始 bug：修复前存进历史/显示出来的是带 Version/StartHTML 等包装头
    # 的原始载荷本身，而不是正文。
    assert "Version:0.9" not in result
    assert "StartFragment" not in result


def test_parse_cf_html_handles_multibyte_utf8_fragment_correctly():
    # StartFragment/EndFragment 是 UTF-8 字节偏移，不是字符索引——中文在
    # UTF-8 下每字符 3 字节，如果实现错误地按字符切片，这段内容会被截断/错位。
    fragment = "你好，世界！这是一段中文正文。"
    raw = _build_cf_html(fragment)
    assert listener.parse_cf_html(raw) == fragment


def test_parse_cf_html_handles_mixed_ascii_and_multibyte_fragment():
    fragment = "hello 世界 mixed 内容 test"
    raw = _build_cf_html(fragment)
    assert listener.parse_cf_html(raw) == fragment


def test_parse_cf_html_falls_back_to_original_when_markers_missing():
    raw = "not a CF_HTML payload at all, just plain html-ish text"
    assert listener.parse_cf_html(raw) == raw


def test_parse_cf_html_falls_back_when_start_after_end():
    raw = "Version:0.9\r\nStartFragment:9999\r\nEndFragment:5\r\n<html></html>"
    assert listener.parse_cf_html(raw) == raw


def test_parse_cf_html_falls_back_when_end_exceeds_string_length():
    raw = "Version:0.9\r\nStartFragment:0\r\nEndFragment:999999\r\n<html></html>"
    assert listener.parse_cf_html(raw) == raw


def test_parse_cf_html_falls_back_on_negative_or_equal_offsets():
    raw = "Version:0.9\r\nStartFragment:10\r\nEndFragment:10\r\n<html></html>"
    assert listener.parse_cf_html(raw) == raw


def test_parse_cf_html_empty_fragment_falls_back_to_raw_text():
    # 空 fragment 意味着 start == end，命中 "start >= end" 这条安全兜底
    # （跟"标记缺失"走同一条回退路径），不会返回空字符串。
    raw = _build_cf_html("")
    assert listener.parse_cf_html(raw) == raw
