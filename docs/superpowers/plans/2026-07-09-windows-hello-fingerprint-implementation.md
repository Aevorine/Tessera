# Windows Hello 指纹解锁 + 登录页重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 file_vault 的"机器指纹"因子换成真正的 Windows Hello 生物指纹认证，并把启动流程从"主界面先出现、点按钮才检查解锁"改成"启动先进登录页，验证通过才能进主界面"的硬性关卡模式。

**Architecture:** `fingerprint.py` 内部实现从读 WMI 硬件标识改为封装 `winrt` 包调用 `UserConsentVerifier`（阻塞式真实提示框）；`identity.py`/`backend_server.py` 的指纹相关函数/RPC 相应改造，`SLOT_FINGERPRINT` 变为可选槽位；`require_manual_unlock` 开关整体删除（登录页重构后失去意义）；前端新增 `LoginScreen.tsx` 作为 `App.tsx` 的启动关卡，`MainScreen.tsx` 里各按钮的"先偷偷试指纹"逻辑随之移除。

**Tech Stack:** Python 3.9 + `winrt-Windows.Security.Credentials.UI`/`winrt-Windows.Foundation`（已在本机验证可用）、TypeScript + React + shadcn/ui、pytest。

**Spec:** `docs/superpowers/specs/2026-07-09-windows-hello-fingerprint-design.md`（已通过两轮 spec-document-reviewer 审核并经用户确认）

**关于 `setup_verify_fingerprint` 这个 RPC**：spec 文档"后端改动"一节列出的三个新 RPC（`unlock_fingerprint`/`setup_check_fingerprint_available`/`rebind_fingerprint`）都需要已存在的身份数据（`_require_store()`）或已解锁的 IMK（`_require_imk()`），但 spec"前端改动"一节明确要求 `SetupWizard` 在指纹步骤"弹出真实验证一次作为确认"——这一步发生在身份还不存在的时候，三个已列出的 RPC 都用不了。本计划补一个 `setup_verify_fingerprint`（镜像 `setup_verify_totp` 的"本地检查、不落盘"语义），这是实现 spec 里已经写明的向导流程所必需的，不是新范围。

---

## Task 1: `fingerprint.py` 换成 Windows Hello

**Files:**
- Modify: `modules/file_vault/fingerprint.py`（整个重写）
- Modify: `modules/file_vault/tests/test_fingerprint.py`（整个重写）

- [ ] **Step 1: 安装依赖**

Run: `pip install winrt-Windows.Security.Credentials.UI winrt-Windows.Foundation`
Expected: 安装成功（本机已经装过，这一步在其他机器上首次跑才会真的下载）

- [ ] **Step 2: 写失败的测试，整个替换 `test_fingerprint.py`**

```python
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import fingerprint


def test_generate_bio_secret_is_32_bytes_and_random():
    s1 = fingerprint.generate_bio_secret()
    s2 = fingerprint.generate_bio_secret()
    assert isinstance(s1, bytes)
    assert len(s1) == 32
    assert s1 != s2


def test_is_available_returns_a_bool_without_raising():
    # Doesn't assert True/False - that depends on the test machine's own
    # Windows Hello configuration. Only asserts the check itself never
    # raises and always resolves to a real boolean.
    result = fingerprint.is_available()
    assert isinstance(result, bool)
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_fingerprint.py -v`
Expected: FAIL — `AttributeError: module 'modules.file_vault.fingerprint' has no attribute 'generate_bio_secret'`

- [ ] **Step 4: 整个重写 `modules/file_vault/fingerprint.py`**

```python
"""Real biometric fingerprint unlock via Windows Hello. Replaces the old
machine-hardware-identifier scheme (motherboard serial + CPU ID via WMI):
SLOT_FINGERPRINT in identity_store.json is the same slot name, but the
secret behind it is now a random value gated by an actual Windows Hello
fingerprint prompt, not a silently-read hardware ID - unlocking via this
factor requires physically touching the sensor each time.

Async WinRT calls are bridged into this module's synchronous functions via
asyncio.run() - acceptable because backend_server.py already processes one
NDJSON request at a time and blocking is already its model (see its own
module docstring), and there's no long-lived event loop here to conflict
with.
"""

import asyncio
import secrets

from core.logging import get_logger

logger = get_logger(__name__)


class FingerprintUnavailableError(RuntimeError):
    """Windows Hello isn't usable on this machine, or the verification
    call itself failed for a system-level reason (not just the user
    cancelling or failing the biometric check)."""


def is_available() -> bool:
    """True if Windows Hello is configured and usable on this machine.
    Never raises - any failure to even check counts as unavailable."""
    try:
        from winrt.windows.security.credentials.ui import (
            UserConsentVerifier,
            UserConsentVerifierAvailability,
        )
    except ImportError:
        return False

    async def _check():
        return await UserConsentVerifier.check_availability_async()

    try:
        availability = asyncio.run(_check())
    except Exception:
        logger.warning("Failed to check Windows Hello availability", exc_info=True)
        return False
    return availability == UserConsentVerifierAvailability.AVAILABLE


def generate_bio_secret() -> bytes:
    """A fresh random secret to store in keyring at setup/rebind time,
    HKDF'd exactly like the TOTP/email factors' secrets."""
    return secrets.token_bytes(32)


def request_verification(message: str = "请验证指纹以解锁 Ideal1 File Vault") -> bool:
    """Blocks showing the native Windows Hello prompt until the user
    completes or cancels it. Returns True only on a successful biometric
    verification, False if the user simply cancelled (not an error - same
    semantics as "wrong password"). Raises FingerprintUnavailableError only
    for genuine system-level problems (no Windows Hello configured, sensor
    busy, etc.) - callers should surface that as a distinct error message
    rather than a plain "didn't work"."""
    try:
        from winrt.windows.security.credentials.ui import (
            UserConsentVerificationResult,
            UserConsentVerifier,
        )
    except ImportError as exc:
        raise FingerprintUnavailableError("Windows Hello 组件未安装") from exc

    async def _verify():
        return await UserConsentVerifier.request_verification_async(message)

    try:
        result = asyncio.run(_verify())
    except Exception as exc:
        logger.warning("Windows Hello verification call failed", exc_info=True)
        raise FingerprintUnavailableError("指纹验证过程出错") from exc

    if result == UserConsentVerificationResult.VERIFIED:
        return True
    if result == UserConsentVerificationResult.CANCELED:
        return False

    messages = {
        UserConsentVerificationResult.DEVICE_NOT_PRESENT: "这台电脑没有指纹传感器",
        UserConsentVerificationResult.NOT_CONFIGURED_FOR_USER: "这台电脑未配置 Windows Hello 指纹",
        UserConsentVerificationResult.DISABLED_BY_POLICY: "Windows Hello 指纹已被系统策略禁用",
        UserConsentVerificationResult.DEVICE_BUSY: "指纹传感器正忙，请稍后重试",
        UserConsentVerificationResult.RETRIES_EXHAUSTED: "指纹验证失败次数过多，请稍后重试",
    }
    raise FingerprintUnavailableError(messages.get(result, "指纹验证失败"))
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_fingerprint.py -v`
Expected: PASS（2 项全绿）

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/fingerprint.py modules/file_vault/tests/test_fingerprint.py
git commit -m "Replace machine-hardware fingerprint with real Windows Hello biometric verification"
```

---

## Task 2: `identity.py` —— 指纹槽位可选化 + 删除 AppSettings

**Files:**
- Modify: `modules/file_vault/identity.py`
- Modify: `modules/file_vault/tests/test_identity.py`

- [ ] **Step 1: 修改测试**

在 `modules/file_vault/tests/test_identity.py` 里，把 `store` fixture（第 37-45 行）改成：

```python
@pytest.fixture
def store(tmp_path, fake_keyring):
    return identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=TOTP_SEED,
        email_address=EMAIL,
        recovery_key=RECOVERY_KEY,
        enable_fingerprint=True,
    )
```

`test_setup_identity_creates_all_five_slots`（第 48-50 行）、`test_setup_identity_persists_and_reloads`（第 53-56 行）的断言本身不用改——`store` fixture 现在默认带上指纹槽位，`set(store.slots.keys()) == set(identity.ALL_SLOTS)` 依然成立。

删掉这三个测试：
- `test_load_app_settings_defaults_to_auto_unlock_allowed`（第 154-156 行，`AppSettings` 功能本身被删除，不是重写）
- `test_save_and_load_app_settings_round_trip`（第 159-162 行，同上）
- `test_unlock_via_fingerprint_matches_current_machine`（第 90-93 行）——**这一条必须删，不能漏**：它直接调用 `identity.try_unlock_via_fingerprint(store)`，不带任何 `monkeypatch`。Step 3 改完之后，`try_unlock_via_fingerprint()` 只要槽位存在就会调用真实的 `fingerprint.request_verification()`，而新版 `store` fixture 默认就带指纹槽位（本步骤开头已经改成 `enable_fingerprint=True`）——如果这个测试留着，跑 `pytest` 会在没人值守的情况下弹出一个真实的、阻塞的 Windows Hello 系统提示框，测试会卡住而不是干净地通过或失败。等价的场景已经由 Step 4 新增的 `test_unlock_via_fingerprint_success_when_verification_succeeds`（用 `monkeypatch` 模拟验证通过）覆盖，直接删掉这个旧测试即可，不需要重写。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_identity.py -v`
Expected: FAIL —— `test_setup_identity_creates_all_five_slots`/`test_setup_identity_persists_and_reloads` 报 `TypeError: setup_identity() got an unexpected keyword argument 'enable_fingerprint'`；`test_unlock_via_fingerprint_returns_none_on_different_machine` 报 `AttributeError: <module 'fingerprint'> does not have the attribute 'compute_fingerprint'`（因为 Task 1 已经删掉了这个函数）

- [ ] **Step 3: 修改 `identity.py`**

第 34-36 行，在 `KEYRING_EMAIL_SECRET` 之后追加：
```python
KEYRING_BIO_SECRET = "bio_secret"
```

第 157-185 行的 `setup_identity()` 整个替换为：
```python
def setup_identity(
    data_dir: Path,
    password: str,
    totp_seed: str,
    email_address: Optional[str],
    recovery_key: str,
    enable_fingerprint: bool = False,
) -> IdentityStore:
    """Create a brand-new identity: generate IMK, wrap it 4-5 ways
    (password/TOTP/email/recovery always; fingerprint only if
    enable_fingerprint - the caller must have already confirmed Windows
    Hello is available and completed a real verification as part of the
    setup wizard before passing True here), persist the wrapped slots to
    disk and the TOTP seed/email secret/bio secret to keyring. Called once
    by the setup wizard, after the user has already seen and confirmed the
    TOTP QR code and the recovery key.
    """
    imk = crypto.generate_key()
    email_secret = crypto.generate_key()  # independent of TOTP seed / password

    slots = {
        SLOT_PASSWORD: _wrap_scrypt(imk, password.encode("utf-8")),
        SLOT_TOTP: _wrap_hkdf(imk, totp_seed.encode("utf-8"), INFO_TOTP),
        SLOT_EMAIL: _wrap_hkdf(imk, email_secret, INFO_EMAIL),
        SLOT_RECOVERY: _wrap_scrypt(imk, recovery_key.strip().encode("utf-8")),
    }

    bio_secret = None
    if enable_fingerprint:
        bio_secret = fingerprint.generate_bio_secret()
        slots[SLOT_FINGERPRINT] = _wrap_hkdf(imk, bio_secret, INFO_FINGERPRINT)

    store = IdentityStore(email_address=email_address, slots=slots)
    save_identity_store(data_dir, store)

    keyring.set_password(SERVICE_NAME, KEYRING_TOTP_SEED, totp_seed)
    keyring.set_password(SERVICE_NAME, KEYRING_EMAIL_SECRET, base64.b64encode(email_secret).decode())
    if bio_secret is not None:
        keyring.set_password(SERVICE_NAME, KEYRING_BIO_SECRET, base64.b64encode(bio_secret).decode())

    return store
```

第 244-259 行的 `try_unlock_via_fingerprint()` 整个替换为：
```python
def try_unlock_via_fingerprint(store: IdentityStore) -> Optional[bytes]:
    """Requires the caller to have already decided to attempt this factor
    (e.g. the user clicked the "指纹" tab on the login screen) - shows a
    real, blocking Windows Hello prompt and only returns non-None if the
    user actually completes a successful biometric verification.

    Returns None (not an error) if: no fingerprint factor is bound to this
    identity, the user cancels/fails the biometric check, or (migration
    case) the identity has an old hardware-fingerprint-era slot with no
    corresponding bio_secret in keyring - nothing to unwrap with in that
    case, not an error, just "this factor isn't usable yet, rebind it".

    Raises fingerprint.FingerprintUnavailableError only for genuine
    system-level problems (no Windows Hello configured at all, sensor
    busy, etc.) - callers should surface that as a distinct error message.
    """
    slot = store.slots.get(SLOT_FINGERPRINT)
    if slot is None:
        return None

    if not fingerprint.request_verification():
        return None

    secret_b64 = keyring.get_password(SERVICE_NAME, KEYRING_BIO_SECRET)
    if not secret_b64:
        return None
    secret = base64.b64decode(secret_b64)

    kek = crypto.derive_key_hkdf(secret, slot.salt, INFO_FINGERPRINT)
    try:
        return crypto.unwrap_key(kek, slot.nonce, slot.wrapped_imk)
    except InvalidTag:
        return None
```

第 305-310 行的 `rewrap_recovery()` 之后（"--- Settings ---" 区块内）新增：
```python
def rewrap_fingerprint(data_dir: Path, store: IdentityStore, imk: bytes) -> None:
    """Requires an already-unlocked IMK (via a different factor) and a
    successful real Windows Hello verification to confirm the user's
    consent, then generates a brand-new bio_secret and rebinds the
    fingerprint slot - mirrors rewrap_totp()'s pattern. Raises
    fingerprint.FingerprintUnavailableError if Windows Hello isn't usable
    on this machine, or UnlockError if the user didn't complete the
    verification (cancelled/failed)."""
    if not fingerprint.request_verification():
        raise UnlockError("指纹验证未通过，重新绑定已取消")
    bio_secret = fingerprint.generate_bio_secret()
    store.slots[SLOT_FINGERPRINT] = _wrap_hkdf(imk, bio_secret, INFO_FINGERPRINT)
    save_identity_store(data_dir, store)
    keyring.set_password(SERVICE_NAME, KEYRING_BIO_SECRET, base64.b64encode(bio_secret).decode())


def fingerprint_binding_is_usable(store: IdentityStore) -> bool:
    """True only if this identity has both a fingerprint slot AND a
    matching bio_secret in keyring. False for: no fingerprint factor at
    all, or (migration case) a stale slot left over from before this
    feature existed with no corresponding keyring entry. Lets
    backend_server.py give a specific "这个绑定已失效，去重新绑定" message
    instead of sending the user through a real Windows Hello prompt only
    to find out afterward that it was never going to work."""
    if store.slots.get(SLOT_FINGERPRINT) is None:
        return False
    return bool(keyring.get_password(SERVICE_NAME, KEYRING_BIO_SECRET))
```

删除整个第 313-354 行的"App-level behavior settings"区块（`SETTINGS_FILENAME`、`AppSettings` 类、`settings_path()`、`load_app_settings()`、`save_app_settings()`）——文件到 `rewrap_fingerprint()` 结束就是末尾了。

第 1-13 行模块顶部的 docstring，把"machine fingerprint"改成准确描述：
```python
"""Identity layer: the Identity Master Key (IMK) is generated once at
setup and wrapped up to five independent ways (password / TOTP / email /
Windows Hello fingerprint [optional] / recovery key). Any ONE factor
successfully unwraps IMK - this is the user's explicit choice (convenience
over requiring all factors together). IMK is then used per-file to wrap
each file's own random File Key (see container.py) so file throughput
never depends on the slow/gated factor checks below.

Wrapped slots live in data_dir/identity_store.json (gitignored - holds
sensitive wrapped-key material). The TOTP seed, email secret, and
fingerprint bio secret are the actual stable secrets behind those gated
factors and are kept in the OS credential store via `keyring`, never in
the JSON file.
"""
```

- [ ] **Step 4: 追加新测试到 `test_identity.py`**（在文件末尾，`test_rewrap_recovery_returns_new_key_and_invalidates_old` 之后）

```python
def test_unlock_via_fingerprint_success_when_verification_succeeds(store, monkeypatch):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: True)
    imk = identity.try_unlock_via_fingerprint(store)
    assert imk is not None
    assert len(imk) == 32


def test_unlock_via_fingerprint_returns_none_when_verification_fails(store, monkeypatch):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: False)
    assert identity.try_unlock_via_fingerprint(store) is None


def test_unlock_via_fingerprint_returns_none_when_no_slot_bound(tmp_path, fake_keyring):
    store_without_fp = identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=TOTP_SEED,
        email_address=EMAIL,
        recovery_key=RECOVERY_KEY,
        enable_fingerprint=False,
    )
    assert identity.try_unlock_via_fingerprint(store_without_fp) is None


def test_unlock_via_fingerprint_returns_none_for_legacy_slot_without_bio_secret(store, monkeypatch, fake_keyring):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: True)
    # Simulate the migration scenario: a fingerprint slot exists on disk
    # (from before this feature shipped) but its keyring bio_secret was
    # never written under the new scheme.
    fake_keyring.pop((identity.SERVICE_NAME, identity.KEYRING_BIO_SECRET), None)
    assert identity.try_unlock_via_fingerprint(store) is None


def test_fingerprint_binding_is_usable_true_when_slot_and_secret_both_present(store):
    assert identity.fingerprint_binding_is_usable(store) is True


def test_fingerprint_binding_is_usable_false_when_no_slot_bound(tmp_path, fake_keyring):
    store_without_fp = identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=TOTP_SEED,
        email_address=EMAIL,
        recovery_key=RECOVERY_KEY,
        enable_fingerprint=False,
    )
    assert identity.fingerprint_binding_is_usable(store_without_fp) is False


def test_fingerprint_binding_is_usable_false_for_legacy_slot_without_bio_secret(store, fake_keyring):
    fake_keyring.pop((identity.SERVICE_NAME, identity.KEYRING_BIO_SECRET), None)
    assert identity.fingerprint_binding_is_usable(store) is False


def test_rewrap_fingerprint_generates_new_secret_but_still_unlocks(tmp_path, store, monkeypatch):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: True)
    imk_before = identity.unlock_via_password(store, PASSWORD)

    identity.rewrap_fingerprint(tmp_path, store, imk_before)

    imk_after = identity.try_unlock_via_fingerprint(store)
    assert imk_after == imk_before


def test_rewrap_fingerprint_raises_unlock_error_when_verification_fails(tmp_path, store, monkeypatch):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: False)
    imk = identity.unlock_via_password(store, PASSWORD)
    with pytest.raises(identity.UnlockError):
        identity.rewrap_fingerprint(tmp_path, store, imk)
```

也把 `test_unlock_via_fingerprint_returns_none_on_different_machine`（第 96-98 行）和 `test_all_five_paths_unlock_to_the_same_imk`（第 119-127 行）改掉——前者删除（`compute_fingerprint` 已经不存在，"换一台电脑"这个概念对 Windows Hello 因子不适用，等价场景已经被上面新增的 `test_unlock_via_fingerprint_returns_none_when_verification_fails` 覆盖），后者改成：

```python
def test_all_five_paths_unlock_to_the_same_imk(store, monkeypatch):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: True)
    imk_password = identity.unlock_via_password(store, PASSWORD)
    imk_recovery = identity.unlock_via_recovery_key(store, RECOVERY_KEY)
    imk_totp = identity.unlock_via_totp(store, totp_mod.current_code(TOTP_SEED))
    imk_fp = identity.try_unlock_via_fingerprint(store)
    pending = identity.start_email_unlock(store, SMTP_CONFIG, sender=lambda *a: None)
    imk_email = identity.finish_email_unlock(store, pending, pending.code)

    assert imk_password == imk_recovery == imk_totp == imk_fp == imk_email
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_identity.py -v`
Expected: PASS 全绿

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/identity.py modules/file_vault/tests/test_identity.py
git commit -m "Make SLOT_FINGERPRINT optional, add rewrap_fingerprint, drop AppSettings"
```

---

## Task 3: `backend_server.py` —— 删除旧 RPC，新增指纹相关 RPC

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Modify: `modules/file_vault/tests/test_backend_server.py`

- [ ] **Step 1: 修改测试——先删掉引用旧行为的三个用例**

在 `modules/file_vault/tests/test_backend_server.py` 里删除这三个测试函数（第 96-160 行）：
- `test_get_app_settings_defaults_to_auto_unlock_allowed`
- `test_update_app_settings_requires_unlock`
- `test_require_manual_unlock_disables_fingerprint_auto_unlock_on_next_launch`

- [ ] **Step 2: 追加新测试（写在刚删除的位置，即 `test_full_setup_and_password_unlock` 之后、`test_encrypt_decrypt_round_trip_with_progress` 之前）**

```python
def test_setup_check_fingerprint_available_returns_a_bool(client):
    result, _, error = client.call("setup_check_fingerprint_available", {})
    assert error is None
    assert isinstance(result["available"], bool)


def test_unlock_fingerprint_reports_not_bound_when_no_fingerprint_slot(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    # setup_complete above didn't pass enable_fingerprint, so this identity
    # has no fingerprint slot - unlock_fingerprint must report that without
    # ever touching the real Windows Hello API.
    result, _, error = client.call("unlock_fingerprint", {})
    assert error is None
    assert result == {"ok": False, "error": "此身份未绑定指纹解锁"}


def test_rebind_fingerprint_requires_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("rebind_fingerprint", {})
    assert result is None
    assert error == "尚未解锁"
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k "fingerprint"`
Expected: FAIL —— `"Unknown method: setup_check_fingerprint_available"` 等

- [ ] **Step 4: 修改 `backend_server.py`**

第 29 行的 import，加上 `fingerprint`：
```python
from modules.file_vault import container, email_otp, fingerprint, identity, passwords  # noqa: E402
```

删除第 103-124 行的三个函数：`rpc_unlock_auto`、`rpc_get_app_settings`、`rpc_update_app_settings`。

第 88-100 行的 `rpc_setup_complete` 改成：
```python
def rpc_setup_complete(params):
    global _store
    _store = identity.setup_identity(
        data_dir=_data_dir,
        password=params["password"],
        totp_seed=params["totp_seed"],
        email_address=params.get("email_address"),
        recovery_key=params["recovery_key"],
        enable_fingerprint=params.get("enable_fingerprint", False),
    )
    smtp_params = params.get("smtp_config")
    if smtp_params:
        identity.save_smtp_config(email_otp.SmtpConfig(**smtp_params))
    return {"ok": True}
```

在原来 `rpc_setup_generate_recovery_key`（第 84-85 行）之后新增：
```python
def rpc_setup_check_fingerprint_available(params):
    return {"available": fingerprint.is_available()}


def rpc_setup_verify_fingerprint(params):
    """Local check during the setup wizard, mirrors rpc_setup_verify_totp's
    'confirm it works, don't persist anything yet' semantics - the actual
    bio_secret only gets generated inside setup_identity() when
    setup_complete is called with enable_fingerprint=True."""
    try:
        return {"ok": fingerprint.request_verification()}
    except fingerprint.FingerprintUnavailableError as exc:
        return {"ok": False, "error": str(exc)}
```

在原来 `rpc_regenerate_recovery_key`（第 221-224 行）之后新增：
```python
def rpc_rebind_fingerprint(params):
    store = _require_store()
    imk = _require_imk()
    try:
        identity.rewrap_fingerprint(_data_dir, store, imk)
    except (fingerprint.FingerprintUnavailableError, identity.UnlockError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}
```

在原来 `rpc_unlock_email_finish`（第 172-181 行）之后新增：
```python
def rpc_unlock_fingerprint(params):
    global _imk
    store = _require_store()
    if store.slots.get(identity.SLOT_FINGERPRINT) is None:
        return {"ok": False, "error": "此身份未绑定指纹解锁"}
    # Checked before ever prompting: a stale slot from before this feature
    # existed (bio_secret never written to keyring) would otherwise send
    # the user through a real Windows Hello touch only to find out
    # afterward it was never going to work - catch that case up front with
    # a message that tells them what to actually do about it.
    if not identity.fingerprint_binding_is_usable(store):
        return {"ok": False, "error": "该指纹绑定已失效（可能是旧版本升级后未重新绑定），请到设置里点“重新绑定指纹解锁”"}
    try:
        imk = identity.try_unlock_via_fingerprint(store)
    except fingerprint.FingerprintUnavailableError as exc:
        return {"ok": False, "error": str(exc)}
    if imk is None:
        return {"ok": False, "error": "指纹验证未通过"}
    _imk = imk
    return {"ok": True}
```

`_METHODS` 字典（第 404-432 行）：删除 `"unlock_auto"`/`"get_app_settings"`/`"update_app_settings"` 三行，追加：
```python
    "setup_check_fingerprint_available": rpc_setup_check_fingerprint_available,
    "setup_verify_fingerprint": rpc_setup_verify_fingerprint,
    "unlock_fingerprint": rpc_unlock_fingerprint,
    "rebind_fingerprint": rpc_rebind_fingerprint,
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: PASS 全绿

- [ ] **Step 6: 跑一次全量 Python 测试套件**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault -q`
Expected: PASS，全部通过

- [ ] **Step 7: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Replace unlock_auto/app_settings RPCs with Windows Hello fingerprint RPCs"
```

---

## Task 4: 前端类型定义

**Files:**
- Modify: `modules/file_vault/ui/src/shared/ipcTypes.ts`

- [ ] **Step 1: 删除第 59-61 行**（`unlock_auto`/`get_app_settings`/`update_app_settings`）

- [ ] **Step 2: 在 `setup_generate_recovery_key`（第 48 行）之后新增**

```typescript
  setup_check_fingerprint_available: { params: Record<string, never>; result: { available: boolean } }
  setup_verify_fingerprint: { params: Record<string, never>; result: { ok: true } | { ok: false; error: string } }
```

- [ ] **Step 3: `setup_complete` 的 params（原第 49-58 行）加一个可选字段**

```typescript
  setup_complete: {
    params: {
      password: string
      totp_seed: string
      email_address: string | null
      recovery_key: string
      smtp_config?: SmtpConfigInput
      enable_fingerprint?: boolean
    }
    result: { ok: true }
  }
```

- [ ] **Step 4: 在 `unlock_email_finish`（原第 69 行）之后新增**

```typescript
  unlock_fingerprint: { params: Record<string, never>; result: { ok: true } | { ok: false; error: string } }
```

- [ ] **Step 5: 在 `regenerate_recovery_key`（原第 116 行）之后新增**

```typescript
  rebind_fingerprint: { params: Record<string, never>; result: { ok: true } | { ok: false; error: string } }
```

- [ ] **Step 6: 类型检查**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit`
Expected: 会报错——`UnlockDialog.tsx`/`MainScreen.tsx`/`SettingsScreen.tsx` 里还在用刚删掉的 `unlock_auto`/`get_app_settings`/`update_app_settings`。这些错误在 Task 6-8 里随着对应文件改动逐步消失，这一步先确认新增的类型本身没有语法错误（错误信息只指向别的文件，不是这次改的文件）。

- [ ] **Step 7: 提交**

```bash
git add modules/file_vault/ui/src/shared/ipcTypes.ts
git commit -m "Update ipcTypes for Windows Hello fingerprint RPCs"
```

---

## Task 5: 提取共用的解锁标签组件，`UnlockDialog.tsx` 加指纹标签

**Files:**
- Create: `modules/file_vault/ui/src/components/UnlockTabs.tsx`
- Modify: `modules/file_vault/ui/src/components/UnlockDialog.tsx`

`UnlockDialog.tsx`（弹窗，用于设置页强制重新验证）和 Task 6 要新建的 `LoginScreen.tsx`（整页，启动关卡）需要完全一样的五个标签内容（密码/验证器/邮箱/恢复密钥/指纹），只是外层容器不同（一个是 Dialog，一个是整页 Card）。这里没有自动化测试（和其余 React 组件一致，靠 `tsc`/`eslint` + 手动走查）。

- [ ] **Step 1: 创建 `modules/file_vault/ui/src/components/UnlockTabs.tsx`**

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { vaultApi } from '@/lib/vaultApi'

// Shared by UnlockDialog.tsx (a popup, used for Settings' forced
// re-authentication) and LoginScreen.tsx (a full page, the app's startup
// gate) - both need the exact same five factor tabs, just wrapped
// differently (Dialog vs. full-page Card).

export function PasswordTab({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function handleUnlock() {
    const res = await vaultApi.call('unlock_password', { password })
    if (res.ok) onUnlocked()
    else setError(res.error ?? '解锁失败')
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-2">
        <Label htmlFor="unlock-password">密码</Label>
        <Input
          id="unlock-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="w-full" onClick={handleUnlock}>
        解锁
      </Button>
    </div>
  )
}

export function TotpTab({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  async function handleUnlock() {
    const res = await vaultApi.call('unlock_totp', { code })
    if (res.ok) onUnlocked()
    else setError(res.error ?? '解锁失败')
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-2">
        <Label htmlFor="unlock-totp">验证器 6 位验证码</Label>
        <Input
          id="unlock-totp"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="w-full" onClick={handleUnlock}>
        解锁
      </Button>
    </div>
  )
}

export function EmailTab({ onUnlocked }: { onUnlocked: () => void }) {
  const [status, setStatus] = useState('点击发送验证码到已注册邮箱')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  async function handleSend() {
    setSending(true)
    setStatus('正在发送...')
    const res = await vaultApi.call('unlock_email_start', {})
    setSending(false)
    if (res.ok) {
      setSent(true)
      setStatus(`验证码已发送到 ${res.email_address}，10 分钟内有效`)
    } else {
      setStatus(res.error ?? '发送失败')
    }
  }

  async function handleUnlock() {
    if (!sent) {
      setError('请先点击发送验证码')
      return
    }
    const res = await vaultApi.call('unlock_email_finish', { code })
    if (res.ok) onUnlocked()
    else setError(res.error ?? '解锁失败')
  }

  return (
    <div className="space-y-3 pt-2">
      <p className="text-sm text-muted-foreground">{status}</p>
      <Button variant="secondary" className="w-full" onClick={handleSend} disabled={sending}>
        发送验证码
      </Button>
      <div className="space-y-2">
        <Label htmlFor="unlock-email-code">收到的验证码</Label>
        <Input
          id="unlock-email-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="w-full" onClick={handleUnlock}>
        解锁
      </Button>
    </div>
  )
}

export function RecoveryTab({ onUnlocked }: { onUnlocked: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  async function handleUnlock() {
    const res = await vaultApi.call('unlock_recovery', { recovery_key: key })
    if (res.ok) onUnlocked()
    else setError(res.error ?? '解锁失败')
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-2">
        <Label htmlFor="unlock-recovery">恢复密钥</Label>
        <Input
          id="unlock-recovery"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="w-full" onClick={handleUnlock}>
        解锁
      </Button>
    </div>
  )
}

export function FingerprintTab({ onUnlocked }: { onUnlocked: () => void }) {
  const [status, setStatus] = useState('点击开始，随后请按提示触摸指纹传感器')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')

  async function handleVerify() {
    setVerifying(true)
    setStatus('等待验证...')
    setError('')
    const res = await vaultApi.call('unlock_fingerprint', {})
    setVerifying(false)
    if (res.ok) {
      onUnlocked()
    } else {
      setStatus('点击开始，随后请按提示触摸指纹传感器')
      setError(res.error ?? '解锁失败')
    }
  }

  return (
    <div className="space-y-3 pt-2">
      <p className="text-sm text-muted-foreground">{status}</p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="w-full" onClick={handleVerify} disabled={verifying}>
        使用指纹解锁
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: 重写 `UnlockDialog.tsx`，改用共用标签 + 加指纹**

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmailTab, FingerprintTab, PasswordTab, RecoveryTab, TotpTab } from '@/components/UnlockTabs'

// The unwrapped IMK never leaves the Python backend process - it stays
// server-side in backend_server.py's module state. This dialog only needs
// to report "unlock succeeded", not carry any key material itself.
export function UnlockDialog({
  open,
  onOpenChange,
  onUnlocked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUnlocked: () => void
}) {
  function handleUnlocked() {
    // Order matters: fire onUnlocked() first so a caller distinguishing
    // "closed because unlocked" from "closed because cancelled" (e.g. a
    // pending-promise resolver keyed off onOpenChange) sees success before
    // the close event arrives.
    onUnlocked()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>解锁</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="password">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="password">密码</TabsTrigger>
            <TabsTrigger value="totp">验证器</TabsTrigger>
            <TabsTrigger value="email">邮箱</TabsTrigger>
            <TabsTrigger value="recovery">恢复密钥</TabsTrigger>
            <TabsTrigger value="fingerprint">指纹</TabsTrigger>
          </TabsList>
          <TabsContent value="password">
            <PasswordTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="totp">
            <TotpTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="email">
            <EmailTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="recovery">
            <RecoveryTab onUnlocked={handleUnlocked} />
          </TabsContent>
          <TabsContent value="fingerprint">
            <FingerprintTab onUnlocked={handleUnlocked} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: 这一步 `tsc` 应该不再报 `UnlockDialog.tsx` 相关的错误了（`MainScreen.tsx`/`SettingsScreen.tsx` 仍有残留错误，属于 Task 7-8 的范围，先不管）

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/components/UnlockTabs.tsx modules/file_vault/ui/src/components/UnlockDialog.tsx
git commit -m "Extract shared unlock tab components, add fingerprint tab to UnlockDialog"
```

---

## Task 6: 新增 `LoginScreen.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/components/LoginScreen.tsx`

- [ ] **Step 1: 创建文件**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmailTab, FingerprintTab, PasswordTab, RecoveryTab, TotpTab } from '@/components/UnlockTabs'

export function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <Card className="w-[420px]">
        <CardHeader>
          <CardTitle>登录 - Ideal1 File Vault</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="password">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="password">密码</TabsTrigger>
              <TabsTrigger value="totp">验证器</TabsTrigger>
              <TabsTrigger value="email">邮箱</TabsTrigger>
              <TabsTrigger value="recovery">恢复密钥</TabsTrigger>
              <TabsTrigger value="fingerprint">指纹</TabsTrigger>
            </TabsList>
            <TabsContent value="password">
              <PasswordTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="totp">
              <TotpTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="email">
              <EmailTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="recovery">
              <RecoveryTab onUnlocked={onUnlocked} />
            </TabsContent>
            <TabsContent value="fingerprint">
              <FingerprintTab onUnlocked={onUnlocked} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: `LoginScreen.tsx` 本身不再报错（`App.tsx` 还没接入它，其余残留错误属于后续任务）

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/components/LoginScreen.tsx
git commit -m "Add LoginScreen: full-page startup unlock gate"
```

---

## Task 7: `App.tsx` 接入登录页 + `MainScreen.tsx` 精简

**Files:**
- Modify: `modules/file_vault/ui/src/App.tsx`
- Modify: `modules/file_vault/ui/src/components/MainScreen.tsx`

- [ ] **Step 1: 修改 `App.tsx`**

第 6 行 `import { PasswordScreen } from '@/components/PasswordScreen'` 之后新增：
```typescript
import { LoginScreen } from '@/components/LoginScreen'
```

第 9 行：
```typescript
type View = 'loading' | 'setup' | 'main' | 'settings' | 'passwords'
```
改成：
```typescript
type View = 'loading' | 'setup' | 'login' | 'main' | 'settings' | 'passwords'
```

第 15 行 `vaultApi.call('identity_exists', {}).then((res) => setView(res.exists ? 'main' : 'setup'))` 改成：
```typescript
vaultApi.call('identity_exists', {}).then((res) => setView(res.exists ? 'login' : 'setup'))
```

第 21 行 `{view === 'setup' && <SetupWizard onComplete={() => setView('main')} />}` 之后新增：
```tsx
{view === 'login' && <LoginScreen onUnlocked={() => setView('main')} />}
```

- [ ] **Step 2: 修改 `MainScreen.tsx`**

删除第 62-72 行的 `ensureUnlocked()` 函数整个（不再需要——`App.tsx` 现在保证只有已经通过 `LoginScreen` 才能到达 `MainScreen`）。`ensureFreshlyUnlocked()`（第 74-84 行）保持不变。

第 153-184 行 `handleEncrypt()` 里，删除这一行：
```typescript
    if (!(await ensureUnlocked())) return
```
（在 `if (!inputPaths || inputPaths.length === 0) return` 之后）

第 186-248 行 `handleDecrypt()` 里，删除这一行：
```typescript
    if (!(await ensureUnlocked())) return
```
（在 `if (validPaths.length === 0) { ... return }` 块之后）

第 255-258 行的 `handlePasswords()` 改成：
```typescript
  function handlePasswords() {
    onOpenPasswords()
  }
```
（不再是 `async`，因为不再需要 `await ensureUnlocked()`）

- [ ] **Step 3: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: `App.tsx`/`MainScreen.tsx` 不再报错（`SettingsScreen.tsx` 仍有残留错误，属于 Task 8）

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/App.tsx modules/file_vault/ui/src/components/MainScreen.tsx
git commit -m "Wire LoginScreen as the startup gate, simplify MainScreen's per-action unlock checks"
```

---

## Task 8: `SetupWizard.tsx` —— 新增指纹绑定步骤

**Files:**
- Modify: `modules/file_vault/ui/src/components/SetupWizard.tsx`

- [ ] **Step 1: 修改 `Step` 类型（第 11 行）和 `STEP_LABELS`（第 13-18 行）**

```typescript
type Step = 'password' | 'totp' | 'fingerprint' | 'email' | 'recovery'

const STEP_ORDER: Step[] = ['password', 'totp', 'fingerprint', 'email', 'recovery']

const STEP_TITLES: Record<Step, string> = {
  password: '设置密码',
  totp: '绑定验证器 App',
  fingerprint: '绑定指纹解锁',
  email: '邮箱与发信配置',
  recovery: '离线恢复密钥',
}

// The fingerprint step doesn't count toward the total when this machine
// has no usable Windows Hello - the wizard skips it entirely rather than
// showing a step the user can't complete or a "skip" button for something
// that was never actually an option.
function stepLabel(step: Step, fingerprintAvailable: boolean): string {
  const activeSteps = fingerprintAvailable ? STEP_ORDER : STEP_ORDER.filter((s) => s !== 'fingerprint')
  const index = activeSteps.indexOf(step) + 1
  return `第 ${index} 步 / ${activeSteps.length}：${STEP_TITLES[step]}`
}
```

- [ ] **Step 2: `WizardState` 接口（第 20-25 行）加一个字段**

```typescript
interface WizardState {
  password: string
  totpSeed: string
  emailAddress: string | null
  smtpConfig: SmtpConfigInput | null
  enableFingerprint: boolean
}
```

- [ ] **Step 3: 修改 `SetupWizard` 主体（第 27-90 行）**

```tsx
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('password')
  const [fingerprintAvailable, setFingerprintAvailable] = useState(false)
  const [state, setState] = useState<WizardState>({
    password: '',
    totpSeed: '',
    emailAddress: null,
    smtpConfig: null,
    enableFingerprint: false,
  })

  useEffect(() => {
    vaultApi.call('setup_check_fingerprint_available', {}).then((res) => setFingerprintAvailable(res.available))
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <Card className="w-[420px]">
        <CardHeader>
          <CardTitle>首次设置 - Ideal1 File Vault</CardTitle>
          <CardDescription>{stepLabel(step, fingerprintAvailable)}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'password' && (
            <PasswordStep
              onNext={(password) => {
                setState((s) => ({ ...s, password }))
                setStep('totp')
              }}
            />
          )}
          {step === 'totp' && (
            <TotpStep
              onNext={(totpSeed) => {
                setState((s) => ({ ...s, totpSeed }))
                setStep(fingerprintAvailable ? 'fingerprint' : 'email')
              }}
            />
          )}
          {step === 'fingerprint' && (
            <FingerprintStep
              onNext={() => {
                setState((s) => ({ ...s, enableFingerprint: true }))
                setStep('email')
              }}
            />
          )}
          {step === 'email' && (
            <EmailStep
              onNext={(emailAddress, smtpConfig) => {
                setState((s) => ({ ...s, emailAddress, smtpConfig }))
                setStep('recovery')
              }}
              onSkip={() => {
                setState((s) => ({ ...s, emailAddress: null, smtpConfig: null }))
                setStep('recovery')
              }}
            />
          )}
          {step === 'recovery' && (
            <RecoveryStep
              onFinish={async (recoveryKey) => {
                await vaultApi.call('setup_complete', {
                  password: state.password,
                  totp_seed: state.totpSeed,
                  email_address: state.emailAddress,
                  recovery_key: recoveryKey,
                  smtp_config: state.smtpConfig ?? undefined,
                  enable_fingerprint: state.enableFingerprint,
                })
                onComplete()
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: 在 `TotpStep` 组件（原第 137-191 行）之后新增 `FingerprintStep`**

```tsx
function FingerprintStep({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState('点击开始绑定，随后请按提示触摸指纹传感器完成一次验证')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')

  async function handleVerify() {
    setVerifying(true)
    setStatus('等待验证...')
    setError('')
    const res = await vaultApi.call('setup_verify_fingerprint', {})
    setVerifying(false)
    if (res.ok) {
      onNext()
    } else {
      setStatus('点击开始绑定，随后请按提示触摸指纹传感器完成一次验证')
      setError(res.error ?? '验证失败')
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{status}</p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button className="w-full" onClick={handleVerify} disabled={verifying}>
        开始指纹验证
      </Button>
    </div>
  )
}
```

- [ ] **Step 5: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: `SetupWizard.tsx` 不再报错

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/ui/src/components/SetupWizard.tsx
git commit -m "Add fingerprint binding step to SetupWizard, auto-skip when Windows Hello unavailable"
```

---

## Task 9: `SettingsScreen.tsx` —— 删除旧开关，新增重新绑定指纹按钮

**Files:**
- Modify: `modules/file_vault/ui/src/components/SettingsScreen.tsx`

- [ ] **Step 1: 修改 `SettingsScreen` 主体**

删除第 19-33 行的 `requireManualUnlock`/`loadedSettings` 状态、`useEffect`、`handleToggleRequireManualUnlock` 函数。

删除第 54-65 行的整个 Checkbox JSX 块（"每次打开都要求手动验证"）。

在"重新生成恢复密钥"按钮（原第 51-53 行）之后新增：
```tsx
          <Button className="w-full" onClick={handleRebindFingerprint}>
            重新绑定指纹解锁
          </Button>
```

在 `SettingsScreen` 函数体内、`return` 之前新增：
```typescript
  async function handleRebindFingerprint() {
    const res = await vaultApi.call('rebind_fingerprint', {})
    if (!res.ok) {
      toast.error('重新绑定失败', { description: res.error })
      return
    }
    toast.success('指纹解锁已重新绑定')
  }
```

改动后 `SettingsScreen` 函数应该长这样（去掉了旧开关相关的一切，加了新按钮+新函数）：
```tsx
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null)

  async function handleRebindFingerprint() {
    const res = await vaultApi.call('rebind_fingerprint', {})
    if (!res.ok) {
      toast.error('重新绑定失败', { description: res.error })
      return
    }
    toast.success('指纹解锁已重新绑定')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <Card className="w-96">
        <CardHeader>
          <CardTitle>设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="w-full" onClick={() => setActiveDialog('password')}>
            修改密码
          </Button>
          <Button className="w-full" onClick={() => setActiveDialog('totp')}>
            重新绑定验证器
          </Button>
          <Button className="w-full" onClick={() => setActiveDialog('email')}>
            修改邮箱与发信配置
          </Button>
          <Button className="w-full" onClick={() => setActiveDialog('recovery')}>
            重新生成恢复密钥
          </Button>
          <Button className="w-full" onClick={handleRebindFingerprint}>
            重新绑定指纹解锁
          </Button>
          <Button className="w-full" variant="outline" onClick={onBack}>
            返回
          </Button>
        </CardContent>
      </Card>

      <ChangePasswordDialog open={activeDialog === 'password'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <RebindTotpDialog open={activeDialog === 'totp'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <UpdateEmailDialog open={activeDialog === 'email'} onOpenChange={(o) => !o && setActiveDialog(null)} />
      <RegenRecoveryDialog open={activeDialog === 'recovery'} onOpenChange={(o) => !o && setActiveDialog(null)} />
    </div>
  )
}
```

其余的 `ChangePasswordDialog`/`RebindTotpDialog`/`UpdateEmailDialog`/`RegenRecoveryDialog`/`Checkbox` import 都不变（`Checkbox` 组件还在被 `UpdateEmailDialog` 里的 SSL 勾选框用，不要连 import 一起删）。

- [ ] **Step 2: 类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: 两条命令都无输出（成功，全部前端文件都不再报错）

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/components/SettingsScreen.tsx
git commit -m "Remove require-manual-unlock toggle, add rebind-fingerprint button to Settings"
```

---

## Task 10: 更新文档

**Files:**
- Modify: `modules/file_vault/README.md`

- [ ] **Step 1: 更新顶部的解锁方式列表（第 3-9 行）**

```markdown
多因素文件加密模块，带 Electron + React + TypeScript（shadcn/ui）图形界面。启动后先进登录页，任意一种方式验证通过才能进入主界面：

- 密码
- 邮箱验证码（需要先在设置里配置好发信邮箱）
- 验证器 App 动态码（Google/Microsoft Authenticator、Authy 等，标准 TOTP）
- **真实指纹**（通过 Windows Hello 调用本机指纹传感器，需要你实际按手指验证；这台电脑没有配置 Windows Hello 时这条路径不可用，设置向导会自动跳过绑定步骤）
- 一次性离线恢复密钥（首次设置时显示一次，请自行妥善保管）
```

- [ ] **Step 2: 第 28 行更新设置向导的步骤描述**

```markdown
首次运行会自动弹出设置向导（设密码 → 绑定验证器 → [这台电脑支持 Windows Hello 才会有这步] 绑定指纹解锁 → 配置邮箱[可跳过] → 生成并确认保存恢复密钥）。之后每次运行先进登录页，验证通过后进入主界面，选文件、点"加密"或"解密"即可。
```

- [ ] **Step 3: 在"打包成单个 exe"小节（第 46 行）之前新增依赖说明**

```markdown
### 依赖：Windows Hello 指纹

指纹解锁依赖 `winrt` 包调用 Windows 自己的 Hello API，第一次用之前装一下：

```bash
pip install winrt-Windows.Security.Credentials.UI winrt-Windows.Foundation
```

没有指纹传感器/没配置 Windows Hello 的电脑，这两个包装了也没用——设置向导会自动检测并跳过绑定步骤，不影响其余四种解锁方式。
```

- [ ] **Step 4: 更新"重要提醒"小节（第 57-62 行）**

把第 59 行的"换了电脑（机器指纹变化）"改成更准确的描述：

```markdown
- **恢复密钥只会显示一次**，设置向导里务必抄写或保存到安全的地方（不要和加密文件放在一起）。如果同时丢失手机（验证器）、这台电脑坏了或重装系统（指纹解锁失效）又忘记密码，恢复密钥是唯一能找回文件的办法——如果连恢复密钥也丢了，文件将无法恢复，这是设计使然，不是 bug。
```

- [ ] **Step 5: 更新"手动验证清单"（第 70-78 行），第 2 条改成指纹相关，其余顺延**

```markdown
## 手动验证清单

以下几项无法自动化测试，需要你实际运行一遍确认：

1. `npm install` 之后 `python scripts/run.py run file_vault` 能正常打开窗口，走一遍设置向导、登录页、加密解密一个文件、改设置，确认所有界面都正常。
2. 设置向导里真的按一下指纹传感器完成绑定；重新打开软件，在登录页点"指纹"标签，真的能用指纹解锁。
3. 用手机上真实的验证器 App 扫描设置向导里的二维码，确认扫码绑定、App 显示的验证码真的能通过验证。
4. 在设置向导或"设置"页里填入真实的 SMTP 账号和应用专用密码，点"发送测试邮件"，确认真的能收到邮件。
5. 点"密码管理"进入，走一遍新增/编辑/删除/搜索/显示隐藏密码/复制到剪贴板，确认都正常。
6. 用真实浏览器（Chrome 或 Edge）导出一份密码 CSV，在"密码管理"里导入，确认条目正确、原 CSV 被安全删除；再导出一份 CSV，确认能被浏览器的"导入密码"功能正常读取。
7. 在设置页点"重新绑定指纹解锁"，真的按一下指纹传感器，确认绑定成功；如果之前是旧版本升级上来的身份（指纹槽位是老的机器硬件指纹），确认这一步之后指纹解锁真的能用了。
```

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/README.md
git commit -m "Document Windows Hello fingerprint unlock and the login screen"
```

---

## Task 11: 全量验证

**Files:** 无新增/修改，只运行验证命令。

- [ ] **Step 1: 全量 Python 测试**

Run: `cd "<repo>" && python -X utf8 -m pytest modules/file_vault -q`
Expected: PASS，全部通过

- [ ] **Step 2: 前端类型检查 + lint**

Run: `cd "<repo>\modules\file_vault\ui" && npx tsc --noEmit && npx eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`
Expected: 两条命令都无输出（成功）

- [ ] **Step 3: 手动走查（记录在 README"手动验证清单"里，不是自动化步骤）**

按 Task 10 更新后的清单逐条走一遍，重点是第 1、2、7 条——这三条是这次改动新增/受影响最大的部分：登录页本身、真实指纹绑定与解锁、旧身份的指纹重新绑定。

- [ ] **Step 4: 如果这次改动要打包进现有的 exe（`modules/file_vault/ui/release/`），跑完整构建**

Run: `cd "<repo>\modules\file_vault\ui" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run build`
Expected: `tsc && vite build && electron-builder` 三步都成功，产物在 `release/<version>/Ideal1 File Vault-Windows-<version>.exe`。**注意**：`electron-builder` 打包时如果遇到"output file is locked for writing (maybe by virus scanner) => waiting for unlock..."，这是本机杀毒软件扫描锁导致的已知情况，耐心等（之前遇到过最长约 21 分钟），不是构建失败。

**重要**：这次改动涉及 Python 依赖变化（新增 `winrt` 两个包），`extraResources` 打包进 exe 的是 Python **源码**而不是完整环境（参考 README 里"这个 exe 仍然依赖本机的 Python"的说明），所以运行打包出来的 exe 的电脑上也必须提前 `pip install winrt-Windows.Security.Credentials.UI winrt-Windows.Foundation`，否则指纹这条解锁路径会报错（其余四条路径不受影响）。
