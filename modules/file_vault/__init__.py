"""File Vault - multi-factor file encryption module (see modules/file_vault/README.md)."""

MODULE_META = {
    "name": "file_vault",
    "description": "Multi-factor file encryption (password/email/TOTP/machine fingerprint, any one unlocks) with an Electron + React GUI.",
    "version": "0.1.45",
}


def register(ctx):
    """Optional: called to wire this module into the app context."""


def run(ctx):
    """Entry point for `run file_vault`: launches the Electron UI in dev mode
    (`npm run dev` in ui/, which spawns backend_server.py)."""
    import os
    import shutil
    import subprocess
    from pathlib import Path

    ui_dir = Path(__file__).parent / "ui"

    # 不用 shell=True：参数虽写死，但这是坏样板，别人照写带变量的命令就成命令注入。
    # Windows 上 npm 是批处理 npm.cmd，用 shutil.which() 解析出带扩展名的完整路径即可直接执行。
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if npm is None:
        raise RuntimeError(
            "npm not found on PATH. The file_vault dev UI needs Node.js; "
            "install it from https://nodejs.org/ and reopen your terminal."
        )
    subprocess.run([npm, "run", "dev"], cwd=str(ui_dir), check=True, shell=False, env=os.environ.copy())
