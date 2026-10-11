import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import backend_server  # noqa: E402
from modules.file_vault.fileops import service  # noqa: E402


def test_service_loads_and_saves_progress_preferences(monkeypatch):
    stored = {"position": "bottom-right", "auto_hide_seconds": 5, "compact": False}
    expected = {"position": "top-center", "auto_hide_seconds": 10, "compact": True}
    monkeypatch.setattr(service.progress_preferences, "load_preferences", lambda: stored)
    monkeypatch.setattr(
        service.progress_preferences,
        "save_preferences",
        lambda preferences: preferences,
    )

    assert service.get_progress_preferences() == stored
    assert service.set_progress_preferences(expected) == expected


def test_progress_preference_rpc_get_and_set_do_not_accept_a_path(monkeypatch):
    expected = {"position": "bottom-center", "auto_hide_seconds": 3, "compact": True}
    monkeypatch.setattr(service, "get_progress_preferences", lambda: expected)
    monkeypatch.setattr(service, "set_progress_preferences", lambda preferences: preferences)

    assert backend_server.rpc_file_clip_progress_preferences_get({}) == {
        "ok": True,
        "preferences": expected,
    }
    assert backend_server.rpc_file_clip_progress_preferences_set(expected) == {
        "ok": True,
        "preferences": expected,
    }
    assert backend_server.rpc_file_clip_progress_preferences_set({**expected, "path": "C:/bad"}) == {
        "ok": False,
        "error": "file_clip.invalid_request",
    }


def test_progress_preference_rpc_returns_stable_error_when_persistence_fails(
    monkeypatch, caplog
):
    preferences = {"position": "bottom-center", "auto_hide_seconds": 3, "compact": True}

    def fail_save(_preferences):
        raise OSError("disk full")

    monkeypatch.setattr(service, "set_progress_preferences", fail_save)

    assert backend_server.rpc_file_clip_progress_preferences_set(preferences) == {
        "ok": False,
        "error": "file_clip.progress_preferences_save_failed",
    }
    assert "progress preferences" in caplog.text.lower()


@pytest.mark.parametrize(
    "preferences",
    (
        {"position": "middle", "auto_hide_seconds": 5, "compact": False},
        {"position": "bottom-right", "auto_hide_seconds": 7, "compact": False},
        {"position": "bottom-right", "auto_hide_seconds": 5, "compact": "false"},
        {"position": "bottom-right", "auto_hide_seconds": 5},
    ),
)
def test_progress_preference_rpc_rejects_invalid_values(preferences):
    assert backend_server.rpc_file_clip_progress_preferences_set(preferences) == {
        "ok": False,
        "error": "file_clip.invalid_request",
    }
