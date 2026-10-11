"""开机自启动管理：注册表 Run 项、启动文件夹、计划任务、服务。

四个来源缺一不可（只看 Run 会漏掉登录触发的计划任务，普通机器上有 30~60 条）。
只禁用不删除，每条可一键还原：注册表项搬到备份键；启动文件夹改扩展名 `.disabled-by-tessera`；
计划任务 `schtasks /Change /DISABLE`；服务改为手动而非禁用（禁用会让依赖它的服务连带失败）。
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
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

# 备份键：禁用的自启项搬到这里，还原时搬回。用 msconfig 的位置，使系统自带工具也认得出来。
BACKUP_KEY = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved"
TESSERA_BACKUP_KEY = r"Software\Tessera\PcClean\DisabledStartup"


@dataclass(frozen=True)
class RunLocation:
    hive: int
    hive_name: str
    subkey: str
    scope: str
    needs_elevation: bool


def _run_locations() -> Sequence[RunLocation]:
    if not WINREG_AVAILABLE:
        return ()
    return (
        RunLocation(winreg.HKEY_CURRENT_USER, "HKCU",
                    r"Software\Microsoft\Windows\CurrentVersion\Run", "user", False),
        RunLocation(winreg.HKEY_CURRENT_USER, "HKCU",
                    r"Software\Microsoft\Windows\CurrentVersion\RunOnce", "user", False),
        RunLocation(winreg.HKEY_LOCAL_MACHINE, "HKLM",
                    r"Software\Microsoft\Windows\CurrentVersion\Run", "machine", True),
        RunLocation(winreg.HKEY_LOCAL_MACHINE, "HKLM",
                    r"Software\Microsoft\Windows\CurrentVersion\RunOnce", "machine", True),
        RunLocation(winreg.HKEY_LOCAL_MACHINE, "HKLM",
                    r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
                    "machine32", True),
    )


def _shortcut_names() -> Set[str]:
    """桌面 + 开始菜单上的快捷方式名，用于判断"是不是用户常用的软件"（有快捷方式≈用户自己装的、认
    得出来）。"""
    names: Set[str] = set()
    roots = []
    desktop = paths.known("Desktop")
    if desktop:
        roots.append(desktop)
    roaming = paths.known("RoamingAppData")
    if roaming:
        roots.append(roaming / "Microsoft/Windows/Start Menu/Programs")
    programdata = paths.known("ProgramData")
    if programdata:
        roots.append(programdata / "Microsoft/Windows/Start Menu/Programs")
    for root in roots:
        if not root or not paths.exists(root):
            continue
        try:
            for entry in root.rglob("*.lnk"):
                names.add(entry.stem.strip().lower())
        except OSError:
            continue
    return names


def scan_startup(task: ScanTask, *, whitelist: Optional[Set[str]] = None) -> ScanReport:
    """四个来源并行扫：`schtasks /Query /FO CSV /V` 要起进程枚举全部计划任务（实测 6~8 秒），
    另外三个合计不到 200 毫秒，并行后总时长只取决于最慢的那个。
    """
    from concurrent.futures import ThreadPoolExecutor

    items: List[CleanItem] = []
    errors: List[str] = []
    shortcuts = _shortcut_names()

    sources = (
        ("registryRun", lambda: _scan_registry_run(whitelist, shortcuts)),
        ("startupFolder", lambda: _scan_startup_folders(whitelist, shortcuts)),
        ("scheduledTasks", lambda: _scan_scheduled_tasks(whitelist, shortcuts)),
        ("services", lambda: _scan_services(whitelist)),
    )
    steps = len(sources)

    # 统计四路里成功回来的几路，作为"真的查过"的证据；内部线程池的 thread-local 打点传不回主线程，
    # 只能在收口处手工数，经 `probes=` 交给报告层。
    probed = 0
    denied = 0

    with ThreadPoolExecutor(max_workers=steps,
                            thread_name_prefix="pcclean-startup") as pool:
        futures = {pool.submit(fn): name for name, fn in sources}
        done = 0
        for future in futures:
            name = futures[future]
            try:
                items.extend(future.result())
                probed += 1
            except Exception as exc:
                errors.append(f"{name}: {type(exc).__name__}")
                denied += 1
            done += 1
            task.progress(done, steps)

    # **数量对账**：派了 4 个必须收回 4 个。收少了说明有一路静默失败，
    # 而那正是"启动项只有 3 个"这种假结论的来源。
    if done != steps:
        errors.append(f"startup.accountingMismatch:dispatched={steps},returned={done}")

    # 排序：先按重要性倒序（垃圾排最前，方便用户一眼看到该关的），
    # 同级按名字。**不按大小排** —— 自启项没有"大小"，按 0 排序等于随机。
    items.sort(key=lambda i: (-int(i.importance), i.label.lower()))
    return task.report(items, errors=errors, probes=probed, denied=denied)


def _scan_registry_run(whitelist, shortcuts: Set[str]) -> List[CleanItem]:
    items: List[CleanItem] = []
    if not WINREG_AVAILABLE:
        return items
    for loc in _run_locations():
        try:
            with winreg.OpenKey(loc.hive, loc.subkey, 0, winreg.KEY_READ) as key:
                _, n_val, _ = winreg.QueryInfoKey(key)
                for i in range(n_val):
                    try:
                        name, value, _ = winreg.EnumValue(key, i)
                    except OSError:
                        continue
                    if not name:
                        continue
                    command = str(value)
                    verdict = imp.classify_startup(
                        name=name, command=command, whitelist=whitelist
                    )
                    if name.strip().lower() in shortcuts and verdict.importance > Importance.COMMON:
                        verdict = imp.Verdict(Importance.COMMON,
                                              "pcclean.reason.recentlyUsed", name)
                    items.append(CleanItem(
                        item_id=f"startup:reg:{loc.hive_name}:{loc.subkey}:{name}",
                        category="startup",
                        label=name,
                        path=command,
                        importance=verdict.importance,
                        reason=verdict.reason_key,
                        locked=verdict.locked,
                        default_selected=verdict.importance == Importance.JUNK,
                        detail={
                            "source": "registry",
                            "hive": loc.hive_name,
                            "subkey": loc.subkey,
                            "value_name": name,
                            "command": command,
                            "scope": loc.scope,
                            "needs_elevation": loc.needs_elevation,
                            "enabled": True,
                            "evidence": verdict.evidence,
                            "recommended_action": imp.recommend_for_startup(verdict.importance),
                        },
                    ))
        except (FileNotFoundError, OSError, PermissionError):
            continue
    items.extend(_scan_disabled_backup())
    return items


def _scan_disabled_backup() -> List[CleanItem]:
    """已经被本应用禁用的项也要列出来 —— 否则用户找不到"我把什么关了"，
    也就没法还原。这类项显示成"已禁用"状态。"""
    items: List[CleanItem] = []
    if not WINREG_AVAILABLE:
        return items
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, TESSERA_BACKUP_KEY, 0,
                            winreg.KEY_READ) as key:
            _, n_val, _ = winreg.QueryInfoKey(key)
            for i in range(n_val):
                try:
                    name, value, _ = winreg.EnumValue(key, i)
                except OSError:
                    continue
                if not name:
                    continue
                # 备份值的格式：`<hive>|<subkey>|<原命令行>`
                parts = str(value).split("|", 2)
                if len(parts) != 3:
                    continue
                hive_name, subkey, command = parts
                items.append(CleanItem(
                    item_id=f"startup:disabled:{name}",
                    category="startup",
                    label=name,
                    path=command,
                    importance=Importance.OPTIONAL,
                    reason="pcclean.startup.disabledByApp",
                    default_selected=False,
                    detail={
                        "source": "registry",
                        "hive": hive_name,
                        "subkey": subkey,
                        "value_name": name,
                        "command": command,
                        "enabled": False,
                        "needs_elevation": hive_name == "HKLM",
                        # 它已经不启动了，没有任何动作值得建议。给 keep 而不是
                        # 留空：留空会让前端的"一键应用建议"不知道该不该算上它。
                        "recommended_action": imp.RECOMMEND_KEEP,
                    },
                ))
    except (FileNotFoundError, OSError, PermissionError):
        pass
    return items


_DISABLED_SUFFIX = ".disabled-by-tessera"


def _scan_startup_folders(whitelist, shortcuts: Set[str]) -> List[CleanItem]:
    items: List[CleanItem] = []
    for folder_key, scope, elevated in (("Startup", "user", False),
                                        ("CommonStartup", "machine", True)):
        root = paths.known(folder_key)
        if root is None or not paths.exists(root):
            continue
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir():
                continue
            name = entry.name
            disabled = name.endswith(_DISABLED_SUFFIX)
            display = name[: -len(_DISABLED_SUFFIX)] if disabled else name
            if display.lower() in ("desktop.ini",):
                continue
            verdict = imp.classify(name=Path(display).stem, path=str(entry),
                                   whitelist=whitelist,
                                   has_shortcut=Path(display).stem.lower() in shortcuts)
            items.append(CleanItem(
                item_id=f"startup:folder:{scope}:{display}",
                category="startup",
                label=Path(display).stem,
                path=str(entry),
                importance=verdict.importance,
                reason=verdict.reason_key if not disabled else "pcclean.startup.disabledByApp",
                locked=verdict.locked,
                default_selected=verdict.importance == Importance.JUNK and not disabled,
                detail={
                    "source": "folder",
                    "scope": scope,
                    "file": str(entry),
                    "original_name": display,
                    "enabled": not disabled,
                    "needs_elevation": elevated,
                    "evidence": verdict.evidence,
                    "recommended_action": (
                        imp.RECOMMEND_KEEP if disabled
                        else imp.recommend_for_startup(verdict.importance)
                    ),
                },
            ))
    return items


_TASKS_CACHE: Dict[str, object] = {"text": "", "at": 0.0}
_TASKS_TTL_S = 60.0


def _scheduled_tasks_csv() -> str:
    """`schtasks /Query /FO CSV /V` 的输出，带 60 秒缓存。

    整个套件里最慢的外部调用（实测 5~9 秒），且绕不过去：非提权进程对 `C:\\Windows\\System32\\Tasks`
    `scandir` 会 WinError 5，`Path.rglob` 则静默返回 0 条（像"没有计划任务"，最危险的失败）。
    缓存让"体检后再进启动项面板"不必再等一次。
    """
    now = time.monotonic()
    cached = _TASKS_CACHE.get("text")
    if cached and now - float(_TASKS_CACHE.get("at") or 0) < _TASKS_TTL_S:
        return str(cached)
    if os.name != "nt":
        return ""
    try:
        proc = subprocess.run(
            ["schtasks.exe", "/Query", "/FO", "CSV", "/V"],
            capture_output=True, timeout=90.0,
            creationflags=_CREATE_NO_WINDOW, shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0:
        return ""
    text = (proc.stdout or b"").decode("utf-8", errors="replace")
    if not text.strip():
        text = (proc.stdout or b"").decode("gbk", errors="replace")
    if text.strip():
        _TASKS_CACHE["text"] = text
        _TASKS_CACHE["at"] = now
    return text


def _scan_scheduled_tasks(whitelist, shortcuts: Set[str]) -> List[CleanItem]:
    """登录/开机触发的计划任务；必须带 /V 才有触发器和状态字段，否则分不出"开机跑"和"每周三跑"。"""
    text = _scheduled_tasks_csv()
    if not text.strip():
        return []

    import csv
    import io

    items: List[CleanItem] = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        rows = list(reader)
    except (csv.Error, ValueError):
        return items

    for row in rows:
        if not row:
            continue
        name = (row.get("TaskName") or row.get("任务名") or "").strip()
        if not name or name.startswith("TaskName"):
            continue
        trigger = (row.get("Scheduled Task State") or "")
        logon_trigger = (row.get("Schedule Type") or row.get("计划类型") or "").strip()
        run_as = (row.get("Run As User") or "").strip()
        command = (row.get("Task To Run") or row.get("要运行的任务") or "").strip()
        status = (row.get("Status") or row.get("状态") or "").strip()
        enabled = (row.get("Scheduled Task State") or
                   row.get("计划任务状态") or "").strip().lower() not in ("disabled", "已禁用")

        # 只要开机/登录触发的
        if logon_trigger.lower() not in ("at logon", "at system start", "onstart", "onlogon",
                                         "登录时", "系统启动时", "一次"):
            if "logon" not in logon_trigger.lower() and "启动" not in logon_trigger:
                continue

        # Microsoft 自己的任务全部锁死 —— 它们是 Windows 正常运转的一部分，
        # 而且数量巨大，混在列表里只会淹没真正该关的第三方项。
        if name.startswith("\\Microsoft\\"):
            continue

        verdict = imp.classify_startup(name=Path(name).name, command=command,
                                       whitelist=whitelist)
        items.append(CleanItem(
            item_id=f"startup:task:{name}",
            category="startup",
            label=Path(name).name,
            path=command,
            importance=verdict.importance,
            reason=verdict.reason_key,
            locked=verdict.locked,
            default_selected=verdict.importance == Importance.JUNK and enabled,
            detail={
                "source": "scheduledTask",
                "task_name": name,
                "command": command,
                "run_as": run_as,
                "enabled": enabled,
                "status": status,
                "needs_elevation": True,
                "evidence": verdict.evidence,
                "recommended_action": (
                    imp.RECOMMEND_KEEP if not enabled
                    else imp.recommend_for_startup(verdict.importance)
                ),
            },
        ))
    return items


# 这些服务动了会出事，永远锁死。列的是**服务名**不是显示名。
_CRITICAL_SERVICES = {
    "wuauserv", "windefend", "wscsvc", "mpssvc", "bfe", "dhcp", "dnscache",
    "lanmanworkstation", "lanmanserver", "rpcss", "dcomlaunch", "plugplay",
    "power", "profsvc", "themes", "audiosrv", "audioendpointbuilder",
    "eventlog", "schedule", "cryptsvc", "trustedinstaller", "msiserver",
    "winmgmt", "nsi", "netprofm", "nlasvc", "sysmain", "wsearch",
}


# 服务的 Start 值：0=引导 1=系统 2=自动 3=手动 4=禁用
_SERVICE_START_AUTO = 2
# Type 位：0x1/0x2 是驱动，0x10/0x20 才是真正的"服务"。
# 驱动不该出现在"开机自启"列表里——用户对着它做任何操作都是在玩火。
_SERVICE_TYPE_MASK = 0x30


def _scan_services(whitelist) -> List[CleanItem]:
    """自动启动的第三方服务。

    直读注册表 `HKLM\\SYSTEM\\CurrentControlSet\\Services`，不起 PowerShell（原 `Get-CimInstance
    Win32_Service`
    光启动进程就要数秒，拖到 8.7 秒）；且 `Start` 是原始数值，判"自动"比转译后的 `StartMode` 更准。
    `sysmain`（SuperFetch）放进锁死名单：机械盘上关掉会明显变慢，SSD 上也无净收益。
    """
    if not WINREG_AVAILABLE:
        return []

    rows: List[Dict[str, str]] = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SYSTEM\CurrentControlSet\Services", 0,
                            winreg.KEY_READ) as root:
            n_sub, _, _ = winreg.QueryInfoKey(root)
            for i in range(n_sub):
                try:
                    name = winreg.EnumKey(root, i)
                except OSError:
                    continue
                try:
                    with winreg.OpenKey(root, name, 0, winreg.KEY_READ) as key:
                        def _val(value_name, default=None):
                            try:
                                return winreg.QueryValueEx(key, value_name)[0]
                            except (FileNotFoundError, OSError):
                                return default

                        start = _val("Start")
                        if start != _SERVICE_START_AUTO:
                            continue
                        svc_type = _val("Type", 0) or 0
                        if not (int(svc_type) & _SERVICE_TYPE_MASK):
                            continue  # 驱动，跳过
                        rows.append({
                            "Name": name,
                            "DisplayName": str(_val("DisplayName", name) or name),
                            "PathName": str(_val("ImagePath", "") or ""),
                            "State": "",
                        })
                except (FileNotFoundError, OSError, PermissionError):
                    continue
    except (FileNotFoundError, OSError, PermissionError):
        return []

    items: List[CleanItem] = []
    for row in rows:
        name = str(row.get("Name") or "")
        display = str(row.get("DisplayName") or name)
        path_name = str(row.get("PathName") or "")
        state = str(row.get("State") or "")
        if not name:
            continue
        if name.lower() in _CRITICAL_SERVICES:
            continue  # 锁死项直接不列，避免淹没列表
        # DisplayName 可能是 `@%SystemRoot%\system32\x.dll,-100` 这种资源引用。
        # 显示原样等于给用户看一串乱码，退回服务名更有用。
        if display.startswith("@"):
            display = name
        low_path = os.path.expandvars(path_name).lower()
        if "\\windows\\system32\\" in low_path or "\\windows\\syswow64\\" in low_path:
            continue  # 系统自带服务不列
        verdict = imp.classify_startup(name=display, command=path_name, whitelist=whitelist)
        items.append(CleanItem(
            item_id=f"startup:service:{name}",
            category="startup",
            label=display,
            path=path_name,
            importance=verdict.importance,
            reason=verdict.reason_key,
            locked=verdict.locked,
            default_selected=False,
            # 服务默认永不勾选。改服务启动类型的影响面比关一个 Run 项大得多，
            # 必须是用户主动做的决定。
            detail={
                "source": "service",
                "service_name": name,
                "command": path_name,
                "state": state,
                "enabled": True,
                "needs_elevation": True,
                "target_start_mode": "Manual",
                "evidence": verdict.evidence,
                # 服务一律只建议"自己看一眼"、绝不建议禁用：改服务启动类型影响面远大于 Run 项，
                # 而签名/路径/最近使用这些判定信号对服务解释力弱得多。
                "recommended_action": imp.RECOMMEND_REVIEW,
            },
        ))
    return items
