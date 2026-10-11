#!/usr/bin/env python
"""file_clip 性能实测：本引擎 vs PowerShell Copy-Item vs robocopy /MT:8
（2GB 单文件、1 万个 4KB 小文件）。"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_clip import engine  # noqa: E402

GB = 1024 ** 3
BIG_SIZE = 2 * GB
SMALL_COUNT = 10_000
SMALL_SIZE = 4 * 1024


def gen_big_file(path: str) -> None:
    print(f"生成 2GB 测试文件 {path} ...", flush=True)
    block = os.urandom(64 * 1024 * 1024)
    with open(path, "wb") as f:
        for _ in range(BIG_SIZE // len(block)):
            f.write(block)


def gen_small_files(base: str) -> None:
    print(f"生成 {SMALL_COUNT:,} 个 4KB 小文件 {base} ...", flush=True)
    os.makedirs(base)
    block = os.urandom(SMALL_SIZE)
    for i in range(SMALL_COUNT):
        with open(os.path.join(base, f"f{i:05d}.dat"), "wb") as f:
            f.write(i.to_bytes(8, "little") + block[8:])


def bench_ours(sources, dest) -> float:
    report = engine.transfer(sources, dest, move=False, on_conflict="overwrite",
                             live_progress=False)
    assert report.ok, f"引擎报错: {report.errors[:3]}"
    assert report.files_done == report.files_total
    return report.elapsed


def bench_powershell_copyitem(src, dest) -> float:
    """用 Measure-Command 计时，排除 PowerShell 启动开销。"""
    cmd = (
        f"$t = Measure-Command {{ Copy-Item -LiteralPath '{src}' "
        f"-Destination '{dest}' -Recurse -Force }}; "
        f"[Console]::WriteLine($t.TotalSeconds)"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", cmd],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip().splitlines()[-1])


def bench_robocopy(src_dir, dest_dir) -> float:
    t0 = time.perf_counter()
    r = subprocess.run(
        ["robocopy", src_dir, dest_dir, "/E", "/MT:8",
         "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
        capture_output=True, text=True,
    )
    elapsed = time.perf_counter() - t0
    assert r.returncode < 8, f"robocopy 失败: rc={r.returncode}"
    return elapsed


def count_and_size(path: str):
    if os.path.isfile(path):
        return 1, os.path.getsize(path)
    n = b = 0
    for root, _, files in os.walk(path):
        for name in files:
            n += 1
            b += os.path.getsize(os.path.join(root, name))
    return n, b


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="file_clip_bench_")
    results = []
    try:
        # ---- 场景A：2GB 大文件 ----
        big_src = os.path.join(tmp, "big_2gb.bin")
        gen_big_file(big_src)

        dest_a1 = os.path.join(tmp, "dest_ours_big")
        t = bench_ours([big_src], dest_a1)
        n, b = count_and_size(dest_a1)
        assert n == 1 and b == BIG_SIZE
        results.append(("2GB 大文件", "file_clip 引擎", t, BIG_SIZE / t / 1024 / 1024))
        shutil.rmtree(dest_a1)

        dest_a2 = os.path.join(tmp, "dest_ps_big")
        os.makedirs(dest_a2)
        t = bench_powershell_copyitem(big_src, dest_a2)
        n, b = count_and_size(dest_a2)
        assert n == 1 and b == BIG_SIZE
        results.append(("2GB 大文件", "Copy-Item(串行基线)", t, BIG_SIZE / t / 1024 / 1024))
        shutil.rmtree(dest_a2)
        os.unlink(big_src)

        # ---- 场景B：10,000 个 4KB 小文件 ----
        small_src = os.path.join(tmp, "small_src")
        gen_small_files(small_src)
        total_small = SMALL_COUNT * SMALL_SIZE

        dest_b1 = os.path.join(tmp, "dest_ours_small")
        t = bench_ours([small_src], dest_b1)
        n, b = count_and_size(dest_b1)
        assert n == SMALL_COUNT and b == total_small, f"{n} files, {b} bytes"
        results.append(("1万小文件", "file_clip 引擎", t, SMALL_COUNT / t))
        shutil.rmtree(dest_b1)

        dest_b2 = os.path.join(tmp, "dest_ps_small")
        os.makedirs(dest_b2)  # 目标目录必须先存在，否则 Copy-Item 会改名复制而不是复制进去
        t = bench_powershell_copyitem(small_src, dest_b2)
        n, b = count_and_size(os.path.join(dest_b2, "small_src"))
        assert n == SMALL_COUNT and b == total_small, f"{n} files, {b} bytes"
        results.append(("1万小文件", "Copy-Item(串行基线)", t, SMALL_COUNT / t))
        shutil.rmtree(dest_b2)

        dest_b3 = os.path.join(tmp, "dest_rc_small")
        t = bench_robocopy(small_src, dest_b3)
        n, b = count_and_size(dest_b3)
        assert n == SMALL_COUNT and b == total_small
        results.append(("1万小文件", "robocopy /MT:8(参照)", t, SMALL_COUNT / t))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n===== 实测结果（同一块盘 C:，源文件已在系统缓存，条件一致）=====")
    for scene, tool, t, rate in results:
        unit = "MB/s" if scene.startswith("2GB") else "文件/秒"
        print(f"{scene:10s} | {tool:22s} | {t:8.2f}s | {rate:10,.0f} {unit}")
    print()
    print("注：file_clip 对 ≥256MB 的文件用无缓冲直写（完成=数据真正落盘）；")
    print("    Copy-Item 是缓冲写（完成时数据可能还在内存里没写完），大文件项它占了缓存便宜。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
