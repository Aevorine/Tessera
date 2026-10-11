"""口令封装的分享容器（fk_wrap_pw）：另一个金库（不同 IMK）只凭口令能打开；口令错有专门错误码；
头部只有一种封装；参数写在头部且读取时有上限；旧容器读路径不受影响。"""

import base64
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import container, crypto

PASSPHRASE = "河边的风 correct horse 42"

# 真实默认参数（256 MiB）每次派生约 0.35 s；测试里换成最小合法参数，只验证逻辑。
# 默认参数本身由 test_default_kdf_parameters_are_recorded 单独钉住。
FAST_ARGON2 = {"m": 64, "t": 1, "p": 1}


@pytest.fixture(autouse=True)
def _fast_kdf(monkeypatch):
    monkeypatch.setattr(crypto, "ARGON2ID_DEFAULTS", dict(FAST_ARGON2))
    monkeypatch.setattr(crypto, "SCRYPT_SHARE_DEFAULTS", {"n": 2**10, "r": 8, "p": 1})


def _read_raw(path: Path) -> dict:
    with open(path, "rb") as f:
        return container._read_raw_header(f)


def _rewrite_header(path: Path, mutate) -> None:
    raw = path.read_bytes()
    (hlen,) = container._HEADER_LEN_STRUCT.unpack(raw[:4])
    header = json.loads(raw[4:4 + hlen])
    mutate(header)
    new = json.dumps(header).encode()
    path.write_bytes(container._HEADER_LEN_STRUCT.pack(len(new)) + new + raw[4 + hlen:])


def _share_file(tmp_path, data=b"shared secret payload" * 1000, passphrase=PASSPHRASE, **kw):
    src = tmp_path / "plan.txt"
    src.write_bytes(data)
    out = tmp_path / "plan.txt.ivault"
    container.encrypt_file(src, out, crypto.generate_key(), passphrase=passphrase, **kw)
    return src, out


def test_another_vault_opens_it_with_the_passphrase_alone(tmp_path):
    src, out = _share_file(tmp_path)
    other_vault_imk = crypto.generate_key()  # 收件人的金库：完全不同的身份
    dest = tmp_path / "received.txt"
    container.decrypt_file(out, dest, other_vault_imk, passphrase=PASSPHRASE)
    assert dest.read_bytes() == src.read_bytes()
    # 连 IMK 都不给也行——口令容器根本不用它
    dest2 = tmp_path / "received2.txt"
    container.decrypt_file(out, dest2, None, passphrase=PASSPHRASE)
    assert dest2.read_bytes() == src.read_bytes()


def test_header_carries_only_the_passphrase_wrap_with_its_parameters(tmp_path):
    _, out = _share_file(tmp_path)
    header = _read_raw(out)
    assert "fk_wrap_pw" in header
    assert "fk_wrap" not in header and "fk_wrap_pq" not in header
    wrap = header["fk_wrap_pw"]
    assert set(wrap) == {"kdf", "params", "salt", "nonce", "wrapped_fk"}
    assert wrap["kdf"] == crypto.KDF_ARGON2ID
    assert wrap["params"] == FAST_ARGON2
    assert len(base64.b64decode(wrap["salt"])) == crypto.SALT_LEN


def test_default_kdf_parameters_are_recorded(monkeypatch):
    monkeypatch.undo()  # 真实默认值
    kdf, params = crypto.default_passphrase_kdf()
    assert kdf == crypto.KDF_ARGON2ID, "cryptography>=49 ships Argon2id; scrypt is only a runtime fallback"
    assert params == {"m": 256 * 1024, "t": 3, "p": 4}


def test_wrong_passphrase_has_its_own_error_code(tmp_path):
    _, out = _share_file(tmp_path)
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", crypto.generate_key(), passphrase="not it at all")
    assert exc.value.code == "container.wrong_passphrase"
    assert not (tmp_path / "x").exists()


def test_missing_passphrase_asks_for_one_instead_of_key_mismatch(tmp_path):
    _, out = _share_file(tmp_path)
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", crypto.generate_key())
    assert exc.value.code == "container.passphrase_required"


def test_read_header_reports_passphrase_protection_without_failing(tmp_path):
    _, out = _share_file(tmp_path)
    locked = container.read_header(out, crypto.generate_key())
    assert locked["passphrase_protected"] is True
    assert locked["metadata_locked"] is True
    assert "original_filename" not in locked
    assert "meta" not in locked

    opened = container.read_header(out, crypto.generate_key(), passphrase=PASSPHRASE)
    assert opened["passphrase_protected"] is True
    assert opened["original_filename"] == "plan.txt"
    assert opened["kind"] == container.KIND_FILE
    # 解锁前（没有 IMK）同样认得出来
    assert container.read_header(out)["passphrase_protected"] is True


def test_passphrase_is_unicode_normalised(tmp_path):
    decomposed = "café passphrase"  # e + 组合重音
    composed = "café passphrase"
    _, out = _share_file(tmp_path, passphrase=decomposed)
    dest = tmp_path / "out.txt"
    container.decrypt_file(out, dest, None, passphrase=composed)
    assert dest.exists()


def test_folder_round_trip_through_the_passphrase(tmp_path):
    src = tmp_path / "album"
    (src / "sub").mkdir(parents=True)
    (src / "a.txt").write_bytes(b"alpha")
    (src / "sub" / "b.bin").write_bytes(os.urandom(5000))
    out = tmp_path / "album.ivault"
    container.encrypt_folder(src, out, crypto.generate_key(), passphrase=PASSPHRASE)

    listing = container.list_folder_container(out, crypto.generate_key(), passphrase=PASSPHRASE)
    assert {e["name"] for e in listing["entries"]} == {"a.txt", "sub/b.bin"}

    dest = tmp_path / "restored"
    container.extract_folder_container(out, dest, None, passphrase=PASSPHRASE)
    assert (dest / "sub" / "b.bin").read_bytes() == (src / "sub" / "b.bin").read_bytes()

    with pytest.raises(container.InvalidContainerError) as exc:
        container.list_folder_container(out, crypto.generate_key(), passphrase="wrong wrong")
    assert exc.value.code == "container.wrong_passphrase"


def test_one_keyring_derives_once_per_batch(tmp_path, monkeypatch):
    calls = []
    real = crypto.derive_passphrase_kek

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(crypto, "derive_passphrase_kek", counting)
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    outs = []
    for i in range(4):
        src = tmp_path / f"f{i}.txt"
        src.write_bytes(os.urandom(100))
        out = tmp_path / f"f{i}.ivault"
        container.encrypt_file(src, out, None, passphrase=keyring)
        outs.append(out)
    assert len(calls) == 1, "sealing a batch must run the slow KDF once, not once per file"

    opener = crypto.PassphraseKeyring(PASSPHRASE)
    for i, out in enumerate(outs):
        container.decrypt_file(out, tmp_path / f"d{i}.txt", None, passphrase=opener)
    assert len(calls) == 2, "opening a batch sealed together must also derive once"
    # 同一批共用 salt，但每个 FK 的封装 nonce 各不相同
    wraps = [_read_raw(o)["fk_wrap_pw"] for o in outs]
    assert len({w["salt"] for w in wraps}) == 1
    assert len({w["nonce"] for w in wraps}) == 4


def test_passphrase_and_post_quantum_are_mutually_exclusive(tmp_path):
    _, public = crypto.generate_pq_keypair()
    src = tmp_path / "a.txt"
    src.write_bytes(b"x")
    with pytest.raises(ValueError):
        container.encrypt_file(src, tmp_path / "a.ivault", crypto.generate_key(), pq_public_key=public,
                               passphrase=PASSPHRASE)
    assert not (tmp_path / "a.ivault").exists()


def test_a_second_wrap_smuggled_into_the_header_is_rejected(tmp_path):
    _, out = _share_file(tmp_path)
    imk = crypto.generate_key()
    nonce, wrapped = crypto.wrap_key(imk, os.urandom(32))
    _rewrite_header(out, lambda h: h.update(fk_wrap={
        "nonce": base64.b64encode(nonce).decode(), "wrapped_fk": base64.b64encode(wrapped).decode(),
    }))
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", imk, passphrase=PASSPHRASE)
    assert exc.value.code == "container.invalid_header"


@pytest.mark.parametrize("params", [
    {"m": 64 * 1024 * 1024, "t": 3, "p": 4},  # 64 GiB：会把进程撑爆的恶意头部
    {"m": 64, "t": 1000, "p": 1},
    {"m": 64, "t": 1, "p": 1, "extra": 1},
    {"m": 64, "t": True, "p": 1},
    {"m": "64", "t": 1, "p": 1},
])
def test_out_of_range_kdf_parameters_are_refused_before_deriving(tmp_path, params):
    _, out = _share_file(tmp_path)
    _rewrite_header(out, lambda h: h["fk_wrap_pw"].update(params=params))
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", None, passphrase=PASSPHRASE)
    assert exc.value.code == "container.invalid_kdf_params"


def test_lowered_kdf_cost_in_a_tampered_header_does_not_open(tmp_path):
    _, out = _share_file(tmp_path)
    _rewrite_header(out, lambda h: h["fk_wrap_pw"].update(params={"m": 32, "t": 1, "p": 1}))
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", None, passphrase=PASSPHRASE)
    assert exc.value.code == "container.wrong_passphrase"


def test_unknown_kdf_is_reported_as_unsupported(tmp_path):
    _, out = _share_file(tmp_path)
    _rewrite_header(out, lambda h: h["fk_wrap_pw"].update(kdf="balloon"))
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", None, passphrase=PASSPHRASE)
    assert exc.value.code == "container.unsupported_kdf"


def test_scrypt_fallback_when_argon2id_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto, "argon2id_available", lambda: False)
    _, out = _share_file(tmp_path)
    assert _read_raw(out)["fk_wrap_pw"]["kdf"] == crypto.KDF_SCRYPT
    dest = tmp_path / "o.txt"
    container.decrypt_file(out, dest, None, passphrase=PASSPHRASE)
    assert dest.exists()


def test_argon2id_container_on_a_runtime_without_argon2id(tmp_path, monkeypatch):
    _, out = _share_file(tmp_path)
    monkeypatch.setattr(crypto, "argon2id_available", lambda: False)
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(out, tmp_path / "x", None, passphrase=PASSPHRASE)
    assert exc.value.code == "container.unsupported_kdf"


def test_identity_containers_ignore_a_supplied_passphrase(tmp_path):
    imk = crypto.generate_key()
    src = tmp_path / "own.txt"
    src.write_bytes(b"mine")
    out = tmp_path / "own.ivault"
    container.encrypt_file(src, out, imk)
    dest = tmp_path / "own.out"
    container.decrypt_file(out, dest, imk, passphrase="irrelevant passphrase")
    assert dest.read_bytes() == b"mine"
    assert container.read_header(out, imk)["passphrase_protected"] is False


def test_keyring_never_exposes_the_passphrase_in_its_repr_or_errors(tmp_path):
    keyring = crypto.PassphraseKeyring(PASSPHRASE)
    assert PASSPHRASE not in repr(keyring)
    _, out = _share_file(tmp_path)
    try:
        container.decrypt_file(out, tmp_path / "x", None, passphrase="a wrong passphrase")
    except container.InvalidContainerError as exc:
        assert "a wrong passphrase" not in str(exc) and "a wrong passphrase" not in repr(exc.params)


# RPC 端到端：两个真实后端子进程、两套身份（A 用口令封装，B 是另一个金库、只凭口令打开）；
# 分享的承诺必须用真进程验证，而不是同进程里换 IMK。


def _unlocked_client(data_dir: Path, password: str):
    from modules.file_vault.tests.test_backend_server import BackendClient

    client = BackendClient(data_dir)
    client.call("setup_complete", {
        "password": password,
        "totp_seed": "JBSWY3DPEHPK3PXP",
        "email_address": None,
        "recovery_key": "AAAA-BBBB-CCCC-DDDD",
    })
    result, _, error = client.call("unlock_password", {"password": password})
    assert error is None and result["ok"] is True
    return client


def test_rpc_share_between_two_different_vaults(tmp_path):
    sender = _unlocked_client(tmp_path / "vault_a", "sender-password-123")
    receiver = _unlocked_client(tmp_path / "vault_b", "receiver-password-456")
    try:
        src = tmp_path / "report.txt"
        src.write_text("季度报告 quarterly", encoding="utf-8")
        sealed = tmp_path / "report.txt.ivault"

        result, _, error = sender.call("share_encrypt_file", {
            "input_path": str(src), "output_path": str(sealed), "passphrase": "short",
        })
        assert error is None and result == {
            "ok": False, "error": "container.passphrase_too_short", "error_params": {"min": 8},
        }

        result, _, error = sender.call("share_encrypt_file", {
            "input_path": str(src), "output_path": str(sealed), "passphrase": PASSPHRASE,
            "share_session": "s1",
        })
        assert error is None and result["ok"] is True and result["container_size"] > 0
        sender.call("share_session_end", {"share_session": "s1"})

        # 收件人的普通 read_header 认得出"要口令"，而不是报错
        result, _, error = receiver.call("read_header", {"input_path": str(sealed)})
        assert error is None and result["ok"] is True
        assert result["header"]["passphrase_protected"] is True

        result, _, _ = receiver.call("share_read_headers", {
            "paths": [str(sealed)], "passphrase": "wrong passphrase!", "share_session": "r1",
        })
        assert result["ok"] is True
        assert result["results"][0]["ok"] is False
        assert result["results"][0]["error"] == "container.wrong_passphrase"

        result, _, _ = receiver.call("share_read_headers", {
            "paths": [str(sealed)], "passphrase": PASSPHRASE, "share_session": "r1",
        })
        entry = result["results"][0]
        assert entry["ok"] is True and entry["header"]["original_filename"] == "report.txt"

        result, _, _ = receiver.call("verify_container", {
            "input_path": str(sealed), "passphrase": PASSPHRASE, "share_session": "r1",
        })
        assert result["ok"] is True and result["intact"] is True and result["wrap"] == "passphrase"

        out = tmp_path / "received.txt"
        result, _, error = receiver.call("share_decrypt_file", {
            "input_path": str(sealed), "output_path": str(out), "passphrase": PASSPHRASE,
            "share_session": "r1",
        })
        assert error is None and result["ok"] is True
        assert out.read_text(encoding="utf-8") == "季度报告 quarterly"

        # 没有口令时走普通 decrypt_file：明确说"要口令"
        result, _, _ = receiver.call("decrypt_file", {
            "input_path": str(sealed), "output_path": str(tmp_path / "x.txt"),
        })
        assert result["ok"] is False and result["error"] == "container.passphrase_required"

        result, _, _ = receiver.call("files_path_sizes", {"paths": [str(out), str(tmp_path)]})
        assert result["sizes"][str(out)] == out.stat().st_size
        assert result["sizes"][str(tmp_path)] is None
    finally:
        sender.close()
        receiver.close()
