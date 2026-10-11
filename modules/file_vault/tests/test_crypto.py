import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.crypto import (
    InvalidTag,
    aead_decrypt,
    aead_encrypt,
    derive_key_hkdf,
    derive_key_scrypt,
    generate_key,
    random_nonce,
    random_salt,
    unwrap_key,
    wrap_key,
)


def test_generate_key_is_32_bytes_and_random():
    a, b = generate_key(), generate_key()
    assert len(a) == 32
    assert len(b) == 32
    assert a != b


def test_derive_key_scrypt_deterministic():
    salt = random_salt()
    k1 = derive_key_scrypt(b"correct horse battery staple", salt)
    k2 = derive_key_scrypt(b"correct horse battery staple", salt)
    assert k1 == k2
    assert len(k1) == 32


def test_derive_key_scrypt_different_secret_differs():
    salt = random_salt()
    k1 = derive_key_scrypt(b"password-a", salt)
    k2 = derive_key_scrypt(b"password-b", salt)
    assert k1 != k2


def test_derive_key_hkdf_deterministic():
    salt = random_salt()
    seed = os.urandom(20)
    k1 = derive_key_hkdf(seed, salt, b"file_vault-totp")
    k2 = derive_key_hkdf(seed, salt, b"file_vault-totp")
    assert k1 == k2
    assert len(k1) == 32


def test_derive_key_hkdf_different_info_differs():
    salt = random_salt()
    seed = os.urandom(20)
    k1 = derive_key_hkdf(seed, salt, b"file_vault-totp")
    k2 = derive_key_hkdf(seed, salt, b"file_vault-email")
    assert k1 != k2


def test_aead_round_trip():
    key = generate_key()
    nonce = random_nonce()
    plaintext = b"hello file vault"
    ct = aead_encrypt(key, nonce, plaintext)
    pt = aead_decrypt(key, nonce, ct)
    assert pt == plaintext


def test_aead_wrong_key_raises_invalid_tag():
    key = generate_key()
    wrong_key = generate_key()
    nonce = random_nonce()
    ct = aead_encrypt(key, nonce, b"secret")
    with pytest.raises(InvalidTag):
        aead_decrypt(wrong_key, nonce, ct)


def test_aead_tampered_ciphertext_raises_invalid_tag():
    key = generate_key()
    nonce = random_nonce()
    ct = bytearray(aead_encrypt(key, nonce, b"secret data"))
    ct[0] ^= 0xFF
    with pytest.raises(InvalidTag):
        aead_decrypt(key, nonce, bytes(ct))


def test_wrap_unwrap_key_round_trip():
    kek = generate_key()
    fk = generate_key()
    nonce, wrapped = wrap_key(kek, fk)
    unwrapped = unwrap_key(kek, nonce, wrapped)
    assert unwrapped == fk


def test_unwrap_key_wrong_kek_fails():
    kek = generate_key()
    wrong_kek = generate_key()
    fk = generate_key()
    nonce, wrapped = wrap_key(kek, fk)
    with pytest.raises(InvalidTag):
        unwrap_key(wrong_kek, nonce, wrapped)
