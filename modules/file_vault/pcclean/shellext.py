"""右键菜单管理：Shell 扩展、New 菜单、发送到。

来源：1. 上下文菜单处理器 (`shellex\\ContextMenuHandlers`)，Explorer 会加载其 DLL，是卡顿主因；
2. New 菜单 (`ShellNew`)；3. SendTo 文件夹（纯快捷方式，最安全）。
只禁用不删除：注册表键名加前缀 `-`（Windows 认的禁用约定），还原时去掉。
"""

from __future__ import annotations

import os
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

DISABLED_PREFIX = "-"

# 挂上下文菜单的几个根位置。`*` 是"所有文件"，Directory 是文件夹，
# Directory\Background 是在空白处点右键，Drive 是盘符。
_CONTEXT_ROOTS: Sequence[Tuple[str, str]] = (
    (r"*\shellex\ContextMenuHandlers", "allFiles"),
    (r"AllFilesystemObjects\shellex\ContextMenuHandlers", "allObjects"),
    (r"Directory\shellex\ContextMenuHandlers", "directory"),
    (r"Directory\Background\shellex\ContextMenuHandlers", "directoryBackground"),
    (r"Drive\shellex\ContextMenuHandlers", "drive"),
    (r"Folder\shellex\ContextMenuHandlers", "folder"),
    (r"LibraryFolder\background\shellex\ContextMenuHandlers", "libraryBackground"),
)

# 直接挂在 shell 下的动词（不是 COM 处理器，是简单的命令行项）。
_VERB_ROOTS: Sequence[Tuple[str, str]] = (
    (r"*\shell", "allFilesVerb"),
    (r"Directory\shell", "directoryVerb"),
    (r"Directory\Background\shell", "directoryBackgroundVerb"),
)

# 这些右键项是 Windows 自己的，删了会掉系统功能。
_CRITICAL_HANDLERS = {
    "open with", "打开方式", "sharing", "共享", "ewsl",
    "sendto", "发送到", "cortana", "modernsharing", "compatibility",
    "library location", "restore previous versions", "还原以前的版本",
    "workfolders", "windows.share", "windows.modernshare",
    "pintostartscreen", "pintohome", "shellhwdetection",
}


def _clsid_info(clsid: str) -> Tuple[str, str]:
    """CLSID → (显示名, DLL 路径)；否则界面只能显示一串 GUID，用户无从判断该不该禁用。"""
    if not WINREG_AVAILABLE or not clsid.startswith("{"):
        return "", ""
    name = ""
    dll = ""
    for hive in (winreg.HKEY_CLASSES_ROOT,):
        try:
            with winreg.OpenKey(hive, rf"CLSID\{clsid}", 0, winreg.KEY_READ) as key:
                try:
                    name = str(winreg.QueryValueEx(key, "")[0] or "")
                except (FileNotFoundError, OSError):
                    pass
                try:
                    with winreg.OpenKey(key, "InprocServer32", 0, winreg.KEY_READ) as srv:
                        dll = str(winreg.QueryValueEx(srv, "")[0] or "")
                except (FileNotFoundError, OSError):
                    pass
        except (FileNotFoundError, OSError, PermissionError):
            continue
    return name, dll


def _publisher_of(dll_path: str) -> str:
    """从 DLL 的版本资源里读公司名。分级引擎靠它把"这是 NVIDIA 的"
    和"这是某个不认识的东西"分开。"""
    if not dll_path or os.name != "nt":
        return ""
    expanded = os.path.expandvars(dll_path.strip('"'))
    if not os.path.exists(expanded):
        return ""
    try:
        import ctypes
        from ctypes import wintypes

        size = ctypes.windll.version.GetFileVersionInfoSizeW(expanded, None)
        if not size:
            return ""
        buf = ctypes.create_string_buffer(size)
        if not ctypes.windll.version.GetFileVersionInfoW(expanded, 0, size, buf):
            return ""
        lplp = ctypes.c_void_p()
        length = wintypes.UINT()
        # 先问语言/代码页，再按它去取 CompanyName。写死 040904b0 在
        # 非英文资源的 DLL 上取不到值（返回空，看起来像"没有签名信息"）。
        if not ctypes.windll.version.VerQueryValueW(
            buf, "\\VarFileInfo\\Translation", ctypes.byref(lplp), ctypes.byref(length)
        ):
            return ""
        codepage = ctypes.cast(lplp, ctypes.POINTER(ctypes.c_uint16))
        lang, page = codepage[0], codepage[1]
        query = f"\\StringFileInfo\\{lang:04x}{page:04x}\\CompanyName"
        if not ctypes.windll.version.VerQueryValueW(
            buf, query, ctypes.byref(lplp), ctypes.byref(length)
        ):
            return ""
        return ctypes.wstring_at(lplp, length.value).strip("\x00").strip()
    except (OSError, AttributeError, ValueError):
        return ""


def scan_context_menu(task: ScanTask, *, whitelist: Optional[Set[str]] = None) -> ScanReport:
    items: List[CleanItem] = []
    errors: List[str] = []
    seen: Set[str] = set()
    steps = 4
    # 四路来源里成功走完几路。见 `ScanTask.report` 的 `probes` 注释：
    # 注册表类扫描不经过 `paths.iter_files`，没有它就没有任何"我真的查过"的凭据。
    probed = 0
    denied = 0

    try:
        items.extend(_scan_handlers(whitelist, seen))
        probed += 1
    except Exception as exc:
        errors.append(f"contextHandlers: {type(exc).__name__}")
        denied += 1
    task.progress(1, steps)

    if not task.cancelled():
        try:
            items.extend(_scan_verbs(whitelist, seen))
            probed += 1
        except Exception as exc:
            errors.append(f"verbs: {type(exc).__name__}")
            denied += 1
    task.progress(2, steps)

    if not task.cancelled():
        try:
            items.extend(_scan_shell_new(whitelist))
            probed += 1
        except Exception as exc:
            errors.append(f"shellNew: {type(exc).__name__}")
            denied += 1
    task.progress(3, steps)

    if not task.cancelled():
        try:
            items.extend(_scan_send_to(whitelist))
            probed += 1
        except Exception as exc:
            errors.append(f"sendTo: {type(exc).__name__}")
            denied += 1
    task.progress(steps, steps)

    items.sort(key=lambda i: (-int(i.importance), i.label.lower()))
    return task.report(items, errors=errors, probes=probed, denied=denied)


def _scan_handlers(whitelist, seen: Set[str]) -> List[CleanItem]:
    items: List[CleanItem] = []
    if not WINREG_AVAILABLE:
        return items
    for subkey, scope in _CONTEXT_ROOTS:
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, subkey, 0, winreg.KEY_READ) as key:
                n_sub, _, _ = winreg.QueryInfoKey(key)
                for i in range(n_sub):
                    try:
                        child = winreg.EnumKey(key, i)
                    except OSError:
                        continue
                    disabled = child.startswith(DISABLED_PREFIX)
                    raw_name = child[1:] if disabled else child
                    clsid = ""
                    try:
                        with winreg.OpenKey(key, child, 0, winreg.KEY_READ) as sub:
                            clsid = str(winreg.QueryValueEx(sub, "")[0] or "").strip()
                    except (FileNotFoundError, OSError):
                        pass

                    friendly, dll = _clsid_info(clsid) if clsid else ("", "")
                    publisher = _publisher_of(dll)
                    display = friendly or raw_name
                    dedupe_key = f"{scope}:{raw_name}"
                    if dedupe_key in seen:
                        continue
                    seen.add(dedupe_key)

                    if raw_name.strip().lower() in _CRITICAL_HANDLERS:
                        verdict = imp.Verdict(Importance.CRITICAL,
                                              "pcclean.reason.systemCritical", raw_name)
                    else:
                        verdict = imp.classify(name=display, publisher=publisher,
                                               path=dll, whitelist=whitelist)
                    items.append(CleanItem(
                        item_id=f"shellext:handler:{scope}:{raw_name}",
                        category="contextMenu",
                        label=display,
                        path=dll or clsid,
                        importance=verdict.importance,
                        reason=(verdict.reason_key if not disabled
                                else "pcclean.contextMenu.disabledByApp"),
                        locked=verdict.locked,
                        default_selected=False,
                        detail={
                            "source": "contextMenuHandler",
                            "scope": scope,
                            "subkey": subkey,
                            "key_name": child,
                            "original_name": raw_name,
                            "clsid": clsid,
                            "dll": dll,
                            "publisher": publisher,
                            "enabled": not disabled,
                            "needs_elevation": True,
                            "evidence": verdict.evidence,
                        },
                    ))
        except (FileNotFoundError, OSError, PermissionError):
            continue
    return items


def _scan_verbs(whitelist, seen: Set[str]) -> List[CleanItem]:
    """直接挂在 shell 下的命令行动词（"用 XX 打开"这类）。"""
    items: List[CleanItem] = []
    if not WINREG_AVAILABLE:
        return items
    for subkey, scope in _VERB_ROOTS:
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, subkey, 0, winreg.KEY_READ) as key:
                n_sub, _, _ = winreg.QueryInfoKey(key)
                for i in range(n_sub):
                    try:
                        child = winreg.EnumKey(key, i)
                    except OSError:
                        continue
                    disabled = child.startswith(DISABLED_PREFIX)
                    raw_name = child[1:] if disabled else child
                    dedupe_key = f"{scope}:{raw_name}"
                    if dedupe_key in seen:
                        continue
                    seen.add(dedupe_key)

                    display = raw_name
                    command = ""
                    try:
                        with winreg.OpenKey(key, child, 0, winreg.KEY_READ) as sub:
                            try:
                                mui = str(winreg.QueryValueEx(sub, "MUIVerb")[0] or "")
                                if mui and not mui.startswith("@"):
                                    display = mui
                            except (FileNotFoundError, OSError):
                                pass
                            try:
                                with winreg.OpenKey(sub, "command", 0, winreg.KEY_READ) as cmd:
                                    command = str(winreg.QueryValueEx(cmd, "")[0] or "")
                            except (FileNotFoundError, OSError):
                                pass
                    except (FileNotFoundError, OSError):
                        pass

                    if raw_name.strip().lower() in _CRITICAL_HANDLERS:
                        verdict = imp.Verdict(Importance.CRITICAL,
                                              "pcclean.reason.systemCritical", raw_name)
                    else:
                        verdict = imp.classify_startup(name=display, command=command,
                                                       whitelist=whitelist)
                    items.append(CleanItem(
                        item_id=f"shellext:verb:{scope}:{raw_name}",
                        category="contextMenu",
                        label=display,
                        path=command,
                        importance=verdict.importance,
                        reason=(verdict.reason_key if not disabled
                                else "pcclean.contextMenu.disabledByApp"),
                        locked=verdict.locked,
                        default_selected=False,
                        detail={
                            "source": "shellVerb",
                            "scope": scope,
                            "subkey": subkey,
                            "key_name": child,
                            "original_name": raw_name,
                            "command": command,
                            "enabled": not disabled,
                            "needs_elevation": True,
                            "evidence": verdict.evidence,
                        },
                    ))
        except (FileNotFoundError, OSError, PermissionError):
            continue
    return items


def _scan_shell_new(whitelist) -> List[CleanItem]:
    """「新建」子菜单。遍历 HKCR 下所有带 ShellNew 子键的扩展名。"""
    items: List[CleanItem] = []
    if not WINREG_AVAILABLE:
        return items
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "", 0, winreg.KEY_READ) as root:
            n_sub, _, _ = winreg.QueryInfoKey(root)
            for i in range(n_sub):
                try:
                    child = winreg.EnumKey(root, i)
                except OSError:
                    continue
                if not child.startswith("."):
                    continue
                for candidate in ("ShellNew", "-ShellNew"):
                    try:
                        with winreg.OpenKey(root, rf"{child}\{candidate}", 0,
                                            winreg.KEY_READ):
                            pass
                    except (FileNotFoundError, OSError, PermissionError):
                        continue
                    disabled = candidate.startswith(DISABLED_PREFIX)
                    friendly = child
                    try:
                        with winreg.OpenKey(root, child, 0, winreg.KEY_READ) as ext:
                            progid = str(winreg.QueryValueEx(ext, "")[0] or "")
                        if progid:
                            with winreg.OpenKey(root, progid, 0, winreg.KEY_READ) as pk:
                                friendly = str(winreg.QueryValueEx(pk, "")[0] or "") or child
                    except (FileNotFoundError, OSError, PermissionError):
                        pass
                    items.append(CleanItem(
                        item_id=f"shellext:new:{child}",
                        category="contextMenu",
                        label=f"{friendly} ({child})",
                        path=rf"HKCR\{child}\ShellNew",
                        importance=Importance.OPTIONAL,
                        reason=("pcclean.contextMenu.shellNew"
                                if not disabled else "pcclean.contextMenu.disabledByApp"),
                        default_selected=False,
                        detail={
                            "source": "shellNew",
                            "extension": child,
                            "key_name": candidate,
                            "enabled": not disabled,
                            "needs_elevation": True,
                        },
                    ))
                    break
    except (FileNotFoundError, OSError, PermissionError):
        pass
    return items


def _scan_send_to(whitelist) -> List[CleanItem]:
    """「发送到」。纯快捷方式文件，最安全的一类 —— 删了只是少一个菜单项。"""
    items: List[CleanItem] = []
    roaming = paths.known("RoamingAppData")
    if roaming is None:
        return items
    send_to = roaming / "Microsoft/Windows/SendTo"
    if not paths.exists(send_to):
        return items
    try:
        entries = list(send_to.iterdir())
    except OSError:
        return items
    for entry in entries:
        if entry.name.lower() == "desktop.ini":
            continue
        disabled = entry.name.endswith(".disabled-by-tessera")
        display = entry.stem.replace(".disabled-by-tessera", "")
        items.append(CleanItem(
            item_id=f"shellext:sendto:{display}",
            category="contextMenu",
            label=display,
            path=str(entry),
            importance=Importance.OPTIONAL,
            reason=("pcclean.contextMenu.sendTo" if not disabled
                    else "pcclean.contextMenu.disabledByApp"),
            default_selected=False,
            detail={
                "source": "sendTo",
                "file": str(entry),
                "enabled": not disabled,
                "needs_elevation": False,
            },
        ))
    return items
