import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from core.fileops import progress_preferences
from core.fileops import system_integration as si


ALL_POSITIONS = (
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
)


def test_missing_preference_file_returns_the_default_silently(tmp_path, caplog):
    path = tmp_path / "progress_preferences.json"

    assert progress_preferences.load_preferences(path) == {
        "position": "bottom-right",
        "auto_hide_seconds": 5,
        "compact": False,
    }
    assert not caplog.records


@pytest.mark.parametrize("position", ALL_POSITIONS)
def test_every_supported_position_round_trips(tmp_path, position):
    path = tmp_path / "progress_preferences.json"
    preferences = {
        "position": position,
        "auto_hide_seconds": 5,
        "compact": False,
    }

    assert progress_preferences.save_preferences(preferences, path) == preferences
    assert progress_preferences.load_preferences(path) == preferences


@pytest.mark.parametrize("auto_hide_seconds", (3, 5, 10))
def test_auto_hide_values_and_compact_round_trip(tmp_path, auto_hide_seconds):
    path = tmp_path / "progress_preferences.json"
    preferences = {
        "position": "top-left",
        "auto_hide_seconds": auto_hide_seconds,
        "compact": True,
    }

    progress_preferences.save_preferences(preferences, path)

    assert progress_preferences.load_preferences(path) == preferences


def test_invalid_json_returns_default_and_logs_a_diagnostic(tmp_path, caplog):
    path = tmp_path / "progress_preferences.json"
    path.write_text("{not json", encoding="utf-8")

    assert progress_preferences.load_preferences(path) == progress_preferences.DEFAULT_PREFERENCES
    assert "progress preferences" in caplog.text.lower()


def test_save_uses_same_directory_temporary_file_and_atomic_replace(tmp_path, monkeypatch):
    path = tmp_path / "progress_preferences.json"
    calls = []
    real_replace = os.replace

    def recording_replace(source, destination):
        calls.append((Path(source), Path(destination)))
        real_replace(source, destination)

    monkeypatch.setattr(progress_preferences.os, "replace", recording_replace)
    preferences = {
        "position": "bottom-left",
        "auto_hide_seconds": 10,
        "compact": True,
    }

    progress_preferences.save_preferences(preferences, path)

    assert json.loads(path.read_text(encoding="utf-8")) == preferences
    assert len(calls) == 1
    temporary, destination = calls[0]
    assert temporary.parent == path.parent
    assert temporary.name.startswith(path.name + ".")
    assert destination == path
    assert not temporary.exists()


def _access_denied(message):
    """构造一个和 Windows 上真实占用一模一样的异常（含 winerror）。"""
    error = PermissionError(13, message)
    error.winerror = 5
    return error


def test_replace_retries_while_another_process_briefly_holds_the_file(
    tmp_path, monkeypatch
):
    """杀毒软件扫刚落盘的临时文件会让 os.replace 报 ACCESS_DENIED；
    这是瞬时占用，须重试而不是保存失败。"""
    path = tmp_path / "progress_preferences.json"
    real_replace = os.replace
    attempts = []
    slept = []

    def flaky_replace(source, destination):
        attempts.append(1)
        if len(attempts) <= 3:
            raise _access_denied("Access is denied")
        real_replace(source, destination)

    monkeypatch.setattr(progress_preferences.os, "replace", flaky_replace)
    monkeypatch.setattr(progress_preferences.time, "sleep", slept.append)
    preferences = {
        "position": "top-right",
        "auto_hide_seconds": 3,
        "compact": False,
    }

    assert progress_preferences.save_preferences(preferences, path) == preferences
    assert json.loads(path.read_text(encoding="utf-8")) == preferences
    assert len(attempts) == 4  # 三次被占用，第四次成功
    assert slept == [0.01, 0.02, 0.04]  # 退避在变长，不是死循环空转
    assert not list(tmp_path.glob(path.name + ".*"))


def test_replace_gives_up_instead_of_retrying_forever(tmp_path, monkeypatch):
    """一直占着就得如实报错，不能无限等下去，临时文件也不许留下。"""
    path = tmp_path / "progress_preferences.json"
    attempts = []

    def always_denied(source, destination):
        attempts.append(1)
        raise _access_denied("Access is denied")

    monkeypatch.setattr(progress_preferences.os, "replace", always_denied)
    monkeypatch.setattr(progress_preferences.time, "sleep", lambda _seconds: None)

    with pytest.raises(PermissionError):
        progress_preferences.save_preferences(
            {"position": "center", "auto_hide_seconds": 5, "compact": False}, path
        )

    assert len(attempts) == len(progress_preferences._REPLACE_RETRY_DELAYS_SECONDS) + 1
    assert not list(tmp_path.glob(path.name + ".*"))


def test_replace_does_not_retry_errors_that_waiting_cannot_fix(tmp_path, monkeypatch):
    """磁盘满、目标是目录等错误重试无益，必须立刻抛出，否则故障会被拖成一秒静默卡顿再报错。"""
    path = tmp_path / "progress_preferences.json"
    attempts = []

    def disk_full(source, destination):
        attempts.append(1)
        error = OSError(28, "No space left on device")
        error.winerror = 112  # ERROR_DISK_FULL
        raise error

    monkeypatch.setattr(progress_preferences.os, "replace", disk_full)
    monkeypatch.setattr(
        progress_preferences.time,
        "sleep",
        lambda _seconds: pytest.fail("不该为不可恢复的错误等待"),
    )

    with pytest.raises(OSError):
        progress_preferences.save_preferences(
            {"position": "center", "auto_hide_seconds": 5, "compact": False}, path
        )

    assert len(attempts) == 1
    assert not list(tmp_path.glob(path.name + ".*"))


def test_concurrent_process_saves_leave_valid_json_without_temp_collisions(tmp_path):
    path = tmp_path / "progress_preferences.json"
    ready = tmp_path / "writer-ready"
    child_preferences = {
        "position": "top-left",
        "auto_hide_seconds": 3,
        "compact": False,
    }
    parent_preferences = {
        "position": "bottom-right",
        "auto_hide_seconds": 10,
        "compact": True,
    }
    project_root = Path(__file__).resolve().parents[3]
    command = (
        "import sys; from pathlib import Path; "
        f"sys.path.insert(0, {str(project_root)!r}); "
        "from core.fileops.progress_preferences import save_preferences; "
        f"path = Path({str(path)!r}); ready = Path({str(ready)!r}); "
        f"preferences = {child_preferences!r}; "
        "ready.write_text('ready', encoding='ascii'); "
        "[save_preferences(preferences, path) for _ in range(30)]"
    )
    child = subprocess.Popen([sys.executable, "-c", command])
    try:
        deadline = time.monotonic() + 3
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists()
        for _ in range(30):
            progress_preferences.save_preferences(parent_preferences, path)
        assert child.wait(timeout=5) == 0
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)

    assert json.loads(path.read_text(encoding="utf-8")) in (
        child_preferences,
        parent_preferences,
    )
    assert not list(tmp_path.glob(path.name + ".*"))


def test_second_writer_cannot_enter_replace_region_until_first_releases(
    tmp_path, monkeypatch
):
    path = tmp_path / "progress_preferences.json"
    first_entered_replace = threading.Event()
    second_entered_replace = threading.Event()
    release_first_writer = threading.Event()
    failures = []
    replace_count = 0
    count_lock = threading.Lock()
    real_replace = os.replace

    def controlled_replace(source, destination):
        nonlocal replace_count
        with count_lock:
            is_first_writer = replace_count == 0
            replace_count += 1
        if is_first_writer:
            first_entered_replace.set()
            assert release_first_writer.wait(2)
        else:
            second_entered_replace.set()
        real_replace(source, destination)

    def save(preferences):
        try:
            progress_preferences.save_preferences(preferences, path)
        except BaseException as exc:
            failures.append(exc)

    monkeypatch.setattr(progress_preferences.os, "replace", controlled_replace)
    first = threading.Thread(
        target=save,
        args=({"position": "top-left", "auto_hide_seconds": 3, "compact": False},),
    )
    second = threading.Thread(
        target=save,
        args=({"position": "bottom-right", "auto_hide_seconds": 10, "compact": True},),
    )
    second_started = False
    first.start()
    try:
        assert first_entered_replace.wait(2)
        second.start()
        second_started = True
        assert not second_entered_replace.wait(0.15)
    finally:
        release_first_writer.set()
        first.join(2)
        if second_started:
            second.join(2)

    assert not first.is_alive()
    assert second_started and not second.is_alive()
    assert not failures
    assert second_entered_replace.is_set()


def test_preference_write_lock_times_out_with_a_clear_os_error(tmp_path, monkeypatch):
    path = tmp_path / "progress_preferences.json"
    entered = threading.Event()
    release = threading.Event()

    def hold_lock():
        with progress_preferences._preference_write_lock(path, timeout_seconds=1):
            entered.set()
            assert release.wait(2)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    assert entered.wait(2)
    monkeypatch.setattr(progress_preferences, "PREFERENCE_WRITE_LOCK_TIMEOUT_SECONDS", 0.01)
    try:
        with pytest.raises(OSError, match="timed out acquiring progress preference write lock"):
            progress_preferences.save_preferences(progress_preferences.DEFAULT_PREFERENCES, path)
    finally:
        release.set()
        holder.join(2)
    assert not holder.is_alive()


def test_provisioned_runtime_reads_preferences_without_electron(tmp_path, monkeypatch):
    local_app_data = tmp_path / "LocalAppData"
    install_root = local_app_data / "Tessera" / "FileHook"
    source_core = tmp_path / "source" / "core"
    source_core.mkdir(parents=True)
    for source in (Path(__file__).resolve().parents[2]).rglob("*"):
        relative = source.relative_to(Path(__file__).resolve().parents[2])
        target = source_core / relative
        if source.is_dir():
            target.mkdir(exist_ok=True)
        elif "__pycache__" not in source.parts and source.suffix not in {".pyc", ".pyo"}:
            target.write_bytes(source.read_bytes())
    hook_exe = source_core / "fileops" / "c" / "hook_agent.exe"
    hook_exe.write_bytes(b"fake-hook")
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    preferences = {
        "position": "center-right",
        "auto_hide_seconds": 3,
        "compact": True,
    }
    progress_preferences.save_preferences(preferences)

    runtime = si.provision_runtime(source_core_dir=source_core, install_root=install_root)
    runtime_dir = Path(runtime["runtime_dir"])
    command = (
        "import json, sys; "
        f"sys.path.insert(0, {str(runtime_dir)!r}); "
        "from core.fileops.progress_preferences import load_preferences; "
        "print(json.dumps(load_preferences()))"
    )
    child_env = os.environ.copy()
    child_env["LOCALAPPDATA"] = str(local_app_data)
    child_env.pop("ELECTRON_RUN_AS_NODE", None)

    result = subprocess.run(
        [sys.executable, "-c", command],
        capture_output=True,
        check=True,
        env=child_env,
        text=True,
        timeout=5,
    )

    assert json.loads(result.stdout) == preferences
