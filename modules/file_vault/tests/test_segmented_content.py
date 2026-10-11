"""notes/segmented_content.py 的直接单测：此前只有间接覆盖，逐字符实现占大笔记首次打开
80%+ 耗时却无人察觉。这里直接钉住 split_text 的 UTF-8 安全与边界偏好契约，不依赖存储/RPC。"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.notes import segmented_content  # noqa: E402
from modules.file_vault.notes.segmented_content import MAX_SEGMENT_BYTES, split_text  # noqa: E402


def _reconstruct(text: str, *, target_bytes: int) -> str:
    return "".join(s.content for s in split_text(text, target_bytes=target_bytes))


def test_split_text_empty_yields_nothing():
    assert list(split_text("")) == []


def test_split_text_short_text_yields_single_segment():
    segments = list(split_text("hello world"))
    assert len(segments) == 1
    assert segments[0].content == "hello world"
    assert segments[0].ordinal == 0
    assert segments[0].byte_size == len(b"hello world")


def test_split_text_respects_target_bytes_for_ascii():
    text = "".join(f"line {i}\n" for i in range(50_000))
    segments = list(split_text(text, target_bytes=4096))

    assert len(segments) > 1
    for s in segments[:-1]:
        assert s.byte_size <= 4096
    assert "".join(s.content for s in segments) == text


def test_split_text_prefers_newline_near_target_boundary():
    # Each line is short and well inside target_bytes, so the cut should
    # land immediately after a "\n", never mid-line.
    text = "".join(f"line-{i:04d}\n" for i in range(2000))
    segments = list(split_text(text, target_bytes=1000))

    assert len(segments) > 1
    for s in segments[:-1]:
        assert s.content.endswith("\n")


def test_split_text_splits_single_line_with_no_newlines():
    # No newline anywhere to break on - must still bound segment size using
    # character boundaries only.
    text = "x" * 10_000
    segments = list(split_text(text, target_bytes=1000))

    assert len(segments) == 10
    for s in segments:
        assert s.byte_size <= 1000
    assert "".join(s.content for s in segments) == text


def test_split_text_never_splits_a_multibyte_character_cjk():
    # 3-byte-per-character CJK text with no newlines - a naive byte slice at
    # a fixed offset would corrupt characters straddling the boundary.
    text = "这是一段测试文本" * 5000
    segments = list(split_text(text, target_bytes=997))  # deliberately not a multiple of 3

    reconstructed = "".join(s.content for s in segments)
    assert reconstructed == text
    for s in segments:
        # Round-tripping through decode() already proves validity, but
        # assert the byte_size field is honest too.
        assert s.byte_size == len(s.content.encode("utf-8"))
        assert s.byte_size <= 997 or len(s.content) == 1  # only a lone oversized char may exceed target


def test_split_text_never_splits_a_multibyte_character_emoji():
    # Emoji are 4-byte UTF-8 sequences (astral plane) - the widest case.
    text = "😀🎉✨" * 20_000
    segments = list(split_text(text, target_bytes=2003))

    reconstructed = "".join(s.content for s in segments)
    assert reconstructed == text
    for s in segments:
        assert s.byte_size == len(s.content.encode("utf-8"))


def test_split_text_mixed_ascii_cjk_and_newlines_reconstructs_exactly():
    lines = []
    for i in range(3000):
        if i % 7 == 0:
            lines.append(f"第{i}行中文内容混合ascii text 😀\n")
        else:
            lines.append(f"plain ascii line {i}\n")
    text = "".join(lines)

    for target in (997, 4096, segmented_content.TARGET_SEGMENT_BYTES):
        assert _reconstruct(text, target_bytes=target) == text


def test_split_text_respects_max_segment_bytes_hard_cap_even_near_target():
    text = "y" * 5000
    segments = list(split_text(text, target_bytes=MAX_SEGMENT_BYTES))
    for s in segments:
        assert s.byte_size <= MAX_SEGMENT_BYTES


def test_split_text_ordinals_are_sequential_from_zero_per_call():
    text = "z" * 5000
    segments = list(split_text(text, target_bytes=1000))
    assert [s.ordinal for s in segments] == list(range(len(segments)))


def test_split_text_byte_size_field_matches_actual_encoding_for_all_segments():
    text = ("mixed 中文 emoji 😀 text\n" * 3000)
    for s in split_text(text, target_bytes=1500):
        assert s.byte_size == len(s.content.encode("utf-8"))


@pytest.mark.parametrize("target_bytes", [0, -1, MAX_SEGMENT_BYTES + 1])
def test_split_text_rejects_target_bytes_out_of_range(target_bytes):
    with pytest.raises(ValueError):
        list(split_text("anything", target_bytes=target_bytes))


def test_split_text_single_character_wider_than_target_bytes_still_progresses():
    # target_bytes 小于单个 CJK 字符编码（3 字节）时，段仍须含完整字符，不能抛错或停滞。
    text = "中" * 5 + "abc"
    segments = list(split_text(text, target_bytes=1))

    assert "".join(s.content for s in segments) == text
    assert segments[0].content == "中"
