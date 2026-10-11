#!/usr/bin/env python
"""file_clip 功能自测（直接运行）：剪贴板往返、哈希校验、重名策略、同盘/跨盘剪切、防呆、空剪贴板。
数据放系统临时目录和 tests/.tmp_d，跑完自动清理。"""

import ctypes
import hashlib
import os
import shutil
import stat
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_clip import cli, clipboard, engine  # noqa: E402

FILE_ATTRIBUTE_READONLY = 0x1


# ---------- 工具 ----------

def rmtree_force(path):
    def _onerror(func, p, exc_info):
        os.chmod(p, stat.S_IWRITE)
        func(p)

    if os.path.isdir(path):
        shutil.rmtree(path, onerror=_onerror)
    elif os.path.lexists(path):
        os.chmod(path, stat.S_IWRITE)
        os.unlink(path)


def make_tree(base: str, small_count: int = 300) -> None:
    os.makedirs(base)
    with open(os.path.join(base, "普通文件.txt"), "w", encoding="utf-8") as f:
        f.write("你好 file_clip！" * 100)
    open(os.path.join(base, "empty.bin"), "wb").close()
    with open(os.path.join(base, "emoji 🚀 文件.dat"), "wb") as f:
        f.write(os.urandom(1024))
    deep = os.path.join(base, "sub", "nested")
    os.makedirs(deep)
    with open(os.path.join(deep, "deep.bin"), "wb") as f:
        f.write(os.urandom(2 * 1024 * 1024))
    os.makedirs(os.path.join(base, "sub", "空目录"))
    small = os.path.join(base, "small")
    os.makedirs(small)
    blob = os.urandom(8192)
    for i in range(small_count):
        with open(os.path.join(small, f"f{i:04d}.dat"), "wb") as f:
            f.write(blob[: 1024 + (i % 8) * 1024])
    ro = os.path.join(base, "readonly.txt")
    with open(ro, "w", encoding="utf-8") as f:
        f.write("readonly content")
    ctypes.windll.kernel32.SetFileAttributesW(ro, FILE_ATTRIBUTE_READONLY)


def hash_tree(base: str):
    """返回 {相对路径: sha256}（文件）和 {相对目录路径}（含空目录）。"""
    files, dirs = {}, set()
    for root, dnames, fnames in os.walk(base):
        rel_root = os.path.relpath(root, base)
        for d in dnames:
            dirs.add(os.path.normpath(os.path.join(rel_root, d)))
        for name in fnames:
            p = os.path.join(root, name)
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            files[os.path.normpath(os.path.join(rel_root, name))] = h.hexdigest()
    return files, dirs


# ---------- 测试用例 ----------

def test_clipboard_roundtrip(tmp):
    p1 = os.path.join(tmp, "a.txt")
    p2 = os.path.join(tmp, "b.txt")
    for p in (p1, p2):
        with open(p, "w") as f:
            f.write("x")
    clipboard.set_file_drop([p1, p2], move=False)
    paths, is_cut = clipboard.get_file_drop()
    assert paths == [p1, p2] and is_cut is False
    clipboard.set_file_drop([p1], move=True)
    paths, is_cut = clipboard.get_file_drop()
    assert paths == [p1] and is_cut is True


def test_copy_paste_integrity(tmp):
    src = os.path.join(tmp, "源目录")
    dst = os.path.join(tmp, "目标1")
    make_tree(src)
    src_files, src_dirs = hash_tree(src)

    clipboard.set_file_drop([src], move=False)
    rc = cli.main(["paste", dst])
    assert rc == 0, f"paste rc={rc}"

    copied = os.path.join(dst, "源目录")
    dst_files, dst_dirs = hash_tree(copied)
    assert dst_files == src_files, "文件内容哈希不一致！"
    assert dst_dirs == src_dirs, f"目录结构不一致（空目录丢失？）: {src_dirs ^ dst_dirs}"

    # 修改时间保留（CopyFileExW 语义）
    s = os.stat(os.path.join(src, "普通文件.txt"))
    d = os.stat(os.path.join(copied, "普通文件.txt"))
    assert abs(s.st_mtime - d.st_mtime) < 3, "修改时间未保留"
    # 只读属性保留
    attrs = os.stat(os.path.join(copied, "readonly.txt")).st_file_attributes
    assert attrs & FILE_ATTRIBUTE_READONLY, "只读属性未保留"
    # 源必须原封不动
    assert hash_tree(src)[0] == src_files


def test_conflict_rename(tmp):
    src = os.path.join(tmp, "源目录")
    dst = os.path.join(tmp, "目标1")  # 里面已有「源目录」
    report = engine.transfer([src], dst, move=False, on_conflict="rename")
    assert report.ok, report.errors
    assert report.renamed, "应记录改名"
    renamed_dir = os.path.join(dst, "源目录 (2)")
    assert os.path.isdir(renamed_dir), "未生成「源目录 (2)」"
    assert hash_tree(renamed_dir)[0] == hash_tree(src)[0]


def test_conflict_skip(tmp):
    src = os.path.join(tmp, "源目录")
    dst = os.path.join(tmp, "目标1")
    report = engine.transfer([src], dst, move=False, on_conflict="skip")
    assert report.ok, report.errors
    assert report.skipped and report.files_total == 0, "skip 策略不应拷贝任何文件"
    assert not os.path.exists(os.path.join(dst, "源目录 (3)"))


def test_conflict_overwrite(tmp):
    src = os.path.join(tmp, "源目录")
    dst = os.path.join(tmp, "目标1")
    marker = os.path.join(src, "普通文件.txt")
    with open(marker, "w", encoding="utf-8") as f:
        f.write("覆盖后的新内容 v2")
    report = engine.transfer([src], dst, move=False, on_conflict="overwrite")
    assert report.ok, report.errors
    with open(os.path.join(dst, "源目录", "普通文件.txt"), encoding="utf-8") as f:
        assert f.read() == "覆盖后的新内容 v2", "覆盖未生效"
    # 只读目标也要能覆盖
    assert hash_tree(os.path.join(dst, "源目录"))[0] == hash_tree(src)[0]


def test_cut_same_volume_instant(tmp):
    src = os.path.join(tmp, "剪切源")
    dst = os.path.join(tmp, "剪切目标")
    make_tree(src, small_count=500)
    before, _ = hash_tree(src)

    report = engine.transfer([src], dst, move=True, on_conflict="rename")
    assert report.ok, report.errors
    assert report.fast_moved, "同盘剪切应走快速改名"
    assert report.files_total == 0, "同盘剪切不应搬任何数据"
    assert report.elapsed < 2.0, f"同盘剪切太慢: {report.elapsed:.2f}s"
    assert not os.path.exists(src), "剪切后源应消失"
    after, _ = hash_tree(os.path.join(dst, "剪切源"))
    assert after == before, "剪切后内容不一致"
    print(f"    (505 个文件同盘剪切耗时 {report.elapsed*1000:.0f}ms)", end=" ")


def test_cut_cross_volume(tmp, d_tmp):
    src = os.path.join(tmp, "跨盘源")  # C:
    make_tree(src, small_count=50)
    before, before_dirs = hash_tree(src)

    report = engine.transfer([src], d_tmp, move=True, on_conflict="rename")  # -> D:
    assert report.ok, report.errors
    assert report.files_done == report.files_total > 0, "跨盘剪切应实际拷贝"
    assert not os.path.exists(src), "跨盘剪切后源应删除"
    after, after_dirs = hash_tree(os.path.join(d_tmp, "跨盘源"))
    assert after == before and after_dirs == before_dirs


def test_dest_inside_source_guard(tmp):
    src = os.path.join(tmp, "防呆源")
    os.makedirs(os.path.join(src, "inner"))
    report = engine.transfer([src], os.path.join(src, "inner"), move=False)
    assert report.errors, "应拒绝把文件夹拷进自己内部"
    assert "无限嵌套" in report.errors[0][1]


def test_paste_empty_clipboard(tmp):
    clipboard.clear_clipboard()
    rc = cli.main(["paste", os.path.join(tmp, "无效目标")])
    assert rc == 1, f"空剪贴板 paste 应返回 1，实际 {rc}"


def test_clipboard_cleared_after_cut_paste(tmp):
    f = os.path.join(tmp, "single.txt")
    with open(f, "w") as fp:
        fp.write("cut me")
    dst = os.path.join(tmp, "单文件目标")
    rc = cli.main(["cut", f])
    assert rc == 0
    rc = cli.main(["paste", dst])
    assert rc == 0
    assert os.path.isfile(os.path.join(dst, "single.txt"))
    assert not os.path.exists(f)
    assert clipboard.get_file_drop() is None, "剪切粘贴成功后剪贴板应清空"


# ---------- 运行器 ----------

def main() -> int:
    tmp = tempfile.mkdtemp(prefix="file_clip_test_")
    d_tmp = str(Path(__file__).resolve().parent / ".tmp_d")
    rmtree_force(d_tmp)
    os.makedirs(d_tmp)
    tests = [
        ("剪贴板往返（复制/剪切状态）", test_clipboard_roundtrip, (tmp,)),
        ("复制粘贴完整性（哈希/空目录/时间/只读属性）", test_copy_paste_integrity, (tmp,)),
        ("重名策略 rename 保留两者", test_conflict_rename, (tmp,)),
        ("重名策略 skip 跳过", test_conflict_skip, (tmp,)),
        ("重名策略 overwrite 覆盖（含只读目标）", test_conflict_overwrite, (tmp,)),
        ("同盘剪切瞬移", test_cut_same_volume_instant, (tmp,)),
        ("跨盘剪切（C:→D: 拷贝后删源）", test_cut_cross_volume, (tmp, d_tmp)),
        ("防呆：目标在源内部", test_dest_inside_source_guard, (tmp,)),
        ("空剪贴板 paste 报错退出", test_paste_empty_clipboard, (tmp,)),
        ("剪切粘贴后剪贴板清空", test_clipboard_cleared_after_cut_paste, (tmp,)),
    ]
    passed = failed = 0
    try:
        for name, fn, args in tests:
            t0 = time.perf_counter()
            try:
                fn(*args)
            except Exception as exc:
                failed += 1
                print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
            else:
                passed += 1
                print(f"PASS  {name} ({time.perf_counter() - t0:.2f}s)")
    finally:
        clipboard.clear_clipboard()
        rmtree_force(tmp)
        rmtree_force(d_tmp)
    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
