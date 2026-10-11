"""垃圾清理、日志清理、下载目录整理：形状相同（列目录 → 数大小 → 产出可清理项），合成一张规则表。
每条规则都要能回答「删了会丢什么」，并写进 `reason_key` 给用户看。"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean import paths
from modules.file_vault.pcclean.model import (
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)


@dataclass(frozen=True)
class JunkRule:
    """一条垃圾清理规则。`min_age_days` 最关键：删掉刚创建的临时文件可能让正在进行的安装崩掉，
    所以默认至少存在 1 天，只有确定无主的（缩略图缓存、回收站）才设 0。"""

    key: str
    """i18n 键的后缀，界面用 `pcclean.junk.<key>` 取标题和说明。"""

    resolve: Callable[[], Optional[Path]]
    importance: Importance = Importance.JUNK
    min_age_days: float = 1.0
    default_selected: bool = True
    include_dirs: bool = True
    """False = 只删目录里的文件，保留目录结构（有些程序假定目录存在）。"""

    patterns: Sequence[str] = ()
    """非空时只匹配这些后缀/文件名。空 = 整个目录。"""

    info_only: bool = False
    """只报大小、**不允许清理**（产出 `locked=True` 的条目）。

    给"占了很多空间、但不是垃圾"的目录用。判据是**这份数据是不是用户自己
    创建的**——如果是，让他知道空间在哪就够了，删除该在产生它的那个程序里做，
    因为只有在那里他才分得清每一项是什么。

    第一个用例是安卓模拟器镜像（本机 8.2 GB）。它必须 info_only，因为
    `junk` 属于 `actions.py` 的 `_HARD_DELETE_CATEGORIES`——**永久删除，不进
    回收站、没有 undo**。这对临时文件是对的，对"用户自己建的虚拟设备"是灾难。
    `_RECYCLE_CATEGORIES` 的注释早就写过这条教训：「"看起来毫无价值"正是删错时
    最容易被辩解掉的那种」。

    走 `locked` 而不是新开一个可逆性档位，是因为 `reversibility()` 的判据必须
    和 `_execute_one` 的分支同源（它自己的 docstring 和守卫测试都这么要求），
    而 `locked` 在两边都已经是"一律拒绝"，不需要新增任何分支。
    """

    whole_dir: bool = False
    """这个目录**只能整个删或整个留**，`min_age_days` 对它没有意义。

    两个理由，缺一不可：

    1. **正确性。** 依赖缓存（gradle / go mod / cargo / nuget）是一个有内部
       索引的整体，按文件年龄删掉其中一部分会把它删成**损坏状态**——比原样
       留着更糟，而用户以为自己只是"清理了旧文件"。安卓模拟器镜像同理：
       一个 AVD 是一组文件，删掉其中"旧的那几个"等于毁掉这个虚拟设备。
    2. **速度。** 这类目录动辄几万到几十万个文件（实测本机 gradle 缓存 50096 个、
       go 模块缓存 56019 个）。为了拿 mtime 而逐个 `stat`，会让 junk 这一类
       直接吃光 25 秒预算并被判成超时——加规则反而把整类扫描弄挂了。
       `paths.dir_size()` 走 `scandir` 自带的 stat 信息，不额外发系统调用。

    这类项一律 `default_selected=False`：整删是重操作，必须用户自己点。
    """


def _local(rel: str) -> Callable[[], Optional[Path]]:
    def _resolve() -> Optional[Path]:
        root = paths.known("LocalAppData")
        return (root / rel) if root else None
    return _resolve


def _windir(rel: str) -> Callable[[], Optional[Path]]:
    def _resolve() -> Optional[Path]:
        root = paths.known("Windows")
        return (root / rel) if root else None
    return _resolve


def _programdata(rel: str) -> Callable[[], Optional[Path]]:
    def _resolve() -> Optional[Path]:
        root = paths.known("ProgramData")
        return (root / rel) if root else None
    return _resolve


def _profile(rel: str) -> Callable[[], Optional[Path]]:
    """`%USERPROFILE%` 下的相对路径。不用 `paths.known`：它只认 `_FOLDERID` 里的 Shell 已知文件夹，
    `known("UserProfile")` 返回 None，而 `.gradle`、`.cargo`、`.nuget`、`.android` 都在家目录根上。"""
    def _resolve() -> Optional[Path]:
        root = paths.user_profile()
        return (root / rel) if root else None
    return _resolve


def _roaming(rel: str) -> Callable[[], Optional[Path]]:
    def _resolve() -> Optional[Path]:
        raw = os.environ.get("APPDATA")
        return (Path(raw) / rel) if raw else None
    return _resolve


JUNK_RULES: Sequence[JunkRule] = (
    JunkRule("userTemp", lambda: paths.known("Temp"), min_age_days=1.0),
    JunkRule("windowsTemp", _windir("Temp"), min_age_days=1.0),
    JunkRule("prefetch", _windir("Prefetch"), Importance.OPTIONAL, min_age_days=30.0,
             default_selected=False),
    # Prefetch 默认不勾：它是开机加速用的，删掉之后**接下来几次启动会变慢**。
    # 很多"优化工具"默认清它，然后用户抱怨电脑变卡——正好和目的相反。
    JunkRule("thumbnailCache", _local("Microsoft/Windows/Explorer"), min_age_days=0.0,
             patterns=("thumbcache_*.db", "iconcache_*.db")),
    JunkRule("windowsUpdateCache", _windir("SoftwareDistribution/Download"), min_age_days=7.0),
    JunkRule("deliveryOptimization", _windir("ServiceProfiles/NetworkService/AppData/Local/"
                                             "Microsoft/Windows/DeliveryOptimization"),
             min_age_days=3.0),
    JunkRule("crashDumps", _local("CrashDumps"), min_age_days=3.0),
    JunkRule("windowsErrorReports", _programdata("Microsoft/Windows/WER"), min_age_days=3.0),
    JunkRule("installerCache", _local("Package Cache"), Importance.OPTIONAL, min_age_days=30.0,
             default_selected=False),
    # Package Cache 默认不勾：删了以后很多软件的"修复/卸载"会要你重新下载安装包。
    JunkRule("fontCache", _local("FontCache"), min_age_days=7.0),
    JunkRule("dxCache", _local("D3DSCache"), min_age_days=7.0),
    JunkRule("nvidiaShaderCache", _local("NVIDIA/DXCache"), min_age_days=7.0),
    JunkRule("directxShaderCache", _local("Microsoft/DirectX Shader Cache"), min_age_days=7.0),
    JunkRule("officeCache", _local("Microsoft/Office/16.0/OfficeFileCache"),
             Importance.OPTIONAL, min_age_days=7.0, default_selected=False),
    JunkRule("clipboardHistoryCache", _local("Microsoft/Windows/Clipboard"), min_age_days=1.0),
    JunkRule("cbsLogs", _windir("Logs/CBS"), min_age_days=7.0),
    JunkRule("dismLogs", _windir("Logs/DISM"), min_age_days=7.0),
    JunkRule("setupLogs", _windir("Panther"), Importance.OPTIONAL, min_age_days=30.0),
    JunkRule("minidump", _windir("Minidump"), Importance.OPTIONAL, min_age_days=7.0,
             default_selected=False),

    # 开发工具缓存，装了开发环境的机器上通常比系统垃圾大一个数量级（本机十三条合计 17.9 GB）。
    # 分两档，判据是删了要付什么代价：JUNK + 默认勾选 = 纯构建产物，重建只慢一点；
    # OPTIONAL + 不勾选 = 删了要重新下载几百兆到几 G，只让用户看见，不替他勾（计费网络上误删是真实伤害）。
    # 没装对应工具时目录不存在，`_scan_rule` 直接跳过。

    # 纯构建缓存：重建只花 CPU，不花流量。
    JunkRule("pipCache", _local("pip/Cache"), min_age_days=1.0),
    JunkRule("npmCache", _local("npm-cache/_cacache"), min_age_days=1.0),
    JunkRule("yarnCache", _local("Yarn/Cache"), min_age_days=1.0),
    JunkRule("goBuildCache", _local("go-build"), min_age_days=1.0),
    JunkRule("vscodeCache", _roaming("Code/Cache"), min_age_days=1.0),
    JunkRule("vscodeCachedData", _roaming("Code/CachedData"), min_age_days=7.0),

    # 要重新下载才能恢复的：只列出来，不替用户做决定。
    # 全部 whole_dir —— 按文件年龄删掉依赖缓存的一部分会把它删坏（见 whole_dir 说明）。
    JunkRule("gradleCache", _profile(".gradle/caches"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    JunkRule("goModCache", _profile("go/pkg/mod"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    JunkRule("cargoRegistry", _profile(".cargo/registry"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    JunkRule("nugetPackages", _profile(".nuget/packages"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    JunkRule("electronCache", _local("electron/Cache"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    JunkRule("playwrightBrowsers", _local("ms-playwright"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    JunkRule("jetbrainsCaches", _local("JetBrains"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True),
    # 安卓模拟器镜像（本机 8.2 GB）是用户自建的虚拟设备，不是缓存，所以 `info_only=True`
    # （产出 locked 条目，执行侧拒绝）：`junk` 属 `_HARD_DELETE_CATEGORIES`，永久删除、无回收站、无 undo。
    # 列出只为让用户知道空间在哪，删除应去 Android Studio。
    JunkRule("androidAvd", _profile(".android/avd"), Importance.OPTIONAL,
             default_selected=False, whole_dir=True, info_only=True),
)

_BROWSER_PROCESSES = {
    "Google Chrome": ("chrome.exe",),
    "Microsoft Edge": ("msedge.exe",),
    "Mozilla Firefox": ("firefox.exe",),
    "Brave": ("brave.exe",),
    "Vivaldi": ("vivaldi.exe",),
    "Opera": ("opera.exe",),
}


def _running_browsers() -> set:
    """当前在跑的浏览器进程名集合，探不到返回空集合（宁可少提示，也不因 psutil 缺席把整类标成可能失败）。

    Chromium 开着时缓存里不少文件被独占，删除失败却无提示，用户只会看到释放空间远小于列出的数字。
    实现在 `processes.py`：走 Toolhelp32 快照，psutil 作兜底，带 TTL 缓存（体检时九个 scanner 并行）。"""
    from modules.file_vault.pcclean import processes

    return set(processes.running_names())


BROWSER_CACHE_SUBDIRS = (
    "Cache/Cache_Data",
    "Code Cache/js",
    "Code Cache/wasm",
    "GPUCache",
    "Service Worker/CacheStorage",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
)


def _matches(name: str, patterns: Sequence[str]) -> bool:
    if not patterns:
        return True
    from fnmatch import fnmatch
    return any(fnmatch(name, p) for p in patterns)


def _scan_rule(rule: JunkRule, task: ScanTask, now: float) -> Optional[CleanItem]:
    """一条规则 → 一条可清理项（或 None）。

    目录里只要有文件就产出一条。`size_bytes` 只算真正会清掉的部分（虚报可释放空间更糟），被
    "至少 1 天未改"过滤掉的量放进 detail，让界面显示「另有 X GB 因最近改动未计入，可调低门槛」。
    旧实现 `count == 0` 时直接丢弃，日志/缓存天生持续追加写，导致 9.4 GB 只报出几十兆且不说明。"""
    root = None
    try:
        root = rule.resolve()
    except (OSError, ValueError):
        root = None
    if root is None or not paths.exists(root):
        return None

    if rule.whole_dir:
        # 整目录一口价：不逐个 stat，也没有"过滤掉的部分"这个概念。
        size, n = paths.dir_size(root, should_cancel=task.cancelled)
        if n == 0:
            return None
        return CleanItem(
            item_id=f"junk:{rule.key}",
            category="junk",
            label=rule.key,
            size_bytes=size,
            path=str(root),
            importance=rule.importance,
            reason=f"pcclean.junk.{rule.key}.reason",
            locked=rule.info_only,
            default_selected=False,
            detail={
                "file_count": n,
                "total_file_count": n,
                "total_bytes": size,
                "filtered_file_count": 0,
                "filtered_bytes": 0,
                "min_age_days": 0.0,
                "patterns": [],
                "include_dirs": True,
                "whole_dir": True,
                "label_key": f"pcclean.junk.{rule.key}.label",
            },
        )

    cutoff = now - rule.min_age_days * 86400
    total = 0
    count = 0
    all_total = 0
    all_count = 0
    for file_path, size in paths.iter_files(root, should_cancel=task.cancelled):
        if not _matches(file_path.name, rule.patterns):
            continue
        all_total += size
        all_count += 1
        try:
            if rule.min_age_days > 0 and file_path.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        total += size
        count += 1

    if all_count == 0:
        return None
    return CleanItem(
        item_id=f"junk:{rule.key}",
        category="junk",
        label=rule.key,
        size_bytes=total,
        path=str(root),
        importance=rule.importance,
        reason=f"pcclean.junk.{rule.key}.reason",
        # 一条能清的都没有时不预勾：勾了也释放不出东西，只会让用户以为点了有用。
        default_selected=rule.default_selected and count > 0,
        detail={
            "file_count": count,
            "total_file_count": all_count,
            "total_bytes": all_total,
            # 「被过滤掉的量」由后端算好，前端不自己做减法，将来加别的过滤条件时前端不用改。
            "filtered_file_count": all_count - count,
            "filtered_bytes": all_total - total,
            "min_age_days": rule.min_age_days,
            "patterns": list(rule.patterns),
            "include_dirs": rule.include_dirs,
            "label_key": f"pcclean.junk.{rule.key}.label",
        },
    )


def scan_junk(task: ScanTask, *, age_scale: float = 1.0,
              min_age_days_override: Optional[float] = None,
              deep: bool = False) -> ScanReport:
    """系统垃圾：临时文件、各类缓存、更新残留、崩溃转储、日志。

    `age_scale` / `min_age_days_override` 让用户调「多久没动过才算垃圾」：默认 1 天是对的（安装程序会
    写临时目录），但知道没有安装任务时调到 0 能多清一百多兆。`age_scale=0` 不看时间，`2` 门槛翻倍；
    override 顶掉每条规则各自的值。

    `deep` 默认 False：`whole_dir` 开发工具缓存要走遍十几万目录项（冷缓存 10~15 秒），放进默认路径
    会把一键体检从 5.5 秒拖到 34 秒（`test_pcclean_perf_budget.py` 守护）。默认只跑便宜规则，另给
    `analysed=False` 占位项（界面 `health.needsSeparateAnalysis`），到「空间分析」再单独算。
    """
    items: List[CleanItem] = []
    errors: List[str] = []
    now = time.time()
    active_rules = [r for r in JUNK_RULES if deep or not r.whole_dir]
    skipped_heavy = [r for r in JUNK_RULES if r.whole_dir] if not deep else []
    total_rules = len(active_rules) + 1  # +1 给回收站

    for index, rule in enumerate(active_rules):
        if task.cancelled():
            break
        try:
            effective = rule
            if min_age_days_override is not None:
                effective = replace(rule, min_age_days=max(0.0, float(min_age_days_override)))
            elif age_scale != 1.0:
                effective = replace(rule, min_age_days=max(0.0, rule.min_age_days * age_scale))
            item = _scan_rule(effective, task, now)
            if item:
                items.append(item)
        except Exception as exc:  # 单条规则失败不该毁掉整次扫描
            errors.append(f"{rule.key}: {type(exc).__name__}")
        task.progress(index + 1, total_rules)

    recycle = _scan_recycle_bin(task)
    if recycle:
        items.append(recycle)

    # 跳过的那批必须留痕，否则装了开发环境的机器一键体检会静默漏掉十几 GB，却显示成完整报告。
    if skipped_heavy:
        items.append(CleanItem(
            item_id="junk:devCachesPending",
            category="junk",
            label="devCachesPending",
            size_bytes=0,
            path="",
            importance=Importance.OPTIONAL,
            reason="pcclean.junk.devCachesPending.reason",
            locked=True,
            default_selected=False,
            detail={
                # 复用 CleanItemList 里 analysed=False 那条渲染分支，
                # 界面直接显示"还没算过大小，要单独跑一次分析（约 N 分钟）"。
                "analysed": False,
                "analysis_seconds_estimate": 20,
                "pending_rules": [r.key for r in skipped_heavy],
                "label_key": "pcclean.junk.devCachesPending.label",
            },
        ))

    task.progress(total_rules, total_rules)
    return task.report(items, errors=errors)


def _scan_recycle_bin(task: ScanTask) -> Optional[CleanItem]:
    """回收站。走 Shell API 问大小，不去遍历 `$Recycle.Bin` ——
    那个目录的 ACL 只对所有者开放，遍历会大面积拒绝访问，数出来的值偏小很多。"""
    if not paths.IS_WINDOWS:
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class SHQUERYRBINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("i64Size", ctypes.c_longlong),
                ("i64NumItems", ctypes.c_longlong),
            ]

        info = SHQUERYRBINFO()
        info.cbSize = ctypes.sizeof(info)
        # pszRootPath=None → 全部驱动器
        hr = ctypes.windll.shell32.SHQueryRecycleBinW(None, ctypes.byref(info))
        if hr != 0 or info.i64NumItems <= 0:
            return None
        return CleanItem(
            item_id="junk:recycleBin",
            category="junk",
            label="recycleBin",
            size_bytes=int(info.i64Size),
            path="",
            importance=Importance.JUNK,
            reason="pcclean.junk.recycleBin.reason",
            default_selected=False,
            # 回收站默认**不勾选**：它是用户主动放进去的东西，里面可能有他还想找回来的。
            # 其他清理项都是系统自己产生的，回收站是唯一"用户内容"的那一项。
            detail={
                "file_count": int(info.i64NumItems),
                "special": "recycle_bin",
                "label_key": "pcclean.junk.recycleBin.label",
            },
        )
    except (OSError, AttributeError, ValueError):
        return None


def scan_browser_cache(task: ScanTask) -> ScanReport:
    """浏览器缓存。与 Cookie/历史分开：缓存删了只是慢一点，Cookie 删了会掉线所有网站。

    每个配置文件一条而不是每个浏览器一条：合并成一行时用户有多个 Profile（多半是不同账号），
    只能全清或全不清，粒度太粗以致不敢点。"""
    items: List[CleanItem] = []
    running = _running_browsers()
    browsers = paths.browser_profile_roots()
    for index, (label, root) in enumerate(browsers):
        if task.cancelled():
            break
        # Chromium 系每个 Profile 一份缓存；Firefox 的结构不同，整棵当一份。
        units: List[Tuple[str, Path, List[Path]]] = []
        if label == "Mozilla Firefox":
            units.append((label, root, [root]))
        else:
            for profile in _chromium_profiles(root):
                units.append((
                    f"{label} · {profile.name}",
                    profile,
                    [profile / sub for sub in BROWSER_CACHE_SUBDIRS],
                ))
        for unit_label, unit_root, candidates in units:
            if task.cancelled():
                break
            total = 0
            count = 0
            for candidate in candidates:
                if not paths.exists(candidate):
                    continue
                size, n = paths.dir_size(candidate, should_cancel=task.cancelled)
                total += size
                count += n
            if not count:
                continue
            items.append(CleanItem(
                # item_id 用 Profile 目录名而非显示名：显示名随 i18n 和分隔符写法变，item_id 要在两次扫描间稳定
                # （前端用它回传勾选状态，见 CleanItem.item_id）。
                item_id=f"browserCache:{label}:{unit_root.name}",
                category="browserCache",
                label=unit_label,
                size_bytes=total,
                path=str(unit_root),
                importance=Importance.JUNK,
                reason="pcclean.browser.cache.reason",
                default_selected=True,
                detail={"file_count": count, "browser": label,
                        "profile": unit_root.name,
                        # True = 这个浏览器现在开着，缓存文件多半被独占，
                        # 清理会部分失败。界面据此提示"先关掉它"。
                        "browser_running": any(
                            p in running for p in _BROWSER_PROCESSES.get(label, ())),
                        "subdirs": list(BROWSER_CACHE_SUBDIRS)},
            ))
        task.progress(index + 1, max(1, len(browsers)))
    items.sort(key=lambda i: i.size_bytes, reverse=True)
    return task.report(items)


def _chromium_profiles(user_data: Path) -> List[Path]:
    """Chromium 的 Profile 目录：`Default`、`Profile 1`、`Profile 2`…
    只按名字挑，别把 `System Profile`、`Crashpad` 这些也当成用户 Profile。"""
    out: List[Path] = []
    try:
        for entry in user_data.iterdir():
            if not entry.is_dir():
                continue
            name = entry.name
            if name == "Default" or name.startswith("Profile "):
                out.append(entry)
    except OSError:
        pass
    return out


_INSTALLER_SUFFIXES = (".exe", ".msi", ".msix", ".appx")
_ARCHIVE_SUFFIXES = (".zip", ".rar", ".7z", ".tar", ".gz", ".xz", ".iso")
_MEDIA_SUFFIXES = (".mp4", ".mkv", ".avi", ".mov", ".mp3", ".flac", ".wav")
_DOC_SUFFIXES = (".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".epub")


def scan_downloads(task: ScanTask, *, stale_days: float = 60.0) -> ScanReport:
    """下载目录整理。只列出，不默认勾选任何项：下载目录全是用户自己的文件，默认勾选可能删掉未备份的东西。"""
    root = paths.known("Downloads")
    if root is None:
        return task.report([], errors=["downloads.not_found"])

    items: List[CleanItem] = []
    now = time.time()
    files = list(paths.iter_files(root, max_depth=3, should_cancel=task.cancelled))
    for index, (file_path, size) in enumerate(files):
        if task.cancelled():
            break
        suffix = file_path.suffix.lower()
        try:
            mtime = file_path.stat().st_mtime
        except OSError:
            continue
        age_days = (now - mtime) / 86400
        if suffix in _INSTALLER_SUFFIXES:
            kind = "installer"
        elif suffix in _ARCHIVE_SUFFIXES:
            kind = "archive"
        elif suffix in _MEDIA_SUFFIXES:
            kind = "media"
        elif suffix in _DOC_SUFFIXES:
            kind = "document"
        else:
            kind = "other"

        # 装完就没用的安装包 + 放了很久 = 唯一敢建议清的一类，
        # 但仍然 default_selected=False。
        suggest = kind == "installer" and age_days >= stale_days
        items.append(CleanItem(
            item_id=f"download:{file_path}",
            category="downloads",
            label=file_path.name,
            size_bytes=size,
            path=str(file_path),
            importance=Importance.OPTIONAL if suggest else Importance.COMMON,
            reason="pcclean.downloads.staleInstaller" if suggest else "pcclean.downloads.userFile",
            default_selected=False,
            detail={"kind": kind, "age_days": round(age_days, 1)},
        ))
        if index % 200 == 0:
            task.progress(index, max(1, len(files)))
    task.progress(len(files), max(1, len(files)))
    items.sort(key=lambda i: i.size_bytes, reverse=True)
    return task.report(items)
