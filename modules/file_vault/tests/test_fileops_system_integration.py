import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops import system_integration as si


def _fake_core_tree(tmp_path: Path) -> Path:
    core = tmp_path / "source" / "core"
    fileops = core / "fileops"
    c_dir = fileops / "c"
    c_dir.mkdir(parents=True)
    (core / "__init__.py").write_text("", encoding="utf-8")
    (core / "logging.py").write_text("VALUE = 'logging'\n", encoding="utf-8")
    (fileops / "__init__.py").write_text("", encoding="utf-8")
    (fileops / "hook_cli.py").write_text("VALUE = 'cli'\n", encoding="utf-8")
    (fileops / "engine.py").write_text("VALUE = 'engine'\n", encoding="utf-8")
    (c_dir / "hook_agent.exe").write_bytes(b"fake-hook-binary")
    return core


def test_provision_runtime_copies_hook_and_python_to_stable_install_root(tmp_path):
    source_core = _fake_core_tree(tmp_path)
    install_root = tmp_path / "LocalAppData" / "Tessera" / "FileHook"

    runtime = si.provision_runtime(
        source_core_dir=source_core,
        install_root=install_root,
    )

    runtime_dir = Path(runtime["runtime_dir"])
    assert runtime_dir.parent == install_root
    assert Path(runtime["hook_exe"]).is_file()
    assert Path(runtime["cli_script"]).is_file()
    assert Path(runtime["hook_exe"]).is_relative_to(install_root)
    assert Path(runtime["cli_script"]).is_relative_to(install_root)
    assert Path(runtime["cli_script"]).read_text(encoding="utf-8") == "VALUE = 'cli'\n"


def test_provision_runtime_repairs_an_existing_but_incomplete_runtime_dir(tmp_path):
    """用户实际撞上的 bug：开关「系统级文件快捷键」永远失败。

    目标 runtime 目录已存在时（并发的第二次 provision、上一版拷到一半被杀），`os.replace(staging,
    runtime_dir)` 在 Windows 上抛 PermissionError(WinError 5)，旧代码只 `except FileExistsError`
    接不住，开关每次点都失败。
    """
    source_core = _fake_core_tree(tmp_path)
    install_root = tmp_path / "LocalAppData" / "Tessera" / "FileHook"

    expected_dir = install_root / f"runtime-{si._runtime_digest(source_core)}"
    (expected_dir / "core" / "fileops").mkdir(parents=True)
    (expected_dir / "core" / "fileops" / "leftover.txt").write_text("half", encoding="utf-8")

    runtime = si.provision_runtime(source_core_dir=source_core, install_root=install_root)

    assert Path(runtime["runtime_dir"]) == expected_dir
    assert Path(runtime["hook_exe"]).is_file()
    assert Path(runtime["cli_script"]).read_text(encoding="utf-8") == "VALUE = 'cli'\n"
    # 残缺的那份是被整个换掉的，不是跟新内容混在一起
    assert not (expected_dir / "core" / "fileops" / "leftover.txt").exists()
    assert not list(install_root.glob(".runtime-*")), "staging 目录必须收干净"


def test_provision_runtime_keeps_a_complete_dir_written_by_a_racing_peer(tmp_path):
    """目标已存在**且完整**——另一个进程刚抢先装好了。这份多余的 staging 直接丢掉，
    绝不能把人家正在用的目录改名挪走（那会让已经启动的 hook_agent.exe 指向空气）。"""
    source_core = _fake_core_tree(tmp_path)
    install_root = tmp_path / "LocalAppData" / "Tessera" / "FileHook"

    peer = install_root / f"runtime-{si._runtime_digest(source_core)}"
    (peer / "core" / "fileops" / "c").mkdir(parents=True)
    (peer / "core" / "fileops" / "hook_cli.py").write_text("VALUE = 'peer'\n", encoding="utf-8")
    (peer / "core" / "fileops" / "c" / "hook_agent.exe").write_bytes(b"peer-binary")

    runtime = si.provision_runtime(source_core_dir=source_core, install_root=install_root)

    assert Path(runtime["cli_script"]).read_text(encoding="utf-8") == "VALUE = 'peer'\n"
    assert not list(install_root.glob(".retired-*")), "完整的目录不许被退位"


def test_sweep_leaves_a_staging_dir_another_process_is_still_writing(tmp_path):
    """扫垃圾必须卡 mtime：`.runtime-*.staging` 可能正是另一个进程此刻在写的那份。
    无条件删会把人家拷到一半的目录抽走，那边报的错跟真实原因毫无关系。"""
    root = tmp_path / "FileHook"
    root.mkdir()
    fresh = root / ".runtime-abc-1234.staging"
    fresh.mkdir()
    stale = root / ".retired-runtime-abc-1-1"
    stale.mkdir()
    import os as _os
    old = _os.stat(stale).st_mtime - si._LEFTOVER_MIN_AGE_S - 60
    _os.utime(stale, (old, old))

    si._sweep_runtime_leftovers(root)

    assert fresh.is_dir(), "刚创建的 staging 属于别人，不许删"
    assert not stale.exists(), "过了岁数线的残留该清掉"


def test_reconcile_autostart_repairs_enabled_but_stopped_agent(monkeypatch, tmp_path):
    runtime = {
        "runtime_dir": str(tmp_path / "runtime"),
        "hook_exe": str(tmp_path / "runtime" / "core" / "fileops" / "c" / "hook_agent.exe"),
        "cli_script": str(tmp_path / "runtime" / "core" / "fileops" / "hook_cli.py"),
    }
    calls = []
    monkeypatch.setattr(si, "get_autostart", lambda: True)
    monkeypatch.setattr(si, "get_autostart_value", lambda: si._autostart_value(runtime))
    monkeypatch.setattr(si, "provision_runtime", lambda: runtime)
    monkeypatch.setattr(si, "is_running", lambda hook_exe=None: False)
    monkeypatch.setattr(
        si,
        "start_agent",
        lambda runtime_paths=None, on_conflict="rename": calls.append(
            ("start", runtime_paths, on_conflict)
        ),
    )
    monkeypatch.setattr(
        si,
        "set_autostart",
        lambda enabled, runtime_paths=None: calls.append(
            ("autostart", enabled, runtime_paths)
        ),
    )

    status = si.reconcile_autostart()

    assert calls == [
        ("start", runtime, "rename"),
        ("autostart", True, runtime),
    ]
    assert status["autostart"] is True


def test_reconcile_autostart_restarts_running_agent_when_runtime_changed(monkeypatch, tmp_path):
    runtime = {
        "runtime_dir": str(tmp_path / "runtime-new"),
        "hook_exe": str(tmp_path / "runtime-new" / "core" / "fileops" / "c" / "hook_agent.exe"),
        "cli_script": str(tmp_path / "runtime-new" / "core" / "fileops" / "hook_cli.py"),
    }
    calls = []
    monkeypatch.setattr(si, "get_autostart", lambda: True)
    monkeypatch.setattr(si, "get_autostart_value", lambda: '"old-runtime.exe"')
    monkeypatch.setattr(si, "provision_runtime", lambda: runtime)
    monkeypatch.setattr(si, "is_running", lambda hook_exe=None: True)
    monkeypatch.setattr(
        si,
        "restart_agent",
        lambda runtime_paths=None, on_conflict="rename": calls.append(
            ("restart", runtime_paths, on_conflict)
        ),
    )
    monkeypatch.setattr(
        si,
        "set_autostart",
        lambda enabled, runtime_paths=None: calls.append(
            ("autostart", enabled, runtime_paths)
        ),
    )

    si.reconcile_autostart()

    assert calls == [
        ("restart", runtime, "rename"),
        ("autostart", True, runtime),
    ]


def test_status_exposes_last_hook_start_failure(monkeypatch, tmp_path):
    status_path = tmp_path / "hook-status.txt"
    status_path.write_text("failed 5\n", encoding="ascii")
    monkeypatch.setattr(si, "hook_status_path", lambda: status_path)
    monkeypatch.setattr(si, "is_running", lambda hook_exe=None: False)
    monkeypatch.setattr(si, "get_autostart", lambda: True)

    status = si.get_status()

    assert status["running"] is False
    assert status["state"] == "failed"
    assert status["last_error"] == "win32:5"


def test_autostart_command_passes_an_explicit_stable_status_file(monkeypatch, tmp_path):
    runtime = {
        "runtime_dir": str(tmp_path / "runtime"),
        "hook_exe": str(tmp_path / "runtime" / "hook_agent.exe"),
        "cli_script": str(tmp_path / "runtime" / "hook_cli.py"),
    }
    status_path = tmp_path / "FileHook" / "hook-status.txt"
    monkeypatch.setattr(si, "hook_status_path", lambda: status_path)
    monkeypatch.setattr(si, "_pyw_path", lambda: "C:\\Python\\pythonw.exe")

    value = si._autostart_value(runtime)

    assert f'"{status_path}"' in value


def test_c_hook_does_not_use_mingw_wide_swscanf_for_shortcut_config():
    source = (PROJECT_ROOT / "core" / "fileops" / "c" / "hook_agent.c").read_text(encoding="utf-8")
    config_loader = source[source.index("static void load_shortcut_bindings"):source.index("int WINAPI wWinMain")]

    assert "parse_shortcut_binding" in config_loader
    assert "swscanf(" not in config_loader
    assert "wcstol(" in source

