"""Contract checks for task-card settings exposed by the Electron renderer."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "ui" / "src"
LOCALES = ("zh", "en", "es", "fr", "ru", "ar")
TASK_CARD_KEYS = {
    "taskCardPreferencesTitle",
    "taskCardPreferencesHint",
    "taskCardPositionLabel",
    "taskCardPositionTopLeft",
    "taskCardPositionTopCenter",
    "taskCardPositionTopRight",
    "taskCardPositionMiddleLeft",
    "taskCardPositionCenter",
    "taskCardPositionMiddleRight",
    "taskCardPositionBottomLeft",
    "taskCardPositionBottomCenter",
    "taskCardPositionBottomRight",
    "taskCardAutoHideLabel",
    "taskCardAutoHideSeconds",
    "taskCardCompactLabel",
    "taskCardPreviewTitle",
    "taskCardPreviewDetail",
    "taskCardSavedToast",
    "taskCardSaveFailedToast",
}


def test_task_card_preference_rpc_and_type_are_declared() -> None:
    types = (ROOT / "shared" / "ipcTypes.ts").read_text(encoding="utf-8")

    assert "export type TaskCardPosition" in types
    assert "export interface TaskCardPreferences" in types
    assert "file_clip_progress_preferences_get" in types
    assert "file_clip_progress_preferences_set" in types


def test_every_locale_translates_task_card_settings() -> None:
    for locale in LOCALES:
        settings_path = ROOT / "i18n" / "locales" / locale / "settings.json"
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        assert TASK_CARD_KEYS <= settings.keys(), locale


def test_every_locale_translates_task_card_save_error() -> None:
    for locale in LOCALES:
        errors_path = ROOT / "i18n" / "locales" / locale / "errors.json"
        errors = json.loads(errors_path.read_text(encoding="utf-8"))
        assert "file_clip.progress_preferences_save_failed" in errors, locale
