"""打包（冻结）形态下钩子代理链路的回归测试，对应两个真机故障：

1. 勾选「系统级文件快捷键」报 WinError 2 找不到 hook_agent.c：发行包里没有也不该有 .c 源码。
2. 钩子在跑但 Ctrl+C / Ctrl+V 没反应：钩子 fork 的是
   `<后端exe> -X utf8 <hook_cli> copy-selection ...`，后端 argparse 只认 --data-dir，
   每次按键 fork 出以 exit 2 静默死掉的进程（易被误判为快捷键被抢）。
"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops import system_integration as si  # noqa: E402


# ---------- 1. 打包后没有 .c 源码，不能因此崩掉 ----------

def test_build_hook_agent_accepts_prebuilt_exe_without_source(tmp_path, monkeypatch):
    """发行包的正常形态：只有 exe，没有 .c，也没有 gcc。"""
    exe = tmp_path / "hook_agent.exe"
    exe.write_bytes(b"prebuilt")
    monkeypatch.setattr(si, "HOOK_EXE", str(exe))
    monkeypatch.setattr(si, "HOOK_SRC", str(tmp_path / "hook_agent.c"))  # 不创建

    def explode(*_a, **_k):
        raise AssertionError("打包形态下绝不该去调 gcc——用户机器上没有编译器")

    monkeypatch.setattr("core.proc.run_command", explode)

    assert si.build_hook_agent() is True


def test_build_hook_agent_reports_missing_exe_clearly(tmp_path, monkeypatch):
    """exe 也没有才是真的坏了，要报得让人看得懂，而不是去撞 gcc。"""
    monkeypatch.setattr(si, "HOOK_EXE", str(tmp_path / "hook_agent.exe"))
    monkeypatch.setattr(si, "HOOK_SRC", str(tmp_path / "hook_agent.c"))

    with pytest.raises(FileNotFoundError) as excinfo:
        si.build_hook_agent()
    # 报错必须指向 exe，不能再把用户引到一个他机器上压根不存在的 .c 上去
    assert "hook_agent.exe" in str(excinfo.value)
    assert not str(excinfo.value).endswith(".c")


def test_build_hook_agent_recompiles_when_source_is_newer(tmp_path, monkeypatch):
    """源码模式仍然要能按需重编，别把开发流程一起修没了。"""
    exe = tmp_path / "hook_agent.exe"
    src = tmp_path / "hook_agent.c"
    exe.write_bytes(b"old")
    src.write_text("int main(void){return 0;}", encoding="utf-8")
    import os
    os.utime(exe, (1_000_000, 1_000_000))
    os.utime(src, (2_000_000, 2_000_000))  # 源码更新

    monkeypatch.setattr(si, "HOOK_EXE", str(exe))
    monkeypatch.setattr(si, "HOOK_SRC", str(src))

    calls = []
    monkeypatch.setattr("core.proc.run_command", lambda cmd, *a, **k: calls.append(cmd))

    assert si.build_hook_agent() is True
    assert calls and calls[0][0] == "gcc"


# ---------- 2. 冻结后钩子命令必须能被后端认出来并转交 ----------

def _hook_argv():
    from modules.file_vault.backend_server import _hook_cli_argv
    return _hook_cli_argv


def test_frozen_hook_command_is_dispatched_to_hook_cli():
    """钩子代理实际 fork 的命令（core/fileops/c/hook_agent.c spawn_copy）去掉 exe 后必须被认出来：
    "<解释器>" -X utf8 "<cli>" copy-selection <hwnd> [--cut]"""
    _hook_cli_argv = _hook_argv()
    argv = ["-X", "utf8", si.HOOK_CLI_SENTINEL, "copy-selection", "123456"]
    assert _hook_cli_argv(argv) == ["copy-selection", "123456"]


def test_legacy_py_path_still_dispatched():
    """升级上来的机器，注册表里存的还是老的 hook_cli.py 绝对路径。"""
    _hook_cli_argv = _hook_argv()
    legacy = r"C:\Users\x\AppData\Local\Tessera\FileHook\runtime-abc\core\fileops\hook_cli.py"
    argv = ["-X", "utf8", legacy, "paste-window", "99", "--gui", "--on-conflict", "rename"]
    assert _hook_cli_argv(argv) == ["paste-window", "99", "--gui", "--on-conflict", "rename"]


def test_normal_backend_start_is_not_mistaken_for_a_hook_call():
    """普通启动（Electron 拉起后端）绝不能被误判成钩子调用。"""
    _hook_cli_argv = _hook_argv()
    assert _hook_cli_argv([]) is None
    assert _hook_cli_argv(["--data-dir", r"D:\VaultData"]) is None
    # 名字里带 hook_cli 但不是那个脚本的，也不该命中
    assert _hook_cli_argv(["--data-dir", r"D:\hook_cli.py.backup"]) is None


def test_agent_argv_uses_sentinel_only_when_frozen(monkeypatch):
    """冻结时传标记（没有 .py 可指），源码模式仍传真实脚本路径。"""
    runtime = {
        "runtime_dir": r"C:\rt",
        "hook_exe": r"C:\rt\core\fileops\c\hook_agent.exe",
        "cli_script": r"C:\rt\core\fileops\hook_cli.py",
    }

    monkeypatch.setattr(si, "_is_frozen", lambda: True)
    assert si._agent_argv(runtime)[2] == si.HOOK_CLI_SENTINEL

    monkeypatch.setattr(si, "_is_frozen", lambda: False)
    assert si._agent_argv(runtime)[2] == runtime["cli_script"]
