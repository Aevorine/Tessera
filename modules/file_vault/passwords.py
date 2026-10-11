"""Password entries, encrypted as one JSON blob under the same IMK file_vault uses (see identity.py).

Not chunked like container.py: a personal list is tens of KB, so one AES-256-GCM call suffices.
"""

import base64
import csv
import json
import math
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse

from modules.file_vault import crypto
from modules.file_vault.errors import VaultError

VAULT_FILENAME = "passwords.vault"
FORMAT_VERSION = 2
SUPPORTED_FORMAT_VERSIONS = (1, 2)
MAX_PASSWORD_HISTORY = 5

# Exact allowed field sets: version 1 entries carry exactly the eight fields (no `history`, no
# extras); version 2 adds an optional `history`. Validated explicitly (dataclasses don't check types).
# The tuples below are the single source of field names; sets and (de)serializers derive from them.
_ENTRY_TEXT_FIELDS = ("id", "name", "url", "username", "password", "notes")
_ENTRY_TIME_FIELDS = ("created_at", "updated_at")
_SNAPSHOT_TEXT_FIELDS = ("name", "url", "username", "password", "notes")
_SNAPSHOT_TIME_FIELDS = ("updated_at",)

_LEGACY_ENTRY_FIELDS = frozenset(_ENTRY_TEXT_FIELDS + _ENTRY_TIME_FIELDS)
_V2_ENTRY_FIELDS = frozenset(_LEGACY_ENTRY_FIELDS | {"history"})
_SNAPSHOT_FIELDS = frozenset(_SNAPSHOT_TEXT_FIELDS + _SNAPSHOT_TIME_FIELDS)


class PasswordVaultError(VaultError):
    """passwords.vault exists but couldn't be decrypted or parsed, or a CSV
    being imported is missing required columns."""


class _DuplicateKeyError(ValueError):
    """Raised when a JSON object repeats a key; json.loads would silently keep the last, letting
    tampered data bypass validation."""


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKeyError()
        result[key] = value
    return result


def _require_text(value):
    # bool is a subclass of int, and JSON true/false decode to bool - neither
    # is a text field. `type(value) is str` also excludes str subclasses.
    if type(value) is not str:
        raise PasswordVaultError("password.content_corrupted")
    return value


def _require_finite_number(value):
    # Reject bool (JSON true/false), NaN, and +/-Infinity; accept only finite
    # ints/floats. `type(value) is int` excludes bool (whose type is bool).
    if type(value) is int or type(value) is float:
        if math.isfinite(value):
            return value
    raise PasswordVaultError("password.content_corrupted")


@dataclass(frozen=True)
class PasswordHistorySnapshot:
    name: str
    url: str
    username: str
    password: str
    notes: str
    updated_at: float


@dataclass
class PasswordEntry:
    id: str
    name: str
    url: str
    username: str
    password: str
    notes: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    history: List[PasswordHistorySnapshot] = field(default_factory=list)

    def to_storage_json(self) -> dict:
        """Validates and serializes a complete entry (with history) for storage.

        Raises PasswordVaultError('password.content_corrupted') for any invalid object so a malformed entry
        is never written; the error never includes field values."""
        try:
            raw = {f: getattr(self, f) for f in _ENTRY_TEXT_FIELDS + _ENTRY_TIME_FIELDS}
            raw["history"] = [
                {f: getattr(s, f) for f in _SNAPSHOT_TEXT_FIELDS + _SNAPSHOT_TIME_FIELDS}
                for s in self.history
            ]
        except (TypeError, AttributeError) as exc:
            # e.g. history isn't iterable, or an item isn't a snapshot object.
            raise PasswordVaultError("password.content_corrupted") from exc
        # Reuse the exact load-side validation so save and load agree.
        PasswordEntry.from_storage_json(raw, version=FORMAT_VERSION)
        return raw

    def to_rpc_json(self) -> dict:
        """Serialize the current entry state without password history."""
        return {f: getattr(self, f) for f in _ENTRY_TEXT_FIELDS + _ENTRY_TIME_FIELDS}

    @staticmethod
    def from_storage_json(d, *, version: int) -> "PasswordEntry":
        """Strictly validates one decrypted entry and builds a PasswordEntry.

        version 1 must carry exactly the eight legacy fields (no `history`); version 2 adds an optional
        `history`. Any deviation raises PasswordVaultError('password.content_corrupted') without field values."""
        if type(d) is not dict:
            raise PasswordVaultError("password.content_corrupted")
        keys = frozenset(d.keys())
        if version == 1:
            if keys != _LEGACY_ENTRY_FIELDS:
                raise PasswordVaultError("password.content_corrupted")
            history: List[PasswordHistorySnapshot] = []
        else:
            if not (_LEGACY_ENTRY_FIELDS <= keys <= _V2_ENTRY_FIELDS):
                raise PasswordVaultError("password.content_corrupted")
            history = _history_from_storage(d["history"]) if "history" in d else []
        fields = {f: _require_text(d[f]) for f in _ENTRY_TEXT_FIELDS}
        fields.update({f: _require_finite_number(d[f]) for f in _ENTRY_TIME_FIELDS})
        return PasswordEntry(history=history, **fields)

    def updated(self, *, name: str, url: str, username: str, password: str, notes: str = "") -> "PasswordEntry":
        """Return a new entry with a snapshot of this effective prior state."""
        if (self.name, self.url, self.username, self.password, self.notes) == (name, url, username, password, notes):
            return self

        snapshot = PasswordHistorySnapshot(
            name=self.name,
            url=self.url,
            username=self.username,
            password=self.password,
            notes=self.notes,
            updated_at=self.updated_at,
        )
        return PasswordEntry(
            id=self.id,
            name=name,
            url=url,
            username=username,
            password=password,
            notes=notes,
            created_at=self.created_at,
            updated_at=time.time(),
            history=[snapshot, *self.history][:MAX_PASSWORD_HISTORY],
        )


def _snapshot_from_storage(d) -> PasswordHistorySnapshot:
    """Strictly validate one decrypted history snapshot object. Must carry
    EXACTLY the six snapshot fields (no unknown fields, no nested `history`)."""
    if type(d) is not dict:
        raise PasswordVaultError("password.content_corrupted")
    if frozenset(d.keys()) != _SNAPSHOT_FIELDS:
        raise PasswordVaultError("password.content_corrupted")
    fields = {f: _require_text(d[f]) for f in _SNAPSHOT_TEXT_FIELDS}
    fields.update({f: _require_finite_number(d[f]) for f in _SNAPSHOT_TIME_FIELDS})
    return PasswordHistorySnapshot(**fields)


def _history_from_storage(value) -> List[PasswordHistorySnapshot]:
    """`history` must be a list of at most MAX_PASSWORD_HISTORY snapshots.
    Never silently truncates: an over-long list is rejected outright."""
    if type(value) is not list:
        raise PasswordVaultError("password.content_corrupted")
    if len(value) > MAX_PASSWORD_HISTORY:
        raise PasswordVaultError("password.content_corrupted")
    return [_snapshot_from_storage(item) for item in value]


def _dedupe_key(e: PasswordEntry):
    """Identity for the DESTRUCTIVE dedupe: the five current text fields plus the ordered history
    content tuples. Entries collide only when both match.

    Snapshot `updated_at` is excluded: history position is the authoritative order, and the clock may
    repeat or roll back. Collapsing entries that differ only in timestamps loses no unique history."""
    current = tuple(getattr(e, f) for f in _ENTRY_TEXT_FIELDS[1:])  # skip id
    history = tuple(
        tuple(getattr(s, f) for f in _SNAPSHOT_TEXT_FIELDS)
        for s in e.history
    )
    return (current, history)


def find_duplicate_ids(entries: List[PasswordEntry]) -> List[str]:
    """Returns ids of every entry after the first in each group of 2+ exact matches on the current
    fields (name/url/username/password/notes, not id/timestamps) AND full history; the first survives.

    Backs the DESTRUCTIVE "去重" button. History is part of the key: entries with identical current
    fields but different history are not duplicates, since deleting one would destroy a unique record
    of past passwords. Kept separate from find_exact_match, so a re-import never duplicates merely
    because the existing entry gained history."""
    seen = set()
    duplicate_ids = []
    for e in entries:
        key = _dedupe_key(e)
        if key in seen:
            duplicate_ids.append(e.id)
        else:
            seen.add(key)
    return duplicate_ids


def find_exact_match(
    entries: List[PasswordEntry], *, name: str, url: str, username: str, password: str, notes: str = "",
) -> Optional[PasswordEntry]:
    """Current-field check (history excluded) of a candidate against existing entries; used by
    rpc_password_add so adding an exact duplicate is a no-op, even if the existing entry has history."""
    for e in entries:
        if (e.name, e.url, e.username, e.password, e.notes) == (name, url, username, password, notes):
            return e
    return None


def account_key(url: str, username: str) -> tuple:
    """Identity of 'the same account' across imports/updates: the URL hostname (lowercased) plus the
    username, stripped of surrounding whitespace only.

    Username case is preserved: folding risks matching two different accounts, which is worse than
    missing an update. Password/name/notes are irrelevant here."""
    return (_hostname_from_url(url).lower(), username.strip())


def find_account_match(entries: List[PasswordEntry], *, url: str, username: str) -> Optional[PasswordEntry]:
    """Returns the entry sharing account_key(url, username), or None; separates 'new account' from
    'existing account, changed' during CSV import (rpc_password_import_csv_preview/_confirm)."""
    key = account_key(url, username)
    for e in entries:
        if account_key(e.url, e.username) == key:
            return e
    return None


def new_entry(name: str, url: str, username: str, password: str, notes: str = "") -> PasswordEntry:
    now = time.time()
    return PasswordEntry(
        id=str(uuid.uuid4()),
        name=name,
        url=url,
        username=username,
        password=password,
        notes=notes,
        created_at=now,
        updated_at=now,
    )


def reconstruct_entry(raw: dict) -> PasswordEntry:
    """Rebuilds a PasswordEntry from a to_rpc_json dict, keeping id, timestamps and history; undo-restore only."""
    return PasswordEntry(
        id=raw.get("id", ""),
        name=raw.get("name", ""),
        url=raw.get("url", ""),
        username=raw.get("username", ""),
        password=raw.get("password", ""),
        notes=raw.get("notes", ""),
        created_at=float(raw.get("created_at", 0)),
        updated_at=float(raw.get("updated_at", 0)),
        history=[PasswordHistorySnapshot(
            password=h.get("password", ""), username=h.get("username", ""),
            notes=h.get("notes", ""), updated_at=float(h.get("updated_at", 0)),
        ) for h in (raw.get("history") or [])],
    )


def vault_path(data_dir: Path) -> Path:
    return Path(data_dir) / VAULT_FILENAME


def _validate_format_version(blob: dict) -> int:
    """The outer `format_version` is NOT covered by the AEAD tag, so it is attacker-controllable.

    It must be present and a real JSON integer (not bool, float like 1.0, string, container or
    non-finite). Only 1 and 2 are supported; other integers are 'unsupported' and never decrypted."""
    if "format_version" not in blob:
        raise PasswordVaultError("password.invalid_format")
    version = blob["format_version"]
    # `type(version) is int` rejects bool (type bool), float 1.0/2.0, NaN, etc.
    if type(version) is not int:
        raise PasswordVaultError("password.invalid_format")
    if version not in SUPPORTED_FORMAT_VERSIONS:
        raise PasswordVaultError("password.unsupported_format_version")
    return version


def _entries_from_plaintext(plaintext: bytes, *, version: int) -> List[PasswordEntry]:
    try:
        text = plaintext.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PasswordVaultError("password.content_corrupted") from exc
    try:
        data = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except (_DuplicateKeyError, json.JSONDecodeError) as exc:
        raise PasswordVaultError("password.content_corrupted") from exc
    if type(data) is not list:
        raise PasswordVaultError("password.content_corrupted")
    return [PasswordEntry.from_storage_json(item, version=version) for item in data]


def load_password_vault(data_dir: Path, imk: bytes) -> List[PasswordEntry]:
    """Returns [] if the vault file doesn't exist yet; raises PasswordVaultError if it can't be
    decrypted (wrong imk, corrupted) or parsed. Strictly read-only: never rewrites or migrates the file."""
    path = vault_path(data_dir)
    if not path.exists():
        return []
    raw_text = path.read_text(encoding="utf-8")
    try:
        blob = json.loads(raw_text, object_pairs_hook=_reject_duplicate_keys)
    except (_DuplicateKeyError, json.JSONDecodeError) as exc:
        raise PasswordVaultError("password.invalid_format") from exc
    if type(blob) is not dict:
        raise PasswordVaultError("password.invalid_format")

    version = _validate_format_version(blob)

    try:
        fk_nonce = base64.b64decode(blob["fk_wrap"]["nonce"])
        wrapped_fk = base64.b64decode(blob["fk_wrap"]["wrapped_fk"])
        content_nonce = base64.b64decode(blob["nonce"])
        ciphertext = base64.b64decode(blob["ciphertext"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PasswordVaultError("password.invalid_format") from exc

    try:
        fk = crypto.unwrap_key(imk, fk_nonce, wrapped_fk)
        plaintext = crypto.aead_decrypt(fk, content_nonce, ciphertext)
    except crypto.InvalidTag as exc:
        raise PasswordVaultError("password.key_mismatch") from exc

    return _entries_from_plaintext(plaintext, version=version)


def save_password_vault(data_dir: Path, entries: List[PasswordEntry], imk: bytes) -> None:
    """Re-encrypts and rewrites the whole vault as format_version 2.

    A fresh File Key per save (as in container.py), written atomically via temp file + replace so a
    crash can't leave passwords.vault half-written. Every entry is validated before any bytes are
    written, so a bad in-memory entry aborts without touching the file."""
    # Validate + serialize first: raises before any file I/O on bad input.
    serialized = [e.to_storage_json() for e in entries]

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
    tmp_path = path.with_name(path.name + ".part")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    tmp_path.replace(path)


CSV_EXPORT_FIELDNAMES = ["name", "url", "username", "password"]

_NAME_ALIASES = ("name", "title")
_URL_ALIASES = ("url", "login_uri")
_USERNAME_ALIASES = ("username", "login")
_PASSWORD_ALIASES = ("password",)


def _find_column(lower_fieldnames: dict, aliases: tuple) -> Optional[str]:
    for alias in aliases:
        if alias in lower_fieldnames:
            return lower_fieldnames[alias]
    return None


def _hostname_from_url(url: str) -> str:
    parsed = urlparse(url if "://" in url else f"//{url}")
    return parsed.hostname or url


def _parse_csv_rows(path: Path, encoding: str) -> List[PasswordEntry]:
    with open(path, "r", encoding=encoding, newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise PasswordVaultError("password.csv_empty_or_invalid")
        lower_fieldnames = {fn.lower(): fn for fn in reader.fieldnames}

        name_col = _find_column(lower_fieldnames, _NAME_ALIASES)
        url_col = _find_column(lower_fieldnames, _URL_ALIASES)
        username_col = _find_column(lower_fieldnames, _USERNAME_ALIASES)
        password_col = _find_column(lower_fieldnames, _PASSWORD_ALIASES)

        if url_col is None or username_col is None or password_col is None:
            raise PasswordVaultError("password.csv_missing_columns")

        entries = []
        for row in reader:
            url = row.get(url_col) or ""
            name = (row.get(name_col) or "") if name_col else ""
            if not name:
                name = _hostname_from_url(url)
            entries.append(
                new_entry(
                    name=name,
                    url=url,
                    username=row.get(username_col) or "",
                    password=row.get(password_col) or "",
                )
            )
        return entries


# Excel 另存为 CSV 在简体中文 Windows 上默认是 GBK/ANSI，含中文时 utf-8-sig 会 UnicodeDecodeError。
# gb18030 是超集；两种都读不了才判定看不懂，免得把解码失败误当结构错误重试。
_CSV_ENCODING_FALLBACKS = ("utf-8-sig", "gb18030")


def parse_csv(path: Path) -> List[PasswordEntry]:
    """Parses a Chrome/Edge (name,url,username,password) or Firefox (no name column; name falls back to
    the URL hostname) password export CSV.

    Tries _CSV_ENCODING_FALLBACKS in order, advancing only on UnicodeDecodeError; a structural error
    raises immediately. Raises PasswordVaultError if url/username/password columns are missing or no
    encoding works."""
    last_decode_error: Optional[UnicodeDecodeError] = None
    for encoding in _CSV_ENCODING_FALLBACKS:
        try:
            return _parse_csv_rows(path, encoding)
        except UnicodeDecodeError as exc:
            last_decode_error = exc
            continue
    raise PasswordVaultError("password.csv_bad_encoding") from last_decode_error


@dataclass(frozen=True)
class CsvImportPlanRow:
    """One parsed CSV row's classification for import preview/confirm. `action` is one of:

    - "add": no existing entry shares the account (url+username); a new entry is created.
    - "update": an entry shares the account and a field differs; confirm calls its `updated()`
      (history snapshot). `match_id` names the target.
    - "unchanged": an entry shares the account and all fields match; a no-op.
    - "superseded_in_batch": a later row in the same CSV shares the account and wins;
      `superseded_by` is that row's row_index.
    """
    row_index: int
    name: str
    url: str
    username: str
    password: str
    notes: str
    action: str
    match_id: Optional[str] = None
    superseded_by: Optional[int] = None


def plan_csv_import(entries: List[PasswordEntry], candidates: List[PasswordEntry]) -> List[CsvImportPlanRow]:
    """Classifies every parsed CSV row against the CURRENT vault `entries` without mutating either list.

    Shared by preview and confirm so they never disagree. A CSV row has no timestamp, so among rows
    with the same account in one file the last wins as "most recent"; earlier ones are superseded_in_batch.
    """
    last_index_for_key = {}
    for i, c in enumerate(candidates):
        last_index_for_key[account_key(c.url, c.username)] = i

    rows = []
    for i, c in enumerate(candidates):
        key = account_key(c.url, c.username)
        if last_index_for_key[key] != i:
            rows.append(CsvImportPlanRow(
                row_index=i, name=c.name, url=c.url, username=c.username,
                password=c.password, notes=c.notes,
                action="superseded_in_batch", superseded_by=last_index_for_key[key],
            ))
            continue
        match = find_account_match(entries, url=c.url, username=c.username)
        if match is None:
            action, match_id = "add", None
        elif (match.name, match.url, match.username, match.password, match.notes) == (
            c.name, c.url, c.username, c.password, c.notes,
        ):
            action, match_id = "unchanged", match.id
        else:
            action, match_id = "update", match.id
        rows.append(CsvImportPlanRow(
            row_index=i, name=c.name, url=c.url, username=c.username,
            password=c.password, notes=c.notes, action=action, match_id=match_id,
        ))
    return rows


def apply_csv_import_plan(
    entries: List[PasswordEntry], plan_rows: List[CsvImportPlanRow], selected_row_indices: List[int],
) -> "tuple[int, int]":
    """Applies the selected add/update rows of a plan_csv_import() result to `entries` in place.

    "unchanged", "superseded_in_batch" and unknown row_index are skipped silently (only a stale or
    replayed selection can include them). Returns (added_count, updated_count)."""
    plan_by_index = {r.row_index: r for r in plan_rows}
    added = updated = 0
    for idx in sorted(set(selected_row_indices)):
        row = plan_by_index.get(idx)
        if row is None or row.action not in ("add", "update"):
            continue
        if row.action == "add":
            entries.append(new_entry(name=row.name, url=row.url, username=row.username, password=row.password, notes=row.notes))
            added += 1
        else:
            for i, e in enumerate(entries):
                if e.id == row.match_id:
                    new_e = e.updated(name=row.name, url=row.url, username=row.username, password=row.password, notes=row.notes)
                    if new_e is not e:
                        entries[i] = new_e
                        updated += 1
                    break
    return added, updated


def export_csv(path: Path, entries: List[PasswordEntry]) -> None:
    """Writes a Chrome/Edge-compatible password export CSV.

    utf-8-sig (BOM) rather than utf-8: without it Excel on Chinese Windows opens non-ASCII text as
    mojibake. Chrome/Edge strip the BOM, so re-import is unaffected."""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_EXPORT_FIELDNAMES)
        writer.writeheader()
        for e in entries:
            writer.writerow({"name": e.name, "url": e.url, "username": e.username, "password": e.password})
