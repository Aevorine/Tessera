import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import keyring as real_keyring

from modules.file_vault import email_otp, fingerprint, identity, totp as totp_mod

PASSWORD = "correct horse battery staple"
TOTP_SEED = totp_mod.generate_seed()
EMAIL = "user@example.com"
RECOVERY_KEY = identity.generate_recovery_key()
SMTP_CONFIG = email_otp.SmtpConfig(host="smtp.example.com", port=587, username="me@example.com", password="app-pw")


@pytest.fixture
def fake_keyring(monkeypatch):
    """In-memory keyring so tests never touch the real OS credential store."""
    store = {}

    def fake_set(service, key, value):
        store[(service, key)] = value

    def fake_get(service, key):
        return store.get((service, key))

    def fake_delete(service, key):
        try:
            del store[(service, key)]
        except KeyError:
            raise real_keyring.errors.PasswordDeleteError()

    monkeypatch.setattr(real_keyring, "set_password", fake_set)
    monkeypatch.setattr(real_keyring, "get_password", fake_get)
    monkeypatch.setattr(real_keyring, "delete_password", fake_delete)
    return store


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


def test_setup_identity_creates_all_five_slots(tmp_path, store):
    assert set(store.slots.keys()) == set(identity.ALL_SLOTS)
    assert identity.identity_exists(tmp_path)


def test_setup_identity_persists_and_reloads(tmp_path, store):
    reloaded = identity.load_identity_store(tmp_path)
    assert reloaded.email_address == EMAIL
    assert set(reloaded.slots.keys()) == set(identity.ALL_SLOTS)


def test_save_identity_store_failed_write_preserves_existing_file(monkeypatch, tmp_path, store):
    store_path = tmp_path / identity.IDENTITY_FILENAME
    before = store_path.read_text(encoding="utf-8")

    def partial_dump(_obj, fp, **_kwargs):
        fp.write("{")
        raise OSError("disk full")

    monkeypatch.setattr(identity.json, "dump", partial_dump)

    with pytest.raises(OSError, match="disk full"):
        identity.save_identity_store(tmp_path, store)

    assert store_path.read_text(encoding="utf-8") == before
    assert identity.load_identity_store(tmp_path).email_address == EMAIL


def test_unlock_via_password_success(store):
    imk = identity.unlock_via_password(store, PASSWORD)
    assert len(imk) == 32


def test_unlock_via_password_wrong_fails(store):
    with pytest.raises(identity.UnlockError):
        identity.unlock_via_password(store, "wrong password")


def test_unlock_via_recovery_key_success(store):
    imk = identity.unlock_via_recovery_key(store, RECOVERY_KEY)
    assert len(imk) == 32


def test_unlock_via_recovery_key_wrong_fails(store):
    with pytest.raises(identity.UnlockError):
        identity.unlock_via_recovery_key(store, "AAAA-BBBB-CCCC-CCCC-CCCC-CCCC-CCCC-CCCC")


def test_unlock_via_totp_success(store):
    code = totp_mod.current_code(TOTP_SEED)
    imk = identity.unlock_via_totp(store, code)
    assert len(imk) == 32


def test_unlock_via_totp_wrong_code_fails(store):
    with pytest.raises(identity.UnlockError):
        identity.unlock_via_totp(store, "000000")


def test_email_unlock_full_round_trip(store):
    sent = []

    def fake_sender(config, to_addr, subject, body):
        sent.append((to_addr, body))

    pending = identity.start_email_unlock(store, SMTP_CONFIG, sender=fake_sender)
    assert sent[0][0] == EMAIL
    imk = identity.finish_email_unlock(store, pending, pending.code)
    assert len(imk) == 32


def test_email_unlock_wrong_code_fails(store):
    pending = identity.start_email_unlock(store, SMTP_CONFIG, sender=lambda *a: None)
    with pytest.raises(identity.UnlockError):
        identity.finish_email_unlock(store, pending, "000000")


def test_all_five_paths_unlock_to_the_same_imk(store, monkeypatch):
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: True)
    imk_password = identity.unlock_via_password(store, PASSWORD)
    imk_recovery = identity.unlock_via_recovery_key(store, RECOVERY_KEY)
    imk_totp = identity.unlock_via_totp(store, totp_mod.current_code(TOTP_SEED))
    imk_fp = identity.try_unlock_via_fingerprint(store)
    pending = identity.start_email_unlock(store, SMTP_CONFIG, sender=lambda *a: None)
    imk_email = identity.finish_email_unlock(store, pending, pending.code)

    assert imk_password == imk_recovery == imk_totp == imk_fp == imk_email


def test_rewrap_password_replaces_only_that_slot(tmp_path, store):
    imk_before = identity.unlock_via_password(store, PASSWORD)
    identity.rewrap_password(tmp_path, store, imk_before, "a brand new password")

    with pytest.raises(identity.UnlockError):
        identity.unlock_via_password(store, PASSWORD)

    imk_after = identity.unlock_via_password(store, "a brand new password")
    imk_via_recovery = identity.unlock_via_recovery_key(store, RECOVERY_KEY)
    assert imk_after == imk_before == imk_via_recovery


def test_rewrap_recovery_returns_new_key_and_invalidates_old(tmp_path, store):
    imk_before = identity.unlock_via_password(store, PASSWORD)
    new_recovery_key = identity.rewrap_recovery(tmp_path, store, imk_before)
    assert new_recovery_key != RECOVERY_KEY

    with pytest.raises(identity.UnlockError):
        identity.unlock_via_recovery_key(store, RECOVERY_KEY)

    imk_after = identity.unlock_via_recovery_key(store, new_recovery_key)
    assert imk_after == imk_before


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
    # 模拟迁移场景：磁盘上已有指纹槽位（该功能上线前写的），但 keyring 里没有新方案的 bio_secret。
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


def test_rewrap_fingerprint_rolls_back_keyring_when_disk_write_fails(tmp_path, store, monkeypatch, fake_keyring):
    # 回归：rewrap_fingerprint/_totp/_email 曾先写磁盘槽位再写 keyring 密钥，中途中断（崩溃、磁盘满、
    # 权限错误）会留下无对应槽位的新密钥，该解锁因子永久损坏。现改为先写 keyring，磁盘写失败则回滚，
    # 两边回到原来一致的状态。
    monkeypatch.setattr(fingerprint, "request_verification", lambda *a, **k: True)
    old_bio_secret = fake_keyring[(identity.SERVICE_NAME, identity.KEYRING_BIO_SECRET)]
    imk_before = identity.unlock_via_password(store, PASSWORD)

    def boom(data_dir, store):
        raise OSError("disk full")

    monkeypatch.setattr(identity, "save_identity_store", boom)
    with pytest.raises(OSError):
        identity.rewrap_fingerprint(tmp_path, store, imk_before)

    assert fake_keyring[(identity.SERVICE_NAME, identity.KEYRING_BIO_SECRET)] == old_bio_secret
    imk_after = identity.try_unlock_via_fingerprint(store)
    assert imk_after == imk_before


def test_rewrap_totp_generates_new_seed_but_still_unlocks(tmp_path, store):
    new_seed = totp_mod.generate_seed()
    imk_before = identity.unlock_via_password(store, PASSWORD)

    identity.rewrap_totp(tmp_path, store, imk_before, new_seed)

    imk_after = identity.unlock_via_totp(store, totp_mod.current_code(new_seed))
    assert imk_after == imk_before


def test_rewrap_totp_rolls_back_keyring_when_disk_write_fails(tmp_path, store, monkeypatch, fake_keyring):
    new_seed = totp_mod.generate_seed()
    imk_before = identity.unlock_via_password(store, PASSWORD)

    def boom(data_dir, store):
        raise OSError("disk full")

    monkeypatch.setattr(identity, "save_identity_store", boom)
    with pytest.raises(OSError):
        identity.rewrap_totp(tmp_path, store, imk_before, new_seed)

    assert fake_keyring[(identity.SERVICE_NAME, identity.KEYRING_TOTP_SEED)] == TOTP_SEED
    imk_after = identity.unlock_via_totp(store, totp_mod.current_code(TOTP_SEED))
    assert imk_after == imk_before


def test_rewrap_email_generates_new_secret_but_still_unlocks(tmp_path, store):
    imk_before = identity.unlock_via_password(store, PASSWORD)

    identity.rewrap_email(tmp_path, store, imk_before, "new-address@example.com")

    assert store.email_address == "new-address@example.com"
    pending = identity.start_email_unlock(store, SMTP_CONFIG, sender=lambda *a: None)
    imk_after = identity.finish_email_unlock(store, pending, pending.code)
    assert imk_after == imk_before


def test_rewrap_email_rolls_back_keyring_when_disk_write_fails(tmp_path, store, monkeypatch, fake_keyring):
    old_email_secret = fake_keyring[(identity.SERVICE_NAME, identity.KEYRING_EMAIL_SECRET)]
    imk_before = identity.unlock_via_password(store, PASSWORD)

    def boom(data_dir, store):
        raise OSError("disk full")

    monkeypatch.setattr(identity, "save_identity_store", boom)
    with pytest.raises(OSError):
        identity.rewrap_email(tmp_path, store, imk_before, "new-address@example.com")

    assert fake_keyring[(identity.SERVICE_NAME, identity.KEYRING_EMAIL_SECRET)] == old_email_secret
    assert store.email_address == EMAIL  # not switched to the new address
    pending = identity.start_email_unlock(store, SMTP_CONFIG, sender=lambda *a: None)
    imk_after = identity.finish_email_unlock(store, pending, pending.code)
    assert imk_after == imk_before


# --- Brute-force lockout (check_not_locked_out / record_failed_unlock_attempt) ---


def test_check_not_locked_out_passes_with_fresh_store(store):
    identity.check_not_locked_out(store)  # must not raise


def test_no_lockout_within_free_attempts_budget(tmp_path, store):
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS):
        identity.record_failed_unlock_attempt(tmp_path, store)
    identity.check_not_locked_out(store)  # still must not raise


def test_lockout_triggers_after_exceeding_free_attempts(tmp_path, store):
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS + 1):
        identity.record_failed_unlock_attempt(tmp_path, store)
    with pytest.raises(identity.LockedOutError) as exc_info:
        identity.check_not_locked_out(store)
    assert exc_info.value.params["seconds_remaining"] > 0


def test_lockout_seconds_escalate_and_cap_at_max(tmp_path, store):
    # 每多失败一次，锁定时间翻倍，直到封顶 - 不能无限增长。
    seen = []
    for _ in range(15):
        identity.record_failed_unlock_attempt(tmp_path, store)
        seen.append(store.locked_until - time.time())
    assert seen[-1] <= identity.MAX_LOCKOUT_SECONDS + 1
    assert seen[-1] == pytest.approx(identity.MAX_LOCKOUT_SECONDS, abs=1)


def test_successful_unlock_resets_failed_attempts(tmp_path, store):
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS + 1):
        identity.record_failed_unlock_attempt(tmp_path, store)
    identity.record_successful_unlock(tmp_path, store)
    assert store.failed_attempts == 0
    assert store.locked_until == 0.0
    identity.check_not_locked_out(store)  # must not raise anymore


def test_lockout_state_persists_across_reload(tmp_path, store):
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS + 1):
        identity.record_failed_unlock_attempt(tmp_path, store)
    reloaded = identity.load_identity_store(tmp_path)
    with pytest.raises(identity.LockedOutError):
        identity.check_not_locked_out(reloaded)


def test_lockout_is_shared_across_different_factors(tmp_path, store):
    # 密码和 TOTP 是共享同一个失败计数器 - 不能靠换一个因素来绕开锁定。
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS + 1):
        identity.record_failed_unlock_attempt(tmp_path, store)
    with pytest.raises(identity.LockedOutError):
        identity.check_not_locked_out(store)
    # 换用 TOTP 因子也一样：锁定状态与因子无关，调用方应在真正尝试解锁前先检查
    # （backend_server.py 每个 rpc_unlock_* 都这样接入）。


# Scrypt 成本迁移：调高 Scrypt 成本不能把已有金库锁死；参数记在每个槽位自己身上而不读当前
# crypto.SCRYPT_N，正为此。


def _downgrade_to_legacy(tmp_path, store, slot_name, secret):
    """把一个槽位改回旧成本重新封装，模拟"升级前创建的金库"。"""
    from modules.file_vault import crypto

    imk = identity.unlock_via_password(store, PASSWORD)
    salt = crypto.random_salt()
    kek = crypto.derive_key_scrypt(secret.encode("utf-8"), salt, crypto.SCRYPT_N_LEGACY)
    nonce, wrapped = crypto.wrap_key(kek, imk)
    store.slots[slot_name] = identity.Slot(
        salt=salt, nonce=nonce, wrapped_imk=wrapped, scrypt_n=crypto.SCRYPT_N_LEGACY
    )
    identity.save_identity_store(tmp_path, store)
    return imk


def test_slot_without_scrypt_n_is_read_as_legacy(store):
    """升级前写的 identity.json 没有 scrypt_n 字段，读到时必须当旧成本；当新成本会让这些金库永远
    打不开，且报的还是"密码错误"。"""
    from modules.file_vault import crypto

    raw = store.slots[identity.SLOT_PASSWORD].to_json()
    del raw["scrypt_n"]
    assert identity.Slot.from_json(raw).scrypt_n == crypto.SCRYPT_N_LEGACY


def test_new_slots_record_the_current_cost(store):
    from modules.file_vault import crypto

    assert store.slots[identity.SLOT_PASSWORD].scrypt_n == crypto.SCRYPT_N
    assert store.slots[identity.SLOT_RECOVERY].scrypt_n == crypto.SCRYPT_N


def test_a_legacy_slot_still_unlocks(tmp_path, store):
    from modules.file_vault import crypto

    expected = _downgrade_to_legacy(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD)
    assert store.slots[identity.SLOT_PASSWORD].scrypt_n == crypto.SCRYPT_N_LEGACY
    assert identity.unlock_via_password(store, PASSWORD) == expected


def test_upgrade_rewraps_a_legacy_slot_and_keeps_the_same_imk(tmp_path, store):
    from modules.file_vault import crypto

    expected = _downgrade_to_legacy(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD)

    assert identity.upgrade_scrypt_slot(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD) is True
    assert store.slots[identity.SLOT_PASSWORD].scrypt_n == crypto.SCRYPT_N
    # 同一把 IMK：换的是外面那层包装，不是里面的钥匙。换了的话文件全解不开了。
    assert identity.unlock_via_password(store, PASSWORD) == expected
    # 落盘了，不只是改了内存
    assert identity.load_identity_store(tmp_path).slots[identity.SLOT_PASSWORD].scrypt_n == crypto.SCRYPT_N


def test_upgrade_is_idempotent(tmp_path, store):
    assert identity.upgrade_scrypt_slot(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD) is False


def test_upgrade_with_a_wrong_secret_changes_nothing(tmp_path, store):
    from modules.file_vault import crypto

    _downgrade_to_legacy(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD)
    before = store.slots[identity.SLOT_PASSWORD]

    assert identity.upgrade_scrypt_slot(tmp_path, store, identity.SLOT_PASSWORD, "not the password") is False
    assert store.slots[identity.SLOT_PASSWORD] is before
    assert store.slots[identity.SLOT_PASSWORD].scrypt_n == crypto.SCRYPT_N_LEGACY


def test_upgrade_that_cannot_write_leaves_the_vault_openable(tmp_path, store, monkeypatch):
    """磁盘写不了时金库必须还能打开：升级只是优化，不属于解锁流程，不能让 IO 错误冒出去把"稍好爆破"
    变成"打不开自己的数据"。"""
    from modules.file_vault import crypto

    expected = _downgrade_to_legacy(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD)

    def boom(data_dir, s):
        raise OSError("disk full")

    monkeypatch.setattr(identity, "save_identity_store", boom)
    assert identity.upgrade_scrypt_slot(tmp_path, store, identity.SLOT_PASSWORD, PASSWORD) is False

    # 内存里的槽位必须回滚成磁盘上那一份。不回滚的话，下次解锁会拿新成本去开一个
    # 仍然是旧成本封的槽位，直接变成"密码错误"。
    assert store.slots[identity.SLOT_PASSWORD].scrypt_n == crypto.SCRYPT_N_LEGACY
    assert identity.unlock_via_password(store, PASSWORD) == expected


def test_recovery_slot_upgrades_too(tmp_path, store):
    from modules.file_vault import crypto

    expected = _downgrade_to_legacy(tmp_path, store, identity.SLOT_RECOVERY, RECOVERY_KEY)
    assert identity.upgrade_scrypt_slot(tmp_path, store, identity.SLOT_RECOVERY, RECOVERY_KEY) is True
    assert store.slots[identity.SLOT_RECOVERY].scrypt_n == crypto.SCRYPT_N
    assert identity.unlock_via_recovery_key(store, RECOVERY_KEY) == expected


# 向导里可跳过的因子（验证器 / 邮箱 / 生物识别）。不变量：跳过 = 根本不建槽，不拿占位值建假槽；
# 假槽是谁都能推导出的解锁路径，外观与正常槽无异。密码和恢复密钥始终会建，所以跳过可选因子
# 不会让金库打不开。


def test_skipping_the_authenticator_creates_no_totp_slot(tmp_path, fake_keyring):
    store = identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=None,
        email_address=EMAIL,
        recovery_key=RECOVERY_KEY,
    )
    assert identity.SLOT_TOTP not in store.slots
    # 兜底的两条必须在——它们是"金库永远打得开"的保证
    assert identity.SLOT_PASSWORD in store.slots
    assert identity.SLOT_RECOVERY in store.slots
    # keyring 里也不该留下一个空种子
    assert real_keyring.get_password(identity.SERVICE_NAME, identity.KEYRING_TOTP_SEED) is None
    # 重新读回来仍然没有这个槽（不是只在内存里对）
    assert identity.SLOT_TOTP not in identity.load_identity_store(tmp_path).slots


def test_skipping_the_authenticator_still_unlocks_by_password_and_recovery(tmp_path, fake_keyring):
    store = identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=None,
        email_address=None,
        recovery_key=RECOVERY_KEY,
    )
    assert identity.unlock_via_password(store, PASSWORD) is not None
    assert identity.unlock_via_recovery_key(store, RECOVERY_KEY) is not None


def test_skipping_email_creates_no_email_slot(tmp_path, fake_keyring):
    """没填邮箱却建邮箱解锁槽，会留一条走不通的路：unlock_email_start 因 store.email_address 为空
    而拒绝，但界面标签还在，用户会以为自己操作错了。"""
    store = identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=TOTP_SEED,
        email_address=None,
        recovery_key=RECOVERY_KEY,
    )
    assert identity.SLOT_EMAIL not in store.slots
    assert real_keyring.get_password(identity.SERVICE_NAME, identity.KEYRING_EMAIL_SECRET) is None


def test_skipping_everything_optional_still_leaves_a_usable_vault(tmp_path, fake_keyring):
    store = identity.setup_identity(
        data_dir=tmp_path,
        password=PASSWORD,
        totp_seed=None,
        email_address=None,
        recovery_key=RECOVERY_KEY,
        enable_fingerprint=False,
    )
    assert set(store.slots.keys()) == {identity.SLOT_PASSWORD, identity.SLOT_RECOVERY}
    assert identity.unlock_via_password(store, PASSWORD) is not None
