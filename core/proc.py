"""Thin subprocess wrapper for external toolchains, with consistent logging
and a clear missing-tool error."""

import shutil
import subprocess
from typing import Optional, Sequence

from core.logging import get_logger

logger = get_logger(__name__)


class ToolNotFoundError(RuntimeError):
    pass


def require_tool(tool: str) -> str:
    """Return the resolved path to `tool`, raising ToolNotFoundError if missing."""
    path = shutil.which(tool)
    if path is None:
        raise ToolNotFoundError(
            f"'{tool}' not found on PATH. Install it before using this module."
        )
    return path


def run_command(
    cmd: Sequence[str],
    cwd: Optional[str] = None,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run an external command and return the CompletedProcess (text output).

    Raises ToolNotFoundError up front if cmd[0] isn't on PATH, not a raw FileNotFoundError.
    """
    require_tool(cmd[0])
    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)
    if result.stdout:
        logger.debug(result.stdout)
    if result.stderr:
        logger.debug(result.stderr)
    return result
