"""口令 keyring 的生命周期：批次收尾（forget）之后还排着队的任务必须失败，
而不是拿被清空的口令去封文件；forget 本身不许被正在跑的慢哈希卡住。"""

import os
import sys
import threading
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import container, crypto

PASSPHRASE = "河边的风 correct horse 42"


@pytest.fixture(autouse=True)
def _fast_kdf(monkeypatch):
    monkeypatch.setattr(crypto, "ARGON2ID_DEFAULTS", {"m": 64, "t": 1, "p": 1})
    monkeypatch.setattr(crypto, "SCRYPT_SHARE_DEFAULTS", {"n": 2**10, "r": 8, "p": 1})


def test_a_forgotten_keyring_refuses_to_seal_and_leaves_the_source_alone(tmp_path):
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    keyring.forget()
    src = tmp_path / "plan.txt"
    src.write_bytes(b"do not seal me under an empty passphrase")
    out = tmp_path / "plan.txt.ivault"
    with pytest.raises(container.InvalidContainerError) as err:
        container.encrypt_file(src, out, None, passphrase=keyring)
    assert err.value.code == "container.passphrase_required"
    assert not out.exists()
    assert src.read_bytes() == b"do not seal me under an empty passphrase"


def test_a_forgotten_keyring_refuses_to_open(tmp_path):
    src = tmp_path / "a.txt"
    src.write_bytes(os.urandom(64))
    out = tmp_path / "a.ivault"
    container.encrypt_file(src, out, None, passphrase=PASSPHRASE)
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    keyring.forget()
    with pytest.raises(container.InvalidContainerError) as err:
        container.decrypt_file(out, tmp_path / "b.txt", None, passphrase=keyring)
    assert err.value.code == "container.passphrase_required"


def test_forget_during_a_derivation_discards_its_result(monkeypatch):
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    real = crypto.derive_passphrase_kek

    def derive_then_forget(*args, **kwargs):
        kek = real(*args, **kwargs)
        keyring.forget()  # 批次在派生途中被收尾
        return kek

    monkeypatch.setattr(crypto, "derive_passphrase_kek", derive_then_forget)
    with pytest.raises(crypto.PassphraseKeyringClosed):
        keyring.seal_key(os.urandom(32))
    assert keyring._opened == {}


def test_forget_does_not_wait_for_a_running_derivation(monkeypatch):
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    started, release = threading.Event(), threading.Event()
    real = crypto.derive_passphrase_kek

    def slow(*args, **kwargs):
        started.set()
        release.wait(5)
        return real(*args, **kwargs)

    monkeypatch.setattr(crypto, "derive_passphrase_kek", slow)
    errors = []
    worker = threading.Thread(target=lambda: _capture(errors, keyring.seal_key, os.urandom(32)))
    worker.start()
    assert started.wait(5)
    t0 = time.monotonic()
    keyring.forget()  # 后端派发线程上调用：必须立刻返回
    assert time.monotonic() - t0 < 0.5
    release.set()
    worker.join(5)
    assert errors and isinstance(errors[0], crypto.PassphraseKeyringClosed)


def test_concurrent_first_seals_derive_once_and_share_one_salt(monkeypatch):
    calls = []
    real = crypto.derive_passphrase_kek

    def counting(*args, **kwargs):
        calls.append(1)
        time.sleep(0.05)
        return real(*args, **kwargs)

    monkeypatch.setattr(crypto, "derive_passphrase_kek", counting)
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    wraps = []
    lock = threading.Lock()

    def seal():
        w = keyring.seal_key(os.urandom(32))
        with lock:
            wraps.append(w)

    threads = [threading.Thread(target=seal) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(wraps) == 8
    assert len(calls) == 1, "eight workers starting a batch together must still derive once"
    assert len({w["salt"] for w in wraps}) == 1


def _capture(errors, fn, *args):
    try:
        fn(*args)
    except Exception as exc:  # noqa: BLE001 - the test inspects what was raised
        errors.append(exc)
