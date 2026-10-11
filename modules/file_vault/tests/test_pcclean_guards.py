"""性质守卫：每条都先拿已知坏版本验证过会红；
刻意钉在性质（如"干跑不碰磁盘"）而非实现行号上，避免无关重构误报。"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from modules.file_vault.pcclean import actions, cachestore, schedule, service, userrules
from modules.file_vault.pcclean.model import CleanItem, Importance, ScanTask


def _item(item_id: str, category: str, **kwargs) -> CleanItem:
    return CleanItem(
        item_id=item_id,
        category=category,
        label=kwargs.pop("label", item_id),
        size_bytes=kwargs.pop("size_bytes", 0),
        path=kwargs.pop("path", ""),
        importance=kwargs.pop("importance", Importance.OPTIONAL),
        **kwargs,
    )


# E4 零不可逆删除：可逆性标注必须与真实执行分支一致


def test_reversibility_matches_the_real_execute_branches():
    """预演屏说"进回收站"，真实执行就必须真进回收站；
    两处分叉是不报错的承诺落空，比崩溃更严重。"""
    for category in actions._RECYCLE_CATEGORIES:
        assert actions.reversibility(_item("x", category)) == "recycle", category
    for category in actions._HARD_DELETE_CATEGORIES:
        assert actions.reversibility(_item("x", category)) == "permanent", category
    # `popupSources` 曾漏在列表外，在 reversibility() 里落入兜底 `permanent`，
    # 而实际走可撤销的 `_startup_disable`；方向保守但仍是判据分叉，守卫就是禁止分叉。
    for category in ("registry", "startup", "popupSources", "contextMenu", "plugins"):
        assert actions.reversibility(_item("x", category)) == "restorable", category

    # 没见过的类别必须落到最保守的一档。落到 "recycle" 的话，一个将来新增的
    # 硬删除类别会自动获得一句"能从回收站拉回来"的假承诺。
    assert actions.reversibility(_item("x", "some_future_category")) == "permanent"


def test_custom_rules_never_hard_delete(tmp_path: Path):
    """用户自定义规则匹配到的文件一律进回收站：
    内置规则审过而用户规则未审，写宽了可能误中想留的文件。"""
    assert "custom" in actions._RECYCLE_CATEGORIES
    assert "custom" not in actions._HARD_DELETE_CATEGORIES
    assert actions.reversibility(_item("x", "custom")) == "recycle"


# D3 干跑必须什么都不做


def test_dry_run_touches_nothing_at_all(tmp_path: Path):
    target = tmp_path / "victim.bin"
    target.write_bytes(b"x" * 4096)
    before = target.stat()

    result = actions.execute(tmp_path, [
        _item("a", "bigFiles", path=str(target), size_bytes=4096),
        _item("b", "junk", path=str(tmp_path / "cache"), size_bytes=1000,
              importance=Importance.JUNK),
        _item("c", "registry", path="HKCU/Software/Nope"),
    ], dry_run=True)

    after = target.stat()
    assert target.exists()
    assert (after.st_size, after.st_mtime) == (before.st_size, before.st_mtime)

    payload = result.to_dict()
    assert payload["dry_run"] is True
    assert payload["preview"] == 3
    assert payload["done"] == 0
    # 干跑没做任何事，自然没有东西可撤销。报 True 的话界面会给出一个点了
    # 什么也不会发生的"撤销"按钮。
    assert payload["undoable"] is False
    # 干跑不写审计：审计记的是"做过什么"，而干跑什么都没做。
    assert not (tmp_path / "pcclean" / actions.AUDIT_FILE_NAME).exists()
    # 也不能真的去建还原点——那是个几秒钟的系统调用。
    assert result.restore_point.get("planned") is True
    assert "ok" not in result.restore_point


def test_dry_run_still_refuses_locked_and_critical(tmp_path: Path):
    """干跑走的必须是**同一套**前置检查，否则预演屏会展示一批真实执行时
    根本不会碰的东西。"""
    result = actions.execute(tmp_path, [
        _item("locked", "junk", locked=True),
        _item("critical", "junk", importance=Importance.CRITICAL),
        _item("fine", "junk"),
    ], dry_run=True)
    statuses = {o.item_id: o.status for o in result.outcomes}
    assert statuses == {"locked": "skipped", "critical": "skipped", "fine": "preview"}


# D5 审计日志绝不能记录文件路径


def test_audit_log_never_records_a_file_path(tmp_path: Path):
    """一份完整的个人文件路径清单，比这个日志要保护的东西还敏感。"""
    secret = tmp_path / "tax-return-2025.pdf"
    secret.write_bytes(b"y" * 512)
    actions.execute(tmp_path, [
        _item("a", "bigFiles", path=str(secret), size_bytes=512, label=secret.name),
    ])

    raw = (tmp_path / "pcclean" / actions.AUDIT_FILE_NAME).read_text(encoding="utf-8")
    assert raw.strip(), "audit line should have been written"
    assert str(secret) not in raw
    assert secret.name not in raw
    assert "tax-return" not in raw

    entries = actions.read_audit(tmp_path)
    assert entries and entries[0]["by_category"] == {"bigFiles": 1}


# A2 超时预算必须是协作式的，且交回已扫到的部分


def test_budget_trips_cancelled_and_is_reported_separately():
    task = ScanTask(category="x", budget_s=0.05)
    assert task.cancelled() is False
    assert task.timed_out() is False

    time.sleep(0.08)
    # 超预算后 scanner 看到的就是"该停了"，它不需要知道为什么。
    assert task.cancelled() is True
    assert task.timed_out() is True

    report = task.report([_item("kept", "junk")])
    # 交回已经扫到的部分，而不是丢掉。
    assert len(report.items) == 1
    assert report.timed_out is True
    assert report.to_dict()["timed_out"] is True


def test_user_cancel_is_not_reported_as_a_timeout():
    """两者都让 `cancelled()` 为真，但界面上的措辞完全不同：一个是"你取消了"，
    一个是"这一类太慢，可以重扫"。混在一起会让用户以为自己的取消失败了。"""
    task = ScanTask(category="x", should_cancel=lambda: True, budget_s=3600.0)
    assert task.cancelled() is True
    assert task.timed_out() is False
    assert task.report([]).timed_out is False


# B4 定时清理的类别白名单必须无条件生效


def test_schedule_clamps_categories_even_when_the_file_is_tampered_with(tmp_path: Path):
    """配置文件可被直接改（如 categories 改成 `["software"]` 会自动卸载软件），
    所以裁剪在读取时也要做，不能只在写入时。"""
    schedule.save_config(tmp_path, {"enabled": True, "mode": "clean"})
    path = tmp_path / "pcclean" / schedule.CONFIG_FILE_NAME
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["categories"] = ["software", "registry", "startup"]
    raw["interval"] = "every-minute"
    path.write_text(json.dumps(raw), encoding="utf-8")

    loaded = schedule.load_config(tmp_path)
    assert loaded["categories"] == list(schedule.SAFE_CATEGORIES)
    assert loaded["interval"] == "weekly"


def test_safe_categories_stay_regenerable_only():
    """自动清理只许碰"删了会自己回来"的东西；
    将来想把 `downloads` 或 `privacy` 加进 SAFE_CATEGORIES 会被此测试拦住。"""
    assert set(schedule.SAFE_CATEGORIES) == {"junk", "browserCache"}


# B5 自定义规则的安全边界


@pytest.mark.parametrize("root, expected", [
    ("C:\\", "pcclean.rules.driveRootForbidden"),
    ("D:\\", "pcclean.rules.driveRootForbidden"),
    ("C:\\Windows\\Temp", "pcclean.rules.systemPathForbidden"),
    ("C:\\Program Files", "pcclean.rules.systemPathForbidden"),
])
def test_dangerous_roots_are_refused_not_warned_about(root, expected, tmp_path: Path):
    """拒绝而不是警告。把 `C:\\Users\\me\\Downloads` 删剩一个 `C:\\`
    只是一次退格的事，而这条规则会在每次体检时自动跑。"""
    with pytest.raises(userrules.RuleError) as caught:
        userrules.validate_root(root, tmp_path)
    assert str(caught.value) == expected


def test_the_vault_data_dir_and_its_parent_are_both_refused(tmp_path: Path):
    """让清理工具能删掉自己的金库是荒唐的。父目录同样要挡——清父目录会连着
    把金库一起带走，而用户看到的规则上写的是父目录。"""
    vault = tmp_path / "nested" / "vault"
    vault.mkdir(parents=True)
    for candidate in (vault, vault.parent):
        with pytest.raises(userrules.RuleError) as caught:
            userrules.validate_root(str(candidate), vault)
        assert str(caught.value) == "pcclean.rules.vaultPathForbidden"


@pytest.mark.parametrize("patterns", [[], ["*"], ["*.*"], ["**"], ["sub/*.log"]])
def test_patterns_that_mean_everything_are_refused(patterns):
    with pytest.raises(userrules.RuleError):
        userrules.validate_patterns(patterns)


def test_custom_scan_matches_only_the_pattern_and_never_preselects(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    (work / "a.log").write_text("x")
    (work / "keep.txt").write_text("y")
    (work / "sub").mkdir()
    (work / "sub" / "deep.log").write_text("z")

    userrules.upsert_rule(vault, {
        "root": str(work), "patterns": ["*.log"], "min_age_days": 0,
    })
    report = userrules.scan_custom(ScanTask(category="custom"), data_dir=vault)

    assert [i.label for i in report.items] == ["a.log"]
    # 规则写宽了的后果不该由"我们替他勾上了"来承担。
    assert all(not i.default_selected for i in report.items)
    assert all(i.importance == Importance.OPTIONAL for i in report.items)


# A1 落盘缓存：显示可以旧，执行不可以


def test_cache_older_than_the_execute_ttl_is_shown_but_not_executable(tmp_path: Path):
    item = _item("a", "junk", path=str(tmp_path / "f"), size_bytes=10)
    cachestore.save_health(tmp_path, {
        "categories": {"junk": {"ok": True, "items": [item.to_dict()],
                                "selectable_bytes": 10}},
        "summary": {},
    })

    fresh = cachestore.load_health(tmp_path, execute_ttl_s=900)
    assert fresh is not None and fresh["fresh_enough_to_execute"] is True

    # 同一份缓存，换一个更短的执行窗口：仍然显示，但不再可执行。
    aged = cachestore.load_health(tmp_path, execute_ttl_s=0)
    assert aged is not None, "stale cache must still be displayable"
    assert aged["fresh_enough_to_execute"] is False


def test_timed_out_categories_are_not_cached(tmp_path: Path):
    """残缺的结果存下来，下次开机会铺一个偏小的数字，而用户无从知道它是残缺的。"""
    saved = cachestore.save_health(tmp_path, {
        "categories": {"startup": {"ok": True, "timed_out": True, "items": []}},
        "summary": {},
    })
    assert saved is False
    assert cachestore.load_health(tmp_path, execute_ttl_s=900) is None


def test_timing_estimate_uses_the_median_not_the_mean(tmp_path: Path):
    """磁盘偶尔被别的进程占住会跑出一次 5 倍耗时。平均值会被这一个样本永久
    带偏，中位数不会——而进度条上一个错的剩余时间比没有更糟。"""
    for sample in (100, 110, 120, 5000, 130):
        cachestore.record_timing(tmp_path, {"junk": sample})
    assert cachestore.estimates(tmp_path)["junk"] == 120


# A5 剩余时间只许高估，不许低估


def test_eta_never_undershoots_the_slowest_remaining_category():
    """报短了每一次都是"说好 3 秒结果等了 9 秒"。"""
    eta = service.PcCleanService._eta_ms(
        {"junk", "startup"}, {"junk": 1000, "startup": 8000}, workers=4)
    assert eta >= 8000

    # 工人不够时要排队，此时总时长由总量除以并发数决定，而不是最慢的那一个。
    many = {f"c{i}": 3000 for i in range(8)}
    assert service.PcCleanService._eta_ms(set(many), many, workers=2) >= 12000


def test_eta_is_zero_when_there_is_no_history():
    """没有样本就说"计算中"，**不编一个数字**。"""
    assert service.PcCleanService._eta_ms({"junk"}, {}, workers=4) == 0


# A3 并发度：机械盘上必须收敛


def test_worker_count_collapses_on_a_mechanical_disk(monkeypatch):
    """六个线程同时读不同目录 = 磁头来回颠簸，总时间比串行还长。
    HDD 上并发的收益是负的。"""
    from modules.file_vault.pcclean import space

    drive = service.paths.system_drive().rstrip(":\\").upper()

    monkeypatch.setattr(space, "cached_media_types", lambda: {drive: "HDD"})
    assert service._adaptive_workers() == 2

    monkeypatch.setattr(space, "cached_media_types", lambda: {drive: "SSD"})
    assert 2 <= service._adaptive_workers() <= 8

    # 探测失败时回落值必须对两种介质都不算灾难，而不是取乐观值。
    def _boom():
        raise OSError("no wmi")

    monkeypatch.setattr(space, "cached_media_types", _boom)
    assert service._adaptive_workers() <= 4


def test_choosing_a_worker_count_never_runs_the_slow_probe(monkeypatch):
    """并发度选择绝不能触发介质探测：`space._media_types()` 的 PowerShell + CIM
    查询首次要 4~9 秒，会让一键体检在扫描前白等；用户等待路径上的调优必须比它省下的时间更便宜。"""
    from modules.file_vault.pcclean import space

    called = []

    def _must_not_be_called():
        called.append(1)
        raise AssertionError("_adaptive_workers 不许触发慢探测")

    monkeypatch.setattr(space, "_media_types", _must_not_be_called)
    monkeypatch.setattr(space, "cached_media_types", dict)
    # 后台预热线程也不许在这里被拉起来跑真探测——把它按住。
    monkeypatch.setattr(service, "_warm_media_types", lambda: None)

    workers = service._adaptive_workers()
    assert called == [], "并发度选择碰了慢探测"
    assert 2 <= workers <= 8


def test_cached_media_types_never_shells_out(monkeypatch):
    """`cached_media_types()` 只能"有就给、没有就算"，不许去探测。
    验证行为（按住外部调用看它动不动），而非匹配源码文本——后者会被 docstring 字样误报。"""
    from modules.file_vault.pcclean import space

    def _must_not_run(*args, **kwargs):
        raise AssertionError("cached_media_types 不许起外部进程")

    monkeypatch.setattr(space, "_run", _must_not_run)
    monkeypatch.setattr(space, "_MEDIA_CACHE", {}, raising=False)
    assert space.cached_media_types() == {}


# junk 是硬删除档：进来的条目必须是系统产生、可再生的


def test_info_only_junk_rules_produce_locked_items(tmp_path: Path, monkeypatch):
    """`info_only` 规则必须产出 `locked=True`，否则会走 `_HARD_DELETE_CATEGORIES`
    的永久删除（不进回收站、无 undo），对用户自建内容（如安卓模拟器镜像）是灾难。
    守卫钉在"info_only ⇒ locked"这条性质上，而非某个规则名。"""
    from modules.file_vault.pcclean import junk as junk_mod

    target = tmp_path / "avd"
    target.mkdir()
    (target / "big.img").write_bytes(b"x" * 4096)

    rule = junk_mod.JunkRule(
        "fixtureInfoOnly", lambda: target, Importance.OPTIONAL,
        default_selected=False, whole_dir=True, info_only=True,
    )
    item = junk_mod._scan_rule(rule, ScanTask(category="junk"), time.time())

    assert item is not None, "目录里有文件就该被看见"
    assert item.size_bytes == 4096, "只读不等于不报大小——让用户知道空间在哪正是它存在的理由"
    assert item.locked is True
    assert item.default_selected is False


def test_locked_junk_items_are_refused_by_the_executor(tmp_path: Path):
    """上一条证明扫描侧打了标，这一条证明执行侧认这个标；约定要两端都遵守才是保护。

    victim 必须是目录：junk 执行走 `_delete_tree_contents(root, ...)`，对文件本来就不动，
    用文件当 victim 时删掉 `locked` 检查也照样绿。
    """
    victim_dir = tmp_path / "avd-images"
    victim_dir.mkdir()
    inner = victim_dir / "userdata.img"
    inner.write_bytes(b"x" * 128)

    item = _item(
        "junk:fixtureInfoOnly", "junk", path=str(victim_dir), size_bytes=128,
        locked=True,
        detail={"patterns": [], "min_age_days": 0, "include_dirs": True,
                "whole_dir": True},
    )
    result = actions.execute(tmp_path, [item], create_restore_point=False)

    assert inner.exists(), "locked 条目被执行侧删掉了 —— 这正是它该拦的事"
    assert victim_dir.exists()
    assert all(o.status != "cleaned" for o in result.outcomes)


def test_android_avd_rule_is_info_only():
    """回归钉子：这条规则是带着"可删除"上线的，8.2 GB 用户自建虚拟设备
    差一点走上永久删除。改回可删除时必须有人重新想一遍这段。"""
    from modules.file_vault.pcclean import junk as junk_mod

    rule = next(r for r in junk_mod.JUNK_RULES if r.key == "androidAvd")
    assert rule.info_only is True
    assert rule.default_selected is False


# 重复文件：第一级预算用完时，也必须交回已确认的组


def test_duplicates_still_reports_groups_when_phase_one_runs_out_of_budget(
    tmp_path: Path, monkeypatch
):
    """三级筛选到第三级才产出第一组；原实现预算在第一级用完就让后两级 `break`，
    交回零组，等于告诉用户"没有重复文件"。现给前两级留软截止（45% / 75%），
    最后 25% 留给第三级，并标出 `truncated`。本守卫拖慢 `iter_files` 让预算在遍历中途用完。"""
    from modules.file_vault.pcclean import space

    # 六个根目录，各放一对相同的 2 MB 文件。必须多根：第一级截止只在"每个根之间"
    # 和"每 4000 个文件"判断，用例文件远不足 4000，单根触发不了软截止。
    roots = []
    for group_index in range(6):
        d = tmp_path / f"root{group_index}"
        d.mkdir()
        blob = bytes([65 + group_index]) * (2 * 1024 * 1024)
        entries = []
        for name in ("copy1.bin", "copy2.bin"):
            p = d / name
            p.write_bytes(blob)
            entries.append((p, len(blob)))
        roots.append((str(d), entries))

    by_root = dict(roots)

    def slow_iter(root, **kwargs):
        # 每个文件拖 0.3 秒 → 每个根 0.6 秒。预算 4 秒，第一级软截止在 45%
        # （1.8 秒），所以前三个根跑得完、第四个根开始前就被截住。
        for entry in by_root[str(root)]:
            time.sleep(0.3)
            yield entry

    monkeypatch.setattr(space.paths, "iter_files", slow_iter)

    task = ScanTask(category="duplicates", budget_s=4.0)
    report = space.scan_duplicates(
        task, roots=[r for r, _ in roots], min_size_kb=1024)

    groups = {i.detail["group"] for i in report.items}
    assert groups, "预算在第一级用完，第三级就没跑——这正是要修的那件事"
    assert 0 < len(groups) < 6, f"应当只覆盖了一部分根，实际 {len(groups)} 组"
    assert report.partial is True, "只覆盖了部分范围，必须标出来"
    # 钉住 partial 与 truncated 不许再合并：合并会使按 truncated 拒收的 D5 落盘缓存，
    # 对天然按 limit 截断的大文件扫描永远失效。
    assert report.truncated is False, "这里没有按 limit 截断，truncated 不该被顺手打上"


# E5 清理前后的真实可用空间：唯一能让用户自己核对的数字


def test_real_execute_records_free_space_but_dry_run_does_not(tmp_path: Path):
    """`freed_bytes` 由各项 size_bytes 相加，天然偏乐观（硬链接、被占用、进回收站只是挪位置），
    所以另记系统给出的可用空间供用户核对。干跑不量：没改任何东西，给 before/after 只会显示"变化 0 B"。"""
    victim = tmp_path / "cachedir"
    victim.mkdir()
    for n in range(3):
        (victim / f"f{n}.tmp").write_bytes(b"z" * 512_000)

    item = _item(
        "junk:fixture", "junk", path=str(victim), size_bytes=1_536_000,
        importance=Importance.JUNK,
        detail={"patterns": [], "min_age_days": 0, "include_dirs": True},
    )

    dry = actions.execute(tmp_path, [item], create_restore_point=False, dry_run=True)
    assert (dry.free_before, dry.free_after) == (0, 0)
    assert dry.to_dict()["free_before"] == 0

    real = actions.execute(tmp_path, [item], create_restore_point=False)
    payload = real.to_dict()
    assert payload["done"] == 1
    # 只断言"量到了"，不断言差额等于 freed_bytes —— 两者本来就会分叉，
    # 而那正是把它记下来的理由。钉死相等的话，第一次遇到硬链接就误报。
    assert payload["free_before"] > 0
    assert payload["free_after"] > 0

    entry = actions.read_audit(tmp_path)[0]
    assert entry["free_before"] > 0 and entry["free_after"] > 0, (
        "审计里没有这两个数的话，'上次清理到底管不管用'就永远查不回来了"
    )
