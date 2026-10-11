"""Regression coverage for Ctrl+C/Ctrl+X invoked by the global file hook."""

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops import clipboard, hook_cli


def test_copy_selection_writes_selected_paths_as_a_copy(monkeypatch):
    recorded = []
    monkeypatch.setattr(hook_cli, "resolve_selected_items", lambda hwnd: ["C:\\a.txt", "C:\\b"])
    monkeypatch.setattr(clipboard, "set_file_drop", lambda paths, move: recorded.append((paths, move)))

    assert hook_cli.cmd_copy_selection("42", move=False) == 0
    assert recorded == [(["C:\\a.txt", "C:\\b"], False)]


def test_cut_selection_writes_selected_paths_as_a_move(monkeypatch):
    recorded = []
    monkeypatch.setattr(hook_cli, "resolve_selected_items", lambda hwnd: ["C:\\a.txt"])
    monkeypatch.setattr(clipboard, "set_file_drop", lambda paths, move: recorded.append((paths, move)))

    assert hook_cli.cmd_copy_selection("42", move=True) == 0
    assert recorded == [(["C:\\a.txt"], True)]
