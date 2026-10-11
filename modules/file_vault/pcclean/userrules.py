"""用户自定义清理规则：一个目录 + 一组通配符 + "多久没动过"。

这是整套清理里最危险的功能（`root=C:\\`、`patterns=["*"]`、`min_age_days=0` 能清空整台机器，
且可能只是手滑），所以规则是拒绝而非警告：
1. 禁止盘符根目录；2. 禁止系统目录（Windows、Program Files、ProgramData、System Volume）；
3. 禁止保险库自己的数据目录；4. 禁止空 pattern 和纯 `*`，须至少带后缀或前缀；
5. 命中的文件逐个进回收站，不整目录删、不硬删（内置清理为速度会整目录删
`_delete_tree_contents`，用户规则不配）。
"""

from __future__ import annotations

import fnmatch
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from modules.file_vault.pcclean import paths
from modules.file_vault.pcclean.model import CleanItem, Importance, ScanReport, ScanTask

RULES_FILE_NAME = "user-rules.json"

MAX_RULES = 50
MAX_ITEMS_PER_RULE = 2000
"""单条规则最多列这么多文件。不是性能考虑，是**可审阅性**：
一屏列出两千条已经没人会看了，超过就说明这条规则写得太宽，
该让用户先收窄而不是让他闭着眼睛点全选。"""

_FORBIDDEN_DIR_PARTS = (
    "\\windows", "\\program files", "\\programdata",
    "\\system volume information", "\\$recycle.bin",
    "\\appdata\\local\\microsoft\\windows",
)


class RuleError(Exception):
    """规则不合法。消息是 i18n 键。"""


def _rules_path(data_dir: Path) -> Path:
    return Path(data_dir) / "pcclean" / RULES_FILE_NAME


def validate_root(root: str, data_dir: Path) -> Path:
    """把用户填的目录校验成可安全清理的绝对路径；每条拒绝对应一种真实的手滑或误解。"""
    raw = (root or "").strip().strip('"')
    if not raw:
        raise RuleError("pcclean.rules.emptyRoot")
    try:
        resolved = Path(os.path.expandvars(raw)).expanduser().resolve()
    except (OSError, ValueError):
        raise RuleError("pcclean.rules.badRoot")

    text = str(resolved).lower().rstrip("\\")
    drive, tail = os.path.splitdrive(str(resolved))
    if not tail.strip("\\/"):
        # `C:\` —— 盘符根。
        raise RuleError("pcclean.rules.driveRootForbidden")

    for part in _FORBIDDEN_DIR_PARTS:
        if part in text + "\\":
            raise RuleError("pcclean.rules.systemPathForbidden")

    try:
        vault = str(Path(data_dir).resolve()).lower()
        # 双向都要挡：既不能清金库目录，也不能清它的上级
        #（清上级会连着把金库一起带走，而用户看到的规则写的是上级目录）。
        if text.startswith(vault) or vault.startswith(text + "\\"):
            raise RuleError("pcclean.rules.vaultPathForbidden")
    except OSError:
        pass

    if not paths.exists(resolved) or not resolved.is_dir():
        raise RuleError("pcclean.rules.rootNotFound")
    return resolved


def validate_patterns(patterns: Sequence[str]) -> List[str]:
    cleaned = [str(p).strip() for p in (patterns or []) if str(p).strip()]
    if not cleaned:
        raise RuleError("pcclean.rules.emptyPattern")
    for pattern in cleaned:
        # `*` 和 `*.*` 等于"这个目录下所有东西"。要那个效果请用系统的删除，
        # 不要用一个名字叫"清理规则"的东西——它会在每次体检时自动跑。
        if pattern in ("*", "*.*", "**"):
            raise RuleError("pcclean.rules.patternTooBroad")
        if any(sep in pattern for sep in ("\\", "/")):
            raise RuleError("pcclean.rules.patternHasPath")
    return cleaned


def load_rules(data_dir: Path) -> List[Dict[str, Any]]:
    path = _rules_path(data_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rules = data.get("rules") if isinstance(data, dict) else None
    return [r for r in (rules or []) if isinstance(r, dict)]


def save_rules(data_dir: Path, rules: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    path = _rules_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "rules": list(rules)[:MAX_RULES]}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return payload["rules"]


def upsert_rule(data_dir: Path, rule: Dict[str, Any]) -> List[Dict[str, Any]]:
    """新增或改一条规则；校验在这里做而非扫描时，否则非法规则留在文件里等后续版本去踩。"""
    root = validate_root(str(rule.get("root") or ""), data_dir)
    patterns = validate_patterns(rule.get("patterns") or [])
    try:
        min_age = max(0.0, float(rule.get("min_age_days", 7)))
    except (TypeError, ValueError):
        raise RuleError("pcclean.rules.badAge")

    entry = {
        "rule_id": str(rule.get("rule_id") or f"user-{uuid.uuid4().hex[:8]}"),
        "label": str(rule.get("label") or root.name)[:80],
        "root": str(root),
        "patterns": patterns,
        "min_age_days": min_age,
        "recursive": bool(rule.get("recursive", False)),
        "enabled": bool(rule.get("enabled", True)),
    }
    rules = [r for r in load_rules(data_dir) if r.get("rule_id") != entry["rule_id"]]
    if len(rules) >= MAX_RULES:
        raise RuleError("pcclean.rules.tooMany")
    rules.append(entry)
    return save_rules(data_dir, rules)


def remove_rule(data_dir: Path, rule_id: str) -> List[Dict[str, Any]]:
    rules = [r for r in load_rules(data_dir) if r.get("rule_id") != rule_id]
    return save_rules(data_dir, rules)


def scan_custom(task: ScanTask, *, data_dir: Path) -> ScanReport:
    """按用户规则扫；每个命中文件是一条独立条目，不整目录打包，让用户看清到底删哪些文件。"""
    rules = [r for r in load_rules(data_dir) if r.get("enabled", True)]
    if not rules:
        return task.report([])

    items: List[CleanItem] = []
    errors: List[str] = []
    truncated = False
    now = time.time()

    for rule in rules:
        if task.cancelled():
            break
        try:
            root = validate_root(str(rule.get("root") or ""), data_dir)
            patterns = validate_patterns(rule.get("patterns") or [])
        except RuleError as exc:
            # 规则存入后目录被删或被改成系统路径会走到这里；如实报出，静默跳过会让用户困惑"设了规则却什么
            # 都没扫到"。
            errors.append(f"{rule.get('rule_id')}:{exc}")
            continue

        min_age_s = float(rule.get("min_age_days") or 0) * 86400.0
        recursive = bool(rule.get("recursive"))
        found = 0

        if recursive:
            walker = paths.iter_files(root, should_cancel=task.cancelled)
        else:
            def _shallow():
                try:
                    for entry in root.iterdir():
                        try:
                            if entry.is_file():
                                yield entry, entry.stat().st_size
                        except OSError:
                            continue
                except OSError:
                    return
            walker = _shallow()

        for file_path, size in walker:
            if task.cancelled():
                break
            if not any(fnmatch.fnmatch(file_path.name.lower(), p.lower())
                       for p in patterns):
                continue
            try:
                age_s = now - file_path.stat().st_mtime
            except OSError:
                continue
            # `min_age_s > 0` 这个前置判断不能省：Windows 的 `time.time()` 分辨率 15.625 毫秒，
            # 刚写完的文件 mtime 可能晚于随后取到的 `now`（实测约 14%），`age_s < 0.0` 会使其被静默跳过，
            # 表现为 `min_age_days: 0` 的规则时有时无地漏文件。`junk.py` 已是 `min_age_days > 0 and ...`。
            if min_age_s > 0 and age_s < min_age_s:
                continue
            if found >= MAX_ITEMS_PER_RULE:
                truncated = True
                break
            found += 1
            items.append(CleanItem(
                item_id=f"custom:{file_path}",
                category="custom",
                label=file_path.name,
                size_bytes=size,
                path=str(file_path),
                # 永远 OPTIONAL、默认不勾选：用户自写规则我们无从判断匹配到的东西重不重要，规则写宽的后果不该
                # 由"替他勾上"承担。
                importance=Importance.OPTIONAL,
                reason="pcclean.custom.matchedRule",
                default_selected=False,
                detail={
                    "rule_id": rule.get("rule_id"),
                    "rule_label": rule.get("label"),
                    "age_days": int(age_s / 86400),
                },
            ))

    return task.report(items, truncated=truncated, errors=errors)
