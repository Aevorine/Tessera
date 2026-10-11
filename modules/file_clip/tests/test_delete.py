#!/usr/bin/env python
"""file_clip 删除功能自测：永久删除、回收站删除、CLI --yes、
右键多选收集器（3 个并发进程合并成一批）。"""

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_clip import engine  # noqa: E402

CLI = str(PROJECT_ROOT / "modules" / "file_clip" / "cli.py")
FILE_ATTRIBUTE_READONLY = 0x1


def make_tree(base, n_files=200):
    import ctypes

    os.makedirs(os.path.join(base, "sub", "deep"))
    total = 0
    blob = os.urandom(4096)
    for i in range(n_files):
        p = os.path.join(base, "sub" if i % 3 else "", f"f{i:04d}.dat")
        with open(p, "wb") as f:
            f.write(blob)
        total += len(blob)
    ro = os.path.join(base, "sub", "deep", "readonly.txt")
    with open(ro, "w") as f:
        f.write("ro")
    ctypes.windll.kernel32.SetFileAttributesW(ro, FILE_ATTRIBUTE_READONLY)
    return n_files + 1, total + 2


def test_permanent_delete(tmp):
    base = os.path.join(tmp, "删除树")
    n, total = make_tree(base)
    report = engine.delete_items([base])
    assert report.ok, report.errors[:3]
    assert report.files_done == report.files_total == n
    assert report.bytes_done == total
    assert not os.path.exists(base), "目录应被整树删除"


def test_recycle_delete(tmp):
    p = os.path.join(tmp, "回收站测试.txt")
    with open(p, "w") as f:
        f.write("recycle me")
    report = engine.delete_items([p], recycle=True)
    assert report.ok, report.errors
    assert not os.path.exists(p), "回收站删除后原位置应消失"


def test_cli_yes_path(tmp):
    p = os.path.join(tmp, "cli删除.txt")
    with open(p, "w") as f:
        f.write("x")
    r = subprocess.run(
        [sys.executable, "-X", "utf8", CLI, "delete", p, "--yes"],
        capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert not os.path.exists(p)
    # 不带 --yes 的永久删除必须拒绝执行
    p2 = os.path.join(tmp, "cli拒绝.txt")
    with open(p2, "w") as f:
        f.write("x")
    r = subprocess.run(
        [sys.executable, "-X", "utf8", CLI, "delete", p2],
        capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    assert r.returncode == 1 and os.path.exists(p2), "无确认不得删除"
    os.unlink(p2)


def test_multiselect_collector(tmp):
    """模拟资源管理器多选右键：3 个进程同时各报 1 个路径，队长合并删除。"""
    files = []
    for i in range(3):
        p = os.path.join(tmp, f"多选{i}.txt")
        with open(p, "w") as f:
            f.write("x")
        files.append(p)
    env = dict(os.environ, FILE_CLIP_DELETE_NOGUI="1")
    procs = [
        subprocess.Popen(
            [sys.executable, "-X", "utf8", CLI, "queue-delete", p, "--permanent"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8",
        )
        for p in files
    ]
    outs = [p.communicate(timeout=60)[0] for p in procs]
    assert all(p.returncode == 0 for p in procs), outs
    for p in files:
        assert not os.path.exists(p), f"{p} 应已被删除"
    leaders = [o for o in outs if "删除：" in (o or "")]
    assert len(leaders) == 1, f"应恰好一个队长执行删除，实际 {len(leaders)}：{outs}"
    assert "3/3" in leaders[0], f"队长应一次删 3 个：{leaders[0]}"


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="file_clip_del_")
    tests = [
        ("永久删除（201 文件含只读，统计校验）", test_permanent_delete),
        ("回收站删除", test_recycle_delete),
        ("CLI 删除（--yes 通过 / 无确认拒绝）", test_cli_yes_path),
        ("右键多选收集器（3 进程并发合并）", test_multiselect_collector),
    ]
    passed = failed = 0
    try:
        for name, fn in tests:
            t0 = time.perf_counter()
            try:
                fn(tmp)
            except Exception as exc:
                failed += 1
                print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
            else:
                passed += 1
                print(f"PASS  {name} ({time.perf_counter() - t0:.2f}s)")
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
