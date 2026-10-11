"""Bounded text-segment primitives for large notes; no database or RPC dependency."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

TARGET_SEGMENT_BYTES = 256 * 1024
MAX_SEGMENT_BYTES = 512 * 1024


@dataclass(frozen=True)
class TextSegment:
    ordinal: int
    content: str
    byte_size: int


def _utf8_size(text: str) -> int:
    return len(text.encode("utf-8"))


def split_text(text: str, *, target_bytes: int = TARGET_SEGMENT_BYTES) -> Iterator[TextSegment]:
    """Yields UTF-8 bounded pieces, preferring a nearby preceding newline.

    ``target_bytes`` is the normal size; every segment is strictly <= ``MAX_SEGMENT_BYTES``.
    A single oversized line is split on character boundaries. Cuts are found in the whole
    encoded ``bytes`` (one encode, not per-character: that took 80% of an 80MB note's open)
    and only move earlier. Backing off continuation bytes (0x80..0xBF) lands on a character
    boundary; ``\\n`` (0x0A) never appears inside a multi-byte sequence, so searching it is safe.
    """
    if not 0 < target_bytes <= MAX_SEGMENT_BYTES:
        raise ValueError("target_bytes must be within the segment limit")

    data = text.encode("utf-8")
    length = len(data)
    start = 0
    ordinal = 0
    while start < length:
        end = _segment_end(data, start, length, target_bytes)
        if end == start:
            # UTF-8 code points never exceed four bytes, therefore this only
            # protects callers that change MAX_SEGMENT_BYTES in the future.
            raise ValueError("segment limit is too small for one character")

        boundary = data.rfind(b"\n", start, end)
        if boundary >= start:
            end = boundary + 1

        chunk = data[start:end]
        yield TextSegment(ordinal=ordinal, content=chunk.decode("utf-8"), byte_size=len(chunk))
        start = end
        ordinal += 1


def _segment_end(data: bytes, start: int, length: int, target_bytes: int) -> int:
    """Byte offset in ``start < offset <= length`` closest to
    ``start + target_bytes`` that doesn't land inside a UTF-8 character."""
    end = min(start + target_bytes, length)
    if end >= length:
        return length

    probe = end
    while probe > start and (data[probe] & 0xC0) == 0x80:
        probe -= 1
    if probe > start:
        return probe

    # The character at `start` is wider than target_bytes (only if target_bytes < 4): advance past it.
    probe = end
    while probe < length and (data[probe] & 0xC0) == 0x80:
        probe += 1
    return probe


def validate_segment_content(content: str) -> int:
    """Returns byte size or rejects a payload that exceeds the hard limit."""
    byte_size = _utf8_size(content)
    if byte_size > MAX_SEGMENT_BYTES:
        raise ValueError("segment payload exceeds the hard limit")
    return byte_size
