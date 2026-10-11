"""File Key 的后量子（ML-KEM-1024 混合）封装。
失效形态不是崩溃而是"看着开了其实没开"：容器带后量子头、解密正常，攻击者仍可走经典路径，
外部无差别。所以断言多在于"必须不存在什么"，以及错误密钥要被拒绝而非静默产出垃圾。"""
import base64
import json
import os
import struct
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import container, crypto, identity  # noqa: E402

IMK = crypto.generate_key()


@pytest.fixture(scope="module")
def keypair():
    return crypto.generate_pq_keypair()  # (seed, public_key)


def _raw_header(path: Path) -> dict:
    with open(path, "rb") as f:
        (n,) = struct.unpack(">I", f.read(4))
        return json.loads(f.read(n).decode("utf-8"))


# ---------------------------------------------------------------- primitives

def test_encapsulate_decapsulate_agree(keypair):
    seed, public_key = keypair
    shared, kem_ct = crypto.pq_encapsulate(public_key)
    assert len(shared) == crypto.KEY_LEN
    assert len(kem_ct) == crypto.PQ_CIPHERTEXT_LEN
    assert crypto.pq_decapsulate(seed, kem_ct) == shared


def test_public_key_is_recomputable_from_seed(keypair):
    seed, public_key = keypair
    assert crypto.pq_public_key_from_seed(seed) == public_key


def test_hybrid_kek_needs_both_inputs():
    """If either half can be varied without changing the output, the combiner
    isn't combining and the whole construction is decorative."""
    imk, other_imk = crypto.generate_key(), crypto.generate_key()
    ss, other_ss = os.urandom(32), os.urandom(32)
    salt = crypto.random_salt()
    base = crypto.hybrid_kek(imk, ss, salt)
    assert crypto.hybrid_kek(imk, ss, salt) == base          # deterministic
    assert crypto.hybrid_kek(other_imk, ss, salt) != base    # IMK matters
    assert crypto.hybrid_kek(imk, other_ss, salt) != base    # ML-KEM matters
    assert crypto.hybrid_kek(imk, ss, crypto.random_salt()) != base


# ---------------------------------------------------------------- containers

def test_file_round_trip_with_post_quantum_wrap(tmp_path, keypair):
    seed, public_key = keypair
    data = os.urandom(9000)
    src = tmp_path / "doc.bin"
    src.write_bytes(data)
    enc = tmp_path / "doc.ivault"
    container.encrypt_file(src, enc, IMK, cipher="aes-256-gcm", pq_public_key=public_key)

    assert container.read_header(enc, IMK, pq_seed=seed)["post_quantum"] is True
    out = tmp_path / "doc.out"
    container.decrypt_file(enc, out, IMK, pq_seed=seed)
    assert out.read_bytes() == data


def test_folder_round_trip_with_post_quantum_wrap(tmp_path, keypair):
    """需求是「加密文件（多选）」和「加密整个文件夹」都能用；
    文件夹走另一个写入器（_ChunkingEncryptWriter），证明一个不代表另一个。"""
    seed, public_key = keypair
    tree = tmp_path / "tree"
    (tree / "sub").mkdir(parents=True)
    (tree / "a.bin").write_bytes(os.urandom(2048))
    (tree / "sub" / "b.bin").write_bytes(os.urandom(4096))
    enc = tmp_path / "tree.ivault"
    container.encrypt_folder(tree, enc, IMK, cipher="aes-256-gcm", pq_public_key=public_key)

    assert container.header_is_post_quantum(_raw_header(enc))
    preview = container.decrypt_folder_to_temp(enc, IMK, pq_seed=seed)
    try:
        names = sorted(e["name"] for e in preview["entries"])
        assert names == ["a.bin", "sub/b.bin"]
    finally:
        container.discard_folder_temp(Path(preview["temp_zip_path"]))


def test_hybrid_container_does_not_also_carry_the_classical_wrap(tmp_path, keypair):
    """最致命的错误：在 `fk_wrap_pq` 之外还输出 `fk_wrap`。
    攻击者直接走经典路径，ML-KEM 层形同虚设，而文件仍能解密，往返测试发现不了。"""
    _seed, public_key = keypair
    src = tmp_path / "doc.bin"
    src.write_bytes(os.urandom(512))
    enc = tmp_path / "doc.ivault"
    container.encrypt_file(src, enc, IMK, pq_public_key=public_key)

    header = _raw_header(enc)
    assert "fk_wrap_pq" in header
    assert "fk_wrap" not in header, "classical wrap must not survive alongside the hybrid one"
    assert header["fk_wrap_pq"]["kem"] == crypto.PQ_KEM
    assert len(base64.b64decode(header["fk_wrap_pq"]["kem_ct"])) == crypto.PQ_CIPHERTEXT_LEN


def test_wrong_pq_seed_is_rejected_not_silently_wrong(tmp_path, keypair):
    """ML-KEM 解封装从不报失败，错误密钥只得到隐式拒绝的密钥；
    所以错误必须在 AEAD 解包处抛出，不能是 32 个看似正常的字节。"""
    _seed, public_key = keypair
    src = tmp_path / "doc.bin"
    src.write_bytes(os.urandom(512))
    enc = tmp_path / "doc.ivault"
    container.encrypt_file(src, enc, IMK, pq_public_key=public_key)

    other_seed, _ = crypto.generate_pq_keypair()
    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(enc, tmp_path / "out", IMK, pq_seed=other_seed)
    assert exc.value.code == "container.key_mismatch"


def test_missing_pq_seed_reports_which_thing_is_missing(tmp_path, keypair):
    _seed, public_key = keypair
    src = tmp_path / "doc.bin"
    src.write_bytes(os.urandom(512))
    enc = tmp_path / "doc.ivault"
    container.encrypt_file(src, enc, IMK, pq_public_key=public_key)

    with pytest.raises(container.InvalidContainerError) as exc:
        container.decrypt_file(enc, tmp_path / "out", IMK)
    assert exc.value.code == "container.pq_key_missing"


def test_classical_containers_are_untouched(tmp_path):
    """Existing vaults must keep working with no seed anywhere in sight."""
    src = tmp_path / "doc.bin"
    data = os.urandom(4096)
    src.write_bytes(data)
    enc = tmp_path / "doc.ivault"
    container.encrypt_file(src, enc, IMK)

    header = _raw_header(enc)
    assert "fk_wrap" in header and "fk_wrap_pq" not in header
    out = tmp_path / "doc.out"
    container.decrypt_file(enc, out, IMK)
    assert out.read_bytes() == data


def test_wrong_size_public_key_is_refused(tmp_path):
    src = tmp_path / "doc.bin"
    src.write_bytes(b"x")
    with pytest.raises(container.InvalidContainerError) as exc:
        container.encrypt_file(src, tmp_path / "doc.ivault", IMK, pq_public_key=b"too short")
    assert exc.value.code == "container.invalid_pq_key"
    assert not (tmp_path / "doc.ivault").exists()


# ---------------------------------------------------------------- identity

def test_identity_keypair_persists_and_reopens(tmp_path):
    store = identity.IdentityStore(email_address=None, slots={})
    seed, public_key = identity.ensure_pq_keypair(tmp_path, store, IMK)
    assert crypto.pq_public_key_from_seed(seed) == public_key

    # Same identity asked twice must return the SAME key - regenerating would
    # orphan every container already written against the old public key.
    again = identity.ensure_pq_keypair(tmp_path, store, IMK)
    assert again == (seed, public_key)

    reloaded = identity.load_identity_store(tmp_path)
    assert identity.load_pq_keypair(reloaded, IMK) == (seed, public_key)


def test_identity_keypair_seed_is_not_stored_in_the_clear(tmp_path):
    store = identity.IdentityStore(email_address=None, slots={})
    seed, _public_key = identity.ensure_pq_keypair(tmp_path, store, IMK)
    raw = identity.identity_path(tmp_path).read_bytes()
    assert base64.b64encode(seed) not in raw
    assert seed not in raw


def test_identity_without_keypair_reports_none(tmp_path):
    store = identity.IdentityStore(email_address=None, slots={})
    assert identity.load_pq_keypair(store, IMK) is None


def test_wrong_imk_cannot_open_the_keypair(tmp_path):
    store = identity.IdentityStore(email_address=None, slots={})
    identity.ensure_pq_keypair(tmp_path, store, IMK)
    with pytest.raises(identity.UnlockError):
        identity.load_pq_keypair(store, crypto.generate_key())
