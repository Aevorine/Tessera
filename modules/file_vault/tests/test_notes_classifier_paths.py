"""笔记导入自动分类在递归分类下的打分（notes/classifier.py）。

候选名已是 `工作/项目A` 这样的整条路径，拿整串匹配永远得 0 分，会让自动分类在用户一建多级分类
后整体失效。所以测试重点是按段打分：叶子段权重最高，父段明显更低。
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.notes import classifier


def _candidate(name, keywords=None):
    return {"name": name, "keywords": keywords or []}


def test_nested_category_matches_on_its_leaf_segment(tmp_path=None):
    """这就是不按段拆就会失效的那个场景——文件名里只有 `项目A`，没有完整路径。"""
    result = classifier.classify("项目A周报.txt", "本周进展", [_candidate("工作/项目A")])
    assert result == "工作/项目A"


def test_full_path_in_the_title_still_matches(tmp_path=None):
    # 按段拆之后整串出现的情况仍然命中（每一段都在标题里）
    result = classifier.classify("工作/项目A 周报", "本周进展", [_candidate("工作/项目A")])
    assert result == "工作/项目A"


def test_leaf_match_beats_an_ancestor_only_match(tmp_path=None):
    """父段命中是弱信号：提到"工作"的文件对 `工作/*` 下所有兄弟分类一视同仁，权重高会让父段命中压过
    叶子段精确命中而塞错分类，所以父段要打折。"""
    candidates = [_candidate("工作/项目A"), _candidate("工作/项目B")]

    result = classifier.classify("项目B验收单", "工作内容如下", candidates)

    assert result == "工作/项目B"


def test_ancestor_match_alone_still_beats_nothing(tmp_path=None):
    """打折不等于归零——只命中父段时仍然好过完全不分类。"""
    result = classifier.classify("工作安排", "内容", [_candidate("工作/项目A")])
    assert result == "工作/项目A"


def test_several_ancestor_hits_do_not_outweigh_one_leaf_hit(tmp_path=None):
    """两个父段都命中（0.75 + 0.75 = 1.5）也压不过一次叶子命中（3）。
    这个比例是 _ANCESTOR_SCORE_FACTOR = 0.25 存在的全部理由。"""
    candidates = [
        _candidate("公司/工作/杂项"),  # 标题里有"公司"和"工作"两个父段
        _candidate("归档/季度总结"),  # 标题里有叶子"季度总结"
    ]

    result = classifier.classify("公司工作季度总结", "内容", candidates)

    assert result == "归档/季度总结"


def test_keywords_apply_to_the_whole_category_not_per_segment(tmp_path=None):
    """关键词是用户给**整个分类**填的同义词，本来就不带层级语义，不该拆段。"""
    result = classifier.classify("Alpha 立项书", "内容", [_candidate("工作/项目A", ["Alpha"])])
    assert result == "工作/项目A"


def test_no_match_returns_none_rather_than_forcing_a_guess(tmp_path=None):
    """保持"不硬猜"：一个都匹配不上就留空让用户自己归档。重分类预览也依赖此语义，None 绝不能被当成
    "应该清空分类"的信号。"""
    assert classifier.classify("完全无关的文件", "内容", [_candidate("工作/项目A")]) is None


def test_empty_candidates_returns_none(tmp_path=None):
    assert classifier.classify("项目A", "内容", []) is None


def test_ties_keep_the_first_candidate_for_determinism(tmp_path=None):
    """候选顺序是稳定的（storage.list_categories 按名字排序），并列时取先出现的
    那个，结果才不会随 dict/set 的迭代顺序变化。"""
    candidates = [_candidate("甲/项目"), _candidate("乙/项目")]
    assert classifier.classify("项目文档", "内容", candidates) == "甲/项目"


def test_a_path_with_blank_segments_does_not_crash(tmp_path=None):
    """历史脏数据（`工作//项目A`）在打分这条**读**路径上要宽松处理——
    严格校验只发生在写入时。"""
    assert classifier.classify("项目A周报", "内容", [_candidate("工作//项目A")]) == "工作//项目A"
