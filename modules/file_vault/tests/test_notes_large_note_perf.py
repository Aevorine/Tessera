"""大笔记性能回归测试：断言开销与文件总大小解耦。

不断言绝对耗时（随机器差好几倍，终会随机失败然后被 skip），改断言复杂度：同一操作在 4 倍大的
笔记上不应慢 4 倍。覆盖三条路径，均应 O(1)：打开（读一段正文）、编辑（写一段正文）、
建索引/分类打分（有界读取，不把整篇读进内存）。
"""

import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.notes import classifier, segmented_content, storage
from modules.file_vault.notes.service import NotesService

# 两个规模差 4 倍。取这么小（而不是真的几十 MB）是为了让测试跑得快——复杂度是
# 否线性用 1MB vs 4MB 就能看出来，不需要真的造一个 80MB 的文件。
SMALL_BYTES = 1 * 1024 * 1024
LARGE_BYTES = 4 * 1024 * 1024

# 4 倍数据量下允许的最大耗时倍数。取 2.0 而非 1.2：小规模耗时仅毫秒级，噪声占比大；真退化成
# O(N) 时倍数接近 4，离 2.0 足够远，不会漏报。
MAX_SLOWDOWN_RATIO = 2.0

# 大规模一侧低于此绝对耗时就直接判定为常量时间，不看比值：这个量级的比值没有意义（0.17ms vs
# 0.33ms 可能只是一次调度抖动或 fsync 运气）。2ms 本身是有效的复杂度断言：4MB 上真做一遍 O(N)
# 读取/解密/切分不可能在 2ms 内完成（光 SQLCipher 解密 4MB 就远超），两者等价，只是更抗噪。
NOISE_FLOOR_SECONDS = 2e-3


def _text_of(byte_size: int) -> str:
    line = "the quick brown fox jumps over the lazy dog\n"  # 44 字节 ASCII
    return line * (byte_size // len(line))


def _make_service(tmp_path, name) -> NotesService:
    return NotesService(tmp_path / name, crypto.generate_key())


def _segmented_note(service, byte_size: int) -> int:
    """造一篇已经转成分段存储的笔记，返回 note_id。"""
    note = service.create_note(title="big", category="", content=_text_of(byte_size))
    service._convert_legacy_note_to_segments(note["id"], note)
    return note["id"]


def _median_seconds(fn, repeats=9) -> float:
    """取中位数：最小值会被幸运的缓存命中带偏，平均值会被偶发 GC/调度停顿带偏；样本数取奇数，
    中位数才是真实存在的某次测量而非插值。"""
    samples = []
    for _ in range(repeats):
        start = time.perf_counter()
        fn()
        samples.append(time.perf_counter() - start)
    samples.sort()
    return samples[len(samples) // 2]


def _assert_constant_time(small_seconds: float, large_seconds: float, label: str):
    # 大规模那一侧本身就远快于"扫一遍 4MB"所需的时间 → 已经证明了是常量时间，
    # 不需要再看比值（那个量级的比值纯粹是噪声）。见 NOISE_FLOOR_SECONDS 的注释。
    if large_seconds < NOISE_FLOOR_SECONDS:
        return
    ratio = large_seconds / max(small_seconds, 1e-6)
    assert ratio <= MAX_SLOWDOWN_RATIO, (
        f"{label}: 数据量翻 4 倍后耗时变成 {ratio:.1f} 倍"
        f"（{small_seconds * 1000:.2f}ms → {large_seconds * 1000:.2f}ms），"
        f"看起来退化成了 O(N)。这条路径必须与笔记总大小无关。"
    )


# --- 打开：读一段 -------------------------------------------------------


def test_reading_one_segment_is_independent_of_total_note_size(tmp_path):
    """打开大笔记之所以能"ms 级"，全靠这一条：一次只取一个 256KB 的段，
    RPC 传输量、SQLCipher 解密量、JSON 序列化量都是常量。"""
    small_service = _make_service(tmp_path, "small")
    large_service = _make_service(tmp_path, "large")
    small_id = _segmented_note(small_service, SMALL_BYTES)
    large_id = _segmented_note(large_service, LARGE_BYTES)

    small = _median_seconds(lambda: storage.fetch_segment(small_service.conn, small_id, 0))
    large = _median_seconds(lambda: storage.fetch_segment(large_service.conn, large_id, 0))

    _assert_constant_time(small, large, "读取单段")


def test_reading_the_last_segment_is_also_constant_time(tmp_path):
    """不只是第一段——跳到文件末尾同样不能付整篇的代价。"""
    small_service = _make_service(tmp_path, "small")
    large_service = _make_service(tmp_path, "large")
    small_id = _segmented_note(small_service, SMALL_BYTES)
    large_id = _segmented_note(large_service, LARGE_BYTES)
    small_last = storage.count_segments(small_service.conn, small_id) - 1
    large_last = storage.count_segments(large_service.conn, large_id) - 1
    assert large_last > small_last  # 前提：大的确实分了更多段

    small = _median_seconds(lambda: storage.fetch_segment(small_service.conn, small_id, small_last))
    large = _median_seconds(lambda: storage.fetch_segment(large_service.conn, large_id, large_last))

    _assert_constant_time(small, large, "读取末段")


def test_segment_count_lookup_is_constant_time(tmp_path):
    """打开笔记的第一步是问"总共几段"——这一步走 COUNT 索引，不该扫正文。"""
    small_service = _make_service(tmp_path, "small")
    large_service = _make_service(tmp_path, "large")
    small_id = _segmented_note(small_service, SMALL_BYTES)
    large_id = _segmented_note(large_service, LARGE_BYTES)

    small = _median_seconds(lambda: storage.count_segments(small_service.conn, small_id))
    large = _median_seconds(lambda: storage.count_segments(large_service.conn, large_id))

    _assert_constant_time(small, large, "统计段数")


# --- 编辑：写一段 -------------------------------------------------------


def test_writing_one_segment_is_independent_of_total_note_size(tmp_path):
    """编辑不能走"读全文 → 改 → 写全文"，否则每敲一个字的成本都跟文件大小成
    正比。乐观并发（expected_revision）就是为了让写入只碰一个段。"""
    small_service = _make_service(tmp_path, "small")
    large_service = _make_service(tmp_path, "large")
    small_id = _segmented_note(small_service, SMALL_BYTES)
    large_id = _segmented_note(large_service, LARGE_BYTES)

    def write(service, note_id):
        segment = storage.fetch_segment(service.conn, note_id, 0)
        storage.update_segment(
            service.conn,
            segment["id"],
            expected_revision=segment["revision"],
            content=segment["content"],
            byte_size=segment["byte_size"],
        )

    small = _median_seconds(lambda: write(small_service, small_id))
    large = _median_seconds(lambda: write(large_service, large_id))

    _assert_constant_time(small, large, "写入单段")


# --- 有界读取：FTS 索引 / 分类打分 --------------------------------------


def test_fts_indexing_a_huge_note_reads_only_the_bounded_prefix(tmp_path):
    """超限笔记只索引前 2MB。关键是读取也要有界：走 _normalize_note_row 会把整篇读进内存再丢掉大部分，
    一次重建索引就能把内存打爆。"""
    service = _make_service(tmp_path, "vault")
    note_id = _segmented_note(service, LARGE_BYTES)
    row = storage.fetch_one(service.conn, note_id)

    content = service._content_for_index(row)

    assert row["content_length"] > 2 * 1024 * 1024  # 前提：这篇确实超限
    assert len(content.encode("utf-8")) <= 2 * 1024 * 1024
    assert service.fts_index_truncated(row["content_length"]) is True


def test_small_notes_still_get_fully_indexed(tmp_path):
    """截断只该发生在真的超大的笔记上——普通笔记必须整篇可搜。"""
    service = _make_service(tmp_path, "vault")
    text = "找得到这句话吗\n" * 100
    note = service.create_note(title="小笔记", category="", content=text)
    row = storage.fetch_one(service.conn, note["id"])

    assert service.fts_index_truncated(row["content_length"]) is False
    assert service._content_for_index(row) == text


def test_classify_excerpt_is_independent_of_total_note_size(tmp_path):
    """回溯重分类要对几百篇笔记逐一打分。每篇都读整文的话，一次重分类就等于把
    整个笔记库读一遍——这条路径必须有界。"""
    small_service = _make_service(tmp_path, "small")
    large_service = _make_service(tmp_path, "large")
    small_id = _segmented_note(small_service, SMALL_BYTES)
    large_id = _segmented_note(large_service, LARGE_BYTES)

    small = _median_seconds(lambda: small_service._classify_excerpt_for(small_id))
    large = _median_seconds(lambda: large_service._classify_excerpt_for(large_id))

    _assert_constant_time(small, large, "分类摘要读取")
    assert len(large_service._classify_excerpt_for(large_id)) <= classifier.CLASSIFY_EXCERPT_CHARS


def test_bounded_content_never_splits_a_multibyte_character(tmp_path):
    """按字节截断时如果正好切在一个多字节字符中间，不能产生半个字符——
    那会让写进 FTS 的文本里混进替换字符，搜索时莫名其妙匹配不上。"""
    service = _make_service(tmp_path, "vault")
    # 每个中文字符 3 字节，取一个不是 3 的倍数的上限，保证会切在字符中间
    note = service.create_note(title="中文", category="", content="中" * 1000)
    row = storage.fetch_one(service.conn, note["id"])

    truncated = service._bounded_content(row, 100)

    assert len(truncated.encode("utf-8")) <= 100
    assert "�" not in truncated  # 没有替换字符
    assert truncated == "中" * 33  # 100 // 3


# --- 分段切分本身 -------------------------------------------------------


def test_split_text_is_linear_not_quadratic(tmp_path):
    """split_text 曾因逐字符 str.encode() 在 80MB 文本上占 80% 耗时（见 segmented_content.py 顶部）。
    切分必须扫全文，是 O(N)；这里断言不比线性更差，防止退回逐字符。"""
    small = _median_seconds(lambda: list(segmented_content.split_text(_text_of(SMALL_BYTES))), repeats=3)
    large = _median_seconds(lambda: list(segmented_content.split_text(_text_of(LARGE_BYTES))), repeats=3)

    if large < 1e-4 and small < 1e-4:
        pytest.skip("两个规模都快到测不准，比值没有意义")
    ratio = large / max(small, 1e-6)
    # 4 倍数据量、线性算法 → 约 4 倍耗时。给到 8 倍的余量容纳噪声；真退化成
    # 平方级会是 16 倍，跟阈值差得足够远。
    assert ratio <= 8.0, f"切分耗时变成 {ratio:.1f} 倍，疑似退化成超线性"


def test_every_segment_respects_the_hard_byte_limit(tmp_path):
    """段大小的上界是 RPC 载荷和单次解密量的上界——它被突破的话，"单段读取是
    常量时间"这个前提就不成立了。"""
    segments = list(segmented_content.split_text(_text_of(SMALL_BYTES)))

    assert len(segments) > 1
    assert all(seg.byte_size <= segmented_content.MAX_SEGMENT_BYTES for seg in segments)
    # 拼回去必须跟原文完全一致——有界不能以丢内容为代价
    assert "".join(seg.content for seg in segments) == _text_of(SMALL_BYTES)
