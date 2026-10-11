# -*- coding: utf-8 -*-
"""生成依赖漏洞扫描快照，供应用内「安全体检」面板离线显示。

`npm audit`/`pip-audit` 要联网，所以在构建时扫一次随包发出，面板显示“上次扫描 X 天前”（过期要说明，见 security_health.py 的 dependencyFreshness）。
用法：`python scripts/make_security_snapshot.py`，写到 `modules/file_vault/security-audit-snapshot.json`。
没网或 npm 不在 PATH 时不写文件也不退出 1：缺文件让面板标“查不到”才是真相，写假的 `{"high": 0}` 才是事故。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
UI_DIR = REPO / "modules" / "file_vault" / "ui"
OUT = REPO / "modules" / "file_vault" / "security-audit-snapshot.json"


def npm_audit() -> dict:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if npm is None:
        raise RuntimeError("npm 不在 PATH 里")
    # --omit=dev：只算真正发给用户的依赖。开发依赖（vitest、playwright）的漏洞
    # 不在用户机器上运行，把它们算进"你的应用有 N 个高危漏洞"是虚报。
    proc = subprocess.run(
        [npm, "audit", "--omit=dev", "--json"],
        cwd=str(UI_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    # npm audit 有漏洞时退出码非 0，这是**正常情况**，不是失败。
    # 只有 stdout 不是合法 JSON 才算真失败。
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"npm audit 输出不是 JSON：{proc.stderr[:300]}") from exc


def main() -> int:
    try:
        report = npm_audit()
    except Exception as exc:
        print(f"[snapshot] 跳过：{exc}", file=sys.stderr)
        print("[snapshot] 不写快照。面板会把依赖两项标成「查不到」——那是此刻的真相。")
        return 0

    meta = (report.get("metadata") or {}).get("vulnerabilities") or {}
    snapshot = {
        "scannedAt": time.time(),
        "tool": "npm audit --omit=dev",
        "critical": int(meta.get("critical", 0)),
        "high": int(meta.get("critical", 0)) + int(meta.get("high", 0)),
        "moderate": int(meta.get("moderate", 0)),
        "low": int(meta.get("low", 0)),
    }
    # critical 并进 high：面板上只有"高危"一档。把 critical 单列成第三档，
    # 用户要在两个都很吓人的数字之间做区分，而他能采取的行动是同一个。
    OUT.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[snapshot] 写入 {OUT.relative_to(REPO)}：高危 {snapshot['high']} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
