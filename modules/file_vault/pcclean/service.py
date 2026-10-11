"""对外门面，`backend_server` 只与本模块打交道。

1. 一键体检并行调度：用线程池而非进程池，扫描几乎全是文件系统/注册表 I/O（期间释放 GIL），
   且免去 pickle 回传与重复 import。
2. 扫描结果缓存：`execute` 必须用后端自己扫出的对象，不信前端传入（见 actions.execute），
   故按 item_id 缓存并设 TTL，隔太久的结果执行时可能删到别的东西。
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean import (
    actions,
    cachestore,
    deepclean,
    elevate,
    importance as imp,
    junk,
    memory,
    paths,
    popup,
    privacy,
    registry_clean,
    safety,
    schedule,
    shellext,
    software,
    space,
    startup,
    toolbox,
    userrules,
)
from modules.file_vault.pcclean.model import (
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)

CACHE_TTL_S = 900.0
"""扫描结果的有效期。超过就要求前端重扫 —— 拿 15 分钟前的路径去删文件，
那个路径上现在是什么谁也不知道。"""

DEFAULT_BUDGET_S = 25.0
"""单类扫描的默认时间预算。

定 25 秒的依据：一键体检里最慢的一类是启动项（`schtasks /Query /FO CSV /V`
实测 5.2 / 8.2 / 8.8 秒），预算给到它最坏情况的三倍仍不会误伤；而真正跑飞的
情况（网络盘挂起、某个目录有几十万个文件）都远超这个数。

**预算是协作式的**（见 `ScanTask.budget_s`）：超时不杀线程，只是让 scanner
自己收工并交回已扫到的部分，报告上打 `timed_out`。所以最坏情况下用户看到的是
"启动项：已扫到 31 项（本类超时，可重扫）"，而不是整个体检卡死。"""

CATEGORY_BUDGET_S = {
    # junk 超时从默认 25 秒提到 90：`deep=True` 要走十几万目录项，实测单跑 20.5 秒。
    # 超时交回的是"扫到一半"的数字，用户会看到可释放空间凭空少了一半。
    # 90 秒只对 `deep=True` 的单类扫描有意义；一键体检走 deep=False（跳过 whole_dir 规则，5~6 秒），
    # 回归由 `test_pcclean_perf_budget.py` 守护。
    "junk": 90.0,
    "duplicates": 180.0,
    "bigFiles": 120.0,
    "dirAnalysis": 120.0,
    "software": 90.0,
    "leftovers": 90.0,
    "diskSlimming": 60.0,
    "startup": 45.0,
    # 用户规则可以指向任意目录（含递归），预算给足；没有规则时它一秒都不用。
    "custom": 60.0,
    # 深度清理三类：都要走遍一大片目录树，25 秒不够。
    "browserData": 60.0,
    "driverStore": 120.0,
    "emptyDirs": 60.0,
}
"""按类覆盖默认预算。这几类本来就慢（要走遍整块盘或者问系统服务），
拿 25 秒卡它们等于把功能关掉。"""


NON_SPACE_CATEGORIES = frozenset({"memory"})
"""这些类的 `size_bytes` **不是磁盘空间**，清了不会让硬盘多出一个字节。

目前只有 `memory` 一个：它的每一项是某个进程当前的工作集。问题在于
`selectable_bytes` 会把它们加起来（实测本机 **7.9 GB**），而体检总览把每一类都
渲染成「N 项 · X」，于是「内存 65 项 · 7.9 GB」和「垃圾文件 18 项 · 20 GB」
长得一模一样——用户只能读成"这里还能再清出 7.9 GB"。

而"压缩工作集"做的事是把页面换出到页面文件，进程下次用到就换回来。**它不是
在释放什么，只是在挪。** 那 7.9 GB 里绝大部分是 Chrome 和编辑器正在用的内存。
把它摆在可释放空间的位置上，正是各种"内存优化"工具最招人恨的那一手。

标出来之后由界面决定怎么显示——本文件只负责说清"这个数字不是磁盘空间"，
不替界面决定措辞。"""


_ORDER_HINT_MS = {
    # 首次运行（无历史样本）的派工顺序提示，毫秒；只需量级对，避免秒级类排在毫秒级类前占住 worker。
    "memory": 60,
    "privacy": 100,
    "browserCache": 100,
    # 体检走 deep=False，实测 5~6 秒；此表只服务派工顺序，故填 deep=False 的量级而非单类 deep 的 20 秒。
    "junk": 6000,
    "plugins": 2300,
    "diskSlimming": 2500,
    "custom": 300,
    "registry": 4700,
    "startup": 8000,
    "popupSources": 8000,
}


HEARTBEAT_INTERVAL_S = 2.0
"""扫描期间"我还活着"的心跳间隔。

**这不是装饰，是防误杀。** 桥接层（`ui/electron/pythonBridge.ts`）有一个
**空闲超时**：后端连续沉默超过预算就把这次调用判负，界面上弹出的正是
「这次扫描没跑完」——而后端那时候往往正跑得好好的。

沉默是真会发生的：一键体检里 `schtasks /Query` 单次就要 5~9 秒，遇到网络盘
挂起或者几十万个文件的目录，一类跑到几十秒完全正常。以前只在**每类扫完**
才发一条进度，一类跑多久就沉默多久。

心跳把"沉默"和"卡死"这两件事分开：屏幕上有进度、桥接层收得到消息，
而真正的卡死（连心跳线程都停了）仍然会被判负。间隔取 2 秒是因为桥接层
最短的预算是 20 秒，2 秒给了十倍余量，同时对 IPC 的压力可以忽略。
"""


def _brief(exc: BaseException, limit: int = 300) -> str:
    """把异常压成一行给界面看的原因（只压扁截断，不脱敏）。

    只在用户本机界面一闪而过，不落盘、不进审计日志（审计日志连路径都不许有，见 actions.py）；
    "哪个路径拒绝访问"正是用户下一步行动所需的信息。
    """
    text = " ".join(str(exc).split())
    if not text:
        return type(exc).__name__
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def _safe_progress(on_progress):
    """把进度回调裹成永不抛异常的版本。

    回调另一头是 IPC 写管道，应用退出/界面刷新/渲染进程崩溃时会断并抛异常，
    不裹的话没人看的进度消息会带崩健康的扫描。
    `test_heartbeat_survives_a_callback_that_raises` 守护此点。
    """
    if on_progress is None:
        return None

    def safe(done: int, total: int) -> None:
        try:
            on_progress(done, total)
        except Exception:
            pass

    return safe


class _Heartbeat:
    """长时间不出声的工作期间周期性喂进度消息。

    用守护线程而非循环插桩：沉默发生在控制权不在我们手里时（`subprocess.run` 卡住、网络盘遍历）。
    回调异常一律吞掉，心跳失败不能带崩扫描。
    """

    def __init__(self, on_progress, total: int,
                 interval_s: float = HEARTBEAT_INTERVAL_S) -> None:
        self._on_progress = on_progress
        self._total = total
        self._interval = interval_s
        self._done = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def bump(self, done: int) -> None:
        """真的完成了几项。心跳照着报，进度条才不会倒退。"""
        self._done = done

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._on_progress(self._done, self._total)
            except Exception:
                pass

    def __enter__(self) -> "_Heartbeat":
        if self._on_progress is not None:
            self._thread = threading.Thread(
                target=self._run, name="pcclean-heartbeat", daemon=True)
            self._thread.start()
        return self

    def __exit__(self, *_exc) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        return False


_MEDIA_WARM_STARTED = threading.Event()


def _warm_media_types() -> None:
    """后台探测介质类型，暖进 `space._media_types()` 缓存。

    单独开线程是因为它走 PowerShell + CIM，首次要 4~9 秒；曾直接写进 `_adaptive_workers()`，
    让一键体检白等 4 秒，而各 scanner 本身只要几十毫秒。
    """
    if _MEDIA_WARM_STARTED.is_set():
        return
    _MEDIA_WARM_STARTED.set()

    def _run() -> None:
        try:
            space._media_types()
        except Exception:
            pass

    threading.Thread(target=_run, name="pcclean-media-warm", daemon=True).start()


def _adaptive_workers() -> int:
    """按 CPU 核数和系统盘介质决定并发扫描数，绝不阻塞。

    机械盘多线程读不同目录会磁头颠簸，收到 2；NVMe 多核可更高；上限 8，再多受注册表锁和
    `schtasks` 等单点调用限制。介质只读已有缓存，读不到就用默认 4 并让后台去探，第二轮起生效。
    """
    try:
        cpu = os.cpu_count() or 4
    except Exception:
        cpu = 4

    media = "unknown"
    try:
        cached = space.cached_media_types()
        if cached:
            media = cached.get(paths.system_drive().rstrip(":\\").upper(), "unknown")
        else:
            _warm_media_types()
    except Exception:
        media = "unknown"

    if media == "HDD":
        return 2
    if media == "unknown":
        # 回落值必须对两种介质都不算灾难，而不是"乐观值"——探不到介质
        # 通常意味着这台机器有点特殊，不是加码的时候。
        return max(2, min(4, cpu))
    return max(2, min(8, cpu))


class PcCleanService:
    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)
        self._lock = threading.Lock()
        self._cache: Dict[str, Tuple[float, CleanItem]] = {}
        self._cancel_flags: Dict[str, threading.Event] = {}
        self._blocker = popup.PopupBlocker(self._data_dir)
        self._prewarm_thread: Optional[threading.Thread] = None
        self._prewarm_stop = threading.Event()
        self._scheduler = schedule.Scheduler(self._data_dir, self._run_scheduled)

    # -- 缓存 -------------------------------------------------------------

    def _remember(self, report: ScanReport, *, at: Optional[float] = None) -> None:
        """把扫描结果记进执行缓存。

        `at` 仅供落盘缓存读回用，必须按当时的时间戳记账；盖上"现在"会把旧数据伪装成新的，
        而执行缓存 TTL 的意义就是不让旧路径被执行。
        """
        now = time.time()
        stamp = now if at is None else float(at)
        with self._lock:
            for item in report.items:
                self._cache[item.item_id] = (stamp, item)
            # 顺手清过期的，省得缓存无限长
            stale = [k for k, (ts, _) in self._cache.items() if now - ts > CACHE_TTL_S]
            for key in stale:
                self._cache.pop(key, None)

    def _lookup(self, item_ids: Sequence[str]) -> Tuple[List[CleanItem], List[str]]:
        now = time.time()
        found: List[CleanItem] = []
        missing: List[str] = []
        with self._lock:
            for item_id in item_ids:
                entry = self._cache.get(item_id)
                if entry is None or now - entry[0] > CACHE_TTL_S:
                    missing.append(item_id)
                    continue
                found.append(entry[1])
        return found, missing

    # -- 取消 -------------------------------------------------------------

    def _flag(self, scan_id: str) -> threading.Event:
        with self._lock:
            event = self._cancel_flags.get(scan_id)
            if event is None:
                event = threading.Event()
                self._cancel_flags[scan_id] = event
            return event

    def _yield_prewarm(self, scan_id: str) -> None:
        """用户自己发起扫描时让后台预扫立刻停手：二者读同一块盘，同时跑会让用户那次慢一倍。"""
        if scan_id == "__prewarm__":
            return
        with self._lock:
            event = self._cancel_flags.get("__prewarm__")
        if event is not None:
            event.set()

    def cancel(self, scan_id: str) -> Dict[str, Any]:
        with self._lock:
            event = self._cancel_flags.get(scan_id)
        if event is None:
            return {"ok": False, "error": "pcclean.cancel.unknownScan"}
        event.set()
        return {"ok": True, "scan_id": scan_id}

    def _release(self, scan_id: str) -> None:
        with self._lock:
            self._cancel_flags.pop(scan_id, None)

    # -- 单类扫描 ---------------------------------------------------------

    def _scanners(self) -> Dict[str, Callable[[ScanTask, Dict[str, Any]], ScanReport]]:
        whitelist = imp.load_whitelist(self._data_dir)
        return {
            "junk": lambda t, o: junk.scan_junk(
                t, age_scale=float(o.get("age_scale", 1.0)),
                min_age_days_override=(float(o["min_age_days"])
                                       if o.get("min_age_days") is not None else None),
                # 跟 diskSlimming 用同一个 `deep` 开关：默认关，一键体检不跑
                # 那批要走十几万个目录项的开发工具缓存（见 scan_junk 的说明）。
                deep=bool(o.get("deep", False))),
            "browserCache": lambda t, o: junk.scan_browser_cache(t),
            "browserData": lambda t, o: deepclean.scan_browser_data(t),
            "driverStore": lambda t, o: deepclean.scan_driver_store(t),
            "emptyDirs": lambda t, o: deepclean.scan_empty_dirs(
                t, roots=o.get("roots")),
            "privacy": lambda t, o: privacy.scan_privacy(t),
            "plugins": lambda t, o: privacy.scan_plugins(t, whitelist=whitelist),
            "downloads": lambda t, o: junk.scan_downloads(
                t, stale_days=float(o.get("stale_days", 60))),
            "diskSlimming": lambda t, o: space.scan_disk_slimming(
                t, deep=bool(o.get("deep", False))),
            "bigFiles": lambda t, o: space.scan_big_files(
                t, roots=o.get("roots"),
                min_size_mb=float(o.get("min_size_mb", 100)),
                limit=int(o.get("limit", 500))),
            "dirAnalysis": lambda t, o: space.analyze_directory(
                t, root=str(o.get("root") or ""),
                depth=int(o.get("depth", 2)), top_n=int(o.get("top_n", 40))),
            "duplicates": lambda t, o: space.scan_duplicates(
                t, roots=o.get("roots"),
                min_size_kb=float(o.get("min_size_kb", 1024)),
                limit_groups=int(o.get("limit_groups", 300)),
                keep_strategy=str(o.get("keep_strategy") or "smart")),
            "volumes": lambda t, o: space.list_volumes(t),
            "memory": lambda t, o: memory.scan_memory(
                t, min_working_set_mb=float(o.get("min_working_set_mb", 50))),
            "startup": lambda t, o: startup.scan_startup(t, whitelist=whitelist),
            "contextMenu": lambda t, o: shellext.scan_context_menu(t, whitelist=whitelist),
            "software": lambda t, o: software.scan_software(t, whitelist=whitelist),
            "leftovers": lambda t, o: software.scan_leftovers(
                t, installed_names=o.get("installed_names")),
            "registry": lambda t, o: registry_clean.scan_registry(t),
            "popupSources": lambda t, o: popup.scan_popup_sources(t),
            "custom": lambda t, o: userrules.scan_custom(t, data_dir=self._data_dir),
        }

    def scan(self, category: str, options: Optional[Dict[str, Any]] = None,
             *, scan_id: str = "", on_progress=None) -> Dict[str, Any]:
        self._yield_prewarm(scan_id)
        scanners = self._scanners()
        scanner = scanners.get(category)
        if scanner is None:
            return {"ok": False, "error": "pcclean.scan.unknownCategory",
                    "category": category}

        on_progress = _safe_progress(on_progress)
        flag = self._flag(scan_id) if scan_id else threading.Event()
        task = ScanTask(category=category, on_progress=on_progress,
                        should_cancel=flag.is_set,
                        budget_s=self._budget_for(category, options or {}))
        try:
            # 单类扫描里最慢的几类可跑几分钟且不一定有进度点；心跳保证桥接层一直有声音，
            # 否则正常的深度扫描会被判成"后端死了"。
            with _Heartbeat(on_progress, 1):
                report = scanner(task, options or {})
        except Exception as exc:
            self._release(scan_id)
            return {"ok": False,
                    "error": f"pcclean.scan.failed:{type(exc).__name__}",
                    "detail": _brief(exc),
                    "category": category}
        finally:
            if scan_id:
                self._release(scan_id)

        safety.apply_safety_policy(report, self._data_dir)
        self._remember(report)
        payload = report.to_dict()
        payload["ok"] = True
        payload["cancelled"] = flag.is_set()
        # 慢扫描落盘，下次开面板先铺上（见 cachestore.save_scan：超时/截断/空
        # 结果一律不存，免得下次拿一份残缺数据冒充完整结果）。
        cachestore.save_scan(self._data_dir, category, payload)
        return payload

    def cached_scan(self, category: str) -> Dict[str, Any]:
        """读回上次落盘的单类扫描结果，没有则返回 {"ok": False}。

        供「空间分析」等面板打开时先用（重复文件扫描 180 秒、大文件 120 秒）；
        结果必须带 `from_cache` 和 `age_s`，界面要说明数字有多旧。
        """
        cached = cachestore.load_scan(self._data_dir, category,
                                      execute_ttl_s=CACHE_TTL_S)
        if not cached:
            return {"ok": False, "error": "pcclean.scan.noCache"}
        payload = dict(cached["payload"])
        payload["from_cache"] = True
        payload["cache_age_s"] = cached["age_s"]
        payload["stale"] = not cached["fresh_enough_to_execute"]
        if cached["fresh_enough_to_execute"]:
            # 够新才喂回执行缓存，并且**按当时的时间戳记账**——盖上"现在"
            # 等于把一份旧数据伪装成刚扫出来的。
            report = ScanReport(category=category, items=[
                CleanItem(
                    item_id=str(i["item_id"]), category=str(i["category"]),
                    label=str(i["label"]), size_bytes=int(i.get("size_bytes") or 0),
                    path=str(i.get("path") or ""),
                    importance=Importance.OPTIONAL, reason=str(i.get("reason") or ""),
                    locked=bool(i.get("locked")), detail=dict(i.get("detail") or {}),
                )
                for i in payload.get("items") or []
            ])
            self._remember(report, at=cached["saved_at"])
        return payload

    # -- 一键体检 ---------------------------------------------------------

    HEALTH_CATEGORIES = (
        "junk", "browserCache", "privacy", "diskSlimming",
        "startup", "registry", "plugins", "popupSources", "memory",
        # `custom` 是用户自定义规则；曾不在此列表也无前端调用，规则能建能存却永不执行。
        # 无规则时 `scan_custom` 第一行就返回空报告，加入几乎零成本。
        "custom",
    )

    def health_check(self, options: Optional[Dict[str, Any]] = None,
                     *, scan_id: str = "", on_progress=None,
                     on_category=None, on_plan=None, on_tick=None) -> Dict[str, Any]:
        """一键体检：并行跑一批扫描并出汇总。

        不含 bigFiles / duplicates / software（大盘上要跑几分钟），它们在各自面板里按需跑。

        `on_category` 流式回调：总时长约 10 秒几乎全由 `schtasks /Query /FO CSV /V`（7 秒）造成，
        绕不过去——非提权进程 `scandir` 枚举 `C:\\Windows\\System32\\Tasks` 会 WinError 5，
        `rglob` 则静默返回 0 条。其余八类不到 3 秒，所以每扫完一类就推给界面，不让屏幕有"卡住"的时刻。
        """
        self._yield_prewarm(scan_id)
        options = options or {}
        # 进度回调一律先裹一层。它的另一头是 IPC 管道，断了会抛，
        # 而那跟扫描本身健不健康毫无关系。
        on_progress = _safe_progress(on_progress)
        scanners = self._scanners()
        selected = [c for c in (options.get("categories") or self.HEALTH_CATEGORIES)
                    if c in scanners]
        flag = self._flag(scan_id) if scan_id else threading.Event()
        started = time.perf_counter()

        reports: Dict[str, Dict[str, Any]] = {}
        errors: List[str] = []
        # 按类归档的失败原因，是给界面用的结构化数据（`errors` 只是日志字符串），
        # 界面要能说出"哪一类因何失败、点此只重扫这一类"。
        failures: Dict[str, Dict[str, str]] = {}
        timings: Dict[str, int] = {}
        done_count = 0

        # 先把上次的结果铺上去，在任何扫描开始之前完成，之后每扫完一类覆盖对应那一格。
        cached_names: List[str] = []
        if bool(options.get("use_cache", True)) and on_category:
            cached_names = self._emit_cached(selected, on_category)

        # -- 告诉界面这一轮打算干什么、大概要多久 ---------------------------
        estimates = cachestore.estimates(self._data_dir)
        workers = _adaptive_workers()
        if on_plan:
            on_plan({
                "categories": list(selected),
                "estimates_ms": {c: estimates[c] for c in selected if c in estimates},
                "eta_ms": self._eta_ms(selected, estimates, workers),
                "workers": workers,
                "from_cache": cached_names,
            })

        # `popupSources` 完全从 `startup` 的结果里筛出来。两个都选中时让它
        # **复用**那份报告，别把最慢的那一项（8.7 秒）跑两遍。
        derive_popup = "popupSources" in selected and "startup" in selected
        dispatch = [c for c in selected if not (derive_popup and c == "popupSources")]

        # 快的先派工：线程池按提交顺序取任务，`workers` 少（如机械盘只给 2）时顺序决定首块内容多久出现，
        # 否则 5~9 秒的 `startup`（`schtasks /Query`）会让毫秒级的类排队干等。
        # 排序键用历史中位数 (`cachestore.estimates`)，首次无样本则回落 `_ORDER_HINT_MS`，
        # 只需区分秒级与毫秒级。
        dispatch.sort(key=lambda c: estimates.get(c, _ORDER_HINT_MS.get(c, 1000)))
        startup_report_holder: Dict[str, Any] = {}
        pending = set(selected)

        # 每类各自记最后一次推送时刻，必须分开：共用时间戳会让快的类吃掉慢的类（用户盯着的那个）的心跳。
        last_tick: Dict[str, float] = {}

        def _one(category: str) -> Tuple[str, Dict[str, Any]]:
            def tick(done: int, total: int) -> None:
                """把这一类自己的进度推给界面，节流到 300ms 一条（scanner 的 `task.progress()` 遍历时每秒可调
                几百次，白占 IPC 带宽）。"""
                if on_tick is None:
                    return
                now = time.perf_counter()
                if now - last_tick.get(category, 0.0) < 0.3:
                    return
                last_tick[category] = now
                try:
                    on_tick(category, int(done), int(total))
                except Exception:
                    # 界面那头断了跟扫描健不健康毫无关系，和 `_safe_progress` 同理。
                    pass

            task = ScanTask(category=category, on_progress=tick,
                            should_cancel=flag.is_set,
                            budget_s=self._budget_for(category, options))
            try:
                report = scanners[category](task, options.get(category) or {})
            except Exception as exc:
                return category, {"ok": False,
                                  "error": f"pcclean.scan.failed:{type(exc).__name__}",
                                  "detail": _brief(exc),
                                  "category": category}
            if category == "startup":
                startup_report_holder["report"] = report
            # 安全闸口必须在 `_remember` 之前：执行缓存里存的得是已过闸条目，
            # 否则界面显示的和实际会执行的是两份数据（预演屏撒谎）。
            safety.apply_safety_policy(report, self._data_dir)
            self._remember(report)
            payload = report.to_dict()
            payload["ok"] = True
            return category, payload

        # 心跳包住整个并行段。最慢的一类（计划任务）单独就能沉默 9 秒，
        # 网络盘挂起时更久——没有心跳，桥接层会在 20 秒时把整轮判负。
        with _Heartbeat(on_progress, len(selected)) as beat, \
                ThreadPoolExecutor(max_workers=workers,
                                   thread_name_prefix="pcclean-scan") as pool:
            futures = {pool.submit(_one, c): c for c in dispatch}
            for future in as_completed(futures):
                category = futures[future]
                try:
                    name, payload = future.result()
                except Exception as exc:
                    errors.append(f"{category}: {_brief(exc, 160)}")
                    failures[category] = {"category": category,
                                          "code": type(exc).__name__,
                                          "detail": _brief(exc, 160)}
                    pending.discard(category)
                    done_count += 1
                    beat.bump(done_count)
                    if on_progress:
                        on_progress(done_count, len(selected))
                    continue
                reports[name] = payload
                pending.discard(name)
                if payload.get("ok"):
                    timings[name] = int(payload.get("elapsed_ms") or 0)
                else:
                    # scanner 抛的异常已被 `_one` 兜住，这里是"返回了但标失败"；必须记 failures，
                    # 否则该类在界面上永远停在"扫描中"。
                    failures[name] = {
                        "category": name,
                        "code": str(payload.get("error") or "").split(":")[-1],
                        "detail": str(payload.get("detail") or ""),
                    }
                done_count += 1
                beat.bump(done_count)
                if on_category:
                    payload = dict(payload)
                    payload["eta_ms"] = self._eta_ms(pending, estimates, workers)
                    on_category(name, payload)
                if on_progress:
                    on_progress(done_count, len(selected))

        if derive_popup:
            task = ScanTask(category="popupSources", should_cancel=flag.is_set,
                            budget_s=self._budget_for("popupSources", options))
            try:
                report = popup.scan_popup_sources(
                    task, startup_report=startup_report_holder.get("report"))
                safety.apply_safety_policy(report, self._data_dir)
                self._remember(report)
                payload = report.to_dict()
                payload["ok"] = True
                reports["popupSources"] = payload
                timings["popupSources"] = int(payload.get("elapsed_ms") or 0)
                pending.discard("popupSources")
                if on_category:
                    payload = dict(payload)
                    payload["eta_ms"] = self._eta_ms(pending, estimates, workers)
                    on_category("popupSources", payload)
            except Exception as exc:
                errors.append(f"popupSources: {_brief(exc, 160)}")
                failures["popupSources"] = {"category": "popupSources",
                                            "code": type(exc).__name__,
                                            "detail": _brief(exc, 160)}
                pending.discard("popupSources")
            done_count += 1
            if on_progress:
                on_progress(done_count, len(selected))

        # **数量对账**：派出去几个必须收回几个。少一个就是有 scanner
        # 静默失败了，那正是"看起来很干净"的假象来源。
        if len(reports) + len(errors) != len(selected):
            errors.append(
                f"pcclean.health.accountingMismatch:"
                f"dispatched={len(selected)},returned={len(reports)},errors={len(errors)}"
            )

        self._release(scan_id)
        result = {
            "ok": True,
            "cancelled": flag.is_set(),
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
            "categories": reports,
            "errors": errors,
            # 界面靠它画"哪一类没跑完、为什么、重扫这一类"那张卡。
            # 空字典 = 九类全跑完了，这时界面一个字的错误都不该显示。
            "failures": [failures[c] for c in selected if c in failures],
            "summary": self._summarise(reports),
            "memory": memory.memory_status(),
            "workers": workers,
            "timed_out": sorted(c for c, p in reports.items() if p.get("timed_out")),
        }

        # 取消掉的那一轮不进缓存：它的结果按定义是残缺的，存下来下次开机
        # 会铺一份偏小的数字上去，而用户根本不知道那是半截结果。
        if not flag.is_set():
            cachestore.save_health(self._data_dir, result)
            if timings:
                cachestore.record_timing(self._data_dir, timings)
        return result

    # -- 缓存回放与耗时估算 -----------------------------------------------

    def _emit_cached(self, selected: Sequence[str], on_category) -> List[str]:
        """把上次落盘的结果先推给界面，返回真正推出的类名。

        只有缓存比执行 TTL 新才喂回执行缓存 (`_remember`)；更旧的仅显示，点"清理"时返回
        `staleSelection` 让前端重扫。显示旧数字与执行旧路径的风险不同，不能共用门槛。
        """
        try:
            cached = cachestore.load_health(self._data_dir, execute_ttl_s=CACHE_TTL_S)
        except Exception:
            return []
        if not cached:
            return []

        executable = bool(cached.get("fresh_enough_to_execute"))
        saved_at = float(cached.get("saved_at") or 0)
        emitted: List[str] = []
        for name in selected:
            payload = (cached.get("categories") or {}).get(name)
            if not isinstance(payload, dict):
                continue
            # 缓存条目必须重新过一遍安全闸口：缓存是磁盘上可被改的普通 JSON（同 `_execute_one` 的第二道黑
            # 名单），
            # 认下被改成 `default_selected=true` 的条目会导致永久删除。
            replay: Optional[ScanReport] = None
            try:
                replay = safety.apply_safety_policy(ScanReport(
                    category=name,
                    items=[CleanItem.from_dict(raw)
                           for raw in (payload.get("items") or [])],
                ), self._data_dir)
            except Exception:
                executable = False
            if executable and replay is not None:
                self._remember(replay, at=saved_at)
            shown = dict(payload)
            if replay is not None:
                # 界面看到的和执行缓存里躺着的是同一批对象的同一份结论。
                shown["items"] = [i.to_dict() for i in replay.items]
            shown["from_cache"] = True
            shown["cache_age_s"] = int(cached.get("age_s") or 0)
            shown["stale"] = not executable
            try:
                on_category(name, shown)
                emitted.append(name)
            except Exception:
                # 回放失败不该让真正的扫描也跑不起来。
                break
        return emitted

    @staticmethod
    def _eta_ms(pending, estimates: Dict[str, int], workers: int) -> int:
        """还要等多久（毫秒）；无历史样本返回 0，界面显示"计算中"。

        取"最慢那个"与"总和/工人数"的较大者，是粗糙下界但不会低估——进度条只能偏长不能偏短。
        """
        remaining = [estimates[c] for c in pending if c in estimates]
        if not remaining:
            return 0
        slowest = max(remaining)
        queued = sum(remaining) / max(1, workers)
        return int(max(slowest, queued))

    @staticmethod
    def _budget_for(category: str, options: Dict[str, Any]) -> float:
        """这一类给多少秒。优先级：`budgets[category]` 明确指定 > 按类默认表 > 全局默认，
        最后乘界面"扫描力度"的 `budget_scale`；倍率只作用于默认值，明确指定的不再乘（否则同一意图应用
        两遍）。
        """
        override = (options.get("budgets") or {}).get(category)
        if isinstance(override, (int, float)) and override > 0:
            return float(override)
        base = CATEGORY_BUDGET_S.get(category, DEFAULT_BUDGET_S)
        raw_scale = options.get("budget_scale")
        if isinstance(raw_scale, (int, float)) and raw_scale > 0:
            # 上下都夹住：0.1 会让每一类都在第一步就超时（那是把功能关掉，
            # 不是"更快"），10 会让一次体检跑到用户以为死机。
            base *= max(0.25, min(6.0, float(raw_scale)))
        return base

    @staticmethod
    def _summarise(reports: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """出一份汇总。刻意不给"健康评分"这类编造的数字，只给可核对的事实：可清字节数、可关自启项数、
        无效注册表引用数。"""
        reclaimable = 0
        by_category: Dict[str, Dict[str, Any]] = {}
        total_items = 0
        attention = 0

        for category, payload in reports.items():
            if not payload.get("ok"):
                continue
            selectable = int(payload.get("selectable_bytes") or 0)
            items = payload.get("items") or []
            default_on = [i for i in items if i.get("default_selected")]
            junky = [i for i in items if i.get("importance") == "junk"]
            reclaimable += sum(int(i.get("size_bytes") or 0) for i in default_on)
            total_items += len(items)
            attention += len(junky)
            by_category[category] = {
                "count": len(items),
                "default_selected": len(default_on),
                "junk_count": len(junky),
                "selectable_bytes": selectable,
                "space_backed": category not in NON_SPACE_CATEGORIES,
                "truncated": bool(payload.get("truncated")),
            }

        return {
            "reclaimable_bytes": reclaimable,
            "total_items": total_items,
            "needs_attention": attention,
            "by_category": by_category,
        }

    # -- 执行 -------------------------------------------------------------

    def execute(self, item_ids: Sequence[str], options: Optional[Dict[str, Any]] = None,
                *, on_progress=None) -> Dict[str, Any]:
        """执行清理。前端只传 **item_id 列表**，其余全部由后端从缓存里取。"""
        options = options or {}
        items, missing = self._lookup(item_ids)
        if not items:
            return {"ok": False, "error": "pcclean.execute.staleSelection",
                    "missing": missing}

        needs_elevation = [
            i for i in items
            if i.detail.get("needs_elevation") and not elevate.is_elevated()
        ]
        normal = [i for i in items if i not in needs_elevation]

        # 用户是否点过"授权"，默认没点：不在用户没预期时弹 UAC。第一遍只清无需权限的部分，
        # 如实报告"还有 N 项需管理员权限"，用户点授权后才带 allow_elevation=True 再来一次。
        # 此前这类项一律算"没能清掉"，界面又没有授权入口，注册表、系统目录、C 盘瘦身永远清不掉。
        allow_elevation = bool(options.get("allow_elevation", False))

        result = actions.execute(
            self._data_dir, normal,
            create_restore_point=bool(options.get("create_restore_point", True)),
            # 同 health_check：管道断了不该把一次正在跑的清理带崩，
            # 那会让用户以为"删到一半炸了"，而实际上文件删得好好的。
            on_progress=_safe_progress(on_progress),
        )
        payload = result.to_dict()
        payload["ok"] = not result.aborted
        payload["missing"] = missing
        # 界面画"授权并继续"那张卡要的三样：还剩几项、是哪几项、共多少字节。
        payload["needs_elevation"] = {
            "count": len(needs_elevation),
            "item_ids": [i.item_id for i in needs_elevation],
            "bytes": sum(i.size_bytes for i in needs_elevation),
        }

        if needs_elevation and not allow_elevation:
            for item in needs_elevation:
                payload["outcomes"].append({
                    "item_id": item.item_id, "status": "skipped",
                    "freed_bytes": 0,
                    "error": "pcclean.execute.needsElevation",
                    "undo_token": "",
                })
            payload["skipped"] = int(payload.get("skipped") or 0) + len(needs_elevation)
            return payload

        # 需要提权的部分：拉一次助手，把它们一起干完。**只弹一次 UAC** ——
        # 每一项弹一次的话，用户面对二十个 UAC 对话框只会直接放弃。
        if needs_elevation and not result.aborted:
            job = elevate.HelperJob(
                action="execute_items",
                payload={
                    "items": [i.to_dict() for i in needs_elevation],
                    "create_restore_point": False,  # 上面已经建过了
                },
            )
            elevated_result = elevate.run_elevated(job, data_dir=self._data_dir)
            payload["elevated"] = elevated_result
            if elevated_result.get("ok"):
                payload["freed_bytes"] = (int(payload.get("freed_bytes") or 0)
                                          + int(elevated_result.get("freed_bytes") or 0))
                payload["outcomes"].extend(elevated_result.get("outcomes") or [])
            else:
                for item in needs_elevation:
                    payload["outcomes"].append({
                        "item_id": item.item_id, "status": "skipped",
                        "freed_bytes": 0,
                        "error": str(elevated_result.get("error")
                                     or "pcclean.elevate.failed"),
                        "undo_token": "",
                    })
        return payload

    def startup_delay(self, item_id: str, minutes: int) -> Dict[str, Any]:
        """把自启项改成延迟启动。

        单独入口，不塞进 `execute()`：延迟启动什么都没删，混入会让审计/撤销日志和"释放字节数"都要迁就。
        撤销仍走同一份 journal（`kind=startup_disabled`）。
        """
        items, missing = self._lookup([item_id])
        if not items:
            return {"ok": False, "error": "pcclean.execute.staleSelection",
                    "missing": missing}
        item = items[0]
        if item.locked or item.category != "startup":
            return {"ok": False, "error": "pcclean.startup.delayUnsupported"}

        journal: List[Dict[str, Any]] = []
        ok, err, undo = actions.startup_delay(item.detail, minutes)
        if not ok:
            return {"ok": False, "error": err or "pcclean.startup.delayCreateFailed"}
        journal.append({"kind": "startup_disabled", "undo": undo,
                        "item_id": item.item_id, "reversible": True})
        session_id = uuid.uuid4().hex
        actions._write_journal(self._data_dir, session_id, journal, {"delay_minutes": minutes})
        return {"ok": True, "session_id": session_id, "item_id": item.item_id,
                "minutes": minutes, "task_name": undo.get("delay_task", "")}

    def preview(self, item_ids: Sequence[str]) -> Dict[str, Any]:
        """清理预演：点下去之前告诉用户会发生什么。

        1. 每块盘从多少变成多少（而非笼统的"可释放 4.2 GB"）；2. 按可逆性分三档列出撤不回来的项；
        3. 哪些项会被拒绝（锁死、白名单）及原因。
        走 `actions.execute(dry_run=True)` 同一条代码路径，不另写模拟，免得与真实行为分叉。
        """
        items, missing = self._lookup(item_ids)
        if not items:
            return {"ok": False, "error": "pcclean.execute.staleSelection",
                    "missing": missing}

        result = actions.execute(self._data_dir, items, dry_run=True)
        payload = result.to_dict()

        approved_ids = {o.item_id for o in result.outcomes if o.status == "preview"}
        approved = [i for i in items if i.item_id in approved_ids]

        by_reversibility: Dict[str, Dict[str, int]] = {}
        by_category: Dict[str, Dict[str, int]] = {}
        by_drive: Dict[str, int] = {}
        for item in approved:
            level = actions.reversibility(item)
            bucket = by_reversibility.setdefault(level, {"count": 0, "bytes": 0})
            bucket["count"] += 1
            bucket["bytes"] += item.size_bytes
            cat = by_category.setdefault(item.category, {"count": 0, "bytes": 0})
            cat["count"] += 1
            cat["bytes"] += item.size_bytes
            drive = self._drive_of(item.path)
            if drive:
                by_drive[drive] = by_drive.get(drive, 0) + item.size_bytes

        drives = []
        for letter, freed in sorted(by_drive.items()):
            # 这里曾有两处错误且互相掩盖：
            # ① `_drive_of()` 返回裸盘符 `"C"`，`GetDiskFreeSpaceExW` 要根路径 `"C:\\"`，传错会让
            #    `_disk_space` 抛 OSError、整个 preview 失败（按钮一直转圈）。
            # ② `_disk_space` 返回 `(total, free)`，此前按 `free_before, total` 解包，顺序反了。
            # 其他调用点写法正确：`total, free = _disk_space(drive + "\\")`；只有这里从条目路径反推盘符。
            try:
                total, free_before = space._disk_space(f"{letter}:\\")
            except OSError:
                # 一块盘读不到不该让整份预演失败——跳过它，其余照常给。
                # `list_volumes` 里也是这么处理的。
                continue
            drives.append({
                "drive": letter,
                "total_bytes": total,
                "free_before": free_before,
                # 上界而非承诺：文件可能已不在，回收站删除也不立刻还空间；界面必须写成"最多"。
                "free_after_max": free_before + freed,
                "freed_bytes": freed,
            })

        payload.update({
            "ok": True,
            "missing": missing,
            "by_reversibility": by_reversibility,
            "by_category": by_category,
            "drives": drives,
            "rejected": [
                {"item_id": o.item_id, "reason": o.error}
                for o in result.outcomes if o.status == "skipped"
            ],
        })
        return payload

    @staticmethod
    def _drive_of(raw_path: str) -> str:
        """从路径取盘符。取不到就返回空串 —— 注册表项、启动项这类根本没有
        盘符的条目本来就不该出现在"哪块盘能腾出多少"这张表里。"""
        try:
            drive = os.path.splitdrive(str(raw_path))[0]
            return drive.rstrip(":\\").upper() if drive else ""
        except Exception:
            return ""

    def audit_log(self, limit: int = 200) -> Dict[str, Any]:
        return {"ok": True, "entries": actions.read_audit(self._data_dir, limit)}

    def audit_delete(self, session_ids: Any) -> Dict[str, Any]:
        """删除若干条清理记录。`session_ids` 为空时**什么都不删**，不是"删全部"——
        把空列表理解成全选是删除类接口最经典的翻车方式。要清空走 audit_clear。"""
        ids = [str(sid) for sid in (session_ids or []) if str(sid)]
        removed = actions.delete_audit(self._data_dir, ids)
        return {"ok": True, "removed": removed,
                "entries": actions.read_audit(self._data_dir, 200)}

    def audit_clear(self) -> Dict[str, Any]:
        removed = actions.clear_audit(self._data_dir)
        return {"ok": True, "removed": removed, "entries": []}

    # -- 自定义规则 -------------------------------------------------------

    def rules_get(self) -> Dict[str, Any]:
        return {"ok": True, "rules": userrules.load_rules(self._data_dir),
                "max_rules": userrules.MAX_RULES}

    def rules_upsert(self, rule: Dict[str, Any]) -> Dict[str, Any]:
        try:
            rules = userrules.upsert_rule(self._data_dir, rule or {})
        except userrules.RuleError as exc:
            # 校验失败的原因原样回给界面。**必须是 i18n 键而不是异常文本**——
            # "规则不合法"帮不了用户改对它，"这条路径是系统目录"才行。
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "rules": rules}

    def rules_remove(self, rule_id: str) -> Dict[str, Any]:
        return {"ok": True, "rules": userrules.remove_rule(self._data_dir, rule_id)}

    # -- 定时计划 ---------------------------------------------------------

    def schedule_get(self) -> Dict[str, Any]:
        config = schedule.load_config(self._data_dir)
        return {"ok": True, "config": config,
                "due_at": int(schedule.due_at(config)),
                "safe_categories": list(schedule.SAFE_CATEGORIES),
                "intervals": sorted(schedule.INTERVALS)}

    def schedule_set(self, config: Dict[str, Any]) -> Dict[str, Any]:
        saved = schedule.save_config(self._data_dir, config or {})
        if saved.get("enabled"):
            self._scheduler.start()
        else:
            self._scheduler.stop()
        return {"ok": True, "config": saved, "due_at": int(schedule.due_at(saved))}

    def _run_scheduled(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """定时任务到点时调用。

        `scan` 档只扫不删；`clean` 档只执行 `default_selected` 的项——默认没勾上的本就该由人判断，
        自动化更不该替他决定。
        """
        categories = list(config.get("categories") or schedule.SAFE_CATEGORIES)
        health = self.health_check({"categories": categories, "use_cache": False},
                                   scan_id="__schedule__")
        if str(config.get("mode")) != "clean":
            return {"ok": True, "items": int(
                (health.get("summary") or {}).get("total_items") or 0)}

        item_ids: List[str] = []
        for name, payload in (health.get("categories") or {}).items():
            if name not in schedule.SAFE_CATEGORIES or not payload.get("ok"):
                continue
            for raw in payload.get("items") or []:
                if raw.get("default_selected") and not raw.get("locked"):
                    item_ids.append(str(raw.get("item_id")))
        if not item_ids:
            return {"ok": True, "items": 0, "freed_bytes": 0}

        # 定时清理不建还原点：它只碰缓存和临时文件，建点纯属浪费。
        # 真要动系统的东西根本不该走定时这条路。
        result = self.execute(item_ids, {"create_restore_point": False})
        return {"ok": bool(result.get("ok")), "items": len(item_ids),
                "freed_bytes": int(result.get("freed_bytes") or 0)}

    def uninstall(self, item_id: str, *, silent: bool = False) -> Dict[str, Any]:
        """调用已装软件自己的卸载程序。

        参数是 item_id 而非前端传来的命令行（否则等于向渲染层开放任意命令执行）；
        命令行取自后端自己的扫描缓存，只可能来自注册表。
        """
        items, missing = self._lookup([item_id])
        if not items:
            return {"ok": False, "error": "pcclean.execute.staleSelection",
                    "missing": missing}
        item = items[0]
        if item.category != "software":
            return {"ok": False, "error": "pcclean.execute.unsupportedCategory"}
        if item.locked:
            return {"ok": False, "error": "pcclean.execute.lockedItem"}
        return software.uninstall(item.detail, silent=silent)

    def undo(self, session_id: str) -> Dict[str, Any]:
        return actions.undo(self._data_dir, session_id)

    def sessions(self, limit: int = 20) -> Dict[str, Any]:
        return {"ok": True, "sessions": actions.list_sessions(self._data_dir, limit)}

    # -- 内存 -------------------------------------------------------------

    def memory_status(self) -> Dict[str, Any]:
        return {"ok": True, **memory.memory_status()}

    def trim_memory(self, item_ids: Sequence[str]) -> Dict[str, Any]:
        items, missing = self._lookup(item_ids)
        pids = [int(i.detail.get("pid") or 0) for i in items
                if i.category == "memory" and i.detail.get("pid")]
        if not pids:
            return {"ok": False, "error": "pcclean.memory.noTargets", "missing": missing}
        before = memory.memory_status()
        result = memory.trim_working_sets(pids)
        after = memory.memory_status()
        return {"ok": True, "before": before, "after": after, **result}

    def purge_standby(self) -> Dict[str, Any]:
        if elevate.is_elevated():
            return memory.purge_standby_list()
        return elevate.run_elevated(
            elevate.HelperJob(action="purge_standby_list", payload={}),
            data_dir=self._data_dir, timeout_s=60.0,
        )

    # -- 弹窗拦截 ---------------------------------------------------------

    def popup_status(self) -> Dict[str, Any]:
        return {"ok": True, **self._blocker.status()}

    def popup_set_enabled(self, enabled: bool) -> Dict[str, Any]:
        config = self._blocker.load_config()
        config["enabled"] = bool(enabled)
        self._blocker.save_config(config)
        if enabled:
            self._blocker.start()
        else:
            self._blocker.stop()
        return {"ok": True, **self._blocker.status()}

    def popup_test(self) -> Dict[str, Any]:
        """干跑一轮，让用户看看当前规则会拦到什么 —— 但不真的关窗口。"""
        return {"ok": True, "hits": self._blocker.check_once(dry_run=True)}

    def popup_capture(self) -> Dict[str, Any]:
        """捕获模式：列出当前所有可见窗口，让用户点一个变成规则。"""
        windows = popup.enumerate_windows(visible_only=True)
        return {"ok": True, "windows": [
            {"hwnd": w.hwnd, "title": w.title, "class_name": w.class_name,
             "pid": w.pid, "process": w.process}
            for w in windows if w.title or w.class_name
        ]}

    def popup_add_rule(self, rule: Dict[str, Any]) -> Dict[str, Any]:
        config = self._blocker.load_config()
        rules = list(config.get("custom_rules") or [])
        import uuid as _uuid
        entry = {
            "rule_id": str(rule.get("rule_id") or f"user-{_uuid.uuid4().hex[:8]}"),
            "label": str(rule.get("label") or ""),
            "title_pattern": str(rule.get("title_pattern") or ""),
            "class_pattern": str(rule.get("class_pattern") or ""),
            "process_pattern": str(rule.get("process_pattern") or ""),
            "enabled": bool(rule.get("enabled", True)),
        }
        if not (entry["title_pattern"] or entry["class_pattern"]
                or entry["process_pattern"]):
            return {"ok": False, "error": "pcclean.popup.emptyRule"}
        rules = [r for r in rules if r.get("rule_id") != entry["rule_id"]]
        rules.append(entry)
        config["custom_rules"] = rules
        self._blocker.save_config(config)
        return {"ok": True, **self._blocker.status()}

    def popup_remove_rule(self, rule_id: str) -> Dict[str, Any]:
        config = self._blocker.load_config()
        config["custom_rules"] = [r for r in (config.get("custom_rules") or [])
                                  if r.get("rule_id") != rule_id]
        disabled = set(config.get("disabled_builtin") or [])
        if any(r.rule_id == rule_id for r in popup.BUILTIN_RULES):
            disabled.add(rule_id)
        config["disabled_builtin"] = sorted(disabled)
        self._blocker.save_config(config)
        return {"ok": True, **self._blocker.status()}

    def popup_whitelist(self, entries: Sequence[str]) -> Dict[str, Any]:
        config = self._blocker.load_config()
        config["whitelist"] = sorted({str(e).strip() for e in entries if str(e).strip()})
        self._blocker.save_config(config)
        return {"ok": True, **self._blocker.status()}

    def popup_clear_log(self) -> Dict[str, Any]:
        self._blocker.clear_log()
        return {"ok": True, **self._blocker.status()}

    def start_if_configured(self) -> None:
        """后端启动时调一次：用户上次开着拦截就继续开着。"""
        try:
            if self._blocker.load_config().get("enabled"):
                self._blocker.start()
        except Exception:
            pass
        self.start_prewarm()
        try:
            if schedule.load_config(self._data_dir).get("enabled"):
                self._scheduler.start()
        except Exception:
            pass

    # -- 空闲预扫 ---------------------------------------------------------

    PREWARM_DELAY_S = 20.0
    """开机后等多久才预扫。

    不是立刻跑：应用刚起来的头十几秒正在解锁金库、建索引、拉起 Go 跨设备进程，
    这时候再派九个线程去刨磁盘，用户感觉到的是**启动变卡了**——为了让某个
    还没打开的面板快几秒，把每次开机都拖慢，这笔账是亏的。"""

    PREWARM_MIN_AGE_S = 600.0
    """缓存比这个还新就不预扫。刚扫过又扫一遍纯属浪费电。"""

    def start_prewarm(self) -> None:
        """后台静默预扫，让用户首次打开清理面板时是满的。

        约束：只在缓存已旧时跑；用户发起扫描时立即让路（`_prewarm_stop` 置位即退）；
        异常一律吞掉，失败时用户应看到"面板空着"而非报错弹窗。
        """
        with self._lock:
            if self._prewarm_thread is not None and self._prewarm_thread.is_alive():
                return
            thread = threading.Thread(target=self._prewarm_run,
                                      name="pcclean-prewarm", daemon=True)
            self._prewarm_thread = thread
        thread.start()

    def _prewarm_run(self) -> None:
        try:
            if self._prewarm_stop.wait(self.PREWARM_DELAY_S):
                return
            cached = cachestore.load_health(self._data_dir, execute_ttl_s=CACHE_TTL_S)
            if cached and float(cached.get("age_s") or 0) < self.PREWARM_MIN_AGE_S:
                return
            self.health_check(
                {"use_cache": False},
                scan_id="__prewarm__",
                # 不给任何回调：这一轮的产物是落盘缓存，不是屏幕上的东西。
                # 真往界面推的话，用户会看到一个自己没点过的面板突然开始动。
            )
        except Exception:
            pass

    def shutdown(self) -> None:
        self._prewarm_stop.set()
        try:
            self._scheduler.stop()
        except Exception:
            pass
        try:
            self.cancel("__prewarm__")
        except Exception:
            pass
        try:
            self._blocker.stop()
        except Exception:
            pass

    # -- 白名单 -----------------------------------------------------------

    def whitelist_get(self) -> Dict[str, Any]:
        return {"ok": True, "entries": sorted(imp.load_whitelist(self._data_dir))}

    def whitelist_set(self, entries: Sequence[str]) -> Dict[str, Any]:
        saved = imp.save_whitelist(self._data_dir, entries)
        return {"ok": True, "entries": sorted(saved)}

    # -- 工具箱 -----------------------------------------------------------

    def tools(self) -> Dict[str, Any]:
        return {"ok": True, "tools": toolbox.list_tools(),
                "elevated": elevate.is_elevated()}

    def run_tool(self, tool_id: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        tool = next((t for t in toolbox.TOOLS if t.tool_id == tool_id), None)
        if tool is None:
            return {"ok": False, "error": "pcclean.toolbox.unknownTool"}
        if tool.needs_elevation and not elevate.is_elevated():
            mapped = {
                "createRestorePoint": "create_restore_point",
                "toggleHibernation": "disable_hibernation",
            }.get(tool_id)
            if mapped:
                return elevate.run_elevated(
                    elevate.HelperJob(action=mapped, payload=params or {}),
                    data_dir=self._data_dir,
                )
            # 没有对应助手动作的（renewIp / resetWinsock）直接跑，
            # 失败时错误里会带 needs_elevation，界面据此提示。
        return toolbox.run_tool(tool_id, params, data_dir=self._data_dir)

    # -- 磁盘优化 ---------------------------------------------------------

    def optimize_volume(self, drive: str, mode: str = "auto") -> Dict[str, Any]:
        """碎片整理 / TRIM。`mode='auto'` 时按介质自己选。"""
        media = space._media_types().get(drive.rstrip(":\\").upper(), "unknown")
        is_ssd = media != "HDD"
        if mode == "auto":
            action = "retrim_volume" if is_ssd else "defrag_volume"
        elif mode == "retrim":
            action = "retrim_volume"
        elif mode == "defrag":
            if is_ssd:
                # 明确拒绝对 SSD 做碎片整理。用户就算手动选了也不做 ——
                # 这是会损伤硬件的操作，"用户自己选的"不能作为损伤硬件的理由。
                return {"ok": False, "error": "pcclean.defrag.refusedOnSsd",
                        "media_type": media}
            action = "defrag_volume"
        else:
            return {"ok": False, "error": "pcclean.defrag.unknownMode"}

        job = elevate.HelperJob(action=action, payload={"drive": drive})
        result = elevate.run_elevated(job, data_dir=self._data_dir, timeout_s=3600.0)
        result["media_type"] = media
        result["is_ssd"] = is_ssd
        return result
