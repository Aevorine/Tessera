"""Discover modules under modules/: subpackages not starting with "_" that expose MODULE_META.
A broken module is skipped (logged) without stopping discovery."""

import importlib
import pkgutil
from dataclasses import dataclass
from types import ModuleType
from typing import Optional

from core.logging import get_logger

logger = get_logger(__name__)


@dataclass
class ModuleInfo:
    name: str
    description: str
    version: str
    module: ModuleType


def discover_modules() -> dict[str, ModuleInfo]:
    import modules as modules_pkg

    discovered: dict[str, ModuleInfo] = {}
    for _finder, name, is_pkg in pkgutil.iter_modules(modules_pkg.__path__):
        if not is_pkg or name.startswith("_"):
            continue

        try:
            mod = importlib.import_module(f"modules.{name}")
        except Exception:
            logger.warning("Skipping modules.%s: failed to import", name, exc_info=True)
            continue

        meta = getattr(mod, "MODULE_META", None)
        if not isinstance(meta, dict):
            logger.warning("Skipping modules.%s: no MODULE_META dict found", name)
            continue

        try:
            discovered[name] = ModuleInfo(
                name=meta["name"],
                description=meta["description"],
                version=meta["version"],
                module=mod,
            )
        except KeyError:
            logger.warning("Skipping modules.%s: MODULE_META missing required keys", name)
            continue

    return discovered


def get_module(name: str) -> Optional[ModuleInfo]:
    return discover_modules().get(name)
