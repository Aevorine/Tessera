"""故障诊断日志：只记「某功能没能正常工作」的事件，与 activity_log.py（记用户做了什么，在加密库里）无关。

必须在金库锁着甚至解锁失败时也能写，所以：
  * 明文 JSONL，放数据目录，不进加密库。
  * 默认关闭，未开启时一字节不写（日志本身是隐私风险）。
  * 只记故障，不记正常操作。
  * 绝不写入内容本身（剪贴板正文、文件内容、密码、密钥、完整路径），只记功能和错误码。

来源：backend_server 的 RPC 分发层统一喂入失败（`_record_rpc_failure`），前端喂入未捕获异常。
检索：`level` + 结构化字段 + 服务端筛选。交付：`build_report()` 产出可直接贴出的排查报告。

条目字段：`uid` 稳定标识（删除按它，不按下标）；`ts` unix 秒；`at` 本地时间字符串；
`level` error/warn/info；`module` 功能；`problem` 一句话；`code` 错误码可空；
`detail` 错误码、异常类名、状态字符串，不放用户内容；`count` 重复次数（见 `record` 折叠）。
"""

from __future__ import annotations

import json
import os
import platform
import sys
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

# 单个日志文件上限，超过轮转一次，只保留一份历史（诊断日志只关心最近的问题）。
MAX_BYTES = 2 * 1024 * 1024
MAX_ENTRIES_RETURNED = 500

LEVELS = ("error", "warn", "info")
"""三档就够。再细分（fatal/critical/trace…）在这个规模上只会让筛选器
变复杂，而没有任何一条排查路径真的用得上第四档。"""

_DEFAULT_LEVEL = "error"

# 同一条故障连着刷屏时的折叠窗口（秒）。断网重连一类的问题一秒能刷几十条，
# 不折叠的话真正有用的上下文会被顶出日志文件。
_DEDUPE_WINDOW_SECONDS = 60

_lock = threading.Lock()

# 进程内自增序号。uid 用「时间戳-序号-进程号」拼，防止同秒多条撞号导致删一条连带删另一条。
_seq = 0

# 最后写出那一行的信息，用于 O(1) 折叠：存写入前的文件长度和该行字节数，折叠时直接截断到 offset 重写，
# 避免故障刷屏时每秒几十次整份读写 2 MB 文件。写入方只有后端一个进程且有 _lock，内存状态可信；
# 文件被外部改过、长度对不上由 _try_fold_into_last 检出并放弃折叠。
# `_last_path` 把状态钉在具体文件上：数据目录会换（迁移、测试、多实例），只校验长度挡不住两文件等长。
_last_path: Optional[str] = None
_last_key: Optional[tuple] = None
_last_ts = 0
_last_offset = -1
_last_length = 0


def _forget_last() -> None:
    """让下一次 record 从没有可折叠的上一行开始；删除、清空、轮转后必须调，否则偏移量指向已失效的文件。"""
    global _last_path, _last_key, _last_ts, _last_offset, _last_length
    _last_path = None
    _last_key = None
    _last_ts = 0
    _last_offset = -1
    _last_length = 0


def log_path(data_dir: Path) -> Path:
    return Path(data_dir) / "diagnostic.log.jsonl"


def _rotated_path(data_dir: Path) -> Path:
    return log_path(data_dir).with_suffix(".jsonl.1")


def _settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / "diagnostic.enabled"


def is_enabled(data_dir: Path) -> bool:
    """日志是否开启。**默认关闭**——没有这个标记文件就是关。"""
    try:
        return _settings_path(data_dir).exists()
    except OSError:
        return False


def set_enabled(data_dir: Path, enabled: bool) -> None:
    path = _settings_path(data_dir)
    try:
        if enabled:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("1", encoding="utf-8")
        else:
            path.unlink(missing_ok=True)
    except OSError:
        # 标记写不进去时按"关"处理：宁可不记，也不要因为日志本身报错
        # 把用户正在做的事打断。
        pass


def _normalize_level(level: str) -> str:
    value = (level or "").strip().lower()
    return value if value in LEVELS else _DEFAULT_LEVEL


def _next_uid(now: int) -> str:
    global _seq
    _seq += 1
    return "%d-%d-%d" % (now, os.getpid(), _seq)


def record(
    data_dir: Path,
    module: str,
    problem: str,
    detail: str = "",
    code: str = "",
    level: str = _DEFAULT_LEVEL,
) -> None:
    """记一条故障；没开日志则直接返回，不做 I/O。

    `detail` 只放错误码、异常类名、状态字符串，不要传用户内容（剪贴板正文、文件名、路径、密码）。
    连续的同一条（同 module + problem + code）折叠并累加 `count`；只看最后一行，
    中间隔了别的事件说明有时间线价值，不合并。
    """
    if not is_enabled(data_dir):
        return

    now = int(time.time())
    entry = {
        "uid": _next_uid(now),
        "ts": now,
        "at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
        "level": _normalize_level(level),
        "module": _truncate(module, 64),
        "problem": _truncate(problem, 200),
        "code": _truncate(code, 120),
        "detail": _truncate(detail),
        "count": 1,
    }

    key = (entry["module"], entry["problem"], entry["code"], entry["level"])

    with _lock:
        try:
            path = log_path(data_dir)
            path.parent.mkdir(parents=True, exist_ok=True)
            _rotate_if_needed(path)
            if _try_fold_into_last(path, entry, now, key):
                return
            _append_line(path, entry, key, now)
        except OSError:
            # 日志写失败绝不能影响主流程——它是辅助设施，不是功能本身。
            pass


def _append_line(path: Path, entry: Dict[str, Any], key: tuple, now: int) -> None:
    """追加一行，并把"这一行在哪、多长"记在内存里供下次折叠用。"""
    global _last_path, _last_key, _last_ts, _last_offset, _last_length
    payload = (json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8")
    with path.open("ab") as fh:
        # 显式定位到文件尾再取偏移：append 模式刚打开时 tell() 在各平台可能为 0，
        # 拿 0 当偏移会让下次折叠改写文件开头，毁掉整份日志。
        fh.seek(0, os.SEEK_END)
        offset = fh.tell()
        fh.write(payload)
    _last_path = str(path)
    _last_key = key
    _last_ts = now
    _last_offset = offset
    _last_length = len(payload)


def _try_fold_into_last(path: Path, entry: Dict[str, Any], now: int,
                        key: tuple) -> bool:
    """最后一行若是同一条且在折叠窗口内，就把 count 加一并刷新时间。

    只截断并重写最后一行，不读写整个文件（刷屏时每秒命中几十次）。只信内存 `_last_*` 并用文件长度
    校验：对不上说明文件被外部改过或上次写到一半崩了，此时放弃折叠、追加一行，多一行好过写坏日志。
    """
    global _last_ts, _last_length
    if _last_path != str(path):
        return False
    if _last_key is None or _last_key != key or _last_offset < 0:
        return False
    if now - _last_ts > _DEDUPE_WINDOW_SECONDS:
        return False

    try:
        if path.stat().st_size != _last_offset + _last_length:
            _forget_last()
            return False
        with path.open("rb") as fh:
            fh.seek(_last_offset)
            raw = fh.read(_last_length)
    except OSError:
        _forget_last()
        return False

    try:
        last = json.loads(raw.decode("utf-8").strip())
    except (ValueError, UnicodeDecodeError):
        _forget_last()
        return False
    if not isinstance(last, dict):
        _forget_last()
        return False

    try:
        last["count"] = int(last.get("count") or 1) + 1
    except (TypeError, ValueError):
        last["count"] = 2
    last["ts"] = now
    last["at"] = entry["at"]
    # detail 用最新一次的：同一个故障连着发生时，最后一次的上下文离
    # "用户看到问题"最近，比第一次更有参考价值。
    last["detail"] = entry["detail"]

    payload = (json.dumps(last, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        with path.open("r+b") as fh:
            fh.seek(_last_offset)
            fh.write(payload)
            fh.truncate(_last_offset + len(payload))
    except OSError:
        _forget_last()
        return False

    _last_ts = now
    _last_length = len(payload)
    return True


def _truncate(text: str, limit: int = 500) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + "…"


def _rotate_if_needed(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size > MAX_BYTES:
            old = path.with_suffix(path.suffix + ".1")
            old.unlink(missing_ok=True)
            os.replace(path, old)
            # 当前文件被整个搬走了，内存里那个偏移量现在指向一份不存在的文件。
            _forget_last()
    except OSError:
        pass


def _coerce(entry: Any, fallback_index: int) -> Optional[Dict[str, Any]]:
    """把读出的一行整理成完整条目。老版本的行缺 uid/ts/level/count，就地补齐而非丢弃；
    ts 从 `at` 反解，解不出用 0（排最后但可见）。"""
    if not isinstance(entry, dict):
        return None
    at = str(entry.get("at") or "")
    try:
        ts_int = int(entry.get("ts") or 0)
    except (TypeError, ValueError):
        ts_int = 0
    if ts_int <= 0 and at:
        try:
            ts_int = int(time.mktime(time.strptime(at, "%Y-%m-%d %H:%M:%S")))
        except (ValueError, OverflowError):
            ts_int = 0
    try:
        count = max(1, int(entry.get("count") or 1))
    except (TypeError, ValueError):
        count = 1
    return {
        # 老条目没有 uid，用"legacy-<行号>"顶上。它在一次读取内稳定，
        # 足够支撑"选中→删除"这一个来回。
        "uid": str(entry.get("uid") or "legacy-%d" % fallback_index),
        "ts": ts_int,
        "at": at,
        "level": _normalize_level(str(entry.get("level") or _DEFAULT_LEVEL)),
        "module": str(entry.get("module") or ""),
        "problem": str(entry.get("problem") or ""),
        "code": str(entry.get("code") or ""),
        "detail": str(entry.get("detail") or ""),
        "count": count,
    }


def _read_raw(data_dir: Path) -> List[Dict[str, Any]]:
    """两份文件（当前 + 轮转）全读出来，按写入顺序（旧 → 新）返回。"""
    entries: List[Dict[str, Any]] = []
    index = 0
    # 先读轮转出去的那份：它比当前这份旧。顺序反了的话时间线会拧着。
    for candidate in (_rotated_path(data_dir), log_path(data_dir)):
        try:
            if not candidate.exists():
                continue
            with candidate.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        # 一行坏掉不该让整份日志读不出来
                        continue
                    item = _coerce(parsed, index)
                    index += 1
                    if item is not None:
                        entries.append(item)
        except OSError:
            continue
    return entries


def read_all(data_dir: Path, limit: int = MAX_ENTRIES_RETURNED) -> List[dict]:
    """读最近的日志，最新的排前面。"""
    entries = _read_raw(data_dir)
    entries.reverse()
    return entries[:limit]


def query(
    data_dir: Path,
    levels: Optional[Sequence[str]] = None,
    modules: Optional[Sequence[str]] = None,
    search: str = "",
    since: int = 0,
    limit: int = MAX_ENTRIES_RETURNED,
) -> Dict[str, Any]:
    """带筛选地读，筛选放后端做，避免每次改条件都重新序列化整份日志。
    返回值带上筛选前的模块清单和总数，否则下拉框只剩当前筛出的模块，无法切回。"""
    entries = _read_raw(data_dir)
    total = len(entries)
    all_modules = sorted({e["module"] for e in entries if e["module"]})

    wanted_levels = {_normalize_level(x) for x in (levels or [])}
    wanted_modules = {str(x) for x in (modules or []) if str(x)}
    needle = (search or "").strip().lower()

    def keep(entry: Dict[str, Any]) -> bool:
        if wanted_levels and entry["level"] not in wanted_levels:
            return False
        if wanted_modules and entry["module"] not in wanted_modules:
            return False
        if since and entry["ts"] and entry["ts"] < since:
            return False
        if needle:
            haystack = " ".join((
                entry["module"], entry["problem"], entry["code"], entry["detail"],
            )).lower()
            if needle not in haystack:
                return False
        return True

    filtered = [e for e in entries if keep(e)]
    filtered.reverse()
    capped = filtered[: max(1, int(limit or MAX_ENTRIES_RETURNED))]
    return {
        "entries": capped,
        "total": total,
        "matched": len(filtered),
        "modules": all_modules,
        "levels": list(LEVELS),
        "truncated": len(filtered) > len(capped),
    }


def stats(data_dir: Path) -> Dict[str, Any]:
    """按级别 / 模块聚合，外加最常出现的几条，让一屏就能看出问题在哪。"""
    entries = _read_raw(data_dir)
    by_level: Counter = Counter()
    by_module: Counter = Counter()
    problems: Counter = Counter()
    first_ts = 0
    last_ts = 0
    occurrences = 0

    for entry in entries:
        weight = entry["count"]
        occurrences += weight
        by_level[entry["level"]] += weight
        if entry["module"]:
            by_module[entry["module"]] += weight
        problems[(entry["module"], entry["problem"])] += weight
        ts = entry["ts"]
        if ts:
            first_ts = ts if first_ts == 0 else min(first_ts, ts)
            last_ts = max(last_ts, ts)

    top = []
    for (module, problem), count in problems.most_common(8):
        top.append({"module": module, "problem": problem, "count": count})

    return {
        "lines": len(entries),
        "occurrences": occurrences,
        "by_level": {level: by_level.get(level, 0) for level in LEVELS},
        "by_module": [{"module": m, "count": c} for m, c in by_module.most_common()],
        "top_problems": top,
        "first_ts": first_ts,
        "last_ts": last_ts,
    }


def environment() -> Dict[str, Any]:
    """排查报告的环境部分。刻意不含路径、用户名、机器名：报告是要发给别人的，与哪个功能坏了无关。"""
    try:
        release = platform.release()
        version = platform.version()
    except Exception:
        release = version = ""
    return {
        "os": sys.platform,
        "os_release": release,
        "os_version": version,
        "arch": platform.machine() if hasattr(platform, "machine") else "",
        "python": platform.python_version(),
    }


def delete(data_dir: Path, uids: Sequence[str]) -> int:
    """按 uid 删掉若干条，返回真正删掉的条数。

    两份文件（当前 + 轮转）都要过一遍，各自原子替换。空列表什么都不删，
    把空选择当作「全选」是删除类接口最典型的事故。
    """
    wanted = {str(u) for u in (uids or []) if str(u)}
    if not wanted:
        return 0

    removed = 0
    with _lock:
        # 删除会重写文件，偏移量随之失效。放在删之前调，免得中途异常时漏掉。
        _forget_last()
        for candidate in (log_path(data_dir), _rotated_path(data_dir)):
            removed += _delete_from_file(candidate, wanted)
    return removed


def _delete_from_file(path: Path, wanted: set) -> int:
    try:
        if not path.exists():
            return 0
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return 0

    kept: List[str] = []
    removed = 0
    index = 0
    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            # 读不懂的行原样留着：它不是用户勾中的那条。
            kept.append(stripped + "\n")
            continue
        item = _coerce(parsed, index)
        index += 1
        if item is not None and item["uid"] in wanted:
            removed += 1
            continue
        kept.append(stripped + "\n")

    if removed == 0:
        return 0
    try:
        if kept:
            tmp = path.with_suffix(path.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8") as fh:
                fh.writelines(kept)
            os.replace(tmp, path)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        return 0
    return removed


def clear_all(data_dir: Path) -> int:
    """删掉全部日志，返回删掉的条数；真删文件，不做标记删除。"""
    removed = len(_read_raw(data_dir))
    with _lock:
        _forget_last()
        for candidate in (log_path(data_dir), _rotated_path(data_dir)):
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass
    return removed


def build_report(data_dir: Path, limit: int = MAX_ENTRIES_RETURNED) -> str:
    """产出可直接贴出的纯文本排查报告，比让用户去数据目录找 JSONL 更容易真的被发出来。"""
    env = environment()
    summary = stats(data_dir)
    lines: List[str] = []
    lines.append("Tessera diagnostic report")
    lines.append("generated: %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("os: %s %s (%s)" % (env["os"], env["os_release"], env["arch"]))
    lines.append("python: %s" % env["python"])
    lines.append("")
    lines.append("-- summary --")
    lines.append("entries: %d (occurrences: %d)" % (summary["lines"], summary["occurrences"]))
    lines.append("by level: " + ", ".join(
        "%s=%d" % (level, summary["by_level"].get(level, 0)) for level in LEVELS
    ))
    if summary["by_module"]:
        lines.append("by module: " + ", ".join(
            "%s=%d" % (row["module"], row["count"]) for row in summary["by_module"][:12]
        ))
    if summary["top_problems"]:
        lines.append("")
        lines.append("-- most frequent --")
        for row in summary["top_problems"]:
            lines.append("  %4dx [%s] %s" % (row["count"], row["module"], row["problem"]))
    lines.append("")
    lines.append("-- entries (newest first) --")
    for entry in read_all(data_dir, limit):
        suffix = " x%d" % entry["count"] if entry["count"] > 1 else ""
        code = " (%s)" % entry["code"] if entry["code"] else ""
        lines.append("%s  %-5s [%s] %s%s%s" % (
            entry["at"], entry["level"], entry["module"], entry["problem"], code, suffix,
        ))
        if entry["detail"]:
            lines.append("        %s" % entry["detail"])
    return "\n".join(lines) + "\n"
