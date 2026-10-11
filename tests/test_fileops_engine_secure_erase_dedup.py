"""Tests for core/fileops/engine.py secure_erase / fast_dedup_hash / full_dedup_hash / is_duplicate (plain filesystem ops, directly testable)."""

import os
import stat

import pytest

from core.fileops import engine


# --- secure_erase ---


def test_secure_erase_removes_a_small_file(tmp_path):
    f = tmp_path / "small.txt"
    f.write_bytes(b"some sensitive content")

    engine.secure_erase(str(f))

    assert not f.exists()


def test_secure_erase_removes_an_empty_file(tmp_path):
    f = tmp_path / "empty.bin"
    f.write_bytes(b"")

    engine.secure_erase(str(f))

    assert not f.exists()


def test_secure_erase_removes_a_directory_tree(tmp_path):
    d = tmp_path / "secret_folder"
    d.mkdir()
    (d / "file1.txt").write_bytes(b"one")
    sub = d / "sub"
    sub.mkdir()
    (sub / "file2.txt").write_bytes(b"two")

    engine.secure_erase(str(d))

    assert not d.exists()


def test_secure_erase_nonexistent_path_is_a_silent_no_op(tmp_path):
    missing = tmp_path / "never_existed.txt"

    engine.secure_erase(str(missing))  # 不应抛异常


def test_secure_erase_overwrites_content_before_the_final_delete(tmp_path, monkeypatch):
    # 让最后的“删除”失败，文件留在磁盘上，才能在覆写后、删除前读出内容核对确实写入了新数据。
    f = tmp_path / "secret.txt"
    original = b"top secret original content, do not leak"
    f.write_bytes(original)
    original_size = f.stat().st_size

    def _blocked_unlink(path):
        raise OSError("blocked for test")

    monkeypatch.setattr(os, "unlink", _blocked_unlink)

    with pytest.raises(OSError):
        engine.secure_erase(str(f))

    assert f.stat().st_size == original_size  # 覆写不改变文件大小
    assert f.read_bytes() != original  # 但内容已经被覆写，不再是原文


def test_secure_erase_leaves_file_intact_and_raises_when_a_pass_fails(tmp_path):
    f = tmp_path / "locked.txt"
    f.write_bytes(b"cannot be overwritten while read-only")
    os.chmod(str(f), stat.S_IREAD)
    try:
        with pytest.raises(OSError):
            engine.secure_erase(str(f))
        # 覆写没有全部成功就不该删除文件——"安全擦除"的承诺是"覆写后删除"，
        # 半途而废却还是把文件删了，会让调用方误以为数据已经被安全清除。
        assert f.exists()
    finally:
        os.chmod(str(f), stat.S_IWRITE)  # 恢复可写，让 tmp_path 能正常清理


def test_secure_erase_respects_custom_pass_count(tmp_path):
    f = tmp_path / "one_pass.txt"
    f.write_bytes(b"content")

    engine.secure_erase(str(f), passes=1)

    assert not f.exists()


# --- fast_dedup_hash / full_dedup_hash ---


def test_fast_dedup_hash_matches_for_files_with_identical_prefixes(tmp_path):
    a = tmp_path / "a.txt"
    a.write_bytes(b"identical prefix content")
    b = tmp_path / "b.txt"
    b.write_bytes(b"identical prefix content")

    assert engine.fast_dedup_hash(str(a)) == engine.fast_dedup_hash(str(b))


def test_fast_dedup_hash_returns_a_consistent_value_for_empty_files(tmp_path):
    # 空文件读出的 chunk 也是 b''——不能被误判为"读不了"（见下面
    # is_duplicate 对两个空文件的测试，这是这条行为实际起作用的地方）。
    f = tmp_path / "empty.txt"
    f.write_bytes(b"")

    digest = engine.fast_dedup_hash(str(f))

    assert digest is not None
    assert digest == engine.fast_dedup_hash(str(f))


def test_fast_dedup_hash_returns_none_for_missing_file(tmp_path):
    assert engine.fast_dedup_hash(str(tmp_path / "does_not_exist.txt")) is None


def test_full_dedup_hash_returns_none_for_missing_file(tmp_path):
    assert engine.full_dedup_hash(str(tmp_path / "does_not_exist.txt")) is None


def test_full_dedup_hash_matches_hashlib_reference(tmp_path):
    import hashlib

    f = tmp_path / "a.bin"
    content = b"some binary-ish content \x00\x01\x02" * 1000
    f.write_bytes(content)

    assert engine.full_dedup_hash(str(f)) == hashlib.sha256(content).hexdigest()


# --- is_duplicate ---


def test_is_duplicate_true_for_identical_content(tmp_path):
    a = tmp_path / "a.txt"
    a.write_bytes(b"same content " * 100)
    b = tmp_path / "b.txt"
    b.write_bytes(b"same content " * 100)

    assert engine.is_duplicate(str(a), str(b)) is True


def test_is_duplicate_false_for_different_content_same_size(tmp_path):
    a = tmp_path / "a.txt"
    a.write_bytes(b"aaaa")
    b = tmp_path / "b.txt"
    b.write_bytes(b"bbbb")

    assert engine.is_duplicate(str(a), str(b)) is False


def test_is_duplicate_false_for_different_sizes(tmp_path):
    a = tmp_path / "a.txt"
    a.write_bytes(b"short")
    b = tmp_path / "b.txt"
    b.write_bytes(b"a much longer piece of content than the other file")

    assert engine.is_duplicate(str(a), str(b)) is False


def test_is_duplicate_true_for_two_empty_files(tmp_path):
    a = tmp_path / "a.txt"
    a.write_bytes(b"")
    b = tmp_path / "b.txt"
    b.write_bytes(b"")

    assert engine.is_duplicate(str(a), str(b)) is True


def test_is_duplicate_detects_difference_beyond_the_fast_hash_prefix(tmp_path):
    # 前 4KB（DEDUP_HASH_FIRST_N）完全相同，4KB 之后才不同——必须触发
    # full_dedup_hash 复核才能分辨，只做快速哈希会把这种情况误判为重复。
    prefix = b"x" * 4096
    a = tmp_path / "a.bin"
    a.write_bytes(prefix + b"AAAA_TAIL")
    b = tmp_path / "b.bin"
    b.write_bytes(prefix + b"BBBB_TAIL")

    assert engine.is_duplicate(str(a), str(b)) is False


def test_is_duplicate_false_when_source_is_missing(tmp_path):
    dest = tmp_path / "dest.txt"
    dest.write_bytes(b"content")

    assert engine.is_duplicate(str(tmp_path / "missing_source.txt"), str(dest)) is False


def test_is_duplicate_false_when_dest_is_missing(tmp_path):
    src = tmp_path / "src.txt"
    src.write_bytes(b"content")

    assert engine.is_duplicate(str(src), str(tmp_path / "missing_dest.txt")) is False
