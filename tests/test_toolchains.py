"""Smoke tests that the Python/JS/C toolchain in modules/README.md works end-to-end via core.proc."""

import shutil
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.proc import ToolNotFoundError, require_tool, run_command


def test_require_tool_raises_for_missing_tool():
    with pytest.raises(ToolNotFoundError):
        require_tool("definitely-not-a-real-tool")


def test_python_invocable_via_run_command():
    result = run_command([sys.executable, "-c", "print('ok')"])
    assert "ok" in result.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
def test_node_invocable_via_run_command():
    result = run_command(["node", "-e", "console.log('ok')"])
    assert "ok" in result.stdout


@pytest.mark.skipif(shutil.which("gcc") is None, reason="gcc not on PATH")
def test_gcc_compiles_and_runs_hello_world(tmp_path):
    src = tmp_path / "hello.c"
    src.write_text('#include <stdio.h>\nint main(void) { printf("ok\\n"); return 0; }\n')
    exe = tmp_path / "hello.exe"
    run_command(["gcc", str(src), "-o", str(exe)])
    result = run_command([str(exe)])
    assert "ok" in result.stdout
