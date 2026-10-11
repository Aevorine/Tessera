"""Config loading: environment variables plus an optional root config.toml (missing is fine)."""

import os
from pathlib import Path
from typing import Any

try:
    import tomllib  # Python 3.11+
except ImportError:
    tomllib = None  # type: ignore[assignment]

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.toml"


def load_config() -> dict[str, Any]:
    """Load config.toml if present, then overlay IDEAL1_* env vars (IDEAL1_LOG_LEVEL -> log_level).

    Without tomllib (Python < 3.11) config.toml is skipped instead of failing.
    """
    config: dict[str, Any] = {}
    if CONFIG_PATH.exists() and tomllib is not None:
        with open(CONFIG_PATH, "rb") as f:
            config.update(tomllib.load(f))

    for key, value in os.environ.items():
        if key.startswith("IDEAL1_"):
            config[key[len("IDEAL1_"):].lower()] = value

    return config
