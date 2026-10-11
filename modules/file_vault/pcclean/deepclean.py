"""三类内置规则够不着的深度清理：浏览器分项数据（browserData）、被顶替的旧驱动包（driverStore）、
空文件夹/失效快捷方式/零字节文件（emptyDirs）。收录标准同 `toolbox.py`：必须有可测收益且系统自带界面做不到。

安全线：
1. 默认一个都不勾：这三类删了不会自己重建（Cookie 要重新登录、驱动要重装、空目录可能是用户建的结构）。
2. 密码文件永远不列：Chromium `Login Data`、Firefox `logins.json` / `key4.db`。
3. Firefox `places.sqlite` 不收：历史和书签在同一文件，无法只删前者。
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean import paths, processes
from modules.file_vault.pcclean.model import CleanItem, Importance, ScanReport, ScanTask

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


@dataclass(frozen=True)
class BrowserDataKind:
    key: str
    """i18n 键的中缀，也是 item_id 的一部分。"""

    files: Tuple[str, ...]
    """Profile 目录下的相对路径。文件和目录都行。"""

    importance: Importance = Importance.OPTIONAL
    """`JUNK` 只给纯缓存那几项——它们删了确实没有任何损失。"""


# Chromium 系（Chrome / Edge / Brave / Vivaldi / Opera / 国产套壳）。Chrome 86 后部分文件从 Profile
# 根移到 `Network/`；两处都列，不存在的自然跳过。按版本号分支会在浏览器更新后静默扫出 0 项。
_CHROMIUM_KINDS: Sequence[BrowserDataKind] = (
    BrowserDataKind("cookies", ("Network/Cookies", "Cookies",
                                "Network/Cookies-journal", "Cookies-journal")),
    BrowserDataKind("history", ("History", "History-journal", "Visited Links",
                                "Top Sites", "Network Action Predictor")),
    BrowserDataKind("downloadRecords", ("DownloadMetadata",)),
    BrowserDataKind("formData", ("Web Data", "Web Data-journal")),
    BrowserDataKind("sessions", ("Sessions", "Current Session", "Current Tabs",
                                 "Last Session", "Last Tabs")),
    BrowserDataKind("siteData", ("Local Storage", "Session Storage",
                                 "IndexedDB", "databases")),
    BrowserDataKind("serviceWorker", ("Service Worker",), Importance.JUNK),
    BrowserDataKind("gpuCache", ("GPUCache", "ShaderCache", "DawnCache",
                                 "DawnGraphiteCache", "DawnWebGPUCache"),
                    Importance.JUNK),
    BrowserDataKind("codeCache", ("Code Cache",), Importance.JUNK),
    BrowserDataKind("favicons", ("Favicons", "Favicons-journal"), Importance.JUNK),
)

# Firefox。**刻意短很多**：它把历史和书签放在同一个 `places.sqlite` 里，
# 而 `logins.json`/`key4.db` 是密码库。两者都不收，剩下的才是能安全分项的。
_FIREFOX_KINDS: Sequence[BrowserDataKind] = (
    BrowserDataKind("cookies", ("cookies.sqlite", "cookies.sqlite-wal")),
    BrowserDataKind("formData", ("formhistory.sqlite",)),
    BrowserDataKind("sessions", ("sessionstore-backups", "sessionstore.jsonlz4",
                                 "recovery.jsonlz4")),
    BrowserDataKind("siteData", ("storage/default",)),
    BrowserDataKind("gpuCache", ("startupCache", "shader-cache"), Importance.JUNK),
)

# 绝不列出的文件名。用显式黑名单：上面的 kind 含目录（`storage/default`），其内容随浏览器版本变化。
_NEVER_TOUCH = {
    "login data", "login data-journal", "login data for account",
    "logins.json", "key4.db", "key3.db", "cert9.db", "signons.sqlite",
    "bookmarks", "bookmarks.bak", "places.sqlite", "favicons.sqlite",
    "affiliation database", "web data-journal.bak",
}


def _profiles_of(label: str, root: Path) -> List[Tuple[str, Path]]:
    """(Profile 显示名, 目录)。Firefox 和 Chromium 的目录结构不一样。"""
    out: List[Tuple[str, Path]] = []
    try:
        if label == "Mozilla Firefox":
            for entry in root.iterdir():
                if entry.is_dir() and (entry / "prefs.js").exists():
                    out.append((entry.name.split(".", 1)[-1] or entry.name, entry))
        else:
            for entry in root.iterdir():
                if not entry.is_dir():
                    continue
                if entry.name == "Default" or entry.name.startswith("Profile "):
                    out.append((entry.name, entry))
    except OSError:
        pass
    return out


def _measure(base: Path, rel: str, should_cancel) -> Tuple[int, int]:
    """(字节, 个数)。目录就整棵数，文件就是它自己。"""
    target = base / rel
    if not paths.exists(target):
        return 0, 0
    if target.name.lower() in _NEVER_TOUCH:
        return 0, 0
    try:
        if target.is_dir():
            return paths.dir_size(target, should_cancel=should_cancel)
        return target.stat().st_size, 1
    except OSError:
        paths.bump_scan_stat("denied")
        return 0, 0


def scan_browser_data(task: ScanTask) -> ScanReport:
    """浏览器分项数据（Cookie、历史、表单、站点数据）。

    与只碰纯缓存的 `browserCache` 是两件事（删了要重新登录），所以分开，且一项都不默认勾选。
    """
    items: List[CleanItem] = []
    errors: List[str] = []
    browsers = paths.browser_profile_roots()
    if not browsers:
        # 一个浏览器都没找到 ≠ 这台机器很干净。记一条，让界面能说清楚。
        return task.report([], errors=["browserData.noBrowserFound"])

    for index, (label, root) in enumerate(browsers):
        if task.cancelled():
            break
        kinds = _FIREFOX_KINDS if label == "Mozilla Firefox" else _CHROMIUM_KINDS
        profiles = _profiles_of(label, root)
        if not profiles:
            # Chromium 有时把数据直接放在 User Data 根（老版本、绿色版）。
            profiles = [("", root)]

        for profile_name, profile_dir in profiles:
            if task.cancelled():
                break
            paths.bump_scan_stat("dirs")
            for kind in kinds:
                total = 0
                count = 0
                present: List[str] = []
                for rel in kind.files:
                    size, n = _measure(profile_dir, rel, task.cancelled)
                    if n:
                        total += size
                        count += n
                        present.append(rel)
                if not present:
                    continue
                suffix = f" · {profile_name}" if profile_name else ""
                items.append(CleanItem(
                    item_id=f"browserData:{label}:{profile_name}:{kind.key}",
                    category="browserData",
                    label=f"{label}{suffix}",
                    size_bytes=total,
                    path=str(profile_dir),
                    importance=kind.importance,
                    reason=f"pcclean.browserData.{kind.key}.reason",
                    # **全部 False。** 见文件头第 1 条。
                    default_selected=False,
                    detail={
                        "browser": label,
                        "profile": profile_name,
                        "kind": kind.key,
                        "files": present,
                        "file_count": count,
                        "label_key": f"pcclean.browserData.{kind.key}.label",
                    },
                ))
        task.progress(index + 1, max(1, len(browsers)))

    # 浏览器开着时 Cookie / 站点数据的 SQLite 被独占，删除必败；要提前说明，否则「点了清除 Cookie
    # 还是登录着」会被当成功能坏了。
    processes.annotate_browser_items(items)

    # 同一个浏览器的项排在一起，组内按占用倒序。
    items.sort(key=lambda i: (i.detail.get("browser", ""), -i.size_bytes))
    return task.report(items, errors=errors)


_DRIVER_FIELD = re.compile(
    r"^\s*(?:Published Name|发布名称|Original Name|原始名称|Provider Name|提供程序名称|"
    r"Class Name|类名称|Driver Version|驱动程序版本|Class|类)\s*[:：]\s*(.+?)\s*$",
    re.M,
)


def _pnputil_packages() -> List[Dict[str, str]]:
    """`pnputil /enum-drivers` 的解析结果。列出不需要提权（删才需要）。

    按空行分隔的段落解析，不按字段名：字段名是本地化的（中文叫「发布名称」），按英文名匹配会在中文
    Windows 上静默返回空列表。
    """
    try:
        proc = subprocess.run(
            ["pnputil.exe", "/enum-drivers"],
            capture_output=True, timeout=60.0, creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    raw = (proc.stdout or b"") + (proc.stderr or b"")
    text = ""
    for encoding in ("utf-8", "gbk", "mbcs"):
        try:
            text = raw.decode(encoding)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if not text:
        return []

    packages: List[Dict[str, str]] = []
    current: Dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            if current.get("published"):
                packages.append(current)
            current = {}
            continue
        if ":" not in line and "：" not in line:
            continue
        key, _, value = line.replace("：", ":").partition(":")
        key = key.strip().lower()
        value = value.strip()
        if "published" in key or "发布名称" in key:
            current["published"] = value
        elif "original" in key or "原始名称" in key:
            current["original"] = value
        elif "provider" in key or "提供程序" in key:
            current["provider"] = value
        elif "class" in key or key.startswith("类"):
            current.setdefault("class", value)
        elif "version" in key or "版本" in key:
            current["version"] = value
    if current.get("published"):
        packages.append(current)
    return packages


def _version_key(raw: str) -> Tuple:
    """把 `10/25/2023 31.0.15.3623` 排成可比较的元组：先按日期再按版本。不能直接比字符串，
    `9/1/2024` 会排在 `10/25/2023` 前面。"""
    date_part, _, version_part = raw.strip().partition(" ")
    stamp = 0.0
    for fmt in ("%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d", "%Y-%m-%d"):
        try:
            stamp = time.mktime(time.strptime(date_part, fmt))
            break
        except (ValueError, OverflowError):
            continue
    numbers = tuple(int(n) for n in re.findall(r"\d+", version_part)[:4])
    return (stamp, numbers)


def _repository_sizes(should_cancel) -> Dict[str, List[Tuple[Path, int, float]]]:
    """DriverStore 里每个 inf 名下有哪几份副本（大小、放入时间）。

    `FileRepository` 目录名形如 `nvhda.inf_amd64_2c3d...`，前缀是 inf 原名，按前缀分组即得同一驱动的各代。
    """
    root = paths.known("Windows")
    if root is None:
        return {}
    repo = root / "System32" / "DriverStore" / "FileRepository"
    if not paths.exists(repo):
        return {}
    groups: Dict[str, List[Tuple[Path, int, float]]] = {}
    try:
        for entry in repo.iterdir():
            if should_cancel and should_cancel():
                break
            if not entry.is_dir():
                continue
            paths.bump_scan_stat("dirs")
            stem = entry.name.split(".inf_", 1)[0].lower()
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                paths.bump_scan_stat("denied")
                continue
            size, _ = paths.dir_size(entry, should_cancel=should_cancel)
            groups.setdefault(stem, []).append((entry, size, mtime))
    except OSError:
        paths.bump_scan_stat("denied")
    return groups


def scan_driver_store(task: ScanTask) -> ScanReport:
    """列出被新版本顶替的旧驱动包（Windows 装驱动不删旧的，显卡驱动可攒十几代、每代 300~800 MB）。

    大小是启发式对应：`pnputil` 给发布名和版本，`FileRepository` 给目录和字节数，两者无直接对应字段，
    所以按 inf 原名分组、各自按时间排序后逐个配对；组内数量对不上就不报大小（size=0），错数字比没有更糟。
    """
    if not paths.IS_WINDOWS:
        return task.report([], errors=["driverStore.windows_only"])

    packages = _pnputil_packages()
    if not packages:
        return task.report([], errors=["driverStore.enumFailed"])
    task.progress(1, 3)

    repo = _repository_sizes(task.cancelled)
    task.progress(2, 3)

    # 按 (原始 inf 名, 提供者) 分组。同名不同厂商的 inf 确实存在。
    grouped: Dict[Tuple[str, str], List[Dict[str, str]]] = {}
    for pkg in packages:
        key = (str(pkg.get("original", "")).lower(), str(pkg.get("provider", "")))
        grouped.setdefault(key, []).append(pkg)

    items: List[CleanItem] = []
    for (original, provider), group in grouped.items():
        if task.cancelled():
            break
        if len(group) < 2:
            continue  # 只有一代，那一代还在用
        group.sort(key=lambda p: _version_key(str(p.get("version", ""))), reverse=True)
        stem = original.rsplit(".inf", 1)[0]
        copies = sorted(repo.get(stem, []), key=lambda c: c[2], reverse=True)
        # 最新那一份留着，剩下的是可清理的旧代。
        for offset, pkg in enumerate(group[1:], start=1):
            size = copies[offset][1] if offset < len(copies) else 0
            items.append(CleanItem(
                item_id=f"driverStore:{pkg.get('published')}",
                category="driverStore",
                label=f"{provider} · {original}",
                size_bytes=size,
                path=str(copies[offset][0]) if offset < len(copies) else "",
                importance=Importance.OPTIONAL,
                reason="pcclean.driverStore.superseded.reason",
                # 默认不勾。删了要重装才回得来，而"回滚驱动"确实是有人会用的功能。
                default_selected=False,
                detail={
                    "published": pkg.get("published", ""),
                    "original": original,
                    "provider": provider,
                    "version": pkg.get("version", ""),
                    "driver_class": pkg.get("class", ""),
                    "generation": offset,
                    "needs_elevation": True,
                    "size_estimated": offset >= len(copies),
                    "label_key": "pcclean.driverStore.superseded.label",
                },
            ))
    task.progress(3, 3)
    items.sort(key=lambda i: -i.size_bytes)
    return task.report(items, probes=len(packages))


_EMPTY_SCAN_ROOTS = ("Desktop", "Documents", "Downloads")
_EMPTY_DIR_LIMIT = 3000

# 不当成"空文件夹"的名字。这些是程序按约定创建的占位目录，删了会让对应的
# 软件在下次启动时报错——而它们看起来跟用户手滑建出来的空目录一模一样。
_KEEP_EMPTY_NAMES = {
    ".git", ".vs", ".idea", "node_modules", "__pycache__",
    "bin", "obj", "build", "dist", "logs", "temp", "cache",
}


def _is_broken_shortcut(path: Path) -> bool:
    """.lnk 指向的目标是否还在。

    不引 pywin32，直接在文件里找绝对路径（LinkInfo 存明文，UTF-16 和 ANSI 各一份）。

    判据是「所有候选路径都不存在」而非「第一个不存在」：lnk 里有目标、工作目录、图标、安装器旧路径，
    按第一条判会因图标路径变了误杀正常快捷方式。宁可漏报也不误报，因为用户会全选后一起送进回收站。
    """
    try:
        raw = path.read_bytes()[:8192]
    except OSError:
        return False

    candidates: List[str] = []
    for encoding in ("utf-16-le", "mbcs", "utf-8"):
        try:
            text = raw.decode(encoding, errors="ignore")
        except (LookupError, UnicodeDecodeError):
            continue
        for match in re.finditer(r"[A-Za-z]:\\[^\x00\r\n\"<>|*?]{3,200}", text):
            candidate = match.group(0).rstrip("\\ ")
            if len(candidate) >= 6:
                candidates.append(candidate)

    # 一条路径都没解析出来则当成好的：可能指向网络共享、shell 命名空间（此电脑、控制面板）或未知格式，
    # 这些不是失效，说成失效最易误删。
    if not candidates:
        return False

    for candidate in candidates:
        try:
            if Path(candidate).exists():
                return False
        except (OSError, ValueError):
            # 路径非法或访问被拒都不构成"目标不存在"的证据。
            return False
    return True


def scan_empty_dirs(task: ScanTask, *, roots: Optional[Sequence[str]] = None) -> ScanReport:
    """空文件夹、失效快捷方式、零字节文件。只扫桌面/文档/下载：整盘的空目录多是程序自建的
    （见 `_KEEP_EMPTY_NAMES`），列出来只会制造焦虑。"""
    targets: List[Path] = []
    for name in (roots or _EMPTY_SCAN_ROOTS):
        candidate = Path(name) if os.path.isabs(str(name)) else (paths.known(str(name)) or None)
        if candidate is not None and paths.exists(candidate):
            targets.append(candidate)
    if not targets:
        return task.report([], errors=["emptyDirs.noRoot"])

    items: List[CleanItem] = []
    truncated = False
    seen_dirs = 0

    for root in targets:
        if task.cancelled():
            break
        # 自底向上：先看最深的目录，这样"清空之后才变空"的父目录也能识别出来。
        for current, dirnames, filenames in os.walk(root, topdown=False):
            if task.cancelled():
                break
            here = Path(current)
            seen_dirs += 1
            paths.bump_scan_stat("dirs")

            for name in filenames:
                target = here / name
                lower = name.lower()
                try:
                    size = target.stat().st_size
                except OSError:
                    paths.bump_scan_stat("denied")
                    continue
                paths.bump_scan_stat("files")

                if lower.endswith(".lnk") and _is_broken_shortcut(target):
                    items.append(CleanItem(
                        item_id=f"emptyDirs:lnk:{target}",
                        category="emptyDirs",
                        label=name,
                        size_bytes=size,
                        path=str(target),
                        importance=Importance.OPTIONAL,
                        reason="pcclean.emptyDirs.brokenShortcut.reason",
                        default_selected=False,
                        detail={"kind": "brokenShortcut", "parent": str(here),
                                "label_key": "pcclean.emptyDirs.brokenShortcut.label"},
                    ))
                elif size == 0 and not lower.startswith("."):
                    items.append(CleanItem(
                        item_id=f"emptyDirs:zero:{target}",
                        category="emptyDirs",
                        label=name,
                        size_bytes=0,
                        path=str(target),
                        importance=Importance.OPTIONAL,
                        reason="pcclean.emptyDirs.zeroByte.reason",
                        default_selected=False,
                        detail={"kind": "zeroByte", "parent": str(here),
                                "label_key": "pcclean.emptyDirs.zeroByte.label"},
                    ))
                if len(items) >= _EMPTY_DIR_LIMIT:
                    truncated = True
                    break

            if truncated:
                break
            if here == root:
                continue          # 不把 `下载` 这种根目录自己列成"空文件夹"
            if dirnames or filenames:
                continue
            if here.name.lower() in _KEEP_EMPTY_NAMES or here.name.startswith("."):
                continue
            items.append(CleanItem(
                item_id=f"emptyDirs:dir:{here}",
                category="emptyDirs",
                label=here.name,
                size_bytes=0,
                path=str(here),
                importance=Importance.OPTIONAL,
                reason="pcclean.emptyDirs.emptyFolder.reason",
                default_selected=False,
                detail={"kind": "emptyFolder", "parent": str(here.parent),
                        "label_key": "pcclean.emptyDirs.emptyFolder.label"},
            ))
        if truncated:
            break

    items.sort(key=lambda i: (str(i.detail.get("kind")), i.label.lower()))
    return task.report(items, truncated=truncated)
