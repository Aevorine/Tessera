"""F 组性能指标：把目标变成会失败的守卫。
本文件覆盖无头环境可测的 F37 极速扫描、F38 深度扫描、F41 峰值内存，以及结构性保证：
扫描期间后端必须持续发心跳，否则界面空闲超时会把正在跑的体检判负。
F39（帧率）、F42（首屏可交互）需真实渲染，靠发布前人工实测，不写永远通过的空断言。"""

from __future__ import annotations

import os
import re
import tempfile
import threading
import time
from pathlib import Path

import pytest

from modules.file_vault.pcclean import service as svc_mod
from modules.file_vault.pcclean.service import PcCleanService

pytestmark = pytest.mark.skipif(os.name != "nt", reason="清理套件只在 Windows 上有意义")

# 极速档两条线用 min-of-N 而非单次计时：本机磁盘吞吐噪声 ±30%，单次采样的守卫会随机红。
# 最快一次 ≤ 3s：兑现"极速"。最慢一次 ≤ 10s：拦住慢扫描混入极速档，故意放松，只拦数量级错误。
FAST_RUNS = 3
FAST_BEST_BUDGET_S = 3.0
FAST_WORST_BUDGET_S = 10.0

# 标准档九类。慢项是 `schtasks /Query`（实测 5~9 秒），给到 60 秒是
# 最坏情况的六倍以上；超过说明真的有东西跑飞了。
STANDARD_BUDGET_S = 60.0

FAST_CATEGORIES = ["junk", "browserCache", "privacy", "memory"]

_PCCLEAN_TS = (Path(__file__).resolve().parents[1]
               / "ui" / "src" / "lib" / "pcclean.ts")


def _fast_budget_from_ui() -> float:
    """极速档每类的预算从界面源码读取，不在此另写一份，
    否则界面改了测试没改，守卫测的就不是用户实际用的东西。"""
    text = _PCCLEAN_TS.read_text(encoding="utf-8")
    block = re.search(r"fast:\s*\{(.*?)\n  \}", text, re.S)
    assert block, "lib/pcclean.ts 里找不到 SCAN_MODES.fast —— 极速档被改名或删了？"
    budget = re.search(r"budgets:\s*\{[^}]*?junk:\s*([\d.]+)", block.group(1))
    assert budget, "SCAN_MODES.fast 里没有 junk 的预算"
    return float(budget.group(1))


@pytest.fixture()
def service(tmp_path: Path) -> PcCleanService:
    return PcCleanService(tmp_path)


def _run_fast(service: PcCleanService, scan_id: str):
    """跑一次极速档，返回 (耗时秒, 结果)。必须 `use_cache=False`，否则量的是读 JSON 的耗时。"""
    budget = _fast_budget_from_ui()
    started = time.perf_counter()
    result = service.health_check({
        "categories": FAST_CATEGORIES,
        "use_cache": False,
        "budgets": {c: budget for c in FAST_CATEGORIES},
    }, scan_id=scan_id)
    return time.perf_counter() - started, result


def test_fast_scan_finishes_within_its_budget(service: PcCleanService) -> None:
    """F37：极速扫一扫——最快一次 ≤ 3 秒，最慢一次 ≤ 10 秒。"""
    samples = []
    last = None
    for n in range(FAST_RUNS):
        elapsed, result = _run_fast(service, f"perf-fast-{n}")
        assert result["ok"] is True
        samples.append(elapsed)
        last = result

    best, worst = min(samples), max(samples)
    shown = ", ".join(f"{s:.2f}s" for s in samples)
    assert best < FAST_BEST_BUDGET_S, (
        f"极速档 {FAST_RUNS} 次里最快的一次是 {best:.2f}s（全部：{shown}），"
        f"超出 {FAST_BEST_BUDGET_S}s —— 这台机器状态最好的时候都达不到"
        f"「极速」这个名字。各类耗时："
        f"{ {c: p.get('elapsed_ms') for c, p in last['categories'].items()} }"
    )
    assert worst < FAST_WORST_BUDGET_S, (
        f"极速档最慢的一次是 {worst:.2f}s（全部：{shown}）—— 这不是抖动，"
        f"是有慢扫描被塞进了极速档"
    )

    # 跑得快但什么都没扫到，等于把功能关掉换来的速度。
    assert set(last["categories"]) == set(FAST_CATEGORIES), (
        f"极速档少扫了类：{set(FAST_CATEGORIES) - set(last['categories'])}"
    )


def test_standard_scan_finishes_within_its_budget(service: PcCleanService) -> None:
    """F38：标准体检 ≤ 60 秒，且九类一个都不能少。"""
    started = time.perf_counter()
    result = service.health_check({"use_cache": False}, scan_id="perf-standard")
    elapsed = time.perf_counter() - started

    assert result["ok"] is True
    assert elapsed < STANDARD_BUDGET_S, f"标准体检跑了 {elapsed:.2f}s，超出 {STANDARD_BUDGET_S}s"
    assert len(result["categories"]) + len(result["errors"]) == len(PcCleanService.HEALTH_CATEGORIES)


def test_scan_never_goes_silent_long_enough_to_be_declared_dead(
    service: PcCleanService,
) -> None:
    """扫描期间的最长沉默必须远短于界面空闲超时。
    「这次扫描没跑完」的根因是 `ui/electron/pythonBridge.ts` 的空闲超时先判负；
    修法是桥接层放宽预算加后端每 2 秒心跳，本条测后者（前者见 `ui/tests/backendSilentTimeout.test.mjs`）。
    门槛 10 秒：约为桥接预算 180 秒的 1/18，余量大又能抓住心跳被删（无心跳时最长沉默=最慢一类，schtasks 实测 5~9 秒）。"""
    stamps: list[float] = []
    lock = threading.Lock()
    started = time.perf_counter()

    def on_progress(_done: int, _total: int) -> None:
        with lock:
            stamps.append(time.perf_counter() - started)

    service.health_check({"use_cache": False}, scan_id="perf-heartbeat",
                         on_progress=on_progress)

    assert stamps, "整轮扫描一条进度都没发过——界面必然把它判成卡死"
    gaps = [stamps[0]] + [stamps[i] - stamps[i - 1] for i in range(1, len(stamps))]
    worst = max(gaps)
    assert worst < 10.0, (
        f"最长沉默 {worst:.2f}s。心跳应该把它压在 {svc_mod.HEARTBEAT_INTERVAL_S}s 附近；"
        f"这么长说明心跳没在跑，界面会重新开始把正常扫描判成失败"
    )


def test_heartbeat_survives_a_callback_that_raises(service: PcCleanService) -> None:
    """心跳回调抛异常不能把扫描带崩；安全网出问题最差应是"没有网"，而非连累被保护的流程。"""
    calls = {"n": 0}

    def angry(_done: int, _total: int) -> None:
        calls["n"] += 1
        raise RuntimeError("progress sink exploded")

    result = service.health_check({
        "categories": FAST_CATEGORIES,
        "use_cache": False,
    }, scan_id="perf-angry", on_progress=angry)

    assert result["ok"] is True, "进度回调抛异常把整轮扫描带崩了"
    assert calls["n"] > 0


@pytest.mark.parametrize("budget_s", [1.0, 2.0])
def test_time_budget_actually_bounds_a_scan(service: PcCleanService, budget_s: float) -> None:
    """给一类多少秒预算，它就该在多少秒左右收工（端到端量，曾抓到真 bug）。
    scanner 给 `paths.iter_files` / `paths.dir_size` 传的是 `task.should_cancel`（只含用户取消，
    不含时间预算，预算在 `task.cancelled()` 里），导致单个大目录遍历一旦开始就跑到底，
    实测 0.8 秒预算跑了 5.26 秒，报告还写 `timed_out: True`；全仓库 15 处同错。
    允许 2.5 倍超出：协作式检查点之间要跑完，磁盘噪声 ±30%；只拦数量级失效。"""
    started = time.perf_counter()
    result = service.health_check({
        "categories": ["junk"],
        "use_cache": False,
        "budgets": {"junk": budget_s},
    }, scan_id=f"budget-{budget_s}")
    elapsed = time.perf_counter() - started

    assert result["ok"] is True
    ceiling = budget_s * 2.5 + 1.0
    assert elapsed < ceiling, (
        f"给了 {budget_s}s 预算，实际跑了 {elapsed:.2f}s（上限 {ceiling:.2f}s）。"
        f"检查各 scanner 是不是又把 `task.should_cancel` 而不是 `task.cancelled` "
        f"传进了 paths.iter_files / paths.dir_size —— 前者不含时间预算。"
    )


def test_instant_categories_do_not_queue_behind_slow_ones(
    service: PcCleanService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """并发少的机器上，毫秒级的类不许排在秒级的后面。
    线程池按提交顺序取任务，`workers` 少时顺序决定用户多久看到内容；
    本机 SSD 下 `_adaptive_workers()` 为 8 看不出差别，故强行压到 2 模拟机械盘。
    固定顺序下三个瞬时类排在 `startup`（schtasks，5~9 秒）后要 8.46 秒，按历史耗时升序派工为 0.12 秒；
    首块内容时间不变。门槛 3 秒：回归会跳到 8 秒量级，离抖动足够远。"""
    monkeypatch.setattr(svc_mod, "_adaptive_workers", lambda: 2)

    started = time.perf_counter()
    arrivals: dict[str, float] = {}

    def on_category(name: str, _payload: dict) -> None:
        arrivals.setdefault(name, time.perf_counter() - started)

    service.health_check({"use_cache": False}, scan_id="order-1",
                         on_category=on_category)

    instant = ["memory", "privacy", "browserCache"]
    missing = [c for c in instant if c not in arrivals]
    assert not missing, f"这几类根本没回来：{missing}"

    slowest_instant = max(arrivals[c] for c in instant)
    assert slowest_instant < 3.0, (
        f"三个瞬时类全部到齐用了 {slowest_instant:.2f}s（各自："
        f"{ {c: round(arrivals[c], 2) for c in instant} }）。"
        f"它们大概又被排到 startup 后面了 —— 检查 health_check 里 dispatch 的排序。"
    )


def test_preview_reports_real_disk_numbers(service: PcCleanService) -> None:
    """清理预演必须真的跑出来，且盘符数字不能是反的（端到端实测抓出）。
    在 `service.preview` 里：
      ① `_drive_of()` 交回裸盘符 `"C"`，而 `GetDiskFreeSpaceExW` 要 `"C:\\"`，抛 `OSError` 炸掉整个 preview。
      ② `_disk_space` 返回 `(total, free)`，却按 `(free, total)` 解包；①不修②永远暴露不了。
    断言用关系而非具体数字：可用空间 < 总容量、清理后 ≥ 清理前。"""
    report = service.scan("diskSlimming", {}, scan_id="prev-1")
    assert report["ok"] is True
    ids = [i["item_id"] for i in report["items"] if not i["locked"]]
    if not ids:
        pytest.skip("这台机器的系统盘没有可清理的瘦身项")

    result = service.preview(ids)
    assert result["ok"] is True, f"预演没跑起来：{result.get('error')}"
    assert result["dry_run"] is True
    assert result["drives"], "预演没有给出任何盘的数字——`_disk_space` 大概又被喂了裸盘符"

    for drive in result["drives"]:
        total = drive["total_bytes"]
        free_before = drive["free_before"]
        assert total > 0, f"{drive['drive']} 盘总容量是 {total}"
        assert 0 <= free_before <= total, (
            f"{drive['drive']} 盘可用 {free_before} 大于总容量 {total} —— "
            f"free 和 total 解包反了"
        )
        assert drive["free_after_max"] >= free_before, "清理后的可用空间不该比清理前少"


def test_failed_category_reports_a_reason_not_just_a_flag() -> None:
    """F-可解释：某一类失败时必须回结构化原因，而非一句"没跑完"；喂一个会炸的 scanner，检查 `failures[]` 信息够画卡片。"""
    with tempfile.TemporaryDirectory() as tmp:
        service = PcCleanService(Path(tmp))
        original = service._scanners

        def broken():
            table = original()

            def boom(_task, _options):
                raise PermissionError("拒绝访问: C:\\Windows\\System32\\config")

            table["registry"] = boom
            return table

        service._scanners = broken  # type: ignore[method-assign]
        result = service.health_check({
            "categories": ["registry", "memory"],
            "use_cache": False,
        }, scan_id="perf-broken")

    reports = result["categories"]
    assert reports["registry"]["ok"] is False
    assert "PermissionError" in reports["registry"]["error"]
    # 光有异常类型名不够 —— 用户看到 "PermissionError" 仍然不知道该干什么。
    assert "拒绝访问" in reports["registry"]["detail"], (
        "失败原因没带上原文，界面上只能显示一个类型名，等于没说"
    )
