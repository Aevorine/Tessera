"""Identity layer: the IMK is generated once at setup and wrapped five independent ways (password / TOTP / email /
optional Windows Hello fingerprint / recovery key); any ONE factor unwraps it (user's choice: convenience over all-factors).
The IMK wraps each file's own File Key (see container.py), so file throughput never depends on slow factor checks.

Wrapped slots live in data_dir/identity_store.json (gitignored). The TOTP seed, email secret and fingerprint secret
are kept in the OS credential store via `keyring`, never in the JSON."""

import base64
import json
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

import keyring

from core.logging import get_logger
from cryptography.exceptions import InvalidTag

from modules.file_vault import ai_client, crypto, email_otp, fingerprint
from modules.file_vault import totp as totp_mod
from modules.file_vault.errors import VaultError

logger = get_logger(__name__)


# Overridable so subprocess-based tests can use a throwaway keyring namespace instead of reading/overwriting the
# real user's secrets (happened in practice; see IDEAL1_FILE_VAULT_KEYRING_SERVICE in test_backend_server.py).
SERVICE_NAME = os.environ.get("IDEAL1_FILE_VAULT_KEYRING_SERVICE", "ideal1-file-vault")
KEYRING_TOTP_SEED = "totp_seed"
KEYRING_EMAIL_SECRET = "email_secret"
KEYRING_SMTP_CONFIG = "smtp_config"
KEYRING_BIO_SECRET = "bio_secret"
KEYRING_AI_CONFIG = "ai_config"

SLOT_PASSWORD = "password"
SLOT_TOTP = "totp"
SLOT_EMAIL = "email"
SLOT_FINGERPRINT = "fingerprint"
SLOT_RECOVERY = "recovery"
ALL_SLOTS = (SLOT_PASSWORD, SLOT_TOTP, SLOT_EMAIL, SLOT_FINGERPRINT, SLOT_RECOVERY)

# 胁迫密码槽，故意不在 ALL_SLOTS 里：它通往独立的诱饵金库，遍历所有解锁方式的地方都不该算它
# （否则会出现在解锁方式列表和安全体检计数里，暴露其存在）。它包的是另一个 IMK，解开后应用切到
# `<数据目录>/decoy`，那里有独立且看似正常的剪贴板、笔记、密码库。
SLOT_DURESS = "duress"

INFO_TOTP = b"file_vault-totp"
INFO_EMAIL = b"file_vault-email"
INFO_FINGERPRINT = b"file_vault-fingerprint"

IDENTITY_FILENAME = "identity_store.json"


class UnlockError(VaultError):
    """A factor was presented but did not successfully unwrap IMK."""


class IdentityNotSetUpError(VaultError):
    pass


class LockedOutError(VaultError):
    """Too many recent failed unlock attempts across password/TOTP/recovery-key/email (see check_not_locked_out); don't attempt the unwrap while raised."""


# Brute-force throttling for the four guessable factors (password, TOTP, recovery key, email code; fingerprint is
# excluded, Windows Hello has its own lockout). Scrypt alone doesn't stop RPC hammering and TOTP/email guesses cost nothing,
# so an escalating lockout is shared across all four (switching factors can't reset it) and persisted in IdentityStore (survives restart).
FREE_UNLOCK_ATTEMPTS = 5
BASE_LOCKOUT_SECONDS = 5
MAX_LOCKOUT_SECONDS = 300


def _lockout_seconds_for(failed_attempts: int) -> float:
    if failed_attempts <= FREE_UNLOCK_ATTEMPTS:
        return 0.0
    exponent = failed_attempts - FREE_UNLOCK_ATTEMPTS - 1
    return min(BASE_LOCKOUT_SECONDS * (2**exponent), MAX_LOCKOUT_SECONDS)


def check_not_locked_out(store: "IdentityStore") -> None:
    """Raises LockedOutError (with seconds_remaining for a UI countdown) if a lockout window hasn't elapsed.
    Check BEFORE unwrapping: the point is to skip the slow Scrypt derivation entirely, not just discard its result."""
    remaining = store.locked_until - time.time()
    if remaining > 0:
        raise LockedOutError("auth.locked_out", seconds_remaining=int(remaining) + 1)


def record_failed_unlock_attempt(data_dir: Path, store: "IdentityStore") -> None:
    store.failed_attempts += 1
    lockout = _lockout_seconds_for(store.failed_attempts)
    if lockout > 0:
        store.locked_until = time.time() + lockout
    save_identity_store(data_dir, store)


def record_successful_unlock(data_dir: Path, store: "IdentityStore") -> None:
    """Resets the counter - a legitimate unlock is proof the guessing has
    stopped, regardless of how many prior attempts used other factors."""
    if store.failed_attempts or store.locked_until:
        store.failed_attempts = 0
        store.locked_until = 0.0
        save_identity_store(data_dir, store)


def default_data_dir() -> Path:
    return Path(__file__).resolve().parent / "data"


@dataclass
class Slot:
    salt: bytes
    nonce: bytes
    wrapped_imk: bytes
    # Scrypt cost this slot was wrapped with (only Scrypt slots; HKDF ones ignore it). Recorded per slot so raising
    # the cost is non-breaking; slots from before this field get SCRYPT_N_LEGACY, their true parameter, or they'd be unopenable.
    scrypt_n: int = crypto.SCRYPT_N_LEGACY

    def to_json(self) -> dict:
        return {
            "salt": base64.b64encode(self.salt).decode(),
            "nonce": base64.b64encode(self.nonce).decode(),
            "wrapped_imk": base64.b64encode(self.wrapped_imk).decode(),
            "scrypt_n": self.scrypt_n,
        }

    @staticmethod
    def from_json(d: dict) -> "Slot":
        return Slot(
            salt=base64.b64decode(d["salt"]),
            nonce=base64.b64decode(d["nonce"]),
            wrapped_imk=base64.b64decode(d["wrapped_imk"]),
            # Absent => written before the cost bump. See the field comment.
            scrypt_n=int(d.get("scrypt_n", crypto.SCRYPT_N_LEGACY)),
        )


@dataclass
class IdentityStore:
    email_address: Optional[str]
    slots: Dict[str, Slot] = field(default_factory=dict)
    format_version: int = 1
    created_at: float = field(default_factory=time.time)
    # Brute-force lockout state (see check_not_locked_out/record_failed_unlock_attempt); defaulted so older identity_store.json still loads.
    failed_attempts: int = 0
    locked_until: float = 0.0
    # The identity's ML-KEM-1024 keypair for hybrid-wrapping File Keys in post-quantum containers
    # (see container._wrap_fk_for_header): {"kem", "public_key", "nonce", "wrapped_seed"}; the 64-byte seed
    # is IMK-wrapped, the public key is plain. Absent on older identities until needed, since generating needs an unlocked IMK (ensure_pq_keypair).
    pq_keypair: Optional[dict] = None

    def to_json(self) -> dict:
        return {
            "format_version": self.format_version,
            "created_at": self.created_at,
            "email_address": self.email_address,
            "slots": {name: slot.to_json() for name, slot in self.slots.items()},
            "failed_attempts": self.failed_attempts,
            "locked_until": self.locked_until,
            "pq_keypair": self.pq_keypair,
        }

    @staticmethod
    def from_json(d: dict) -> "IdentityStore":
        return IdentityStore(
            format_version=d["format_version"],
            created_at=d["created_at"],
            email_address=d.get("email_address"),
            slots={name: Slot.from_json(s) for name, s in d["slots"].items()},
            failed_attempts=d.get("failed_attempts", 0),
            locked_until=d.get("locked_until", 0.0),
            pq_keypair=d.get("pq_keypair"),
        )


def identity_path(data_dir: Path) -> Path:
    return data_dir / IDENTITY_FILENAME


def identity_exists(data_dir: Path) -> bool:
    return identity_path(data_dir).exists()


def load_identity_store(data_dir: Path) -> IdentityStore:
    path = identity_path(data_dir)
    if not path.exists():
        raise IdentityNotSetUpError("identity.not_set_up", path=str(path))
    with open(path, "r", encoding="utf-8") as f:
        return IdentityStore.from_json(json.load(f))


def save_identity_store(data_dir: Path, store: IdentityStore) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    path = identity_path(data_dir)
    tmp_path = path.with_name(f"{path.name}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(store.to_json(), f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)


def generate_recovery_key() -> str:
    """A 160-bit random key, base32-encoded and grouped for readability,
    e.g. 'XJ7K-9QRT-...'. Shown once at setup; never stored by the app."""
    raw = secrets.token_bytes(20)
    b32 = base64.b32encode(raw).decode().rstrip("=")
    groups = [b32[i : i + 4] for i in range(0, len(b32), 4)]
    return "-".join(groups)


def _wrap_scrypt(imk: bytes, secret: bytes) -> Slot:
    salt = crypto.random_salt()
    kek = crypto.derive_key_scrypt(secret, salt)
    nonce, wrapped = crypto.wrap_key(kek, imk)
    # Record the cost parameter actually used, so a future bump can leave this
    # slot readable instead of bricking it.
    return Slot(salt=salt, nonce=nonce, wrapped_imk=wrapped, scrypt_n=crypto.SCRYPT_N)


def _wrap_hkdf(imk: bytes, secret: bytes, info: bytes) -> Slot:
    salt = crypto.random_salt()
    kek = crypto.derive_key_hkdf(secret, salt, info)
    nonce, wrapped = crypto.wrap_key(kek, imk)
    return Slot(salt=salt, nonce=nonce, wrapped_imk=wrapped)


def setup_identity(
    data_dir: Path,
    password: str,
    totp_seed: Optional[str],
    email_address: Optional[str],
    recovery_key: str,
    enable_fingerprint: bool = False,
) -> IdentityStore:
    """Create a new identity: generate the IMK, wrap it several ways, persist slots to disk and the TOTP seed/email secret/bio secret to keyring.
    Called once by the setup wizard after the user confirmed the TOTP QR code and recovery key.

    Password and recovery are always created (together they guarantee the vault is never unopenable); the rest is optional:
    totp_seed=None (no authenticator), email_address=None (no SMTP), enable_fingerprint (only after a real Hello verification in the wizard).
    A skipped factor gets no slot at all, never one wrapped around a placeholder, which would be an unlock path anyone could derive."""
    imk = crypto.generate_key()
    email_secret = crypto.generate_key()  # independent of TOTP seed / password

    slots = {
        SLOT_PASSWORD: _wrap_scrypt(imk, password.encode("utf-8")),
        SLOT_RECOVERY: _wrap_scrypt(imk, recovery_key.strip().encode("utf-8")),
    }
    if totp_seed:
        slots[SLOT_TOTP] = _wrap_hkdf(imk, totp_seed.encode("utf-8"), INFO_TOTP)
    # 邮箱槽只在真填了邮箱时建：否则 unlock_email_start 会因 store.email_address 为空而拒绝，但界面标签仍在，用户会以为自己操作错了。
    if email_address:
        slots[SLOT_EMAIL] = _wrap_hkdf(imk, email_secret, INFO_EMAIL)

    bio_secret = None
    if enable_fingerprint:
        bio_secret = fingerprint.generate_bio_secret()
        slots[SLOT_FINGERPRINT] = _wrap_hkdf(imk, bio_secret, INFO_FINGERPRINT)

    store = IdentityStore(email_address=email_address, slots=slots)
    store.pq_keypair = _build_pq_keypair(imk)
    save_identity_store(data_dir, store)

    if totp_seed:
        keyring.set_password(SERVICE_NAME, KEYRING_TOTP_SEED, totp_seed)
    if email_address:
        keyring.set_password(SERVICE_NAME, KEYRING_EMAIL_SECRET, base64.b64encode(email_secret).decode())
    if bio_secret is not None:
        keyring.set_password(SERVICE_NAME, KEYRING_BIO_SECRET, base64.b64encode(bio_secret).decode())

    return store


# One ML-KEM-1024 keypair per identity. Post-quantum containers carry an ML-KEM ciphertext in the header; opening
# needs this seed plus the IMK (crypto.hybrid_kek). The seed is IMK-wrapped, so every unlock factor reaches it
# and it cannot be lost while any unlock path works.


def _build_pq_keypair(imk: bytes) -> dict:
    seed, public_key = crypto.generate_pq_keypair()
    nonce, wrapped_seed = crypto.wrap_key(imk, seed)
    return {
        "kem": crypto.PQ_KEM,
        "public_key": base64.b64encode(public_key).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "wrapped_seed": base64.b64encode(wrapped_seed).decode(),
    }


def load_pq_keypair(store: IdentityStore, imk: bytes) -> Optional[tuple]:
    """Return (seed, public_key), or None if no PQ keypair yet. Raises UnlockError if the record exists but the IMK can't open it:
    treating that as "absent" would re-key the identity and orphan every container written against the old public key."""
    record = store.pq_keypair
    if not record:
        return None
    if record.get("kem") != crypto.PQ_KEM:
        raise UnlockError("identity.pq_unsupported_kem")
    try:
        seed = crypto.unwrap_key(
            imk,
            base64.b64decode(record["nonce"]),
            base64.b64decode(record["wrapped_seed"]),
        )
        public_key = base64.b64decode(record["public_key"])
    except (KeyError, TypeError, ValueError, crypto.InvalidTag) as exc:
        raise UnlockError("identity.pq_keypair_corrupt") from exc
    return seed, public_key


def ensure_pq_keypair(data_dir: Path, store: IdentityStore, imk: bytes) -> tuple:
    """Return (seed, public_key), generating and persisting one on first request for an identity predating this feature (~0.2 ms, once)."""
    existing = load_pq_keypair(store, imk)
    if existing is not None:
        return existing
    store.pq_keypair = _build_pq_keypair(imk)
    save_identity_store(data_dir, store)
    return load_pq_keypair(store, imk)


def save_smtp_config(config: email_otp.SmtpConfig) -> None:
    blob = json.dumps(
        {
            "host": config.host,
            "port": config.port,
            "username": config.username,
            "password": config.password,
            "use_ssl": config.use_ssl,
        }
    )
    keyring.set_password(SERVICE_NAME, KEYRING_SMTP_CONFIG, blob)


def load_smtp_config() -> Optional[email_otp.SmtpConfig]:
    blob = keyring.get_password(SERVICE_NAME, KEYRING_SMTP_CONFIG)
    if blob is None:
        return None
    d = json.loads(blob)
    return email_otp.SmtpConfig(**d)


def save_ai_config(config: ai_client.AiConfig) -> None:
    blob = json.dumps({"api_key": config.api_key, "model": config.model, "base_url": config.base_url})
    keyring.set_password(SERVICE_NAME, KEYRING_AI_CONFIG, blob)


def load_ai_config() -> Optional[ai_client.AiConfig]:
    blob = keyring.get_password(SERVICE_NAME, KEYRING_AI_CONFIG)
    if blob is None:
        return None
    d = json.loads(blob)
    return ai_client.AiConfig(**d)


# --- Unlock paths: each returns the raw 32-byte IMK, or raises UnlockError ---


def unlock_via_password(store: IdentityStore, password: str) -> bytes:
    slot = store.slots[SLOT_PASSWORD]
    # slot.scrypt_n, not crypto.SCRYPT_N: this slot must be opened with the
    # cost it was sealed with, whatever the current default happens to be.
    kek = crypto.derive_key_scrypt(password.encode("utf-8"), slot.salt, slot.scrypt_n)
    try:
        return crypto.unwrap_key(kek, slot.nonce, slot.wrapped_imk)
    except InvalidTag:
        raise UnlockError("auth.wrong_password")


def has_duress_password(store: IdentityStore) -> bool:
    return SLOT_DURESS in store.slots


def set_duress_password(data_dir: Path, store: IdentityStore, duress_password: str) -> bytes:
    """设一个胁迫密码，返回对应的诱饵 IMK。诱饵 IMK 现场随机生成，必须与真 IMK 无数学关系，
    否则诱饵密码持有者多一条攻击真金库的路。重设直接覆盖旧槽，旧诱饵数据不删（删除本身会留下痕迹）。"""
    decoy_imk = crypto.generate_key()
    store.slots[SLOT_DURESS] = _wrap_scrypt(decoy_imk, duress_password.encode("utf-8"))
    save_identity_store(data_dir, store)
    return decoy_imk


def clear_duress_password(data_dir: Path, store: IdentityStore) -> bool:
    if SLOT_DURESS not in store.slots:
        return False
    del store.slots[SLOT_DURESS]
    save_identity_store(data_dir, store)
    return True


def unlock_via_duress(store: IdentityStore, password: str) -> bytes:
    """用胁迫密码解开诱饵 IMK，没设过或对不上都抛 UnlockError。
    调用方必须在真密码失败之后才试，且两条路的错误码和耗时特征要完全一致，否则能被试出胁迫密码是否存在。"""
    slot = store.slots.get(SLOT_DURESS)
    if slot is None:
        raise UnlockError("auth.wrong_password")
    kek = crypto.derive_key_scrypt(password.encode("utf-8"), slot.salt, slot.scrypt_n)
    try:
        return crypto.unwrap_key(kek, slot.nonce, slot.wrapped_imk)
    except InvalidTag:
        raise UnlockError("auth.wrong_password")


def unlock_via_recovery_key(store: IdentityStore, recovery_key: str) -> bytes:
    slot = store.slots[SLOT_RECOVERY]
    kek = crypto.derive_key_scrypt(recovery_key.strip().encode("utf-8"), slot.salt, slot.scrypt_n)
    try:
        return crypto.unwrap_key(kek, slot.nonce, slot.wrapped_imk)
    except InvalidTag:
        raise UnlockError("auth.wrong_recovery_key")


def upgrade_scrypt_slot(data_dir: Path, store: IdentityStore, slot_name: str, secret: str) -> bool:
    """Re-wrap a Scrypt slot at the current cost if it is on an older one; True if upgraded.

    Called right after a successful unlock, the only moment the plaintext secret is known to work without asking the user.
    Failures (read-only disk, backup tool lock, no space) are swallowed: the upgrade is an optimisation retried next unlock,
    and must not turn into "can't reach your data".
    The old wrapped key is replaced, not kept: vault strength is that of its weakest slot."""
    slot = store.slots.get(slot_name)
    if slot is None or slot.scrypt_n >= crypto.SCRYPT_N:
        return False
    try:
        imk = crypto.unwrap_key(
            crypto.derive_key_scrypt(secret.encode("utf-8"), slot.salt, slot.scrypt_n),
            slot.nonce,
            slot.wrapped_imk,
        )
    except InvalidTag:
        # Caller passed a secret that doesn't open this slot. Nothing to do -
        # and definitely nothing to write.
        return False

    previous = store.slots[slot_name]
    store.slots[slot_name] = _wrap_scrypt(imk, secret.encode("utf-8"))
    try:
        save_identity_store(data_dir, store)
    except OSError:
        # Restore the in-memory store to match what is on disk, or the next unlock would derive with the new cost against an old-cost slot.
        store.slots[slot_name] = previous
        return False
    return True


def unlock_via_totp(store: IdentityStore, code: str) -> bytes:
    seed = keyring.get_password(SERVICE_NAME, KEYRING_TOTP_SEED)
    if not seed:
        raise UnlockError("auth.totp_not_set_up")
    if not totp_mod.verify_code(seed, code):
        raise UnlockError("auth.totp_invalid_or_expired")
    slot = store.slots[SLOT_TOTP]
    kek = crypto.derive_key_hkdf(seed.encode("utf-8"), slot.salt, INFO_TOTP)
    try:
        return crypto.unwrap_key(kek, slot.nonce, slot.wrapped_imk)
    except InvalidTag:
        raise UnlockError("auth.totp_unlock_failed")


def try_unlock_via_fingerprint(
    store: IdentityStore, hwnd: int = 0, timeout_seconds: Optional[int] = None
) -> Optional[bytes]:
    """Show a blocking Windows Hello prompt (caller already chose this factor, e.g. user clicked the "指纹" tab); returns non-None only on a successful verification.

    If hwnd != 0 uses request_verification_for_window() so the prompt is on top. That prompt is modal to the window (app un-clickable),
    so timeout_seconds lets an automatic attempt (login screen fires one on mount) hold it far shorter; None = module default.

    Returns None (not an error) if no fingerprint factor is bound, the user cancels/fails, or a legacy hardware-fingerprint slot has no
    bio_secret in keyring (rebind needed). Raises fingerprint.FingerprintUnavailableError only for system-level problems; callers show a distinct message."""
    slot = store.slots.get(SLOT_FINGERPRINT)
    if slot is None:
        return None

    # Prefer the window-aware path when a parent HWND is available.
    verified: bool
    if hwnd:
        verified = fingerprint.request_verification_for_window(hwnd, timeout_seconds=timeout_seconds)
    else:
        verified = fingerprint.request_verification(timeout_seconds=timeout_seconds)

    if not verified:
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


def start_email_unlock(store: IdentityStore, smtp_config: email_otp.SmtpConfig, sender=None) -> email_otp.PendingOtp:
    if not store.email_address:
        raise UnlockError("auth.recovery_email_not_set")
    return email_otp.send_otp(smtp_config, store.email_address, sender=sender)


def finish_email_unlock(store: IdentityStore, pending: email_otp.PendingOtp, submitted_code: str) -> bytes:
    if not email_otp.verify_otp(pending, submitted_code):
        raise UnlockError("auth.email_code_invalid_or_expired")
    secret_b64 = keyring.get_password(SERVICE_NAME, KEYRING_EMAIL_SECRET)
    if not secret_b64:
        raise UnlockError("auth.email_unlock_not_set_up")
    secret = base64.b64decode(secret_b64)
    slot = store.slots[SLOT_EMAIL]
    kek = crypto.derive_key_hkdf(secret, slot.salt, INFO_EMAIL)
    try:
        return crypto.unwrap_key(kek, slot.nonce, slot.wrapped_imk)
    except InvalidTag:
        raise UnlockError("auth.email_unlock_failed")


# --- Settings: re-wrap a single slot given an already-unlocked IMK ---


def rewrap_password(data_dir: Path, store: IdentityStore, imk: bytes, new_password: str) -> None:
    store.slots[SLOT_PASSWORD] = _wrap_scrypt(imk, new_password.encode("utf-8"))
    save_identity_store(data_dir, store)


def rewrap_totp(data_dir: Path, store: IdentityStore, imk: bytes, new_seed: str) -> None:
    """Writes the keyring secret BEFORE the disk slot and rolls the keyring back if the disk write raises, so an interruption
    can't leave a new seed with no matching slot (which permanently breaks this factor with 'code invalid or expired' until rebound).
    A hard kill exactly between the writes can still desync them (no two-phase commit across backends), but the slower disk write going first made that window far larger."""
    old_seed = keyring.get_password(SERVICE_NAME, KEYRING_TOTP_SEED)
    old_slot = store.slots.get(SLOT_TOTP)
    keyring.set_password(SERVICE_NAME, KEYRING_TOTP_SEED, new_seed)
    try:
        store.slots[SLOT_TOTP] = _wrap_hkdf(imk, new_seed.encode("utf-8"), INFO_TOTP)
        save_identity_store(data_dir, store)
    except Exception:
        if old_seed is not None:
            keyring.set_password(SERVICE_NAME, KEYRING_TOTP_SEED, old_seed)
        if old_slot is not None:
            store.slots[SLOT_TOTP] = old_slot
        raise


def rewrap_email(data_dir: Path, store: IdentityStore, imk: bytes, new_email_address: str) -> None:
    """See rewrap_totp(): same keyring-before-disk-with-rollback pattern (a partial rewrap once desynced the keyring email_secret from the disk slot, breaking email unlock until rebound)."""
    new_secret = crypto.generate_key()
    old_secret_b64 = keyring.get_password(SERVICE_NAME, KEYRING_EMAIL_SECRET)
    old_email = store.email_address
    old_slot = store.slots.get(SLOT_EMAIL)
    keyring.set_password(SERVICE_NAME, KEYRING_EMAIL_SECRET, base64.b64encode(new_secret).decode())
    try:
        store.email_address = new_email_address
        store.slots[SLOT_EMAIL] = _wrap_hkdf(imk, new_secret, INFO_EMAIL)
        save_identity_store(data_dir, store)
    except Exception:
        if old_secret_b64 is not None:
            keyring.set_password(SERVICE_NAME, KEYRING_EMAIL_SECRET, old_secret_b64)
        store.email_address = old_email
        if old_slot is not None:
            store.slots[SLOT_EMAIL] = old_slot
        else:
            store.slots.pop(SLOT_EMAIL, None)
        raise


def rewrap_recovery(data_dir: Path, store: IdentityStore, imk: bytes) -> str:
    """Generate and return a brand-new recovery key (shown once, same as setup)."""
    new_key = generate_recovery_key()
    store.slots[SLOT_RECOVERY] = _wrap_scrypt(imk, new_key.encode("utf-8"))
    save_identity_store(data_dir, store)
    return new_key


def rewrap_fingerprint(data_dir: Path, store: IdentityStore, imk: bytes, hwnd: int = 0) -> None:
    """Needs an unlocked IMK (via another factor) and a real Windows Hello verification as consent, then generates a new bio_secret
    and rebinds the fingerprint slot (same pattern as rewrap_totp(), see its keyring-before-disk rationale).
    Raises fingerprint.FingerprintUnavailableError if Hello is unusable, UnlockError if verification wasn't completed."""
    verified = (
        fingerprint.request_verification_for_window(hwnd)
        if hwnd else
        fingerprint.request_verification()
    )
    if not verified:
        raise UnlockError("auth.fingerprint_verification_cancelled")
    bio_secret = fingerprint.generate_bio_secret()
    old_secret_b64 = keyring.get_password(SERVICE_NAME, KEYRING_BIO_SECRET)
    old_slot = store.slots.get(SLOT_FINGERPRINT)
    keyring.set_password(SERVICE_NAME, KEYRING_BIO_SECRET, base64.b64encode(bio_secret).decode())
    try:
        store.slots[SLOT_FINGERPRINT] = _wrap_hkdf(imk, bio_secret, INFO_FINGERPRINT)
        save_identity_store(data_dir, store)
    except Exception:
        if old_secret_b64 is not None:
            keyring.set_password(SERVICE_NAME, KEYRING_BIO_SECRET, old_secret_b64)
        if old_slot is not None:
            store.slots[SLOT_FINGERPRINT] = old_slot
        else:
            store.slots.pop(SLOT_FINGERPRINT, None)
        raise


def fingerprint_binding_is_usable(store: IdentityStore) -> bool:
    """True only if there is both a fingerprint slot AND a matching bio_secret in keyring (False for no factor, or a stale pre-feature slot).
    Lets backend_server.py say "这个绑定已失效，去重新绑定" instead of sending the user through a Hello prompt that can't work."""
    if store.slots.get(SLOT_FINGERPRINT) is None:
        return False
    return bool(keyring.get_password(SERVICE_NAME, KEYRING_BIO_SECRET))
