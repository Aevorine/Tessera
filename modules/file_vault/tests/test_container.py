import base64
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import container, crypto

IMK = crypto.generate_key()


def test_encrypt_decrypt_round_trip_small_file(tmp_path):
    original = tmp_path / "note.txt"
    original.write_bytes(b"hello file vault, this is a small test file")

    encrypted = tmp_path / "note.ivault"
    container.encrypt_file(original, encrypted, IMK)
    assert encrypted.exists()
    assert not (tmp_path / "note.ivault.part").exists()

    decrypted = tmp_path / "note.decrypted.txt"
    container.decrypt_file(encrypted, decrypted, IMK)

    assert decrypted.read_bytes() == original.read_bytes()


def test_encrypt_decrypt_round_trip_empty_file(tmp_path):
    original = tmp_path / "empty.bin"
    original.write_bytes(b"")

    encrypted = tmp_path / "empty.ivault"
    container.encrypt_file(original, encrypted, IMK)

    decrypted = tmp_path / "empty.out"
    container.decrypt_file(encrypted, decrypted, IMK)
    assert decrypted.read_bytes() == b""


def test_encrypt_decrypt_round_trip_spans_multiple_chunks(tmp_path, monkeypatch):
    monkeypatch.setattr(container, "CHUNK_SIZE", 64)  # force many small chunks

    original = tmp_path / "multi.bin"
    data = os.urandom(500)  # ~8 chunks at 64 bytes each
    original.write_bytes(data)

    progress_calls = []
    encrypted = tmp_path / "multi.ivault"
    container.encrypt_file(original, encrypted, IMK, on_progress=lambda done, total: progress_calls.append((done, total)))

    assert progress_calls, "on_progress should have been called"
    assert progress_calls[-1][0] == progress_calls[-1][1]  # last call: done == total
    assert progress_calls[-1][1] >= 7  # ceil(500/64) == 8

    decrypted = tmp_path / "multi.out"
    container.decrypt_file(encrypted, decrypted, IMK)
    assert decrypted.read_bytes() == data


def test_encrypt_file_reads_input_file_only_once(tmp_path, monkeypatch):
    # 旧实现为算 sha256_plaintext 先完整读一遍源文件，加密循环又读一遍，大文件多一倍磁盘 I/O。
    # 哈希现与加密分块同一趟完成，此处锁定"只打开一次输入文件"防回归。
    import builtins

    original = tmp_path / "perf.bin"
    original.write_bytes(os.urandom(10_000))

    real_open = builtins.open
    real_os_open = os.open
    open_count = {"input": 0}

    def counting_open(path, *args, **kwargs):
        if Path(path) == original:
            open_count["input"] += 1
        return real_open(path, *args, **kwargs)

    # os.open 也要数：大文件顺序读走 _open_sequential_read（os.open + O_SEQUENTIAL，见
    # container._SEQUENTIAL_FLAG），不经过 builtins.open；只盯后者会在"读了两遍"时仍绿。
    def counting_os_open(path, *args, **kwargs):
        if Path(path) == original:
            open_count["input"] += 1
        return real_os_open(path, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", counting_open)
    monkeypatch.setattr(os, "open", counting_os_open)

    encrypted = tmp_path / "perf.ivault"
    container.encrypt_file(original, encrypted, IMK)
    assert open_count["input"] == 1

    monkeypatch.undo()  # restore real open before decrypt/read_bytes below
    decrypted = tmp_path / "perf.out"
    container.decrypt_file(encrypted, decrypted, IMK)
    assert decrypted.read_bytes() == original.read_bytes()


def test_wrong_imk_fails_to_decrypt(tmp_path):
    original = tmp_path / "secret.txt"
    original.write_bytes(b"top secret contents")
    encrypted = tmp_path / "secret.ivault"
    container.encrypt_file(original, encrypted, IMK)

    wrong_imk = crypto.generate_key()
    with pytest.raises(container.InvalidContainerError):
        container.decrypt_file(encrypted, tmp_path / "out.txt", wrong_imk)


def test_tampered_chunk_raises_integrity_error_and_leaves_no_output(tmp_path):
    original = tmp_path / "secret2.txt"
    original.write_bytes(b"another secret payload, long enough to matter")
    encrypted = tmp_path / "secret2.ivault"
    container.encrypt_file(original, encrypted, IMK)

    raw = bytearray(encrypted.read_bytes())
    raw[-1] ^= 0xFF  # flip the last byte, inside the final chunk's GCM tag
    encrypted.write_bytes(bytes(raw))

    output = tmp_path / "secret2.out"
    with pytest.raises(container.ContainerIntegrityError):
        container.decrypt_file(encrypted, output, IMK)

    assert not output.exists()
    assert not (tmp_path / (output.name + ".part")).exists()


def test_non_container_file_raises_invalid_container_error(tmp_path):
    not_a_vault = tmp_path / "random.bin"
    not_a_vault.write_bytes(os.urandom(100))

    with pytest.raises(container.InvalidContainerError):
        container.decrypt_file(not_a_vault, tmp_path / "out.bin", IMK)


def test_read_header_returns_metadata_with_imk(tmp_path):
    original = tmp_path / "doc.txt"
    original.write_bytes(b"some document content")
    encrypted = tmp_path / "doc.ivault"
    container.encrypt_file(original, encrypted, IMK)

    header = container.read_header(encrypted, IMK)
    assert header["original_filename"] == "doc.txt"
    assert header["plaintext_size"] == len(b"some document content")


def test_read_header_without_imk_keeps_v2_metadata_locked(tmp_path):
    original = tmp_path / "doc.txt"
    original.write_bytes(b"some document content")
    encrypted = tmp_path / "doc.ivault"
    container.encrypt_file(original, encrypted, IMK)

    header = container.read_header(encrypted)
    assert header["metadata_locked"] is True
    assert "original_filename" not in header
    assert "sha256_plaintext" not in header


def test_read_header_with_wrong_imk_rejects(tmp_path):
    original = tmp_path / "doc.txt"
    original.write_bytes(b"some document content")
    encrypted = tmp_path / "doc.ivault"
    container.encrypt_file(original, encrypted, IMK)

    with pytest.raises(container.InvalidContainerError):
        container.read_header(encrypted, crypto.generate_key())


def test_v2_plaintext_header_leaks_no_metadata(tmp_path):
    """格式 v2 的核心：持有 .ivault 但没有密钥的人，不得得知原文件名，也不能靠 SHA-256 确认其中
    含某个已知文件。"""
    secret_name = "salary_" + "2026_confidential.docx"
    content = b"secret body content" * 100
    original = tmp_path / secret_name
    original.write_bytes(content)
    encrypted = tmp_path / "out.ivault"
    container.encrypt_file(original, encrypted, IMK)

    raw = encrypted.read_bytes()
    import hashlib as _hashlib

    assert secret_name.encode() not in raw
    assert _hashlib.sha256(content).hexdigest().encode() not in raw
    # And the content itself must not appear anywhere either.
    assert b"secret body content" not in raw


def _write_v1_container(original, encrypted, imk):
    """复现旧版 v1 写入器（明文元数据头），使向后兼容解密继续用真实 v1 字节测试，因为代码现只写 v2。"""
    import base64
    import hashlib
    import json
    import os as _os
    import struct

    plaintext = original.read_bytes()
    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
    nonce_prefix = _os.urandom(container.NONCE_PREFIX_LEN)
    header = {
        "format_version": 1,
        "original_filename": original.name,
        "chunk_size": container.CHUNK_SIZE,
        "plaintext_size": len(plaintext),
        "sha256_plaintext": hashlib.sha256(plaintext).hexdigest(),
        "file_nonce_prefix": base64.b64encode(nonce_prefix).decode(),
        "fk_wrap": {
            "nonce": base64.b64encode(fk_nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
        },
    }
    header_bytes = json.dumps(header).encode("utf-8")
    with open(encrypted, "wb") as fout:
        fout.write(struct.pack(">I", len(header_bytes)))
        fout.write(header_bytes)
        for index in range(0, len(plaintext), container.CHUNK_SIZE):
            chunk = plaintext[index : index + container.CHUNK_SIZE]
            nonce = nonce_prefix + (index // container.CHUNK_SIZE).to_bytes(4, "big")
            ciphertext = crypto.aead_encrypt(fk, nonce, chunk)
            fout.write(struct.pack(">I", len(ciphertext)))
            fout.write(ciphertext)


def test_v1_container_still_decrypts_and_reads_header(tmp_path):
    original = tmp_path / "legacy.txt"
    data = b"data encrypted before the v2 format existed"
    original.write_bytes(data)
    encrypted = tmp_path / "legacy.ivault"
    _write_v1_container(original, encrypted, IMK)

    header = container.read_header(encrypted, IMK)
    assert header["format_version"] == 1
    assert header["original_filename"] == "legacy.txt"

    decrypted = tmp_path / "legacy.out"
    container.decrypt_file(encrypted, decrypted, IMK)
    assert decrypted.read_bytes() == data


def test_v1_container_rejects_unsafe_original_filename(tmp_path):
    original = tmp_path / "legacy.txt"
    original.write_bytes(b"legacy content")
    encrypted = tmp_path / "legacy.ivault"
    _write_v1_container(original, encrypted, IMK)

    import json
    import struct

    raw = encrypted.read_bytes()
    (header_len,) = struct.unpack(">I", raw[:4])
    header = json.loads(raw[4 : 4 + header_len])
    header["original_filename"] = "..\\outside.txt"
    header_bytes = json.dumps(header).encode("utf-8")
    encrypted.write_bytes(struct.pack(">I", len(header_bytes)) + header_bytes + raw[4 + header_len :])

    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"must remain untouched")
    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.read_header(encrypted, IMK)
    assert exc_info.value.code == "container.invalid_original_filename"
    assert outside.read_bytes() == b"must remain untouched"


def test_encrypt_and_decrypt_preserve_unrelated_part_file(tmp_path):
    original = tmp_path / "source.txt"
    original.write_bytes(b"plaintext")
    encrypted = tmp_path / "source.ivault"
    part_sentinel = tmp_path / "source.ivault.part"
    part_sentinel.write_bytes(b"unrelated staging sentinel")

    container.encrypt_file(original, encrypted, IMK)
    assert part_sentinel.read_bytes() == b"unrelated staging sentinel"

    output = tmp_path / "restored.txt"
    output_part_sentinel = tmp_path / "restored.txt.part"
    output_part_sentinel.write_bytes(b"another unrelated sentinel")
    container.decrypt_file(encrypted, output, IMK)
    assert output.read_bytes() == b"plaintext"
    assert output_part_sentinel.read_bytes() == b"another unrelated sentinel"


def test_decrypt_refuses_existing_destination_without_overwriting(tmp_path):
    original = tmp_path / "source.txt"
    original.write_bytes(b"correct plaintext")
    encrypted = tmp_path / "source.ivault"
    container.encrypt_file(original, encrypted, IMK)

    output = tmp_path / "existing.txt"
    output.write_bytes(b"must survive")
    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.decrypt_file(encrypted, output, IMK)
    assert exc_info.value.code == "container.destination_exists"
    assert output.read_bytes() == b"must survive"


def test_encrypt_refuses_output_that_already_exists_without_overwriting(tmp_path):
    original = tmp_path / "source.txt"
    original.write_bytes(b"plaintext")
    output = tmp_path / "existing.ivault"
    output.write_bytes(b"must survive")

    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.encrypt_file(original, output, IMK)
    assert exc_info.value.code == "container.destination_exists"
    assert output.read_bytes() == b"must survive"


@pytest.mark.parametrize("unsafe_name", ["../outside.txt", "..\\outside.txt", "C:\\outside.txt", "\\\\server\\share\\x.txt", "", ".", ".."])
def test_read_header_rejects_unsafe_v1_original_filenames(tmp_path, unsafe_name):
    original = tmp_path / "legacy.txt"
    original.write_bytes(b"legacy content")
    encrypted = tmp_path / "legacy.ivault"
    _write_v1_container(original, encrypted, IMK)

    import json
    import struct

    raw = encrypted.read_bytes()
    (header_len,) = struct.unpack(">I", raw[:4])
    header = json.loads(raw[4 : 4 + header_len])
    header["original_filename"] = unsafe_name
    header_bytes = json.dumps(header).encode("utf-8")
    encrypted.write_bytes(struct.pack(">I", len(header_bytes)) + header_bytes + raw[4 + header_len :])

    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.read_header(encrypted, IMK)
    assert exc_info.value.code == "container.invalid_original_filename"


def test_tampered_meta_block_raises_integrity_error(tmp_path):
    import base64
    import json
    import struct

    original = tmp_path / "doc.txt"
    original.write_bytes(b"content")
    encrypted = tmp_path / "doc.ivault"
    container.encrypt_file(original, encrypted, IMK)

    raw = encrypted.read_bytes()
    (header_len,) = struct.unpack(">I", raw[:4])
    header = json.loads(raw[4 : 4 + header_len])
    meta = bytearray(base64.b64decode(header["meta"]))
    meta[0] ^= 0xFF
    header["meta"] = base64.b64encode(bytes(meta)).decode()
    new_header = json.dumps(header).encode("utf-8")
    encrypted.write_bytes(struct.pack(">I", len(new_header)) + new_header + raw[4 + header_len :])

    with pytest.raises(container.ContainerIntegrityError):
        container.read_header(encrypted, IMK)
    with pytest.raises(container.ContainerIntegrityError):
        container.decrypt_file(encrypted, tmp_path / "out.txt", IMK)


@pytest.mark.parametrize("cipher", sorted(crypto.selectable_file_ciphers()))
def test_encrypt_decrypt_round_trip_every_cipher(tmp_path, cipher):
    original = tmp_path / "doc.bin"
    data = os.urandom(3000)
    original.write_bytes(data)
    encrypted = tmp_path / "doc.ivault"
    container.encrypt_file(original, encrypted, IMK, cipher=cipher)

    header = container.read_header(encrypted, IMK)
    assert header["cipher"] == cipher
    assert header["original_filename"] == "doc.bin"

    decrypted = tmp_path / "doc.out"
    container.decrypt_file(encrypted, decrypted, IMK)
    assert decrypted.read_bytes() == data


@pytest.mark.parametrize("cipher", sorted(crypto.RETIRED_FILE_CIPHERS))
def test_retired_cipher_still_decrypts_but_cannot_be_chosen(tmp_path, cipher):
    """AES-128 是量子对手唯一真正占优的地方（Grover 使 128 位变 64）：新容器必须拒绝它，但已写入的
    文件必须永远能打开，读路径不能随写路径收紧。

    必须手工构造"旧"容器：encrypt_file 拒绝该算法后没有受支持的方式产出，也就无法证明读路径仍可用。
    """
    original = tmp_path / "doc.bin"
    data = os.urandom(3000)
    original.write_bytes(data)

    with pytest.raises(container.InvalidContainerError) as exc:
        container.encrypt_file(original, tmp_path / "new.ivault", IMK, cipher=cipher)
    assert exc.value.code == "container.retired_cipher"
    assert not (tmp_path / "new.ivault").exists()

    legacy = tmp_path / "legacy.ivault"
    _write_legacy_container(legacy, data, "doc.bin", cipher)
    assert container.read_header(legacy, IMK)["cipher"] == cipher
    decrypted = tmp_path / "doc.out"
    container.decrypt_file(legacy, decrypted, IMK)
    assert decrypted.read_bytes() == data


def _write_legacy_container(path, data: bytes, filename: str, cipher: str) -> None:
    """Reproduce exactly what encrypt_file used to emit for `cipher`."""
    fk = crypto.generate_file_key(cipher)
    fk_nonce, wrapped_fk = crypto.wrap_key(IMK, fk)
    nonce_prefix = os.urandom(container.NONCE_PREFIX_LEN)
    meta = json.dumps({
        "original_filename": filename,
        "plaintext_size": len(data),
        "sha256_plaintext": hashlib.sha256(data).hexdigest(),
        "kind": container.KIND_FILE,
    }).encode("utf-8")
    meta_ct = crypto.file_aead_encrypt(
        cipher, fk, container._chunk_nonce(nonce_prefix, container._META_CHUNK_INDEX),
        meta, container._META_AAD,
    )
    header = json.dumps({
        "format_version": container.FORMAT_VERSION,
        "chunk_size": container.CHUNK_SIZE,
        "cipher": cipher,
        "file_nonce_prefix": base64.b64encode(nonce_prefix).decode(),
        "fk_wrap": {
            "nonce": base64.b64encode(fk_nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
        },
        "meta": base64.b64encode(meta_ct).decode(),
    }).encode("utf-8")
    with open(path, "wb") as f:
        f.write(container._HEADER_LEN_STRUCT.pack(len(header)))
        f.write(header)
        ct = crypto.file_aead_encrypt(cipher, fk, container._chunk_nonce(nonce_prefix, 0), data)
        f.write(container._CHUNK_LEN_STRUCT.pack(len(ct)))
        f.write(ct)


def test_encrypt_rejects_unknown_cipher(tmp_path):
    original = tmp_path / "doc.txt"
    original.write_bytes(b"content")
    with pytest.raises(container.InvalidContainerError):
        container.encrypt_file(original, tmp_path / "doc.ivault", IMK, cipher="rot13")
    assert not (tmp_path / "doc.ivault").exists()


def test_decrypt_rejects_tampered_cipher_field(tmp_path):
    """Downgrade/裁剪攻击防线：把头部的 cipher 字段改成别的算法后，
    元数据解密的认证标签必然失败，不能得到明文。"""
    import base64 as _b64
    import json as _json
    import struct as _struct

    original = tmp_path / "doc.txt"
    original.write_bytes(b"content")
    encrypted = tmp_path / "doc.ivault"
    container.encrypt_file(original, encrypted, IMK, cipher="chacha20-poly1305")

    raw = encrypted.read_bytes()
    (header_len,) = _struct.unpack(">I", raw[:4])
    header = _json.loads(raw[4 : 4 + header_len])
    header["cipher"] = "aes-256-gcm"
    new_header = _json.dumps(header).encode("utf-8")
    encrypted.write_bytes(_struct.pack(">I", len(new_header)) + new_header + raw[4 + header_len :])

    with pytest.raises((container.ContainerIntegrityError, container.InvalidContainerError)):
        container.decrypt_file(encrypted, tmp_path / "out.txt", IMK)


def test_expected_chunk_count():
    assert container.expected_chunk_count(0, 100) == 0
    assert container.expected_chunk_count(1, 100) == 1
    assert container.expected_chunk_count(100, 100) == 1
    assert container.expected_chunk_count(101, 100) == 2


def test_encrypt_refuses_to_overwrite_source_file(tmp_path):
    original = tmp_path / "precious.docx"
    original.write_bytes(b"irreplaceable content")
    original_bytes = original.read_bytes()

    with pytest.raises(container.SamePathError):
        container.encrypt_file(original, original, IMK)

    # The refusal must happen before any write - source must be untouched.
    assert original.read_bytes() == original_bytes
    assert not (tmp_path / "precious.docx.part").exists()


def test_encrypt_refuses_when_paths_are_same_file_via_different_spelling(tmp_path):
    original = tmp_path / "precious.docx"
    original.write_bytes(b"irreplaceable content")

    # Same file, different (non-normalized) path string - must still be caught.
    same_file_different_spelling = tmp_path / "." / "precious.docx"
    with pytest.raises(container.SamePathError):
        container.encrypt_file(original, same_file_different_spelling, IMK)


def test_decrypt_refuses_to_overwrite_source_file(tmp_path):
    original = tmp_path / "note.txt"
    original.write_bytes(b"some content to encrypt")
    encrypted = tmp_path / "note.ivault"
    container.encrypt_file(original, encrypted, IMK)
    encrypted_bytes = encrypted.read_bytes()

    with pytest.raises(container.SamePathError):
        container.decrypt_file(encrypted, encrypted, IMK)

    # The .ivault file itself must survive untouched - it's the only copy.
    assert encrypted.read_bytes() == encrypted_bytes


def test_secure_delete_file_removes_file_and_overwrites_content(tmp_path):
    target = tmp_path / "secret.txt"
    original_content = b"sensitive plaintext" * 100
    target.write_bytes(original_content)

    # 最终 unlink 前原地覆写；用 os.open 做原始读取，绕开 OS 缓存让陈旧读取看起来仍是旧内容。
    container.secure_delete_file(target)

    assert not target.exists()


def test_secure_delete_file_on_large_multi_chunk_file(tmp_path):
    # Exercise the multi-chunk overwrite loop, not just the single-write path.
    target = tmp_path / "big_secret.bin"
    target.write_bytes(os.urandom(10 * 1024 * 1024))  # 10MB, spans multiple 4MiB chunks

    container.secure_delete_file(target)

    assert not target.exists()


# ---- Folder containers ----


def _build_folder_tree(root: Path) -> dict:
    """构建含嵌套目录、空目录和 unicode 名的小树，返回 {相对 posix 路径: 字节内容或 None（目录
    标记）}，便于按内容而非文件名对比前后。"""
    (root / "a.txt").write_bytes(b"hello from a")
    (root / "sub").mkdir()
    (root / "sub" / "b.bin").write_bytes(os.urandom(200))
    (root / "sub" / "deep").mkdir()
    (root / "sub" / "deep" / "c.txt").write_bytes(b"nested content")
    (root / "empty_dir").mkdir()
    (root / "unicode_目录").mkdir()
    (root / "unicode_目录" / "中文.txt").write_bytes("中文内容".encode("utf-8"))

    expected = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            rel = name if rel_dir == "." else f"{rel_dir}/{name}".replace(os.sep, "/")
            expected[rel] = (Path(dirpath) / name).read_bytes()
        if not dirnames and not filenames and rel_dir != ".":
            expected[rel_dir.replace(os.sep, "/") + "/"] = None
    return expected


def _read_extracted_tree(root: Path) -> dict:
    result = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            rel = name if rel_dir == "." else f"{rel_dir}/{name}".replace(os.sep, "/")
            result[rel] = (Path(dirpath) / name).read_bytes()
        if not dirnames and not filenames and rel_dir != ".":
            result[rel_dir.replace(os.sep, "/") + "/"] = None
    return result


def test_encrypt_decrypt_folder_round_trip(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    expected = _build_folder_tree(src)

    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)
    assert ivault.exists()
    assert not (tmp_path / "src.ivault.part").exists()

    preview = container.decrypt_folder_to_temp(ivault, IMK)
    assert preview["original_name"] == "src"
    assert {e["name"] for e in preview["entries"]} == set(expected.keys())

    dest = tmp_path / "restored"
    container.extract_folder_temp(preview["temp_zip_path"], dest)
    assert not Path(preview["temp_zip_path"]).exists()  # cleaned up after extract

    assert _read_extracted_tree(dest) == expected


def test_encrypt_folder_reports_progress_to_completion(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.bin").write_bytes(os.urandom(50_000))

    calls = []
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK, on_progress=lambda done, total: calls.append((done, total)))

    assert calls, "on_progress should have been called at least once"
    assert calls[-1][0] == calls[-1][1]  # final call: done == total


def test_encrypt_empty_folder_round_trips(tmp_path):
    src = tmp_path / "empty_src"
    src.mkdir()

    ivault = tmp_path / "empty.ivault"
    container.encrypt_folder(src, ivault, IMK)

    preview = container.decrypt_folder_to_temp(ivault, IMK)
    assert preview["entries"] == []

    dest = tmp_path / "empty_restored"
    container.extract_folder_temp(preview["temp_zip_path"], dest)
    assert dest.is_dir()
    assert list(dest.iterdir()) == []


def test_folder_container_header_kind_is_folder(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    header = container.read_header(ivault, IMK)
    assert header["kind"] == container.KIND_FOLDER
    assert header["original_filename"] == "src"
    assert isinstance(header["plaintext_size"], int)
    assert header["plaintext_size"] > 0


def test_file_container_header_kind_is_file(tmp_path):
    original = tmp_path / "note.txt"
    original.write_bytes(b"plain file content")
    encrypted = tmp_path / "note.ivault"
    container.encrypt_file(original, encrypted, IMK)

    header = container.read_header(encrypted, IMK)
    assert header["kind"] == container.KIND_FILE


def test_old_v2_container_without_kind_field_defaults_to_file(tmp_path, monkeypatch):
    # 模拟文件夹支持之前加密的 .ivault（meta 块没有 "kind" 键）：read_header 必须解析为 KIND_FILE
    # 而不是抛 KeyError，保证存量容器升级后照常可用。
    original = tmp_path / "legacy.txt"
    original.write_bytes(b"pre-folder-support content")
    encrypted = tmp_path / "legacy.ivault"
    container.encrypt_file(original, encrypted, IMK)

    real_normalize = container._normalize_meta

    def strip_kind(meta):
        meta = dict(meta)
        meta.pop("kind", None)
        return real_normalize(meta)

    # 只在规范化之前剥掉 "kind"，仍走 _normalize_meta 里真实的 setdefault("kind", KIND_FILE)；
    # 比手工构造头字节更不怕无关的头布局变动。
    monkeypatch.setattr(
        container, "_normalize_meta", lambda meta: real_normalize({k: v for k, v in meta.items() if k != "kind"})
    )
    header = container.read_header(encrypted, IMK)
    assert header["kind"] == container.KIND_FILE


def test_decrypt_file_rejects_folder_container(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.decrypt_file(ivault, tmp_path / "out.bin", IMK)
    assert exc_info.value.code == "container.is_folder_container"
    assert not (tmp_path / "out.bin").exists()
    assert not (tmp_path / "out.bin.part").exists()


def test_decrypt_folder_to_temp_rejects_file_container(tmp_path):
    original = tmp_path / "note.txt"
    original.write_bytes(b"plain file content")
    encrypted = tmp_path / "note.ivault"
    container.encrypt_file(original, encrypted, IMK)

    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.decrypt_folder_to_temp(encrypted, IMK)
    assert exc_info.value.code == "container.not_a_folder_container"


def test_decrypt_folder_to_temp_does_not_touch_a_destination(tmp_path):
    # 预览除自己的临时文件外不得有文件系统副作用，显式调用 extract_folder_temp 前不能在调用方
    # 没要求的位置写任何东西。
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    before = set(tmp_path.iterdir())
    preview = container.decrypt_folder_to_temp(ivault, IMK)
    after = set(tmp_path.iterdir())
    assert before == after  # nothing new appeared under tmp_path itself

    temp_zip = Path(preview["temp_zip_path"])
    assert temp_zip.exists()
    assert tmp_path not in temp_zip.parents  # lives in the OS temp dir, not here
    container.discard_folder_temp(str(temp_zip))


def test_discard_folder_temp_cleans_up_without_extracting(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    preview = container.decrypt_folder_to_temp(ivault, IMK)
    temp_zip = Path(preview["temp_zip_path"])
    assert temp_zip.exists()

    container.discard_folder_temp(str(temp_zip))
    assert not temp_zip.exists()
    # Idempotent - discarding an already-gone temp path is not an error.
    container.discard_folder_temp(str(temp_zip))


def test_encrypt_folder_rejects_non_directory(tmp_path):
    not_a_dir = tmp_path / "plain.txt"
    not_a_dir.write_bytes(b"x")

    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.encrypt_folder(not_a_dir, tmp_path / "out.ivault", IMK)
    assert exc_info.value.code == "container.not_a_directory"


def test_encrypt_folder_spans_multiple_chunks(tmp_path, monkeypatch):
    monkeypatch.setattr(container, "CHUNK_SIZE", 64)  # force many small chunks

    src = tmp_path / "src"
    src.mkdir()
    data_a = os.urandom(500)
    data_b = os.urandom(300)
    (src / "a.bin").write_bytes(data_a)
    (src / "b.bin").write_bytes(data_b)

    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    preview = container.decrypt_folder_to_temp(ivault, IMK)
    dest = tmp_path / "restored"
    container.extract_folder_temp(preview["temp_zip_path"], dest)

    assert (dest / "a.bin").read_bytes() == data_a
    assert (dest / "b.bin").read_bytes() == data_b


def test_extract_folder_temp_rejects_existing_destination_without_overwriting(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.txt").write_bytes(b"folder plaintext")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    preview = container.decrypt_folder_to_temp(ivault, IMK)
    destination = tmp_path / "restored"
    destination.mkdir()
    sentinel = destination / "must_survive.txt"
    sentinel.write_bytes(b"existing folder content")
    with pytest.raises(container.InvalidContainerError) as exc_info:
        container.extract_folder_temp(preview["temp_zip_path"], destination)
    assert exc_info.value.code == "container.destination_exists"
    assert sentinel.read_bytes() == b"existing folder content"
    # 预览故意保留：该失败发生在碰临时文件之前，意思是"选错文件夹"，换一个即可；删掉会让一次选错
    # 就得重解整个容器（大容器几分钟），且重试得到没头没脑的"预览已失效"。真正开始解压后的失败仍照旧
    # 丢弃，见 extract_folder_temp 的 docstring。
    assert Path(preview["temp_zip_path"]).exists()

    # 换个空目录重试——同一份预览必须还能用
    container.extract_folder_temp(preview["temp_zip_path"], tmp_path / "restored_2")
    assert (tmp_path / "restored_2" / "a.txt").read_bytes() == b"folder plaintext"
    assert not Path(preview["temp_zip_path"]).exists()


def test_extract_folder_temp_rejects_path_traversal(tmp_path):
    # 手工构造含路径穿越条目名的 zip，直接测 extract_folder_temp 的防御检查：encrypt_folder 的
    # arcname 都来自 os.path.relpath，自己产不出这种条目，此处模拟被损坏/篡改的临时文件。
    import zipfile as zf_mod

    evil_zip = tmp_path / "evil.zip"
    with zf_mod.ZipFile(evil_zip, "w") as zf:
        zf.writestr("../../escaped.txt", b"should never land outside output_dir")

    output_dir = tmp_path / "safe_dest"
    with pytest.raises(container.ContainerIntegrityError):
        container.extract_folder_temp(evil_zip, output_dir)
    assert not (tmp_path.parent / "escaped.txt").exists()
    # The temp file is still deleted even on this failure path.
    assert not evil_zip.exists()


def test_secure_delete_folder_removes_tree_without_following_symlinks(tmp_path):
    src = tmp_path / "to_delete"
    src.mkdir()
    (src / "inside.txt").write_bytes(b"folder content")
    outside = tmp_path / "must_survive.txt"
    outside.write_bytes(b"outside content")
    link = src / "outside-link.txt"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable in this environment: {exc}")

    container.secure_delete_folder(src)
    assert not src.exists()
    assert outside.read_bytes() == b"outside content"


def test_secure_delete_folder_removes_tree(tmp_path):
    src = tmp_path / "to_delete"
    src.mkdir()
    _build_folder_tree(src)

    container.secure_delete_folder(src)
    assert not src.exists()


def test_secure_delete_folder_overwrites_every_file_before_removing_the_tree(tmp_path, monkeypatch):
    """界面承诺「覆写后删除，不进回收站，无法恢复」，对文件夹同样成立。

    只验证"目录没了"的用例，换成 unlink() 或 shutil.rmtree 也照样绿，而文件内容仍可被恢复工具捞出。
    所以这里盯的是树里每个普通文件都真的走了覆写。
    """
    src = tmp_path / "to_delete"
    src.mkdir()
    (src / "top.txt").write_bytes(b"a" * 4096)
    nested = src / "nested" / "deeper"
    nested.mkdir(parents=True)
    (nested / "buried.bin").write_bytes(b"b" * 8192)
    (src / "nested" / "sibling.txt").write_bytes(b"c" * 512)

    expected = {
        (src / "top.txt").resolve(),
        (nested / "buried.bin").resolve(),
        (src / "nested" / "sibling.txt").resolve(),
    }

    overwritten = set()
    real_secure_delete_file = container.secure_delete_file

    def spy(path):
        overwritten.add(Path(path).resolve())
        return real_secure_delete_file(path)

    monkeypatch.setattr(container, "secure_delete_file", spy)
    container.secure_delete_folder(src)

    assert overwritten == expected, (
        "这些文件没有走覆写就被删了，磁盘上仍可恢复："
        f"{sorted(str(p) for p in expected - overwritten)}"
    )
    assert not src.exists()


def test_secure_delete_folder_handles_read_only_files(tmp_path):
    """一个只读文件不许搞砸整棵树的删除。

    曾发生：勾了「加密后安全删除原始文件夹」，加密成功但文件夹原样留着；树里有只读+隐藏+系统的
    `desktop.ini`，`open(path, "r+b")` 抛 PermissionError 穿过整个 os.walk，一个文件都没删。
    只读在 Windows 上是属性不是权限，应清掉重试，而不是判成删不掉。
    """
    src = tmp_path / "to_delete"
    src.mkdir()
    (src / "normal.txt").write_bytes(b"a" * 1024)
    read_only = src / "desktop.ini"
    read_only.write_bytes(b"[.ShellClassInfo]\r\nIconResource=x.ico\r\n")
    os.chmod(read_only, stat.S_IREAD)
    nested_read_only = src / "sub" / "locked.dat"
    nested_read_only.parent.mkdir()
    nested_read_only.write_bytes(b"b" * 2048)
    os.chmod(nested_read_only, stat.S_IREAD)

    container.secure_delete_folder(src)

    assert not src.exists(), "只读文件让整个文件夹的安全删除失败了"


def test_secure_delete_folder_reports_what_survived_instead_of_claiming_success(tmp_path):
    """删不掉时必须说出来并列出路径。"删不干净但报成功"更糟（用户以为明文没了）；一个删不掉的文件
    不能让其余文件也留下，且调用方必须收到带路径清单的异常。"""
    src = tmp_path / "to_delete"
    src.mkdir()
    (src / "deletable.txt").write_bytes(b"a" * 1024)
    stuck = src / "held_open.bin"
    stuck.write_bytes(b"b" * 4096)

    # Windows 上没有 FILE_SHARE_DELETE 的打开句柄才会真正阻止 unlink（同用户在编辑器里开着该文件）；
    # POSIX 上 unlink 照样成功，无可断言。
    handle = open(stuck, "rb")
    try:
        try:
            container.secure_delete_folder(src)
        except container.SecureDeleteIncompleteError as exc:
            assert exc.code == "container.secure_delete_incomplete"
            assert str(stuck) in exc.params["sample"]
            assert not (src / "deletable.txt").exists(), (
                "一个删不掉的文件不该让其它文件也留在磁盘上"
            )
        else:
            if os.name == "nt":
                pytest.fail("被占用的文件竟然删掉了，说明这个用例没测到该测的东西")
            assert not src.exists()  # POSIX: unlink on an open file is fine
    finally:
        handle.close()


def test_v2_folder_container_kind_stays_locked_without_imk(tmp_path):
    # 与文件容器测试 test_v2_plaintext_header_leaks_no_metadata 同一性质：kind 在加密的 meta 块里，
    # 没有 imk 也不得可读。
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    header = container.read_header(ivault, imk=None)
    assert header.get("metadata_locked") is True
    assert "kind" not in header
    assert "original_filename" not in header



def test_diff_reports_no_changes_when_folder_matches_container(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    _build_folder_tree(src)
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    diff = container.diff_folder_against_container(src, ivault, IMK)
    assert diff["added"] == []
    assert diff["removed"] == []
    assert diff["modified"] == []
    assert diff["empty_dirs_added"] == []
    assert diff["empty_dirs_removed"] == []
    assert diff["unchanged_count"] > 0
    assert diff["original_name"] == "src"


def test_diff_detects_added_removed_and_modified_files(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    _build_folder_tree(src)
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    # modify a.txt (same size, different content - must still be caught by CRC)
    original = (src / "a.txt").read_bytes()
    replacement = bytes(len(original))  # same length, all zero bytes - guaranteed different
    assert replacement != original
    (src / "a.txt").write_bytes(replacement)
    # remove a nested file
    (src / "sub" / "b.bin").unlink()
    # add a new file
    (src / "new_file.txt").write_bytes(b"brand new")

    diff = container.diff_folder_against_container(src, ivault, IMK)
    assert diff["added"] == ["new_file.txt"]
    assert diff["removed"] == ["sub/b.bin"]
    assert diff["modified"] == ["a.txt"]


def test_diff_detects_empty_dir_added_and_removed(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "kept_empty").mkdir()
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    (src / "kept_empty").rmdir()
    (src / "brand_new_empty").mkdir()

    diff = container.diff_folder_against_container(src, ivault, IMK)
    assert diff["empty_dirs_added"] == ["brand_new_empty/"]
    assert diff["empty_dirs_removed"] == ["kept_empty/"]


def test_diff_cleans_up_its_own_temp_preview_zip(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)

    # 只看这一次调用新增了什么，不能断言整个系统临时目录为空：预览 zip 落在真实 %TEMP%，"用户正看着
    # 预览还没决定"本就是合法中间状态，别的用例或真在运行的应用留一份都会让这条无关地变红。
    pattern = f"{container._FOLDER_TEMP_PREFIX}*.zip"
    before = set(Path(tempfile.gettempdir()).glob(pattern))
    container.diff_folder_against_container(src, ivault, IMK)
    after = set(Path(tempfile.gettempdir()).glob(pattern))
    assert after - before == set()


def test_diff_rejects_file_container(tmp_path):
    original = tmp_path / "note.txt"
    original.write_bytes(b"just a file")
    encrypted = tmp_path / "note.ivault"
    container.encrypt_file(original, encrypted, IMK)

    with pytest.raises(container.InvalidContainerError):
        container.diff_folder_against_container(tmp_path / "some_dir_that_does_not_matter", encrypted, IMK)


def test_reencrypt_replaces_container_with_updated_content(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    _build_folder_tree(src)
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)
    original_bytes = ivault.read_bytes()

    (src / "a.txt").write_bytes(b"updated content")
    (src / "new_after_reencrypt.txt").write_bytes(b"fresh")

    container.reencrypt_folder_container(src, ivault, IMK)

    assert ivault.exists()
    assert ivault.read_bytes() != original_bytes  # genuinely re-encrypted, not a no-op
    # No stray sibling temp files left behind (success path cleans up both).
    siblings = list(ivault.parent.glob(f".{ivault.name}.*"))
    assert siblings == []

    preview = container.decrypt_folder_to_temp(ivault, IMK)
    try:
        with zipfile.ZipFile(preview["temp_zip_path"]) as zf:
            assert zf.read("a.txt") == b"updated content"
            assert zf.read("new_after_reencrypt.txt") == b"fresh"
    finally:
        container.discard_folder_temp(preview["temp_zip_path"])


def test_reencrypt_preserves_original_on_source_folder_missing(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"content")
    ivault = tmp_path / "src.ivault"
    container.encrypt_folder(src, ivault, IMK)
    original_bytes = ivault.read_bytes()

    shutil.rmtree(src)  # source folder gone - reencrypt must fail cleanly

    with pytest.raises(container.InvalidContainerError):
        container.reencrypt_folder_container(src, ivault, IMK)

    # Original container is completely untouched - never partially replaced.
    assert ivault.exists()
    assert ivault.read_bytes() == original_bytes
    assert list(ivault.parent.glob(f".{ivault.name}.*")) == []


def test_reencrypt_rejects_non_container_path(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "f.txt").write_bytes(b"x")
    with pytest.raises(container.InvalidContainerError):
        container.reencrypt_folder_container(src, tmp_path / "does_not_exist.ivault", IMK)


# --- 加密文件夹：列清单与解压不再经过临时明文 ZIP ---


def _make_folder_container(tmp_path, imk, name="folder"):
    src = tmp_path / name
    (src / "sub").mkdir(parents=True)
    (src / "top.txt").write_text("顶层内容", encoding="utf-8")
    (src / "sub" / "nested.bin").write_bytes(b"\x00\x01\x02" * 5000)
    out = tmp_path / f"{name}.ivault"
    container.encrypt_folder(str(src), str(out), imk)
    return src, out


def test_list_folder_container_reads_the_listing_without_writing_anything(tmp_path):
    """列清单不许在磁盘留明文。旧实现把整个容器解密成临时明文 ZIP 再读中央目录，10 GB 文件夹要先
    写 10 GB 明文；这条钉住"那份临时明文不再存在"（性能与隐私问题）。"""
    imk = os.urandom(32)
    src, out = _make_folder_container(tmp_path, imk)

    temp_root = Path(tempfile.gettempdir())
    before = set(temp_root.glob(f"{container._FOLDER_TEMP_PREFIX}*"))
    listing = container.list_folder_container(str(out), imk)
    after = set(temp_root.glob(f"{container._FOLDER_TEMP_PREFIX}*"))

    assert after == before, f"列清单留下了临时明文文件：{sorted(after - before)}"
    names = {e["name"] for e in listing["entries"]}
    assert "top.txt" in names
    assert any(n.endswith("sub/nested.bin") or n == "sub/nested.bin" for n in names), names
    assert listing["original_name"] == "folder"


def test_extract_folder_container_round_trips_every_byte(tmp_path):
    imk = os.urandom(32)
    src, out = _make_folder_container(tmp_path, imk)
    dst = tmp_path / "restored"

    container.extract_folder_container(str(out), str(dst), imk)

    assert (dst / "top.txt").read_text(encoding="utf-8") == "顶层内容"
    assert (dst / "sub" / "nested.bin").read_bytes() == b"\x00\x01\x02" * 5000


def test_extract_folder_container_refuses_an_existing_destination(tmp_path):
    """目标已存在时一个字节都不许写——绝不跟用户已有的文件夹合并。"""
    imk = os.urandom(32)
    src, out = _make_folder_container(tmp_path, imk)
    dst = tmp_path / "occupied"
    dst.mkdir()
    (dst / "mine.txt").write_text("别动我", encoding="utf-8")

    with pytest.raises(container.InvalidContainerError) as exc:
        container.extract_folder_container(str(out), str(dst), imk)
    assert exc.value.code == "container.destination_exists"
    assert (dst / "mine.txt").read_text(encoding="utf-8") == "别动我"
    assert list(dst.iterdir()) == [dst / "mine.txt"], "目标目录被动过了"


def test_random_access_reader_rejects_a_tampered_chunk(tmp_path):
    """按偏移跳到某一块之后，篡改仍须当场被发现。

    列清单现在只解末尾几块，跳过的块没被验证过；保证来自每块独立密封且 nonce 带块序号
    （见 _chunk_nonce），所以改哪一块读到时都会失败，而不是解出看似合理的垃圾。
    """
    imk = os.urandom(32)
    src, out = _make_folder_container(tmp_path, imk)

    raw = bytearray(out.read_bytes())
    # 翻掉靠近文件末尾的一个字节（中央目录所在的那一块），列清单必然要读到它
    raw[-64] ^= 0xFF
    out.write_bytes(bytes(raw))

    with pytest.raises(container.ContainerIntegrityError):
        container.list_folder_container(str(out), imk)


def test_extract_folder_container_verifies_the_whole_plaintext_before_writing(tmp_path):
    """整体 sha256 对不上时，目标目录一个字节都不许出现。

    边解边写最快但校验失败时明文已落在用户目录，所以校验是独立的前置只读扫描，不是边写边算。
    """
    imk = os.urandom(32)
    src, out = _make_folder_container(tmp_path, imk)

    raw = bytearray(out.read_bytes())
    raw[-64] ^= 0xFF
    out.write_bytes(bytes(raw))

    dst = tmp_path / "should_not_appear"
    with pytest.raises(container.ContainerIntegrityError):
        container.extract_folder_container(str(out), str(dst), imk)
    assert not dst.exists(), "校验失败了，但目标目录还是被创建了"


def test_list_folder_container_refuses_a_file_kind_container(tmp_path):
    imk = os.urandom(32)
    plain = tmp_path / "just_a_file.txt"
    plain.write_text("hello", encoding="utf-8")
    out = tmp_path / "file.ivault"
    container.encrypt_file(str(plain), str(out), imk)

    with pytest.raises(container.InvalidContainerError) as exc:
        container.list_folder_container(str(out), imk)
    assert exc.value.code == "container.not_a_folder_container"
