"""Non-secret UI preference store for recovery codes (separate from ui_settings.py).

Toggles: scan_downloads (spec 1.1, default False) scans Downloads for new recovery-code files;
reveal_requires_verify (spec 9, default True) requires UnlockDialog re-auth to reveal plaintext.
"""
import json
from pathlib import Path
from typing import Dict, Any

SETTINGS_FILENAME = "recovery_codes_settings.json"

_DEFAULTS: Dict[str, Any] = {
    "scan_downloads_enabled": False,
    "reveal_requires_verify": True,
}


def _settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / SETTINGS_FILENAME


def load(data_dir: Path) -> Dict[str, Any]:
    path = _settings_path(data_dir)
    if not path.exists():
        return dict(_DEFAULTS)
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return dict(_DEFAULTS)
        result = dict(_DEFAULTS)
        result.update(raw)
        return result
    except (json.JSONDecodeError, OSError):
        return dict(_DEFAULTS)


def save(data_dir: Path, settings: Dict[str, Any]) -> None:
    path = _settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = dict(_DEFAULTS)
    merged.update(settings)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f)
