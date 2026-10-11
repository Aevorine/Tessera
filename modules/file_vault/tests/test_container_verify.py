"""只校验不落盘（container.verify_container）：篡改是结论（intact=False + 哪一块）而非异常，
只有根本无法校验才抛；全程不产生明文文件。"""

import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import container, crypto

IMK = crypto.generate_key()


@pytest.fixture
def small_chunks(monkeypatch):
    monkeypatch.setattr(container, "CHUNK_SIZE", 64)


def _file_container(tmp_path, data: bytes, **kw) -> Path:
    src = tmp_path / "doc.bin"
    src.write_bytes(data)
    out = tmp_path / "doc.ivault"
    container.encrypt_file(src, out, IMK, **kw)
    src.unlink()
    return out


def _chunk_offsets(path: Path) -> list:
    """(offset_of_length_prefix, ciphertext_len) for every chunk."""
    raw = path.read_bytes()
    (hlen,) = container._HEADER_LEN_STRUCT.unpack(raw[:4])
    pos = 4 + hlen
    out = []
    while pos < len(raw):
        (n,) = container._CHUNK_LEN_STRUCT.unpack(raw[pos:pos + 4])
        out.append((pos, n))
        pos += 4 + n
    return out


def _snapshot(tmp_path: Path) -> set:
    return {p for p in tmp_path.rglob("*")}


def test_intact_file_container_reports_every_chunk(tmp_path, small_chunks):
    out = _file_container(tmp_path, os.urandom(500))
    before = _snapshot(tmp_path)
    progress = []
    result = container.verify_container(out, IMK, on_progress=lambda d, t: progress.append((d, t)))
    assert result["intact"] is True and result["failure"] is None
    assert result["chunks_checked"] == result["chunks_expected"] == 8
    assert result["bytes_checked"] == result["plaintext_size"] == 500
    assert result["kind"] == "file" and result["original_filename"] == "doc.bin"
    assert result["wrap"] == "identity"
    assert progress[-1] == (8, 8)
    assert _snapshot(tmp_path) == before, "verification must not write anything"


def test_flipped_byte_names_the_chunk(tmp_path, small_chunks):
    out = _file_container(tmp_path, os.urandom(500))
    offsets = _chunk_offsets(out)
    raw = bytearray(out.read_bytes())
    pos, _ = offsets[5]
    raw[pos + 4 + 10] ^= 0x01
    out.write_bytes(bytes(raw))
    result = container.verify_container(out, IMK)
    assert result["intact"] is False
    assert result["failure"] == "chunk" and result["failed_chunk"] == 5
    assert result["chunks_checked"] == 5


def test_swapped_chunks_are_caught(tmp_path, small_chunks):
    out = _file_container(tmp_path, os.urandom(64 * 4))
    offsets = _chunk_offsets(out)
    raw = out.read_bytes()
    (a, n), (b, _) = offsets[1], offsets[2]
    body = raw[:a] + raw[b:b + 4 + n] + raw[a:a + 4 + n] + raw[b + 4 + n:]
    out.write_bytes(body)
    result = container.verify_container(out, IMK)
    assert result["failure"] == "chunk" and result["failed_chunk"] == 1


def test_dropped_final_chunk_is_truncation(tmp_path, small_chunks):
    out = _file_container(tmp_path, os.urandom(300))
    last, _ = _chunk_offsets(out)[-1]
    out.write_bytes(out.read_bytes()[:last])
    result = container.verify_container(out, IMK)
    assert result["failure"] == "truncated"
    assert result["failed_chunk"] == result["chunks_expected"] - 1


def test_cut_mid_chunk_is_truncation(tmp_path, small_chunks):
    out = _file_container(tmp_path, os.urandom(300))
    out.write_bytes(out.read_bytes()[:-7])
    assert container.verify_container(out, IMK)["failure"] == "truncated"


def test_appended_chunk_is_trailing_data(tmp_path, small_chunks):
    out = _file_container(tmp_path, os.urandom(128))
    pos, n = _chunk_offsets(out)[0]
    raw = out.read_bytes()
    out.write_bytes(raw + raw[pos:pos + 4 + n])
    result = container.verify_container(out, IMK)
    assert result["failure"] == "trailing_data" and result["failed_chunk"] == 2


def test_tampered_metadata_is_reported_not_raised(tmp_path):
    out = _file_container(tmp_path, b"hello")
    raw = bytearray(out.read_bytes())
    marker = raw.find(b'"meta": "') + len(b'"meta": "')
    raw[marker + 3] = ord("A") if raw[marker + 3] != ord("A") else ord("B")
    out.write_bytes(bytes(raw))
    result = container.verify_container(out, IMK)
    assert result["intact"] is False and result["failure"] == "metadata"


def test_empty_file_container_is_intact(tmp_path):
    out = _file_container(tmp_path, b"")
    result = container.verify_container(out, IMK)
    assert result["intact"] is True and result["chunks_expected"] == 0


def test_wrong_key_raises_instead_of_claiming_tampering(tmp_path):
    out = _file_container(tmp_path, b"data")
    with pytest.raises(container.InvalidContainerError) as exc:
        container.verify_container(out, crypto.generate_key())
    assert exc.value.code == "container.key_mismatch"


def test_folder_container_verifies_and_counts_entries(tmp_path, small_chunks):
    src = tmp_path / "proj"
    (src / "empty").mkdir(parents=True)
    (src / "a.txt").write_bytes(os.urandom(300))
    (src / "b.txt").write_bytes(b"b")
    out = tmp_path / "proj.ivault"
    container.encrypt_folder(src, out, IMK)
    result = container.verify_container(out, IMK)
    assert result["intact"] is True and result["kind"] == "folder"
    assert result["file_count"] == 2 and result["entry_count"] == 3

    pos, _ = _chunk_offsets(out)[2]
    raw = bytearray(out.read_bytes())
    raw[pos + 6] ^= 0x80
    out.write_bytes(bytes(raw))
    bad = container.verify_container(out, IMK)
    assert bad["failure"] == "chunk" and bad["failed_chunk"] == 2


def test_passphrase_and_post_quantum_containers_verify(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto, "ARGON2ID_DEFAULTS", {"m": 64, "t": 1, "p": 1})
    shared = _file_container(tmp_path, os.urandom(1000), passphrase="shared passphrase")
    with pytest.raises(container.InvalidContainerError) as exc:
        container.verify_container(shared, IMK)
    assert exc.value.code == "container.passphrase_required"
    result = container.verify_container(shared, None, passphrase="shared passphrase")
    assert result["intact"] and result["wrap"] == "passphrase"

    seed, public = crypto.generate_pq_keypair()
    (tmp_path / "pq").mkdir()
    pq = _file_container(tmp_path / "pq", os.urandom(1000), pq_public_key=public)
    result = container.verify_container(pq, IMK, pq_seed=seed)
    assert result["intact"] and result["wrap"] == "post_quantum"


def test_every_cipher_verifies(tmp_path):
    for cipher in ("aes-256-gcm", "chacha20-poly1305"):
        d = tmp_path / cipher
        d.mkdir()
        out = _file_container(d, os.urandom(2000), cipher=cipher)
        result = container.verify_container(out, IMK)
        assert result["intact"] and result["cipher"] == cipher
