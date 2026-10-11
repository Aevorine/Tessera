# -*- coding: utf-8 -*-
"""近似重复：认出几乎一样但不完全一样的剪贴板记录（精确哈希对差一字节的重复无能为力）。

故意不认的（Jaccard 相似度）：网址带不带 utm 参数 0.49、地址去掉全部空格 0.45、
同模板填不同内容 0.31。前两种与第三种在任何通用相似度上挤在一起分不开，
而合并第三种会真丢记录；所以只认小差异，漏一对只是多一行，认错一对是丢数据。

做法：对 3 字符 shingle（不引词典的折中，同 search_index.py 的 bigram）取 blake2b 低 64 位，
累加成 64 位 SimHash，判重看汉明距离。两道闸：SimHash 初筛（<= 6），再用 shingle 集合
Jaccard 确认（>= 0.85）；只用一道无法同时认出前两种又排除第三种（实测距离 18/13/15）。
少于 12 个字符的短文本不参与：统计意义不成立，应靠精确哈希去重。
"""

from __future__ import annotations

import hashlib
from typing import Dict, List, Sequence, Tuple

__all__ = ["simhash", "hamming", "group_near_duplicates", "MIN_LENGTH", "DEFAULT_MAX_DISTANCE"]

SHINGLE_SIZE = 3
MIN_LENGTH = 12
# SimHash 初筛的汉明距离上限。放宽一点没关系，后面还有 Jaccard 那道闸把关。
DEFAULT_MAX_DISTANCE = 6
# 确认用的 Jaccard 下限。0.85 的位置是量出来的：真正的"只差空白/大小写"是 1.00
# 附近，而最接近的误判候选（同模板不同内容）只有 0.31，中间空得很。
MIN_JACCARD = 0.85
_BITS = 64
_MASK = (1 << _BITS) - 1


def _normalise(text: str) -> str:
    """比对前只做最无争议的归一化：去首尾空白、压缩连续空白、转小写；不做全角转半角、不去标点（宁可
    少认）。"""
    return " ".join(text.split()).lower()


def _shingles(text: str) -> List[str]:
    if len(text) <= SHINGLE_SIZE:
        return [text]
    return [text[i : i + SHINGLE_SIZE] for i in range(len(text) - SHINGLE_SIZE + 1)]


def simhash(text: str) -> int:
    """64 位指纹。内容越像，指纹相差的二进制位越少。"""
    normalised = _normalise(text)
    counters = [0] * _BITS
    for shingle in _shingles(normalised):
        digest = int.from_bytes(
            hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest(), "big"
        )
        for bit in range(_BITS):
            counters[bit] += 1 if (digest >> bit) & 1 else -1
    value = 0
    for bit in range(_BITS):
        if counters[bit] > 0:
            value |= 1 << bit
    return value & _MASK


def hamming(a: int, b: int) -> int:
    return bin((a ^ b) & _MASK).count("1")


def _jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def group_near_duplicates(
    items: Sequence[Tuple[object, str]],
    max_distance: int = DEFAULT_MAX_DISTANCE,
) -> List[List[object]]:
    """把 (id, 文本) 序列按近似度分组，只返回成组（长度 >= 2）的 id 列表。

    朴素两两比较 O(n²)，600 条约 650 ms：这是用户点"清理重复项"后等待的扫描，可接受；
    历史上限 5000 条，LSH 分桶的复杂度等真有需要再引入。
    """
    candidates = []
    for item_id, text in items:
        normalised = _normalise(text or "")
        if len(normalised) < MIN_LENGTH:
            continue
        candidates.append((item_id, simhash(text), frozenset(_shingles(normalised))))
    parent: Dict[object, object] = {item_id: item_id for item_id, _, _ in candidates}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(len(candidates)):
        id_a, hash_a, set_a = candidates[i]
        for j in range(i + 1, len(candidates)):
            id_b, hash_b, set_b = candidates[j]
            # 第一道：便宜的位运算，绝大多数不相干的对在这里就被挡掉。
            if hamming(hash_a, hash_b) > max_distance:
                continue
            # 第二道：真正判"像不像"。见模块头注释里那组实测数字。
            if _jaccard(set_a, set_b) >= MIN_JACCARD:
                union(id_a, id_b)

    groups: Dict[object, List[object]] = {}
    for item_id, _, _ in candidates:
        groups.setdefault(find(item_id), []).append(item_id)
    # 组内按传入顺序（也就是调用方给的 id 顺序）排好，组间按"成员多的在前"——
    # 用户先看到的应该是收益最大的那一组。
    return sorted((members for members in groups.values() if len(members) > 1),
                  key=lambda m: (-len(m), m[0] if isinstance(m[0], int) else 0))
