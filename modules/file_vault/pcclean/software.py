"""已装软件清单、重要性分级、卸载与残留清理。

全部列出（不截断、不隐藏系统组件，仅加锁），每条带五级标签和"删了会怎样"。
数据来源三处缺一会漏：HKLM Uninstall（64 位）、HKLM WOW6432Node Uninstall（32 位）、
HKCU Uninstall（仅当前用户，如 VS Code、Electron 应用）。
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

from modules.file_vault.pcclean import importance as imp
from modules.file_vault.pcclean import paths
from modules.file_vault.pcclean.model import (
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)

WINREG_AVAILABLE = False
try:  # pragma: no cover
    import winreg  # type: ignore
    WINREG_AVAILABLE = os.name == "nt"
except ImportError:  # pragma: no cover
    winreg = None  # type: ignore

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_UNINSTALL_ROOTS: Sequence[Tuple[str, str, str, bool]] = (
    ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\Uninstall", "machine", True),
    ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
     "machine32", True),
    ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Uninstall", "user", False),
)


def _hive(name: str):
    return winreg.HKEY_LOCAL_MACHINE if name == "HKLM" else winreg.HKEY_CURRENT_USER


def _read_value(key, name: str, default=""):
    try:
        value = winreg.QueryValueEx(key, name)[0]
        return value if value is not None else default
    except (FileNotFoundError, OSError, TypeError):
        return default


def _parse_install_date(raw: str) -> str:
    """注册表里的 InstallDate 是 `YYYYMMDD`。转成 ISO 给前端，
    转不了就原样返回 —— 有些安装器往这里写别的格式，硬解析会抛异常。"""
    raw = str(raw or "").strip()
    if len(raw) == 8 and raw.isdigit():
        try:
            return datetime.strptime(raw, "%Y%m%d").date().isoformat()
        except ValueError:
            return raw
    return raw


def scan_software(task: ScanTask, *, whitelist: Optional[Set[str]] = None) -> ScanReport:
    """全部已装软件。**不做任何过滤**，系统组件也列出来（打上 CRITICAL 锁）。"""
    items: List[CleanItem] = []
    errors: List[str] = []
    if not WINREG_AVAILABLE:
        return task.report(items, errors=["software.windows_only"])

    shortcuts = _shortcut_stems()
    seen_keys: Set[str] = set()
    total_roots = len(_UNINSTALL_ROOTS)

    for root_index, (hive_name, subkey, scope, elevated) in enumerate(_UNINSTALL_ROOTS):
        if task.cancelled():
            break
        try:
            with winreg.OpenKey(_hive(hive_name), subkey, 0, winreg.KEY_READ) as key:
                paths.bump_scan_stat("dirs")
                n_sub, _, _ = winreg.QueryInfoKey(key)
                for i in range(n_sub):
                    if task.cancelled():
                        break
                    try:
                        child = winreg.EnumKey(key, i)
                    except OSError:
                        continue
                    try:
                        with winreg.OpenKey(key, child, 0, winreg.KEY_READ) as entry:
                            paths.bump_scan_stat("files")
                            item = _software_item(
                                entry, child, hive_name, subkey, scope, elevated,
                                whitelist, shortcuts, seen_keys, task,
                            )
                            if item:
                                items.append(item)
                    except (FileNotFoundError, OSError, PermissionError):
                        paths.bump_scan_stat("denied")
                        continue
        except (FileNotFoundError, OSError, PermissionError) as exc:
            paths.bump_scan_stat("denied")
            errors.append(f"{hive_name}\\{subkey}: {type(exc).__name__}")
        task.progress(root_index + 1, total_roots)

    # 按"最该关注的排前面"：垃圾 → 可选 → 常用 → 驱动 → 系统关键。
    # 同级按占用空间倒序 —— 用户在同一级里最先想处理的是占地方最大的。
    items.sort(key=lambda i: (-int(i.importance), -i.size_bytes, i.label.lower()))
    return task.report(items, errors=errors)


def _software_item(entry, key_name, hive_name, subkey, scope, elevated,
                   whitelist, shortcuts, seen_keys, task) -> Optional[CleanItem]:
    display_name = str(_read_value(entry, "DisplayName") or "").strip()
    if not display_name:
        return None

    # SystemComponent=1 是安装器写的隐藏条目；仍列出但归 CRITICAL 并锁死，不能悄悄过滤后声称"这就
    # 是全部"。
    system_component = int(_read_value(entry, "SystemComponent", 0) or 0)
    release_type = str(_read_value(entry, "ReleaseType") or "")
    parent_key = str(_read_value(entry, "ParentKeyName") or "")

    publisher = str(_read_value(entry, "Publisher") or "").strip()
    install_location = str(_read_value(entry, "InstallLocation") or "").strip()
    uninstall_string = str(_read_value(entry, "UninstallString") or "").strip()
    quiet_uninstall = str(_read_value(entry, "QuietUninstallString") or "").strip()
    version = str(_read_value(entry, "DisplayVersion") or "").strip()
    install_date = _parse_install_date(_read_value(entry, "InstallDate"))
    estimated_kb = int(_read_value(entry, "EstimatedSize", 0) or 0)

    dedupe = f"{display_name}|{version}|{publisher}"
    if dedupe in seen_keys:
        return None
    seen_keys.add(dedupe)

    # EstimatedSize 经常是 0 或严重不准。有安装目录就实际数一遍 ——
    # 这一屏用户最关心的就是"哪个软件占地方最大"，报一个假数字等于没做。
    size_bytes = estimated_kb * 1024
    measured = False
    if install_location:
        location = Path(os.path.expandvars(install_location))
        if paths.exists(location) and location.is_dir():
            measured_size, _ = paths.dir_size(
                location, should_cancel=task.cancelled, cap_entries=60_000
            )
            if measured_size > 0:
                size_bytes = measured_size
                measured = True

    # 「多久没用过」补足"体积 × 使用频率"的另一半：卸载理由是"占 4 GB 且一年没开过"。
    idle_days = _idle_days(install_location, task)
    has_shortcut = display_name.strip().lower() in shortcuts
    verdict = imp.classify(
        name=display_name,
        publisher=publisher,
        path=install_location,
        whitelist=whitelist,
        has_shortcut=has_shortcut,
    )
    if system_component or release_type in ("Update", "Security Update", "Hotfix") or parent_key:
        verdict = imp.Verdict(Importance.CRITICAL, "pcclean.reason.systemCritical",
                              release_type or "SystemComponent")

    return CleanItem(
        item_id=f"software:{hive_name}:{scope}:{key_name}",
        category="software",
        label=display_name,
        size_bytes=size_bytes,
        path=install_location,
        importance=verdict.importance,
        reason=verdict.reason_key,
        locked=verdict.locked or not (uninstall_string or quiet_uninstall),
        default_selected=False,
        detail={
            "publisher": publisher,
            "version": version,
            "install_date": install_date,
            "install_location": install_location,
            "uninstall_string": uninstall_string,
            "quiet_uninstall_string": quiet_uninstall,
            "size_measured": measured,
            "size_source": "measured" if measured else "registry",
            "scope": scope,
            "hive": hive_name,
            "registry_key": f"{hive_name}\\{subkey}\\{key_name}",
            "needs_elevation": elevated,
            "system_component": bool(system_component),
            "has_shortcut": has_shortcut,
            "evidence": verdict.evidence,
            "silent_capable": bool(quiet_uninstall),
            # `None` 表示量不出来，不是 0；界面必须区分"很久没用"和"不知道"，否则会让人卸掉天天在用的软件。
            "idle_days": idle_days,
            "idle_known": idle_days is not None,
        },
    )


def _idle_days(install_location: str, task) -> Optional[int]:
    """安装目录里最近一次改动距今多少天。

    在不装驱动、不读事件日志下的最佳近似（程序运行时会碰自己目录里的配置/日志/缓存）。
    只看前两层、最多 400 个文件：对几百个软件各跑一次，深挖 `node_modules` 会把整轮扫描拖到几分钟，
    而精度对"半年还是一年没动过"毫无影响。
    """
    if not install_location:
        return None
    try:
        root = Path(os.path.expandvars(install_location))
    except (OSError, ValueError):
        return None
    if not paths.exists(root) or not root.is_dir():
        return None

    newest = 0.0
    seen = 0
    try:
        stack = [(root, 0)]
        while stack and seen < 400:
            current, depth = stack.pop()
            if task.cancelled():
                break
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        if seen >= 400:
                            break
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if depth < 1:
                                    stack.append((Path(entry.path), depth + 1))
                                continue
                            seen += 1
                            mtime = entry.stat(follow_symlinks=False).st_mtime
                            if mtime > newest:
                                newest = mtime
                        except OSError:
                            continue
            except OSError:
                continue
    except OSError:
        return None
    if newest <= 0:
        return None
    return max(0, int((time.time() - newest) / 86400))


def _shortcut_stems() -> Set[str]:
    names: Set[str] = set()
    roots = []
    desktop = paths.known("Desktop")
    if desktop:
        roots.append(desktop)
    for key in ("RoamingAppData", "ProgramData"):
        root = paths.known(key)
        if root:
            roots.append(root / "Microsoft/Windows/Start Menu/Programs")
    for root in roots:
        if not root or not paths.exists(root):
            continue
        try:
            for entry in root.rglob("*.lnk"):
                names.add(entry.stem.strip().lower())
        except OSError:
            continue
    return names


# 卸载残留


def scan_leftovers(task: ScanTask, *, installed_names: Optional[List[str]] = None) -> ScanReport:
    """卸载残留：已卸载但安装/配置目录仍留在盘上的。

    扫 `Program Files` / `AppData` 一级目录，与已装软件名集合比对。天然会误报（`JetBrains`
    目录对应软件名 `IntelliJ IDEA 2024.3`），所以全部 default_selected=False，importance 最高
    只到 OPTIONAL、绝不给 JUNK，最近 90 天有改动的目录不报。
    """
    items: List[CleanItem] = []
    known_names = {n.strip().lower() for n in (installed_names or []) if n.strip()}

    roots: List[Tuple[Path, str]] = []
    for key, scope in (("ProgramFiles", "programFiles"),
                       ("ProgramFilesX86", "programFilesX86"),
                       ("LocalAppData", "localAppData"),
                       ("RoamingAppData", "roamingAppData")):
        root = paths.known(key)
        if root and paths.exists(root):
            roots.append((root, scope))

    recent_cutoff = time.time() - 90 * 86400

    for root_index, (root, scope) in enumerate(roots):
        if task.cancelled():
            break
        try:
            entries = [e for e in root.iterdir() if e.is_dir()]
        except OSError:
            continue
        for entry in entries:
            if task.cancelled():
                break
            name = entry.name
            low = name.strip().lower()
            if low in ("microsoft", "windowsapps", "common files", "windows nt",
                       "packages", "temp", "programs", "microsoft office"):
                continue
            # 名字能对上任何一个已装软件就跳过（子串两边都试 ——
            # 目录叫 `Google`，软件叫 `Google Chrome`）
            if any(low in known or known in low for known in known_names if len(known) > 3):
                continue

            size, count, newest = _dir_stats(entry, task)
            if count == 0:
                continue
            if newest > recent_cutoff:
                continue  # 90 天内动过，还在用
            if size < 1024 * 1024:
                continue  # 小于 1 MB 的不值得让用户操心

            items.append(CleanItem(
                item_id=f"leftover:{entry}",
                category="leftovers",
                label=name,
                size_bytes=size,
                path=str(entry),
                importance=Importance.OPTIONAL,
                reason="pcclean.leftovers.orphanDirectory",
                default_selected=False,
                detail={
                    "scope": scope,
                    "file_count": count,
                    "last_modified": datetime.fromtimestamp(newest).date().isoformat(),
                    "needs_elevation": scope.startswith("programFiles"),
                },
            ))
        task.progress(root_index + 1, max(1, len(roots)))

    items.sort(key=lambda i: i.size_bytes, reverse=True)
    return task.report(items)


def _dir_stats(root: Path, task: ScanTask) -> Tuple[int, int, float]:
    total = 0
    count = 0
    newest = 0.0
    for file_path, size in paths.iter_files(root, max_depth=6,
                                            should_cancel=task.cancelled):
        total += size
        count += 1
        try:
            mtime = file_path.stat().st_mtime
            if mtime > newest:
                newest = mtime
        except OSError:
            continue
        if count > 20_000:
            break
    return total, count, newest


def uninstall(item_detail: Dict[str, object], *, silent: bool = False) -> Dict[str, object]:
    """调用软件自己的卸载程序，绝不自己删安装目录（会留下注册表项、服务、驱动、右键菜单，且卸载程
    序可能要迁移数据或释放授权）。

    `silent=True` 只在软件提供 QuietUninstallString 时可用；自己给 UninstallString 拼 `/S` 是错的，
    各安装器静默参数不同。
    """
    command = ""
    if silent:
        command = str(item_detail.get("quiet_uninstall_string") or "")
    if not command:
        command = str(item_detail.get("uninstall_string") or "")
    if not command:
        return {"ok": False, "error": "pcclean.software.noUninstaller"}

    try:
        # Windows CreateProcess accepts a quoted command line directly. Do not
        # interpret registry values through cmd.exe shell operators.
        proc = subprocess.Popen(
            command,
            shell=False,
            creationflags=_CREATE_NO_WINDOW if silent else 0,
        )
        return {"ok": True, "pid": proc.pid, "silent": silent, "command": command}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"pcclean.software.launchFailed:{type(exc).__name__}"}
