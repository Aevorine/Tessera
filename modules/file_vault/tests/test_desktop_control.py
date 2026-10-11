import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import desktop_control


class _CompletedProcess:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_find_apps_filters_locally_and_never_returns_launch_paths(monkeypatch):
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["input"] = json.loads(kwargs["input"])
        return _CompletedProcess(
            stdout=json.dumps(
                {
                    "apps": [
                        {
                            "name": "Notepad",
                            "pid": 123,
                            "running": True,
                            "active": False,
                            "kind": "uwp",
                            "launch_path": "C:\\private\\shortcut.lnk",
                        },
                        {"name": "Calculator", "pid": 0, "running": False, "active": False, "kind": "uwp"},
                    ]
                }
            )
        )

    monkeypatch.setattr(desktop_control.subprocess, "run", fake_run)

    result = desktop_control.execute("desktop_find_apps", {"query": "note"})

    assert captured["command"] == [desktop_control.DRIVER_COMMAND, "call", "list_apps"]
    assert captured["input"] == {}
    assert result == {
        "apps": [{"name": "Notepad", "pid": 123, "running": True, "active": False, "kind": "uwp"}]
    }


def test_click_forces_background_delivery_and_uses_only_allowed_arguments(monkeypatch):
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["input"] = json.loads(kwargs["input"])
        return _CompletedProcess(stdout='{"effect":"confirmed"}')

    monkeypatch.setattr(desktop_control.subprocess, "run", fake_run)

    result = desktop_control.execute(
        "desktop_click",
        {"pid": 12, "window_id": 34, "element_index": 7, "delivery_mode": "foreground", "path": "ignored"},
    )

    assert captured["command"] == [desktop_control.DRIVER_COMMAND, "call", "click"]
    assert captured["input"] == {
        "pid": 12,
        "window_id": 34,
        "element_index": 7,
        "delivery_mode": "background",
        "session": desktop_control.SESSION_NAME,
    }
    assert result == {"effect": "confirmed"}


def test_set_value_writes_via_accessibility_api_with_no_delivery_mode(monkeypatch):
    # set_value 没有 delivery_mode 概念（ValuePattern.SetValue 是纯无障碍写入），且 cua-driver 对它的
    # schema 是 additionalProperties:false，传 delivery_mode 会让调用失败，所以绝不能出现，
    # 尽管其他变更动作都强制带上。
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["input"] = json.loads(kwargs["input"])
        return _CompletedProcess(stdout='{"effect":"confirmed"}')

    monkeypatch.setattr(desktop_control.subprocess, "run", fake_run)

    result = desktop_control.execute(
        "desktop_set_value",
        {"pid": 12, "window_id": 34, "element_index": 7, "value": "600519", "delivery_mode": "foreground"},
    )

    assert captured["command"] == [desktop_control.DRIVER_COMMAND, "call", "set_value"]
    assert captured["input"] == {
        "pid": 12,
        "window_id": 34,
        "element_index": 7,
        "value": "600519",
        "session": desktop_control.SESSION_NAME,
    }
    assert result == {"effect": "confirmed"}


def test_set_value_requires_a_nonempty_value():
    with pytest.raises(desktop_control.DesktopControlError) as exc:
        desktop_control.execute("desktop_set_value", {"pid": 1, "window_id": 2, "element_index": 3, "value": "  "})
    assert exc.value.code == "ai.desktop_request_invalid"


def test_rejects_unknown_tools_and_invalid_required_arguments():
    with pytest.raises(desktop_control.DesktopControlError) as unknown:
        desktop_control.execute("desktop_kill_app", {"pid": 1})
    assert unknown.value.code == "ai.desktop_action_blocked"

    with pytest.raises(desktop_control.DesktopControlError) as invalid:
        desktop_control.execute("desktop_launch_app", {})
    assert invalid.value.code == "ai.desktop_request_invalid"


def test_launch_allows_only_an_app_name_not_paths_or_extra_arguments(monkeypatch):
    captured = {}

    def fake_run(command, **kwargs):
        captured["input"] = json.loads(kwargs["input"])
        return _CompletedProcess(stdout='{"pid": 91, "name": "Calculator"}')

    monkeypatch.setattr(desktop_control.subprocess, "run", fake_run)

    desktop_control.execute(
        "desktop_launch_app",
        {"name": "Calculator", "path": "C:\\Windows\\System32\\cmd.exe", "additional_arguments": ["/c", "whoami"]},
    )

    assert captured["input"] == {"name": "Calculator", "start_minimized": True}
