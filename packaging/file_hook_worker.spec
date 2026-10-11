# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：全局快捷键 worker，one-dir。

**为什么这个必须是 one-dir，而后端可以是 one-file**：

hook_agent.exe 每次捕获到 Ctrl+V / Delete / Shift+Delete 就会拉起一次这个 worker。
one-file 的运行方式是"每次启动都把整个解释器 + 依赖解压到临时目录，跑完再删"——
几十 MB 的解压对一次按键来说是几百毫秒到几秒的延迟，而且用户按得越快堆积越多。
one-dir 直接执行已经展开好的文件，启动成本就是一次正常的 Python 解释器启动。

这就是"打包形态按调用频率选"的具体含义：同一个项目里，启动一次的用 one-file 换
分发干净，高频调用的用 one-dir 换启动速度。

产物是一个目录，由 electron-builder 作为 extraResources 整个塞进 portable EXE，
再由应用在首次运行时按内容哈希部署到 %LOCALAPPDATA%\\Tessera\\FileHook\\
runtime-<digest>\\ —— **注册表 Run 项只能指向那个稳定路径**，绝不能指向 portable
EXE 的临时 resourcesPath（每次启动都变，下次开机就不存在了）。见
data_dir.py::file_hook_runtime_root 的注释。

构建（必须在 Windows x64 上跑）：
    pyinstaller --clean --noconfirm packaging/file_hook_worker.spec
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

PROJECT_ROOT = Path(SPECPATH).resolve().parent  # noqa: F821

hiddenimports = [
    "win32api",
    "win32con",
    "win32gui",
    "win32clipboard",
    "win32process",
    "pythoncom",
    "pywintypes",
]
hiddenimports += collect_submodules("core.fileops")

# worker 只做文件操作，不碰金库——不需要 sqlcipher/keyring/cryptography 那一套。
# 刻意保持这个依赖面最小：它是被高频拉起的进程，装的东西越少启动越快，而且
# 它本来就不该有能力读用户的加密数据（最小权限）。
datas = [
    (str(PROJECT_ROOT / "core" / "fileops" / "c" / "hook_agent.exe"), "core/fileops/c"),
]
for optional in [PROJECT_ROOT / "core" / "fileops" / "c" / "ui_scan_agent.ps1"]:
    if optional.exists():
        datas.append((str(optional), "core/fileops/c"))

a = Analysis(  # noqa: F821
    [str(PROJECT_ROOT / "core" / "fileops" / "hook_cli.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest", "sqlcipher3", "keyring", "cryptography", "PIL"],
    noarchive=False,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # one-dir 的关键：二进制留给下面的 COLLECT
    name="file_hook_worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    target_arch="x64",
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="file_hook_worker",
)
