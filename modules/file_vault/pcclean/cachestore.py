r"""体检结果的落盘缓存 + 每类耗时的历史样本。

落盘是为了重开面板时先铺满上次结果、后台重扫并逐类替换，等待感知为 0。

安全规则：显示可以用旧数据，执行绝对不行。`CleanItem` 存真实路径，旧路径上现在可能是别的重要文件。
所以落盘缓存只喂界面；仅当缓存比 `execute` 的 TTL 更新时才喂回执行缓存；过期的照样显示
（带 `stale`），点「清理」时前端先重扫。两件事不共用 TTL：旧数据的代价是数字旧，执行的代价是删错文件。

耗时样本给进度条算剩余时间，用中位数：偶发 5 倍耗时会永久带偏平均值。
"""

from __future__ import annotations

import json
import os
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

CACHE_VERSION = 2
"""结构变了就 +1。版本对不上直接当没有缓存——**绝不尝试迁移旧结构**：
迁移代码要跑在"我们不确定里面是什么"的数据上，而重扫一次的代价只有几秒。"""

MAX_SAMPLES = 7
"""每类留几次耗时样本。7 次足够压住偶发抖动，又不会让几个月前的机器状态
（换过硬盘、装过杀软）一直影响今天的估算。"""

DISPLAY_MAX_AGE_S = 7 * 24 * 3600.0
"""超过这个岁数连显示都不给——一周前的"可释放 4 GB"已经没有参考价值，
铺在屏幕上只会误导。"""


def _dir(data_dir: Path) -> Path:
    return Path(data_dir) / "pcclean"


def _cache_path(data_dir: Path) -> Path:
    return _dir(data_dir) / "health-cache.json"


def _timing_path(data_dir: Path) -> Path:
    return _dir(data_dir) / "scan-timing.json"


def _write_atomic(path: Path, payload: Dict[str, Any]) -> bool:
    """写临时文件再改名：直接覆盖时进程被杀会留下损坏的 JSON；同卷 `os.replace` 是原子的。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(tmp_name, str(path))
            return True
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except Exception:
        # 缓存写不进去不是错误，只是下次开机慢一点。绝不能因为它让体检失败。
        return False


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        if not path.is_file():
            return None
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


# -- 体检结果 -------------------------------------------------------------


def save_health(data_dir: Path, result: Dict[str, Any]) -> bool:
    """存一次体检的完整结果。只存成功的那些类。"""
    categories = {
        name: payload
        for name, payload in (result.get("categories") or {}).items()
        if isinstance(payload, dict) and payload.get("ok")
        # 超时的那一类结果是残缺的，存下来会让下次开机显示一个偏小的数字，
        # 而用户无从知道它是残缺的。宁可下次重扫。
        and not payload.get("timed_out")
    }
    if not categories:
        return False
    return _write_atomic(_cache_path(data_dir), {
        "version": CACHE_VERSION,
        "saved_at": time.time(),
        "categories": categories,
        "summary": result.get("summary") or {},
    })


def load_health(data_dir: Path, *, execute_ttl_s: float) -> Optional[Dict[str, Any]]:
    """读回上次的体检结果。`fresh_enough_to_execute` 决定是否喂回执行缓存，只在这里判断一次，
    免得调用点各自比 `saved_at`，比错就拿过期路径去删文件。"""
    data = _read_json(_cache_path(data_dir))
    if not data or data.get("version") != CACHE_VERSION:
        return None
    saved_at = float(data.get("saved_at") or 0)
    age = time.time() - saved_at
    if age < 0 or age > DISPLAY_MAX_AGE_S:
        return None
    categories = data.get("categories")
    if not isinstance(categories, dict) or not categories:
        return None
    return {
        "categories": categories,
        "summary": data.get("summary") or {},
        "saved_at": saved_at,
        "age_s": age,
        # `execute_ttl_s <= 0` 一律不可执行。只写 `age <= ttl` 时 ttl=0 会变成「存下的瞬间可执行」，
        # 而 Windows `time.time()` 分辨率可让存完立刻读得到 age == 0.0；偶发的「可拿旧路径去删」比稳定失败危险。
        "fresh_enough_to_execute": execute_ttl_s > 0 and age <= execute_ttl_s,
    }


SCAN_CACHE_PREFIX = "scan-"
SCAN_DISPLAY_MAX_AGE_S = 24 * 3600.0
"""单类扫描结果的显示上限。比体检那份宽得多（体检是 DISPLAY_MAX_AGE_S），
因为这几类本来就是"跑一次要几分钟、一天点不了两次"的重活——重复文件扫描
实测 180 秒，大文件 120 秒。让用户每次打开面板都从头等三分钟，等于逼他不用。

**上限存在的理由和体检那份一样**：再旧的结果也只是"旧数字"，而拿旧路径去
执行是"删错文件"。所以这里只管显示；能不能拿去执行由 `load_scan` 的
`fresh_enough_to_execute` 单独判，判据仍然是 `CACHE_TTL_S`。"""

# 只缓存慢的那几类。快的（隐私 99ms、内存 62ms）重扫比读盘还快，
# 缓存它们只会带来"数字是旧的"这一个纯粹的坏处。
CACHEABLE_SCAN_CATEGORIES = frozenset({
    "duplicates", "bigFiles", "software", "leftovers", "dirAnalysis",
    "driverStore", "emptyDirs", "browserData",
})


def _scan_path(data_dir: Path, category: str) -> Path:
    return _dir(data_dir) / f"{SCAN_CACHE_PREFIX}{category}.json"


def save_scan(data_dir: Path, category: str, payload: Dict[str, Any]) -> bool:
    """存一次单类扫描结果；超时或截断的不存，否则下次会先铺一份残缺却看似完整的数字（同 `save_health`）。"""
    if category not in CACHEABLE_SCAN_CATEGORIES:
        return False
    # 拒收覆盖不全的结果（超时 / 软截止），不拒按 limit 截断的：后者是设计内的完整结果，
    # 大文件扫描每次都会截断，拒收会让缓存对最需要它的类永远失效。
    if not payload.get("ok") or payload.get("timed_out") or payload.get("partial"):
        return False
    if not payload.get("items"):
        return False
    return _write_atomic(_scan_path(data_dir, category), {
        "version": CACHE_VERSION,
        "saved_at": time.time(),
        "category": category,
        "payload": payload,
    })


def load_scan(data_dir: Path, category: str, *,
              execute_ttl_s: float) -> Optional[Dict[str, Any]]:
    """读回上次的单类扫描结果，附带"够不够新到能直接拿去执行"。"""
    data = _read_json(_scan_path(data_dir, category))
    if not data or data.get("version") != CACHE_VERSION:
        return None
    saved_at = float(data.get("saved_at") or 0)
    age = time.time() - saved_at
    if age < 0 or age > SCAN_DISPLAY_MAX_AGE_S:
        return None
    payload = data.get("payload")
    if not isinstance(payload, dict) or not payload.get("items"):
        return None
    return {
        "payload": payload,
        "saved_at": saved_at,
        "age_s": age,
        # 跟 load_health 同一条判据：ttl<=0 一律不可执行。
        "fresh_enough_to_execute": execute_ttl_s > 0 and age <= execute_ttl_s,
    }


def clear_health(data_dir: Path) -> bool:
    try:
        _cache_path(data_dir).unlink()
        return True
    except FileNotFoundError:
        return True
    except Exception:
        return False


# -- 耗时样本 -------------------------------------------------------------


def record_timing(data_dir: Path, samples: Dict[str, int]) -> bool:
    """记一轮各类的实际耗时（毫秒）。"""
    data = _read_json(_timing_path(data_dir)) or {}
    history: Dict[str, List[int]] = {}
    for key, value in (data.get("samples") or {}).items():
        if isinstance(value, list):
            history[str(key)] = [int(v) for v in value if isinstance(v, (int, float))]

    for category, elapsed in samples.items():
        if elapsed <= 0:
            continue
        bucket = history.setdefault(category, [])
        bucket.append(int(elapsed))
        del bucket[:-MAX_SAMPLES]

    return _write_atomic(_timing_path(data_dir), {
        "version": CACHE_VERSION,
        "samples": history,
    })


def estimates(data_dir: Path) -> Dict[str, int]:
    """每类预计耗时（毫秒，中位数）；没样本的类不出现，不编默认值（错的剩余时间比不给更糟），调用方应显示「计算中」。"""
    data = _read_json(_timing_path(data_dir))
    if not data:
        return {}
    out: Dict[str, int] = {}
    for category, values in (data.get("samples") or {}).items():
        usable = [int(v) for v in values if isinstance(v, (int, float)) and v > 0]
        if usable:
            out[str(category)] = int(statistics.median(usable))
    return out
