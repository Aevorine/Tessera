"""Recovery codes ("恢复码"): third-party 2FA/account backup codes.

Encrypted like passwords.py: the whole list as one JSON blob under a fresh per-save File Key
wrapped by the IMK (not the SQLCipher per-row scheme; the data is small).
Unrelated to this app's own master recovery key (identity.py SLOT_RECOVERY, "恢复密钥").
"""

import base64
import csv
import hashlib
import io
import json
import re
import time
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from modules.file_vault import crypto
from modules.file_vault.errors import VaultError

VAULT_FILENAME = "recovery_codes.vault"
FORMAT_VERSION = 1

MAX_IMPORT_FILE_SIZE = 1024 * 1024  # 1 MiB, spec 3.1.4 / 9

# JSON 导出上限 4 MiB（100 服务 × 16 码的 v2 明文约 90 KiB，余量四十倍）。
# 上限本身才是重点：导入文件是不可信输入，`json.loads` 会把整份读进内存，不设限可被撑爆进程。
MAX_JSON_IMPORT_FILE_SIZE = 4 * 1024 * 1024
MAX_IMPORT_HISTORY = 50  # keep newest N per service; unbounded growth serves no purpose

DEFAULT_LOW_STOCK_THRESHOLD = 3
DEFAULT_REVIEW_INTERVAL_DAYS = 180

UNDO_WINDOW_SECONDS = 10

# 每组最多留多少条修改记录。恢复码一组十几个码，一条快照不到 1 KiB，60 条足够
# 覆盖"用掉一个标一个"的整个生命周期，又不会让金库随时间无限变大。
MAX_REVISIONS_PER_GROUP = 60
# 被删除的组的时间线另存一个加密旁文件（DELETED_VAULT_FILENAME），最多留这么多组。
MAX_DELETED_GROUP_RECORDS = 50
DELETED_VAULT_FILENAME = "recovery_codes_deleted.vault"


class RecoveryCodeVaultError(VaultError):
    """recovery_codes.vault exists but couldn't be decrypted/parsed as a
    whole, or an imported file/line failed validation."""


# Per-service format rules (spec section 7): a plain constant table; adding a platform is one entry.
@dataclass(frozen=True)
class ServiceRule:
    key: str
    display_name: str
    filename_pattern: "re.Pattern"
    code_pattern: "re.Pattern"
    expected_count: Optional[int]


SERVICE_RULES: Tuple[ServiceRule, ...] = (
    ServiceRule(
        key="github",
        display_name="GitHub",
        filename_pattern=re.compile(r"^github-recovery-codes(?:\s*\(\d+\))?\.txt$", re.IGNORECASE),
        code_pattern=re.compile(r"^[0-9a-z]{5}-[0-9a-z]{5}$", re.IGNORECASE),
        expected_count=16,
    ),
)

_DEFAULT_CODE_PATTERN = re.compile(r"^[0-9a-zA-Z-]{4,32}$")


def detect_service_rule(filename: str) -> Optional[ServiceRule]:
    for rule in SERVICE_RULES:
        if rule.filename_pattern.match(filename):
            return rule
    return None


def rule_by_key(key: str) -> Optional[ServiceRule]:
    for rule in SERVICE_RULES:
        if rule.key == key:
            return rule
    return None


_UNSAFE_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


def sanitize_source_filename(raw_filename: str) -> str:
    """Strips directory components and unsafe characters from a stored filename (defense in depth,
    spec 9)."""
    name = Path(raw_filename).name
    name = _UNSAFE_FILENAME_CHARS.sub("_", name).strip()
    return name[:255] if name else "unknown"


def validate_import_file_size(path: Path) -> None:
    if path.stat().st_size > MAX_IMPORT_FILE_SIZE:
        raise RecoveryCodeVaultError("recovery_codes.file_too_large")


def validate_json_import_file_size(path: Path) -> None:
    """JSON 导入路径的大小闸门。理由见 MAX_JSON_IMPORT_FILE_SIZE。"""
    if path.stat().st_size > MAX_JSON_IMPORT_FILE_SIZE:
        raise RecoveryCodeVaultError("recovery_codes.file_too_large")


# --- Records ---

@dataclass
class RecoveryCode:
    code: str
    used: bool = False
    used_at: Optional[float] = None


@dataclass
class ImportHistoryEntry:
    action: str  # "import" | "update" | "mark_used" | "export" | "backup_restore"
    timestamp: float
    change_summary: str


@dataclass
class RecoveryCodeGroup:
    id: str
    service: str
    account_label: str
    source_file_name: str
    codes: List[RecoveryCode]
    first_imported_at: float
    last_updated_at: float
    last_checked_at: float
    low_stock_threshold: int = DEFAULT_LOW_STOCK_THRESHOLD
    review_interval_days: int = DEFAULT_REVIEW_INTERVAL_DAYS
    import_history: List[ImportHistoryEntry] = field(default_factory=list)
    note: str = ""
    # 修改时间线：每条是这一组在某次改动之后的完整样子（含明文码），按时间从旧到新。
    # 只随金库本体加密落盘，不进任何导出/备份——见 _group_to_storage_json。
    revisions: List[dict] = field(default_factory=list)

    def to_rpc_json(self) -> dict:
        """Masked view: no `code` plaintext, only `index`/`used`/`usedAt` (as every RPC except
        recovery_codes_reveal). `index` is stable (never reordered) and is how mark_used addresses a code.
        """
        return {
            "id": self.id,
            "service": self.service,
            "accountLabel": self.account_label,
            "sourceFileName": self.source_file_name,
            "codes": [{"index": i, "used": c.used, "usedAt": c.used_at} for i, c in enumerate(self.codes)],
            "firstImportedAt": self.first_imported_at,
            "lastUpdatedAt": self.last_updated_at,
            "lastCheckedAt": self.last_checked_at,
            "lowStockThreshold": self.low_stock_threshold,
            "reviewIntervalDays": self.review_interval_days,
            "importHistory": [
                {"action": h.action, "timestamp": h.timestamp, "changeSummary": h.change_summary}
                for h in self.import_history
            ],
            "note": self.note,
            "remainingCount": remaining_count(self),
            "isLowStock": is_low_stock(self),
            "needsReview": needs_review(self),
        }


@dataclass(frozen=True)
class DamagedRecord:
    """A record whose checksum failed or whose shape was unreadable at load time; reported separately
    so one corrupted/tampered entry never takes down the rest of the vault (spec 3.2/9).
    """
    raw_index: int
    raw_service: Optional[str]
    reason: str

    def to_rpc_json(self) -> dict:
        return {"index": self.raw_index, "service": self.raw_service, "reason": self.reason}


def remaining_count(g: RecoveryCodeGroup) -> int:
    return sum(1 for c in g.codes if not c.used)


def is_low_stock(g: RecoveryCodeGroup) -> bool:
    return remaining_count(g) <= g.low_stock_threshold


def needs_review(g: RecoveryCodeGroup, *, now: Optional[float] = None) -> bool:
    now = time.time() if now is None else now
    return (now - g.last_checked_at) >= g.review_interval_days * 86400


def find_group(groups: List[RecoveryCodeGroup], *, group_id: str) -> Optional[RecoveryCodeGroup]:
    for g in groups:
        if g.id == group_id:
            return g
    return None


def find_group_by_identity(groups: List[RecoveryCodeGroup], *, service: str, account_label: str) -> Optional[RecoveryCodeGroup]:
    for g in groups:
        if g.service == service and g.account_label == account_label:
            return g
    return None


def new_group(*, service: str, account_label: str, source_file_name: str, codes: List[str]) -> RecoveryCodeGroup:
    now = time.time()
    return RecoveryCodeGroup(
        id=str(uuid.uuid4()),
        service=service,
        account_label=account_label,
        source_file_name=sanitize_source_filename(source_file_name),
        codes=[RecoveryCode(code=c) for c in codes],
        first_imported_at=now,
        last_updated_at=now,
        last_checked_at=now,
        import_history=[ImportHistoryEntry(action="import", timestamp=now, change_summary=f"首次导入{len(codes)}个密钥")],
    )


# --- Import parsing (spec 3.1) ---

@dataclass(frozen=True)
class ParsedImportLine:
    line_number: int
    raw: str
    code: Optional[str]  # normalized code, or None if this line is malformed
    valid: bool


def parse_code_lines(text: str, code_pattern: "re.Pattern" = _DEFAULT_CODE_PATTERN) -> List[ParsedImportLine]:
    """Splits text into lines, drops blank and '#' header lines, validates the rest against
    code_pattern.

    Never raises: a bad line is flagged with its 1-based number (spec 3.1.3) for the import preview.
    '#' lines are skipped because export_text writes one per service as a group header.
    """
    results: List[ParsedImportLine] = []
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        valid = bool(code_pattern.match(stripped))
        results.append(ParsedImportLine(line_number=line_no, raw=stripped, code=stripped if valid else None, valid=valid))
    return results


def dedupe_codes(codes: List[str]) -> List[str]:
    """Removes duplicate codes within a single import, preserving first-seen order."""
    seen = set()
    result = []
    for c in codes:
        if c not in seen:
            seen.add(c)
            result.append(c)
    return result


# Multi-group import (spec 3.1/3.3): exports group by service+account, so import must split back
# into the same groups, otherwise re-importing silently merges accounts.

_GROUP_HEADER_PATTERN = re.compile(r"^#\s*(.+?)(?:\s*\(([^()]*)\))?\s*$")


@dataclass(frozen=True)
class ParsedGroup:
    """One service's codes from an import. A file without '# service (account)' headers yields one group
    with service="" that the caller fills in, so single-service files round-trip unchanged.
    """
    service: str
    account_label: str
    codes: List[str]
    invalid_lines: List[ParsedImportLine]


def parse_grouped_text(text: str, code_pattern: "re.Pattern" = _DEFAULT_CODE_PATTERN) -> List[ParsedGroup]:
    """Splits TXT import text on '# service (account)' headers (export_text's format) into ParsedGroups;
    text before the first header becomes an unlabeled leading group.
    """
    blocks: List[list] = []  # each: [service, account_label, raw_lines]
    current: Optional[list] = None
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        header = _GROUP_HEADER_PATTERN.match(stripped) if stripped.startswith("#") else None
        if header:
            if current is not None:
                blocks.append(current)
            current = [header.group(1).strip(), (header.group(2) or "").strip(), []]
        else:
            if current is None:
                current = ["", "", []]
            current[2].append(raw_line)
    if current is not None:
        blocks.append(current)

    groups: List[ParsedGroup] = []
    for service, account_label, raw_lines in blocks:
        parsed = parse_code_lines("\n".join(raw_lines), code_pattern)
        codes = dedupe_codes([p.code for p in parsed if p.valid])
        invalid = [p for p in parsed if not p.valid]
        if not codes and not invalid:
            continue  # empty block (e.g. a header immediately followed by another header)
        groups.append(ParsedGroup(service=service, account_label=account_label, codes=codes, invalid_lines=invalid))
    return groups


def parse_csv_groups(text: str) -> List[ParsedGroup]:
    """Parses export_csv rows back into groups keyed by (service, account_label) in first-seen order;
    raises if the header row isn't ours (no sensible per-row fallback).
    """
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = set(reader.fieldnames or [])
    if not {"service", "account_label", "code"}.issubset(fieldnames):
        raise RecoveryCodeVaultError("recovery_codes.invalid_csv_format")

    order: List[Tuple[str, str]] = []
    codes_by_key: Dict[Tuple[str, str], List[str]] = {}
    invalid_by_key: Dict[Tuple[str, str], List[ParsedImportLine]] = {}
    for row_no, row in enumerate(reader, start=2):  # row 1 is the header
        service = (row.get("service") or "").strip()
        account_label = (row.get("account_label") or "").strip()
        code = (row.get("code") or "").strip()
        key = (service, account_label)
        if key not in codes_by_key:
            order.append(key)
            codes_by_key[key] = []
            invalid_by_key[key] = []
        if code and _DEFAULT_CODE_PATTERN.match(code):
            codes_by_key[key].append(code)
        else:
            invalid_by_key[key].append(ParsedImportLine(line_number=row_no, raw=code or ",".join(row.values()), code=None, valid=False))

    return [
        ParsedGroup(service=service, account_label=account_label, codes=dedupe_codes(codes_by_key[(service, account_label)]), invalid_lines=invalid_by_key[(service, account_label)])
        for service, account_label in order
    ]


def parse_json_groups(text: str) -> List[ParsedGroup]:
    """Parses a JSON export (v1 array or v2 envelope) into codes-only groups for parse_import_text.

    Deliberately lossy (used, notes, thresholds, history dropped); the lossless path is
    parse_json_export() + the json_import_* RPCs.
    """
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format") from exc
    if isinstance(payload, dict):
        if payload.get("encrypted"):
            # 加密导出没有密码就是解不开的。报一个专门的码，而不是含糊的
            # "格式不对"——用户拿的文件没问题，只是走错了入口。
            raise RecoveryCodeVaultError("recovery_codes.json_password_required")
        payload = payload.get("groups")
    if not isinstance(payload, list):
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")

    groups: List[ParsedGroup] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        service = str(entry.get("service") or "").strip()
        account_label = str(entry.get("accountLabel") or "").strip()
        raw_codes = entry.get("codes")
        codes: List[str] = []
        invalid: List[ParsedImportLine] = []
        if isinstance(raw_codes, list):
            for i, c in enumerate(raw_codes, start=1):
                code = c.get("code") if isinstance(c, dict) else None
                if isinstance(code, str) and _DEFAULT_CODE_PATTERN.match(code.strip()):
                    codes.append(code.strip())
                else:
                    invalid.append(ParsedImportLine(line_number=i, raw=str(code), code=None, valid=False))
        if not codes and not invalid:
            continue
        groups.append(ParsedGroup(service=service, account_label=account_label, codes=dedupe_codes(codes), invalid_lines=invalid))
    if not groups:
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")
    return groups


def detect_import_format(filename: str) -> str:
    """Picks the parser by file extension; the three formats don't need content sniffing."""
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        return "csv"
    if suffix == ".json":
        return "json"
    return "txt"


def parse_import_text(text: str, fmt: str, code_pattern: "re.Pattern" = _DEFAULT_CODE_PATTERN) -> List[ParsedGroup]:
    """RPC entry point: dispatches to the parser for the detected format; TXT (incl. plain OCR/clipboard
    text) goes through parse_grouped_text, degrading to one unlabeled group without '#' headers.
    """
    if fmt == "csv":
        return parse_csv_groups(text)
    if fmt == "json":
        return parse_json_groups(text)
    return parse_grouped_text(text, code_pattern)


def diff_import(existing: Optional[RecoveryCodeGroup], new_codes: List[str]) -> str:
    """Returns "new" | "unchanged" | "changed", comparing a candidate
    import's code SET against an existing group's current codes (hash-set
    comparison per spec 3.1.5 - order doesn't matter, only membership)."""
    if existing is None:
        return "new"
    existing_set = {c.code for c in existing.codes}
    return "unchanged" if existing_set == set(new_codes) else "changed"


# --- Encrypted storage (mirrors passwords.py's envelope exactly) ---

def vault_path(data_dir: Path) -> Path:
    return Path(data_dir) / VAULT_FILENAME


def _content_checksum(service: str, account_label: str, codes: List[RecoveryCode]) -> str:
    payload = json.dumps(
        {
            "service": service,
            "account_label": account_label,
            "codes": [{"code": c.code, "used": c.used, "used_at": c.used_at} for c in codes],
        },
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _group_to_storage_json(g: RecoveryCodeGroup, *, include_revisions: bool = False) -> dict:
    """include_revisions 只有写金库本体时才为 True。完整备份也走这个函数，
    但备份是要带出本机的文件，修改时间线（里面是每一版的明文码）不该跟着走。"""
    d = {
        "id": g.id,
        "service": g.service,
        "account_label": g.account_label,
        "source_file_name": g.source_file_name,
        "codes": [{"code": c.code, "used": c.used, "used_at": c.used_at} for c in g.codes],
        "first_imported_at": g.first_imported_at,
        "last_updated_at": g.last_updated_at,
        "last_checked_at": g.last_checked_at,
        "low_stock_threshold": g.low_stock_threshold,
        "review_interval_days": g.review_interval_days,
        "import_history": [
            {"action": h.action, "timestamp": h.timestamp, "change_summary": h.change_summary}
            for h in g.import_history[-MAX_IMPORT_HISTORY:]
        ],
        "note": g.note,
        "checksum": _content_checksum(g.service, g.account_label, g.codes),
    }
    if include_revisions and g.revisions:
        d["revisions"] = g.revisions[-MAX_REVISIONS_PER_GROUP:]
    return d


def _group_from_storage_json(d, index: int) -> "Tuple[Optional[RecoveryCodeGroup], Optional[DamagedRecord]]":
    """Returns (group, None), or (None, DamagedRecord) if this one record is unreadable or fails its
    checksum. The broad except is deliberate: any failure must isolate to "damaged", never propagate.
    """
    raw_service = d.get("service") if isinstance(d, dict) else None
    try:
        if not isinstance(d, dict):
            raise ValueError("not a dict")
        service = d["service"]
        account_label = d.get("account_label", "")
        if not isinstance(service, str) or not isinstance(account_label, str):
            raise ValueError("service/account_label not text")
        codes = []
        for c in d["codes"]:
            code = c["code"]
            if not isinstance(code, str):
                raise ValueError("code not text")
            codes.append(RecoveryCode(code=code, used=bool(c.get("used", False)), used_at=c.get("used_at")))

        stored_checksum = d.get("checksum")
        if stored_checksum != _content_checksum(service, account_label, codes):
            return None, DamagedRecord(raw_index=index, raw_service=service, reason="recovery_codes.checksum_mismatch")

        group = RecoveryCodeGroup(
            id=d["id"],
            service=service,
            account_label=account_label,
            source_file_name=d.get("source_file_name", ""),
            codes=codes,
            first_imported_at=d["first_imported_at"],
            last_updated_at=d["last_updated_at"],
            last_checked_at=d.get("last_checked_at", d["last_updated_at"]),
            low_stock_threshold=d.get("low_stock_threshold", DEFAULT_LOW_STOCK_THRESHOLD),
            review_interval_days=d.get("review_interval_days", DEFAULT_REVIEW_INTERVAL_DAYS),
            import_history=[ImportHistoryEntry(**h) for h in d.get("import_history", [])],
            note=d.get("note", ""),
            # 时间线不参与校验值，读坏了也只丢时间线，不连累这一组本身。
            revisions=_clean_revisions(d.get("revisions")),
        )
        return group, None
    except Exception:
        return None, DamagedRecord(raw_index=index, raw_service=raw_service, reason="recovery_codes.content_corrupted")


def _validate_format_version(blob: dict) -> int:
    if "format_version" not in blob:
        raise RecoveryCodeVaultError("recovery_codes.invalid_format")
    version = blob["format_version"]
    if type(version) is not int:
        raise RecoveryCodeVaultError("recovery_codes.invalid_format")
    if version != FORMAT_VERSION:
        raise RecoveryCodeVaultError("recovery_codes.unsupported_format_version")
    return version


def load_recovery_codes_vault(data_dir: Path, imk: bytes) -> "Tuple[List[RecoveryCodeGroup], List[DamagedRecord]]":
    """Returns ([], []) if the vault file doesn't exist. Raises RecoveryCodeVaultError if the outer
    envelope can't be decrypted (all-or-nothing); a single damaged record is returned in the second
    list instead.
    """
    path = vault_path(data_dir)
    if not path.exists():
        return [], []
    raw_text = path.read_text(encoding="utf-8")
    try:
        blob = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise RecoveryCodeVaultError("recovery_codes.invalid_format") from exc
    if type(blob) is not dict:
        raise RecoveryCodeVaultError("recovery_codes.invalid_format")

    _validate_format_version(blob)

    try:
        fk_nonce = base64.b64decode(blob["fk_wrap"]["nonce"])
        wrapped_fk = base64.b64decode(blob["fk_wrap"]["wrapped_fk"])
        content_nonce = base64.b64decode(blob["nonce"])
        ciphertext = base64.b64decode(blob["ciphertext"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.invalid_format") from exc

    try:
        fk = crypto.unwrap_key(imk, fk_nonce, wrapped_fk)
        plaintext = crypto.aead_decrypt(fk, content_nonce, ciphertext)
    except crypto.InvalidTag as exc:
        raise RecoveryCodeVaultError("recovery_codes.key_mismatch") from exc

    try:
        records = json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.content_corrupted") from exc
    if type(records) is not list:
        raise RecoveryCodeVaultError("recovery_codes.content_corrupted")

    groups: List[RecoveryCodeGroup] = []
    damaged: List[DamagedRecord] = []
    for i, d in enumerate(records):
        group, bad = _group_from_storage_json(d, i)
        if group is not None:
            groups.append(group)
        else:
            damaged.append(bad)
    return groups, damaged


def save_recovery_codes_vault(data_dir: Path, groups: List[RecoveryCodeGroup], imk: bytes) -> None:
    """Re-encrypts and rewrites the whole vault with a fresh File Key (as passwords.py/container.py).

    The previous version is first copied to a '.prev' snapshot (spec 3.2) for restore_previous_snapshot,
    a longer-lived net than the RPC layer's 10-second undo.
    """
    serialized = [_group_to_storage_json(g, include_revisions=True) for g in groups]

    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
    content_nonce = crypto.random_nonce()
    plaintext = json.dumps(serialized, ensure_ascii=False).encode("utf-8")
    ciphertext = crypto.aead_encrypt(fk, content_nonce, plaintext)

    blob = {
        "format_version": FORMAT_VERSION,
        "fk_wrap": {
            "nonce": base64.b64encode(fk_nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
        },
        "nonce": base64.b64encode(content_nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }

    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    path = vault_path(data_dir)

    if path.exists():
        snapshot_path = path.with_name(path.name + ".prev")
        snapshot_path.write_bytes(path.read_bytes())

    tmp_path = path.with_name(path.name + ".part")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    tmp_path.replace(path)


def restore_previous_snapshot(data_dir: Path) -> bool:
    """Restores recovery_codes.vault from its immediate pre-save snapshot.
    Returns False if no snapshot exists (e.g. this is the first save ever)."""
    path = vault_path(data_dir)
    snapshot_path = path.with_name(path.name + ".prev")
    if not snapshot_path.exists():
        return False
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_bytes(snapshot_path.read_bytes())
    tmp_path.replace(path)
    return True


def export_text(groups: List[RecoveryCodeGroup]) -> str:
    """Plain-text export: one service header line, its codes, blank line
    between services - matches the plain original format spec 3.3 asks for
    (round-trippable back through parse_code_lines)."""
    blocks = []
    for g in groups:
        header = f"# {g.service} ({g.account_label})" if g.account_label else f"# {g.service}"
        lines = [header] + [c.code for c in g.codes]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def export_csv(groups: List[RecoveryCodeGroup]) -> str:
    """CSV export: service, account_label, code, used, used_at, one code per row."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["service", "account_label", "code", "used", "used_at"])
    for g in groups:
        for c in g.codes:
            w.writerow([g.service, g.account_label, c.code, "1" if c.used else "0", c.used_at or ""])
    return buf.getvalue()


EXPORT_FORMATS = {"txt", "csv", "json"}


# JSON 导出 v2。v1 是裸数组，有两个问题：
#   1. 往返丢数据：`used`/`usedAt` 写出后从未被读回（parse_json_groups 只取 `code`），
#      "已用"标记全部复活成未用，让人误以为还有一堆可用的码。
#   2. 无版本号、校验、id，文件被改或格式演进时无从察觉。
# v2 是带信封的对象（类型、版本、导出时间、是否加密、整体校验值），每组带内容校验值和全部元数
# 据，往返无损。
# 读时两种都认（v1 只读不写）；`formatVersion` 高于本版本时明确报错，不猜着解析（猜错会把新备
# 份当损坏丢掉）。

JSON_FORMAT_MARKER = "tessera-recovery-codes"
JSON_FORMAT_VERSION = 2

# 加密导出的 AEAD/KDF 跟完整备份完全一致（见 export_full_backup 的说明），
# 这里只是把内层换成 v2 的结构。
JSON_CIPHER = "AES-256-GCM"
JSON_KDF = "scrypt"


def _canonical_json(obj) -> str:
    """校验值须基于确定字节序列：sort_keys、紧凑分隔符、ensure_ascii=False 缺一则同一内容算出两个值。"""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def payload_checksum(groups_json: List[dict]) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(groups_json).encode("utf-8")).hexdigest()


def _group_to_export_json(g: RecoveryCodeGroup, *, include_codes: bool) -> dict:
    """v2 的一组，字段名小驼峰（同 to_rpc_json 与所有 RPC）。

    include_codes=False 为脱敏导出：保留每个码的位置和是否用过，不写 `code`，用于把清单给别人看而
    不交出绕过两步验证的后门。
    """
    codes = []
    for i, c in enumerate(g.codes):
        entry = {"index": i, "used": c.used, "usedAt": c.used_at}
        if include_codes:
            entry["code"] = c.code
            entry["suspect"] = is_suspect_code(c.code)
        codes.append(entry)
    return {
        "id": g.id,
        "service": g.service,
        "accountLabel": g.account_label,
        "sourceFileName": g.source_file_name,
        "note": g.note,
        "lowStockThreshold": g.low_stock_threshold,
        "reviewIntervalDays": g.review_interval_days,
        "firstImportedAt": g.first_imported_at,
        "lastUpdatedAt": g.last_updated_at,
        "lastCheckedAt": g.last_checked_at,
        "remainingCount": remaining_count(g),
        # 逐组校验：一组被改坏不该连累其余的（同 _group_from_storage_json 的
        # 降级策略）。脱敏导出算不出它——码本身不在文件里——所以那种情况下不写。
        "contentChecksum": _content_checksum(g.service, g.account_label, g.codes) if include_codes else None,
        "codes": codes,
        "importHistory": [
            {"action": h.action, "timestamp": h.timestamp, "changeSummary": h.change_summary}
            for h in g.import_history[-MAX_IMPORT_HISTORY:]
        ],
    }


def _group_from_export_json(d, index: int) -> "Tuple[Optional[RecoveryCodeGroup], Optional[DamagedRecord]]":
    """v2/v1 的一组 → RecoveryCodeGroup；失败返回 DamagedRecord。宽进：缺失字段补默认值；
    严出：码非字符串或 contentChecksum 对不上即判损坏（文件被动过）。
    """
    raw_service = d.get("service") if isinstance(d, dict) else None
    try:
        if not isinstance(d, dict):
            raise ValueError("not a dict")
        service = str(d.get("service") or "")
        account_label = str(d.get("accountLabel") or "")

        raw_codes = d.get("codes")
        if not isinstance(raw_codes, list):
            raise ValueError("codes not a list")
        codes: List[RecoveryCode] = []
        redacted = False
        for c in raw_codes:
            if not isinstance(c, dict):
                raise ValueError("code entry not a dict")
            code = c.get("code")
            if code is None:
                redacted = True
                continue
            if not isinstance(code, str):
                raise ValueError("code not text")
            codes.append(RecoveryCode(code=code, used=bool(c.get("used", False)), used_at=c.get("usedAt")))
        if redacted and not codes:
            return None, DamagedRecord(raw_index=index, raw_service=raw_service,
                                       reason="recovery_codes.json_codes_redacted")
        if not codes:
            raise ValueError("no codes")

        stored = d.get("contentChecksum")
        if stored is not None and stored != _content_checksum(service, account_label, codes):
            return None, DamagedRecord(raw_index=index, raw_service=service,
                                       reason="recovery_codes.checksum_mismatch")

        now = time.time()
        first_imported = _as_float(d.get("firstImportedAt"), now)
        group = RecoveryCodeGroup(
            id=str(d.get("id") or uuid.uuid4()),
            service=service,
            account_label=account_label,
            source_file_name=str(d.get("sourceFileName") or ""),
            codes=codes,
            first_imported_at=first_imported,
            last_updated_at=_as_float(d.get("lastUpdatedAt"), first_imported),
            last_checked_at=_as_float(d.get("lastCheckedAt"), first_imported),
            low_stock_threshold=_as_int(d.get("lowStockThreshold"), DEFAULT_LOW_STOCK_THRESHOLD),
            review_interval_days=_as_int(d.get("reviewIntervalDays"), DEFAULT_REVIEW_INTERVAL_DAYS),
            import_history=[
                ImportHistoryEntry(
                    action=str(h.get("action", "import")),
                    timestamp=_as_float(h.get("timestamp"), first_imported),
                    change_summary=str(h.get("changeSummary", "")),
                )
                for h in (d.get("importHistory") or [])
                if isinstance(h, dict)
            ][-MAX_IMPORT_HISTORY:],
            note=str(d.get("note") or ""),
        )
        return group, None
    except Exception:
        return None, DamagedRecord(raw_index=index, raw_service=raw_service,
                                   reason="recovery_codes.content_corrupted")


def _as_float(value, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _as_int(value, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def build_export_payload(
    groups: List[RecoveryCodeGroup],
    *,
    app_version: str = "",
    exported_at: Optional[float] = None,
    include_codes: bool = True,
) -> dict:
    """v2 信封（明文形态）。加密导出把这一份整个塞进密文里。"""
    groups_json = [_group_to_export_json(g, include_codes=include_codes) for g in groups]
    return {
        "format": JSON_FORMAT_MARKER,
        "formatVersion": JSON_FORMAT_VERSION,
        # 单次导出共用一个时间戳，不是每组各取 time.time()，否则文件之间无法直接比对。
        "exportedAt": time.time() if exported_at is None else exported_at,
        "appVersion": app_version,
        "encrypted": False,
        "codesRedacted": not include_codes,
        "checksum": payload_checksum(groups_json),
        "stats": {
            "groupCount": len(groups),
            "codeCount": sum(len(g.codes) for g in groups),
            "unusedCount": sum(remaining_count(g) for g in groups),
        },
        "groups": groups_json,
    }


def export_json(
    groups: List[RecoveryCodeGroup],
    *,
    app_version: str = "",
    exported_at: Optional[float] = None,
    include_codes: bool = True,
) -> str:
    """结构化 JSON 导出（v2）。缩进 2 空格：这份文件是给人看也给机器读的。"""
    return json.dumps(
        build_export_payload(
            groups, app_version=app_version, exported_at=exported_at, include_codes=include_codes
        ),
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def export_json_encrypted(
    groups: List[RecoveryCodeGroup],
    password: str,
    *,
    app_version: str = "",
    exported_at: Optional[float] = None,
) -> str:
    """加密形态的 v2 导出。

    外层是可读 JSON（类型、版本、加密参数），内层密文是完整 v2 信封。密码独立于金库 IMK（同
    export_full_backup），
    泄露备份不应连带能开活库。信封里不写 stats 和服务名（"我在哪些网站有账号"本身需保护），
    代价是输入密码前预览不出规模。
    """
    payload = build_export_payload(
        groups, app_version=app_version, exported_at=exported_at, include_codes=True
    )
    salt = crypto.random_salt()
    kek = crypto.derive_key_scrypt(password.encode("utf-8"), salt)
    nonce = crypto.random_nonce()
    ciphertext = crypto.aead_encrypt(kek, nonce, _canonical_json(payload).encode("utf-8"))
    blob = {
        "format": JSON_FORMAT_MARKER,
        "formatVersion": JSON_FORMAT_VERSION,
        "encrypted": True,
        "exportedAt": payload["exportedAt"],
        "appVersion": app_version,
        "cipher": JSON_CIPHER,
        # 参数跟着文件走。导出文件可能躺在只读介质上，永远没有机会被重新封装，
        # 所以"当年用的是什么参数"只有它自己记得住（同 export_full_backup）。
        "kdf": {
            "algorithm": JSON_KDF,
            "n": crypto.SCRYPT_N,
            "r": crypto.SCRYPT_R,
            "p": crypto.SCRYPT_P,
            "salt": base64.b64encode(salt).decode(),
        },
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
    return json.dumps(blob, ensure_ascii=False, indent=2) + "\n"


@dataclass(frozen=True)
class JsonExportMeta:
    """一份 JSON 导出文件的信封信息，供导入预览显示。"""
    format_version: int
    encrypted: bool
    codes_redacted: bool
    exported_at: Optional[float]
    app_version: str
    # None 表示这份文件里根本没有整体校验值（v1 就没有），不是"校验没过"。
    checksum_ok: Optional[bool]

    def to_rpc_json(self) -> dict:
        return {
            "formatVersion": self.format_version,
            "encrypted": self.encrypted,
            "codesRedacted": self.codes_redacted,
            "exportedAt": self.exported_at,
            "appVersion": self.app_version,
            "checksumOk": self.checksum_ok,
        }


def _decrypt_json_export(blob: dict, password: Optional[str]) -> dict:
    if not password:
        raise RecoveryCodeVaultError("recovery_codes.json_password_required")
    kdf = blob.get("kdf")
    if not isinstance(kdf, dict):
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")
    try:
        salt = base64.b64decode(kdf["salt"])
        nonce = base64.b64decode(blob["nonce"])
        ciphertext = base64.b64decode(blob["ciphertext"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format") from exc

    # 只接受我们自己写得出来的两个 n。敌意文件可以声称 n=2**40，那会把
    # "打开备份"变成一次内存耗尽——同 parse_full_backup 的理由。
    n = _as_int(kdf.get("n"), crypto.SCRYPT_N)
    if kdf.get("algorithm", JSON_KDF) != JSON_KDF or n not in (crypto.SCRYPT_N_LEGACY, crypto.SCRYPT_N):
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")

    kek = crypto.derive_key_scrypt(password.encode("utf-8"), salt, n)
    try:
        plaintext = crypto.aead_decrypt(kek, nonce, ciphertext)
    except crypto.InvalidTag as exc:
        raise RecoveryCodeVaultError("recovery_codes.json_wrong_password") from exc
    try:
        inner = json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format") from exc
    if not isinstance(inner, dict):
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")
    return inner


def parse_json_export(
    text: str, *, password: Optional[str] = None
) -> "Tuple[List[RecoveryCodeGroup], List[DamagedRecord], JsonExportMeta]":
    """把 JSON 导出文件读成完整 RecoveryCodeGroup（无损），认 v1 裸数组、v2 明文信封、v2 加密信封。

    只有整份文件不可用（非 JSON、非本格式、版本更新、密码错）才抛 RecoveryCodeVaultError；
    单组问题走 DamagedRecord，其余组照常导入。
    """
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format") from exc

    if isinstance(raw, list):
        # v1：裸数组，没有信封也没有校验值。仍然读——用户机器上很可能就躺着
        # 几份这样的旧导出，让它们打不开毫无道理。
        entries = raw
        meta_version, encrypted, redacted = 1, False, False
        exported_at, app_version, checksum_ok = None, "", None
    elif isinstance(raw, dict):
        if raw.get("format") != JSON_FORMAT_MARKER:
            raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")
        version = _as_int(raw.get("formatVersion"), 0)
        if version > JSON_FORMAT_VERSION or version < 1:
            # 比我们新的版本**明确拒绝**，不猜着解析：猜错等于把一份更新的
            # 备份当成损坏数据丢掉，而用户以为自己已经恢复过了。
            raise RecoveryCodeVaultError("recovery_codes.json_unsupported_version")
        encrypted = bool(raw.get("encrypted"))
        if encrypted:
            raw = _decrypt_json_export(raw, password)
        entries = raw.get("groups")
        if not isinstance(entries, list):
            raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")
        meta_version = version
        redacted = bool(raw.get("codesRedacted"))
        exported_at = raw.get("exportedAt")
        app_version = str(raw.get("appVersion") or "")
        stored_checksum = raw.get("checksum")
        checksum_ok = None if stored_checksum is None else (stored_checksum == payload_checksum(entries))
    else:
        raise RecoveryCodeVaultError("recovery_codes.invalid_json_format")

    groups: List[RecoveryCodeGroup] = []
    damaged: List[DamagedRecord] = []
    for i, entry in enumerate(entries):
        group, bad = _group_from_export_json(entry, i)
        if group is not None:
            groups.append(group)
        else:
            damaged.append(bad)

    if not groups and redacted:
        # 脱敏导出里根本没有码，导进来只会得到一堆空壳。这不是"损坏"，
        # 是拿错了文件，要说得明明白白。
        raise RecoveryCodeVaultError("recovery_codes.json_codes_redacted")

    meta = JsonExportMeta(
        format_version=meta_version,
        encrypted=encrypted,
        codes_redacted=redacted,
        exported_at=_as_float(exported_at, 0.0) or None,
        app_version=app_version,
        checksum_ok=checksum_ok,
    )
    return groups, damaged, meta


# 选择性导出 / 分片（可移植性）

def select_groups(
    groups: List[RecoveryCodeGroup],
    *,
    ids: Optional[List[str]] = None,
    only_unused: bool = False,
) -> List[RecoveryCodeGroup]:
    """按 id 挑选，可选只保留未用码。

    只保留未用码时返回副本，不能就地改（调用方手里是后端活数据，会静默丢掉已用记录）。
    过滤后无码的组整个丢掉，否则重新导入会成为"损坏记录"。
    """
    wanted = None if ids is None else set(ids)
    picked = [g for g in groups if wanted is None or g.id in wanted]
    if not only_unused:
        return picked

    result: List[RecoveryCodeGroup] = []
    for g in picked:
        unused = [RecoveryCode(code=c.code, used=c.used, used_at=c.used_at) for c in g.codes if not c.used]
        if not unused:
            continue
        result.append(replace(g, codes=unused))
    return result


def chunk_groups(groups: List[RecoveryCodeGroup], size: int) -> "List[List[RecoveryCodeGroup]]":
    """按每份最多 size 组切开，size <= 0 不切；只按组切，不拆开同一组的码，否则丢一片就得到看似完
    整实则缺码的清单。"""
    if size <= 0 or len(groups) <= size:
        return [list(groups)]
    return [list(groups[i:i + size]) for i in range(0, len(groups), size)]


# OCR 易混字符，仅用于标记可疑的导入码，不拒绝（码可能真含这些字符）。
_OCR_CONFUSABLE = frozenset("0Oo1lI|")


def is_suspect_code(code: str) -> bool:
    """码是否含 OCR 易混字符（0/O、1/l/I 等）；导入预览据此提示复核，不阻止导入，纯按字符集判断。"""
    return any(ch in _OCR_CONFUSABLE for ch in code)


# Full backup / cross-device migration (spec 3.5): its own independent password, NOT the vault's
# IMK, so a leaked backup+password can't unlock the live vault and vice versa. Reuses the main
# vault's primitives (Scrypt-derived KEK, single AEAD call). The blob records the Scrypt cost with
# the salt: a backup can't be re-wrapped in place, so this is what keeps old exports openable.

BACKUP_FORMAT_MARKER = "ideal1-recovery-codes-backup"
BACKUP_FORMAT_VERSION = 1


def export_full_backup(groups: List[RecoveryCodeGroup], backup_password: str) -> bytes:
    salt = crypto.random_salt()
    kek = crypto.derive_key_scrypt(backup_password.encode("utf-8"), salt)
    payload = {
        "exported_at": time.time(),
        "groups": [_group_to_storage_json(g) for g in groups],
    }
    plaintext = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    nonce = crypto.random_nonce()
    ciphertext = crypto.aead_encrypt(kek, nonce, plaintext)
    blob = {
        "format": BACKUP_FORMAT_MARKER,
        "format_version": BACKUP_FORMAT_VERSION,
        "salt": base64.b64encode(salt).decode(),
        # Recorded next to the salt so the cost can be raised later without orphaning old backups
        # (a backup can't be re-wrapped in place).
        "scrypt_n": crypto.SCRYPT_N,
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
    return json.dumps(blob).encode("utf-8")


def parse_full_backup(backup_bytes: bytes, backup_password: str) -> "Tuple[List[RecoveryCodeGroup], List[DamagedRecord]]":
    """Raises RecoveryCodeVaultError('recovery_codes.backup_wrong_password') on a wrong password, or
    ('recovery_codes.backup_invalid_format') if the file isn't a backup. A damaged group inside a valid
    backup is returned in the second list instead of aborting the restore.
    """
    try:
        blob = json.loads(backup_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.backup_invalid_format") from exc
    if not isinstance(blob, dict) or blob.get("format") != BACKUP_FORMAT_MARKER:
        raise RecoveryCodeVaultError("recovery_codes.backup_invalid_format")
    try:
        salt = base64.b64decode(blob["salt"])
        nonce = base64.b64decode(blob["nonce"])
        ciphertext = base64.b64decode(blob["ciphertext"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.backup_invalid_format") from exc

    # Absent => exported before the cost bump (legacy parameter). Unparseable values are treated the
    # same, not trusted: a hostile file could name an absurd cost and OOM the restore.
    try:
        scrypt_n = int(blob.get("scrypt_n", crypto.SCRYPT_N_LEGACY))
    except (TypeError, ValueError):
        scrypt_n = crypto.SCRYPT_N_LEGACY
    if scrypt_n not in (crypto.SCRYPT_N_LEGACY, crypto.SCRYPT_N):
        raise RecoveryCodeVaultError("recovery_codes.backup_invalid_format")

    kek = crypto.derive_key_scrypt(backup_password.encode("utf-8"), salt, scrypt_n)
    try:
        plaintext = crypto.aead_decrypt(kek, nonce, ciphertext)
    except crypto.InvalidTag as exc:
        raise RecoveryCodeVaultError("recovery_codes.backup_wrong_password") from exc

    try:
        payload = json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecoveryCodeVaultError("recovery_codes.backup_invalid_format") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("groups"), list):
        raise RecoveryCodeVaultError("recovery_codes.backup_invalid_format")

    groups: List[RecoveryCodeGroup] = []
    damaged: List[DamagedRecord] = []
    for i, d in enumerate(payload["groups"]):
        group, bad = _group_from_storage_json(d, i)
        if group is not None:
            groups.append(group)
        else:
            damaged.append(bad)
    return groups, damaged


def identity_key(service: str, account_label: str) -> str:
    return f"{service}\x1f{account_label}"


@dataclass(frozen=True)
class BackupDiffItem:
    key: str
    service: str
    account_label: str
    # "local_only" | "backup_only" | "identical" | "conflict"
    status: str
    local_group_id: Optional[str]
    backup_index: Optional[int]
    local_remaining: Optional[int]
    backup_remaining: Optional[int]


def diff_full_backup(local_groups: List[RecoveryCodeGroup], backup_groups: List[RecoveryCodeGroup]) -> List[BackupDiffItem]:
    """Classifies every (service, account_label) identity on either side (spec 3.5 diff).

    "identical" needs no decision; only "conflict" does. "identical" means same codes AND same set of
    spent ones: ignoring used flags hid the case where the file says a code is spent but the local
    vault thinks it is available, which must never be reported as identical.
    """
    local_by_key = {identity_key(g.service, g.account_label): g for g in local_groups}
    backup_by_key = {identity_key(g.service, g.account_label): g for g in backup_groups}
    all_keys = list(dict.fromkeys([*local_by_key.keys(), *backup_by_key.keys()]))

    items = []
    for key in all_keys:
        local = local_by_key.get(key)
        backup = backup_by_key.get(key)
        if local is not None and backup is None:
            items.append(BackupDiffItem(
                key=key, service=local.service, account_label=local.account_label, status="local_only",
                local_group_id=local.id, backup_index=None,
                local_remaining=remaining_count(local), backup_remaining=None,
            ))
        elif local is None and backup is not None:
            items.append(BackupDiffItem(
                key=key, service=backup.service, account_label=backup.account_label, status="backup_only",
                local_group_id=None, backup_index=backup_groups.index(backup),
                local_remaining=None, backup_remaining=remaining_count(backup),
            ))
        else:
            same = (
                {c.code for c in local.codes} == {c.code for c in backup.codes}
                and {c.code for c in local.codes if c.used} == {c.code for c in backup.codes if c.used}
            )
            items.append(BackupDiffItem(
                key=key, service=local.service, account_label=local.account_label,
                status="identical" if same else "conflict",
                local_group_id=local.id, backup_index=backup_groups.index(backup),
                local_remaining=remaining_count(local), backup_remaining=remaining_count(backup),
            ))
    return items


def merge_group(local: RecoveryCodeGroup, backup: RecoveryCodeGroup) -> RecoveryCodeGroup:
    """"合并" strategy: union of codes by string (used=True if used on EITHER side, since a spent code
    must never look unused again); note/thresholds from the more recently updated side;
    first_imported_at is the EARLIER of the two.
    """
    by_code: Dict[str, RecoveryCode] = {}
    for c in local.codes + backup.codes:
        existing = by_code.get(c.code)
        if existing is None:
            by_code[c.code] = RecoveryCode(code=c.code, used=c.used, used_at=c.used_at)
        elif c.used and not existing.used:
            existing.used = True
            existing.used_at = c.used_at
    newer = local if local.last_updated_at >= backup.last_updated_at else backup
    # Each history is chronological but the two aren't ordered relative to each other, so merge by
    # timestamp instead of concatenating.
    merged_history = sorted([*local.import_history, *backup.import_history], key=lambda h: h.timestamp)
    return RecoveryCodeGroup(
        id=local.id,
        service=newer.service,
        account_label=newer.account_label,
        source_file_name=newer.source_file_name,
        codes=list(by_code.values()),
        first_imported_at=min(local.first_imported_at, backup.first_imported_at),
        last_updated_at=time.time(),
        last_checked_at=newer.last_checked_at,
        low_stock_threshold=newer.low_stock_threshold,
        review_interval_days=newer.review_interval_days,
        import_history=[
            *merged_history,
            ImportHistoryEntry(action="backup_restore", timestamp=time.time(), change_summary="与备份合并"),
        ],
        note=newer.note,
        # 合并出来的是"本地这一组的新状态"，时间线跟着本地走。
        revisions=list(local.revisions),
    )


# 修改时间线：每条记录是某次改动之后一组的完整样子，由 backend_server 的
# _save_recovery_code_groups 统一对比"上次落盘"与"本次要写"生成，不会有写路径漏记。


def snapshot_state(g: RecoveryCodeGroup) -> dict:
    """这一组此刻的内容快照（深拷贝，之后原地改组不会影响它）。"""
    return {
        "service": g.service,
        "account_label": g.account_label,
        "note": g.note,
        "codes": [{"code": c.code, "used": c.used, "used_at": c.used_at} for c in g.codes],
    }


def state_key(snapshot: dict) -> tuple:
    """判断"内容变没变"用的比较键。used_at 不参与：同一个码被标记已用的时刻
    变了不算内容变化，是否已用才算。"""
    return (
        snapshot["service"],
        snapshot["account_label"],
        snapshot["note"],
        tuple((c["code"], bool(c["used"])) for c in snapshot["codes"]),
    )


def make_revision(snapshot: dict, *, action: str, summary: str = "", batch_id: Optional[str] = None,
                  timestamp: Optional[float] = None) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "timestamp": time.time() if timestamp is None else float(timestamp),
        "action": action,
        "batch_id": batch_id,
        "summary": summary,
        "service": snapshot["service"],
        "account_label": snapshot["account_label"],
        "note": snapshot["note"],
        "codes": [dict(c) for c in snapshot["codes"]],
    }


def append_revision(g: RecoveryCodeGroup, revision: dict) -> None:
    g.revisions.append(revision)
    overflow = len(g.revisions) - MAX_REVISIONS_PER_GROUP
    if overflow > 0:
        # 最早那一条（baseline / 首次导入）是"最初是什么样"的唯一证据，裁剪时
        # 保住它，从第二条开始丢。
        g.revisions[1 : 1 + overflow] = []


def _clean_revisions(raw) -> List[dict]:
    """金库里读出来的时间线逐条校验，形状不对的整条丢掉。"""
    if not isinstance(raw, list):
        return []
    result = []
    for r in raw:
        try:
            codes = [
                {"code": c["code"], "used": bool(c.get("used", False)), "used_at": c.get("used_at")}
                for c in r["codes"]
                if isinstance(c.get("code"), str)
            ]
            result.append({
                "id": str(r["id"]),
                "timestamp": float(r["timestamp"]),
                "action": str(r.get("action") or "update"),
                "batch_id": r.get("batch_id") if isinstance(r.get("batch_id"), str) else None,
                "summary": str(r.get("summary") or ""),
                "service": str(r.get("service") or ""),
                "account_label": str(r.get("account_label") or ""),
                "note": str(r.get("note") or ""),
                "codes": codes,
            })
        except Exception:
            continue
    return result[-MAX_REVISIONS_PER_GROUP:]


def revision_to_rpc_json(revision: dict, group_id: str) -> dict:
    """发给前端的形状：码打码，只剩下标和是否用过（跟 to_rpc_json 同一规矩）。"""
    codes = revision["codes"]
    return {
        "id": revision["id"],
        "group_id": group_id,
        "timestamp": revision["timestamp"],
        "action": revision["action"],
        "batch_id": revision.get("batch_id"),
        "summary": revision.get("summary", ""),
        "service": revision["service"],
        "account_label": revision["account_label"],
        "note": revision["note"],
        "code_count": len(codes),
        "used_count": sum(1 for c in codes if c["used"]),
        "codes": [{"index": i, "used": c["used"], "usedAt": c.get("used_at")} for i, c in enumerate(codes)],
    }


def find_revision(revisions: List[dict], revision_id: str) -> Optional[dict]:
    for r in revisions:
        if r["id"] == revision_id:
            return r
    return None


def revision_before(revisions: List[dict], revision_id: str) -> Optional[dict]:
    """时间线上紧挨在这一条之前的那一条；它自己就是最早的一条时返回 None。"""
    for i, r in enumerate(revisions):
        if r["id"] == revision_id:
            return revisions[i - 1] if i > 0 else None
    return None


def apply_revision(g: RecoveryCodeGroup, revision: dict) -> None:
    """把一组的内容改回某条记录的样子（阈值、来源文件名这些不在快照里的保持不变）。"""
    g.service = revision["service"]
    g.account_label = revision["account_label"]
    g.note = revision["note"]
    g.codes = [RecoveryCode(code=c["code"], used=bool(c["used"]), used_at=c.get("used_at")) for c in revision["codes"]]
    g.last_updated_at = time.time()


def describe_change(old: Optional[dict], new: dict) -> str:
    """一句话说明这次改了什么，写进时间线的 summary。"""
    if old is None:
        return f"{len(new['codes'])}个密钥"
    parts = []
    if old["service"] != new["service"]:
        parts.append(f"服务名 {old['service']} → {new['service']}")
    if old["account_label"] != new["account_label"]:
        parts.append("账号标签")
    if old["note"] != new["note"]:
        parts.append("备注")
    old_codes = {c["code"]: c["used"] for c in old["codes"]}
    new_codes = {c["code"]: c["used"] for c in new["codes"]}
    added = len(new_codes.keys() - old_codes.keys())
    removed = len(old_codes.keys() - new_codes.keys())
    if added:
        parts.append(f"新增{added}个密钥")
    if removed:
        parts.append(f"移除{removed}个密钥")
    newly_used = sum(1 for code, used in new_codes.items() if used and old_codes.get(code) is False)
    unused_again = sum(1 for code, used in new_codes.items() if not used and old_codes.get(code) is True)
    if newly_used:
        parts.append(f"标记已用{newly_used}个")
    if unused_again:
        parts.append(f"取消已用{unused_again}个")
    return "、".join(parts)


def group_from_deleted_record(record: dict, revision: dict) -> RecoveryCodeGroup:
    """已删除的组按某条快照重建，沿用原来的 id 和整条时间线。"""
    now = time.time()
    g = RecoveryCodeGroup(
        id=record["group_id"],
        service=revision["service"],
        account_label=revision["account_label"],
        source_file_name=str(record.get("source_file_name") or ""),
        codes=[],
        first_imported_at=float(record.get("first_imported_at") or revision["timestamp"]),
        last_updated_at=now,
        last_checked_at=now,
        low_stock_threshold=int(record.get("low_stock_threshold") or DEFAULT_LOW_STOCK_THRESHOLD),
        review_interval_days=int(record.get("review_interval_days") or DEFAULT_REVIEW_INTERVAL_DAYS),
        revisions=list(record.get("revisions") or []),
    )
    apply_revision(g, revision)
    return g


def deleted_record_for(g: RecoveryCodeGroup, revisions: List[dict]) -> dict:
    return {
        "group_id": g.id,
        "deleted_at": time.time(),
        "service": g.service,
        "source_file_name": g.source_file_name,
        "first_imported_at": g.first_imported_at,
        "low_stock_threshold": g.low_stock_threshold,
        "review_interval_days": g.review_interval_days,
        "revisions": revisions[-MAX_REVISIONS_PER_GROUP:],
    }


def _deleted_vault_path(data_dir: Path) -> Path:
    return Path(data_dir) / DELETED_VAULT_FILENAME


def load_deleted_records(data_dir: Path, imk: bytes) -> List[dict]:
    """被删除的组的时间线。这是锦上添花的数据：文件不在、解不开、形状不对，
    一律当作空的，绝不让它拖垮恢复码本身。"""
    path = _deleted_vault_path(data_dir)
    if not path.exists():
        return []
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
        fk = crypto.unwrap_key(
            imk, base64.b64decode(blob["fk_wrap"]["nonce"]), base64.b64decode(blob["fk_wrap"]["wrapped_fk"])
        )
        plaintext = crypto.aead_decrypt(fk, base64.b64decode(blob["nonce"]), base64.b64decode(blob["ciphertext"]))
        records = json.loads(plaintext.decode("utf-8"))
    except Exception:
        return []
    if not isinstance(records, list):
        return []
    clean = []
    for r in records:
        if isinstance(r, dict) and isinstance(r.get("group_id"), str):
            r["revisions"] = _clean_revisions(r.get("revisions"))
            if r["revisions"]:
                clean.append(r)
    return clean[-MAX_DELETED_GROUP_RECORDS:]


def save_deleted_records(data_dir: Path, records: List[dict], imk: bytes) -> None:
    """跟 save_recovery_codes_vault 同一套信封：每次换新的 File Key，IMK 包裹。"""
    records = records[-MAX_DELETED_GROUP_RECORDS:]
    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
    content_nonce = crypto.random_nonce()
    ciphertext = crypto.aead_encrypt(fk, content_nonce, json.dumps(records, ensure_ascii=False).encode("utf-8"))
    blob = {
        "format_version": FORMAT_VERSION,
        "fk_wrap": {"nonce": base64.b64encode(fk_nonce).decode(), "wrapped_fk": base64.b64encode(wrapped_fk).decode()},
        "nonce": base64.b64encode(content_nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
    path = _deleted_vault_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    tmp_path.replace(path)


# --- 去重 ---


def find_duplicates(groups: List[RecoveryCodeGroup]) -> "Tuple[List[dict], List[dict]]":
    """返回 (重复组列表, 组内有重复码的组)。

    same_identity：服务名（忽略大小写和首尾空白）+ 账号标签相同，多半是重复导入；
    same_codes：码集合相同但身份不同，多半是服务名打错。已按身份重复报过的不再按码重复报。
    """
    result: List[dict] = []
    by_identity: Dict[tuple, List[str]] = {}
    for g in groups:
        by_identity.setdefault((g.service.strip().casefold(), g.account_label.strip()), []).append(g.id)
    reported = set()
    for ids in by_identity.values():
        if len(ids) > 1:
            result.append({"reason": "same_identity", "ids": ids})
            reported.update(ids)
    by_codes: Dict[frozenset, List[str]] = {}
    for g in groups:
        if g.id in reported or not g.codes:
            continue
        by_codes.setdefault(frozenset(c.code for c in g.codes), []).append(g.id)
    for ids in by_codes.values():
        if len(ids) > 1:
            result.append({"reason": "same_codes", "ids": ids})
    within = []
    for g in groups:
        dup = len(g.codes) - len({c.code for c in g.codes})
        if dup > 0:
            within.append({"id": g.id, "duplicate_count": dup})
    return result, within


def merge_codes_into(target: RecoveryCodeGroup, others: List[RecoveryCodeGroup]) -> None:
    """把 others 的码并进 target：按码去重，任何一边标记过已用就算已用（跟
    merge_group 同一条规矩——把用掉的码当成可用，是这个功能最不能犯的错）。"""
    by_code: Dict[str, RecoveryCode] = {}
    order: List[str] = []
    for c in [*target.codes, *(c for o in others for c in o.codes)]:
        existing = by_code.get(c.code)
        if existing is None:
            by_code[c.code] = RecoveryCode(code=c.code, used=c.used, used_at=c.used_at)
            order.append(c.code)
        elif c.used and not existing.used:
            existing.used = True
            existing.used_at = c.used_at
    target.codes = [by_code[code] for code in order]
    target.last_updated_at = time.time()


def dedupe_group_codes(g: RecoveryCodeGroup) -> int:
    """清掉一组内部的重复码，返回清掉了几个。已用标记同样取或。"""
    before = len(g.codes)
    merge_codes_into(g, [])
    return before - len(g.codes)
