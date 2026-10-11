# 密码管理功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `modules/file_vault/` 内部新增密码管理功能——复用现有的多因素解锁体系（`_require_imk()`），提供密码条目的增删改查、Chrome/Edge/Firefox 密码 CSV 导入导出，界面和文件加密功能在同一个 Electron 应用里。

**Architecture:** 新增 `modules/file_vault/passwords.py`（纯逻辑层，条目加解密存取 + CSV 解析/导出，与 `container.py` 平级），`backend_server.py` 新增 6 个 RPC 方法复用已解锁的 IMK，渲染进程新增 `PasswordScreen.tsx` 并从 `MainScreen.tsx` 加一个入口按钮。不新建模块，不改动 `core/`。

**Tech Stack:** Python 3.9（`cryptography`、标准库 `csv`/`json`/`uuid`）、TypeScript + React + shadcn/ui（复用现有 Button/Input/Dialog/Card/Alert 组件，不新增依赖）、pytest。

**Spec:** `docs/superpowers/specs/2026-07-08-password-vault-design.md`（已通过 spec-document-reviewer 审核并经用户确认）

---

## Task 1: `passwords.py` 数据层——条目模型与加解密存取

**Files:**
- Create: `modules/file_vault/passwords.py`
- Test: `modules/file_vault/tests/test_passwords.py`

- [ ] **Step 1: 写失败的测试**

创建 `modules/file_vault/tests/test_passwords.py`：

```python
import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, passwords

IMK = crypto.generate_key()


def test_new_entry_generates_unique_id_and_timestamps():
    e1 = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")
    e2 = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")
    assert e1.id != e2.id
    assert e1.created_at == e1.updated_at


def test_save_and_load_vault_round_trip(tmp_path):
    entries = [
        passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2"),
        passwords.new_entry(name="Email", url="https://mail.example.com", username="me@example.com", password="p@ss"),
    ]
    passwords.save_password_vault(tmp_path, entries, IMK)

    loaded = passwords.load_password_vault(tmp_path, IMK)
    assert len(loaded) == 2
    assert loaded[0].name == "GitHub"
    assert loaded[1].password == "p@ss"


def test_load_password_vault_returns_empty_list_when_file_missing(tmp_path):
    assert passwords.load_password_vault(tmp_path, IMK) == []


def test_load_password_vault_wrong_imk_raises(tmp_path):
    entries = [passwords.new_entry(name="X", url="https://x.example", username="u", password="p")]
    passwords.save_password_vault(tmp_path, entries, IMK)

    wrong_imk = crypto.generate_key()
    with pytest.raises(passwords.PasswordVaultError):
        passwords.load_password_vault(tmp_path, wrong_imk)


def test_entry_updated_keeps_id_and_created_at_but_bumps_updated_at():
    original = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="old")
    changed = original.updated(name="GitHub", url="https://github.com", username="me", password="new")
    assert changed.id == original.id
    assert changed.created_at == original.created_at
    assert changed.password == "new"


def test_load_password_vault_rejects_unsupported_format_version(tmp_path):
    entries = [passwords.new_entry(name="X", url="https://x.example", username="u", password="p")]
    passwords.save_password_vault(tmp_path, entries, IMK)

    path = passwords.vault_path(tmp_path)
    blob = json.loads(path.read_text(encoding="utf-8"))
    blob["format_version"] = 999
    path.write_text(json.dumps(blob), encoding="utf-8")

    with pytest.raises(passwords.PasswordVaultError):
        passwords.load_password_vault(tmp_path, IMK)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'modules.file_vault.passwords'`（`passwords.py` 还不存在）

- [ ] **Step 3: 实现 `modules/file_vault/passwords.py`（第一部分：数据层，暂不含 CSV）**

```python
"""Password manager entries, encrypted as one JSON blob under the same
Identity Master Key (IMK) file_vault already uses to unlock files (see
identity.py). Deliberately not chunked like container.py's file streaming
format - the whole entry list is small (a personal password list is at
most tens of KB of JSON), so a single AES-256-GCM call per load/save is
already far faster than needed; chunking would just add complexity here
for no benefit.
"""

import base64
import csv
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse

from modules.file_vault import crypto

VAULT_FILENAME = "passwords.vault"
FORMAT_VERSION = 1


class PasswordVaultError(Exception):
    """passwords.vault exists but couldn't be decrypted or parsed, or a CSV
    being imported is missing required columns."""


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

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "PasswordEntry":
        return PasswordEntry(**d)

    def updated(self, *, name: str, url: str, username: str, password: str, notes: str = "") -> "PasswordEntry":
        """Return a new entry with the same id/created_at but fresh values
        and updated_at - used by password_update, never mutates self."""
        return PasswordEntry(
            id=self.id,
            name=name,
            url=url,
            username=username,
            password=password,
            notes=notes,
            created_at=self.created_at,
            updated_at=time.time(),
        )


def new_entry(name: str, url: str, username: str, password: str, notes: str = "") -> PasswordEntry:
    return PasswordEntry(id=str(uuid.uuid4()), name=name, url=url, username=username, password=password, notes=notes)


def vault_path(data_dir: Path) -> Path:
    return Path(data_dir) / VAULT_FILENAME


def load_password_vault(data_dir: Path, imk: bytes) -> List[PasswordEntry]:
    """Returns [] if the vault file doesn't exist yet (first use of the
    password manager). Raises PasswordVaultError if the file exists but
    can't be decrypted (wrong imk, corrupted file) or parsed."""
    path = vault_path(data_dir)
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        try:
            blob = json.load(f)
        except json.JSONDecodeError as exc:
            raise PasswordVaultError("密码库文件格式不正确") from exc

    if blob.get("format_version") != FORMAT_VERSION:
        raise PasswordVaultError(f"不支持的密码库格式版本: {blob.get('format_version')!r}")

    try:
        fk_nonce = base64.b64decode(blob["fk_wrap"]["nonce"])
        wrapped_fk = base64.b64decode(blob["fk_wrap"]["wrapped_fk"])
        content_nonce = base64.b64decode(blob["nonce"])
        ciphertext = base64.b64decode(blob["ciphertext"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PasswordVaultError("密码库文件格式不正确") from exc

    try:
        fk = crypto.unwrap_key(imk, fk_nonce, wrapped_fk)
        plaintext = crypto.aead_decrypt(fk, content_nonce, ciphertext)
    except crypto.InvalidTag as exc:
        raise PasswordVaultError("无法用当前密钥解开密码库（密钥不匹配或文件已损坏）") from exc

    try:
        entries_json = json.loads(plaintext.decode("utf-8"))
        return [PasswordEntry.from_json(e) for e in entries_json]
    except (json.JSONDecodeError, TypeError, UnicodeDecodeError) as exc:
        raise PasswordVaultError("密码库内容已损坏") from exc


def save_password_vault(data_dir: Path, entries: List[PasswordEntry], imk: bytes) -> None:
    """Re-encrypts and rewrites the whole vault file. A fresh File Key is
    generated on every save (matches container.py's per-file FK pattern),
    written atomically via a temp file + replace so a crash mid-write can
    never leave passwords.vault half-written."""
    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
    content_nonce = crypto.random_nonce()
    plaintext = json.dumps([e.to_json() for e in entries], ensure_ascii=False).encode("utf-8")
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
```

注意：这一步暂时保留了 `import csv`、`from urllib.parse import urlparse`、`from typing import Optional` 但还没用到——它们是 Task 2 要加的 CSV 功能需要的，先加进去避免 Task 2 还要改 import 段。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py -v`
Expected: PASS（6 项全绿）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/passwords.py modules/file_vault/tests/test_passwords.py
git commit -m "Add password vault data layer (entries + encrypted storage)"
```

---

## Task 2: `passwords.py` —— CSV 导入导出

**Files:**
- Modify: `modules/file_vault/passwords.py`
- Test: `modules/file_vault/tests/test_passwords.py`

- [ ] **Step 1: 追加失败的测试**

在 `modules/file_vault/tests/test_passwords.py` 末尾追加：

```python
def test_parse_csv_chrome_format(tmp_path):
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com/login,me,hunter2\n",
        encoding="utf-8",
    )
    entries = passwords.parse_csv(csv_path)
    assert len(entries) == 1
    assert entries[0].name == "GitHub"
    assert entries[0].url == "https://github.com/login"
    assert entries[0].username == "me"
    assert entries[0].password == "hunter2"


def test_parse_csv_firefox_format_without_name_column_falls_back_to_hostname(tmp_path):
    csv_path = tmp_path / "firefox_logins.csv"
    csv_path.write_text(
        "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\n"
        "https://example.com/login,me,hunter2,,https://example.com,{abc},0,0,0\n",
        encoding="utf-8",
    )
    entries = passwords.parse_csv(csv_path)
    assert len(entries) == 1
    assert entries[0].name == "example.com"
    assert entries[0].username == "me"


def test_parse_csv_missing_required_column_raises(tmp_path):
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("name,url\nGitHub,https://github.com\n", encoding="utf-8")
    with pytest.raises(passwords.PasswordVaultError):
        passwords.parse_csv(csv_path)


def test_export_csv_writes_chrome_compatible_format(tmp_path):
    entries = [passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")]
    out_path = tmp_path / "export.csv"
    passwords.export_csv(out_path, entries)

    content = out_path.read_text(encoding="utf-8")
    lines = content.strip().splitlines()
    assert lines[0] == "name,url,username,password"
    assert lines[1] == "GitHub,https://github.com,me,hunter2"
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py -v -k csv`
Expected: FAIL — `AttributeError: module 'modules.file_vault.passwords' has no attribute 'parse_csv'`

- [ ] **Step 3: 在 `passwords.py` 末尾追加 CSV 导入导出实现**

```python
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


def parse_csv(path: Path) -> List[PasswordEntry]:
    """Parses a password export CSV from Chrome/Edge (name,url,username,
    password) or Firefox (url,username,password,... - no name column, in
    which case the entry's name falls back to the URL's hostname).
    Raises PasswordVaultError if the required url/username/password
    columns can't be found."""
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise PasswordVaultError("CSV 文件是空的或格式不正确")
        lower_fieldnames = {fn.lower(): fn for fn in reader.fieldnames}

        name_col = _find_column(lower_fieldnames, _NAME_ALIASES)
        url_col = _find_column(lower_fieldnames, _URL_ALIASES)
        username_col = _find_column(lower_fieldnames, _USERNAME_ALIASES)
        password_col = _find_column(lower_fieldnames, _PASSWORD_ALIASES)

        if url_col is None or username_col is None or password_col is None:
            raise PasswordVaultError("CSV 缺少必需的 url/username/password 列，无法识别这个文件的格式")

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


def export_csv(path: Path, entries: List[PasswordEntry]) -> None:
    """Writes a Chrome/Edge-compatible password export CSV (their own
    'import passwords' feature reads this exact format directly)."""
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_EXPORT_FIELDNAMES)
        writer.writeheader()
        for e in entries:
            writer.writerow({"name": e.name, "url": e.url, "username": e.username, "password": e.password})
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py -v`
Expected: PASS（10 项全绿）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/passwords.py modules/file_vault/tests/test_passwords.py
git commit -m "Add Chrome/Edge/Firefox CSV import and Chrome-compatible export"
```

---

## Task 3: `backend_server.py` RPC —— 增删改查

**Files:**
- Modify: `modules/file_vault/backend_server.py:29` (import), `:32-35` (globals), 插入新函数于第 236 行 `rpc_send_test_email` 之后、第 239 行 `# --- RPC methods that need the request id ---` 注释之前, `:283-303` (`_METHODS` 字典)
- Test: `modules/file_vault/tests/test_backend_server.py`

- [ ] **Step 1: 追加失败的测试**

在 `modules/file_vault/tests/test_backend_server.py` 末尾追加（复用文件里已有的 `client` fixture）：

```python
def _setup_and_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})


def test_password_list_empty_before_any_entries(client):
    _setup_and_unlock(client)
    result, _, error = client.call("password_list", {})
    assert error is None
    assert result == {"entries": []}


def test_password_add_and_list_round_trip(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert error is None
    assert result["ok"] is True
    entry_id = result["entry"]["id"]

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 1
    assert result["entries"][0]["id"] == entry_id
    assert result["entries"][0]["password"] == "hunter2"


def test_password_update_changes_fields_but_keeps_id(client):
    _setup_and_unlock(client)
    result, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = result["entry"]["id"]

    result, _, error = client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "new-pass"},
    )
    assert error is None
    assert result["ok"] is True
    assert result["entry"]["id"] == entry_id
    assert result["entry"]["password"] == "new-pass"


def test_password_update_unknown_id_reports_error_not_crash(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_update",
        {"id": "does-not-exist", "name": "X", "url": "https://x.example", "username": "u", "password": "p"},
    )
    assert error is None
    assert result == {"ok": False, "error": "找不到这条密码记录"}


def test_password_delete_removes_entry(client):
    _setup_and_unlock(client)
    result, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    entry_id = result["entry"]["id"]

    result, _, error = client.call("password_delete", {"id": entry_id})
    assert error is None
    assert result == {"ok": True}

    result, _, _ = client.call("password_list", {})
    assert result["entries"] == []


def test_password_operations_before_unlock_report_error_not_crash(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("password_list", {})
    assert result is None
    assert error == "尚未解锁"
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k password`
Expected: FAIL — 每个用例都报 `"Unknown method: password_list"` 之类的错误（RPC 方法还没注册）

- [ ] **Step 3: 修改 `backend_server.py`**

第 29 行，把：
```python
from modules.file_vault import container, email_otp, identity  # noqa: E402
```
改成：
```python
from modules.file_vault import container, email_otp, identity, passwords  # noqa: E402
```

第 35 行 `_pending_otp: Optional[email_otp.PendingOtp] = None` 之后新增一行全局状态：
```python
_password_entries: Optional[list] = None
```

在第 236 行 `rpc_send_test_email` 函数结尾之后、第 239 行 `# --- RPC methods that need the request id ---` 注释之前，插入：

```python
def _require_password_entries(imk: bytes):
    global _password_entries
    if _password_entries is None:
        try:
            _password_entries = passwords.load_password_vault(_data_dir, imk)
        except passwords.PasswordVaultError as exc:
            raise RuntimeError(str(exc))
    return _password_entries


def rpc_password_list(params):
    imk = _require_imk()
    entries = _require_password_entries(imk)
    return {"entries": [e.to_json() for e in entries]}


def rpc_password_add(params):
    imk = _require_imk()
    entries = _require_password_entries(imk)
    entry = passwords.new_entry(
        name=params["name"],
        url=params["url"],
        username=params["username"],
        password=params["password"],
        notes=params.get("notes", ""),
    )
    entries.append(entry)
    passwords.save_password_vault(_data_dir, entries, imk)
    return {"ok": True, "entry": entry.to_json()}


def rpc_password_update(params):
    imk = _require_imk()
    entries = _require_password_entries(imk)
    for i, e in enumerate(entries):
        if e.id == params["id"]:
            updated = e.updated(
                name=params["name"],
                url=params["url"],
                username=params["username"],
                password=params["password"],
                notes=params.get("notes", ""),
            )
            entries[i] = updated
            passwords.save_password_vault(_data_dir, entries, imk)
            return {"ok": True, "entry": updated.to_json()}
    return {"ok": False, "error": "找不到这条密码记录"}


def rpc_password_delete(params):
    global _password_entries
    imk = _require_imk()
    entries = _require_password_entries(imk)
    new_entries = [e for e in entries if e.id != params["id"]]
    if len(new_entries) == len(entries):
        return {"ok": False, "error": "找不到这条密码记录"}
    _password_entries = new_entries
    passwords.save_password_vault(_data_dir, new_entries, imk)
    return {"ok": True}
```

在 `_METHODS` 字典（第 283-303 行）的 `"send_test_email": rpc_send_test_email,` 这一行之后追加：
```python
    "password_list": rpc_password_list,
    "password_add": rpc_password_add,
    "password_update": rpc_password_update,
    "password_delete": rpc_password_delete,
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: PASS（全部现有 + 新增用例都绿）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Add password CRUD RPC methods to backend_server.py"
```

---

## Task 4: `backend_server.py` RPC —— CSV 导入导出

**Files:**
- Modify: `modules/file_vault/backend_server.py`（Task 3 新增函数之后追加，`_METHODS` 字典追加两项）
- Test: `modules/file_vault/tests/test_backend_server.py`

- [ ] **Step 1: 追加失败的测试**

```python
def test_password_import_csv_adds_entries_and_deletes_source_by_default(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com,me,hunter2\n"
        "Email,https://mail.example.com,me@example.com,p@ss\n",
        encoding="utf-8",
    )

    result, _, error = client.call("password_import_csv", {"input_path": str(csv_path)})
    assert error is None
    assert result["ok"] is True
    assert result["imported_count"] == 2
    assert result["source_deleted"] is True
    assert not csv_path.exists()

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 2


def test_password_import_csv_can_keep_source_file(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text("name,url,username,password\nGitHub,https://github.com,me,hunter2\n", encoding="utf-8")

    result, _, error = client.call(
        "password_import_csv", {"input_path": str(csv_path), "delete_source_csv": False}
    )
    assert error is None
    assert "source_deleted" not in result
    assert csv_path.exists()


def test_password_import_csv_bad_format_reports_error(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("name,url\nGitHub,https://github.com\n", encoding="utf-8")

    result, _, error = client.call("password_import_csv", {"input_path": str(csv_path)})
    assert error is None
    assert result["ok"] is False
    assert "url/username/password" in result["error"]


def test_password_export_csv_writes_all_entries(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )

    out_path = tmp_path / "export.csv"
    result, _, error = client.call("password_export_csv", {"output_path": str(out_path)})
    assert error is None
    assert result["ok"] is True
    content = out_path.read_text(encoding="utf-8")
    assert "GitHub,https://github.com,me,hunter2" in content
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k csv`
Expected: FAIL — `"Unknown method: password_import_csv"` / `password_export_csv`

- [ ] **Step 3: 在 `backend_server.py` 里 Task 3 新增函数之后追加**

```python
def rpc_password_import_csv(params):
    imk = _require_imk()
    entries = _require_password_entries(imk)
    input_path = params["input_path"]
    try:
        imported = passwords.parse_csv(Path(input_path))
    except passwords.PasswordVaultError as exc:
        return {"ok": False, "error": str(exc)}

    entries.extend(imported)
    passwords.save_password_vault(_data_dir, entries, imk)

    result = {"ok": True, "imported_count": len(imported)}
    # 保存成功之后才清理源文件——万一保存失败，CSV 原文件还在，不会两头都丢数据。
    if params.get("delete_source_csv", True):
        try:
            container.secure_delete_file(Path(input_path))
            result["source_deleted"] = True
        except Exception as exc:
            result["source_deleted"] = False
            result["delete_error"] = str(exc)
    return result


def rpc_password_export_csv(params):
    imk = _require_imk()
    entries = _require_password_entries(imk)
    output_path = params["output_path"]
    passwords.export_csv(Path(output_path), entries)
    return {"ok": True, "output_path": output_path}
```

在 `_METHODS` 字典里 Task 3 新增的四行之后追加：
```python
    "password_import_csv": rpc_password_import_csv,
    "password_export_csv": rpc_password_export_csv,
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: PASS

- [ ] **Step 5: 跑一次全量 Python 测试套件确认没有破坏其他东西**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault -q`
Expected: PASS，全部通过（含 Task 1-4 新增的用例）

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Add password CSV import/export RPC methods with secure-delete-source"
```

---

## Task 5: 前端类型定义

**Files:**
- Modify: `modules/file_vault/ui/src/shared/ipcTypes.ts`

- [ ] **Step 1: 在 `ContainerHeader` 接口（第 20-28 行）之后、`export interface VaultMethods {`（第 30 行）之前插入**

```typescript
export interface PasswordEntry {
  id: string
  name: string
  url: string
  username: string
  password: string
  notes: string
  created_at: number
  updated_at: number
}
```

- [ ] **Step 2: 在 `VaultMethods` 接口里，`decrypt_file` 那一项（原第 67-70 行）之后、`change_password`（原第 71 行）之前插入**

```typescript
  password_list: { params: Record<string, never>; result: { entries: PasswordEntry[] } }
  password_add: {
    params: { name: string; url: string; username: string; password: string; notes?: string }
    result: { ok: true; entry: PasswordEntry } | { ok: false; error: string }
  }
  password_update: {
    params: { id: string; name: string; url: string; username: string; password: string; notes?: string }
    result: { ok: true; entry: PasswordEntry } | { ok: false; error: string }
  }
  password_delete: { params: { id: string }; result: { ok: true } | { ok: false; error: string } }
  password_import_csv: {
    params: { input_path: string; delete_source_csv?: boolean }
    result:
      | { ok: true; imported_count: number; source_deleted?: boolean; delete_error?: string }
      | { ok: false; error: string }
  }
  password_export_csv: {
    params: { output_path: string }
    result: { ok: true; output_path: string } | { ok: false; error: string }
  }
```

- [ ] **Step 3: 类型检查确认没有编译错误**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit`
Expected: 无输出（成功，尚未有任何代码消费这些新类型，仅确认新增类型本身语法正确）

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/shared/ipcTypes.ts
git commit -m "Add PasswordEntry and password RPC method types"
```

---

## Task 6: `PasswordScreen.tsx` —— 列表、搜索、增删改、导入导出 UI

**Files:**
- Create: `modules/file_vault/ui/src/components/PasswordScreen.tsx`

此文件跟 `SettingsScreen.tsx` 的组织方式一致：一个主屏幕组件 + 一个编辑用的 Dialog 子组件放在同一个文件里。这一步没有自动化测试（项目里现有的 React 组件也都没有单测，一致沿用 `tsc`/`eslint` + 手动走查的验证方式，见 spec 里"测试计划"一节）。

- [ ] **Step 1: 创建 `modules/file_vault/ui/src/components/PasswordScreen.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import type { PasswordEntry } from '@/shared/ipcTypes'

export function PasswordScreen({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<PasswordEntry[]>([])
  const [search, setSearch] = useState('')
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<PasswordEntry | 'new' | null>(null)

  async function reload() {
    const res = await vaultApi.call('password_list', {})
    setEntries(res.entries)
  }

  useEffect(() => {
    reload()
  }, [])

  const filtered = entries.filter((e) => {
    const q = search.toLowerCase()
    return e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
  })

  async function handleDelete(id: string) {
    const res = await vaultApi.call('password_delete', { id })
    if (!res.ok) {
      toast.error('删除失败', { description: res.error })
      return
    }
    toast.success('已删除')
    await reload()
  }

  async function handleImport() {
    const paths = await electronApi.openFiles({
      title: '选择浏览器导出的密码 CSV',
      properties: ['openFile'],
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (!paths || paths.length === 0) return
    const res = await vaultApi.call('password_import_csv', { input_path: paths[0] })
    if (!res.ok) {
      toast.error('导入失败', { description: res.error })
      return
    }
    toast.success(`导入了 ${res.imported_count} 条密码${res.source_deleted ? '，已安全删除原 CSV 文件' : ''}`)
    await reload()
  }

  async function handleExport() {
    const outputPath = await electronApi.saveFile({
      title: '导出密码为 CSV',
      defaultPath: 'passwords.csv',
    })
    if (!outputPath) return
    const res = await vaultApi.call('password_export_csv', { output_path: outputPath })
    if (!res.ok) {
      toast.error('导出失败', { description: res.error })
      return
    }
    toast.success('导出完成', {
      action: { label: '打开所在文件夹', onClick: () => electronApi.showItemInFolder(res.output_path) },
    })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <Card className="w-[560px]">
        <CardHeader>
          <CardTitle>密码管理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="搜索名称/网址/用户名" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button onClick={() => setEditing('new')}>新增</Button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={handleImport}>
              导入 CSV
            </Button>
            <Button variant="outline" className="flex-1" onClick={handleExport}>
              导出 CSV
            </Button>
          </div>

          <div className="max-h-96 space-y-2 overflow-y-auto">
            {filtered.length === 0 && <p className="text-sm text-muted-foreground">还没有密码记录</p>}
            {filtered.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-2 rounded border p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{entry.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{entry.username}</p>
                  <p className="truncate font-mono text-xs">{revealed[entry.id] ? entry.password : '••••••••'}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRevealed((r) => ({ ...r, [entry.id]: !r[entry.id] }))}
                  >
                    {revealed[entry.id] ? '隐藏' : '显示'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(entry.password)}>
                    复制
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(entry)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => handleDelete(entry.id)}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <Button className="w-full" variant="outline" onClick={onBack}>
            返回
          </Button>
        </CardContent>
      </Card>

      <PasswordEditDialog
        entry={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await reload()
        }}
      />
    </div>
  )
}

function PasswordEditDialog({
  entry,
  open,
  onOpenChange,
  onSaved,
}: {
  entry: PasswordEntry | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setName(entry?.name ?? '')
      setUrl(entry?.url ?? '')
      setUsername(entry?.username ?? '')
      setPassword(entry?.password ?? '')
      setNotes(entry?.notes ?? '')
      setError('')
    }
  }, [open, entry])

  async function handleSave() {
    if (!name.trim() || !url.trim()) {
      setError('名称和网址不能为空')
      return
    }
    const params = { name, url, username, password, notes }
    const res = entry
      ? await vaultApi.call('password_update', { id: entry.id, ...params })
      : await vaultApi.call('password_add', params)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? '编辑密码' : '新增密码'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="pw-name">名称</Label>
            <Input id="pw-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw-url">网址</Label>
            <Input id="pw-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw-username">用户名</Label>
            <Input id="pw-username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw-password">密码</Label>
            <Input id="pw-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw-notes">备注</Label>
            <Input id="pw-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button className="w-full" onClick={handleSave}>
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: 两条命令都无输出（成功）

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/components/PasswordScreen.tsx
git commit -m "Add PasswordScreen: list/search/reveal/CRUD/CSV import-export UI"
```

---

## Task 7: 接入入口——`App.tsx` + `MainScreen.tsx`

**Files:**
- Modify: `modules/file_vault/ui/src/App.tsx`
- Modify: `modules/file_vault/ui/src/components/MainScreen.tsx`

- [ ] **Step 1: 修改 `App.tsx`**

第 8 行 `type View = 'loading' | 'setup' | 'main' | 'settings'` 改成：
```typescript
type View = 'loading' | 'setup' | 'main' | 'settings' | 'passwords'
```

第 5 行 `import { SettingsScreen } from '@/components/SettingsScreen'` 之后新增：
```typescript
import { PasswordScreen } from '@/components/PasswordScreen'
```

第 21 行 `{view === 'main' && <MainScreen onOpenSettings={() => setView('settings')} />}` 改成：
```tsx
{view === 'main' && (
  <MainScreen onOpenSettings={() => setView('settings')} onOpenPasswords={() => setView('passwords')} />
)}
```

第 22 行 `{view === 'settings' && <SettingsScreen onBack={() => setView('main')} />}` 之后新增：
```tsx
{view === 'passwords' && <PasswordScreen onBack={() => setView('main')} />}
```

- [ ] **Step 2: 修改 `MainScreen.tsx`**

第 48 行：
```typescript
export function MainScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
```
改成：
```typescript
export function MainScreen({
  onOpenSettings,
  onOpenPasswords,
}: {
  onOpenSettings: () => void
  onOpenPasswords: () => void
}) {
```

第 227-230 行的 `handleSettings` 函数之后新增：
```tsx
  async function handlePasswords() {
    if (!(await ensureUnlocked())) return
    onOpenPasswords()
  }
```

第 259-261 行的"设置"按钮（`<Button ... onClick={handleSettings} ...>设置</Button>`）之后新增：
```tsx
          <Button className="w-full" variant="outline" onClick={handlePasswords} disabled={showProgress}>
            密码管理
          </Button>
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: 两条命令都无输出（成功）

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/App.tsx modules/file_vault/ui/src/components/MainScreen.tsx
git commit -m "Wire up 密码管理 entry point from MainScreen"
```

---

## Task 8: 更新文档

**Files:**
- Modify: `modules/file_vault/README.md`

- [ ] **Step 1: 在 README 里新增一节，说明密码管理功能和刻意偏离模块化约定的原因**

在现有"加密范围 / 批量操作 / 删除源文件"小节之后追加：

```markdown
### 密码管理

除了文件加密，同一个应用里还有一个"密码管理"页面（主界面点"密码管理"进入，解锁方式跟文件加密完全一样，共用同一个 IMK）：

- 增删改查密码条目（名称/网址/用户名/密码/备注），列表里密码默认打码显示，可以单独切换显示或直接复制。
- 支持导入 Chrome/Edge/Firefox 手动导出的密码 CSV（浏览器"设置→密码管理器→导出密码"生成的那个文件），自动识别列名，Firefox 导出没有"名称"列时用网址域名兜底。导入成功后默认会把那份明文 CSV 安全删除（覆写后删除），避免它躺在磁盘上而使密码管理形同虚设——不想删可以在导入时取消勾选。
- 导出成 Chrome/Edge 兼容的 CSV 格式，可以直接用浏览器自己的"导入密码"功能读取。**不支持导出成 Firefox 专用格式**（Firefox 导入要求额外的 guid/timeCreated 等字段，目前没有实现，这属于有意识的范围裁剪）。

**架构上的一个刻意偏离**：项目约定（见 `modules/README.md`）是"一个模块文件夹 = 一个独立场景，模块间不互相 import"。密码管理功能本应该是一个独立的 `modules/password_vault/`，但用户明确要求"密码管理界面和文件加密界面是同一个应用"，独立模块做不到这一点（除非先把身份系统提升到 `core/`，且两个应用各自维护一个窗口，观感上仍是两个 app）。因此密码管理直接实现在 `modules/file_vault/` 内部（`passwords.py` + `backend_server.py` 里的 RPC + `PasswordScreen.tsx`），复用同一套已解锁的 IMK。这是权衡后的有意选择，不是疏忽。
```

- [ ] **Step 2: 在"手动验证清单"小节（`modules/file_vault/README.md:60-66`）的第 3 条之后追加密码管理的手动验证项**

```markdown
4. 点"密码管理"进入，走一遍新增/编辑/删除/搜索/显示隐藏密码/复制到剪贴板，确认都正常。
5. 用真实浏览器（Chrome 或 Edge）导出一份密码 CSV，在"密码管理"里导入，确认条目正确、原 CSV 被安全删除；再导出一份 CSV，确认能被浏览器的"导入密码"功能正常读取。
```

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/README.md
git commit -m "Document the password manager feature and its architecture trade-off"
```

---

## Task 9: 全量验证

**Files:** 无新增/修改，只运行验证命令。

- [ ] **Step 1: 全量 Python 测试**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault -q`
Expected: PASS，全部通过（含 Task 1-4 新增的密码相关用例）

- [ ] **Step 2: 前端类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: 两条命令都无输出（成功）

- [ ] **Step 3: 手动走查（记录在 README"手动验证清单"里，不是自动化步骤）**

以下几项本计划不做自动化（原因见 spec 的"测试计划"一节——原生文件对话框无法通过脚本驱动）：
- `npm run dev` 打开应用，点"密码管理"进入，确认列表/搜索/显示隐藏/复制/新增/编辑/删除都正常。
- 找一个真实浏览器导出一份密码 CSV（Chrome 或 Edge：设置→密码管理器→导出密码），在应用里点"导入 CSV"，确认条目正确导入、原 CSV 被删除。
- 点"导出 CSV"，用 Chrome/Edge 的"导入密码"功能验证导出的文件能被正常读取。

- [ ] **Step 4: 如果这次改动要打包进现有的 exe（`modules/file_vault/ui/release/`），跑完整构建**

Run: `cd "<repo>\modules\file_vault\ui" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run build`
Expected: `tsc && vite build && electron-builder` 三步都成功，产物在 `release/<version>/Ideal1 File Vault-Windows-<version>.exe`
