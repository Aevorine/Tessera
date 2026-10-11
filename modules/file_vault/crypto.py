"""Crypto primitives: an IMK wrapped by five unlock factors; per-file random FK wrapped by the IMK, content in chunked AES-256-GCM. Scrypt runs once per unlock, never per file byte."""

import base64
import hmac
import os
import threading
import unicodedata
from functools import lru_cache
from typing import Dict, Optional, Tuple

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import mlkem
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

KEY_LEN = 32  # 256-bit keys throughout
NONCE_LEN = 12  # standard AES-GCM nonce length
SALT_LEN = 16

# Selectable AEAD ciphers for file content only; identity layer (IMK, key slots) stays AES-256-GCM.
# The choice is recorded in the container header. All use 12-byte nonces (nonce_prefix+index scheme).
FILE_CIPHERS = {
    "aes-256-gcm": (AESGCM, 32),  # default: hardware-accelerated (AES-NI)
    "aes-128-gcm": (AESGCM, 16),  # read-only, see RETIRED_FILE_CIPHERS
    "chacha20-poly1305": (ChaCha20Poly1305, 32),  # fastest without AES-NI
}
DEFAULT_FILE_CIPHER = "aes-256-gcm"

# Ciphers that still decrypt but must never be chosen for a new container. AES-128 drops to a
# 64-bit search under Grover, so removing it from the write path is the post-quantum fix;
# the read path must stay forever for existing files.
RETIRED_FILE_CIPHERS = frozenset({"aes-128-gcm"})

def selectable_file_ciphers() -> list:
    """Ciphers offered for new encryptions, strongest-first."""
    return [name for name in FILE_CIPHERS if name not in RETIRED_FILE_CIPHERS]


# Post-quantum scope: AES-256-GCM and the key hierarchy use no public-key crypto, so bulk content
# was already PQ-secure (Grover leaves 128 bits). ML-KEM adds a hybrid FK wrap (key derived from
# IMK and ML-KEM-1024 secret together), so both must be broken; it keeps the guarantee when a
# container leaves this machine. It does not help against someone holding the identity master key.
PQ_KEM = "ml-kem-1024"
PQ_SEED_LEN = 64  # ML-KEM seed (d||z) as serialised by private_bytes_raw
PQ_PUBLIC_LEN = 1568
PQ_CIPHERTEXT_LEN = 1568
_PQ_HKDF_INFO = b"ivault.pq.fk.v1"


# Cache of expanded ML-KEM keys: rebuilding a private key (0.22 ms) costs more than decapsulating
# (0.09 ms); per-file rebuild made PQ decryption of 2000 files 1.7x slower. It only holds keys the
# unlocked session already keeps in memory, so no extra exposure; maxsize small (one keypair).
@lru_cache(maxsize=4)
def _mlkem_private(seed: bytes):
    return mlkem.MLKEM1024PrivateKey.from_seed_bytes(seed)


@lru_cache(maxsize=8)
def _mlkem_public(public_key_raw: bytes):
    return mlkem.MLKEM1024PublicKey.from_public_bytes(public_key_raw)


def generate_pq_keypair() -> tuple:
    """Return (seed, public_key_raw). The 64-byte seed is the only thing that
    needs storing - the public key is recomputed from it on demand."""
    private = mlkem.MLKEM1024PrivateKey.generate()
    return private.private_bytes_raw(), private.public_key().public_bytes_raw()


def pq_public_key_from_seed(seed: bytes) -> bytes:
    return _mlkem_private(seed).public_key().public_bytes_raw()


def pq_encapsulate(public_key_raw: bytes) -> tuple:
    """Return (shared_secret, kem_ciphertext) for a recipient public key."""
    return _mlkem_public(public_key_raw).encapsulate()


def pq_decapsulate(seed: bytes, kem_ciphertext: bytes) -> bytes:
    return _mlkem_private(seed).decapsulate(kem_ciphertext)


def forget_pq_key_material() -> None:
    """Drop cached key objects. Called when a session ends."""
    _mlkem_private.cache_clear()
    _mlkem_public.cache_clear()


def hybrid_kek(imk: bytes, pq_shared_secret: bytes, salt: bytes) -> bytes:
    """Combine the master key and ML-KEM secret via one HKDF extract (KEM combiner) into a 256-bit KEK. Order and info string are fixed forever or existing containers become unopenable."""
    return HKDF(
        algorithm=hashes.SHA256(), length=KEY_LEN, salt=salt, info=_PQ_HKDF_INFO
    ).derive(imk + pq_shared_secret)

# Scrypt cost: n=2**17, r=8 (OWASP minimum) needs ~134 MB RAM, 0.5-2s, once per unlock.
# Memory is the point: it makes GPU/ASIC parallel guessing expensive (old n=2**14 needed only 16 MB).
SCRYPT_N = 2**17
SCRYPT_R = 8
SCRYPT_P = 1

# n used by vaults created before the bump. Never change: slots from then did not record n, so
# `Slot.from_json` falls back to this (see identity.py); changing it makes them permanently unopenable.
SCRYPT_N_LEGACY = 2**14

__all__ = [
    "InvalidTag",
    "FILE_CIPHERS",
    "DEFAULT_FILE_CIPHER",
    "RETIRED_FILE_CIPHERS",
    "selectable_file_ciphers",
    "PQ_KEM",
    "PQ_SEED_LEN",
    "PQ_PUBLIC_LEN",
    "PQ_CIPHERTEXT_LEN",
    "generate_pq_keypair",
    "pq_public_key_from_seed",
    "pq_encapsulate",
    "pq_decapsulate",
    "forget_pq_key_material",
    "hybrid_kek",
    "generate_key",
    "generate_file_key",
    "random_salt",
    "random_nonce",
    "derive_key_scrypt",
    "derive_key_hkdf",
    "aead_encrypt",
    "aead_decrypt",
    "file_aead_encrypt",
    "file_aead_decrypt",
    "wrap_key",
    "unwrap_key",
    "PASSPHRASE_MIN_CHARS",
    "PassphraseKdfError",
    "PassphraseKeyringClosed",
    "argon2id_available",
    "default_passphrase_kdf",
    "derive_passphrase_kek",
    "PassphraseKeyring",
    "as_passphrase_keyring",
]


def generate_key() -> bytes:
    return AESGCM.generate_key(bit_length=256)


def random_salt() -> bytes:
    return os.urandom(SALT_LEN)


def random_nonce() -> bytes:
    return os.urandom(NONCE_LEN)


def derive_key_scrypt(secret: bytes, salt: bytes, n: int = SCRYPT_N) -> bytes:
    """Derive a 256-bit key from a low-entropy secret with memory-hard Scrypt. `n` is the cost recorded with the slot's salt, so old data stays readable; omit it for new slots (SCRYPT_N)."""
    kdf = Scrypt(salt=salt, length=KEY_LEN, n=n, r=SCRYPT_R, p=SCRYPT_P)
    return kdf.derive(secret)


def derive_key_hkdf(secret: bytes, salt: bytes, info: bytes) -> bytes:
    """Derive a 256-bit key from an already-high-entropy stored secret (TOTP seed, email secret, machine fingerprint); fast HKDF."""
    hkdf = HKDF(algorithm=hashes.SHA256(), length=KEY_LEN, salt=salt, info=info)
    return hkdf.derive(secret)


def generate_file_key(cipher: str) -> bytes:
    """Generate a File Key sized for the given file cipher. Raises KeyError
    for an unknown cipher name - callers validate against FILE_CIPHERS first."""
    _, key_len = FILE_CIPHERS[cipher]
    return os.urandom(key_len)


def file_aead_encrypt(cipher: str, key: bytes, nonce: bytes, plaintext: bytes, associated_data: bytes = None) -> bytes:
    cls, _ = FILE_CIPHERS[cipher]
    return cls(key).encrypt(nonce, plaintext, associated_data)


def file_aead_decrypt(cipher: str, key: bytes, nonce: bytes, ciphertext: bytes, associated_data: bytes = None) -> bytes:
    """Raises cryptography.exceptions.InvalidTag if key/nonce/data don't match."""
    cls, _ = FILE_CIPHERS[cipher]
    return cls(key).decrypt(nonce, ciphertext, associated_data)


def aead_encrypt(key: bytes, nonce: bytes, plaintext: bytes, associated_data: bytes = None) -> bytes:
    return AESGCM(key).encrypt(nonce, plaintext, associated_data)


def aead_decrypt(key: bytes, nonce: bytes, ciphertext: bytes, associated_data: bytes = None) -> bytes:
    """Raises cryptography.exceptions.InvalidTag if key/nonce/data don't match."""
    return AESGCM(key).decrypt(nonce, ciphertext, associated_data)


def wrap_key(kek: bytes, key_to_wrap: bytes) -> tuple[bytes, bytes]:
    """Wrap (encrypt) a raw key with a Key-Encryption-Key. Returns (nonce, wrapped)."""
    nonce = random_nonce()
    wrapped = aead_encrypt(kek, nonce, key_to_wrap)
    return nonce, wrapped


def unwrap_key(kek: bytes, nonce: bytes, wrapped: bytes) -> bytes:
    """Unwrap a key. Raises InvalidTag if kek is wrong."""
    return aead_decrypt(kek, nonce, wrapped)


# 「加密给别人」：FK 用口令经 Argon2id 派生的 KEK 封装，另一金库只凭口令即可打开，IMK 不离开本机。
# 与 IMK / ML-KEM 封装互斥，头部只出现 fk_wrap_pw；同时写 fk_wrap 会让攻击者取较弱一条路绕过。
# 口令低熵，慢哈希成本即全部防线；参数写入头部可日后调高，读取有上限（_PASSPHRASE_LIMITS）。

try:
    from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
except ImportError:  # 老版本 cryptography 没有这个模块——退回 scrypt
    Argon2id = None

PASSPHRASE_MIN_CHARS = 8
KDF_ARGON2ID = "argon2id"
KDF_SCRYPT = "scrypt"

# m 以 KiB 计：256 MiB、t=3、p=4，高于 RFC 9106 第二推荐档（64 MiB/t=3/p=4）。
# 派生只发生在分享批次开始和收件人输入口令时，不在逐文件热路径（见 PassphraseKeyring）。
ARGON2ID_DEFAULTS = {"m": 256 * 1024, "t": 3, "p": 4}
# 只在运行时没有 Argon2id 时才用：与身份层 scrypt 同一档成本（约 134 MB）。
SCRYPT_SHARE_DEFAULTS = {"n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P}

# 读取时的参数上限：头部在解开 FK 前未认证，恶意文件可写 m=64 GiB 撑爆进程，故必须强制；
# 留有余量以便调高默认值（m 到 2 GiB、t 到 16）。
_PASSPHRASE_LIMITS = {
    KDF_ARGON2ID: {"m": (8, 2 * 1024 * 1024), "t": (1, 16), "p": (1, 16)},
    KDF_SCRYPT: {"n": (2**10, 2**20), "r": (1, 16), "p": (1, 4)},
}
_PASSPHRASE_SALT_RANGE = (16, 64)
_PW_WRAP_AAD = b"ivault.fk.pw.v1"

# 同时进行的口令派生最多两路（每路 256 MiB）。PassphraseKeyring 已保证同批只派生一次，
# 信号量兜的是多个批次同时开始的情况。
_KDF_SLOTS = threading.BoundedSemaphore(2)


class PassphraseKeyringClosed(RuntimeError):
    """The keyring was forgotten while work needing it was still queued; every use after forget() fails rather than seal under an empty passphrase."""


class PassphraseKdfError(ValueError):
    """kdf 不认识 / 参数越界 / 本机缺该算法。`reason` 是 "unsupported" 或
    "invalid_params"，由容器层映射成用户可读的错误码。"""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@lru_cache(maxsize=1)
def argon2id_available() -> bool:
    """「模块能 import」不等于「能用」：cryptography 链接的 OpenSSL 可能没编进
    Argon2。所以真跑一次最小参数的派生来判断。"""
    if Argon2id is None:
        return False
    try:
        Argon2id(salt=bytes(16), length=KEY_LEN, iterations=1, lanes=1, memory_cost=8).derive(b"probe")
    except Exception:
        return False
    return True


def default_passphrase_kdf() -> Tuple[str, Dict[str, int]]:
    if argon2id_available():
        return KDF_ARGON2ID, dict(ARGON2ID_DEFAULTS)
    return KDF_SCRYPT, dict(SCRYPT_SHARE_DEFAULTS)


def normalize_passphrase(passphrase: str) -> bytes:
    """NFC 后按 UTF-8 编码，否则带组合字符的口令在不同输入法下码点不同，导致同一口令解不开。"""
    if not isinstance(passphrase, str) or passphrase == "":
        raise ValueError("empty passphrase")
    return unicodedata.normalize("NFC", passphrase).encode("utf-8")


def _validated_kdf_params(kdf: str, params) -> Dict[str, int]:
    limits = _PASSPHRASE_LIMITS.get(kdf)
    if limits is None:
        raise PassphraseKdfError("unsupported")
    if not isinstance(params, dict) or set(params) != set(limits):
        raise PassphraseKdfError("invalid_params")
    out: Dict[str, int] = {}
    for name, (lo, hi) in limits.items():
        value = params[name]
        # bool 是 int 的子类，`true` 不能冒充 1。
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise PassphraseKdfError("invalid_params")
        out[name] = value
    if kdf == KDF_ARGON2ID and out["m"] < 8 * out["p"]:
        raise PassphraseKdfError("invalid_params")
    if kdf == KDF_SCRYPT and out["n"] & (out["n"] - 1):
        raise PassphraseKdfError("invalid_params")
    return out


def derive_passphrase_kek(secret: bytes, kdf: str, params, salt: bytes) -> bytes:
    """Deliberately slow. `secret` is the normalize_passphrase() output."""
    params = _validated_kdf_params(kdf, params)
    if not isinstance(salt, (bytes, bytearray)) or not _PASSPHRASE_SALT_RANGE[0] <= len(salt) <= _PASSPHRASE_SALT_RANGE[1]:
        raise PassphraseKdfError("invalid_params")
    if kdf == KDF_ARGON2ID:
        if not argon2id_available():
            raise PassphraseKdfError("unsupported")
        with _KDF_SLOTS:
            return Argon2id(
                salt=bytes(salt), length=KEY_LEN, iterations=params["t"], lanes=params["p"], memory_cost=params["m"],
            ).derive(secret)
    with _KDF_SLOTS:
        return Scrypt(salt=bytes(salt), length=KEY_LEN, n=params["n"], r=params["r"], p=params["p"]).derive(secret)


def _params_key(params: Dict[str, int]) -> tuple:
    return tuple(sorted(params.items()))


class PassphraseKeyring:
    """一个口令、一批容器：慢哈希每批只跑一次。

    - 封装：同一 keyring 封出的容器共用一个 salt 和 KEK（同口令，攻破一个等于全部；salt 防的是
      跨口令预计算，不受影响），每个 FK 仍用随机 nonce。
    - 打开：每个不同的 (kdf, 参数, salt) 只派生一次并缓存。
    缓存里只放 KEK，不放口令的快速指纹，否则内存转储可绕开慢哈希离线猜口令。
    """

    def __init__(self, passphrase: str):
        self._phrase = normalize_passphrase(passphrase)
        # _lock 串行化"开"方向的派生；_seal_lock 保证"封"方向整批只选一次参数、
        # 只派生一次。两把锁不嵌套：seal 路径先拿 _seal_lock 再进 _kek 拿 _lock。
        self._lock = threading.Lock()
        self._seal_lock = threading.Lock()
        self._opened: Dict[tuple, bytes] = {}
        self._sealing: Optional[Tuple[str, Dict[str, int], bytes, bytes]] = None
        self._closed = False

    def matches(self, passphrase: str) -> bool:
        try:
            return hmac.compare_digest(self._phrase, normalize_passphrase(passphrase))
        except ValueError:
            return False

    def _check_open(self) -> None:
        if self._closed:
            raise PassphraseKeyringClosed("passphrase keyring already forgotten")

    def _kek(self, kdf: str, params: Dict[str, int], salt: bytes) -> bytes:
        # 持锁派生是有意的：同一批的并发 worker 在这里排队，第一个算完，其余
        # 直接命中缓存——而不是 8 路同时各算一遍。
        cache_key = (kdf, _params_key(params), bytes(salt))
        with self._lock:
            self._check_open()
            kek = self._opened.get(cache_key)
            if kek is None:
                kek = derive_passphrase_kek(self._phrase, kdf, params, salt)
                # 派生要几百毫秒，期间可能被 forget()：结果不许留下，也不许用。
                self._check_open()
                self._opened[cache_key] = kek
            return kek

    def seal_key(self, key: bytes) -> dict:
        """Wrap `key`, returning the header's fk_wrap_pw object."""
        with self._seal_lock:
            self._check_open()
            if self._sealing is None:
                kdf, params = default_passphrase_kdf()
                salt = random_salt()
                self._sealing = (kdf, params, salt, self._kek(kdf, params, salt))
            sealing = self._sealing
        kdf, params, salt, kek = sealing
        nonce = random_nonce()
        wrapped = AESGCM(kek).encrypt(nonce, key, _PW_WRAP_AAD)
        return {
            "kdf": kdf,
            "params": dict(params),
            "salt": base64.b64encode(salt).decode(),
            "nonce": base64.b64encode(nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped).decode(),
        }

    def open_key(self, wrap: dict) -> bytes:
        """Raises ValueError (malformed), PassphraseKdfError, or InvalidTag
        (wrong passphrase - or a tampered wrap, indistinguishable by design)."""
        if not isinstance(wrap, dict):
            raise ValueError("fk_wrap_pw is not an object")
        try:
            kdf = wrap["kdf"]
            params = wrap["params"]
            salt = base64.b64decode(wrap["salt"], validate=True)
            nonce = base64.b64decode(wrap["nonce"], validate=True)
            wrapped = base64.b64decode(wrap["wrapped_fk"], validate=True)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("malformed fk_wrap_pw") from exc
        if not isinstance(kdf, str) or len(nonce) != NONCE_LEN:
            raise ValueError("malformed fk_wrap_pw")
        params = _validated_kdf_params(kdf, params)
        return AESGCM(self._kek(kdf, params, salt)).decrypt(nonce, wrapped, _PW_WRAP_AAD)

    def forget(self) -> None:
        """Drop cached KEKs and the passphrase and refuse later use (PassphraseKeyringClosed). Python bytes can't be wiped in place.

        Deliberately lock-free: runs on the dispatch thread while a derivation holding _lock may take seconds; a running derivation sees the flag and discards its result."""
        self._closed = True
        self._opened = {}
        self._sealing = None
        self._phrase = b""


def as_passphrase_keyring(passphrase) -> Optional[PassphraseKeyring]:
    """None / str / keyring -> keyring (or None). Lets container APIs take a
    plain string in one-off calls and a shared keyring in batches."""
    if passphrase is None or isinstance(passphrase, PassphraseKeyring):
        return passphrase
    return PassphraseKeyring(passphrase)
