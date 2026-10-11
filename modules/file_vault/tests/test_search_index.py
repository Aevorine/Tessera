# -*- coding: utf-8 -*-
"""search_index 用例，重点是三件不会报错的失效：
1. 拼音首字母表分界点抄错，某些字永远搜不到；2. 索引与数据不同步，搜到已删记录；
3. 候选集不封顶，常见字退化成全库扫描，只表现为"卡一下"。"""

from __future__ import annotations

import random
import time

import pytest

from modules.file_vault import search_index as si


# 1. 拼音首字母


def test_pinyin_boundaries_decode():
    """每个分界点上的字必须以该声母开头，它前一个字属于上一个声母。
    这是整张表唯一的独立证据：数字可被 GB2312 解码反向验证；抄错一位会让整个声母区间错位而无报错。"""
    bounds = si._PY_BOUNDS
    assert [c for c, _ in bounds] == sorted(c for c, _ in bounds), "分界点必须单调递增"
    for code, letter in bounds:
        quotient, remainder = divmod(code, 100)
        ch = bytes([quotient + 160, remainder + 160]).decode("gb2312")
        assert si._initial_of_char(ch) == letter, f"区位码 {code} 的字 {ch} 应判为 {letter}"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("密码", "mm"),
        ("笔记", "bj"),
        ("剪贴板", "jtb"),
        ("跨设备传输", "ksbcs"),
        ("恢复码", "hfm"),
        ("安全体检", "aqtj"),
        ("哦", "o"),          # 分界点上最容易被抄错的一个字
        ("座", "z"),          # 一级汉字的最后一个
    ],
)
def test_pinyin_initials_known_words(text, expected):
    assert si.pinyin_initials(text) == expected


def test_pinyin_initials_keeps_non_cjk():
    """混排标题里的字母数字必须原样留下——只留汉字首字母的话，
    用户输 "q3cwfp" 这种最自然的混合输入反而搜不到。"""
    assert si.pinyin_initials("Q3 财务复盘") == "q3 cwfp"


def test_pinyin_initials_uses_placeholder_for_unknown():
    """二级汉字推不出声母时补占位符，不能直接跳过：跳过会让后面的字挤上来，
    首字母串整体错位，比"这个字搜不到"影响大得多。"""
    initials = si.pinyin_initials("甲龘乙")
    assert len(initials) == 3
    assert initials[0] == "j"
    assert initials[1] == "?"


# 2. 打分与召回


def test_exact_prefix_outranks_middle_match():
    assert si.score_candidate("note", "notebook") > si.score_candidate("note", "my notebook")


def test_pinyin_query_finds_chinese():
    assert si.score_candidate("cwfp", "财务复盘") > 0


def test_typo_within_one_edit_still_matches():
    assert si.score_candidate("passwrod", "my password vault") > 0


def test_unrelated_query_scores_zero():
    assert si.score_candidate("zzzzzz", "财务复盘 2024") == 0


def test_subsequence_prefers_compact_match():
    """`ntb` 匹配 "notebook" 应该比匹配 "note is a big thing" 分高——
    否则模糊搜索会把最不相关的长文本排到前面。"""
    tight = si.score_candidate("ntb", "notebook")
    loose = si.score_candidate("ntb", "note is a big thing")
    assert tight > loose > 0


# 3. 索引本身


def _index_with(docs):
    idx = si.SearchIndex()
    idx.rebuild("notes", docs, fingerprint="v1")
    return idx


def test_index_returns_candidate_ids_ranked():
    idx = _index_with([(1, "财务复盘 2024"), (2, "购物清单"), (3, "财务预算")])
    hits = idx.search("notes", "财务", limit=10)
    ids = [i for i, _ in hits]
    assert set(ids) == {1, 3}
    assert hits[0][1] >= hits[-1][1], "必须按分数降序"


def test_index_search_by_pinyin_initials():
    idx = _index_with([(1, "季度财务复盘"), (2, "购物清单")])
    ids = [i for i, _ in idx.search("notes", "jdcwfp", limit=10)]
    assert ids == [1]


def test_fingerprint_gates_rebuild():
    idx = _index_with([(1, "a")])
    assert idx.fingerprint_matches("notes", "v1")
    assert not idx.fingerprint_matches("notes", "v2")
    assert not idx.fingerprint_matches("clipboard", "v1")


def test_rebuild_replaces_instead_of_merging():
    """整段替换。合并的话，被删掉的那条会**永远留在索引里**——
    这正是"搜到已删除记录"的经典成因。"""
    idx = _index_with([(1, "财务复盘"), (2, "购物清单")])
    idx.rebuild("notes", [(2, "购物清单")], fingerprint="v2")
    assert idx.doc_count("notes") == 1
    assert idx.search("notes", "财务", limit=10) == []


def test_clear_wipes_everything():
    """锁库时索引必须清空：里面存的是金库内容的明文片段。"""
    idx = _index_with([(1, "财务复盘")])
    idx.clear()
    assert idx.doc_count("notes") == 0
    assert idx.search("notes", "财务", limit=10) == []


def test_index_is_only_a_candidate_source_not_a_data_copy():
    """索引只存 id 和打分文本，不存业务数据；
    有人往 IndexedDoc 塞整条笔记时这里会红，那意味着金库内容多了一份不受锁库管辖的副本。"""
    assert set(si.IndexedDoc.__slots__) == {"module", "native_id", "text"}


# 4. 性能：候选集必须封顶


def test_common_token_does_not_degrade_to_full_scan():
    """十万条里搜每条都有的词仍须很快；无候选上限会退化成全部精算，表现为搜索框卡住。
    断言用候选数而非墙钟时间，墙钟在 CI 上不稳定。"""
    docs = [(i, f"共同前缀 record {i} 财务") for i in range(100_000)]
    idx = si.SearchIndex()
    idx.rebuild("notes", docs, fingerprint="big")
    postings = idx._postings["notes"]
    candidates = idx._candidates(postings, idx._docs["notes"], "财务")
    assert len(candidates) <= si.MAX_CANDIDATES


def test_large_index_query_under_budget():
    """十万条端到端查询预算：阈值 250ms 而非宣传的 50（本机实测约 20-40ms，CI 与用户在打游戏时会慢几倍）；
    要挡的是封顶失效造成的数量级（秒级）退化，不是抖动。"""
    rnd = random.Random(20260818)
    words = ["财务", "复盘", "清单", "note", "backup", "vault", "季度", "预算"]
    docs = [
        (i, " ".join(rnd.choice(words) for _ in range(6)) + f" {i}")
        for i in range(100_000)
    ]
    idx = si.SearchIndex()
    idx.rebuild("notes", docs, fingerprint="big")

    start = time.perf_counter()
    hits = idx.search("notes", "cwfp", limit=50)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert elapsed_ms < 250, f"十万条查询用了 {elapsed_ms:.0f} 毫秒"
    assert len(hits) <= 50
