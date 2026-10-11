# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：后端服务器，one-dir。

## 为什么从 one-file 改成了 one-dir

原来这里是 one-file，理由写的是"后端整个生命周期只启动一次，那一次解压的成本
可以接受，换来分发物干净"。**后半句是错的，因为这个 exe 从来不是分发物。**

它躺在 electron-builder 的 extraResources 里，被裹进外层 EXE。用户下载到的、
看到的、双击的，自始至终只有那一个外层 exe。"分发物就是一个文件"这个收益在这里
根本不存在——one-file 换来的只有成本：

  * PyInstaller 的 one-file 引导程序每次启动都要把整个包（解释器 + cryptography
    + PIL + pywin32 + sqlcipher，几十 MB）解压到 %TEMP%\\_MEIxxxxxx，然后才开始
    跑 Python。这是**每次冷启动**都付一遍，不是只付一次。
  * 解压出来的每一个文件都会被 Defender 实时扫描。这通常比解压本身还慢，而且在
    机械硬盘或者装了第三方杀软的机器上会放大好几倍——同一个包在不同人机器上
    "启动要几秒"的差距主要来自这里。
  * 后端起不来，登录界面就拿不到 identity_exists 的结果，用户看到的是一个白屏。
    也就是说这段解压时间**全部落在用户的可感知等待里**。

one-dir 把这些成本降到零：文件已经在磁盘上摊开，引导程序直接加载。

对**安装版**来说这是纯赚——文件在安装时就写好了，启动零解压。对**免安装版**
来说，外层 portable 启动器本来就要把 resources 铺到临时目录，one-dir 只是把
"铺完再解压一次"变成"铺完直接用"，仍然是净赚。

代价只有一个：dist/ 下从一个 exe 变成一个目录。构建脚本和 electron-builder 的
extraResources 各改一行就完事，用户看不到任何区别。

> **打包形态要按调用频率选，不是全项目统一。** 这句判断本身是对的——只是"后端
> 只启动一次"推不出"可以接受解压"，因为那一次正好卡在用户盯着屏幕等的时候。
> file_hook_worker 同样是 one-dir，理由是高频调用；两个 spec 现在结论一致，
> 但推理路径不同。

构建（必须在 Windows x64 上跑）：
    pyinstaller --clean --noconfirm packaging/file_vault_backend.spec

产出：dist/file_vault_backend/file_vault_backend.exe（**目录**，不是单文件）
"""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# spec 文件执行时 __file__ 不可用，SPECPATH 是 PyInstaller 注入的
PROJECT_ROOT = Path(SPECPATH).resolve().parent  # noqa: F821
VAULT = PROJECT_ROOT / "modules" / "file_vault"

# --- hidden imports ------------------------------------------------------
# PyInstaller 靠静态分析 import 语句来决定打包什么。下面这些都是**动态**加载的，
# 静态分析看不见，不显式声明就会在冻结后运行时才报 ModuleNotFoundError——而且
# 往往是某个功能第一次被用到时才炸，不是启动就炸，很难在冒烟测试里发现。

hiddenimports = []

# keyring 用 entry point 发现后端实现，源码里没有任何一句 import 指向具体后端。
# 少了它的后果最严重：应用能启动、能显示登录界面，但解锁时读不到凭据——用户看到
# 的是"密码怎么输都不对"。
hiddenimports += collect_submodules("keyring.backends")
hiddenimports += ["keyring.backends.Windows", "win32timezone"]

# pywin32：win32api/win32con/win32gui 等在源码里是直接 import 的（静态可见），
# 但它们依赖的 pythoncom/pywintypes 是通过 DLL 动态加载的。
hiddenimports += ["win32api", "win32con", "win32gui", "win32clipboard", "win32process", "pythoncom", "pywintypes"]

# cryptography 的后端实现通过 cffi 绑定动态加载
hiddenimports += collect_submodules("cryptography.hazmat.bindings")

# sqlcipher3 的 C 扩展
hiddenimports += ["sqlcipher3", "sqlcipher3.dbapi2"]

# 其余运行时依赖。
#
# 曾经这里还列着 "websocket" 和 "websockets"。全仓 Python 源码里没有任何一句
# import 指向它们——那是某个后来被换掉的实现留下的。hiddenimports 里挂一个没人
# 用的包，PyInstaller 会老老实实把它连同依赖一起打进去：产物变大、启动时要多加载
# 一批模块，而且没有任何东西会报错提醒你。删了。
hiddenimports += ["pyotp", "qrcode", "PIL", "PIL.Image"]

# 本项目自己的模块也要全收：backend_server 里有一部分是按需 import 的，
# 而 modules/ 下的模块发现机制（core/registry.py）本身就是动态的。
#
# **测试包必须在这里就滤掉，不能只靠下面的 excludes。** collect_submodules 会把
# modules/file_vault/tests/ 下那 66 个 test_*.py 一并收进 hiddenimports，而 excludes
# 又把它们排除掉——两条规则互相打架的结果是 PyInstaller 对每一个都打印一行
#
#     ERROR: Hidden import 'modules.file_vault.tests.test_xxx' not found
#
# 产物本身是对的（测试确实没被打进去），所以这 66 行**从来不会让构建失败**。
# 危险在别处：本文件开头那段注释说得很清楚，漏掉一个 hiddenimport 的后果是冻结后
# 某个功能第一次被用到时才炸。而那种情况下 PyInstaller 打印的正是同一句 ERROR ——
# 一行真的警告混在 66 行假的里面，没有人会发现。滤掉之后这类 ERROR 归零，
# 再出现一行就一定是真的。
def _not_a_test_module(name):
    return ".tests." not in name and not name.endswith(".tests")


hiddenimports += collect_submodules("modules.file_vault", filter=_not_a_test_module)
hiddenimports += collect_submodules("core", filter=_not_a_test_module)

# --- 数据文件与原生资源 ---------------------------------------------------
# 路径要跟 runtime_resources.resource_path() 的期望一致：相对仓库根。
datas = [
    (str(PROJECT_ROOT / "core" / "fileops" / "c" / "hook_agent.exe"), "core/fileops/c"),
    (str(PROJECT_ROOT / "core" / "fileops" / "hook_cli.py"), "core/fileops"),
    (str(VAULT / "c" / "fingerprint_verify.exe"), "modules/file_vault/c"),
    # 依赖漏洞扫描快照。安全体检面板离线显示它——扫描要联网，所以在打包时做一次，
    # 结果随包发出去（生成脚本：scripts/make_security_snapshot.py）。
    # 漏掉这一条不会让构建失败，只会让那一屏的两项永远显示"查不到"。
    (str(VAULT / "security-audit-snapshot.json"), "modules/file_vault"),
]
# 可选的 UIA 辅助脚本——缺了不影响主流程，所以逐个判断存在性而不是硬列。
#
# **fingerprint_verify.ps1 已从这里移除**：指纹验证走的是 C 助手
# fingerprint_verify.exe（见 modules/file_vault/fingerprint.py），那个 .ps1 是更早
# 一版 PowerShell 实现的遗留物，代码里已经没有任何地方引用它。把一个没人调用的
# PowerShell 脚本继续打进安装包，除了徒增体积和攻击面之外没有任何作用。
for optional in [
    PROJECT_ROOT / "core" / "fileops" / "c" / "ui_scan_agent.ps1",
]:
    if optional.exists():
        datas.append((str(optional), str(optional.parent.relative_to(PROJECT_ROOT)).replace("\\", "/")))

datas += collect_data_files("keyring")
datas += collect_data_files("certifi")

# data/ 绝不打包：里面是用户的实时金库（身份/密码）和 ~300MB 的 VS Code 模板。
# 用户数据跟着用户走（见 data_dir.py），不跟着程序走。
# **tkinter 必须打进去，不能排除。**
#
# 曾经它在这个列表里，结果是：装好的应用一按 Delete 或 Ctrl+V（走系统级文件
# 快捷键那条路）就弹一个 "Failed to execute script 'backend_server' ...
# No module named 'tkinter'" 的崩溃框。
#
# 原因是钩子助手是**独立进程**，跟 Electron 界面无关——它要在应用没开的时候
# 也能弹进度窗和"永久删除确认"，所以 core/fileops/progress_ui.py 自己用 tkinter
# 画这些窗口（共 4 处依赖）。把 tkinter 排掉就等于把整条钩子 GUI 路径打断了，
# 而这条路径恰恰是在用户按下快捷键的那一刻才被触发，打包时完全看不出来。
#
# 代价是安装包大约多 10 MB（Tcl/Tk 运行时）。这个代价必须付：没有它，
# "系统级文件快捷键"这个功能整个不可用。
excludes = [
    "matplotlib",
    "pytest",
    "modules.file_vault.tests",
]


a = Analysis(  # noqa: F821
    [str(VAULT / "backend_server.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # one-dir 的关键：二进制留给下面的 COLLECT
    name="file_vault_backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX 压缩过的 exe 是 Defender 误报的重灾区，体积换来的麻烦不值
    console=False,  # 后端通过 stdio 跟 Electron 通信，不要弹控制台窗口
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
    name="file_vault_backend",
)
