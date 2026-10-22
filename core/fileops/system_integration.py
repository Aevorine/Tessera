"""C 钩子代理的编译/启动/停止/自启动管理。
CLI 脚本路径参数化，file_clip 与 file_vault 共用（C 侧 mutex 保证单实例）。"""

import os
import hashlib
import shutil
import subprocess
import time as _time
import winreg
from pathlib import Path

# C 钩子代理自己的注册表 Run 键名，独立于 file_vault 本体：后者退出它仍在跑，
# 自启靠注册表而非 file_vault 进程生命周期。
AUTOSTART_VALUE_NAME = "Ideal1FileVaultFileHook"
AUTOSTART_APPROVED_KEY = (
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
)

# 冻结（PyInstaller）版没有 .py 可指，改传此标记，由 backend_server._hook_cli_argv() 转交
# hook_cli；源码模式仍传真实路径。两者都要支持：老用户注册表里存的是旧 .py 路径。
HOOK_CLI_SENTINEL = "--hook-cli"

HOOK_EXE_DIR = Path(__file__).resolve().parent / "c"
HOOK_EXE = str(HOOK_EXE_DIR / "hook_agent.exe")
HOOK_SRC = str(HOOK_EXE_DIR / "hook_agent.c")
_HOOK_EXE_RELATIVE = ("fileops", "c", "hook_agent.exe")
UI_SCAN_PS1 = str(HOOK_EXE_DIR / "ui_scan_agent.ps1")
# 默认关闭，需显式写入"开"标记才启用：原生按钮的鼠标钩子在真机上仍会间歇崩掉
# hook_agent.exe（连带键盘快捷键），根因未钉死。OFF_MARKER 常量名保留以兼容旧的
# 手动关闭标记文件，ON_MARKER 才是当前生效依据。
NATIVE_BUTTONS_OFF_MARKER = os.path.join(os.environ.get("TEMP", ""), "file_clip_native_buttons_off")
NATIVE_BUTTONS_ON_MARKER = os.path.join(os.environ.get("TEMP", ""), "file_clip_native_buttons_on")
RUNTIME_DIR_NAME = "FileHook"
RUNTIME_PARENT_NAME = "Tessera"

# 一次 provision 是秒级的；中间目录活到这个岁数还在，就是上一次没收拾干净的死物，
# 不可能是别的进程正在用的。见 _sweep_runtime_leftovers。
_LEFTOVER_MIN_AGE_S = 10 * 60


class HookAgentMissingError(FileNotFoundError):
    """所有随包分发的 hook_agent.exe 副本都不在了。"""


def hook_exe_candidates() -> list:
    """按优先级列出发行包里 hook_agent.exe 可能的位置。

    安装包带两份相同副本（冻结后端 resources/backend/ 与 filehook worker resources/filehook/），
    必须都认：曾有一份被安全软件删除，只认后端那份会误报"发行包应当自带它"。
    """
    import sys as _sys

    candidates = [Path(HOOK_EXE)]
    if _is_frozen():
        # sys.executable = resources/<backend|filehook>/<bundle>/<bundle>.exe
        resources = Path(_sys.executable).resolve().parent.parent.parent
        for bundle in (
            ("backend", "file_vault_backend"),
            ("filehook", "file_hook_worker"),
        ):
            candidates.append(resources.joinpath(*bundle, "_internal", "core", *_HOOK_EXE_RELATIVE))
    unique = []
    seen = set()
    for candidate in candidates:
        key = os.path.normcase(str(candidate))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def _missing_hook_message(checked) -> str:
    listed = "；".join(str(p) for p in checked)
    return (
        f"钩子代理 hook_agent.exe 在随包分发的位置都找不到（已检查：{listed}）。"
        "安装包自带这个文件，它消失最常见的原因是被安全软件（360、腾讯电脑管家、"
        "Windows 安全中心等）当作键盘监控程序隔离或删除。请在安全软件的隔离区里恢复它"
        "并把 Tessera 安装目录加入信任，或重新安装 Tessera。"
    )


def resolve_hook_exe() -> Path:
    """返回第一个真实存在的 hook_agent.exe；一个都没有就抛 HookAgentMissingError。"""
    candidates = hook_exe_candidates()
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise HookAgentMissingError(_missing_hook_message(candidates))


def build_hook_agent() -> bool:
    """确保 C 钩子代理可用；仅源码在且比 exe 新（或 exe 缺失）时才编译。

    打包后的应用没有 .c 源码也没有 gcc，只带编译好的 hook_agent.exe。所以：源码在=开发模式，按需编译；
    源码不在=任一随包副本（见 hook_exe_candidates）可用，全无才报错。不可无条件 stat() 源码，否则
    打包版会抛指向 .c 文件的 FileNotFoundError。
    """
    exe = Path(HOOK_EXE)
    src = Path(HOOK_SRC)

    if not src.is_file():
        resolve_hook_exe()
        return True

    if exe.is_file() and exe.stat().st_mtime >= src.stat().st_mtime:
        return True

    from core.proc import run_command

    run_command([
        "gcc", "-O2", "-municode", "-mwindows",
        "-o", HOOK_EXE, HOOK_SRC, "-luser32", "-lshell32",
    ])
    return True


def _default_install_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / RUNTIME_PARENT_NAME / RUNTIME_DIR_NAME
    return Path.home() / "AppData" / "Local" / RUNTIME_PARENT_NAME / RUNTIME_DIR_NAME


def _runtime_digest(source_core: Path, hook_exe_source=None) -> str:
    """runtime 目录名里的内容哈希。

    给出 ``hook_exe_source`` 时它顶替 ``core/fileops/c/hook_agent.exe`` 参与哈希且位置不变；
    与源树那份相同时结果同不传，已部署的 runtime 照常复用。
    """
    hook_target = source_core.joinpath(*_HOOK_EXE_RELATIVE)
    entries = {}
    for file_path in source_core.rglob("*"):
        if not file_path.is_file():
            continue
        if "__pycache__" in file_path.parts or file_path.suffix in {".pyc", ".pyo"}:
            continue
        entries[file_path] = file_path
    if hook_exe_source is not None:
        entries = {k: v for k, v in entries.items() if os.path.normcase(str(k)) != os.path.normcase(str(hook_target))}
        entries[hook_target] = Path(hook_exe_source)

    digest = hashlib.sha256()
    for logical_path in sorted(entries):
        relative = logical_path.relative_to(source_core).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "little"))
        digest.update(relative)
        with entries[logical_path].open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()[:16]


def _sweep_runtime_leftovers(root: Path) -> None:
    """清理上次没删干净的中间目录（`.retired-*`、过期的 `.runtime-*.staging`）。

    退位时 hook_agent.exe 常仍被映射而删不掉，不能让开启快捷键失败，也不能放着不管。
    全程 best-effort，清理失败不得影响主流程。必须卡 mtime：新的 staging 可能正被另一个
    provision 写入，无条件删会抽走它的目录；超过 _LEFTOVER_MIN_AGE_S 的必然是死的。
    """
    cutoff = _time.time() - _LEFTOVER_MIN_AGE_S
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith((".retired-", ".runtime-")):
            continue
        try:
            if not entry.is_dir() or entry.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(entry, ignore_errors=True)


def _registered_runtime_dir():
    """注册表 Run 项此刻指向的 runtime 目录（没注册或解析不了返回 None）。"""
    value = get_autostart_value()
    if not value or not value.startswith('"'):
        return None
    exe = value[1:].split('"', 1)[0]
    parts = Path(exe).parts
    for index, part in enumerate(parts):
        if part.lower().startswith("runtime-"):
            return Path(*parts[: index + 1])
    return None


def _prune_stale_runtimes(root: Path, keep) -> None:
    """删除旧版本留下的 ``runtime-*`` 目录（每份不同的 core/ 内容都会部署一份几十 MB）。

    先删其中的 hook_agent.exe 判断是否在用：Windows 上运行中的映像删不掉，删得掉即无进程
    在用，整目录可清，删不掉就原样保留。无条件保留 ``keep``（本次要用的、注册表 Run 项指向的），
    并卡 mtime 避开别的进程刚部署的目录。best-effort，不影响主流程。
    """
    keep_keys = {os.path.normcase(str(Path(p))) for p in keep if p}
    cutoff = _time.time() - _LEFTOVER_MIN_AGE_S
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith("runtime-") or os.path.normcase(str(entry)) in keep_keys:
            continue
        try:
            if not entry.is_dir() or entry.stat().st_mtime > cutoff:
                continue
            hook = entry.joinpath("core", *_HOOK_EXE_RELATIVE)
            if hook.exists():
                hook.unlink()
        except OSError:
            continue
        shutil.rmtree(entry, ignore_errors=True)


# 杀毒软件 / 索引器扫描刚复制出的 exe 时会短暂持有句柄，目录改名随之 WinError 5。
_RENAME_RETRY_DELAYS_S = (0.0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.2)


def _replace_with_retry(src: Path, dst: Path) -> None:
    """os.replace 遇 PermissionError 时退避重试（Git mingw_rename / graceful-fs 同法）。"""
    for attempt, delay in enumerate(_RENAME_RETRY_DELAYS_S):
        if delay:
            _time.sleep(delay)
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if dst.exists() or attempt == len(_RENAME_RETRY_DELAYS_S) - 1:
                raise


def _copy_into_place(staging: Path, runtime_dir: Path, hook_exe: Path, cli_script: Path) -> None:
    """改名始终被拒时逐文件复制进目标；两个关键文件最后写，保证「二者都在 = 完整」。"""
    staged_core = staging / "core"
    keys = {
        os.path.normcase(str(staged_core.joinpath(*_HOOK_EXE_RELATIVE))): hook_exe,
        os.path.normcase(str(staged_core / "fileops" / "hook_cli.py")): cli_script,
    }
    deferred = []
    for src in staged_core.rglob("*"):
        if src.is_dir():
            continue
        dst = runtime_dir / "core" / src.relative_to(staged_core)
        if os.path.normcase(str(src)) in keys:
            deferred.append((src, dst))
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    for src, dst in sorted(deferred, key=lambda pair: pair[1] == hook_exe):
        dst.parent.mkdir(parents=True, exist_ok=True)
        part = dst.with_name(dst.name + f".{os.getpid()}.part")
        shutil.copy2(src, part)
        _replace_with_retry(part, dst)


def _publish_runtime(staging: Path, runtime_dir: Path, hook_exe: Path, cli_script: Path) -> None:
    """把备好的 staging 目录搬到 runtime_dir，目标已存在、或目录改名被拒时也要成立。

    `os.replace()` 换不掉已存在的目录：Windows 抛 PermissionError（WinError 5），POSIX 抛
    ENOTEMPTY/EEXIST。目标完整 = 别的进程抢先装好了，丢掉自己这份；目标残缺 = 先改名挪走再删。
    目标不存在仍被拒 = 句柄被临时占用，退避重试后改为逐文件复制。
    """
    try:
        _replace_with_retry(staging, runtime_dir)
        return
    except OSError:
        if not runtime_dir.exists():
            _copy_into_place(staging, runtime_dir, hook_exe, cli_script)
            shutil.rmtree(staging, ignore_errors=True)
            return

    if hook_exe.is_file() and cli_script.is_file():
        shutil.rmtree(staging, ignore_errors=True)
        return

    retired = runtime_dir.with_name(f".retired-{runtime_dir.name}-{os.getpid()}-{int(_time.time())}")
    try:
        _replace_with_retry(runtime_dir, retired)
    except OSError:
        _copy_into_place(staging, runtime_dir, hook_exe, cli_script)
        shutil.rmtree(staging, ignore_errors=True)
        return
    try:
        _replace_with_retry(staging, runtime_dir)
    except OSError:
        _replace_with_retry(retired, runtime_dir)
        _copy_into_place(staging, runtime_dir, hook_exe, cli_script)
        shutil.rmtree(staging, ignore_errors=True)
        return
    shutil.rmtree(retired, ignore_errors=True)


def provision_runtime(source_core_dir=None, install_root=None, hook_exe_source=None) -> dict:
    """Copy the hook helper to a versioned, stable LocalAppData directory.

    The portable app runs from an extraction dir that may vanish, so a login item must never
    reference its ``__file__`` paths; versioned dirs also let updates install while an old
    exe is mapped.
    源树里的 hook_agent.exe 不在时默认改用随包副本；显式传 ``source_core_dir`` 则只认那棵树，
    除非同时给出 ``hook_exe_source``。
    """
    source_core = Path(source_core_dir or Path(__file__).resolve().parent.parent)
    root = Path(install_root or _default_install_root())
    _sweep_runtime_leftovers(root)

    in_tree_hook = source_core.joinpath(*_HOOK_EXE_RELATIVE)
    if hook_exe_source is None and source_core_dir is None and not in_tree_hook.is_file():
        hook_exe_source = resolve_hook_exe()
    if hook_exe_source is not None and os.path.normcase(str(Path(hook_exe_source))) == os.path.normcase(str(in_tree_hook)):
        hook_exe_source = None

    version = _runtime_digest(source_core, hook_exe_source)
    runtime_dir = root / f"runtime-{version}"
    target_core = runtime_dir / "core"
    hook_exe = target_core.joinpath(*_HOOK_EXE_RELATIVE)
    cli_script = target_core / "fileops" / "hook_cli.py"

    if not hook_exe.is_file() or not cli_script.is_file():
        root.mkdir(parents=True, exist_ok=True)
        # 每次唯一：上一次被占用而没删净的 staging 不能挡住这一次。
        staging = root / f".runtime-{version}-{os.getpid()}-{_time.time_ns()}.staging"
        try:
            shutil.copytree(
                source_core,
                staging / "core",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
            )
            staged_hook = staging.joinpath("core", *_HOOK_EXE_RELATIVE)
            if hook_exe_source is not None:
                staged_hook.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(hook_exe_source, staged_hook)
            staged_cli = staging / "core" / "fileops" / "hook_cli.py"
            if not staged_hook.is_file() or not staged_cli.is_file():
                raise RuntimeError("file hook runtime is incomplete")
            _publish_runtime(staging, runtime_dir, hook_exe, cli_script)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    _prune_stale_runtimes(root, keep=(runtime_dir, _registered_runtime_dir()))

    return {
        "runtime_dir": str(runtime_dir),
        "hook_exe": str(hook_exe),
        "cli_script": str(cli_script),
    }


def _coerce_runtime_paths(runtime_paths=None) -> dict:
    if isinstance(runtime_paths, (str, Path)):
        return {
            "runtime_dir": str(Path(runtime_paths).resolve().parent.parent.parent),
            "hook_exe": HOOK_EXE,
            "cli_script": str(runtime_paths),
        }
    if runtime_paths is None:
        return provision_runtime()
    return runtime_paths


def _is_frozen() -> bool:
    import sys as _sys
    return bool(getattr(_sys, "frozen", False))


def _pyw_path() -> str:
    import sys as _sys
    if _is_frozen():
        # 冻结版：没有 pythonw.exe，钩子直接拉起后端自身，
        # 由 backend_server._hook_cli_argv() 分发到 hook_cli。
        return _sys.executable
    pyw = Path(_sys.executable).with_name("pythonw.exe")
    return str(pyw) if pyw.exists() else _sys.executable


def _cli_target(runtime_paths: dict) -> str:
    """钩子命令里的第二个参数：冻结版给标记，源码模式给 hook_cli.py 的真实路径。"""
    return HOOK_CLI_SENTINEL if _is_frozen() else runtime_paths["cli_script"]


def _agent_argv(runtime_paths: dict, on_conflict: str = "rename") -> list[str]:
    """Build one unambiguous helper command for live start and Windows Run."""
    return [
        runtime_paths["hook_exe"],
        _pyw_path(),
        _cli_target(runtime_paths),
        on_conflict,
        UI_SCAN_PS1 if native_buttons_enabled() else "",
        str(hook_status_path()),
    ]


# 自定义键位配置（hook_agent.exe 启动时读一次）：与坐标缓存同样放在 %TEMP% 的固定文件名，
# C 侧和 Python 侧解析同一用户的 %TEMP%，天然对上。
SHORTCUT_CONFIG_BASENAME = "file_clip_shortcuts.txt"
HOOK_STATUS_BASENAME = "file_clip_hook_status.txt"
# 五个文件操作共用同一份设置，确保资源管理器和应用内文件管理器的快捷键语义一致。
HOOK_SHORTCUT_ACTIONS = ("copy", "cut", "paste", "delete_recycle", "delete_permanent")
_VK_DELETE = 0x2E


def shortcut_config_path() -> str:
    import tempfile
    return os.path.join(tempfile.gettempdir(), SHORTCUT_CONFIG_BASENAME)


def hook_status_path() -> Path:
    """Return the C helper's cross-process startup diagnostic file."""
    return _default_install_root() / HOOK_STATUS_BASENAME


def read_hook_diagnostic() -> dict:
    """Read the last helper lifecycle state without treating stale data as healthy."""
    try:
        parts = hook_status_path().read_text(encoding="ascii").strip().split()
    except OSError:
        return {"state": "unknown", "last_error": None}
    if not parts:
        return {"state": "unknown", "last_error": None}
    state = parts[0]
    if state == "failed" and len(parts) > 1 and parts[1].isdigit():
        return {"state": "failed", "last_error": f"win32:{parts[1]}"}
    return {"state": state, "last_error": None}


def _clear_hook_diagnostic() -> None:
    try:
        hook_status_path().unlink()
    except FileNotFoundError:
        pass


def _binding_to_vk(binding: dict):
    """把 ui_settings 里的键名映射成 Windows 虚拟键码，映射不了返回 None。
    键名为单个字母/数字或 "Delete"。"""
    key = str(binding.get("key", ""))
    if key.lower() == "delete":
        return _VK_DELETE
    if len(key) == 1 and key.isascii() and key.isalnum():
        return ord(key.upper())
    return None


def write_shortcut_config(shortcuts: dict, config_path: str = None) -> str:
    """把保存的文件操作快捷键写成 hook_agent.exe 的键位配置（原子替换）。
    行格式 "动作名 VK码 ctrl alt shift"（ASCII）；无法映射的跳过，C 侧对缺失动作用内置默认。
    写完需重启代理才生效（C 侧不热加载）。"""
    path = config_path or shortcut_config_path()
    lines = []
    for action in HOOK_SHORTCUT_ACTIONS:
        binding = shortcuts.get(action) if isinstance(shortcuts, dict) else None
        if not isinstance(binding, dict):
            continue
        vk = _binding_to_vk(binding)
        if vk is None:
            continue
        lines.append("%s %d %d %d %d" % (
            action, vk,
            1 if binding.get("ctrl") else 0,
            1 if binding.get("alt") else 0,
            1 if binding.get("shift") else 0,
        ))
    tmp_path = path + ".part"
    with open(tmp_path, "w", encoding="ascii") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(tmp_path, path)
    return path


def native_buttons_enabled() -> bool:
    """原生工具栏/右键菜单图标行的粘贴删除按钮接管是否该启用。默认关闭
    （见上面 NATIVE_BUTTONS_ON_MARKER 的注释）——只看 ON 标记存不存在。"""
    return os.path.exists(UI_SCAN_PS1) and os.path.exists(NATIVE_BUTTONS_ON_MARKER)


def _any_hook_exe():
    """任一份可运行的 hook_agent.exe，用来发 --status / --stop。

    这两条命令走命名互斥体/事件，与哪份 exe 在跑无关；固定用安装目录那份的话，它被删后
    状态永远显示没在跑、也停不掉，而钩子仍在接管 Ctrl+V。
    """
    for candidate in hook_exe_candidates():
        if candidate.is_file():
            return str(candidate)
    registered = _registered_runtime_dir()
    if registered is not None:
        hook = registered.joinpath("core", *_HOOK_EXE_RELATIVE)
        if hook.is_file():
            return str(hook)
    return None


def is_running(hook_exe=None) -> bool:
    """Check the named hook instance, not merely any same-named process."""
    exe = str(hook_exe) if hook_exe and os.path.exists(str(hook_exe)) else _any_hook_exe()
    if not exe:
        return False
    try:
        probe = subprocess.run(
            [exe, "--status"],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=2,
        )
        if probe.returncode in (0, 1):
            return probe.returncode == 0
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq hook_agent.exe", "/NH"],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=2,
        ).stdout
        return "hook_agent.exe" in out
    except Exception:
        return False


def start_agent(runtime_paths=None, on_conflict: str = "rename") -> None:
    """启动 C 钩子代理（无窗口后台进程）。重复启动无害：C 侧 mutex 保证单实例。"""
    runtime = _coerce_runtime_paths(runtime_paths)
    hook_exe = runtime["hook_exe"]
    cli_script = runtime["cli_script"]
    if not os.path.exists(hook_exe):
        raise RuntimeError(f"hook_agent.exe 不存在：{hook_exe}，请先执行 build_hook_agent()")

    argv = _agent_argv(runtime, on_conflict=on_conflict)

    last = None
    for _ in range(5):
        try:
            _clear_hook_diagnostic()
            subprocess.Popen(
                argv,
                cwd=runtime["runtime_dir"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            for _ in range(20):
                if is_running(hook_exe):
                    return
                _time.sleep(0.1)
            diagnostic = read_hook_diagnostic()
            detail = diagnostic["last_error"] or diagnostic["state"]
            if not os.path.exists(hook_exe):
                raise HookAgentMissingError(_missing_hook_message([Path(hook_exe)]))
            raise RuntimeError(
                f"hook_agent.exe started but did not become healthy ({detail})；"
                "如果装有 360、腾讯电脑管家等安全软件，请确认它没有拦截 Tessera 的键盘钩子"
            )
        except PermissionError as exc:
            last = exc
            _time.sleep(0.4)
    if last is not None:
        raise last


def stop_agent(runtime_paths=None) -> bool:
    """向运行中的钩子代理发送退出信号。返回是否成功（True=成功停下或本来就不在跑）。"""
    runtime = _coerce_runtime_paths(runtime_paths) if runtime_paths is not None else None
    hook_exe = runtime["hook_exe"] if runtime else None
    if not hook_exe or not os.path.exists(hook_exe):
        hook_exe = _any_hook_exe()
    if not hook_exe:
        return not is_running()
    rc = subprocess.run([hook_exe, "--stop"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode
    return rc == 0 or not is_running(hook_exe)


def restart_agent(runtime_paths=None, on_conflict: str = "rename") -> None:
    """停止已运行的实例（如有）再启动。

    C 侧用命名 mutex 保证单实例，只调 start_agent() 时新进程会静默退出，旧实例带着旧配置
    继续跑。凡需让配置变更生效的调用点都应用本函数，不要直接调 start_agent()。
    """
    runtime = _coerce_runtime_paths(runtime_paths)
    if is_running(runtime["hook_exe"]):
        stop_agent()
        _time.sleep(0.3)
    start_agent(runtime, on_conflict=on_conflict)


def get_autostart() -> bool:
    """只有 Run 命令已注册且 Windows 未禁用该项，才算开启自启动。"""
    return bool(get_autostart_value()) and _autostart_approved()


def _autostart_approved() -> bool:
    """Read the same startup approval flag used by Task Manager."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_APPROVED_KEY) as key:
            value, kind = winreg.QueryValueEx(key, AUTOSTART_VALUE_NAME)
    except FileNotFoundError:
        return True  # No approval entry means the registered Run item is enabled.
    except OSError:
        return False
    return kind == winreg.REG_BINARY and bool(value) and (value[0] & 1) == 0


def _set_autostart_approved(enabled: bool) -> None:
    """Explicit enable/disable must also update Windows startup approval."""
    value = bytes([2 if enabled else 3]) + bytes(11)
    with winreg.CreateKeyEx(
        winreg.HKEY_CURRENT_USER, AUTOSTART_APPROVED_KEY, 0, winreg.KEY_SET_VALUE
    ) as key:
        winreg.SetValueEx(key, AUTOSTART_VALUE_NAME, 0, winreg.REG_BINARY, value)


def get_autostart_value():
    """Return the exact Run command, or ``None`` when not registered."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
        ) as k:
            value, _ = winreg.QueryValueEx(k, AUTOSTART_VALUE_NAME)
            return value or None
    except OSError:
        return None


def _autostart_value(runtime_paths: dict) -> str:
    return " ".join(f'"{arg}"' for arg in _agent_argv(runtime_paths))


def set_autostart(enabled: bool, runtime_paths=None) -> None:
    """注册/删除系统级文件快捷键的自启动项（HKCU Run）。
    值为 hook_agent.exe 完整命令行，开机不依赖 file_vault。"""
    runtime = _coerce_runtime_paths(runtime_paths) if enabled else None
    # Do not include UI_SCAN_PS1: login startup enables only the stable
    # keyboard path. The experimental mouse-hook path remains opt-in.
    value = _autostart_value(runtime) if runtime else ""

    key = winreg.HKEY_CURRENT_USER
    sub_key = r"Software\Microsoft\Windows\CurrentVersion\Run"
    if enabled:
        with winreg.CreateKeyEx(key, sub_key, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, AUTOSTART_VALUE_NAME, 0, winreg.REG_SZ, value)
        _set_autostart_approved(True)
    else:
        try:
            with winreg.OpenKey(key, sub_key, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, AUTOSTART_VALUE_NAME)
        except OSError:
            pass  # 本来就没写这条注册表值，不算错误
        _set_autostart_approved(False)


def get_status(runtime_paths=None) -> dict:
    """一站式查询：编译状态 + 进程是否在跑 + 自启动是否注册。"""
    runtime = _coerce_runtime_paths(runtime_paths) if runtime_paths is not None else None
    running = is_running(runtime["hook_exe"] if runtime else None)
    diagnostic = read_hook_diagnostic()
    if running:
        diagnostic = {"state": "running", "last_error": None}
    elif diagnostic["state"] == "unknown":
        diagnostic = {"state": "stopped", "last_error": None}
    available_exe = runtime["hook_exe"] if runtime else _any_hook_exe()
    return {
        "compiled": bool(available_exe),
        "running": running,
        "autostart": get_autostart(),
        "exe_path": available_exe or HOOK_EXE,
        "source_path": HOOK_SRC,
        "cli_script": runtime["cli_script"] if runtime else "",
        **diagnostic,
    }


def reconcile_autostart() -> dict:
    """Repair an enabled login hook after app restart or helper update."""
    if not get_autostart():
        return get_status()
    runtime = provision_runtime()
    expected_value = _autostart_value(runtime)
    if get_autostart_value() != expected_value:
        restart_agent(runtime, on_conflict="rename")
    elif not is_running(runtime["hook_exe"]):
        start_agent(runtime, on_conflict="rename")
    # Re-write the value so portable-app temp paths and old versions are
    # repaired even when the old registration still exists.
    set_autostart(True, runtime)
    status = get_status(runtime)
    status["autostart"] = True
    return status
