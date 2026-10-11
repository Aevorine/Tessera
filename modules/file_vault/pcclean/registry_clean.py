"""注册表无效引用扫描；刻意比同类工具保守，因为清理收益近零、风险真实。

无效引用不会拖慢 Windows，但删错一条可能让软件几周后才暴露启动失败。
只扫五类判据明确的无效引用；执行前强制导出 .reg 备份，失败即拒绝执行；
全部 default_selected=False；界面如实说明收益很小。
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

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

MAX_ITEMS = 2000
"""硬上限。超过就截断并把 truncated 置位 —— 一次让用户审 2000 条已经不现实，
再多只会让他直接点全选，那正是我们要避免的。"""


def _path_exists(raw: str) -> bool:
    """判断注册表里存的路径是否还在。

    要处理：带引号带参数、`b.exe,-101` 资源索引、环境变量、`rundll32 x.dll,Entry`。
    判错方向必须是"当成还在"，误判存在为不存在会把正常项列成可删。
    """
    raw = (raw or "").strip()
    if not raw:
        return True  # 空值不算无效引用，只是没配

    candidate = raw
    if candidate.startswith('"'):
        end = candidate.find('"', 1)
        candidate = candidate[1:end] if end > 0 else candidate[1:]
    else:
        # 砍掉逗号后的资源索引
        comma = candidate.find(",")
        if comma > 0 and candidate[:comma].lower().endswith((".exe", ".dll", ".ico", ".cpl")):
            candidate = candidate[:comma]
        else:
            # 砍掉参数：只在第一个能确认是可执行文件的位置切
            parts = candidate.split(" ")
            for i in range(1, len(parts) + 1):
                head = " ".join(parts[:i])
                if head.lower().endswith((".exe", ".dll", ".ico", ".cpl", ".msi")):
                    candidate = head
                    break

    candidate = os.path.expandvars(candidate.strip().strip('"'))
    if not candidate:
        return True
    # 相对路径 / 只有个命令名（`notepad.exe`）—— 交给 PATH，判不了就当存在
    if not os.path.isabs(candidate):
        return True
    try:
        return os.path.exists(candidate)
    except (OSError, ValueError):
        return True


@dataclass(frozen=True)
class RegistryRule:
    key: str
    hive_name: str
    subkey: str
    value_name: str
    """要检查的值名。空串 = 默认值。"""

    needs_elevation: bool
    check: str = "path"
    """'path' = 值里存的是文件路径；'clsid' = 值是 CLSID，去查它的 InprocServer32"""


REGISTRY_RULES: Sequence[RegistryRule] = (
    RegistryRule("appPaths", "HKLM",
                 r"Software\Microsoft\Windows\CurrentVersion\App Paths", "", True),
    RegistryRule("appPathsUser", "HKCU",
                 r"Software\Microsoft\Windows\CurrentVersion\App Paths", "", False),
    RegistryRule("uninstallIcon", "HKLM",
                 r"Software\Microsoft\Windows\CurrentVersion\Uninstall", "DisplayIcon", True),
    RegistryRule("uninstallIconUser", "HKCU",
                 r"Software\Microsoft\Windows\CurrentVersion\Uninstall", "DisplayIcon", False),
    RegistryRule("startupRun", "HKCU",
                 r"Software\Microsoft\Windows\CurrentVersion\Run", "*", False),
    RegistryRule("sharedDlls", "HKLM",
                 r"Software\Microsoft\Windows\CurrentVersion\SharedDLLs", "*", True),
)


def _hive(name: str):
    return winreg.HKEY_LOCAL_MACHINE if name == "HKLM" else winreg.HKEY_CURRENT_USER


def scan_registry(task: ScanTask) -> ScanReport:
    items: List[CleanItem] = []
    errors: List[str] = []
    if not WINREG_AVAILABLE:
        return task.report(items, errors=["registry.windows_only"])

    total = len(REGISTRY_RULES)
    truncated = False

    for index, rule in enumerate(REGISTRY_RULES):
        if task.cancelled():
            break
        try:
            found = _scan_rule(rule, task)
            for item in found:
                if len(items) >= MAX_ITEMS:
                    truncated = True
                    break
                items.append(item)
        except Exception as exc:
            errors.append(f"{rule.key}: {type(exc).__name__}")
        task.progress(index + 1, total + 1)
        if truncated:
            break

    if not truncated and not task.cancelled():
        try:
            for item in _scan_orphan_clsid(task):
                if len(items) >= MAX_ITEMS:
                    truncated = True
                    break
                items.append(item)
        except Exception as exc:
            errors.append(f"orphanClsid: {type(exc).__name__}")
    task.progress(total + 1, total + 1)
    return task.report(items, truncated=truncated, errors=errors)


def _scan_rule(rule: RegistryRule, task: ScanTask) -> List[CleanItem]:
    items: List[CleanItem] = []
    try:
        with winreg.OpenKey(_hive(rule.hive_name), rule.subkey, 0, winreg.KEY_READ) as key:
            # 打开成功才算"检查过一个位置"。注册表不经过 `paths.iter_files`，
            # 自动打点够不着它，而它恰恰是最容易因为权限静默返回空的一类。
            paths.bump_scan_stat("dirs")
            if rule.value_name == "*":
                _, n_val, _ = winreg.QueryInfoKey(key)
                for i in range(n_val):
                    if task.cancelled():
                        break
                    try:
                        name, value, _ = winreg.EnumValue(key, i)
                    except OSError:
                        continue
                    if not name or _path_exists(str(value)):
                        continue
                    items.append(_make_item(rule, name, str(value),
                                            target_kind="value"))
                return items

            n_sub, _, _ = winreg.QueryInfoKey(key)
            for i in range(n_sub):
                if task.cancelled():
                    break
                try:
                    child = winreg.EnumKey(key, i)
                except OSError:
                    continue
                try:
                    with winreg.OpenKey(key, child, 0, winreg.KEY_READ) as sub:
                        try:
                            raw = winreg.QueryValueEx(sub, rule.value_name)[0]
                        except (FileNotFoundError, OSError):
                            continue
                except (FileNotFoundError, OSError, PermissionError):
                    continue
                if _path_exists(str(raw)):
                    continue
                items.append(_make_item(rule, child, str(raw), target_kind="key"))
    except (FileNotFoundError, OSError, PermissionError):
        # 键打不开（不存在或无权限）也记一次 denied，否则被组策略锁住的机器上"0 项"会被当成"很干净"。
        paths.bump_scan_stat("denied")
        return items
    return items


def _make_item(rule: RegistryRule, name: str, value: str, *, target_kind: str) -> CleanItem:
    return CleanItem(
        item_id=f"registry:{rule.key}:{name}",
        category="registry",
        label=name,
        path=f"{rule.hive_name}\\{rule.subkey}\\{name}",
        importance=Importance.OPTIONAL,
        reason=f"pcclean.registry.{rule.key}.reason",
        default_selected=False,
        detail={
            "hive": rule.hive_name,
            "subkey": rule.subkey,
            "name": name,
            "value": value,
            "target_kind": target_kind,
            "value_name": rule.value_name,
            "needs_elevation": rule.needs_elevation,
            "label_key": f"pcclean.registry.{rule.key}.label",
        },
    )


def _scan_orphan_clsid(task: ScanTask) -> List[CleanItem]:
    """指向已不存在 DLL 的 COM 注册项。

    唯一确实有收益的一类（Explorer 加载右键菜单会尝试实例化这些 CLSID），但也只有几十毫秒。
    """
    items: List[CleanItem] = []
    checked = 0
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "CLSID", 0, winreg.KEY_READ) as root:
            n_sub, _, _ = winreg.QueryInfoKey(root)
            for i in range(n_sub):
                if task.cancelled() or len(items) >= 400:
                    break
                try:
                    clsid = winreg.EnumKey(root, i)
                except OSError:
                    continue
                checked += 1
                paths.bump_scan_stat("dirs")
                if checked % 500 == 0:
                    task.progress(checked, n_sub)
                try:
                    with winreg.OpenKey(root, rf"{clsid}\InprocServer32", 0,
                                        winreg.KEY_READ) as srv:
                        dll = str(winreg.QueryValueEx(srv, "")[0] or "")
                except (FileNotFoundError, OSError, PermissionError):
                    continue
                if not dll or _path_exists(dll):
                    continue
                friendly = clsid
                try:
                    with winreg.OpenKey(root, clsid, 0, winreg.KEY_READ) as ck:
                        friendly = str(winreg.QueryValueEx(ck, "")[0] or "") or clsid
                except (FileNotFoundError, OSError, PermissionError):
                    pass
                items.append(CleanItem(
                    item_id=f"registry:orphanClsid:{clsid}",
                    category="registry",
                    label=friendly,
                    path=rf"HKCR\CLSID\{clsid}",
                    importance=Importance.OPTIONAL,
                    reason="pcclean.registry.orphanClsid.reason",
                    default_selected=False,
                    detail={
                        "hive": "HKCR",
                        "subkey": rf"CLSID\{clsid}",
                        "name": clsid,
                        "value": dll,
                        "target_kind": "key",
                        "value_name": "",
                        "needs_elevation": True,
                        "label_key": "pcclean.registry.orphanClsid.label",
                    },
                ))
    except (FileNotFoundError, OSError, PermissionError):
        return items
    return items


def export_backup(items: Iterable[CleanItem], backup_path: Path) -> Dict[str, object]:
    """导出将改动的注册表键到 .reg 文件，是执行清理的前置条件。

    调用方必须先拿到 `{"ok": True}` 才能继续，导出失败整批放弃。
    按键去重：`reg export` 只能导整个键，重复导出后一遍会覆盖前一遍。
    """
    backup_path = Path(backup_path)
    backup_path.parent.mkdir(parents=True, exist_ok=True)

    keys: List[str] = []
    seen = set()
    for item in items:
        detail = item.detail or {}
        hive = str(detail.get("hive") or "")
        subkey = str(detail.get("subkey") or "")
        name = str(detail.get("name") or "")
        if not hive or not subkey:
            continue
        full = (f"{hive}\\{subkey}\\{name}"
                if detail.get("target_kind") == "key" and name
                else f"{hive}\\{subkey}")
        if full not in seen:
            seen.add(full)
            keys.append(full)

    if not keys:
        return {"ok": False, "error": "pcclean.registry.nothingToBackUp", "keys": 0}

    written = 0
    failures: List[str] = []
    # reg export 一次只能导一个键，逐个导到临时文件再拼接；
    # 只保留第一份的 `Windows Registry Editor Version 5.00` 头，否则 regedit 导入会中途报错。
    parts: List[str] = []
    for index, full_key in enumerate(keys):
        tmp = backup_path.with_suffix(f".part{index}.reg")
        try:
            proc = subprocess.run(
                ["reg.exe", "export", full_key, str(tmp), "/y"],
                capture_output=True, timeout=30.0,
                creationflags=_CREATE_NO_WINDOW, shell=False,
            )
            if proc.returncode != 0 or not tmp.exists():
                failures.append(full_key)
                continue
            text = tmp.read_text(encoding="utf-16-le", errors="replace")
            if text.startswith("\ufeff"):
                text = text[1:]
            if index > 0:
                lines = text.splitlines()
                text = "\n".join(line for line in lines
                                 if not line.startswith("Windows Registry Editor"))
            parts.append(text)
            written += 1
        except (OSError, subprocess.SubprocessError, UnicodeError):
            failures.append(full_key)
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass

    if written == 0:
        return {"ok": False, "error": "pcclean.registry.backupFailed",
                "keys": len(keys), "failures": failures}

    try:
        backup_path.write_text("\n".join(parts), encoding="utf-16-le")
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.registry.backupWriteFailed:{type(exc).__name__}"}

    return {
        "ok": True,
        "path": str(backup_path),
        "keys": len(keys),
        "exported": written,
        "failures": failures,
        "size_bytes": backup_path.stat().st_size if backup_path.exists() else 0,
    }
