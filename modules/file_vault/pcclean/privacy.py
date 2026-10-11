"""隐私痕迹清理 + 插件/扩展清理。

与垃圾清理分开：这里删的是用户的行为记录（掉线、最近打开、表单），混在一起会让人误点。
每项默认不勾选除非确实无害，`reason` 写明删了会丢什么。
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from modules.file_vault.pcclean import paths, processes
from modules.file_vault.pcclean.model import (
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)

WINREG_AVAILABLE = False
try:  # pragma: no cover - 非 Windows 上不可用
    import winreg  # type: ignore
    WINREG_AVAILABLE = os.name == "nt"
except ImportError:  # pragma: no cover
    winreg = None  # type: ignore


@dataclass(frozen=True)
class PrivacyRule:
    key: str
    kind: str
    """'registry' | 'files' | 'browser'"""

    target: str
    """registry: `HKCU\\Software\\...` 形式；files: 目录名（用 resolve 解析）"""

    resolve: Optional[Callable[[], Optional[Path]]] = None
    default_selected: bool = False
    values_only: bool = False
    """registry 规则专用：True = 只清键下的值，保留键本身。
    很多 MRU 键被删掉整个键之后 Explorer 不会重建，"最近使用"功能就此坏掉。"""

    patterns: Sequence[str] = ()


def _recent() -> Optional[Path]:
    return paths.known("Recent")


def _local(rel: str) -> Callable[[], Optional[Path]]:
    def _resolve() -> Optional[Path]:
        root = paths.known("LocalAppData")
        return (root / rel) if root else None
    return _resolve


def _roaming(rel: str) -> Callable[[], Optional[Path]]:
    def _resolve() -> Optional[Path]:
        root = paths.known("RoamingAppData")
        return (root / rel) if root else None
    return _resolve


PRIVACY_RULES: Sequence[PrivacyRule] = (
    PrivacyRule("recentDocuments", "files", "Recent", _recent, default_selected=True),
    # 两个跳转列表目录必须是两条独立规则、默认值不同。
    # `AutomaticDestinations` 是 CFBF，可用 `safety.jumplist_pinned_count()` 逐个识别固定项并拦下，
    # 故默认勾选。
    PrivacyRule("jumpLists", "files", "AutomaticDestinations",
                _roaming("Microsoft/Windows/Recent/AutomaticDestinations"),
                default_selected=True),
    # `CustomDestinations` 不是 CFBF，是应用自己注册的分类和任务栏固定项，无法逐条判 pin，
    # 且不会自愈（应用不重新注册就一直是空菜单），所以 `default_selected=False`。
    # 规则 id 是前后端契约（i18n 键由它派生），不要改名。
    PrivacyRule("jumpListsCustom", "files", "CustomDestinations",
                _roaming("Microsoft/Windows/Recent/CustomDestinations"),
                default_selected=False),
    PrivacyRule("runMru", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU",
                default_selected=True, values_only=True),
    PrivacyRule("typedPaths", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\TypedPaths",
                default_selected=True, values_only=True),
    PrivacyRule("recentDocsRegistry", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\RecentDocs",
                default_selected=True, values_only=True),
    PrivacyRule("wordWheelQuery", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\WordWheelQuery",
                default_selected=True, values_only=True),
    PrivacyRule("userAssist", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist",
                default_selected=False, values_only=True),
    PrivacyRule("networkShareMru", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Map Network Drive MRU",
                default_selected=False, values_only=True),
    PrivacyRule("openSaveMru", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSavePidlMRU",
                default_selected=True, values_only=True),
    PrivacyRule("lastVisitedMru", "registry",
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\LastVisitedPidlMRU",
                default_selected=True, values_only=True),
)


# Chromium 系的痕迹文件及删除后果。Cookies 和 Login Data 故意不在表里：
# 前者清了所有网站掉线，后者是保存的密码，只能由用户在浏览器里自己清。
_CHROMIUM_TRACE_FILES = (
    ("history", "History", True),
    ("historyIndex", "History-journal", True),
    ("visitedLinks", "Visited Links", True),
    ("topSites", "Top Sites", True),
    ("shortcuts", "Shortcuts", False),
    ("networkAction", "Network Action Predictor", True),
    ("sessionRestore", "Sessions", False),
)


def scan_privacy(task: ScanTask) -> ScanReport:
    """Windows 使用痕迹 + 浏览器历史。"""
    items: List[CleanItem] = []
    errors: List[str] = []
    total = len(PRIVACY_RULES)

    for index, rule in enumerate(PRIVACY_RULES):
        if task.cancelled():
            break
        try:
            item = _scan_privacy_rule(rule, task)
            if item:
                items.append(item)
        except Exception as exc:
            errors.append(f"{rule.key}: {type(exc).__name__}")
        task.progress(index + 1, total + 1)

    try:
        traces = _scan_browser_traces(task)
        # 浏览器开着时 `History`（SQLite）被独占，需提前提示，否则用户会看到"成功"但历史还在。
        processes.annotate_browser_items(traces)
        items.extend(traces)
    except Exception as exc:
        errors.append(f"browserTraces: {type(exc).__name__}")
    task.progress(total + 1, total + 1)
    return task.report(items, errors=errors)


def _protected_within(root: Path) -> Tuple[int, int]:
    """该目录顶层有多少受保护文件、共多少字节。

    只看顶层：jump list 文件本就平铺，递归会拖慢一键体检的关键路径。
    传 `entry.path` 而非 `entry.name`：`safety.jumplist_pinned_count` 要真的读文件，否则数字会少于
    执行时实际跳过的。
    """
    from modules.file_vault.pcclean import safety

    total = 0
    count = 0
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if not entry.is_file(follow_symlinks=False):
                    continue
                if not safety.protection_reason(entry.path):
                    continue
                count += 1
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        return 0, 0
    return total, count


def _scan_privacy_rule(rule: PrivacyRule, task: ScanTask) -> Optional[CleanItem]:
    if rule.kind == "files":
        root = rule.resolve() if rule.resolve else None
        if root is None or not paths.exists(root):
            return None
        size, count = paths.dir_size(root, should_cancel=task.cancelled)
        # 受保护文件执行时会被跳过（`actions._delete_tree_contents`），报的数字也要扣掉，否则"可清理"
        # 与"实际释放"对不上。
        guarded_bytes, guarded_count = _protected_within(root)
        size = max(0, size - guarded_bytes)
        count = max(0, count - guarded_count)
        if count == 0:
            return None
        return CleanItem(
            item_id=f"privacy:{rule.key}",
            category="privacy",
            label=rule.key,
            size_bytes=size,
            path=str(root),
            importance=Importance.OPTIONAL,
            reason=f"pcclean.privacy.{rule.key}.reason",
            default_selected=rule.default_selected,
            detail={"kind": "files", "file_count": count,
                    # 界面用它说明"这里面有 N 项是你自己钉上去的，不会被清"。
                    # 沉默地保护等于用户永远不知道自己差点丢了什么。
                    "protected_count": guarded_count,
                    "label_key": f"pcclean.privacy.{rule.key}.label"},
        )

    if rule.kind == "registry":
        count = _count_registry_values(rule.target)
        if count <= 0:
            return None
        return CleanItem(
            item_id=f"privacy:{rule.key}",
            category="privacy",
            label=rule.key,
            size_bytes=0,
            path=f"HKCU\\{rule.target}",
            importance=Importance.OPTIONAL,
            reason=f"pcclean.privacy.{rule.key}.reason",
            default_selected=rule.default_selected,
            detail={"kind": "registry", "entry_count": count,
                    "values_only": rule.values_only,
                    "label_key": f"pcclean.privacy.{rule.key}.label"},
        )
    return None


def _count_registry_values(subkey: str) -> int:
    """数一个 HKCU 键下的记录数（含子键）；数不出来返回 0 不抛异常（部分 Windows 版本无此键）。"""
    if not WINREG_AVAILABLE:
        return 0
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey, 0, winreg.KEY_READ) as key:
            n_sub, n_val, _ = winreg.QueryInfoKey(key)
            # 默认值（空名）不算一条记录，它几乎总是存在
            total = n_sub + n_val
            if n_val:
                try:
                    winreg.QueryValueEx(key, "")
                    total -= 1
                except FileNotFoundError:
                    pass
            return max(0, total)
    except (FileNotFoundError, OSError, PermissionError):
        return 0


def _scan_browser_traces(task: ScanTask) -> List[CleanItem]:
    items: List[CleanItem] = []
    for label, root in paths.browser_profile_roots():
        if task.cancelled():
            break
        if label == "Mozilla Firefox":
            items.extend(_scan_firefox_traces(label, root))
            continue
        for profile in _chromium_profiles(root):
            total = 0
            present: List[str] = []
            for key, filename, default_on in _CHROMIUM_TRACE_FILES:
                candidate = profile / filename
                if paths.exists(candidate):
                    try:
                        total += candidate.stat().st_size
                    except OSError:
                        continue
                    present.append(filename)
                elif candidate.is_dir():
                    size, _ = paths.dir_size(candidate, should_cancel=task.cancelled)
                    total += size
                    present.append(filename)
            if not present:
                continue
            items.append(CleanItem(
                item_id=f"privacy:browser:{label}:{profile.name}",
                category="privacy",
                label=f"{label} · {profile.name}",
                size_bytes=total,
                path=str(profile),
                importance=Importance.OPTIONAL,
                reason="pcclean.privacy.browserHistory.reason",
                default_selected=False,
                detail={"kind": "browser", "browser": label,
                        "profile": profile.name, "files": present,
                        "label_key": "pcclean.privacy.browserHistory.label"},
            ))
    return items


def _scan_firefox_traces(label: str, profiles_root: Path) -> List[CleanItem]:
    items: List[CleanItem] = []
    try:
        candidates = [p for p in profiles_root.iterdir() if p.is_dir()]
    except OSError:
        return items
    for profile in candidates:
        total = 0
        present: List[str] = []
        for filename in ("places.sqlite", "places.sqlite-wal", "formhistory.sqlite",
                         "sessionstore.jsonlz4"):
            candidate = profile / filename
            if paths.exists(candidate):
                try:
                    total += candidate.stat().st_size
                except OSError:
                    continue
                present.append(filename)
        if not present:
            continue
        items.append(CleanItem(
            item_id=f"privacy:browser:{label}:{profile.name}",
            category="privacy",
            label=f"{label} · {profile.name}",
            size_bytes=total,
            path=str(profile),
            importance=Importance.OPTIONAL,
            reason="pcclean.privacy.browserHistory.reason",
            default_selected=False,
            detail={"kind": "browser", "browser": label,
                    "profile": profile.name, "files": present,
                    "label_key": "pcclean.privacy.browserHistory.label"},
        ))
    return items


def _chromium_profiles(user_data: Path) -> List[Path]:
    out: List[Path] = []
    try:
        for entry in user_data.iterdir():
            if entry.is_dir() and (entry.name == "Default" or entry.name.startswith("Profile ")):
                out.append(entry)
    except OSError:
        pass
    return out


# 插件 / 扩展清理


def scan_plugins(task: ScanTask, *, whitelist=None) -> ScanReport:
    """浏览器扩展 + Office 加载项 + 注入 Explorer 的 Shell DLL。只列出并分级，不给默认勾选（扩展是
    用户自己装的）。"""
    from modules.file_vault.pcclean import importance as imp

    items: List[CleanItem] = []
    errors: List[str] = []

    try:
        extensions = _scan_browser_extensions(task, whitelist)
        # 扩展目录在浏览器运行时被整个加载着，删除会失败或者只删掉一半 ——
        # 后者更糟：浏览器下次启动时扩展处于半残状态，报的错和"清理"毫无关联。
        processes.annotate_browser_items(extensions)
        items.extend(extensions)
    except Exception as exc:
        errors.append(f"browserExtensions: {type(exc).__name__}")
    task.progress(1, 3)

    try:
        items.extend(_scan_office_addins(whitelist))
    except Exception as exc:
        errors.append(f"officeAddins: {type(exc).__name__}")
    task.progress(2, 3)

    try:
        items.extend(_scan_shell_injection(whitelist))
    except Exception as exc:
        errors.append(f"shellInjection: {type(exc).__name__}")
    task.progress(3, 3)

    return task.report(items, errors=errors)


_RISKY_PERMISSIONS = {
    # 权重来自"这条权限能拿到什么"，不是"名字听起来吓不吓人"。
    "debugger": 5,          # 可以接管整个浏览器调试协议
    "nativeMessaging": 5,   # 能和本机程序通信，等于跳出沙箱
    "proxy": 4,             # 能把全部流量导去任意服务器
    "webRequest": 3,        # 能看见每一个请求
    "webRequestBlocking": 3,
    "cookies": 3,           # 含登录态
    "history": 3,
    "management": 3,        # 能装/停用别的扩展
    "clipboardRead": 3,
    "downloads": 2,
    "scripting": 2,
    "declarativeNetRequest": 2,
    "tabs": 1,
    "bookmarks": 1,
    "geolocation": 1,
}

_ALL_SITES_PATTERNS = ("<all_urls>", "*://*/*", "http://*/*", "https://*/*")

_STALE_AFTER_DAYS = 730.0
"""两年没更新的扩展。不是"两年不更新就有毒"，而是**没人在修它的漏洞了**——
浏览器的攻击面每年都在变，两年前的代码里已知问题不会有人补。"""


def _extension_risk(ext_dir: Path, manifest: Dict[str, object],
                    version_dir: Optional[Path]) -> Dict[str, object]:
    """给扩展打风险分，返回分数、等级和具体因子（让用户能对照自身情况判断）。

    分数只衡量权限大小，不判断是否恶意（密码管理器分数高却不该删），所以永远不会 default_selected。
    """
    permissions: List[str] = []
    for key in ("permissions", "optional_permissions"):
        raw = manifest.get(key)
        if isinstance(raw, list):
            permissions.extend(str(p) for p in raw)

    hosts: List[str] = []
    for key in ("host_permissions", "optional_host_permissions"):
        raw = manifest.get(key)
        if isinstance(raw, list):
            hosts.extend(str(h) for h in raw)
    # MV2 把站点匹配混在 permissions 里，MV3 才分出 host_permissions。
    # 只看 host_permissions 的话，所有 MV2 扩展的站点权限会被整个漏掉。
    hosts.extend(p for p in permissions if "://" in p or p == "<all_urls>")

    score = 0
    factors: List[str] = []

    if any(h in _ALL_SITES_PATTERNS for h in hosts):
        score += 5
        factors.append("allSites")
    elif hosts:
        score += 1
        factors.append("someSites")

    risky = sorted({p for p in permissions if p in _RISKY_PERMISSIONS})
    for name in risky:
        score += _RISKY_PERMISSIONS[name]
    factors.extend(risky)

    # 来路：Web Store 装的扩展带 `_metadata/verified_contents.json`，
    # 手动加载/被别的程序塞进来的没有。后者是浏览器劫持最常见的入口。
    sideloaded = False
    if version_dir is not None:
        verified = version_dir / "_metadata" / "verified_contents.json"
        if not paths.exists(verified):
            sideloaded = True
            score += 3
            factors.append("sideloaded")

    stale_days = 0.0
    try:
        target = version_dir if version_dir is not None else ext_dir
        stale_days = max(0.0, (time.time() - target.stat().st_mtime) / 86400.0)
        if stale_days >= _STALE_AFTER_DAYS:
            score += 2
            factors.append("stale")
    except OSError:
        pass

    level = "high" if score >= 8 else "medium" if score >= 4 else "low"
    return {
        "score": score,
        "level": level,
        "factors": factors,
        "permissions": sorted(set(permissions)),
        "all_sites": "allSites" in factors,
        "sideloaded": sideloaded,
        "stale_days": int(stale_days),
    }


def _read_extension_manifest(ext_dir: Path) -> Tuple[str, str, Dict[str, object],
                                                     Optional[Path]]:
    """从 manifest.json 读扩展名、版本和整份 manifest。

    名字常是 `__MSG_appName__`（需查 _locales），查不到退回目录名（扩展 ID）。
    整份 manifest 一次带出，供风险评分读 `permissions`，避免重复磁盘 I/O。
    """
    version_dirs = []
    try:
        version_dirs = [d for d in ext_dir.iterdir() if d.is_dir()]
    except OSError:
        return ext_dir.name, "", {}, None
    for version_dir in sorted(version_dirs, reverse=True):
        manifest = version_dir / "manifest.json"
        if not paths.exists(manifest):
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        name = str(data.get("name") or "")
        version = str(data.get("version") or "")
        if name.startswith("__MSG_"):
            msg_key = name[6:-2] if name.endswith("__") else name[6:]
            resolved = _resolve_locale_message(version_dir, msg_key,
                                               str(data.get("default_locale") or "en"))
            if resolved:
                name = resolved
        if name:
            return name, version, data, version_dir
    return ext_dir.name, "", {}, None


def _read_extension_name(ext_dir: Path) -> Tuple[str, str]:
    name, version, _, _ = _read_extension_manifest(ext_dir)
    return name, version


def _resolve_locale_message(version_dir: Path, key: str, default_locale: str) -> str:
    for locale in (default_locale, "en", "en_US", "zh_CN"):
        messages = version_dir / "_locales" / locale / "messages.json"
        if not paths.exists(messages):
            continue
        try:
            data = json.loads(messages.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        entry = data.get(key) or data.get(key.lower())
        if isinstance(entry, dict) and entry.get("message"):
            return str(entry["message"])
    return ""


def _scan_browser_extensions(task: ScanTask, whitelist) -> List[CleanItem]:
    from modules.file_vault.pcclean import importance as imp

    items: List[CleanItem] = []
    for label, root in paths.browser_profile_roots():
        if task.cancelled():
            break
        if label == "Mozilla Firefox":
            continue  # Firefox 扩展在 extensions.json 里，结构不同，下面单独处理
        for profile in _chromium_profiles(root):
            ext_root = profile / "Extensions"
            if not paths.exists(ext_root):
                continue
            try:
                ext_dirs = [d for d in ext_root.iterdir() if d.is_dir()]
            except OSError:
                continue
            for ext_dir in ext_dirs:
                name, version, manifest, version_dir = _read_extension_manifest(ext_dir)
                size, _ = paths.dir_size(ext_dir, should_cancel=task.cancelled)
                verdict = imp.classify(name=name, path=str(ext_dir), whitelist=whitelist)
                risk = _extension_risk(ext_dir, manifest, version_dir)
                items.append(CleanItem(
                    item_id=f"plugin:{label}:{profile.name}:{ext_dir.name}",
                    category="plugins",
                    label=name,
                    size_bytes=size,
                    path=str(ext_dir),
                    importance=verdict.importance,
                    reason=verdict.reason_key,
                    locked=verdict.locked,
                    # 风险高**不等于**该删（密码管理器的分数天然就高）。
                    # 分数只用来排序和提示，勾选权永远在用户手里。
                    default_selected=False,
                    detail={"kind": "browserExtension", "browser": label,
                            "profile": profile.name, "extension_id": ext_dir.name,
                            "version": version, "evidence": verdict.evidence,
                            "risk": risk},
                ))
    return items


_OFFICE_ADDIN_ROOTS = (
    (r"Software\Microsoft\Office\Word\Addins", "Word"),
    (r"Software\Microsoft\Office\Excel\Addins", "Excel"),
    (r"Software\Microsoft\Office\PowerPoint\Addins", "PowerPoint"),
    (r"Software\Microsoft\Office\Outlook\Addins", "Outlook"),
)


def _scan_office_addins(whitelist) -> List[CleanItem]:
    from modules.file_vault.pcclean import importance as imp

    if not WINREG_AVAILABLE:
        return []
    items: List[CleanItem] = []
    for subkey, app in _OFFICE_ADDIN_ROOTS:
        for hive, hive_name in ((winreg.HKEY_CURRENT_USER, "HKCU"),
                                (winreg.HKEY_LOCAL_MACHINE, "HKLM")):
            try:
                with winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ) as key:
                    n_sub, _, _ = winreg.QueryInfoKey(key)
                    for i in range(n_sub):
                        try:
                            child = winreg.EnumKey(key, i)
                        except OSError:
                            continue
                        friendly = child
                        try:
                            with winreg.OpenKey(key, child, 0, winreg.KEY_READ) as sub:
                                try:
                                    friendly = str(winreg.QueryValueEx(sub, "FriendlyName")[0])
                                except FileNotFoundError:
                                    pass
                        except OSError:
                            pass
                        verdict = imp.classify(name=friendly, whitelist=whitelist)
                        items.append(CleanItem(
                            item_id=f"plugin:office:{hive_name}:{app}:{child}",
                            category="plugins",
                            label=friendly,
                            path=f"{hive_name}\\{subkey}\\{child}",
                            importance=verdict.importance,
                            reason=verdict.reason_key,
                            locked=verdict.locked,
                            default_selected=False,
                            detail={"kind": "officeAddin", "app": app,
                                    "hive": hive_name, "progid": child,
                                    "needs_elevation": hive_name == "HKLM"},
                        ))
            except (FileNotFoundError, OSError, PermissionError):
                continue
    return items


_SHELL_INJECTION_KEYS = (
    (r"Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers",
     "iconOverlay"),
    (r"Software\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects", "bho"),
)


def _scan_shell_injection(whitelist) -> List[CleanItem]:
    """注入 Explorer 的扩展。图标叠加层（云盘的对勾）尤其值得列出来——
    Windows 只认前 15 个，装多了会有云盘的同步状态图标莫名其妙不显示。"""
    from modules.file_vault.pcclean import importance as imp

    if not WINREG_AVAILABLE:
        return []
    items: List[CleanItem] = []
    for subkey, kind in _SHELL_INJECTION_KEYS:
        for hive, hive_name in ((winreg.HKEY_LOCAL_MACHINE, "HKLM"),
                                (winreg.HKEY_CURRENT_USER, "HKCU")):
            try:
                with winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ) as key:
                    n_sub, _, _ = winreg.QueryInfoKey(key)
                    for i in range(n_sub):
                        try:
                            child = winreg.EnumKey(key, i)
                        except OSError:
                            continue
                        verdict = imp.classify(name=child, whitelist=whitelist)
                        items.append(CleanItem(
                            item_id=f"plugin:shell:{hive_name}:{kind}:{child}",
                            category="plugins",
                            label=child.strip(),
                            path=f"{hive_name}\\{subkey}\\{child}",
                            importance=verdict.importance,
                            reason=verdict.reason_key,
                            locked=verdict.locked,
                            default_selected=False,
                            detail={"kind": kind, "hive": hive_name,
                                    "needs_elevation": hive_name == "HKLM"},
                        ))
            except (FileNotFoundError, OSError, PermissionError):
                continue
    return items
