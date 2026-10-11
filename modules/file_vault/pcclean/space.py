"""空间分析：C 盘瘦身、大文件、目录占用、重复文件、碎片整理。

1. 重复文件用三级哈希：先按大小分组（不读盘），再按头尾 64KB 采样，最后只对采样相同的做全量；
   实测 500 GB 盘上全量哈希字节不到总量的 2%。
2. SSD 绝不做碎片整理（只有写放大）：显式查介质类型，SSD 只给 TRIM 并在界面说明原因。
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import subprocess
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from modules.file_vault.pcclean import paths
from modules.file_vault.pcclean.model import (
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _run(args: List[str], timeout: float = 60.0) -> Tuple[int, str]:
    """跑一条命令，返回 (退出码, 合并输出)；带 `creationflags=CREATE_NO_WINDOW`，否则每次扫描都闪
    黑色控制台窗口。"""
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
            shell=False,
        )
        out = (proc.stdout or b"").decode("utf-8", errors="replace")
        err = (proc.stderr or b"").decode("utf-8", errors="replace")
        return proc.returncode, (out + err)
    except (OSError, subprocess.SubprocessError):
        return -1, ""


# C 盘瘦身


def scan_disk_slimming(task: ScanTask, *, deep: bool = False) -> ScanReport:
    """系统盘瘦身：每项执行都需管理员权限，但扫描本身不需要，进面板不会弹 UAC。

    `deep` 开关是性能关键，别去掉：`dism /AnalyzeComponentStore` 要 60~180 秒（解析 WinSxS 数十万
    硬链接），
    遍历 C 盘一级目录算占用要数十秒（数百万次 stat）；放在默认路径时一键体检跑了 117 秒。
    默认 `deep=False`，这两项返回"待分析"占位，界面显示为可点按钮，并告知用户要花两分钟。
    """
    items: List[CleanItem] = []
    errors: List[str] = []
    drive = paths.system_drive()
    steps = 6

    # 1. 休眠文件。等于物理内存大小，16 GB 内存就是 16 GB 的 hiberfil.sys。
    hiber = Path(f"{drive}\\hiberfil.sys")
    try:
        if paths.exists(hiber):
            size = hiber.stat().st_size
            items.append(CleanItem(
                item_id="disk:hibernation",
                category="diskSlimming",
                label="hibernation",
                size_bytes=size,
                path=str(hiber),
                importance=Importance.OPTIONAL,
                reason="pcclean.disk.hibernation.reason",
                default_selected=False,
                detail={"action": "disable_hibernation", "needs_elevation": True,
                        "label_key": "pcclean.disk.hibernation.label",
                        "reversible": True},
            ))
    except OSError as exc:
        errors.append(f"hibernation: {type(exc).__name__}")
    task.progress(1, steps)

    # 2. WinSxS 组件存储。这里报的是 DISM 算出来的"可回收"部分，
    #    不是整个 WinSxS 的大小 —— 后者绝大部分是硬链接，报出来会严重虚高。
    if not task.cancelled():
        reclaimable = _winsxs_reclaimable() if deep else -1
        if reclaimable != 0:
            items.append(CleanItem(
                item_id="disk:winsxs",
                category="diskSlimming",
                label="componentStore",
                size_bytes=max(0, reclaimable),
                path=f"{drive}\\Windows\\WinSxS",
                importance=Importance.OPTIONAL,
                reason="pcclean.disk.componentStore.reason",
                default_selected=False,
                detail={"action": "dism_cleanup", "needs_elevation": True,
                        "label_key": "pcclean.disk.componentStore.label",
                        "reversible": False,
                        # analysed=False → 界面显示「分析（约 2 分钟）」按钮，
                        # 而不是一个数字。用户点了才跑 deep 扫描。
                        "analysed": deep,
                        "analysis_seconds_estimate": 120,
                        "irreversible_note": "pcclean.disk.componentStore.irreversible"},
            ))
    task.progress(2, steps)

    # 3. 系统还原点
    if not task.cancelled():
        try:
            used = _restore_point_usage(drive)
            if used > 0:
                items.append(CleanItem(
                    item_id="disk:restorePoints",
                    category="diskSlimming",
                    label="restorePoints",
                    size_bytes=used,
                    path=drive,
                    importance=Importance.OPTIONAL,
                    reason="pcclean.disk.restorePoints.reason",
                    default_selected=False,
                    detail={"action": "shrink_shadow_storage", "needs_elevation": True,
                            "label_key": "pcclean.disk.restorePoints.label",
                            "reversible": False},
                ))
        except Exception as exc:
            errors.append(f"restorePoints: {type(exc).__name__}")
    task.progress(3, steps)

    # 4. 页面文件（只报告大小和位置，不建议动 —— 关掉它会让内存吃紧时直接崩程序）
    pagefile = Path(f"{drive}\\pagefile.sys")
    try:
        if paths.exists(pagefile):
            items.append(CleanItem(
                item_id="disk:pagefile",
                category="diskSlimming",
                label="pagefile",
                size_bytes=pagefile.stat().st_size,
                path=str(pagefile),
                importance=Importance.CRITICAL,
                reason="pcclean.disk.pagefile.reason",
                locked=True,
                default_selected=False,
                detail={"action": "info_only", "needs_elevation": False,
                        "label_key": "pcclean.disk.pagefile.label"},
            ))
    except OSError:
        pass
    task.progress(4, steps)

    # 5. Windows.old（升级留下的旧系统，通常十几 GB）
    win_old = Path(f"{drive}\\Windows.old")
    if not task.cancelled() and paths.exists(win_old):
        size, count = paths.dir_size(win_old, should_cancel=task.cancelled)
        if size > 0:
            items.append(CleanItem(
                item_id="disk:windowsOld",
                category="diskSlimming",
                label="windowsOld",
                size_bytes=size,
                path=str(win_old),
                importance=Importance.OPTIONAL,
                reason="pcclean.disk.windowsOld.reason",
                default_selected=False,
                detail={"action": "delete_tree", "needs_elevation": True,
                        "file_count": count, "reversible": False,
                        "label_key": "pcclean.disk.windowsOld.label",
                        "irreversible_note": "pcclean.disk.windowsOld.irreversible"},
            ))
    task.progress(5, steps)

    # 6. 大目录占用：列出 C 盘最大的几个一级目录，纯信息、不可清理。
    # 实测 64 秒（stat 数百万文件），是一键体检曾跑 117 秒的主因，不是 DISM（非提权下 46ms 就失败
    # 返回）。
    if not task.cancelled():
        if deep:
            try:
                items.extend(_top_level_usage(drive, task))
            except Exception as exc:
                errors.append(f"topLevelUsage: {type(exc).__name__}")
        else:
            # 快路径给一条"整盘用了多少"（GetDiskFreeSpaceEx，微秒级），
            # 外加一个"要不要细看"的入口。
            try:
                total, free = _disk_space(drive + "\\")
                items.append(CleanItem(
                    item_id="disk:usage:summary",
                    category="diskSlimming",
                    label=drive,
                    size_bytes=total - free,
                    path=drive + "\\",
                    importance=Importance.CRITICAL,
                    reason="pcclean.disk.usageSummary.reason",
                    locked=True,
                    default_selected=False,
                    detail={"action": "analyse_usage", "analysed": False,
                            "total_bytes": total, "free_bytes": free,
                            "analysis_seconds_estimate": 60,
                            "label_key": "pcclean.disk.usageSummary.label"},
                ))
            except OSError as exc:
                errors.append(f"diskSpace: {type(exc).__name__}")
    task.progress(steps, steps)

    return task.report(items, errors=errors)


def _winsxs_reclaimable() -> int:
    """问 DISM 组件存储有多少可回收；要几十秒且需管理员权限。

    无权限时它返回错误而非 0，拿不到就返回 0 并让该项不出现，不报"0 字节可回收"。
    """
    code, out = _run(
        ["dism.exe", "/Online", "/Cleanup-Image", "/AnalyzeComponentStore"],
        timeout=180.0,
    )
    if code != 0 or not out:
        return 0
    # 输出里有中英文两种可能，抓数字 + 单位
    import re
    match = re.search(
        r"(?:Actual Size of Component Store|组件存储的实际大小)\s*:\s*([\d.]+)\s*(KB|MB|GB)",
        out, re.IGNORECASE)
    reclaim = re.search(
        r"(?:Reclaimable Packages|可回收的程序包)\s*:\s*(\d+)", out, re.IGNORECASE)
    if not match:
        return 0
    value = float(match.group(1))
    unit = match.group(2).upper()
    scale = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}[unit]
    actual = int(value * scale)
    # DISM 不直接给"可回收字节数"，只给包数。用一个保守的估计：
    # 有可回收包时按组件存储的 15% 估，没有就是 0。宁可少报也不虚报。
    if reclaim and int(reclaim.group(1)) > 0:
        return int(actual * 0.15)
    return 0


def _restore_point_usage(drive: str) -> int:
    code, out = _run(["vssadmin.exe", "list", "shadowstorage", f"/for={drive}"], timeout=30.0)
    if code != 0 or not out:
        return 0
    import re
    match = re.search(r"(?:Used Shadow Copy Storage space|已用的卷影副本存储空间)"
                      r"[^:]*:\s*([\d.,]+)\s*(KB|MB|GB|TB)", out, re.IGNORECASE)
    if not match:
        return 0
    value = float(match.group(1).replace(",", ""))
    scale = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}[match.group(2).upper()]
    return int(value * scale)


def _top_level_usage(drive: str, task: ScanTask) -> List[CleanItem]:
    """C 盘一级目录占用。给的是"空间去哪了"的答案，全部 locked。"""
    items: List[CleanItem] = []
    root = Path(drive + "\\")
    try:
        entries = [e for e in root.iterdir() if e.is_dir()]
    except OSError:
        return items
    for entry in entries:
        if task.cancelled():
            break
        name = entry.name.lower()
        if name in ("$recycle.bin", "system volume information", "recovery"):
            continue
        size, count = paths.dir_size(entry, should_cancel=task.cancelled, cap_entries=200_000)
        if size < 512 * 1024 * 1024:  # 小于 512 MB 的一级目录不值得占一行
            continue
        items.append(CleanItem(
            item_id=f"disk:usage:{entry.name}",
            category="diskSlimming",
            label=entry.name,
            size_bytes=size,
            path=str(entry),
            importance=Importance.CRITICAL,
            reason="pcclean.disk.usageInfo.reason",
            locked=True,
            default_selected=False,
            detail={"action": "info_only", "file_count": count,
                    "label_key": "pcclean.disk.usageInfo.label"},
        ))
    items.sort(key=lambda i: i.size_bytes, reverse=True)
    return items[:12]


# 大文件扫描与目录占用分析

_BIG_FILE_KINDS = {
    "video": (".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".ts", ".m2ts"),
    "archive": (".zip", ".rar", ".7z", ".tar", ".gz", ".xz", ".bz2", ".cab"),
    # `.iso .img .vhd .vhdx` 从 archive 挪到这里：20 GB 的虚拟机/WSL 磁盘被归成「压缩包」，会让按
    # 类型看的结论出错。
    "disk_image": (".iso", ".img", ".vhd", ".vhdx", ".vmdk", ".vdi", ".qcow2", ".ova", ".dmg"),
    "installer": (".exe", ".msi", ".appx", ".msix"),
    "media": (".mp3", ".flac", ".wav", ".psd", ".ai", ".raw", ".cr2", ".nef"),
    "database": (".db", ".sqlite", ".mdf", ".bak", ".dmp"),
}


def _idle_days(path: Path) -> float:
    """这个文件有多久没被碰过（天）。取不到返回 -1，**不返回 0**——
    0 会被读成"刚刚还在用"，而那正好是反的。"""
    try:
        st = path.stat()
    except OSError:
        return -1.0
    last = max(st.st_atime, st.st_mtime)
    return round(max(0.0, (time.time() - last) / 86400), 1)


def _classify_big_file(suffix: str) -> str:
    suffix = suffix.lower()
    for kind, suffixes in _BIG_FILE_KINDS.items():
        if suffix in suffixes:
            return kind
    return "other"


def scan_big_files(
    task: ScanTask,
    *,
    roots: Optional[List[str]] = None,
    min_size_mb: float = 100.0,
    limit: int = 500,
) -> ScanReport:
    """大文件扫描；`min_size_mb` 和 `limit` 由界面传入，因为不同人对"大文件"的阈值差很远。"""
    scan_roots = [Path(r) for r in (roots or [])]
    if not scan_roots:
        profile = paths.user_profile()
        scan_roots = [profile] if profile else [Path(paths.system_drive() + "\\")]

    threshold = int(min_size_mb * 1024 * 1024)
    found: List[Tuple[int, Path]] = []
    errors: List[str] = []
    seen = 0

    for root in scan_roots:
        if task.cancelled():
            break
        if not paths.exists(root):
            errors.append(f"missing: {root}")
            continue
        for file_path, size in paths.iter_files(root, should_cancel=task.cancelled):
            seen += 1
            if size >= threshold:
                found.append((size, file_path))
            if seen % 2000 == 0:
                task.progress(len(found), max(len(found), limit), str(file_path.parent))
                if task.cancelled():
                    break

    found.sort(key=lambda x: x[0], reverse=True)
    truncated = len(found) > limit
    items: List[CleanItem] = []
    for size, file_path in found[:limit]:
        suffix = file_path.suffix
        items.append(CleanItem(
            item_id=f"bigfile:{file_path}",
            category="bigFiles",
            label=file_path.name,
            size_bytes=size,
            path=str(file_path),
            importance=Importance.COMMON,
            reason="pcclean.bigFiles.userFile",
            default_selected=False,
            # `idle_days` 回答"还要不要留"。取 atime 和 mtime 中更近的：很多卷关了 atime 更新
            # （NtfsDisableLastAccess 默认开），只看 atime 会把常用文件报成"三年没动过"。
            detail={"kind": _classify_big_file(suffix), "suffix": suffix.lower(),
                    "parent": str(file_path.parent),
                    "idle_days": _idle_days(file_path)},
        ))
    task.progress(len(items), max(1, len(items)))
    return task.report(items, truncated=truncated, errors=errors)


def analyze_directory(
    task: ScanTask,
    *,
    root: str,
    depth: int = 2,
    top_n: int = 40,
) -> ScanReport:
    """目录占用分析，「大文件分析」的数据源。

    只产出树的前两层：完整树在 C 盘有几十万节点，会拖垮 IPC 和渲染；更深的点进去再分析。
    """
    base = Path(root)
    if not paths.exists(base):
        return task.report([], errors=[f"missing: {root}"])

    sizes: Dict[Path, int] = defaultdict(int)
    counts: Dict[Path, int] = defaultdict(int)
    base_depth = len(base.parts)
    total_bytes = 0
    seen = 0

    for file_path, size in paths.iter_files(base, should_cancel=task.cancelled):
        total_bytes += size
        seen += 1
        parts = file_path.parts
        for d in range(1, depth + 1):
            if len(parts) > base_depth + d - 1:
                node = Path(*parts[: base_depth + d])
                sizes[node] += size
                counts[node] += 1
        if seen % 5000 == 0:
            task.progress(seen, seen + 5000)
            if task.cancelled():
                break

    items: List[CleanItem] = []
    for node, size in sorted(sizes.items(), key=lambda kv: kv[1], reverse=True)[:top_n]:
        level = len(node.parts) - base_depth
        items.append(CleanItem(
            item_id=f"dirusage:{node}",
            category="dirAnalysis",
            label=node.name or str(node),
            size_bytes=size,
            path=str(node),
            importance=Importance.COMMON,
            reason="pcclean.dirAnalysis.node",
            default_selected=False,
            detail={
                "level": level,
                "parent": str(node.parent),
                "file_count": counts[node],
                "share": round(size / total_bytes, 4) if total_bytes else 0.0,
                "is_dir": node.is_dir(),
            },
        ))
    task.progress(seen, seen)
    report = task.report(items)
    report.errors.append(f"total_bytes={total_bytes}")
    return report


# 重复文件

_SAMPLE_BYTES = 64 * 1024


def _sample_digest(path: Path, size: int) -> Optional[str]:
    """头 64KB + 尾 64KB 的摘要；很多格式（视频容器、压缩包、Office）头部高度相似，只采头会让大量
    不同文件落进同组。"""
    try:
        with open(path, "rb") as handle:
            head = handle.read(_SAMPLE_BYTES)
            if size > _SAMPLE_BYTES * 2:
                handle.seek(-_SAMPLE_BYTES, os.SEEK_END)
                tail = handle.read(_SAMPLE_BYTES)
            else:
                tail = b""
    except OSError:
        return None
    digest = hashlib.blake2b(digest_size=16)
    digest.update(head)
    digest.update(tail)
    digest.update(str(size).encode("ascii"))
    return digest.hexdigest()


def _full_digest(path: Path, should_cancel=None) -> Optional[str]:
    digest = hashlib.blake2b(digest_size=32)
    try:
        with open(path, "rb") as handle:
            while True:
                if should_cancel and should_cancel():
                    return None
                chunk = handle.read(4 * 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def scan_duplicates(
    task: ScanTask,
    *,
    roots: Optional[List[str]] = None,
    min_size_kb: float = 1024.0,
    limit_groups: int = 300,
    keep_strategy: str = "smart",
) -> ScanReport:
    """重复文件，三级筛选。

    每组第一个文件默认不勾选、其余勾选（用户要的是"每组留一份"）；保留哪份由 `keep_strategy`
    决定（见 `rank_duplicates`），默认 `smart` 把带"副本"后缀、在下载/临时/桌面里的排后面。
    """
    if keep_strategy not in KEEP_STRATEGIES:
        keep_strategy = "smart"
    scan_roots = [Path(r) for r in (roots or [])]
    if not scan_roots:
        profile = paths.user_profile()
        scan_roots = [profile] if profile else []
    if not scan_roots:
        return task.report([], errors=["duplicates.no_root"])

    threshold = int(min_size_kb * 1024)

    # 分阶段软截止，保证第三级一定跑到：三级只有跑完第三级才产出结果，原先共用一个 `cancelled()`，
    # 预算在前两级用完就返回零组（冷缓存下 180 秒返回 0 组，等于"没有重复文件"的错误答案）。
    # 现给前两级各留软截止，最后 25% 预算留给第三级，扫不完就带着已扫部分往下走；
    # `truncated` 如实标出，界面提示"只扫了一部分"。
    budget = task.budget_s
    started = time.perf_counter()

    def _past(fraction: float) -> bool:
        if budget is None:
            return False
        return (time.perf_counter() - started) >= budget * fraction

    partial = False

    # 第一级：按大小分组（零 I/O）
    by_size: Dict[int, List[Path]] = defaultdict(list)
    seen = 0
    for root in scan_roots:
        if task.cancelled() or _past(0.45):
            partial = True
            break
        for file_path, size in paths.iter_files(root, should_cancel=task.cancelled):
            if size < threshold:
                continue
            by_size[size].append(file_path)
            seen += 1
            if seen % 4000 == 0:
                task.progress(seen // 3, seen, str(file_path.parent))
                # 目录遍历本身可能几分钟都出不来一次外层循环，所以截止判断
                # 必须放在内层。4000 个文件一次，开销可以忽略。
                if _past(0.45):
                    partial = True
                    break
        if partial:
            break

    candidates = {s: files for s, files in by_size.items() if len(files) > 1}
    del by_size

    # 第二级：头尾采样
    by_sample: Dict[Tuple[int, str], List[Path]] = defaultdict(list)
    processed = 0
    total_candidates = sum(len(v) for v in candidates.values()) or 1
    for size, files in candidates.items():
        if task.cancelled() or _past(0.75):
            partial = True
            break
        for file_path in files:
            digest = _sample_digest(file_path, size)
            processed += 1
            if digest:
                by_sample[(size, digest)].append(file_path)
            if processed % 500 == 0:
                task.progress(total_candidates // 3 + processed // 2, total_candidates)
                if _past(0.75):
                    partial = True
                    break
        if partial:
            break
    del candidates

    # 第三级：全量哈希，只对采样也撞上的
    groups: Dict[str, List[Path]] = defaultdict(list)
    for (size, _), files in by_sample.items():
        if task.cancelled():
            break
        if len(files) < 2:
            continue
        for file_path in files:
            digest = _full_digest(file_path, task.should_cancel)
            if digest:
                groups[f"{size}:{digest}"].append(file_path)

    items: List[CleanItem] = []
    group_index = 0
    truncated = False
    for group_key, files in sorted(groups.items(),
                                   key=lambda kv: -(len(kv[1]) * _size_of(kv[1][0]))):
        if len(files) < 2:
            continue
        if group_index >= limit_groups:
            truncated = True
            break
        group_index += 1
        ordered = rank_duplicates(files, keep_strategy)
        size = _size_of(ordered[0])
        for position, file_path in enumerate(ordered):
            items.append(CleanItem(
                item_id=f"dup:{file_path}",
                category="duplicates",
                label=file_path.name,
                size_bytes=size,
                path=str(file_path),
                importance=Importance.COMMON,
                reason="pcclean.duplicates.keepFirst" if position == 0
                else "pcclean.duplicates.copy",
                default_selected=position > 0,
                detail={
                    "group": group_key,
                    "group_index": group_index,
                    "position": position,
                    "copies": len(ordered),
                    "is_keeper": position == 0,
                    "wasted_bytes": size * (len(ordered) - 1) if position == 0 else 0,
                    "keep_strategy": keep_strategy,
                },
            ))
    task.progress(total_candidates, total_candidates)
    # `partial` 单独报，不折进 `truncated`：一个是"太多只显示前 N 个"，一个是"只看了一部分范围"，
    # 合并后"没找到"和"只看了一半没找到"无法区分。
    return task.report(items, truncated=truncated, partial=partial)


def _size_of(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _mtime_of(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        # 读不到时间的文件排到最后当副本，不当保留项 —— 保留项必须是我们
        # 确实了解的那一个。
        return float("inf")


KEEP_STRATEGIES = ("smart", "shortestPath", "newest", "oldest")

_COPY_MARKERS = (
    " - 副本", " - copy", " (1)", " (2)", " (3)", "(1)", "(2)", "(3)",
    " - kopie", " - copia", " - копия", "_copy", "-copy", " copy",
)
"""文件名里出现这些就八成是副本。含六语常见的"副本"写法——用户的机器上
中英混装是常态，只认英文的 "copy" 会把中文系统上最典型的副本漏掉。"""

_COPYISH_DIRS = ("download", "下载", "temp", "tmp", "缓存", "cache",
                 "recycle", "回收", "desktop", "桌面")
"""这些目录里的那一份更可能是副本而不是原件。桌面也算——从别处拷到桌面
看一眼是最常见的产生副本的动作。"""


def _copy_score(path: Path) -> Tuple[int, int, int, int]:
    """给文件打"像副本"的分，越小越像原件。

    用打分而非 if：判据会冲突（路径最短的可能在下载夹），需要全序。四个分量按重要性排列，
    最后是路径字符串本身，保证同组排序每次扫描一致，否则重扫后保留项变化会让用户勾选错位。
    """
    text = str(path).lower()
    name = path.name.lower()
    marker = 1 if any(m.lower() in name for m in _COPY_MARKERS) else 0
    in_copyish = 1 if any(d in text for d in _COPYISH_DIRS) else 0
    depth = len(path.parts)
    return (marker, in_copyish, depth, len(str(path)))


def rank_duplicates(files: Sequence[Path], strategy: str = "smart") -> List[Path]:
    """把一组内容相同的文件排序，第一个是保留项。

    - `smart`（默认）：按"像副本"打分，带 `(1)`/`- 副本` 后缀或在下载/临时/桌面的往后排，同分留目
    录浅、路径短的。
    - `shortestPath`：只看路径长短，老行为，最好预测。
    - `newest` / `oldest`：留最新改过的 / 最早的。
    每组恰好一个保留项，且顺序需跨扫描稳定，所以每个 key 最后都用路径字符串兜底。
    """
    ordered = list(files)
    if strategy == "shortestPath":
        return sorted(ordered, key=lambda p: (len(str(p)), str(p)))
    if strategy == "newest":
        return sorted(ordered, key=lambda p: (-_mtime_of(p), str(p)))
    if strategy == "oldest":
        return sorted(ordered, key=lambda p: (_mtime_of(p), str(p)))
    return sorted(ordered, key=lambda p: (_copy_score(p), str(p)))


# 碎片整理 / TRIM


def list_volumes(task: ScanTask) -> ScanReport:
    """列出各卷的介质类型和可用空间。

    介质类型走 PowerShell `Get-PhysicalDisk` 的 `MediaType`；判不出来当 SSD 处理（只给 TRIM）：
    SSD 误当 HDD 去整理会损伤硬件，反之只是少一次优化，错也往代价小的方向错。
    """
    items: List[CleanItem] = []
    errors: List[str] = []
    media_by_drive = _media_types()

    for letter in _drive_letters():
        if task.cancelled():
            break
        try:
            total, free = _disk_space(letter)
        except OSError:
            continue
        if total <= 0:
            continue
        media = media_by_drive.get(letter.rstrip(":\\").upper(), "unknown")
        is_ssd = media != "HDD"
        items.append(CleanItem(
            item_id=f"volume:{letter}",
            category="volumes",
            label=letter,
            size_bytes=total - free,
            path=letter,
            importance=Importance.CRITICAL,
            reason="pcclean.defrag.ssdTrim" if is_ssd else "pcclean.defrag.hddDefrag",
            locked=True,
            default_selected=False,
            detail={
                "total_bytes": total,
                "free_bytes": free,
                "used_percent": round((total - free) / total * 100, 1),
                "media_type": media,
                "recommended_action": "retrim" if is_ssd else "defrag",
                "is_ssd": is_ssd,
                "needs_elevation": True,
            },
        ))
    task.progress(len(items), max(1, len(items)))
    return task.report(items, errors=errors)


def _drive_letters() -> List[str]:
    if not paths.IS_WINDOWS:
        return []
    try:
        mask = ctypes.windll.kernel32.GetLogicalDrives()
    except (OSError, AttributeError):
        return []
    out = []
    for i in range(26):
        if mask & (1 << i):
            letter = f"{chr(ord('A') + i)}:\\"
            try:
                # 3 = DRIVE_FIXED。只管本地固定盘，U 盘和网络盘不该出现在这里。
                if ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(letter)) == 3:
                    out.append(letter)
            except (OSError, AttributeError):
                continue
    return out


def _disk_space(letter: str) -> Tuple[int, int]:
    free = ctypes.c_ulonglong(0)
    total = ctypes.c_ulonglong(0)
    ok = ctypes.windll.kernel32.GetDiskFreeSpaceExW(
        ctypes.c_wchar_p(letter), None, ctypes.byref(total), ctypes.byref(free)
    )
    if not ok:
        raise OSError(f"GetDiskFreeSpaceExW failed for {letter}")
    return total.value, free.value


_MEDIA_CACHE: Dict[str, str] = {}
_MEDIA_CACHE_AT = 0.0
_MEDIA_TTL_S = 300.0


def cached_media_types() -> Dict[str, str]:
    """已探到的介质类型，没有就返回空字典，绝不去探。

    供"有就用、没有也能走"的调用方（并发度选择）使用；`_media_types()` 首次要 4~9 秒，
    用户等待路径上的调用必须走这个。
    """
    if _MEDIA_CACHE and time.monotonic() - _MEDIA_CACHE_AT < _MEDIA_TTL_S:
        return dict(_MEDIA_CACHE)
    return {}


def _media_types() -> Dict[str, str]:
    """盘符 → 介质类型（'SSD' / 'HDD' / 'unknown'），带缓存。

    这条 PowerShell 实测 8.7 秒，而介质类型一次会话内不变；体检、碎片整理面板、擦除空间估算三处都
    会调用。
    """
    global _MEDIA_CACHE_AT
    now = time.monotonic()
    if _MEDIA_CACHE and now - _MEDIA_CACHE_AT < _MEDIA_TTL_S:
        return dict(_MEDIA_CACHE)
    if not paths.IS_WINDOWS:
        return {}
    script = (
        "Get-Partition | ForEach-Object { "
        "$d = Get-PhysicalDisk -ErrorAction SilentlyContinue | "
        "Where-Object DeviceId -eq (Get-Disk -Number $_.DiskNumber -ErrorAction "
        "SilentlyContinue).Number; "
        "if ($_.DriveLetter) { \"$($_.DriveLetter)=$($d.MediaType)\" } }"
    )
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        timeout=30.0,
    )
    result: Dict[str, str] = {}
    if code != 0:
        return result
    for line in out.splitlines():
        line = line.strip()
        if "=" not in line:
            continue
        letter, _, media = line.partition("=")
        letter = letter.strip().upper()
        media = media.strip()
        if not letter:
            continue
        if media.upper() in ("SSD", "HDD", "SCM"):
            result[letter] = media.upper()
        else:
            result[letter] = "unknown"
    if result:
        _MEDIA_CACHE.clear()
        _MEDIA_CACHE.update(result)
        _MEDIA_CACHE_AT = now
    return result
