"""诊断日志的行为约束：它必须在金库锁着、甚至解锁失败时也能写（那正是最需要日志的场景，加密库
打不开），所以是明文 JSONL，也因此默认必须关闭。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import diagnostic_log as dl  # noqa: E402


def test_disabled_by_default_and_writes_nothing(tmp_path):
    assert dl.is_enabled(tmp_path) is False, "日志必须默认关闭"

    dl.record(tmp_path, "crossdevice", "连不上", detail="timeout")

    assert not dl.log_path(tmp_path).exists(), (
        "关闭状态下一个字节都不该写——默认收集日志本身就是隐私问题"
    )
    assert dl.read_all(tmp_path) == []


def test_records_only_after_being_turned_on(tmp_path):
    dl.set_enabled(tmp_path, True)
    assert dl.is_enabled(tmp_path) is True

    dl.record(tmp_path, "fileops", "快捷键没生效", detail="WinError 2", code="E2")
    entries = dl.read_all(tmp_path)

    assert len(entries) == 1
    assert entries[0]["module"] == "fileops"
    assert entries[0]["problem"] == "快捷键没生效"
    assert entries[0]["code"] == "E2"
    assert "at" in entries[0]


def test_turning_off_stops_recording(tmp_path):
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "a", "第一条")
    dl.set_enabled(tmp_path, False)
    dl.record(tmp_path, "b", "第二条不该被记下")

    entries = dl.read_all(tmp_path)
    problems = [e["problem"] for e in entries]
    assert "第一条" in problems
    assert "第二条不该被记下" not in problems


def test_newest_first(tmp_path):
    dl.set_enabled(tmp_path, True)
    for i in range(5):
        dl.record(tmp_path, "m", f"第{i}条")
    entries = dl.read_all(tmp_path)
    assert entries[0]["problem"] == "第4条", "最新的应当排最前面"


def test_clear_all_really_deletes(tmp_path):
    dl.set_enabled(tmp_path, True)
    for i in range(3):
        dl.record(tmp_path, "m", f"第{i}条")

    removed = dl.clear_all(tmp_path)

    assert removed == 3
    assert dl.read_all(tmp_path) == []
    assert not dl.log_path(tmp_path).exists(), "全部删除就该真的把文件删掉"


def test_corrupt_line_does_not_break_reading(tmp_path):
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "m", "好的一条")
    with dl.log_path(tmp_path).open("a", encoding="utf-8") as fh:
        fh.write("{ 这不是合法 JSON\n")
    dl.record(tmp_path, "m", "后面的一条")

    entries = dl.read_all(tmp_path)
    problems = [e["problem"] for e in entries]
    assert "好的一条" in problems and "后面的一条" in problems, (
        "一行坏数据不该让整份日志读不出来"
    )


def test_detail_is_truncated(tmp_path):
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "m", "问题", detail="x" * 5000)
    entries = dl.read_all(tmp_path)
    assert len(entries[0]["detail"]) < 600, "超长 detail 必须截断，避免日志被撑爆"


# 按 uid 删除：改造前只有"全部删除"，勾选不影响删什么；下面几条钉住"勾选是真的"。


def test_delete_removes_only_the_chosen_entries(tmp_path):
    dl.set_enabled(tmp_path, True)
    for i in range(5):
        dl.record(tmp_path, f"m{i}", f"第{i}条")
    entries = dl.read_all(tmp_path)
    victims = [entries[1]["uid"], entries[3]["uid"]]

    removed = dl.delete(tmp_path, victims)

    left = [e["problem"] for e in dl.read_all(tmp_path)]
    assert removed == 2
    assert len(left) == 3
    assert entries[1]["problem"] not in left and entries[3]["problem"] not in left
    assert entries[0]["problem"] in left, "没勾的条目一条都不能少"


def test_delete_with_empty_list_removes_nothing(tmp_path):
    """空选择必须当成"什么都不删"，不能当成"全选"——那是删除接口最经典的翻车。"""
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "m", "留着")

    assert dl.delete(tmp_path, []) == 0
    assert len(dl.read_all(tmp_path)) == 1


def test_uids_are_unique(tmp_path):
    """uid 撞了会导致删一条连带删掉另一条，而这种 bug 只在高频出错时才复现。"""
    dl.set_enabled(tmp_path, True)
    for i in range(50):
        dl.record(tmp_path, f"m{i}", f"第{i}条")
    uids = [e["uid"] for e in dl.read_all(tmp_path)]
    assert len(uids) == len(set(uids))


# 重复折叠：折叠是就地截断重写最后一行，偏移量算错会把整份日志写坏。


def test_repeats_fold_into_one_entry_with_a_count(tmp_path):
    dl.set_enabled(tmp_path, True)
    for _ in range(4):
        dl.record(tmp_path, "crossdevice", "连不上", code="cd.timeout")

    entries = dl.read_all(tmp_path)
    assert len(entries) == 1, "连着刷屏的同一条不该占满整份日志"
    assert entries[0]["count"] == 4


def test_fold_does_not_corrupt_earlier_lines(tmp_path):
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "first", "最早的一条")
    for _ in range(3):
        dl.record(tmp_path, "hot", "刷屏中", code="hot")

    entries = dl.read_all(tmp_path)
    assert [e["problem"] for e in entries] == ["刷屏中", "最早的一条"]
    assert entries[0]["count"] == 3
    raw = dl.log_path(tmp_path).read_bytes()
    assert raw.endswith(b"\n") and raw.count(b"\n") == 2, "就地重写不能留下截断残渣"


def test_different_entry_between_repeats_is_not_merged(tmp_path):
    """夹着别的事件再次出现，说明中间发生了别的事——那是有价值的时间线。"""
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "m", "A")
    dl.record(tmp_path, "m", "B")
    dl.record(tmp_path, "m", "A")

    assert [e["problem"] for e in dl.read_all(tmp_path)] == ["A", "B", "A"]


def test_recording_after_delete_appends_instead_of_overwriting(tmp_path):
    """删除重写过文件，内存里缓存的偏移量必须作废，否则下一条会写到错位置。"""
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "m", "第一条")
    dl.record(tmp_path, "m", "第二条")
    dl.delete(tmp_path, [dl.read_all(tmp_path)[-1]["uid"]])

    dl.record(tmp_path, "m", "第三条")

    problems = [e["problem"] for e in dl.read_all(tmp_path)]
    assert problems == ["第三条", "第二条"]


# --- 筛选与统计 -------------------------------------------------------------


def test_query_filters_and_still_reports_all_modules(tmp_path):
    """筛完之后模块清单不能只剩当前筛出来的那个，否则用户切不回去。"""
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "pcclean", "扫描没跑完", level="warn")
    dl.record(tmp_path, "crossdevice", "连不上", code="cd.timeout")

    result = dl.query(tmp_path, levels=["error"])

    assert [e["module"] for e in result["entries"]] == ["crossdevice"]
    assert result["matched"] == 1 and result["total"] == 2
    assert result["modules"] == ["crossdevice", "pcclean"]


def test_query_search_matches_code_and_detail(tmp_path):
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "m", "某个问题", detail="WinError 2", code="E2")
    dl.record(tmp_path, "m", "另一个问题", code="E5")

    assert dl.query(tmp_path, search="winerror")["matched"] == 1
    assert dl.query(tmp_path, search="E5")["matched"] == 1


def test_stats_count_occurrences_not_just_lines(tmp_path):
    """折叠之后行数和实际发生次数不是一回事，统计要按发生次数算。"""
    dl.set_enabled(tmp_path, True)
    for _ in range(3):
        dl.record(tmp_path, "crossdevice", "连不上", code="cd.timeout")
    dl.record(tmp_path, "pcclean", "扫描没跑完", level="warn")

    summary = dl.stats(tmp_path)

    assert summary["lines"] == 2 and summary["occurrences"] == 4
    assert summary["by_level"] == {"error": 3, "warn": 1, "info": 0}
    assert summary["top_problems"][0] == {
        "module": "crossdevice", "problem": "连不上", "count": 3,
    }


def test_report_contains_no_paths_or_machine_names(tmp_path):
    """报告是拿去发给别人看的，路径、用户名、机器名一律不能出现在里面。"""
    dl.set_enabled(tmp_path, True)
    dl.record(tmp_path, "fileops", "快捷键没生效", code="E2")

    report = dl.build_report(tmp_path)

    assert "快捷键没生效" in report and "fileops" in report
    assert str(tmp_path) not in report
    assert "\\Users\\" not in report and "/Users/" not in report


def test_legacy_entries_survive_the_upgrade(tmp_path):
    """老版本写的行没有 uid/ts/level/count。丢掉它们等于让用户攒着准备排查的
    日志在升级后凭空消失。"""
    dl.set_enabled(tmp_path, True)
    dl.log_path(tmp_path).write_text(
        '{"at": "2026-01-02 03:04:05", "module": "old", '
        '"problem": "老格式", "code": "", "detail": ""}\n',
        encoding="utf-8",
    )

    entries = dl.read_all(tmp_path)

    assert len(entries) == 1
    assert entries[0]["problem"] == "老格式"
    assert entries[0]["level"] == "error" and entries[0]["count"] == 1
    assert entries[0]["uid"], "补出来的 uid 要能支撑一次「选中 → 删除」"
    assert dl.delete(tmp_path, [entries[0]["uid"]]) == 1
