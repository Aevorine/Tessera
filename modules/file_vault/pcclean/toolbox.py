"""工具箱：一批各自独立的小工具。

收录标准：用户真会用；Windows 自带界面要点五步以上或没有界面；优先无需常驻和额外权限。
不收"优化注册表提速"之类没有可测收益的东西。
每个工具是一个 `Tool` 条目加执行函数，统一签名 `(params) -> dict`，前端只渲染列表。
"""

from __future__ import annotations

import ctypes
import os
import re
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean import paths

WINREG_AVAILABLE = False
try:  # pragma: no cover
    import winreg  # type: ignore
    WINREG_AVAILABLE = os.name == "nt"
except ImportError:  # pragma: no cover
    winreg = None  # type: ignore

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


@dataclass(frozen=True)
class Tool:
    tool_id: str
    group: str
    """'network' | 'system' | 'files' | 'privacy'"""

    needs_elevation: bool = False
    dangerous: bool = False
    """True = 执行前界面必须二次确认。"""

    params_schema: Tuple[str, ...] = ()


TOOLS: Sequence[Tool] = (
    Tool("flushDns", "network"),
    Tool("renewIp", "network", needs_elevation=True),
    Tool("resetWinsock", "network", needs_elevation=True, dangerous=True),
    Tool("listPorts", "network"),
    Tool("showHosts", "network"),
    Tool("networkAdapters", "network"),
    Tool("systemInfo", "system"),
    Tool("createRestorePoint", "system", needs_elevation=True),
    Tool("hibernationStatus", "system"),
    Tool("toggleHibernation", "system", needs_elevation=True, params_schema=("enable",)),
    Tool("restartExplorer", "system"),
    Tool("clearIconCache", "system"),
    Tool("emptyFolders", "files", params_schema=("root", "apply")),
    Tool("whoLocks", "files", params_schema=("path",)),
    Tool("batchRename", "files",
         params_schema=("root", "pattern", "replacement", "apply")),
    Tool("longPathScan", "files", params_schema=("root",)),
    Tool("clearClipboard", "privacy"),
    Tool("wipeFreeSpaceEstimate", "privacy", params_schema=("drive",)),
    # 下面这批是第二轮补的。每一条都过了文件顶部那份收录标准 ——
    # 特别是"不收没有可测收益的东西"：这里没有任何一个"关服务提速"类工具。
    Tool("powerPlans", "system"),
    Tool("setPowerPlan", "system", params_schema=("guid",)),
    Tool("uptimeInfo", "system"),
    Tool("driverList", "system"),
    Tool("envVars", "system"),
    Tool("sfcVerify", "system", needs_elevation=True),
    Tool("firewallStatus", "network"),
    Tool("dnsCacheView", "network"),
    Tool("clearThumbnailCache", "files"),
    # 第三轮补的 15 个，同样遵循文件顶部的收录标准；只能靠"感觉变快了"证明有效的不收。
    Tool("processList", "system"),
    Tool("serviceList", "system"),
    Tool("diskHealth", "system"),
    Tool("restorePointList", "system"),
    Tool("pendingReboot", "system"),
    Tool("bigFileFinder", "files", params_schema=("root", "min_mb")),
    Tool("fileHash", "files", params_schema=("path",)),
    Tool("bulkAttributes", "files", params_schema=("root", "apply")),
    Tool("brokenShortcutScan", "files", params_schema=("root",)),
    Tool("recycleBinStatus", "files"),
    Tool("fileShredder", "privacy", dangerous=True, params_schema=("path", "apply")),
    # dangerous=True 必须保留：它清的跳转列表目录里混着用户手工固定的项，
    # 受保护的会被跳过，但要让用户在按下去之前就有机会停下。
    Tool("clearRecentDocs", "privacy", dangerous=True),
    Tool("pingTest", "network", params_schema=("host",)),
    Tool("dnsServers", "network"),
    Tool("killPort", "network", dangerous=True, params_schema=("port", "apply")),
)


def list_tools() -> List[Dict[str, object]]:
    return [dict(asdict(t), params_schema=list(t.params_schema)) for t in TOOLS]


def _run(args, timeout: float = 60.0, shell: bool = False) -> Tuple[int, str]:
    try:
        proc = subprocess.run(
            args, capture_output=True, timeout=timeout,
            creationflags=_CREATE_NO_WINDOW, shell=shell,
        )
        raw = (proc.stdout or b"") + (proc.stderr or b"")
        for encoding in ("utf-8", "gbk", "mbcs"):
            try:
                return proc.returncode, raw.decode(encoding)
            except (UnicodeDecodeError, LookupError):
                continue
        return proc.returncode, raw.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return -2, "timeout"
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, f"{type(exc).__name__}"


# 网络


def tool_flush_dns(_params: Dict) -> Dict[str, object]:
    code, out = _run(["ipconfig.exe", "/flushdns"], timeout=20.0)
    return {"ok": code == 0, "exit_code": code, "output": out.strip()}


def tool_renew_ip(_params: Dict) -> Dict[str, object]:
    code_r, out_r = _run(["ipconfig.exe", "/release"], timeout=45.0)
    code_a, out_a = _run(["ipconfig.exe", "/renew"], timeout=90.0)
    return {
        "ok": code_a == 0,
        "exit_code": code_a,
        "output": (out_r + "\n" + out_a).strip(),
    }


def tool_reset_winsock(_params: Dict) -> Dict[str, object]:
    """重置 Winsock 和 TCP/IP 栈。**执行后必须重启才生效** ——
    界面上不写这句的话，用户会以为没用。"""
    code1, out1 = _run(["netsh.exe", "winsock", "reset"], timeout=45.0)
    code2, out2 = _run(["netsh.exe", "int", "ip", "reset"], timeout=45.0)
    return {
        "ok": code1 == 0,
        "exit_code": code1 if code1 != 0 else code2,
        "output": (out1 + "\n" + out2).strip(),
        "needs_restart": True,
    }


def tool_list_ports(_params: Dict) -> Dict[str, object]:
    """哪个进程占了哪个端口。开发的人每周都要查一次，而 Windows 自带的
    做法是 `netstat -ano` 拿到 PID 再去任务管理器找 —— 这里一步到位。"""
    code, out = _run(["netstat.exe", "-ano", "-p", "TCP"], timeout=30.0)
    if code != 0:
        return {"ok": False, "exit_code": code, "rows": []}

    from modules.file_vault.pcclean.popup import _process_name

    rows: List[Dict[str, object]] = []
    seen: set = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5 or not parts[0].upper().startswith("TCP"):
            continue
        local, remote, state, pid_raw = parts[1], parts[2], parts[3], parts[4]
        if not pid_raw.isdigit():
            continue
        pid = int(pid_raw)
        key = (local, state, pid)
        if key in seen:
            continue
        seen.add(key)
        port = local.rsplit(":", 1)[-1]
        rows.append({
            "local": local,
            "port": int(port) if port.isdigit() else 0,
            "remote": remote,
            "state": state,
            "pid": pid,
            "process": _process_name(pid),
        })
    rows.sort(key=lambda r: (r["state"] != "LISTENING", r["port"]))
    return {"ok": True, "rows": rows[:400], "truncated": len(rows) > 400}


def tool_show_hosts(_params: Dict) -> Dict[str, object]:
    """只读显示 hosts，不提供写入：改 hosts 能劫持任意域名，加密应用不该替用户做；要改让用户自己用
    记事本。"""
    windir = paths.known("Windows")
    if windir is None:
        return {"ok": False, "error": "pcclean.toolbox.pathUnavailable"}
    hosts = windir / "System32/drivers/etc/hosts"
    try:
        text = hosts.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.toolbox.readFailed:{type(exc).__name__}"}
    entries = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) >= 2:
            entries.append({"address": parts[0], "hosts": parts[1:]})
    return {"ok": True, "path": str(hosts), "content": text,
            "entries": entries, "read_only": True}


def tool_network_adapters(_params: Dict) -> Dict[str, object]:
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,"
         "LinkSpeed,MacAddress | ConvertTo-Json -Compress"],
        timeout=30.0,
    )
    if code != 0:
        return {"ok": False, "exit_code": code, "adapters": []}
    import json
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return {"ok": False, "adapters": []}
    if isinstance(data, dict):
        data = [data]
    return {"ok": True, "adapters": data}


# 系统


def tool_system_info(_params: Dict) -> Dict[str, object]:
    from modules.file_vault.pcclean import memory as mem

    info: Dict[str, object] = {"ok": True}
    info["memory"] = mem.memory_status()
    try:
        info["hostname"] = socket.gethostname()
    except OSError:
        info["hostname"] = ""
    info["cpu_count"] = os.cpu_count() or 0
    try:
        info["boot_time"] = time.time() - (ctypes.windll.kernel32.GetTickCount64() / 1000.0)
    except (OSError, AttributeError):
        info["boot_time"] = 0
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "$os = Get-CimInstance Win32_OperatingSystem; "
         "$cs = Get-CimInstance Win32_ComputerSystem; "
         "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; "
         "[pscustomobject]@{OS=$os.Caption; Build=$os.BuildNumber; "
         "Arch=$os.OSArchitecture; Manufacturer=$cs.Manufacturer; Model=$cs.Model; "
         "Cpu=$cpu.Name} | ConvertTo-Json -Compress"],
        timeout=45.0,
    )
    if code == 0:
        import json
        try:
            info["platform"] = json.loads(out.strip() or "{}")
        except ValueError:
            info["platform"] = {}
    volumes: List[Dict[str, object]] = []
    from modules.file_vault.pcclean.space import _disk_space, _drive_letters
    for letter in _drive_letters():
        try:
            total, free = _disk_space(letter)
        except OSError:
            continue
        volumes.append({"drive": letter, "total_bytes": total, "free_bytes": free})
    info["volumes"] = volumes
    return info


def tool_create_restore_point(params: Dict) -> Dict[str, object]:
    """建系统还原点，清理套件执行前会自动调用。

    Windows 默认 24 小时内只允许建一个，第二次会静默失败，这里要显式报出来。
    """
    label = str(params.get("label") or "Tessera PC Clean")
    safe_label = re.sub(r'[^\w\s\-.]', "", label)[:60] or "Tessera"
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         f"Checkpoint-Computer -Description '{safe_label}' "
         "-RestorePointType 'APPLICATION_INSTALL'"],
        timeout=180.0,
    )
    if code == 0:
        return {"ok": True, "label": safe_label}
    lowered = out.lower()
    if "frequency" in lowered or "1440" in out or "已创建" in out:
        return {"ok": False, "error": "pcclean.toolbox.restorePointThrottled",
                "detail": out.strip()[:400]}
    if "disabled" in lowered or "已禁用" in out:
        return {"ok": False, "error": "pcclean.toolbox.systemProtectionOff",
                "detail": out.strip()[:400]}
    return {"ok": False, "error": "pcclean.toolbox.restorePointFailed",
            "exit_code": code, "detail": out.strip()[:400]}


def tool_hibernation_status(_params: Dict) -> Dict[str, object]:
    drive = paths.system_drive()
    hiber = Path(f"{drive}\\hiberfil.sys")
    try:
        exists = hiber.exists()
        size = hiber.stat().st_size if exists else 0
    except OSError:
        exists, size = False, 0
    return {"ok": True, "enabled": exists, "size_bytes": size, "path": str(hiber)}


def tool_toggle_hibernation(params: Dict) -> Dict[str, object]:
    enable = bool(params.get("enable"))
    code, out = _run(["powercfg.exe", "/hibernate", "on" if enable else "off"], timeout=45.0)
    return {"ok": code == 0, "enabled": enable, "exit_code": code,
            "output": out.strip()[:400]}


def tool_restart_explorer(_params: Dict) -> Dict[str, object]:
    """重启资源管理器。任务栏卡死、图标不刷新时最有效的一招，
    而 Windows 自己把它藏在任务管理器的详情页里。"""
    code, _ = _run(["taskkill.exe", "/F", "/IM", "explorer.exe"], timeout=20.0)
    time.sleep(0.8)
    try:
        windir = paths.known("Windows")
        target = str((windir / "explorer.exe")) if windir else "explorer.exe"
        subprocess.Popen([target], creationflags=_CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"pcclean.toolbox.relaunchFailed:{type(exc).__name__}"}
    return {"ok": True, "killed_exit_code": code}


def tool_clear_icon_cache(_params: Dict) -> Dict[str, object]:
    """清图标缓存（图标变白纸或错位时用）。

    必须先关 Explorer 再删：文件被占用时删除会静默失败（PermissionError 被吞掉）。
    """
    local = paths.known("LocalAppData")
    if local is None:
        return {"ok": False, "error": "pcclean.toolbox.pathUnavailable"}
    explorer_dir = local / "Microsoft/Windows/Explorer"
    _run(["taskkill.exe", "/F", "/IM", "explorer.exe"], timeout=20.0)
    time.sleep(0.6)

    removed = 0
    freed = 0
    failed: List[str] = []
    try:
        for entry in explorer_dir.glob("iconcache*"):
            try:
                size = entry.stat().st_size
                entry.unlink()
                removed += 1
                freed += size
            except OSError:
                failed.append(entry.name)
        for entry in explorer_dir.glob("thumbcache*"):
            try:
                size = entry.stat().st_size
                entry.unlink()
                removed += 1
                freed += size
            except OSError:
                failed.append(entry.name)
    except OSError as exc:
        failed.append(type(exc).__name__)

    try:
        windir = paths.known("Windows")
        target = str((windir / "explorer.exe")) if windir else "explorer.exe"
        subprocess.Popen([target], creationflags=_CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        pass
    return {"ok": removed > 0, "removed": removed, "freed_bytes": freed, "failed": failed}


# 文件


def tool_empty_folders(params: Dict) -> Dict[str, object]:
    """找出（可选删除）空文件夹；`apply=False` 只列出，先看后删是工具箱通则。"""
    root_raw = str(params.get("root") or "")
    apply = bool(params.get("apply"))
    if not root_raw:
        return {"ok": False, "error": "pcclean.toolbox.rootRequired"}
    root = Path(root_raw)
    if not root.exists() or not root.is_dir():
        return {"ok": False, "error": "pcclean.toolbox.rootMissing"}

    empties: List[str] = []
    # 自底向上走，这样删掉子目录之后父目录也能被认出来是空的。
    for current, dirs, files in os.walk(root, topdown=False):
        if files:
            continue
        try:
            if not any(os.scandir(current)):
                empties.append(current)
        except OSError:
            continue
        if len(empties) >= 5000:
            break

    removed = 0
    failed: List[str] = []
    if apply:
        for path in empties:
            try:
                os.rmdir(path)
                removed += 1
            except OSError:
                failed.append(path)
    return {"ok": True, "found": len(empties), "removed": removed,
            "folders": empties[:1000], "truncated": len(empties) > 1000,
            "failed": failed[:50], "applied": apply}


def tool_who_locks(params: Dict) -> Dict[str, object]:
    """谁占用了这个文件。

    用 Restart Manager API (`rstrtmgr.dll`)，比枚举所有进程句柄快几个数量级，且无需管理员权限。
    """
    target = str(params.get("path") or "")
    if not target:
        return {"ok": False, "error": "pcclean.toolbox.pathRequired"}
    if not os.path.exists(target):
        return {"ok": False, "error": "pcclean.toolbox.pathMissing"}
    if os.name != "nt":
        return {"ok": False, "error": "pcclean.toolbox.windowsOnly"}

    from ctypes import wintypes

    class RM_UNIQUE_PROCESS(ctypes.Structure):
        _fields_ = [("dwProcessId", wintypes.DWORD),
                    ("ProcessStartTime", wintypes.FILETIME)]

    class RM_PROCESS_INFO(ctypes.Structure):
        _fields_ = [
            ("Process", RM_UNIQUE_PROCESS),
            ("strAppName", wintypes.WCHAR * 256),
            ("strServiceShortName", wintypes.WCHAR * 64),
            ("ApplicationType", ctypes.c_int),
            ("AppStatus", wintypes.ULONG),
            ("TSSessionId", wintypes.DWORD),
            ("bRestartable", wintypes.BOOL),
        ]

    try:
        rstrtmgr = ctypes.windll.rstrtmgr
    except (OSError, AttributeError):
        return {"ok": False, "error": "pcclean.toolbox.apiUnavailable"}

    session = wintypes.DWORD()
    key = ctypes.create_unicode_buffer(256)
    if rstrtmgr.RmStartSession(ctypes.byref(session), 0, key) != 0:
        return {"ok": False, "error": "pcclean.toolbox.sessionFailed"}
    try:
        files = (ctypes.c_wchar_p * 1)(target)
        if rstrtmgr.RmRegisterResources(session, 1, files, 0, None, 0, None) != 0:
            return {"ok": False, "error": "pcclean.toolbox.registerFailed"}

        needed = ctypes.c_uint(0)
        count = ctypes.c_uint(0)
        reason = ctypes.c_uint(0)
        # 第一次调用拿所需数量；直接给固定大小的缓冲区会在占用者多时截断。
        rstrtmgr.RmGetList(session, ctypes.byref(needed), ctypes.byref(count),
                           None, ctypes.byref(reason))
        n = max(1, needed.value)
        array = (RM_PROCESS_INFO * n)()
        count = ctypes.c_uint(n)
        if rstrtmgr.RmGetList(session, ctypes.byref(needed), ctypes.byref(count),
                              array, ctypes.byref(reason)) != 0:
            return {"ok": False, "error": "pcclean.toolbox.listFailed"}

        holders = []
        for i in range(min(count.value, n)):
            info = array[i]
            holders.append({
                "pid": int(info.Process.dwProcessId),
                "name": info.strAppName,
                "service": info.strServiceShortName,
                "restartable": bool(info.bRestartable),
            })
        return {"ok": True, "path": target, "holders": holders}
    finally:
        rstrtmgr.RmEndSession(session)


def tool_batch_rename(params: Dict) -> Dict[str, object]:
    """按正则批量改名，`apply=False` 只出预览：正则写错会一次改掉几百个文件名，且改名没有回收站。"""
    root_raw = str(params.get("root") or "")
    pattern = str(params.get("pattern") or "")
    replacement = str(params.get("replacement") or "")
    apply = bool(params.get("apply"))
    if not root_raw or not pattern:
        return {"ok": False, "error": "pcclean.toolbox.renameArgsRequired"}
    root = Path(root_raw)
    if not root.exists() or not root.is_dir():
        return {"ok": False, "error": "pcclean.toolbox.rootMissing"}
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return {"ok": False, "error": "pcclean.toolbox.badRegex", "detail": str(exc)}

    plan: List[Dict[str, str]] = []
    try:
        entries = sorted(p for p in root.iterdir() if p.is_file())
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.toolbox.readFailed:{type(exc).__name__}"}

    taken = {p.name.lower() for p in entries}
    for entry in entries:
        new_name = regex.sub(replacement, entry.name)
        if new_name == entry.name or not new_name.strip():
            continue
        # 冲突检测：改完之后同名会覆盖别人的文件。这里直接跳过并报告，
        # 不去自动加 (1) 后缀 —— 用户要的是他写的那个规则，静默改名更糟。
        if new_name.lower() in taken:
            plan.append({"from": entry.name, "to": new_name, "status": "conflict"})
            continue
        taken.add(new_name.lower())
        plan.append({"from": entry.name, "to": new_name, "status": "ok"})

    renamed = 0
    failed: List[str] = []
    if apply:
        for row in plan:
            if row["status"] != "ok":
                continue
            try:
                (root / row["from"]).rename(root / row["to"])
                renamed += 1
            except OSError:
                failed.append(row["from"])
                row["status"] = "failed"
    return {"ok": True, "planned": len(plan), "renamed": renamed,
            "plan": plan[:500], "truncated": len(plan) > 500,
            "failed": failed[:50], "applied": apply}


def tool_long_path_scan(params: Dict) -> Dict[str, object]:
    """找出超过 260 字符的路径。这类路径会让复制、备份、删除全部失败，
    而 Explorer 给的错误提示完全看不出是路径太长。"""
    root_raw = str(params.get("root") or "")
    if not root_raw:
        return {"ok": False, "error": "pcclean.toolbox.rootRequired"}
    root = Path(root_raw)
    if not root.exists():
        return {"ok": False, "error": "pcclean.toolbox.rootMissing"}
    rows: List[Dict[str, object]] = []
    for file_path, size in paths.iter_files(root):
        text = str(file_path)
        if len(text) > 255:
            rows.append({"path": text, "length": len(text), "size_bytes": size})
        if len(rows) >= 500:
            break
    rows.sort(key=lambda r: r["length"], reverse=True)
    return {"ok": True, "rows": rows, "count": len(rows)}


# 隐私


def tool_clear_clipboard(_params: Dict) -> Dict[str, object]:
    """清空 Windows 当前剪贴板；不碰本应用自己的剪贴板历史（那是用户加密保存的数据）。"""
    if os.name != "nt":
        return {"ok": False, "error": "pcclean.toolbox.windowsOnly"}
    user32 = ctypes.windll.user32
    try:
        if not user32.OpenClipboard(0):
            return {"ok": False, "error": "pcclean.toolbox.clipboardBusy"}
        try:
            user32.EmptyClipboard()
        finally:
            user32.CloseClipboard()
    except (OSError, AttributeError) as exc:
        return {"ok": False, "error": f"pcclean.toolbox.apiUnavailable:{type(exc).__name__}"}
    return {"ok": True, "note": "pcclean.toolbox.clipboardVaultUntouched"}


def tool_wipe_free_space_estimate(params: Dict) -> Dict[str, object]:
    """估算擦除空闲空间要多久，只估算不执行：擦空闲空间要写满几百 GB，SSD 上纯耗寿命且因磨损均衡擦
    不干净。"""
    drive = str(params.get("drive") or paths.system_drive())
    if not drive.endswith("\\"):
        drive = drive.rstrip(":") + ":\\"
    from modules.file_vault.pcclean.space import _disk_space, _media_types
    try:
        total, free = _disk_space(drive)
    except OSError:
        return {"ok": False, "error": "pcclean.toolbox.driveUnavailable"}
    media = _media_types().get(drive.rstrip(":\\").upper(), "unknown")
    is_ssd = media != "HDD"
    # 保守估：HDD 按 90 MB/s，SSD 按 300 MB/s
    rate = 300 * 1024 * 1024 if is_ssd else 90 * 1024 * 1024
    return {
        "ok": True,
        "drive": drive,
        "free_bytes": free,
        "total_bytes": total,
        "media_type": media,
        "is_ssd": is_ssd,
        "estimated_seconds": int(free / rate) if rate else 0,
        "recommended": not is_ssd,
        "note": "pcclean.toolbox.wipeSsdWarning" if is_ssd
        else "pcclean.toolbox.wipeHddNote",
    }


# 第二批工具

_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                      r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def tool_power_plans(_params: Dict) -> Dict[str, object]:
    """列出电源方案并标出当前生效的；省电模式把 CPU 锁在 30% 是笔记本变慢常见却易忽略的原因。"""
    code, out = _run(["powercfg.exe", "/list"], timeout=20.0)
    plans: List[Dict[str, object]] = []
    for line in out.splitlines():
        match = re.search(r"([0-9a-fA-F-]{36})\s*\(([^)]*)\)", line)
        if not match:
            continue
        plans.append({
            "guid": match.group(1),
            "name": match.group(2).strip(),
            # powercfg 用行尾的星号标当前方案。**不能靠"名字里有不有'平衡'"
            # 来猜**——那个名字是本地化过的，六种语言六个样。
            "active": line.rstrip().endswith("*"),
        })
    return {"ok": code == 0 and bool(plans), "exit_code": code, "plans": plans}


def tool_set_power_plan(params: Dict) -> Dict[str, object]:
    """切换电源方案；GUID 必须先过正则，参数进命令行且来自渲染进程，不校验等于让前端决定
    `powercfg.exe` 的参数。"""
    guid = str(params.get("guid") or "").strip()
    if not _GUID_RE.match(guid):
        return {"ok": False, "error": "pcclean.toolbox.invalidGuid"}
    code, out = _run(["powercfg.exe", "/setactive", guid], timeout=20.0)
    return {"ok": code == 0, "exit_code": code, "output": out.strip(), "guid": guid}


def tool_uptime_info(_params: Dict) -> Dict[str, object]:
    """开机多久了；直接读 `GetTickCount64`，不解析 `systeminfo`（要跑好几秒，且各语言措辞不同）。"""
    try:
        ticks = ctypes.windll.kernel32.GetTickCount64()
    except Exception:
        return {"ok": False, "error": "pcclean.toolbox.unavailable"}
    uptime_s = int(ticks / 1000)
    return {
        "ok": True,
        "uptime_seconds": uptime_s,
        "boot_time": int(time.time() - uptime_s),
        # 连续开机超过一周，很多"越用越卡"其实重启一次就好了。
        "suggest_reboot": uptime_s > 7 * 24 * 3600,
    }


def tool_driver_list(_params: Dict) -> Dict[str, object]:
    """列出已装驱动。换硬件或排查蓝屏时想知道"这台机器上装了谁的驱动"。"""
    code, out = _run(["driverquery.exe", "/FO", "CSV", "/NH"], timeout=90.0)
    drivers: List[Dict[str, str]] = []
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 3:
            drivers.append({"name": parts[0].lstrip('"'),
                            "display_name": parts[1],
                            "type": parts[2]})
    return {"ok": code == 0, "exit_code": code, "count": len(drivers),
            "drivers": drivers[:500], "truncated": len(drivers) > 500}


def tool_env_vars(_params: Dict) -> Dict[str, object]:
    """环境变量。PATH 单独拆成一条条列出来——它通常长到没法在一行里看，
    而"某个命令找不到"十有八九就是这里面某一项写错了。"""
    values = {k: v for k, v in os.environ.items()}
    path_entries = [p for p in values.get("PATH", "").split(os.pathsep) if p]
    missing = []
    for entry in path_entries:
        try:
            if not Path(entry).is_dir():
                missing.append(entry)
        except OSError:
            missing.append(entry)
    return {
        "ok": True,
        "count": len(values),
        "vars": [{"name": k, "value": v} for k, v in sorted(values.items())],
        "path_entries": path_entries,
        # PATH 里指向不存在目录的条目：无害但会拖慢每一次命令查找。
        "path_missing": missing,
    }


def tool_sfc_verify(_params: Dict) -> Dict[str, object]:
    """系统文件完整性校验，只查不修（`/verifyonly`）。刻意不提供 `/scannow`：修复要动系统文件，后
    果超出本应用能承担的范围；
    结果里告诉用户命令，由其自行决定。
    """
    code, out = _run(["sfc.exe", "/verifyonly"], timeout=1800.0)
    text = out.replace("\x00", "")
    lowered = text.lower()
    violations = ("did find integrity violations" in lowered
                  or "找到完整性冲突" in text or "发现了完整性冲突" in text)
    return {
        "ok": code == 0 and not violations,
        "exit_code": code,
        "violations": violations,
        "output": text.strip()[-4000:],
        "repair_command": "sfc /scannow",
    }


def tool_firewall_status(_params: Dict) -> Dict[str, object]:
    """三种网络配置文件的防火墙开关状态。"""
    code, out = _run(["netsh.exe", "advfirewall", "show", "allprofiles", "state"],
                     timeout=30.0)
    lowered = out.lower()
    return {
        "ok": code == 0,
        "exit_code": code,
        "output": out.strip(),
        # 只要有一处是 OFF 就值得提醒。不去逐个 profile 解析名字——
        # 那些名字是本地化的（"域配置文件"/"Domain Profile"…）。
        "any_off": " off" in lowered or "关闭" in out,
    }


def tool_dns_cache_view(_params: Dict) -> Dict[str, object]:
    """看 DNS 缓存里的域名，与「清空 DNS 缓存」配套：清之前先看是否解析到了旧地址。"""
    code, out = _run(["ipconfig.exe", "/displaydns"], timeout=30.0)
    names = sorted({m.strip() for m in re.findall(r"^\s*(\S+)\s*$", out, re.MULTILINE)
                    if "." in m and not m.strip().startswith("-")})
    return {"ok": code == 0, "exit_code": code, "count": len(names),
            "entries": names[:400], "truncated": len(names) > 400}


def tool_clear_thumbnail_cache(_params: Dict) -> Dict[str, object]:
    """删缩略图缓存 (`thumbcache_*.db`)，不同于图标缓存，可长到数 GB。

    被资源管理器占用的文件删不掉属正常，如实计入 `locked` 而不是报失败。
    """
    local = paths.known("LocalAppData")
    if local is None:
        return {"ok": False, "error": "pcclean.toolbox.unavailable"}
    root = local / "Microsoft" / "Windows" / "Explorer"
    if not paths.exists(root):
        return {"ok": True, "removed": 0, "freed_bytes": 0, "locked": 0}
    removed = freed = locked = 0
    try:
        for entry in root.iterdir():
            if not entry.name.lower().startswith("thumbcache_"):
                continue
            try:
                size = entry.stat().st_size
                entry.unlink()
                removed += 1
                freed += size
            except OSError:
                locked += 1
    except OSError:
        return {"ok": False, "error": "pcclean.toolbox.unavailable"}
    return {"ok": True, "removed": removed, "freed_bytes": freed, "locked": locked}


# 第三轮补的 15 个。约定：能给结构化 `rows` 的绝不只给文本，前端渲染为表格；
# `rows` 的键名一律英文小写下划线，前端按固定列名取。


def tool_process_list(_params: Dict) -> Dict[str, object]:
    """按内存占用排的进程表，比任务管理器多显示签名/发布者，用户要知道"这个吃了 2 GB 的是谁的"。"""
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 60 "
         "Id,ProcessName,@{n='MemoryMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},"
         "@{n='Company';e={$_.Company}},@{n='Threads';e={$_.Threads.Count}} "
         "| ConvertTo-Json -Compress"],
        timeout=45.0,
    )
    if code != 0:
        return {"ok": False, "exit_code": code, "rows": []}
    import json
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return {"ok": False, "error": "pcclean.toolbox.readFailed", "rows": []}
    if isinstance(data, dict):
        data = [data]
    rows = [{
        "pid": int(d.get("Id") or 0),
        "process": str(d.get("ProcessName") or ""),
        "memory_mb": float(d.get("MemoryMB") or 0),
        "company": str(d.get("Company") or ""),
        "threads": int(d.get("Threads") or 0),
    } for d in data if isinstance(d, dict)]
    return {"ok": True, "rows": rows}


def tool_service_list(_params: Dict) -> Dict[str, object]:
    """只列非 Microsoft 的服务：全量两百多条多为系统自带，列出只会让人不敢动。
    只显示不提供停用按钮：停错服务（网络没了、外设不认）的后果远大于收益，应在服务管理器里由人来做。
    """
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-CimInstance Win32_Service | Where-Object { $_.PathName -notlike "
         "'*\\Windows\\System32\\svchost.exe*' } | Select-Object Name,DisplayName,"
         "State,StartMode,PathName | ConvertTo-Json -Compress"],
        timeout=60.0,
    )
    if code != 0:
        return {"ok": False, "exit_code": code, "rows": []}
    import json
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return {"ok": False, "error": "pcclean.toolbox.readFailed", "rows": []}
    if isinstance(data, dict):
        data = [data]
    rows = [{
        "name": str(d.get("Name") or ""),
        "display": str(d.get("DisplayName") or ""),
        "state": str(d.get("State") or ""),
        "start_mode": str(d.get("StartMode") or ""),
        "path": str(d.get("PathName") or ""),
    } for d in data if isinstance(d, dict)]
    rows.sort(key=lambda r: (r["state"] != "Running", r["display"].lower()))
    return {"ok": True, "rows": rows[:300], "truncated": len(rows) > 300}


def tool_disk_health(_params: Dict) -> Dict[str, object]:
    """物理磁盘的健康状态与通电时长。

    通电时长走 `Get-StorageReliabilityCounter`，拿不到就不显示（有些 USB 桥接芯片不透传 SMART，编
    一个 0 更糟）。
    """
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-PhysicalDisk | ForEach-Object { $c = $_ | Get-StorageReliabilityCounter "
         "-ErrorAction SilentlyContinue; [pscustomobject]@{ Name=$_.FriendlyName; "
         "Media=$_.MediaType; Size=$_.Size; Health=$_.HealthStatus; "
         "Usage=$_.Usage; Temp=$c.Temperature; Hours=$c.PowerOnHours; "
         "Wear=$c.Wear } } | ConvertTo-Json -Compress"],
        timeout=60.0,
    )
    if code != 0:
        return {"ok": False, "exit_code": code, "rows": []}
    import json
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return {"ok": False, "error": "pcclean.toolbox.readFailed", "rows": []}
    if isinstance(data, dict):
        data = [data]
    rows = []
    for d in data:
        if not isinstance(d, dict):
            continue
        rows.append({
            "name": str(d.get("Name") or ""),
            "media": str(d.get("Media") or ""),
            "size_bytes": int(d.get("Size") or 0),
            "health": str(d.get("Health") or ""),
            "usage": str(d.get("Usage") or ""),
            # None 而不是 0：0 度和"读不到温度"是两回事。
            "temperature_c": d.get("Temp"),
            "power_on_hours": d.get("Hours"),
            "wear_percent": d.get("Wear"),
        })
    return {"ok": True, "rows": rows}


def tool_restore_point_list(_params: Dict) -> Dict[str, object]:
    """现有的系统还原点，配套 `createRestorePoint`：建之前先看有没有、有多久了。"""
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-ComputerRestorePoint | Select-Object SequenceNumber,Description,"
         "RestorePointType,@{n='When';e={$_.ConvertToDateTime($_.CreationTime)"
         ".ToString('yyyy-MM-dd HH:mm')}} | ConvertTo-Json -Compress"],
        timeout=60.0,
    )
    if code != 0:
        # 系统保护关着时这条命令会失败，而那不是错误——是一个用户需要知道的状态。
        return {"ok": True, "rows": [], "protection_off": True}
    import json
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return {"ok": True, "rows": [], "protection_off": True}
    if isinstance(data, dict):
        data = [data]
    rows = [{
        "sequence": int(d.get("SequenceNumber") or 0),
        "description": str(d.get("Description") or ""),
        "type": str(d.get("RestorePointType") or ""),
        "when": str(d.get("When") or ""),
    } for d in data if isinstance(d, dict)]
    rows.sort(key=lambda r: r["sequence"], reverse=True)
    return {"ok": True, "rows": rows, "protection_off": False}


def tool_pending_reboot(_params: Dict) -> Dict[str, object]:
    """有没有等着重启才能生效的更新；很多"清理没效果"（C 盘瘦身后空间不变、驱动没生效）其实是这个，
    这几个注册表位置是确定的。"""
    if not WINREG_AVAILABLE:
        return {"ok": False, "error": "pcclean.toolbox.windowsOnly"}
    signals: List[Dict[str, object]] = []
    # 「这个键存在 = 有东西等着重启」的两处。它们是 Windows 自己用的信号，
    # 不是我们推断出来的——键在就是在。
    checks = (
        ("windowsUpdate", winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"),
        ("componentBasedServicing", winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"),
    )
    for name, hive, subkey in checks:
        try:
            with winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ):
                signals.append({"source": name, "pending": True})
        except OSError:
            signals.append({"source": name, "pending": False})

    # PendingFileRenameOperations：装/卸软件时留下的"下次开机再删这些文件"。
    renames = 0
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SYSTEM\CurrentControlSet\Control\Session Manager",
                            0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, "PendingFileRenameOperations")
            renames = len([v for v in (value or []) if v])
    except OSError:
        renames = 0
    signals.append({"source": "pendingFileRename", "pending": renames > 0,
                    "count": renames})

    pending = any(bool(s.get("pending")) for s in signals)
    return {"ok": True, "pending": pending, "rows": signals}


def tool_big_file_finder(params: Dict) -> Dict[str, object]:
    """在指定目录下找最大的 200 个文件；不带任何清理能力，只回答"这个文件夹里什么占了 8 个 G"。"""
    root_raw = str(params.get("root") or "").strip()
    if not root_raw:
        return {"ok": False, "error": "pcclean.toolbox.rootRequired"}
    root = Path(os.path.expandvars(root_raw))
    if not paths.exists(root) or not root.is_dir():
        return {"ok": False, "error": "pcclean.toolbox.rootMissing"}
    try:
        min_bytes = max(0, int(float(params.get("min_mb") or 50) * 1024 * 1024))
    except (TypeError, ValueError):
        min_bytes = 50 * 1024 * 1024

    found: List[Tuple[int, str]] = []
    total = 0
    for file_path, size in paths.iter_files(root, max_depth=12):
        total += 1
        if size >= min_bytes:
            found.append((size, str(file_path)))
        # 硬上限。对着 C:\ 调用它会数千万个文件，界面等不起，
        # 而"最大的 200 个"在前几万个文件里就已经稳定了。
        if total >= 400_000:
            break
    found.sort(reverse=True)
    rows = [{"path": p, "size_bytes": s} for s, p in found[:200]]
    return {"ok": True, "rows": rows, "scanned": total,
            "truncated": len(found) > 200}


def tool_file_hash(params: Dict) -> Dict[str, object]:
    """一个文件的 SHA-256 / MD5，用于核对下载的安装包与官网校验值。"""
    import hashlib

    raw = str(params.get("path") or "").strip().strip('"')
    if not raw:
        return {"ok": False, "error": "pcclean.toolbox.pathRequired"}
    target = Path(os.path.expandvars(raw))
    if not paths.exists(target) or not target.is_file():
        return {"ok": False, "error": "pcclean.toolbox.pathMissing"}
    sha = hashlib.sha256()
    # 只用来和官网公布的校验值比对，不承担任何安全判断。
    md5 = hashlib.md5(usedforsecurity=False)
    size = 0
    try:
        with open(target, "rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                sha.update(chunk)
                md5.update(chunk)
                # 8 GB 封顶：再大的文件算哈希要几分钟，而那种场景该用专门的工具。
                if size > 8 * 1024 ** 3:
                    return {"ok": False, "error": "pcclean.toolbox.fileTooLarge"}
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.toolbox.readFailed:{type(exc).__name__}"}
    return {"ok": True, "path": str(target), "size_bytes": size,
            "rows": [{"algorithm": "SHA-256", "value": sha.hexdigest()},
                     {"algorithm": "MD5", "value": md5.hexdigest()}]}


def tool_bulk_attributes(params: Dict) -> Dict[str, object]:
    """批量清掉只读/隐藏属性（从光盘、旧硬盘、压缩包拷出的目录树常全是只读）。
    资源管理器的"应用到子文件夹"对深目录常半途失败且不报哪个失败。
    默认预览（`apply` 不为 true 时只数不改），与其他改动类工具一致。
    """
    root_raw = str(params.get("root") or "").strip()
    if not root_raw:
        return {"ok": False, "error": "pcclean.toolbox.rootRequired"}
    root = Path(os.path.expandvars(root_raw))
    if not paths.exists(root) or not root.is_dir():
        return {"ok": False, "error": "pcclean.toolbox.rootMissing"}
    apply = bool(params.get("apply"))

    FILE_ATTRIBUTE_READONLY = 0x1
    FILE_ATTRIBUTE_HIDDEN = 0x2
    FILE_ATTRIBUTE_NORMAL = 0x80
    changed = 0
    failed = 0
    rows: List[Dict[str, object]] = []
    scanned = 0
    for file_path, _size in paths.iter_files(root, max_depth=16):
        scanned += 1
        if scanned > 60_000:
            break
        try:
            attrs = ctypes.windll.kernel32.GetFileAttributesW(str(file_path))
        except (OSError, AttributeError):
            continue
        if attrs == -1 or not (attrs & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN)):
            continue
        if len(rows) < 200:
            rows.append({
                "path": str(file_path),
                "readonly": bool(attrs & FILE_ATTRIBUTE_READONLY),
                "hidden": bool(attrs & FILE_ATTRIBUTE_HIDDEN),
            })
        if not apply:
            changed += 1
            continue
        cleared = attrs & ~FILE_ATTRIBUTE_READONLY & ~FILE_ATTRIBUTE_HIDDEN
        try:
            ok = ctypes.windll.kernel32.SetFileAttributesW(
                str(file_path), cleared or FILE_ATTRIBUTE_NORMAL)
            if ok:
                changed += 1
            else:
                failed += 1
        except (OSError, AttributeError):
            failed += 1
    return {"ok": True, "applied": apply, "changed": changed, "failed": failed,
            "scanned": scanned, "rows": rows, "truncated": len(rows) >= 200}


def tool_broken_shortcut_scan(params: Dict) -> Dict[str, object]:
    """找出指向已不存在目标的 .lnk，只列出不删；删除走「空文件夹 / 失效快捷方式」那一类（有回收站
    兜底）。"""
    from modules.file_vault.pcclean.deepclean import _is_broken_shortcut

    root_raw = str(params.get("root") or "").strip()
    if root_raw:
        root = Path(os.path.expandvars(root_raw))
    else:
        root = paths.known("Desktop") or Path.home()
    if not paths.exists(root) or not root.is_dir():
        return {"ok": False, "error": "pcclean.toolbox.rootMissing"}

    rows: List[Dict[str, object]] = []
    scanned = 0
    try:
        for entry in root.rglob("*.lnk"):
            scanned += 1
            if scanned > 20_000:
                break
            try:
                if _is_broken_shortcut(entry):
                    rows.append({"path": str(entry), "name": entry.stem})
            except OSError:
                continue
            if len(rows) >= 300:
                break
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.toolbox.readFailed:{type(exc).__name__}"}
    return {"ok": True, "rows": rows, "scanned": scanned,
            "root": str(root), "truncated": len(rows) >= 300}


def tool_recycle_bin_status(_params: Dict) -> Dict[str, object]:
    """回收站里有多少东西、占多大。走 Shell API，不去遍历 `$Recycle.Bin`
    ——那个目录的 ACL 只对所有者开放，遍历数出来的值会小很多。"""
    if os.name != "nt":
        return {"ok": False, "error": "pcclean.toolbox.windowsOnly"}
    try:
        class SHQUERYRBINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", ctypes.c_ulong),
                ("i64Size", ctypes.c_longlong),
                ("i64NumItems", ctypes.c_longlong),
            ]

        info = SHQUERYRBINFO()
        info.cbSize = ctypes.sizeof(info)
        hr = ctypes.windll.shell32.SHQueryRecycleBinW(None, ctypes.byref(info))
        if hr != 0:
            return {"ok": False, "error": "pcclean.toolbox.apiUnavailable"}
        return {"ok": True, "size_bytes": int(info.i64Size),
                "item_count": int(info.i64NumItems)}
    except (OSError, AttributeError, ValueError):
        return {"ok": False, "error": "pcclean.toolbox.apiUnavailable"}


def tool_file_shredder(params: Dict) -> Dict[str, object]:
    """覆写后删除一个文件（三遍覆写 + 改名 + 删除）。

    机械硬盘上覆写后基本不可恢复；SSD 因磨损均衡，覆写多半写到另一块物理闪存，原数据仍在，
    真正有效的是全盘 TRIM 或一开始就加密。本工具不假装在 SSD 上不可恢复，并把这段说明显示给用户。
    """
    raw = str(params.get("path") or "").strip().strip('"')
    if not raw:
        return {"ok": False, "error": "pcclean.toolbox.pathRequired"}
    target = Path(os.path.expandvars(raw))
    if not paths.exists(target) or not target.is_file():
        return {"ok": False, "error": "pcclean.toolbox.pathMissing"}

    try:
        size = target.stat().st_size
    except OSError:
        return {"ok": False, "error": "pcclean.toolbox.pathUnavailable"}
    # 2 GB 封顶：再大的文件三遍覆写要写 6 GB，既慢又费寿命。
    if size > 2 * 1024 ** 3:
        return {"ok": False, "error": "pcclean.toolbox.fileTooLarge"}
    if not bool(params.get("apply")):
        return {"ok": True, "applied": False, "path": str(target),
                "size_bytes": size, "passes": 3}

    try:
        with open(target, "r+b") as handle:
            for pattern in (b"\x00", b"\xff", os.urandom(1)):
                handle.seek(0)
                block = pattern * (1024 * 1024)
                written = 0
                while written < size:
                    handle.write(block[: min(len(block), size - written)])
                    written += min(len(block), size - written)
                handle.flush()
                os.fsync(handle.fileno())
        # 改名之后再删：文件名本身也是信息，而它留在目录项里。
        scrambled = target.with_name(f"{uuid_hex()}.tmp")
        os.replace(target, scrambled)
        os.remove(scrambled)
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.toolbox.failed:{type(exc).__name__}"}
    return {"ok": True, "applied": True, "path": str(target),
            "size_bytes": size, "passes": 3}


def uuid_hex() -> str:
    import uuid as _uuid
    return _uuid.uuid4().hex


def tool_clear_recent_docs(params: Dict) -> Dict[str, object]:
    """清空「最近使用的文件」列表（资源管理器 + 跳转列表），一次性、立即生效。

    此前曾直接 `entry.unlink()` 遍历三个目录，绕过 `safety` 全部判断、不进回收站、不写撤销日志，
    能一键抹掉「快速访问 → 固定的文件夹」。现与执行侧同一套：`safety.PathGuard` 逐个问是否受保护
    （跳过并计数）；删除走 `actions.recycle()`；成功项写撤销日志。
    返回 `skipped` / `skippedReasons` 供界面说明"保护了 N 个固定项"，沉默保护会让用户下次去别处删掉。
    """
    from modules.file_vault.pcclean import actions, safety

    recent = paths.known("Recent")
    if recent is None:
        return {"ok": False, "error": "pcclean.toolbox.pathUnavailable"}

    guard = safety.PathGuard()
    removed = 0
    freed = 0
    failed = 0
    skipped = 0
    skipped_reasons: List[str] = []
    journal: List[Dict[str, object]] = []
    targets = [recent,
               recent / "AutomaticDestinations",
               recent / "CustomDestinations"]
    for folder in targets:
        if not paths.exists(folder):
            continue
        try:
            entries = list(folder.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir():
                    continue
            except OSError:
                continue
            reason = guard.check(entry)
            if reason:
                skipped += 1
                if reason not in skipped_reasons:
                    skipped_reasons.append(reason)
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            ok, _err = actions.recycle(entry)
            if not ok:
                failed += 1
                continue
            removed += 1
            freed += size
            journal.append({"kind": "recycled", "path": str(entry),
                            "item_id": "toolbox:clearRecentDocs",
                            "reversible": True,
                            "note": "restore_from_recycle_bin"})

    # 撤销日志。`data_dir` 由后端注入（见 run_tool），拿不到就只是没有这条
    # 记录——文件已经在回收站里了，用户照样能自己拉回来。
    session_id = ""
    data_dir = params.get("data_dir")
    if journal and data_dir:
        try:
            session_id = uuid_hex()[:16]
            actions._write_journal(Path(str(data_dir)), session_id, journal,
                                   {"tool": "clearRecentDocs", "freed_bytes": freed})
        except Exception:
            session_id = ""

    return {"ok": True, "removed": removed, "freed_bytes": freed, "failed": failed,
            "skipped": skipped, "skippedReasons": skipped_reasons,
            "session_id": session_id}


def tool_ping_test(params: Dict) -> Dict[str, object]:
    """到某个主机的延迟和丢包，默认 `223.5.5.5`（阿里公共 DNS）而非 `8.8.8.8`：后者在国内常不通，
    会让"网络诊断"误报网络不通。
    """
    host = str(params.get("host") or "").strip() or "223.5.5.5"
    # 只允许域名/IP 的字符集。这个值会进命令行参数。
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,253}", host):
        return {"ok": False, "error": "pcclean.toolbox.badHost"}
    code, out = _run(["ping.exe", "-n", "4", "-w", "2000", host], timeout=30.0)
    times = [int(m) for m in re.findall(r"[=<](\d+)ms", out)]
    loss = re.search(r"(\d+)%", out)
    return {
        "ok": True,
        "host": host,
        "reachable": code == 0 and bool(times),
        "exit_code": code,
        "avg_ms": round(sum(times) / len(times), 1) if times else None,
        "min_ms": min(times) if times else None,
        "max_ms": max(times) if times else None,
        "loss_percent": int(loss.group(1)) if loss else None,
        "output": out.strip(),
    }


def tool_dns_servers(_params: Dict) -> Dict[str, object]:
    """每块网卡当前用的 DNS；网页打不开时"DNS 被某个软件改过"很常见，系统入口藏在第五层。"""
    code, out = _run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses.Count -gt 0 } "
         "| Select-Object InterfaceAlias,AddressFamily,"
         "@{n='Servers';e={$_.ServerAddresses -join ', '}} | ConvertTo-Json -Compress"],
        timeout=30.0,
    )
    if code != 0:
        return {"ok": False, "exit_code": code, "rows": []}
    import json
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return {"ok": False, "error": "pcclean.toolbox.readFailed", "rows": []}
    if isinstance(data, dict):
        data = [data]
    rows = [{
        "adapter": str(d.get("InterfaceAlias") or ""),
        "family": "IPv6" if int(d.get("AddressFamily") or 2) == 23 else "IPv4",
        "servers": str(d.get("Servers") or ""),
    } for d in data if isinstance(d, dict)]
    return {"ok": True, "rows": rows}


def tool_kill_port(params: Dict) -> Dict[str, object]:
    """找出占着某个端口的进程，可选结束它。

    默认只查不杀（`apply` 不为 true）：杀进程不可逆，端口号打错一位可能杀掉正在写数据的服务，
    界面必须先显示"要杀的是谁"让人确认。
    """
    from modules.file_vault.pcclean.popup import _process_name

    try:
        port = int(params.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if not 1 <= port <= 65535:
        return {"ok": False, "error": "pcclean.toolbox.badPort"}

    code, out = _run(["netstat.exe", "-ano", "-p", "TCP"], timeout=30.0)
    if code != 0:
        return {"ok": False, "exit_code": code, "rows": []}
    holders: Dict[int, Dict[str, object]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5 or not parts[0].upper().startswith("TCP"):
            continue
        local, state, pid_raw = parts[1], parts[3], parts[4]
        if not pid_raw.isdigit():
            continue
        if local.rsplit(":", 1)[-1] != str(port):
            continue
        pid = int(pid_raw)
        holders.setdefault(pid, {"pid": pid, "process": _process_name(pid),
                                 "local": local, "state": state})

    rows = list(holders.values())
    if not bool(params.get("apply")):
        return {"ok": True, "applied": False, "port": port, "rows": rows}

    killed = 0
    failed = 0
    for row in rows:
        pid = int(row["pid"])
        # 别把自己和系统进程干掉。PID 0/4 是 System / Idle。
        if pid in (0, 4) or pid == os.getpid():
            row["skipped"] = True
            continue
        rc, _ = _run(["taskkill.exe", "/PID", str(pid), "/F"], timeout=20.0)
        if rc == 0:
            killed += 1
            row["killed"] = True
        else:
            failed += 1
            row["killed"] = False
    return {"ok": True, "applied": True, "port": port, "rows": rows,
            "killed": killed, "failed": failed}


HANDLERS: Dict[str, Callable[[Dict], Dict[str, object]]] = {
    "flushDns": tool_flush_dns,
    "renewIp": tool_renew_ip,
    "resetWinsock": tool_reset_winsock,
    "listPorts": tool_list_ports,
    "showHosts": tool_show_hosts,
    "networkAdapters": tool_network_adapters,
    "systemInfo": tool_system_info,
    "createRestorePoint": tool_create_restore_point,
    "hibernationStatus": tool_hibernation_status,
    "toggleHibernation": tool_toggle_hibernation,
    "restartExplorer": tool_restart_explorer,
    "clearIconCache": tool_clear_icon_cache,
    "emptyFolders": tool_empty_folders,
    "whoLocks": tool_who_locks,
    "batchRename": tool_batch_rename,
    "longPathScan": tool_long_path_scan,
    "clearClipboard": tool_clear_clipboard,
    "wipeFreeSpaceEstimate": tool_wipe_free_space_estimate,
    "powerPlans": tool_power_plans,
    "setPowerPlan": tool_set_power_plan,
    "uptimeInfo": tool_uptime_info,
    "driverList": tool_driver_list,
    "envVars": tool_env_vars,
    "sfcVerify": tool_sfc_verify,
    "firewallStatus": tool_firewall_status,
    "dnsCacheView": tool_dns_cache_view,
    "clearThumbnailCache": tool_clear_thumbnail_cache,
    "processList": tool_process_list,
    "serviceList": tool_service_list,
    "diskHealth": tool_disk_health,
    "restorePointList": tool_restore_point_list,
    "pendingReboot": tool_pending_reboot,
    "bigFileFinder": tool_big_file_finder,
    "fileHash": tool_file_hash,
    "bulkAttributes": tool_bulk_attributes,
    "brokenShortcutScan": tool_broken_shortcut_scan,
    "recycleBinStatus": tool_recycle_bin_status,
    "fileShredder": tool_file_shredder,
    "clearRecentDocs": tool_clear_recent_docs,
    "pingTest": tool_ping_test,
    "dnsServers": tool_dns_servers,
    "killPort": tool_kill_port,
}


def run_tool(tool_id: str, params: Optional[Dict] = None,
             *, data_dir=None) -> Dict[str, object]:
    """跑一个工具；`data_dir` 由后端注入以写撤销日志。
    入参部分来自渲染进程，"往哪写日志"不能由渲染层决定，所以前端传来的同名字段先无条件丢掉。
    """
    handler = HANDLERS.get(tool_id)
    if handler is None:
        return {"ok": False, "error": "pcclean.toolbox.unknownTool", "tool_id": tool_id}
    call_params = dict(params or {})
    call_params.pop("data_dir", None)
    if data_dir is not None:
        call_params["data_dir"] = str(data_dir)
    try:
        result = handler(call_params)
    except Exception as exc:
        return {"ok": False, "error": f"pcclean.toolbox.failed:{type(exc).__name__}",
                "tool_id": tool_id}
    result.setdefault("tool_id", tool_id)
    return result
