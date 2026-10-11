# -*- coding: utf-8 -*-
"""离线优先的智能搜索：本地内存倒排索引 + 拼音首字母 + 模糊容错。

索引键为三类 token：拉丁词、汉字单字与相邻二字 bigram、拼音首字母串的每个前缀。
查询先用索引把候选缩到几十条，再只对候选精确打分（子串 > 前缀 > 词首 > 首字母 > 子序列
> 编辑距离 1）。

索引只产出候选 id，最终结果必须回权威数据源取一次：取不到（已删除）的丢弃，取到的用真实内容
重新打分，所以索引最多多给候选，不会让已删记录出现。调用方见
`backend_server.rpc_global_search`。`fingerprint`（条数 + 最大更新时间）变了就重建该模块的段。

零第三方依赖，Python 3.9 可用。拼音表由 GB2312 一级汉字（按拼音排序）的 23 个区位码分界点
推出，已解码验证：tests/test_search_index.py::test_pinyin_boundaries_decode。
"""

from __future__ import annotations

import bisect
import re
import unicodedata
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

__all__ = [
    "pinyin_initials",
    "tokenize",
    "score_candidate",
    "SearchIndex",
    "IndexedDoc",
    "MAX_CANDIDATES",
]


# GB2312 一级汉字按拼音排序，每个声母组只记第一个字的区位码（已解码核对）。
# 'o' 必须用 3722（哦）而非常见抄本的 3723（欧），否则「哦」被判成 n 且永远搜不到。
_PY_BOUNDS: List[Tuple[int, str]] = [
    (1601, "a"), (1637, "b"), (1833, "c"), (2078, "d"), (2274, "e"),
    (2302, "f"), (2433, "g"), (2594, "h"), (2787, "j"), (3106, "k"),
    (3212, "l"), (3472, "m"), (3635, "n"), (3722, "o"), (3730, "p"),
    (3858, "q"), (4027, "r"), (4086, "s"), (4390, "t"), (4558, "w"),
    (4684, "x"), (4925, "y"), (5249, "z"),
]
_PY_CODES = [c for c, _ in _PY_BOUNDS]
_PY_LETTERS = [l for _, l in _PY_BOUNDS]
# 区位码 5589 是「座」，一级汉字的最后一个。超过它的是二级汉字（按部首排序，
# 跟拼音无关），推不出声母——那些字只走汉字 bigram 那条路，不进首字母索引。
_PY_MAX = 5589

_INITIAL_CACHE: Dict[str, str] = {}


def _zone_code(ch: str) -> Optional[int]:
    try:
        raw = ch.encode("gb2312")
    except (UnicodeEncodeError, LookupError):
        return None
    if len(raw) != 2:
        return None
    return (raw[0] - 160) * 100 + (raw[1] - 160)


def _initial_of_char(ch: str) -> str:
    """单个汉字的拼音首字母。不是一级汉字就返回空串。"""
    cached = _INITIAL_CACHE.get(ch)
    if cached is not None:
        return cached
    code = _zone_code(ch)
    if code is None or code < _PY_CODES[0] or code > _PY_MAX:
        result = ""
    else:
        result = _PY_LETTERS[bisect.bisect_right(_PY_CODES, code) - 1]
    if len(_INITIAL_CACHE) < 20000:
        _INITIAL_CACHE[ch] = result
    return result


def pinyin_initials(text: str) -> str:
    """汉字换成拼音首字母，非汉字原样保留（小写），以支持 "q3cwfp" 这类混排输入。"""
    out: List[str] = []
    for ch in text:
        if "一" <= ch <= "鿿":
            initial = _initial_of_char(ch)
            # 二级汉字推不出声母时不能跳过（会让后面的字挤上来，「甲乙丙」变 "jb"），补 '?' 占位，
            # 模糊匹配会把它当通配符。
            out.append(initial or "?")
        else:
            out.append(ch.lower())
    return "".join(out)


_LATIN_RUN = re.compile(r"[0-9a-z]+")


def _is_cjk(ch: str) -> bool:
    # 中日韩统一表意文字 + 扩展 A + 假名。这几段都是"没有空格分词"的书写系统，
    # 走 bigram；泰文等其他无空格文字这里不覆盖，它们仍然靠子串那一遍兜底。
    return (
        "一" <= ch <= "鿿"
        or "㐀" <= ch <= "䶿"
        or "぀" <= ch <= "ヿ"
    )


def _normalize(text: str) -> str:
    """NFKC + 小写；折叠全角字母数字，否则从网页复制的全角文本永远搜不到。"""
    return unicodedata.normalize("NFKC", text).lower()


def tokenize(text: str) -> Set[str]:
    """把文本切成索引 token 集合（三类 token 互不冲突，混在一个集合里）。"""
    norm = _normalize(text)
    tokens: Set[str] = set()

    for match in _LATIN_RUN.finditer(norm):
        word = match.group()
        tokens.add(word)
        # 长词的前缀也进索引，这样输一半就能命中。上限 8 是体积和收益的折中：
        # 再长的前缀基本等同于整词，白占空间。
        for i in range(2, min(len(word), 8)):
            tokens.add(word[:i])

    chars = [c for c in norm if _is_cjk(c)]
    tokens.update(chars)
    for i in range(len(chars) - 1):
        tokens.add(chars[i] + chars[i + 1])

    initials = pinyin_initials(norm)
    for match in _LATIN_RUN.finditer(initials):
        run = match.group()
        # 首字母串的所有前缀。「季度财务复盘」→ j, jd, jdc, jdcw, jdcwf, jdcwfp
        for i in range(1, min(len(run), 12) + 1):
            tokens.add("\x01" + run[:i])

    return tokens


def _query_tokens(query: str) -> List[str]:
    """查询侧的 token。跟索引侧不同：这里**不展开前缀**，只取整体，
    因为查询本身就是"前缀"，展开会把候选集撑爆到失去过滤意义。"""
    norm = _normalize(query)
    tokens: List[str] = []
    for match in _LATIN_RUN.finditer(norm):
        word = match.group()
        tokens.append(word)
        # 纯字母的查询同时当作"拼音首字母"试一遍。中文用户输 "cwfp" 时，
        # 他既可能在找英文单词也可能在找「财务复盘」——两条路都走。
        if word.isalpha():
            tokens.append("\x01" + word)
    chars = [c for c in norm if _is_cjk(c)]
    if len(chars) == 1:
        tokens.append(chars[0])
    for i in range(len(chars) - 1):
        tokens.append(chars[i] + chars[i + 1])
    return tokens


# 候选集上限：超出的按命中 token 数排序后截断。打分是 O(候选数 × 文本长度)，不封顶的话
# 搜「的」就等于全库扫描。
MAX_CANDIDATES = 400


def _levenshtein_within_1(a: str, b: str) -> bool:
    """a 和 b 的 Damerau 编辑距离是否 <= 1（含相邻字符对调）。

    只判 1，一次线性扫描即可，比全量 DP 的 O(mn) 快（每敲一键跑几百次）。对调必须算进来：
    passwrod/teh 这类最常见手误按纯 Levenshtein 距离是 2，会搜不到。
    """
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if a == b:
        return True
    if la == lb:
        diff = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
        if len(diff) == 1:
            return True
        # 恰好两个位置不同、且这两个位置相邻、且交换后相等 = 一次对调
        if len(diff) == 2 and diff[1] - diff[0] == 1:
            i, j = diff
            return a[i] == b[j] and a[j] == b[i]
        return False
    # 长度差 1：短的必须是长的删掉一个字符
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    i = j = 0
    skipped = False
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        elif skipped:
            return False
        else:
            skipped = True
            j += 1
    return True


def _subsequence_score(needle: str, hay: str) -> int:
    """needle 是否为 hay 的子序列，是则按紧凑程度给分（0 表示不是）；类似 fzf 的精简版。"""
    if not needle:
        return 0
    i = 0
    first = -1
    last = -1
    for pos, ch in enumerate(hay):
        if ch == needle[i]:
            if first < 0:
                first = pos
            last = pos
            i += 1
            if i == len(needle):
                break
    if i < len(needle):
        return 0
    span = last - first + 1
    # 完全连续时 span == len(needle)，得满分 30；越散越低，最低 5。
    return max(5, 30 - (span - len(needle)))


def score_candidate(query: str, text: str) -> int:
    """记录对查询的得分，0 表示不出现。

    分档刻意拉开（100/80/60/45/…）：完整包含 > 开头 > 词首 > 首字母 > 模糊；留空隙使同档内的
    位置惩罚不会打乱档次。
    """
    if not query:
        return 0
    q = _normalize(query)
    t = _normalize(text)
    if not t:
        return 0

    # 1. 完整子串
    pos = t.find(q)
    if pos >= 0:
        if pos == 0:
            return 100
        # 出现在某个词的开头，比出现在词中间更像"用户要找的"
        if not t[pos - 1].isalnum():
            return 80
        return 65 - min(pos, 20)

    # 2. 拼音首字母
    if q.isascii() and q.isalpha():
        initials = pinyin_initials(t)
        ipos = initials.find(q)
        if ipos >= 0:
            return 60 if ipos == 0 else 50
        # '?' 是二级汉字的占位符（推不出声母）。把它当"任意一个字母"再试一次，
        # 否则一段文本里只要出现一个生僻字，整条的首字母搜索就永久失效。
        if "?" in initials:
            # 逐位比对：q 能不能在 initials 里找到一个起点，使得每一位要么相等、
            # 要么对面是 '?'。比编译正则便宜，而且不用担心转义。
            n, m = len(q), len(initials)
            for start in range(m - n + 1):
                if all(initials[start + i] in (q[i], "?") for i in range(n)):
                    return 45

    # 3. 词级的错一个字母
    words = _LATIN_RUN.findall(t)
    if len(q) >= 4:
        for w in words:
            if _levenshtein_within_1(q, w):
                return 40

    # 4. 子序列（打错顺序、只记得几个字母）
    if q.isascii() and len(q) >= 2:
        sub = _subsequence_score(q, t)
        if sub:
            return sub

    return 0



class IndexedDoc:
    """索引中的一条，只存 id 与打分文本，不存业务数据。

    索引是可随时丢弃重建的缓存；金库数据只有一份权威存储，多存一份就多一处泄漏面和不同步点。
    """

    __slots__ = ("module", "native_id", "text")

    def __init__(self, module: str, native_id, text: str) -> None:
        self.module = module
        self.native_id = native_id
        self.text = text


class SearchIndex:
    """按模块分段的倒排索引，每段可独立重建。无内部锁：后端 RPC 单线程串行（见 backend_server
    主循环）；改成并发处理时这里要一起改。"""

    def __init__(self) -> None:
        # module -> token -> set(doc_key)
        self._postings: Dict[str, Dict[str, Set[int]]] = {}
        # module -> doc_key -> IndexedDoc
        self._docs: Dict[str, Dict[int, IndexedDoc]] = {}
        # module -> 数据源上次给的指纹
        self._fingerprints: Dict[str, str] = {}
        self._next_key = 0

    # -- 维护 --------------------------------------------------------------

    def fingerprint_matches(self, module: str, fingerprint: str) -> bool:
        """数据源的指纹跟索引里记的一样吗？一样就不用重建。"""
        return self._fingerprints.get(module) == fingerprint

    def rebuild(self, module: str, docs: Iterable[Tuple[object, str]], fingerprint: str) -> int:
        """重建一个模块的索引段，docs 为 (业务 id, 可搜索文本) 序列。

        整段替换而非增量：重新分词几万条只需毫秒，而增量要处理改/删/id 复用，正是索引 bug 的来源。
        """
        postings: Dict[str, Set[int]] = {}
        doc_map: Dict[int, IndexedDoc] = {}
        count = 0
        for native_id, text in docs:
            key = self._next_key
            self._next_key += 1
            doc_map[key] = IndexedDoc(module, native_id, text)
            for token in tokenize(text):
                bucket = postings.get(token)
                if bucket is None:
                    postings[token] = {key}
                else:
                    bucket.add(key)
            count += 1
        self._postings[module] = postings
        self._docs[module] = doc_map
        self._fingerprints[module] = fingerprint
        return count

    def drop(self, module: str) -> None:
        self._postings.pop(module, None)
        self._docs.pop(module, None)
        self._fingerprints.pop(module, None)

    def clear(self) -> None:
        """丢弃全部索引（含金库内容的明文片段）。

        目前无调用点：后端没有"锁库"动作，解锁后主密钥一直留在内存（见 backend_server 的 _imk），
        索引不比它更敏感。加"锁定"功能时必须在此调用。
        """
        self._postings.clear()
        self._docs.clear()
        self._fingerprints.clear()

    def doc_count(self, module: str) -> int:
        return len(self._docs.get(module, {}))

    # -- 查询 --------------------------------------------------------------

    def search(self, module: str, query: str, limit: int) -> List[Tuple[object, int]]:
        """返回按分数降序的 [(业务 id, 分数)]，0 分不返回。这只是候选与建议排序，id 必须由调用方回
        权威数据源核实（见模块顶部）。"""
        docs = self._docs.get(module)
        postings = self._postings.get(module)
        if not docs or postings is None or not query.strip():
            return []

        candidates = self._candidates(postings, docs, query)
        scored: List[Tuple[object, int]] = []
        for key in candidates:
            doc = docs.get(key)
            if doc is None:
                continue
            score = score_candidate(query, doc.text)
            if score > 0:
                scored.append((doc.native_id, score))
        scored.sort(key=lambda pair: -pair[1])
        return scored[:limit] if limit and limit > 0 else scored

    def _candidates(
        self,
        postings: Dict[str, Set[int]],
        docs: Dict[int, IndexedDoc],
        query: str,
    ) -> Sequence[int]:
        tokens = _query_tokens(query)
        if not tokens:
            # 查询里没有可索引 token 时退化成全量精算；只发生在很小的查询上，但必须保留，否则会静默返回 0 条。
            return list(docs.keys())[:MAX_CANDIDATES]

        hits: Dict[int, int] = {}
        for token in tokens:
            bucket = postings.get(token)
            if not bucket:
                continue
            for key in bucket:
                hits[key] = hits.get(key, 0) + 1

        if not hits:
            # 一个 token 都没命中，可能拼错：仅在索引不大时才做昂贵的全量模糊（十万条必超时，返回空
            # 比卡住好）。
            if len(docs) <= MAX_CANDIDATES * 5:
                return list(docs.keys())
            return []

        if len(hits) <= MAX_CANDIDATES:
            return list(hits.keys())
        # 命中 token 多的优先。这是精算之前唯一的排序依据，也是唯一便宜的依据。
        ranked = sorted(hits.items(), key=lambda pair: -pair[1])
        return [key for key, _ in ranked[:MAX_CANDIDATES]]
