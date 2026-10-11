"""Guard that file_clip's thin re-exports of core/fileops (engine.py, clipboard.py) are complete and correct, so its CLI/hotkey proxy doesn't use another implementation."""

from core.fileops import clipboard as core_clipboard
from core.fileops import engine as core_engine
from modules.file_clip import clipboard as file_clip_clipboard
from modules.file_clip import engine as file_clip_engine


def test_engine_reexports_same_objects():
    assert file_clip_engine.transfer is core_engine.transfer
    assert file_clip_engine.delete_items is core_engine.delete_items
    assert file_clip_engine.TransferReport is core_engine.TransferReport


def test_clipboard_reexports_same_objects():
    assert file_clip_clipboard.get_file_drop is core_clipboard.get_file_drop
    assert file_clip_clipboard.set_file_drop is core_clipboard.set_file_drop
    assert file_clip_clipboard.clear_clipboard is core_clipboard.clear_clipboard
    assert file_clip_clipboard.ClipboardError is core_clipboard.ClipboardError
