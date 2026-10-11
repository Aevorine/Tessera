"""唯一的「执行清理」入口 + 还原引擎；scanner 都只读，所有删/改代码集中在这里，误删只需审这一个文件。

删除方式按用户丢得起什么选：缓存/临时/日志直接删；用户自己的文件（大文件、重复、下载）进
Windows 回收站（可撤销）；注册表项、自启项、右键菜单、插件禁用 + 备份（可还原）。

每次执行顺序固定：1. 复核选中项，locked 一律拒绝；2. 需要时建还原点/导出注册表备份，
失败则整批中止；3. 逐项执行，成功后写撤销日志；4. 返回逐项结果，不汇总掩盖。
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean import importance as imp
from modules.file_vault.pcclean import paths, registry_clean, safety
from modules.file_vault.pcclean.model import CleanItem, Importance

# `safety` 反过来要用 `reversibility()`，但它是在函数体里 import 的，
# 所以这里的模块级依赖是单向的，不构成循环导入。

WINREG_AVAILABLE = False
try:  # pragma: no cover
    import winreg  # type: ignore
    WINREG_AVAILABLE = os.name == "nt"
except ImportError:  # pragma: no cover
    winreg = None  # type: ignore

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

UNDO_DIR_NAME = "pcclean_undo"
BACKUP_DIR_NAME = "pcclean_backups"

# 走回收站的类别 —— 这些是用户自己的文件
_RECYCLE_CATEGORIES = {"bigFiles", "duplicates", "downloads", "leftovers", "custom",
                       # 空目录/失效快捷方式/零字节文件在用户自己的目录里，看似无价值也照样进回收站，可撤回。
                       "emptyDirs"}
"""进回收站的类别。

`custom`（用户自定义规则）**刻意放在这一档而不是硬删除档**：内置规则是我们
审过的，用户规则不是——一条写宽了的规则匹配到的可能正是他要的文件。
硬删除快几秒，换不回删错一个文件。"""
# 直接删的类别 —— 系统产生的中间文件
_HARD_DELETE_CATEGORIES = {"junk", "browserCache"}

_BROWSER_NEVER_DELETE = {
    "login data", "login data-journal", "login data for account",
    "logins.json", "key4.db", "key3.db", "cert9.db", "signons.sqlite",
    "bookmarks", "bookmarks.bak", "places.sqlite",
}
"""**执行侧**的密码/书签黑名单。

扫描侧（`deepclean.py`）已经挡过一遍了，这里是第二道。不是冗余：条目在
扫描和执行之间要经过一次**落盘缓存往返**（`cachestore`），而那份缓存是磁盘上
一个普通 JSON 文件。任何能改到它的东西都能把 `detail.files` 换成
`["Login Data"]`，而执行侧如果只信缓存就会照删不误。

一个"清理浏览器数据"的功能把人的密码库删掉，不能用"用户自己勾的"来开脱。"""


def _pnputil_delete(published: str) -> Tuple[bool, str]:
    """删除一个驱动包，需要管理员权限，非提权返回 needs_elevation。

    `/uninstall` 会让仍在用的设备切回其他驱动，否则 pnputil 拒绝删除使用中的包。
    """
    if not published or os.name != "nt":
        return False, "pcclean.execute.unsupportedCategory"
    if not re.fullmatch(r"oem\d+\.inf", published, re.I):
        # 只接受 pnputil 自己给出的发布名格式。这个参数最终会进命令行，
        # 而它来自一份磁盘上的缓存文件——不校验就是一条注入路径。
        return False, "pcclean.execute.unknownKind"
    try:
        proc = subprocess.run(
            ["pnputil.exe", "/delete-driver", published, "/uninstall"],
            capture_output=True, timeout=180.0, creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return False, "pcclean.execute.failed"
    if proc.returncode == 0:
        return True, ""
    # 5 = ERROR_ACCESS_DENIED。走标准的"需要授权"通道，界面上会出现
    # 那张"授权并继续"的卡，而不是笼统地说"有 N 项没清掉"。
    if proc.returncode in (5, 0x80070005):
        return False, "needs_elevation"
    return False, "pcclean.execute.failed"


@dataclass
class ActionOutcome:
    item_id: str
    status: str
    """'done' | 'skipped' | 'failed'"""

    freed_bytes: int = 0
    error: str = ""
    undo_token: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "item_id": self.item_id,
            "status": self.status,
            "freed_bytes": self.freed_bytes,
            "error": self.error,
            "undo_token": self.undo_token,
        }


@dataclass
class ExecutionResult:
    session_id: str
    outcomes: List[ActionOutcome] = field(default_factory=list)
    freed_bytes: int = 0
    restore_point: Dict[str, Any] = field(default_factory=dict)
    registry_backup: Dict[str, Any] = field(default_factory=dict)
    aborted: str = ""
    """非空 = 整批中止，字符串是原因的 i18n 键。"""

    dry_run: bool = False
    """True = 这是一次干跑，`outcomes` 里全是 `preview`，磁盘上什么都没变。
    **界面必须把它显示出来**——"预演完成，释放 4.2 GB"和"清理完成，释放
    4.2 GB"长得几乎一样，分不清的话用户会以为已经清过了。"""

    free_before: int = 0
    free_after: int = 0
    """系统盘可用空间，清理前后各量一次（0 = 没量到）。

    **这是唯一一个用户能自己核对的数字。** `freed_bytes` 是我们把各项
    `size_bytes` 加起来报的，它天然偏乐观：硬链接、稀疏文件、被占用而删不掉的
    文件、回收站里只是挪了位置的东西，都会让"我们以为释放了多少"和"资源管理器
    上多出来多少"对不上。把两个数字一起摆出来，用户看一眼就知道该信哪个。

    差额可能是负的（清理期间别的程序在写盘），照实显示即可——**编一个非负数
    比显示负数更糟**，那等于告诉用户这个数字是我们捏的。
    """

    def to_dict(self) -> Dict[str, Any]:
        done = sum(1 for o in self.outcomes if o.status == "done")
        failed = sum(1 for o in self.outcomes if o.status == "failed")
        skipped = sum(1 for o in self.outcomes if o.status == "skipped")
        preview = sum(1 for o in self.outcomes if o.status == "preview")
        return {
            "session_id": self.session_id,
            "outcomes": [o.to_dict() for o in self.outcomes],
            "freed_bytes": self.freed_bytes,
            "done": done,
            "failed": failed,
            "skipped": skipped,
            "preview": preview,
            "dry_run": self.dry_run,
            "free_before": self.free_before,
            "free_after": self.free_after,
            "restore_point": self.restore_point,
            "registry_backup": self.registry_backup,
            "aborted": self.aborted,
            # 干跑不做任何事，不能按 `undo_token` 算 undoable（token 装的是可逆性等级），否则界面会出现无效的「撤销」按钮。
            "undoable": (not self.dry_run) and any(o.undo_token for o in self.outcomes),
        }


_FO_DELETE = 0x0003
_FOF_ALLOWUNDO = 0x0040
_FOF_NOCONFIRMATION = 0x0010
_FOF_NOERRORUI = 0x0400
_FOF_SILENT = 0x0004


def recycle(path: Path) -> Tuple[bool, str]:
    """把文件/目录扔进回收站，走 `SHFileOperationW`，路径必须双 NUL 结尾（NUL 列表结束符）。

    陷阱：双 NUL 字符串不能直接赋给 `c_wchar_p`，ctypes 会因嵌入 NUL 抛 ValueError，被外层
    except 接住后表现为 status=failed，所有用户文件清理都会静默失败。应开 `create_unicode_buffer`
    （自动补一个 NUL，喂 `target + "\\0"` 即得双 NUL）并按 `c_void_p` 传地址。
    """
    if os.name != "nt":
        return False, "windows_only"
    target = str(Path(path).resolve())

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", ctypes.c_void_p),
            ("wFunc", ctypes.c_uint),
            # pFrom/pTo 声明成 c_void_p 而不是 c_wchar_p：后者会在赋值时
            # 对嵌入 NUL 报错，而这个 API 的入参本来就必须带嵌入 NUL。
            ("pFrom", ctypes.c_void_p),
            ("pTo", ctypes.c_void_p),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", ctypes.c_int),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", ctypes.c_void_p),
        ]

    # 缓冲区必须在 SHFileOperationW 调用期间一直活着——直接把
    # cast(...) 的结果塞进结构体而不留引用，缓冲区可能已经被回收。
    buffer = ctypes.create_unicode_buffer(target + "\0")

    op = SHFILEOPSTRUCTW()
    op.wFunc = _FO_DELETE
    op.pFrom = ctypes.cast(buffer, ctypes.c_void_p)
    op.pTo = None
    op.fFlags = _FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_NOERRORUI | _FOF_SILENT
    try:
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    except (OSError, AttributeError, ValueError) as exc:
        return False, type(exc).__name__
    if rc != 0:
        return False, f"shfileop.{rc}"
    if op.fAnyOperationsAborted:
        return False, "aborted"
    return True, ""


def empty_recycle_bin() -> Tuple[bool, int]:
    """清空回收站，返回 (成功?, 释放字节数)。"""
    if os.name != "nt":
        return False, 0
    from modules.file_vault.pcclean.junk import _scan_recycle_bin
    from modules.file_vault.pcclean.model import ScanTask

    before = _scan_recycle_bin(ScanTask(category="junk"))
    freed = before.size_bytes if before else 0
    try:
        # SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
        rc = ctypes.windll.shell32.SHEmptyRecycleBinW(None, None, 0x0001 | 0x0002 | 0x0004)
    except (OSError, AttributeError):
        return False, 0
    # 0 = 成功；0x8000FFFF (E_UNEXPECTED) 在回收站本来就空时也会返回
    return rc == 0, freed



def _undo_dir(data_dir: Path) -> Path:
    path = Path(data_dir) / UNDO_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_journal(data_dir: Path, session_id: str, entries: List[Dict[str, Any]],
                   meta: Dict[str, Any]) -> Path:
    journal = _undo_dir(data_dir) / f"{session_id}.json"
    payload = {
        "session_id": session_id,
        "created_at": time.time(),
        "meta": meta,
        "entries": entries,
    }
    tmp = journal.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, journal)
    return journal


LAST_CLEANED_FILE_NAME = "last_cleaned.json"

# 「上次清理：3 天前」的唯一来源，放在 pcclean 数据目录与 audit.jsonl 并排；不进撤销日志，
# 因为后者按会话切分会被清掉，而它要跨会话保留。


def _last_cleaned_path(data_dir: Path) -> Path:
    return Path(data_dir) / "pcclean" / LAST_CLEANED_FILE_NAME


def iso_utc(ts: Optional[float] = None) -> str:
    """ISO8601（UTC，带 Z），前端直接喂 `new Date()`。存 UTC：文件随数据目录走，无时区标记的本地时间戳换时区会偏移。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ",
                         time.gmtime(time.time() if ts is None else ts))


def read_last_cleaned(data_dir) -> Dict[str, str]:
    """每个类别上次清理完成的时间，没清过的不在内。读不出返回空字典：纯展示字段不该让扫描失败。"""
    if not data_dir:
        return {}
    try:
        raw = json.loads(_last_cleaned_path(Path(data_dir)).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): v for k, v in raw.items() if isinstance(v, str) and v}


def record_last_cleaned(data_dir, categories: Sequence[str],
                        *, at: Optional[float] = None) -> Dict[str, str]:
    """记下这批类别的清理完成时间，返回更新后的全表。

    只记真正成功的类别（调用方按 `status == "done"` 筛）；干跑、整批中止、零成功都不留「刚清过」的印象。
    写失败不抛异常：时间戳落不了盘不能让成功的清理报失败。
    """
    wanted = sorted({str(c) for c in (categories or []) if str(c)})
    if not wanted or not data_dir:
        return {}
    stamp = iso_utc(at)
    current = read_last_cleaned(data_dir)
    for category in wanted:
        current[category] = stamp
    try:
        path = _last_cleaned_path(Path(data_dir))
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass
    return current


def list_sessions(data_dir: Path, limit: int = 20) -> List[Dict[str, Any]]:
    """列出可撤销的清理会话，最新的在前。"""
    out: List[Dict[str, Any]] = []
    try:
        files = sorted(_undo_dir(data_dir).glob("*.json"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return out
    for path in files[:limit]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        entries = data.get("entries") or []
        out.append({
            "session_id": data.get("session_id") or path.stem,
            "created_at": data.get("created_at") or path.stat().st_mtime,
            "entry_count": len(entries),
            "reversible_count": sum(1 for e in entries if e.get("reversible")),
            "meta": data.get("meta") or {},
        })
    return out



def _delete_tree_contents(root: Path, *, patterns: Sequence[str], min_age_days: float,
                          include_dirs: bool) -> Tuple[int, int, List[str]]:
    """删一个目录里符合条件的文件，返回 (释放字节, 删除数, 失败样本)。

    占用中的文件删不掉是常态（浏览器开着时缓存部分锁定），只记录不报错，否则用户会习惯忽略提示。

    `safety.PathGuard` 检查放在这个循环里，因为它是所有「整目录清空」类清理（垃圾、浏览器缓存、
    隐私痕迹）的唯一出口，新 scanner 自动受保护，不靠每个调用方记得加。具体拦的是
    `%APPDATA%\\...\\Recent\\AutomaticDestinations` 下装着「快速访问固定文件夹」的文件：它和旁边的
    最近记录长得一样，却是用户手工钉的配置，删了 Explorer 不会重建。
    """
    from fnmatch import fnmatch

    freed = 0
    removed = 0
    failures: List[str] = []
    cutoff = time.time() - min_age_days * 86400
    guard = safety.PathGuard()

    for file_path, size in paths.iter_files(root):
        if patterns and not any(fnmatch(file_path.name, p) for p in patterns):
            continue
        if guard.check(file_path):
            continue
        try:
            if min_age_days > 0 and file_path.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        try:
            file_path.unlink()
            freed += size
            removed += 1
        except OSError:
            if len(failures) < 20:
                failures.append(file_path.name)

    if include_dirs:
        # 自底向上删空目录。删不掉的（还有锁着的文件）跳过。
        for current, dirs, files in os.walk(root, topdown=False):
            if Path(current) == root:
                continue
            try:
                if not any(os.scandir(current)):
                    os.rmdir(current)
            except OSError:
                continue
    return freed, removed, failures


def _registry_delete(detail: Dict[str, Any]) -> Tuple[bool, str]:
    if not WINREG_AVAILABLE:
        return False, "windows_only"
    hive_name = str(detail.get("hive") or "")
    subkey = str(detail.get("subkey") or "")
    name = str(detail.get("name") or detail.get("value_name") or "")
    target_kind = str(detail.get("target_kind") or "value")

    hive_map = {
        "HKLM": winreg.HKEY_LOCAL_MACHINE,
        "HKCU": winreg.HKEY_CURRENT_USER,
        "HKCR": winreg.HKEY_CLASSES_ROOT,
    }
    hive = hive_map.get(hive_name)
    if hive is None or not subkey:
        return False, "bad_target"
    try:
        if target_kind == "key":
            full = f"{subkey}\\{name}" if name and not subkey.endswith(name) else subkey
            winreg.DeleteKey(hive, full)
        else:
            with winreg.OpenKey(hive, subkey, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, name)
    except FileNotFoundError:
        return True, ""  # 已经没了，当成成功
    except PermissionError:
        return False, "needs_elevation"
    except OSError as exc:
        return False, type(exc).__name__
    return True, ""



TESSERA_DELAY_TASK_PREFIX = "Tessera\\DelayedStartup\\"


def startup_delay(detail: Dict[str, Any], minutes: int) -> Tuple[bool, str, Dict[str, Any]]:
    """把自启项改成延迟启动：登录后等 N 分钟再跑。

    启动项原本只有保留/禁用两档，而拖慢开机的多是用户真要用的程序（网盘、输入法），延迟是中间选项。
    Run 键没有延迟概念，所以搬到计划任务用 `/SC ONLOGON /DELAY`，再禁用原 Run 项；必须先建任务、
    再禁 Run 项，否则任务建失败会白白禁掉用户的自启项。`minutes` 夹在 1~30：0 等于没延迟，
    超过 30 分钟用户多半已在用该程序。
    """
    if str(detail.get("source") or "") != "registry":
        # 只认 Run 键：启动文件夹快捷方式可直接挪走（已有 disable），计划任务改自己的触发器即可；
        # 不认的明确报出来，不假装做了。
        return False, "pcclean.startup.delayUnsupported", {}

    command = str(detail.get("command") or "")
    value_name = str(detail.get("value_name") or "")
    if not command or not value_name:
        return False, "bad_target", {}

    minutes = max(1, min(30, int(minutes)))
    task_name = TESSERA_DELAY_TASK_PREFIX + re.sub(r"[^\w.-]", "_", value_name)[:60]

    import subprocess
    try:
        proc = subprocess.run(
            ["schtasks.exe", "/Create", "/F", "/TN", task_name,
             "/SC", "ONLOGON", "/DELAY", "%04d:%02d" % (0, minutes),
             "/TR", command, "/RL", "LIMITED"],
            capture_output=True, timeout=30.0,
            creationflags=_CREATE_NO_WINDOW, shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, type(exc).__name__, {}
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        # 拒绝访问在这里几乎总是 HKLM 项：那条 Run 值属于所有用户，
        # 建任务要管理员。如实报 needs_elevation，让上层走统一的授权路径。
        if "denied" in err.lower() or "拒绝" in err:
            return False, "needs_elevation", {}
        return False, "pcclean.startup.delayCreateFailed", {}

    ok, err, undo = _startup_disable(detail)
    if not ok:
        # 回滚刚建的任务——留着它会让这个程序**开机跑两次**（Run 项还在，
        # 任务也在），比什么都没做更糟。
        try:
            subprocess.run(["schtasks.exe", "/Delete", "/F", "/TN", task_name],
                           capture_output=True, timeout=30.0,
                           creationflags=_CREATE_NO_WINDOW, shell=False)
        except (OSError, subprocess.SubprocessError):
            pass
        return False, err, {}

    undo["delay_task"] = task_name
    undo["source"] = "registryDelayed"
    return True, "", undo


def _startup_disable(detail: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
    """禁用一个自启项，返回 (成功?, 错误, 撤销所需信息)。"""
    source = str(detail.get("source") or "")

    if source == "registry":
        if not WINREG_AVAILABLE:
            return False, "windows_only", {}
        hive_name = str(detail.get("hive") or "HKCU")
        subkey = str(detail.get("subkey") or "")
        value_name = str(detail.get("value_name") or "")
        command = str(detail.get("command") or "")
        hive = winreg.HKEY_LOCAL_MACHINE if hive_name == "HKLM" else winreg.HKEY_CURRENT_USER
        # 先把原值写进备份键，写成功了才删原值。顺序反过来的话，
        # 备份失败就永久丢了那条命令行。
        try:
            from modules.file_vault.pcclean.startup import TESSERA_BACKUP_KEY
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, TESSERA_BACKUP_KEY, 0,
                                    winreg.KEY_SET_VALUE) as backup:
                winreg.SetValueEx(backup, value_name, 0, winreg.REG_SZ,
                                  f"{hive_name}|{subkey}|{command}")
        except OSError as exc:
            return False, f"backup_failed.{type(exc).__name__}", {}
        try:
            with winreg.OpenKey(hive, subkey, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, value_name)
        except FileNotFoundError:
            return True, "", {"source": "registry", "value_name": value_name}
        except PermissionError:
            return False, "needs_elevation", {}
        except OSError as exc:
            return False, type(exc).__name__, {}
        return True, "", {"source": "registry", "hive": hive_name, "subkey": subkey,
                          "value_name": value_name, "command": command}

    if source == "folder":
        file_raw = str(detail.get("file") or "")
        if not file_raw:
            return False, "bad_target", {}
        src = Path(file_raw)
        dst = src.with_name(src.name + ".disabled-by-tessera")
        try:
            src.rename(dst)
        except FileNotFoundError:
            return True, "", {}
        except PermissionError:
            return False, "needs_elevation", {}
        except OSError as exc:
            return False, type(exc).__name__, {}
        return True, "", {"source": "folder", "from": str(dst), "to": str(src)}

    if source == "scheduledTask":
        task_name = str(detail.get("task_name") or "")
        if not task_name:
            return False, "bad_target", {}
        import subprocess
        try:
            proc = subprocess.run(
                ["schtasks.exe", "/Change", "/TN", task_name, "/DISABLE"],
                capture_output=True, timeout=30.0,
                creationflags=_CREATE_NO_WINDOW, shell=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, type(exc).__name__, {}
        if proc.returncode != 0:
            return False, "needs_elevation", {}
        return True, "", {"source": "scheduledTask", "task_name": task_name}

    if source == "service":
        service_name = str(detail.get("service_name") or "")
        if not service_name:
            return False, "bad_target", {}
        import subprocess
        try:
            # 改成 demand（手动）而不是 disabled：依赖它的服务还能按需拉起它，
            # 禁用则会让依赖链上的服务直接启动失败。
            proc = subprocess.run(
                ["sc.exe", "config", service_name, "start=", "demand"],
                capture_output=True, timeout=30.0,
                creationflags=_CREATE_NO_WINDOW, shell=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, type(exc).__name__, {}
        if proc.returncode != 0:
            return False, "needs_elevation", {}
        return True, "", {"source": "service", "service_name": service_name,
                          "previous_start_mode": "auto"}

    return False, "unknown_source", {}


def _shellext_disable(detail: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
    """禁用右键菜单项 —— 键名前面加 `-`（Windows 自己的禁用约定）。"""
    source = str(detail.get("source") or "")

    if source == "sendTo":
        file_raw = str(detail.get("file") or "")
        src = Path(file_raw)
        dst = src.with_name(src.name + ".disabled-by-tessera")
        try:
            src.rename(dst)
        except FileNotFoundError:
            return True, "", {}
        except OSError as exc:
            return False, type(exc).__name__, {}
        return True, "", {"source": "sendTo", "from": str(dst), "to": str(src)}

    if not WINREG_AVAILABLE:
        return False, "windows_only", {}
    subkey = str(detail.get("subkey") or "")
    key_name = str(detail.get("key_name") or "")
    if not subkey or not key_name:
        return False, "bad_target", {}
    if key_name.startswith("-"):
        return True, "", {}  # 已经是禁用状态

    new_name = "-" + key_name
    ok, err = _rename_registry_key(winreg.HKEY_CLASSES_ROOT, subkey, key_name, new_name)
    if not ok:
        return False, err, {}
    return True, "", {"source": "registryKeyRename", "subkey": subkey,
                      "from": new_name, "to": key_name}


def _rename_registry_key(hive, parent_subkey: str, old_name: str,
                         new_name: str) -> Tuple[bool, str]:
    """注册表无法重命名键，只能递归复制到新名字再删旧的。

    复制必须全部成功才删旧键；中途失败要删掉已复制的半成品，否则新旧两个键并存，右键菜单出现两份。
    """
    try:
        with winreg.OpenKey(hive, parent_subkey, 0, winreg.KEY_READ) as parent:
            try:
                with winreg.OpenKey(parent, old_name, 0, winreg.KEY_READ) as src:
                    tree = _read_key_tree(src)
            except FileNotFoundError:
                return True, ""
    except (FileNotFoundError, OSError, PermissionError) as exc:
        return False, ("needs_elevation" if isinstance(exc, PermissionError)
                       else type(exc).__name__)

    try:
        with winreg.OpenKey(hive, parent_subkey, 0, winreg.KEY_ALL_ACCESS) as parent:
            with winreg.CreateKeyEx(parent, new_name, 0, winreg.KEY_ALL_ACCESS) as dst:
                _write_key_tree(dst, tree)
    except PermissionError:
        return False, "needs_elevation"
    except OSError as exc:
        return False, type(exc).__name__

    try:
        with winreg.OpenKey(hive, parent_subkey, 0, winreg.KEY_ALL_ACCESS) as parent:
            _delete_key_tree(parent, old_name)
    except OSError as exc:
        # 新键建好了但旧键删不掉 —— 把新键撤掉，回到原状
        try:
            with winreg.OpenKey(hive, parent_subkey, 0, winreg.KEY_ALL_ACCESS) as parent:
                _delete_key_tree(parent, new_name)
        except OSError:
            pass
        return False, f"delete_old_failed.{type(exc).__name__}"
    return True, ""


def _read_key_tree(key) -> Dict[str, Any]:
    values: List[Tuple[str, Any, int]] = []
    children: Dict[str, Any] = {}
    n_sub, n_val, _ = winreg.QueryInfoKey(key)
    for i in range(n_val):
        try:
            values.append(winreg.EnumValue(key, i))
        except OSError:
            continue
    for i in range(n_sub):
        try:
            name = winreg.EnumKey(key, i)
            with winreg.OpenKey(key, name, 0, winreg.KEY_READ) as sub:
                children[name] = _read_key_tree(sub)
        except OSError:
            continue
    return {"values": values, "children": children}


def _write_key_tree(key, tree: Dict[str, Any]) -> None:
    for name, data, value_type in tree.get("values", []):
        try:
            winreg.SetValueEx(key, name, 0, value_type, data)
        except OSError:
            continue
    for name, child in (tree.get("children") or {}).items():
        try:
            with winreg.CreateKeyEx(key, name, 0, winreg.KEY_ALL_ACCESS) as sub:
                _write_key_tree(sub, child)
        except OSError:
            continue


def _delete_key_tree(parent, name: str) -> None:
    try:
        with winreg.OpenKey(parent, name, 0, winreg.KEY_ALL_ACCESS) as key:
            while True:
                try:
                    child = winreg.EnumKey(key, 0)
                except OSError:
                    break
                _delete_key_tree(key, child)
    except FileNotFoundError:
        return
    winreg.DeleteKey(parent, name)



def reversibility(item: CleanItem) -> str:
    """这一项删了之后能否拿回来，返回 `recycle`（回收站）/ `restorable`（有 .reg 备份和撤销日志）/
    `permanent`（缓存、临时文件、WinSxS 等真删）。

    判据必须与 `_execute_one` 的分支同源，否则预演屏会撒谎；守卫见
    `tests/test_pcclean_actions.py::test_reversibility_matches_execute_branches`。
    """
    if item.category in _RECYCLE_CATEGORIES:
        return "recycle"
    if item.category in _HARD_DELETE_CATEGORIES:
        return "permanent"
    # `popupSources` 的执行分支与 `startup` 相同（`_startup_disable`，撤销日志 reversible: True），
    # 必须列入此表，否则本函数与执行分支分叉，把可撤销操作报成 permanent。
    if item.category in ("registry", "startup", "popupSources",
                         "contextMenu", "plugins"):
        return "restorable"
    if item.category in ("privacy", "diskSlimming", "browserData", "driverStore"):
        # `browserData` / `driverStore` 都是**真的撤不回来**：Cookie 删了要
        # 重新登录，驱动包删了要重装。它们进这一档不是保守，是事实。
        return "permanent"
    return "permanent"


def _needs_restore_point(approved: Sequence[CleanItem]) -> str:
    """要不要建系统还原点，返回原因的 i18n 键，空串 = 不需要。

    先看可逆性：批次里只要有撤不回来的系统级改动就建点，还原点成本（几秒 + 几百 MB）远小于注册表改坏开不了机。
    """
    if any(i.category in ("registry", "startup", "contextMenu") for i in approved):
        return "pcclean.restorePoint.reasonSystemChange"
    if any(i.category in ("software", "diskSlimming") for i in approved):
        return "pcclean.restorePoint.reasonSoftware"
    if any(reversibility(i) == "permanent" and i.importance <= Importance.DRIVER
           for i in approved):
        return "pcclean.restorePoint.reasonImportantPermanent"
    return ""


def execute(
    data_dir: Path,
    items: Sequence[CleanItem],
    *,
    create_restore_point: bool = True,
    dry_run: bool = False,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> ExecutionResult:
    """执行一批清理。`items` 必须是后端重新扫描后的对象，不是前端传来的 JSON。

    前端结果可能已过期，且其 `locked` / `importance` 是不可信输入，不能把安全判断交给渲染进程。
    `dry_run=True` 走完全相同的前两关（锁死项、白名单），但不动任何字节，每项产出
    `status="preview"` 并带上将发生什么、是否可逆；必须复用同一路径，另写模拟迟早分叉。
    """
    session_id = uuid.uuid4().hex[:16]
    result = ExecutionResult(session_id=session_id)
    result.dry_run = dry_run
    whitelist = imp.load_whitelist(data_dir)
    journal_entries: List[Dict[str, Any]] = []

    # --- 第 1 关：锁死项一律拒绝 -----------------------------------------
    approved: List[CleanItem] = []
    for item in items:
        if item.locked or item.importance == Importance.CRITICAL:
            result.outcomes.append(ActionOutcome(
                item.item_id, "skipped", error="pcclean.execute.lockedItem"))
            continue
        if imp._in_whitelist(whitelist, item.label, item.path):
            result.outcomes.append(ActionOutcome(
                item.item_id, "skipped", error="pcclean.execute.whitelisted"))
            continue
        approved.append(item)

    if not approved:
        return result

    restore_point_reason = _needs_restore_point(approved)

    # --- 干跑到此为止：报告将会发生什么，然后原样返回 ---------------------
    if dry_run:
        for item in approved:
            result.outcomes.append(ActionOutcome(
                item.item_id, "preview", freed_bytes=item.size_bytes,
                undo_token=reversibility(item)))
        result.freed_bytes = sum(i.size_bytes for i in approved)
        result.restore_point = {"planned": bool(restore_point_reason),
                                "reason": restore_point_reason}
        return result

    # --- 第 2 关：备份。失败就整批中止 -----------------------------------
    needs_registry_backup = any(
        i.category in ("registry", "startup", "contextMenu", "plugins") for i in approved
    )
    needs_restore_point = create_restore_point and bool(restore_point_reason)

    if needs_restore_point:
        from modules.file_vault.pcclean import toolbox
        rp = toolbox.tool_create_restore_point({"label": f"Tessera Clean {session_id[:8]}"})
        rp["reason"] = restore_point_reason
        result.restore_point = rp
        # 还原点建不出来**不中止** —— 它只是额外保险，而且在很多机器上
        # 系统保护本来就是关的。真正的保证是下面那份注册表备份。

    if needs_registry_backup:
        backup_dir = Path(data_dir) / BACKUP_DIR_NAME
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"{session_id}.reg"
        registry_items = [i for i in approved
                          if i.category == "registry" and i.detail.get("hive")]
        if registry_items:
            outcome = registry_clean.export_backup(registry_items, backup_path)
            result.registry_backup = outcome
            if not outcome.get("ok"):
                result.aborted = "pcclean.execute.backupFailed"
                return result

    # --- 第 3 关：逐项执行 -----------------------------------------------
    total = len(approved)
    # 放在建还原点/导出注册表备份之后量：那些占用是本次操作的真实代价，应计入最终净变化。
    result.free_before = _system_drive_free()

    cleaned_categories: List[str] = []
    for index, item in enumerate(approved):
        outcome = _execute_one(data_dir, item, journal_entries)
        result.outcomes.append(outcome)
        if outcome.status == "done":
            result.freed_bytes += outcome.freed_bytes
            if item.category not in cleaned_categories:
                cleaned_categories.append(item.category)
        if on_progress:
            on_progress(index + 1, total)

    result.free_after = _system_drive_free()
    # "上次清理时间"只认真的清成功了的类别。全部失败/跳过的一批
    # 在界面上标成"刚清过"，下一次用户就不会再点它了。
    record_last_cleaned(data_dir, cleaned_categories)

    # --- 第 4 关：写撤销日志 ---------------------------------------------
    if journal_entries:
        _write_journal(data_dir, session_id, journal_entries, {
            "restore_point": result.restore_point,
            "registry_backup": result.registry_backup,
            "freed_bytes": result.freed_bytes,
        })
    _append_audit(data_dir, result, approved)
    return result


def _system_drive_free() -> int:
    """系统盘可用字节数，量不到返回 0，绝不猜（0 在界面上表示没量到并隐藏，猜的数会被拿去相减）。

    直接用 `GetDiskFreeSpaceExW`，不复用 space.py 的 `_disk_space`，免得执行与扫描两条路径互相绑定。
    """
    try:
        import ctypes
        from ctypes import wintypes

        drive = paths.system_drive() + "\\"
        free = ctypes.c_ulonglong(0)
        ok = ctypes.windll.kernel32.GetDiskFreeSpaceExW(
            wintypes.LPCWSTR(drive), ctypes.byref(free), None, None)
        return int(free.value) if ok else 0
    except Exception:
        return 0


AUDIT_FILE_NAME = "audit.jsonl"

_AUDIT_MAX_LINES = 2000
"""留多少条。清理这件事出问题往往几周后才发现（"我那个文件呢？"），
留太少等于没有；留太多会让这个文件本身变成需要清理的垃圾。"""


def _append_audit(data_dir: Path, result: ExecutionResult,
                  approved: Sequence[CleanItem]) -> None:
    """每执行一批追加一行审计，只记本地，永不上传。

    只记类别、条数、字节数、可逆性、会话 id，不记完整路径（路径清单泄露比被保护的东西更敏感）；
    要追具体记录用 session_id 查撤销日志。吞掉所有异常：审计写不进不能让成功的清理报失败。
    """
    try:
        by_category: Dict[str, int] = {}
        by_reversibility: Dict[str, int] = {}
        for item in approved:
            by_category[item.category] = by_category.get(item.category, 0) + 1
            key = reversibility(item)
            by_reversibility[key] = by_reversibility.get(key, 0) + 1

        summary = result.to_dict()
        line = json.dumps({
            "ts": int(time.time()),
            "session_id": result.session_id,
            "done": summary.get("done", 0),
            "failed": summary.get("failed", 0),
            "skipped": summary.get("skipped", 0),
            "freed_bytes": result.freed_bytes,
            # 也记进审计：`freed_bytes` 是我们估的，这两个是系统给的。
            # 想回头核对"上个月那次清理到底管不管用"，只有这两个数说了算。
            "free_before": result.free_before,
            "free_after": result.free_after,
            "by_category": by_category,
            "by_reversibility": by_reversibility,
            "restore_point": bool((result.restore_point or {}).get("ok")),
            "aborted": result.aborted,
        }, ensure_ascii=False)

        path = Path(data_dir) / "pcclean" / AUDIT_FILE_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        _trim_audit(path)
    except Exception:
        pass


def _trim_audit(path: Path) -> None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            lines = handle.readlines()
        if len(lines) <= _AUDIT_MAX_LINES:
            return
        with path.open("w", encoding="utf-8") as handle:
            handle.writelines(lines[-_AUDIT_MAX_LINES:])
    except Exception:
        pass


def read_audit(data_dir: Path, limit: int = 200) -> List[Dict[str, Any]]:
    """读回审计记录，最新的在前。"""
    path = Path(data_dir) / "pcclean" / AUDIT_FILE_NAME
    out: List[Dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entry = json.loads(raw)
                except ValueError:
                    # 一行坏掉不该让整份日志读不出来。
                    continue
                if isinstance(entry, dict):
                    out.append(entry)
    except FileNotFoundError:
        return []
    except Exception:
        return out[-limit:][::-1]
    return out[-limit:][::-1]


def delete_audit(data_dir: Path, session_ids: Sequence[str]) -> int:
    """按 session_id 删若干条清理记录，返回实际删除条数。

    JSONL 不能原地删行，整份重写（封顶 2000 行）；先写临时文件再原子替换，避免断电留下半份日志。
    只删审计行，不动撤销日志，否则丢掉该批文件的还原能力。
    """
    wanted = {str(sid) for sid in (session_ids or []) if str(sid)}
    if not wanted:
        return 0
    path = Path(data_dir) / "pcclean" / AUDIT_FILE_NAME
    removed = 0
    try:
        with path.open("r", encoding="utf-8") as handle:
            lines = handle.readlines()
    except FileNotFoundError:
        return 0
    except OSError:
        return 0

    kept: List[str] = []
    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except ValueError:
            # 读不懂的行原样留着：它不是用户点选的那条，没有理由替他删。
            kept.append(stripped + "\n")
            continue
        if isinstance(entry, dict) and str(entry.get("session_id") or "") in wanted:
            removed += 1
            continue
        kept.append(stripped + "\n")

    if removed == 0:
        return 0
    try:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            handle.writelines(kept)
        os.replace(tmp, path)
    except OSError:
        return 0
    return removed


def clear_audit(data_dir: Path) -> int:
    """清空全部清理记录，返回删掉的条数。"""
    path = Path(data_dir) / "pcclean" / AUDIT_FILE_NAME
    try:
        with path.open("r", encoding="utf-8") as handle:
            count = sum(1 for raw in handle if raw.strip())
    except FileNotFoundError:
        return 0
    except OSError:
        return 0
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return 0
    return count


# 删之前必须确认宿主进程没在跑的类别。部分成功比整体失败更糟：浏览器开着时 SQLite 库和扩展目录
# 被独占，删一半会留下半残 Profile（扩展加载不了、历史库损坏），用户看不出与清理的关联。
# `junk` / `browserCache` 刻意不在表里：纯缓存删一半只是少省点空间，会自动重建，不值得逼用户关浏览器。
_NEEDS_BROWSER_CLOSED = {"browserData", "plugins", "privacy"}


def _blocking_process(item: CleanItem) -> str:
    """挡着这一项的进程名，空串 = 可以动手。"""
    if item.category not in _NEEDS_BROWSER_CLOSED:
        return ""
    detail = item.detail or {}
    label = str(detail.get("browser") or "")
    if not label:
        # `privacy` 里绝大多数条目（注册表 MRU、Recent 目录）跟浏览器无关，
        # 它们没有 `browser` 字段，走到这里就该放行。
        return ""
    from modules.file_vault.pcclean import processes

    return processes.browser_running(label)


def _execute_one(data_dir: Path, item: CleanItem,
                 journal: List[Dict[str, Any]]) -> ActionOutcome:
    category = item.category
    detail = item.detail or {}

    try:
        blocker = _blocking_process(item)
        if blocker:
            # 报 `skipped` 而非 `failed`：这是「先关掉它再来」的待办，不是故障，归 failed 会让正常清理像出错。
            return ActionOutcome(item.item_id, "skipped",
                                 error=f"pcclean.execute.closeFirst:{blocker}")
        # 回收站类：用户自己的文件
        if category in _RECYCLE_CATEGORIES:
            target = Path(item.path)
            if not target.exists():
                return ActionOutcome(item.item_id, "skipped",
                                     error="pcclean.execute.gone")
            size = item.size_bytes
            ok, err = recycle(target)
            if not ok:
                return ActionOutcome(item.item_id, "failed", error=err)
            journal.append({"kind": "recycled", "path": str(target),
                            "item_id": item.item_id, "reversible": True,
                            "note": "restore_from_recycle_bin"})
            return ActionOutcome(item.item_id, "done", freed_bytes=size,
                                 undo_token="recycle_bin")

        # 硬删类：系统产生的缓存和临时文件
        if category in _HARD_DELETE_CATEGORIES:
            if detail.get("special") == "recycle_bin":
                ok, freed = empty_recycle_bin()
                if not ok:
                    return ActionOutcome(item.item_id, "failed",
                                         error="pcclean.execute.emptyRecycleFailed")
                journal.append({"kind": "emptied_recycle_bin", "item_id": item.item_id,
                                "reversible": False})
                return ActionOutcome(item.item_id, "done", freed_bytes=freed)

            roots: List[Path] = []
            if category == "browserCache":
                base = Path(item.path)
                for sub in detail.get("subdirs") or []:
                    for profile in base.glob("*"):
                        candidate = profile / sub
                        if candidate.exists():
                            roots.append(candidate)
                if not roots and base.exists():
                    roots.append(base)
            else:
                roots = [Path(item.path)] if item.path else []

            freed_total = 0
            removed_total = 0
            failures: List[str] = []
            for root in roots:
                if not root.exists():
                    continue
                freed, removed, fails = _delete_tree_contents(
                    root,
                    patterns=tuple(detail.get("patterns") or ()),
                    min_age_days=float(detail.get("min_age_days") or 0),
                    include_dirs=bool(detail.get("include_dirs", True)),
                )
                freed_total += freed
                removed_total += removed
                failures.extend(fails)
            journal.append({"kind": "hard_deleted", "path": item.path,
                            "item_id": item.item_id, "reversible": False,
                            "removed": removed_total, "freed_bytes": freed_total})
            if removed_total == 0 and failures:
                return ActionOutcome(item.item_id, "failed",
                                     error="pcclean.execute.allLocked")
            return ActionOutcome(item.item_id, "done", freed_bytes=freed_total)

        # 浏览器分项数据（Cookie / 历史 / 表单 / 站点数据）逐文件删，不用 `_delete_tree_contents`：
        # 这类的 `path` 是 Profile 目录本身，整棵删会毁掉浏览器配置。具体文件在 `detail.files`（扫描时已过黑名单）。
        if category == "browserData":
            freed = 0
            removed = 0
            base = Path(item.path)
            for rel in detail.get("files") or []:
                candidate = base / str(rel)
                # 第二道黑名单。扫描时已经过过一次，这里再过一次是因为
                # **条目会经过落盘缓存往返**，而缓存文件是可以被改的。
                if candidate.name.lower() in _BROWSER_NEVER_DELETE:
                    continue
                # 已安装应用的宿主目录（`Web Applications`）不在上面那张
                # 密码/书签黑名单里，但它同样是"删了用户会发现应用没了"。
                if safety.protection_reason(str(candidate)):
                    continue
                try:
                    if candidate.is_file():
                        freed += candidate.stat().st_size
                        candidate.unlink()
                        removed += 1
                    elif candidate.is_dir():
                        size, _ = paths.dir_size(candidate)
                        shutil.rmtree(candidate, ignore_errors=True)
                        freed += size
                        removed += 1
                except OSError:
                    continue
            journal.append({"kind": "hard_deleted", "path": item.path,
                            "item_id": item.item_id, "reversible": False,
                            "removed": removed, "freed_bytes": freed})
            if removed == 0:
                # 一个都没删掉，最常见的原因是浏览器正开着，文件被锁。
                return ActionOutcome(item.item_id, "failed",
                                     error="pcclean.execute.browserRunning")
            return ActionOutcome(item.item_id, "done", freed_bytes=freed)

        # 旧版驱动包只能走 pnputil，不能直接删 FileRepository：该目录有 TrustedInstaller ACL，
        # 硬删会失败或使驱动数据库不一致（下次装驱动才炸）。
        if category == "driverStore":
            published = str(detail.get("published") or "")
            if not published:
                return ActionOutcome(item.item_id, "skipped",
                                     error="pcclean.execute.unknownKind")
            ok, err = _pnputil_delete(published)
            if not ok:
                return ActionOutcome(item.item_id, "failed", error=err)
            journal.append({"kind": "driver_removed", "published": published,
                            "item_id": item.item_id, "reversible": False,
                            "freed_bytes": item.size_bytes})
            return ActionOutcome(item.item_id, "done", freed_bytes=item.size_bytes)

        # 隐私痕迹
        if category == "privacy":
            kind = str(detail.get("kind") or "")
            if kind == "files":
                freed, removed, _ = _delete_tree_contents(
                    Path(item.path), patterns=(), min_age_days=0, include_dirs=False)
                journal.append({"kind": "hard_deleted", "path": item.path,
                                "item_id": item.item_id, "reversible": False})
                return ActionOutcome(item.item_id, "done", freed_bytes=freed)
            if kind == "registry":
                ok, err = _clear_registry_values(item.path, detail)
                if not ok:
                    return ActionOutcome(item.item_id, "failed", error=err)
                journal.append({"kind": "registry_cleared", "path": item.path,
                                "item_id": item.item_id, "reversible": False})
                return ActionOutcome(item.item_id, "done")
            if kind == "browser":
                freed = 0
                base = Path(item.path)
                for filename in detail.get("files") or []:
                    candidate = base / str(filename)
                    try:
                        if candidate.is_file():
                            freed += candidate.stat().st_size
                            candidate.unlink()
                        elif candidate.is_dir():
                            size, _ = paths.dir_size(candidate)
                            shutil.rmtree(candidate, ignore_errors=True)
                            freed += size
                    except OSError:
                        continue
                journal.append({"kind": "hard_deleted", "path": item.path,
                                "item_id": item.item_id, "reversible": False})
                return ActionOutcome(item.item_id, "done", freed_bytes=freed)
            return ActionOutcome(item.item_id, "skipped", error="pcclean.execute.unknownKind")

        # 注册表
        if category == "registry":
            ok, err = _registry_delete(detail)
            if not ok:
                return ActionOutcome(item.item_id, "failed", error=err)
            journal.append({"kind": "registry_deleted", "detail": detail,
                            "item_id": item.item_id, "reversible": True,
                            "note": "restore_from_reg_backup"})
            return ActionOutcome(item.item_id, "done", undo_token="registry_backup")

        # 自启项 / 弹窗源头
        if category in ("startup", "popupSources"):
            ok, err, undo = _startup_disable(detail)
            if not ok:
                return ActionOutcome(item.item_id, "failed", error=err)
            journal.append({"kind": "startup_disabled", "undo": undo,
                            "item_id": item.item_id, "reversible": True})
            return ActionOutcome(item.item_id, "done", undo_token="startup")

        # 右键菜单 / 插件
        if category in ("contextMenu", "plugins"):
            if category == "plugins" and detail.get("kind") == "browserExtension":
                target = Path(item.path)
                if not target.exists():
                    return ActionOutcome(item.item_id, "skipped",
                                         error="pcclean.execute.gone")
                size = item.size_bytes
                ok, err = recycle(target)
                if not ok:
                    return ActionOutcome(item.item_id, "failed", error=err)
                journal.append({"kind": "recycled", "path": str(target),
                                "item_id": item.item_id, "reversible": True})
                return ActionOutcome(item.item_id, "done", freed_bytes=size,
                                     undo_token="recycle_bin")
            ok, err, undo = _shellext_disable(detail)
            if not ok:
                return ActionOutcome(item.item_id, "failed", error=err)
            journal.append({"kind": "shellext_disabled", "undo": undo,
                            "item_id": item.item_id, "reversible": True})
            return ActionOutcome(item.item_id, "done", undo_token="shellext")

        return ActionOutcome(item.item_id, "skipped",
                             error="pcclean.execute.unsupportedCategory")

    except PermissionError:
        return ActionOutcome(item.item_id, "failed", error="needs_elevation")
    except Exception as exc:
        return ActionOutcome(item.item_id, "failed", error=type(exc).__name__)


def _clear_registry_values(display_path: str, detail: Dict[str, Any]) -> Tuple[bool, str]:
    """清空一个 MRU 键下的值，**保留键本身**（见 privacy.PrivacyRule.values_only）。"""
    if not WINREG_AVAILABLE:
        return False, "windows_only"
    subkey = display_path.split("\\", 1)[1] if "\\" in display_path else display_path
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey, 0,
                            winreg.KEY_ALL_ACCESS) as key:
            _, n_val, _ = winreg.QueryInfoKey(key)
            names = []
            for i in range(n_val):
                try:
                    names.append(winreg.EnumValue(key, i)[0])
                except OSError:
                    continue
            for name in names:
                if not name:
                    continue  # 保留默认值
                try:
                    winreg.DeleteValue(key, name)
                except OSError:
                    continue
            if not detail.get("values_only", True):
                while True:
                    try:
                        child = winreg.EnumKey(key, 0)
                    except OSError:
                        break
                    try:
                        _delete_key_tree(key, child)
                    except OSError:
                        break
    except FileNotFoundError:
        return True, ""
    except PermissionError:
        return False, "needs_elevation"
    except OSError as exc:
        return False, type(exc).__name__
    return True, ""



def undo(data_dir: Path, session_id: str) -> Dict[str, Any]:
    """撤销一次清理会话里所有可逆的部分，不可逆的（已删缓存）明确报出，不假装全部还原。"""
    journal = _undo_dir(data_dir) / f"{session_id}.json"
    if not journal.exists():
        return {"ok": False, "error": "pcclean.undo.sessionNotFound"}
    try:
        data = json.loads(journal.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": False, "error": "pcclean.undo.journalUnreadable"}

    restored = 0
    failed: List[Dict[str, str]] = []
    irreversible = 0

    for entry in reversed(data.get("entries") or []):
        kind = str(entry.get("kind") or "")
        if not entry.get("reversible"):
            irreversible += 1
            continue
        try:
            if kind == "startup_disabled":
                ok = _undo_startup(entry.get("undo") or {})
            elif kind == "shellext_disabled":
                ok = _undo_shellext(entry.get("undo") or {})
            elif kind == "recycled":
                # 回收站里的东西由用户在 Windows 回收站还原：Windows 没有按路径还原的公开 API，且回收站可能已清空。
                ok = False
                failed.append({"item_id": str(entry.get("item_id") or ""),
                               "error": "pcclean.undo.useRecycleBin"})
                continue
            elif kind == "registry_deleted":
                ok = False
                failed.append({"item_id": str(entry.get("item_id") or ""),
                               "error": "pcclean.undo.importRegBackup"})
                continue
            else:
                ok = False
            if ok:
                restored += 1
            else:
                failed.append({"item_id": str(entry.get("item_id") or ""),
                               "error": "pcclean.undo.failed"})
        except Exception as exc:
            failed.append({"item_id": str(entry.get("item_id") or ""),
                           "error": type(exc).__name__})

    meta = data.get("meta") or {}
    return {
        "ok": restored > 0 or not failed,
        "session_id": session_id,
        "restored": restored,
        "failed": failed,
        "irreversible": irreversible,
        "registry_backup_path": (meta.get("registry_backup") or {}).get("path", ""),
    }


def _undo_startup(undo_info: Dict[str, Any]) -> bool:
    source = str(undo_info.get("source") or "")
    if source == "registry" and WINREG_AVAILABLE:
        hive_name = str(undo_info.get("hive") or "HKCU")
        subkey = str(undo_info.get("subkey") or "")
        value_name = str(undo_info.get("value_name") or "")
        command = str(undo_info.get("command") or "")
        hive = winreg.HKEY_LOCAL_MACHINE if hive_name == "HKLM" else winreg.HKEY_CURRENT_USER
        try:
            with winreg.CreateKeyEx(hive, subkey, 0, winreg.KEY_SET_VALUE) as key:
                winreg.SetValueEx(key, value_name, 0, winreg.REG_SZ, command)
            from modules.file_vault.pcclean.startup import TESSERA_BACKUP_KEY
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, TESSERA_BACKUP_KEY, 0,
                                winreg.KEY_SET_VALUE) as backup:
                try:
                    winreg.DeleteValue(backup, value_name)
                except OSError:
                    pass
        except OSError:
            return False
        return True
    if source == "registryDelayed":
        # 撤销延迟启动 = 删掉计划任务 + 把 Run 项写回去。**两件都要做完**：
        # 只删任务的话程序开机不起了；只恢复 Run 项的话它会跑两次。
        import subprocess
        task_name = str(undo_info.get("delay_task") or "")
        deleted = True
        if task_name:
            try:
                proc = subprocess.run(
                    ["schtasks.exe", "/Delete", "/F", "/TN", task_name],
                    capture_output=True, timeout=30.0,
                    creationflags=_CREATE_NO_WINDOW, shell=False)
                deleted = proc.returncode == 0
            except (OSError, subprocess.SubprocessError):
                deleted = False
        restored = _undo_startup({**undo_info, "source": "registry"})
        return deleted and restored

    if source in ("folder", "sendTo"):
        try:
            Path(str(undo_info.get("from"))).rename(Path(str(undo_info.get("to"))))
        except OSError:
            return False
        return True
    if source == "scheduledTask":
        import subprocess
        try:
            proc = subprocess.run(
                ["schtasks.exe", "/Change", "/TN", str(undo_info.get("task_name")), "/ENABLE"],
                capture_output=True, timeout=30.0,
                creationflags=_CREATE_NO_WINDOW, shell=False,
            )
            return proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False
    if source == "service":
        import subprocess
        try:
            proc = subprocess.run(
                ["sc.exe", "config", str(undo_info.get("service_name")), "start=", "auto"],
                capture_output=True, timeout=30.0,
                creationflags=_CREATE_NO_WINDOW, shell=False,
            )
            return proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False
    return False


def _undo_shellext(undo_info: Dict[str, Any]) -> bool:
    source = str(undo_info.get("source") or "")
    if source == "sendTo":
        try:
            Path(str(undo_info.get("from"))).rename(Path(str(undo_info.get("to"))))
        except OSError:
            return False
        return True
    if source == "registryKeyRename" and WINREG_AVAILABLE:
        ok, _ = _rename_registry_key(
            winreg.HKEY_CLASSES_ROOT,
            str(undo_info.get("subkey") or ""),
            str(undo_info.get("from") or ""),
            str(undo_info.get("to") or ""),
        )
        return ok
    return False
