"""定时清理计划。

默认档是 `scan`：到点只静默扫描并存进落盘缓存，不动任何文件；自动清理须用户显式选 `clean`，
且只清 `SAFE_CATEGORIES`（删后系统会自行重新生成：浏览器缓存、临时文件、缩略图）。
软件、启动项、注册表、自定义规则永不进自动清理。

不做成 Windows 计划任务：`schtasks /create` 要提权（主进程永不提权），且会在应用没运行、
金库锁着时触发。代价是应用没开时不跑，界面文案必须如实说明。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

CONFIG_FILE_NAME = "schedule.json"

SAFE_CATEGORIES = ("junk", "browserCache")
"""自动清理只碰这两类。判据是**删了会自己回来**：浏览器缓存下次访问就重建，
临时文件下次运行就重建。用户不会因为它们被清掉而丢失任何东西。

`privacy` 没进来是因为它删的是历史记录/最近打开列表——那些不会自动回来，
而且有人确实靠"最近打开"找文件。`downloads` 更不行，那是用户的真实文件。"""

INTERVALS = {
    "daily": 24 * 3600.0,
    "weekly": 7 * 24 * 3600.0,
    "monthly": 30 * 24 * 3600.0,
}

_CHECK_EVERY_S = 900.0
"""多久醒来看一次到点没有。15 分钟——比它更密没有意义（周期最短是一天），
更疏会让"开机后不久就该跑的那次"拖太久。"""

_STARTUP_GRACE_S = 120.0
"""应用刚起来的两分钟内不触发。开机时一堆东西在抢磁盘，这时候插一脚
用户只会觉得"这软件一开就卡"。"""


def _config_path(data_dir: Path) -> Path:
    return Path(data_dir) / "pcclean" / CONFIG_FILE_NAME


def default_config() -> Dict[str, Any]:
    return {
        "enabled": False,
        "interval": "weekly",
        "mode": "scan",
        "categories": list(SAFE_CATEGORIES),
        "last_run": 0,
        "last_result": {},
    }


def load_config(data_dir: Path) -> Dict[str, Any]:
    config = default_config()
    try:
        raw = json.loads(_config_path(data_dir).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            config.update({k: raw[k] for k in config if k in raw})
    except (OSError, ValueError):
        pass
    return _sanitise(config)


def _sanitise(config: Dict[str, Any]) -> Dict[str, Any]:
    """把配置收进合法范围，这是真正的安全边界：配置文件在磁盘上可被直接改，
    否则 `categories=["software"]` 加 `mode=clean` 会让下个周期自动卸载软件。
    自动清理的类别在这里被无条件裁到白名单内。
    """
    if config.get("interval") not in INTERVALS:
        config["interval"] = "weekly"
    if config.get("mode") not in ("scan", "clean"):
        config["mode"] = "scan"
    requested = config.get("categories") or []
    if not isinstance(requested, list):
        requested = []
    config["categories"] = [c for c in requested if c in SAFE_CATEGORIES] \
        or list(SAFE_CATEGORIES)
    try:
        config["last_run"] = int(config.get("last_run") or 0)
    except (TypeError, ValueError):
        config["last_run"] = 0
    config["enabled"] = bool(config.get("enabled"))
    return config


def save_config(data_dir: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    merged = _sanitise({**default_config(), **(config or {})})
    path = _config_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return merged


def due_at(config: Dict[str, Any]) -> float:
    """下一次该跑的时间戳。没跑过就是"现在"。"""
    last = float(config.get("last_run") or 0)
    if last <= 0:
        return time.time()
    return last + INTERVALS.get(str(config.get("interval")), INTERVALS["weekly"])


class Scheduler:
    """后台线程，到点调 `runner(config)`；runner 由 service 传入而非直接调 `health_check`，使本模
    块可脱离真机单测。"""

    def __init__(self, data_dir: Path, runner: Callable[[Dict[str, Any]], Dict[str, Any]]):
        self._data_dir = Path(data_dir)
        self._runner = runner
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._started_at = time.time()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._started_at = time.time()
        self._thread = threading.Thread(target=self._loop, name="pcclean-schedule",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(_CHECK_EVERY_S):
            try:
                if time.time() - self._started_at < _STARTUP_GRACE_S:
                    continue
                config = load_config(self._data_dir)
                if not config.get("enabled"):
                    continue
                if time.time() < due_at(config):
                    continue
                result = self._runner(config) or {}
                config["last_run"] = int(time.time())
                config["last_result"] = {
                    "ts": config["last_run"],
                    "mode": config.get("mode"),
                    "freed_bytes": int(result.get("freed_bytes") or 0),
                    "items": int(result.get("items") or 0),
                    "ok": bool(result.get("ok", True)),
                }
                save_config(self._data_dir, config)
            except Exception:
                # 计划任务出错绝不能让线程死掉——死掉之后表现是"我设了每周清理
                # 但它再也没跑过"，而且没有任何提示。下个周期继续试。
                continue
