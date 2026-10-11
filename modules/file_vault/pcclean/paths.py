"""Windows 已知目录解析 + 安全的目录遍历。

不硬拼 `C:\\Users\\<name>\\AppData`：中文版、用户目录迁盘、OneDrive 重定向下会落空，
表现为"扫出 0 条"而被当成干净。先走环境变量 + SHGetKnownFolderPath，都失败才拼路径并记入 errors。
"""

from __future__ import annotations

import ctypes
import os
import threading
from ctypes import wintypes
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

IS_WINDOWS = os.name == "nt"


# 扫描证据计数器：区分"扫出 0 项"和"一个目录都没打开过"（如 WinError 5 被 except 吞掉）。
# 每次遍历记进入目录数、文件数、被拒次数，报告层原样交给界面。
# 用 thread-local：8 个 scanner 在各自线程跑（`service.py`），共用计数器会互相污染。

_scan_stats = threading.local()


def reset_scan_stats() -> None:
    """把本线程的计数器归零。`ScanTask` 构造时调一次。"""
    _scan_stats.dirs = 0
    _scan_stats.files = 0
    _scan_stats.denied = 0


def bump_scan_stat(field: str, n: int = 1) -> None:
    """给不走 `iter_files` 的 scanner（注册表、WMI、命令行）用的手工打点。"""
    setattr(_scan_stats, field, int(getattr(_scan_stats, field, 0)) + n)


def scan_stats() -> Dict[str, int]:
    return {
        "dirs": int(getattr(_scan_stats, "dirs", 0)),
        "files": int(getattr(_scan_stats, "files", 0)),
        "denied": int(getattr(_scan_stats, "denied", 0)),
    }


# KNOWNFOLDERID。只列真正用得上的几个，全表有一百多个。
_FOLDERID = {
    "LocalAppData": "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}",
    "RoamingAppData": "{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}",
    "ProgramData": "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}",
    "Downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
    "Documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
    "Desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "Recent": "{AE50C081-EBD2-438A-8655-8A092E34987A}",
    "Startup": "{B97D20BB-F46A-4C97-BA10-5E3608430854}",
    "CommonStartup": "{82A5EA35-D9CD-47C5-9629-E15D2F714E6E}",
    "Windows": "{F38BF404-1D43-42F2-9305-67DE0B28FC23}",
    "System": "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}",
    "ProgramFiles": "{905e63b6-c1bf-494e-b29c-65b732d3d21a}",
    "ProgramFilesX86": "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}",
    "Temp": "",  # 没有 KNOWNFOLDERID，只能走环境变量
}

_ENV_FALLBACK = {
    "LocalAppData": "LOCALAPPDATA",
    "RoamingAppData": "APPDATA",
    "ProgramData": "PROGRAMDATA",
    "Windows": "SystemRoot",
    "Temp": "TEMP",
    "ProgramFiles": "ProgramFiles",
    "ProgramFilesX86": "ProgramFiles(x86)",
}

_cache: Dict[str, Optional[Path]] = {}


def exists(path: Optional[Path]) -> bool:
    """`Path.exists()` 的安全版：Windows 上无权限目录会抛 PermissionError (WinError 5) 而非返回 False。

    异常若被外层 `except Exception` 吞掉，该清理规则会静默返回空，扫描却报成功。
    """
    if path is None:
        return False
    try:
        return path.exists()
    except (OSError, PermissionError, ValueError):
        return False


def _shell_known_folder(guid: str) -> Optional[Path]:
    if not IS_WINDOWS or not guid:
        return None
    try:
        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        clsid = GUID()
        if ctypes.windll.ole32.CLSIDFromString(ctypes.c_wchar_p(guid), ctypes.byref(clsid)) != 0:
            return None
        out = ctypes.c_wchar_p()
        # dwFlags=0, hToken=None → 当前用户
        hr = ctypes.windll.shell32.SHGetKnownFolderPath(
            ctypes.byref(clsid), 0, None, ctypes.byref(out)
        )
        if hr != 0 or not out.value:
            return None
        value = out.value
        ctypes.windll.ole32.CoTaskMemFree(out)
        return Path(value)
    except (OSError, AttributeError, ValueError):
        return None


def known(name: str) -> Optional[Path]:
    """解析一个已知目录。解析不出来返回 None —— 调用方必须处理 None，
    绝不能拿一个拼出来的假路径继续走。"""
    if name in _cache:
        return _cache[name]

    result: Optional[Path] = None
    guid = _FOLDERID.get(name)
    if guid:
        result = _shell_known_folder(guid)
    if result is None:
        env = _ENV_FALLBACK.get(name)
        if env:
            raw = os.environ.get(env)
            if raw:
                result = Path(raw)
    if result is not None and not exists(result):
        result = None
    _cache[name] = result
    return result


def user_profile() -> Optional[Path]:
    raw = os.environ.get("USERPROFILE")
    return Path(raw) if raw and Path(raw).exists() else None


def system_drive() -> str:
    return os.environ.get("SystemDrive", "C:")


def browser_profile_roots() -> List[Tuple[str, Path]]:
    """列出本机已装浏览器及配置目录 (显示名, 目录)；只返回真实存在的，避免"Chrome 缓存 0 字节"误导。"""
    out: List[Tuple[str, Path]] = []
    local = known("LocalAppData")
    roaming = known("RoamingAppData")

    chromium_like = [
        ("Google Chrome", local, "Google/Chrome/User Data"),
        ("Microsoft Edge", local, "Microsoft/Edge/User Data"),
        ("Brave", local, "BraveSoftware/Brave-Browser/User Data"),
        ("Vivaldi", local, "Vivaldi/User Data"),
        ("Opera", roaming, "Opera Software/Opera Stable"),
        ("360 极速浏览器", local, "360ChromeX/Chrome/User Data"),
        ("QQ 浏览器", local, "Tencent/QQBrowser/User Data"),
        ("Sogou 浏览器", local, "SogouExplorer"),
    ]
    for label, root, rel in chromium_like:
        if root is None:
            continue
        candidate = root / rel
        if candidate.exists():
            out.append((label, candidate))

    if roaming is not None:
        firefox = roaming / "Mozilla/Firefox/Profiles"
        if firefox.exists():
            out.append(("Mozilla Firefox", firefox))
    return out


def iter_files(
    root: Path,
    *,
    max_depth: int = 24,
    follow_symlinks: bool = False,
    should_cancel=None,
) -> Iterator[Tuple[Path, int]]:
    """深度受限、不跟随符号链接的遍历，产出 (路径, 字节数)。

    不跟随符号链接和 junction（`Application Data` 等 junction 指回自身会无限递归，
    部分 Python 版本把 junction 当普通目录，故显式判 reparse point）；权限错误不中断；有深度上限。
    """
    root = Path(root)
    if not exists(root):
        return
    base_depth = len(root.parts)

    stack: List[Path] = [root]
    while stack:
        if should_cancel and should_cancel():
            return
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                bump_scan_stat("dirs")
                for entry in it:
                    if should_cancel and should_cancel():
                        return
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not follow_symlinks and _is_reparse_point(entry):
                                continue
                            if len(Path(entry.path).parts) - base_depth < max_depth:
                                stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            try:
                                size = entry.stat(follow_symlinks=False).st_size
                            except OSError:
                                bump_scan_stat("denied")
                                continue
                            bump_scan_stat("files")
                            yield Path(entry.path), size
                    except OSError:
                        bump_scan_stat("denied")
                        continue
        except (OSError, PermissionError):
            # 整个目录打不开（如被企业策略拒绝）也要计入 denied，不能静默。
            bump_scan_stat("denied")
            continue


def _is_reparse_point(entry) -> bool:
    try:
        if entry.is_symlink():
            return True
    except OSError:
        return True
    try:
        # FILE_ATTRIBUTE_REPARSE_POINT = 0x400。junction 不是 symlink，
        # 只有这个属性位认得出来。
        return bool(entry.stat(follow_symlinks=False).st_file_attributes & 0x400)
    except (OSError, AttributeError):
        return False


def dir_size(root: Path, *, should_cancel=None, cap_entries: int = 400_000) -> Tuple[int, int]:
    """算目录总大小，返回 (字节数, 文件数)。

    `cap_entries` 防止对 `C:\\` 这类调用数千万文件；命中上限即返回已数部分，调用方显示"≥ X"。
    """
    total = 0
    count = 0
    for _, size in iter_files(root, should_cancel=should_cancel):
        total += size
        count += 1
        if count >= cap_entries:
            break
    return total, count
