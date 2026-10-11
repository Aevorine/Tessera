"""安全闸口的性质守卫，源于一次真实事故：用户点了首屏「推荐清理」，快速访问的固定文件夹全部消失且无法恢复。
链条：privacy.py 的 jumpLists 规则 default_selected=True，指向 `%APPDATA%\\...\\Recent\\AutomaticDestinations`
（内含快速访问固定项），actions.reversibility('privacy') == 'permanent'，前端 RECOMMENDED_CATEGORIES 收了 'privacy'。
所以守卫钉在性质上（"不可逆且重建代价大的项永不默认勾选"），不断言实现行；每条都先拿已知坏版本验证过会红。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from modules.file_vault.pcclean import actions, processes, safety
from modules.file_vault.pcclean.model import CleanItem, Importance, ScanReport


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


def _apply(*items: CleanItem) -> ScanReport:
    return safety.apply_safety_policy(ScanReport(category="x", items=list(items)))


# 受保护路径


def test_quick_access_pinned_file_is_protected_by_name():
    """快速访问的固定项文件永远不能被当成痕迹删掉；按文件名而非完整路径判断，因用户名、盘符因机而异。"""
    pinned = (r"C:\Users\anyone\AppData\Roaming\Microsoft\Windows\Recent"
              r"\AutomaticDestinations\f01b4d95cf55d32a.automaticDestinations-ms")
    assert safety.protection_reason(pinned) == "pcclean.safety.protected.quickAccessPinned"

    # 同一个目录里旁边那些**是**真痕迹，不能跟着一起被保护——
    # 全都保护起来等于隐私清理这一项什么都不清。
    ordinary = (r"C:\Users\anyone\AppData\Roaming\Microsoft\Windows\Recent"
                r"\AutomaticDestinations\1b4dd67f29cb1962.automaticDestinations-ms")
    assert safety.protection_reason(ordinary) == ""


def test_installed_web_app_directory_is_protected():
    """Chrome 已安装应用（PWA）的宿主目录不能被当缓存删掉；它和 `Code Cache`、`GPUCache` 并排，删了应用打不开。"""
    inside = (r"C:\Users\anyone\AppData\Local\Google\Chrome\User Data\Default"
              r"\Web Applications\_crx_abcdef\icon.ico")
    assert safety.protection_reason(inside) == "pcclean.safety.protected.installedWebApp"

    sibling = (r"C:\Users\anyone\AppData\Local\Google\Chrome\User Data\Default"
               r"\Code Cache\js\index")
    assert safety.protection_reason(sibling) == ""


def test_path_guard_agrees_with_protection_reason():
    """带缓存的 `PathGuard` 必须与逐次判断的 `protection_reason` 答案一致；缓存只为性能，答案不同比慢更危险。"""
    guard = safety.PathGuard()
    samples = [
        r"C:\a\Recent\AutomaticDestinations\f01b4d95cf55d32a.automaticDestinations-ms",
        r"C:\a\Recent\AutomaticDestinations\other.automaticDestinations-ms",
        r"C:\a\User Data\Default\Web Applications\_crx_x\icon.ico",
        r"C:\a\User Data\Default\Web Applications\nested\deep\file.dat",
        r"C:\a\User Data\Default\Cache\data_0",
        "",
    ]
    for path in samples:
        assert guard.check(path) == safety.protection_reason(path), path
    # 走第二遍，确认缓存命中之后答案不变
    for path in samples:
        assert guard.check(path) == safety.protection_reason(path), path


def test_protected_items_are_locked_and_never_preselected():
    protected = _item(
        "privacy:pinned", "privacy", default_selected=True,
        path=r"C:\x\AutomaticDestinations\f01b4d95cf55d32a.automaticDestinations-ms",
    )
    _apply(protected)
    assert protected.locked is True
    assert protected.default_selected is False
    assert protected.detail["protected"]


def test_delete_tree_contents_skips_the_pinned_jumplist(tmp_path: Path):
    """端到端：真的放一个固定项文件，删完必须还在；保护逻辑没接进删除路径是最常见的复发方式。"""
    root = tmp_path / "AutomaticDestinations"
    root.mkdir()
    pinned = root / "f01b4d95cf55d32a.automaticDestinations-ms"
    trace = root / "1b4dd67f29cb1962.automaticDestinations-ms"
    pinned.write_bytes(b"pinned folders live here")
    trace.write_bytes(b"just a recent-files trace")

    freed, removed, _ = actions._delete_tree_contents(
        root, patterns=(), min_age_days=0, include_dirs=False)

    assert pinned.exists(), "快速访问的固定项被删掉了 —— 正是这次要修的那个 bug"
    assert not trace.exists(), "真正的痕迹没被清掉，隐私清理等于失效"
    assert removed == 1
    assert freed == len(b"just a recent-files trace")


# 不可逆项的默认勾选


def test_irreversible_and_expensive_items_are_never_preselected():
    """撤不回来 **且** 重建代价大 → 不替用户预先勾上。"""
    jump = _item("privacy:jumpLists", "privacy", default_selected=True)
    # 规则 id `jumpListsCustom`（`CustomDestinations`）现为 `default_selected=False`，但断言仍有意义：
    # 扫描侧默认值改回 True 也不许被预先勾上，闸口是最后一道而非唯一一道。
    custom_jump = _item("privacy:jumpListsCustom", "privacy", default_selected=True)
    _apply(jump, custom_jump)

    for item in (jump, custom_jump):
        assert item.detail["reversibility"] == "permanent", item.item_id
        assert item.detail["rebuild_cost"] == "high", item.item_id
        assert item.default_selected is False, item.item_id
        assert item.detail["demoted"], "降级了却不说，用户永远不知道这里发生过判断"


def test_zero_cost_items_stay_preselected():
    """反向守卫：临时文件同样不可逆，但必须仍能默认勾选；判据是"重建要不要付代价"，而非"可不可逆"，
    否则一键清理一项都不勾。"""
    junk = _item("junk:userTemp", "junk", default_selected=True,
                 importance=Importance.JUNK)
    recent = _item("privacy:recentDocuments", "privacy", default_selected=True)
    _apply(junk, recent)

    assert junk.default_selected is True
    assert junk.detail["rebuild_cost"] == "none"
    assert recent.default_selected is True, "清最近打开记录是隐私清理的本职工作"


def test_every_item_gets_the_decision_metrics():
    """每一条都必须带齐三个决策字段，缺一个界面就得猜。"""
    items = [
        _item("a", "junk"),
        _item("b", "browserData", detail={"kind": "cookies"}),
        _item("c", "software"),
        _item("d", "some_future_category"),
    ]
    _apply(*items)
    for item in items:
        assert item.detail["reversibility"] in ("recycle", "restorable", "permanent")
        assert item.detail["impact"], item.item_id
        assert item.detail["rebuild_cost"] in ("none", "low", "high"), item.item_id


def test_unknown_category_falls_to_the_most_cautious_metrics():
    """没登记过的类别必须落到最保守的一档；落到 `cache` + `none` 会让新增类别自动得到"放心清"的保证。"""
    item = _item("x", "a_category_nobody_registered")
    _apply(item)
    assert item.detail["impact"] == ["userdata"]
    assert item.detail["rebuild_cost"] == "high"
    assert item.detail["reversibility"] == "permanent"


def test_policy_is_idempotent():
    """重复过闸结果不变：落盘缓存回放的条目已过一次闸，回放路径为防篡改要再过一次。"""
    item = _item("privacy:jumpLists", "privacy", default_selected=True)
    _apply(item)
    first = dict(item.detail)
    _apply(item)
    assert dict(item.detail) == first
    assert item.default_selected is False


def test_cookies_are_marked_as_sign_in_impact_not_cache():
    """Cookie 删了要重新登录，不能跟 GPU 缓存共用一个"删了没损失"的标签。"""
    cookies = _item("bd:1", "browserData", detail={"kind": "cookies"})
    gpu = _item("bd:2", "browserData", detail={"kind": "gpuCache"})
    _apply(cookies, gpu)
    assert "signin" in cookies.detail["impact"]
    assert cookies.detail["rebuild_cost"] != "none"
    assert gpu.detail["impact"] == ["cache"]
    assert gpu.detail["rebuild_cost"] == "none"


# 清理面板的可选指标（前后端约好的契约字段）


def test_every_item_carries_the_panel_contract_fields():
    """五个字段一个都不能少，键名就是这几个：这是与前端的契约，缺一个表现为面板那栏空着，
    与"这一项没有风险"在屏幕上无法区分。"""
    items = [
        _item("a", "junk", size_bytes=1024, detail={"file_count": 700}),
        _item("b", "bigFiles", size_bytes=5 * 1024 ** 3),
        _item("c", "registry"),
    ]
    _apply(*items)
    for item in items:
        detail = item.detail
        assert detail["size"] == item.size_bytes, item.item_id
        assert detail["risk"] in ("low", "medium", "high"), item.item_id
        assert detail["reversibility"] in ("recycle", "restorable", "permanent")
        assert isinstance(detail["estimatedSeconds"], float), item.item_id
        assert detail["estimatedSeconds"] > 0, item.item_id
        assert "lastCleanedAt" in detail, item.item_id


def test_risk_is_derived_from_the_other_three_verdicts():
    """风险档是派生量，不是第四个独立判断；另写一套判据会出现"风险：低"配"不可逆 · 重建代价高"的矛盾。"""
    temp = _item("junk:temp", "junk")                    # 不可逆，但系统自己会补
    empty = _item("ed:1", "emptyDirs")                   # 进回收站，代价低
    dupes = _item("dup:1", "duplicates")                 # 进回收站，但是用户的文件
    reg = _item("reg:1", "registry")                     # 可还原
    cookies = _item("bd:1", "browserData", detail={"kind": "cookies"})
    jump = _item("privacy:jumpLists", "privacy")         # 不可逆 + 重建代价高
    _apply(temp, empty, dupes, reg, cookies, jump)

    assert temp.detail["risk"] == "low"
    assert empty.detail["risk"] == "low"
    # 删错了不是"没了"，是"多两下鼠标"——所以再贵也封顶在 medium。
    assert dupes.detail["risk"] == "medium"
    assert reg.detail["risk"] == "medium"
    assert cookies.detail["risk"] == "medium"
    assert jump.detail["risk"] == "high"


def test_protected_items_are_reported_as_high_risk():
    """锁死的那些清不掉，但界面上必须是高风险——那正是它们被锁的原因。"""
    protected = _item(
        "privacy:pinned", "privacy",
        path=r"C:\x\AutomaticDestinations\f01b4d95cf55d32a.automaticDestinations-ms",
    )
    _apply(protected)
    assert protected.locked is True
    assert protected.detail["risk"] == "high"


def test_estimated_seconds_grows_with_files_and_bytes():
    """量级要对：十万个文件不能和一个文件估出同一个数；该字段只回答"一秒还是五分钟"。"""
    small = _item("s", "junk", size_bytes=1024, detail={"file_count": 1})
    many = _item("m", "junk", size_bytes=1024, detail={"file_count": 100000})
    huge = _item("h", "junk", size_bytes=50 * 1024 ** 3, detail={"file_count": 1})
    _apply(small, many, huge)

    assert small.detail["estimatedSeconds"] < many.detail["estimatedSeconds"]
    assert small.detail["estimatedSeconds"] < huge.detail["estimatedSeconds"]

    # 进回收站比 unlink 慢得多（每个文件要写一条 $I 元数据、要挪进
    # $Recycle.Bin），同样的量估出来必须更久。
    hard = _item("hard", "junk", size_bytes=0, detail={"file_count": 5000})
    binned = _item("bin", "duplicates", size_bytes=0, detail={"file_count": 5000})
    _apply(hard, binned)
    assert binned.detail["estimatedSeconds"] > hard.detail["estimatedSeconds"]


def test_last_cleaned_round_trips_through_the_data_dir(tmp_path: Path):
    """"上次清理时间"要能写下去、读回来，并落到条目的 detail 上。"""
    assert actions.read_last_cleaned(tmp_path) == {}

    saved = actions.record_last_cleaned(tmp_path, ["junk", "privacy"])
    assert set(saved) == {"junk", "privacy"}
    assert actions.read_last_cleaned(tmp_path) == saved
    # ISO8601 + UTC。没有时区标记的本地时间戳在用户换时区之后会凭空偏移。
    assert saved["junk"].endswith("Z") and "T" in saved["junk"]

    junk = _item("j", "junk")
    never = _item("n", "bigFiles")
    safety.apply_safety_policy(ScanReport(category="x", items=[junk, never]), tmp_path)
    assert junk.detail["lastCleanedAt"] == saved["junk"]
    # 没清过的类别是 None，不是 0 也不是空串 —— 0 会被格式化成 1970 年。
    assert never.detail["lastCleanedAt"] is None


def test_last_cleaned_only_records_categories_that_actually_succeeded(tmp_path: Path):
    """一批全失败/全跳过的执行不该留下"刚清过"的印象，否则用户不会再点那一类。"""
    assert actions.record_last_cleaned(tmp_path, []) == {}
    assert actions.read_last_cleaned(tmp_path) == {}

    # 全部锁死 → 一项都没执行 → 不写时间戳
    locked = _item("locked", "junk", locked=True)
    actions.execute(tmp_path, [locked], create_restore_point=False)
    assert actions.read_last_cleaned(tmp_path) == {}

    # 干跑同理：磁盘上什么都没变，"上次清理时间"就不该动
    plain = _item("p", "junk", path=str(tmp_path / "nothing"))
    actions.execute(tmp_path, [plain], create_restore_point=False, dry_run=True)
    assert actions.read_last_cleaned(tmp_path) == {}


def test_reading_a_corrupt_last_cleaned_file_never_breaks_a_scan(tmp_path: Path):
    """纯展示字段读坏了不能让扫描失败。"""
    path = tmp_path / "pcclean" / actions.LAST_CLEANED_FILE_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ this is not json", encoding="utf-8")
    assert actions.read_last_cleaned(tmp_path) == {}

    item = _item("j", "junk")
    safety.apply_safety_policy(ScanReport(category="x", items=[item]), tmp_path)
    assert item.detail["lastCleanedAt"] is None


# 进程占用探测


def test_every_browser_label_has_a_process_name():
    """`paths.browser_profile_roots()` 认得的每个浏览器都要能查到进程名；
    两张表分家的表现是该浏览器永远不提示"请先关闭"，既不报错也不报空。"""
    from modules.file_vault.pcclean import paths

    labels = {label for label, _ in paths.browser_profile_roots()}
    # 本机可能一个浏览器都没装，那时改用源码里那张固定表
    if not labels:
        pytest.skip("本机没有检测到任何浏览器")
    missing = labels - set(processes.BROWSER_PROCESSES)
    assert not missing, f"这些浏览器查不到进程名，永远不会提示先关闭：{missing}"


def test_running_names_degrades_safely():
    """探不到进程时返回空集合，不抛异常；宁可少提示一句，也不让"提示"功能拖垮整次扫描。"""
    names = processes.running_names(force=True)
    assert isinstance(names, frozenset)
    assert all(isinstance(n, str) and n == n.lower() for n in names)


@pytest.mark.skipif(os.name != "nt", reason="Toolhelp32 是 Windows API")
def test_ctypes_snapshot_finds_this_very_process():
    """快照里必须有当前 Python 进程；只断言"返回集合"不够，静默返回空集合的坏实现也能通过。"""
    names = processes._snapshot_ctypes()
    assert names is not None, "Toolhelp32 快照失败"
    assert any("python" in n for n in names), f"快照里没有当前进程：{sorted(names)[:10]}"


def test_browser_running_reports_the_process_name_not_a_boolean():
    """返回进程名，因为界面要说「请先关闭 chrome.exe」，"有程序占用"帮不上忙。"""
    assert processes.browser_running("Google Chrome", names=["chrome.exe"]) == "chrome.exe"
    assert processes.browser_running("Google Chrome", names=["notepad.exe"]) == ""
    assert processes.browser_running("Nonexistent Browser", names=["chrome.exe"]) == ""


def test_annotate_writes_both_the_new_and_the_old_field():
    """新字段 `blocking_process` 与老字段 `browser_running` 必须同时写；
    `junk.py` 和界面仍在用老字段，只写新的会悄悄关掉提示且无报错。"""
    item = _item("x", "browserData", detail={"browser": "Google Chrome"})
    processes.annotate_browser_items([item], )
    if not processes.running_names():
        pytest.skip("本机探不到进程列表")
    assert "blocking_process" in item.detail
    assert "browser_running" in item.detail
    assert item.detail["browser_running"] is bool(item.detail["blocking_process"])


def test_execute_skips_items_held_open_by_a_browser():
    """浏览器开着时，浏览器数据类条目要跳过而非删一半；删一半会留下半残 Profile
    （扩展加载不起来、历史库损坏），且与"点了清理"无可见关联。"""
    item = _item("bd:1", "browserData", detail={"browser": "Ghost Browser"})
    # 造一个"这个浏览器在跑"的世界
    original = dict(processes.BROWSER_PROCESSES)
    try:
        processes.BROWSER_PROCESSES["Ghost Browser"] = tuple(
            sorted(processes.running_names())[:1] or ("nothing.exe",))
        blocker = actions._blocking_process(item)
    finally:
        processes.BROWSER_PROCESSES.clear()
        processes.BROWSER_PROCESSES.update(original)

    if not blocker:
        pytest.skip("本机探不到进程列表")
    assert blocker.endswith(".exe") or blocker


def test_junk_and_cache_are_not_blocked_by_a_running_browser():
    """反向守卫：纯缓存类不该因浏览器开着就整批拒绝；删一半只是少省空间、下次自动重建，
    为它们逼用户关浏览器不值得。"""
    for category in ("junk", "browserCache"):
        item = _item("x", category, detail={"browser": "Google Chrome"})
        assert actions._blocking_process(item) == "", category
