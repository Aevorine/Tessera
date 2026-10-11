"""弹窗拦截：源头禁用 + 窗口监视。这是唯一会主动关别人窗口的功能，规则从严：

1. 只发 `WM_CLOSE`，绝不杀进程（可能丢未保存数据）。
2. 必须命中规则（内置库或用户捕获）才动手，无启发式判断。
3. 白名单优先于一切规则。
4. 每次拦截写日志（标题、类名、进程名、时间），便于查出误拦的规则并加白名单。
5. 绝不碰前台窗口。

监视线程每 1.2 秒枚举一次顶层窗口。
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import threading
import time
from ctypes import wintypes
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Set

IS_WINDOWS = os.name == "nt"

WM_CLOSE = 0x0010
GW_OWNER = 4
_POLL_INTERVAL_S = 1.2
_LOG_LIMIT = 500


@dataclass
class PopupRule:
    """一条拦截规则：title/class/process 三个字段是与关系，空字段不限制；全空规则会被拒绝（等于关
    掉一切）。"""

    rule_id: str
    label: str
    title_pattern: str = ""
    class_pattern: str = ""
    process_pattern: str = ""
    enabled: bool = True
    builtin: bool = False
    source: str = "builtin"

    def is_valid(self) -> bool:
        return bool(self.title_pattern or self.class_pattern or self.process_pattern)

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)


# 内置规则库。刻意做得保守：只覆盖那些**窗口本身就是广告**的形态，
# 不去猜"某某软件的更新提示算不算弹窗"。
BUILTIN_RULES: Sequence[PopupRule] = (
    PopupRule("promo-generic-cn", "pcclean.popup.rule.promoCn",
              title_pattern=r"(限时优惠|立即升级|免费领取|推荐安装|一键加速|"
                            r"发现\d+个?(问题|风险)|您的电脑|清理大师|优惠券)",
              builtin=True),
    PopupRule("promo-toolbar", "pcclean.popup.rule.toolbar",
              title_pattern=r"(?i)(toolbar|search protect|web companion|"
                            r"special offer|recommended for you)",
              builtin=True),
    PopupRule("fake-alert", "pcclean.popup.rule.fakeAlert",
              title_pattern=r"(?i)(your (pc|computer) is|virus detected|"
                            r"系统检测到|驱动异常|急需修复)",
              builtin=True),
    PopupRule("news-feed", "pcclean.popup.rule.newsFeed",
              class_pattern=r"(?i)^(TXGuiFoundation|DUIWindow)$",
              title_pattern=r"(资讯|头条|热点|每日推荐|弹窗)",
              builtin=True),
)


# 窗口枚举

if IS_WINDOWS:
    _EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
else:  # pragma: no cover
    _EnumWindowsProc = None  # type: ignore


@dataclass
class WindowInfo:
    hwnd: int
    title: str
    class_name: str
    pid: int
    process: str
    visible: bool


def _window_text(hwnd) -> str:
    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def _class_name(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _process_name(pid: int) -> str:
    if not pid:
        return ""
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, buf,
                                                             ctypes.byref(size)):
            return os.path.basename(buf.value)
    except (OSError, AttributeError):
        pass
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)
    return ""


def enumerate_windows(*, visible_only: bool = True) -> List[WindowInfo]:
    """枚举顶层窗口。给「捕获模式」和监视线程共用。"""
    if not IS_WINDOWS:
        return []
    result: List[WindowInfo] = []
    user32 = ctypes.windll.user32

    def _callback(hwnd, _lparam):
        try:
            visible = bool(user32.IsWindowVisible(hwnd))
            if visible_only and not visible:
                return True
            # 有 owner 的是对话框/工具窗，通常不是我们要找的独立弹窗；
            # 但推广弹窗恰恰常常是这种，所以**不过滤**，只记下来。
            title = _window_text(hwnd)
            cls = _class_name(hwnd)
            if not title and not cls:
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            result.append(WindowInfo(
                hwnd=int(hwnd),
                title=title,
                class_name=cls,
                pid=int(pid.value),
                process=_process_name(int(pid.value)),
                visible=visible,
            ))
        except (OSError, ValueError, AttributeError):
            pass
        return True

    try:
        user32.EnumWindows(_EnumWindowsProc(_callback), 0)
    except (OSError, AttributeError):
        return result
    return result


# 拦截器


class PopupBlocker:
    """窗口监视线程：`stop()` 后最多再跑一个轮询周期即退出，不留后台残余（隐私应用不能留偷偷枚举窗
    口的线程）。"""

    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._log: List[Dict[str, object]] = []
        self._blocked_count = 0
        self._started_at: Optional[float] = None
        self._on_block: Optional[Callable[[Dict[str, object]], None]] = None

    # -- 配置持久化 -------------------------------------------------------

    @property
    def _config_path(self) -> Path:
        return self._data_dir / "pcclean_popup.json"

    def load_config(self) -> Dict[str, object]:
        default = {
            "enabled": False,
            "custom_rules": [],
            "disabled_builtin": [],
            "whitelist": [],
        }
        try:
            if self._config_path.exists():
                raw = json.loads(self._config_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    default.update({k: raw[k] for k in default if k in raw})
        except (OSError, ValueError):
            pass
        return default

    def save_config(self, config: Dict[str, object]) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._config_path)

    def active_rules(self) -> List[PopupRule]:
        config = self.load_config()
        disabled = set(config.get("disabled_builtin") or [])
        rules = [r for r in BUILTIN_RULES if r.rule_id not in disabled]
        for raw in config.get("custom_rules") or []:
            if not isinstance(raw, dict):
                continue
            try:
                rule = PopupRule(
                    rule_id=str(raw.get("rule_id") or ""),
                    label=str(raw.get("label") or ""),
                    title_pattern=str(raw.get("title_pattern") or ""),
                    class_pattern=str(raw.get("class_pattern") or ""),
                    process_pattern=str(raw.get("process_pattern") or ""),
                    enabled=bool(raw.get("enabled", True)),
                    builtin=False,
                    source="user",
                )
            except (TypeError, ValueError):
                continue
            if rule.rule_id and rule.enabled and rule.is_valid():
                rules.append(rule)
        return rules

    # -- 匹配 -------------------------------------------------------------

    @staticmethod
    def _match(rule: PopupRule, window: WindowInfo) -> bool:
        try:
            if rule.title_pattern and not re.search(rule.title_pattern, window.title):
                return False
            if rule.class_pattern and not re.search(rule.class_pattern, window.class_name):
                return False
            if rule.process_pattern and not re.search(rule.process_pattern, window.process,
                                                      re.IGNORECASE):
                return False
        except re.error:
            # 用户写的正则有语法错误 —— 当成不匹配。让一条坏规则拦不住东西，
            # 好过让它匹配到一切。
            return False
        return rule.is_valid()

    @staticmethod
    def _whitelisted(whitelist: Sequence[str], window: WindowInfo) -> bool:
        for entry in whitelist:
            needle = str(entry).strip().lower()
            if not needle:
                continue
            if (needle in window.title.lower()
                    or needle in window.process.lower()
                    or needle == window.class_name.lower()):
                return True
        return False

    def check_once(self, *, dry_run: bool = False) -> List[Dict[str, object]]:
        """扫一轮窗口，返回命中（或将拦截）的列表。

        `dry_run=True` 供「测试规则」按钮预览，避免过宽规则关掉用户正在用的窗口。
        """
        if not IS_WINDOWS:
            return []
        config = self.load_config()
        whitelist = [str(x) for x in (config.get("whitelist") or [])]
        rules = self.active_rules()
        if not rules:
            return []

        try:
            foreground = int(ctypes.windll.user32.GetForegroundWindow())
        except (OSError, AttributeError):
            foreground = 0

        hits: List[Dict[str, object]] = []
        for window in enumerate_windows(visible_only=True):
            if window.hwnd == foreground:
                continue  # 铁律 5：正在用的窗口永不碰
            if self._whitelisted(whitelist, window):
                continue
            for rule in rules:
                if not self._match(rule, window):
                    continue
                record = {
                    "timestamp": time.time(),
                    "rule_id": rule.rule_id,
                    "rule_label": rule.label,
                    "title": window.title,
                    "class_name": window.class_name,
                    "process": window.process,
                    "pid": window.pid,
                    "blocked": False,
                }
                if not dry_run:
                    record["blocked"] = self._close_window(window.hwnd)
                    if record["blocked"]:
                        self._record(record)
                hits.append(record)
                break
        return hits

    @staticmethod
    def _close_window(hwnd: int) -> bool:
        """发 WM_CLOSE；用 PostMessage 而非 SendMessage，后者会阻塞到对方处理完，对方卡死会拖住监视线程。"""
        try:
            return bool(ctypes.windll.user32.PostMessageW(hwnd, WM_CLOSE, 0, 0))
        except (OSError, AttributeError):
            return False

    def _record(self, entry: Dict[str, object]) -> None:
        with self._lock:
            self._log.append(entry)
            if len(self._log) > _LOG_LIMIT:
                del self._log[: len(self._log) - _LOG_LIMIT]
            self._blocked_count += 1
        if self._on_block:
            try:
                self._on_block(entry)
            except Exception:
                pass

    # -- 线程控制 ---------------------------------------------------------

    def start(self, on_block: Optional[Callable[[Dict[str, object]], None]] = None) -> bool:
        if not IS_WINDOWS:
            return False
        with self._lock:
            if self._thread and self._thread.is_alive():
                return True
            self._stop_event.clear()
            self._on_block = on_block
            self._started_at = time.time()
            self._thread = threading.Thread(
                target=self._loop, name="pcclean-popup-blocker", daemon=True
            )
            self._thread.start()
        return True

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=_POLL_INTERVAL_S * 2)
        self._thread = None
        self._started_at = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.check_once()
            except Exception:
                # 监视线程绝不能因为一次异常就死掉 —— 它死了用户不会收到任何提示，
                # 只会以为拦截还在工作。
                pass
            self._stop_event.wait(_POLL_INTERVAL_S)

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def status(self) -> Dict[str, object]:
        config = self.load_config()
        with self._lock:
            log = list(self._log[-100:])
            blocked = self._blocked_count
        return {
            "running": self.running,
            "enabled_in_config": bool(config.get("enabled")),
            "blocked_count": blocked,
            "started_at": self._started_at,
            "rules": [r.to_dict() for r in self.active_rules()],
            "builtin_rules": [r.to_dict() for r in BUILTIN_RULES],
            "whitelist": list(config.get("whitelist") or []),
            "recent": log,
            "poll_interval_s": _POLL_INTERVAL_S,
        }

    def clear_log(self) -> None:
        with self._lock:
            self._log.clear()
            self._blocked_count = 0


# 源头禁用

_PROMO_SIGNATURES = (
    r"(?i)(promot|adver|popup|弹窗|推广|广告|资讯|头条|navigation|hao123|"
    r"lavasoft|webcompanion|searchprotect)",
)
_PROMO_RE = re.compile("|".join(_PROMO_SIGNATURES))


def scan_popup_sources(task, *, startup_report=None) -> "ScanReport":
    """找出产生弹窗的计划任务和自启项（比窗口监视更根本：根本不弹）。

    `startup_report` 传入已扫好的自启项清单：自启扫描约 8.7 秒，`startup` 和 `popupSources` 共用，
    避免跑两遍。
    """
    from modules.file_vault.pcclean import startup as startup_mod
    from modules.file_vault.pcclean.model import CleanItem, Importance, ScanTask

    items: List[CleanItem] = []
    errors: List[str] = []

    if startup_report is None:
        sub_task = ScanTask(category="popupSources",
                            on_progress=task.on_progress,
                            should_cancel=task.cancelled)
        try:
            startup_report = startup_mod.scan_startup(sub_task)
        except Exception as exc:
            return task.report([], errors=[f"popupSources: {type(exc).__name__}"])

    for item in startup_report.items:
        if item.locked:
            continue
        haystack = f"{item.label} {item.path}"
        if not _PROMO_RE.search(haystack):
            continue
        if not item.detail.get("enabled", True):
            continue
        clone = CleanItem(
            item_id=f"popupSource:{item.item_id}",
            category="popupSources",
            label=item.label,
            path=item.path,
            importance=Importance.JUNK,
            reason="pcclean.popup.sourceDetected",
            default_selected=True,
            detail=dict(item.detail, origin_item_id=item.item_id),
        )
        items.append(clone)

    # 证据全部借自启动项那一轮，否则界面会把"没有推广自启项"误报成"根本没跑"。
    return task.report(items, errors=errors + startup_report.errors,
                       probes=startup_report.scanned_dirs,
                       denied=startup_report.denied)
