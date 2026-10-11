#!/usr/bin/env python
"""删除性能实测：本引擎（并行永久删除）vs Remove-Item vs cmd rd /s /q。"""

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

COUNT = 10_000


def gen(base):
    os.makedirs(base)
    blob = os.urandom(4096)
    for i in range(COUNT):
        with open(os.path.join(base, f"f{i:05d}.dat"), "wb") as f:
            f.write(blob)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="file_clip_delbench_")
    results = []
    try:
        print(f"每轮生成 {COUNT:,} 个 4KB 文件后删除…", flush=True)

        a = os.path.join(tmp, "ours"); gen(a)
        report = engine.delete_items([a], live_progress=False)
        assert report.ok and report.files_done == COUNT
        results.append(("file_clip 引擎", report.elapsed))

        b = os.path.join(tmp, "ps"); gen(b)
        cmd = (f"$t = Measure-Command {{ Remove-Item -LiteralPath '{b}' -Recurse -Force }}; "
               f"[Console]::WriteLine($t.TotalSeconds)")
        out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                             capture_output=True, text=True, check=True)
        assert not os.path.exists(b)
        results.append(("Remove-Item(串行)", float(out.stdout.strip().splitlines()[-1])))

        c = os.path.join(tmp, "rd"); gen(c)
        t0 = time.perf_counter()
        subprocess.run(["cmd", "/c", "rd", "/s", "/q", c], check=True)
        elapsed = time.perf_counter() - t0
        assert not os.path.exists(c)
        results.append(("cmd rd /s /q(参照)", elapsed))
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n===== 删除 {COUNT:,} 个文件实测 =====")
    for tool, t in results:
        print(f"{tool:20s} | {t:7.2f}s | {COUNT / t:8,.0f} 文件/秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
