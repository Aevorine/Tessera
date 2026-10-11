"""递归分类路径工具（notes/category_paths.py，纯字符串逻辑）的测试，重点是不变量：非法路径不能
写入、不能把子树移进自己的子孙、前缀匹配要有层级边界（`工作台` 不是 `工作` 的子孙）。"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.notes import category_paths as cp


# --- 宽松解析（读路径用）-------------------------------------------------


def test_split_path_drops_empty_segments_and_whitespace():
    # 面对历史遗留的脏数据也要能给出合理结果，而不是让整棵树渲染不出来
    assert cp.split_path(" 工作 //项目A/ ") == ["工作", "项目A"]


def test_split_path_of_empty_is_empty_list():
    assert cp.split_path("") == []


def test_normalize_path_produces_canonical_form():
    assert cp.normalize_path(" 工作 //项目A/") == "工作/项目A"


# --- 严格校验（写路径用）-------------------------------------------------


def test_validate_path_accepts_empty_meaning_uncategorized():
    """空分类是合法的——不是所有笔记都得有归属，强制要求会逼出一个叫"其它"的垃圾桶分类。"""
    assert cp.validate_path("") == ""
    assert cp.validate_path("   ") == ""


def test_validate_path_trims_each_segment():
    assert cp.validate_path(" 工作 / 项目A ") == "工作/项目A"


def test_validate_path_rejects_empty_segment_instead_of_silently_fixing_it():
    """写入时 `工作//项目A` 是输入错误，要当面报；像 split_path 那样静默吞掉空段会让用户继续这么输，
    所以宽松解析和严格校验必须是两个函数。"""
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.validate_path("工作//项目A")
    assert exc.value.code == "notes.category_empty_segment"


def test_validate_path_rejects_a_segment_over_the_char_limit():
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.validate_path("x" * (cp.MAX_SEGMENT_CHARS + 1))
    assert exc.value.code == "notes.category_segment_too_long"


def test_validate_path_rejects_going_deeper_than_the_limit():
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.validate_path("/".join(f"a{i}" for i in range(cp.MAX_DEPTH + 1)))
    assert exc.value.code == "notes.category_too_deep"


def test_validate_path_accepts_exactly_the_depth_limit():
    path = "/".join(f"a{i}" for i in range(cp.MAX_DEPTH))
    assert cp.validate_path(path) == path


def test_validate_path_rejects_an_over_long_whole_path():
    # 每段都合法但整条太长——单段上限挡不住这种
    path = "/".join("x" * 50 for _ in range(10))
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.validate_path(path)
    assert exc.value.code == "notes.category_path_too_long"


# --- 层级关系 ------------------------------------------------------------


def test_parent_paths_lists_every_ancestor_shallowest_first():
    assert cp.parent_paths("工作/项目A/需求") == ["工作", "工作/项目A"]


def test_parent_paths_of_a_top_level_category_is_empty():
    assert cp.parent_paths("工作") == []


def test_parent_of_top_level_is_empty_string():
    assert cp.parent_of("工作") == ""
    assert cp.parent_of("工作/项目A") == "工作"


def test_leaf_of_returns_the_most_specific_segment():
    # 分类器按段打分时用它——文件名里出现的几乎总是叶子名
    assert cp.leaf_of("工作/项目A") == "项目A"
    assert cp.leaf_of("工作") == "工作"
    assert cp.leaf_of("") == ""


def test_is_descendant_of_has_segment_boundary_awareness():
    """`工作台` 不能被当成 `工作` 的子孙：裸 startswith 会误判，要加分隔符再比，
    否则删除或重命名 `工作` 会连带改掉 `工作台`。"""
    assert cp.is_descendant_of("工作/项目A", "工作")
    assert not cp.is_descendant_of("工作台", "工作")
    assert not cp.is_descendant_of("工作", "工作")  # 自己不算自己的子孙


def test_is_self_or_descendant_of_includes_itself():
    assert cp.is_self_or_descendant_of("工作", "工作")
    assert cp.is_self_or_descendant_of("工作/项目A", "工作")
    assert not cp.is_self_or_descendant_of("工作台", "工作")


# --- 子树搬迁 ------------------------------------------------------------


def test_rebase_moves_a_descendant_under_the_new_prefix():
    assert cp.rebase("工作/项目A/需求", "工作/项目A", "归档/项目A") == "归档/项目A/需求"


def test_rebase_handles_the_prefix_itself():
    assert cp.rebase("工作/项目A", "工作/项目A", "归档/项目A") == "归档/项目A"


def test_rebase_returns_none_for_an_unrelated_path():
    """返回 None 而不是原样返回，让调用方能区分"要改"和"不用动"，
    批量 UPDATE 时不会白写一堆没变化的行。"""
    assert cp.rebase("生活/旅行", "工作/项目A", "归档/项目A") is None
    assert cp.rebase("工作台", "工作", "归档") is None  # 边界感同样适用


def test_validate_move_blocks_moving_a_subtree_into_its_own_descendant():
    """把子树移进自己的子孙里会产生无限自嵌套的路径，且没有回滚余地——
    必须在动手之前拦住，这是整个移动操作里唯一会不可逆地毁掉数据的输入。"""
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.validate_move("工作/项目A", "工作/项目A/子集")
    assert exc.value.code == "notes.category_move_into_self"


def test_validate_move_blocks_moving_a_category_onto_itself():
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.validate_move("工作/项目A", "工作/项目A")
    assert exc.value.code == "notes.category_move_into_self"


def test_validate_move_allows_a_sibling_rename():
    assert cp.validate_move("工作/项目A", "工作/项目B") == "工作/项目B"


def test_validate_move_allows_moving_to_a_similarly_named_sibling():
    # `工作/项目A` → `工作/项目A2`：A2 不是 A 的子孙，只是名字像
    assert cp.validate_move("工作/项目A", "工作/项目A2") == "工作/项目A2"


def test_check_resulting_depth_catches_a_subtree_pushed_past_the_limit():
    """只校验目标路径自己的深度不够：子树整体下移时底下每一层都跟着变深。"""
    deep_leaf = "a/" + "/".join(f"b{i}" for i in range(cp.MAX_DEPTH - 1))
    with pytest.raises(cp.CategoryPathError) as exc:
        cp.check_resulting_depth(deep_leaf, "a", "x/y/a")
    assert exc.value.code == "notes.category_too_deep"


def test_check_resulting_depth_is_a_noop_for_an_unrelated_path():
    cp.check_resulting_depth("生活/旅行", "工作", "归档")  # 不该抛
