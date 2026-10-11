"""write_shortcut_config：把 ui_settings 的文件操作快捷键写成 hook_agent.exe 启动时读取的键位文件
（行格式 "动作名 VK码 ctrl alt shift"）。只测纯函数，不测"重启真实代理"（会碰运行中的钩子）。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops import system_integration as si


DEFAULT_SHORTCUTS = {
    "copy": {"key": "c", "ctrl": True, "alt": False, "shift": False},
    "cut": {"key": "x", "ctrl": True, "alt": False, "shift": False},
    "paste": {"key": "v", "ctrl": True, "alt": False, "shift": False},
    "delete_recycle": {"key": "Delete", "ctrl": False, "alt": False, "shift": False},
    "delete_permanent": {"key": "Delete", "ctrl": False, "alt": False, "shift": True},
}


def _write(tmp_path, shortcuts):
    config_path = tmp_path / "file_clip_shortcuts.txt"
    returned = si.write_shortcut_config(shortcuts, config_path=str(config_path))
    assert returned == str(config_path)
    return config_path.read_text(encoding="ascii").splitlines()


def test_default_shortcuts_produce_expected_vk_lines(tmp_path):
    lines = _write(tmp_path, DEFAULT_SHORTCUTS)
    assert lines == [
        "copy 67 1 0 0",             # Ctrl+C → 'C' = 0x43 = 67
        "cut 88 1 0 0",              # Ctrl+X → 'X' = 0x58 = 88
        "paste 86 1 0 0",            # Ctrl+V → 'V' = 0x56 = 86
        "delete_recycle 46 0 0 0",   # Delete = 0x2E = 46
        "delete_permanent 46 0 0 1",  # Shift+Delete
    ]


def test_custom_letter_and_digit_keys_map_to_vk_codes(tmp_path):
    shortcuts = dict(DEFAULT_SHORTCUTS)
    shortcuts["paste"] = {"key": "b", "ctrl": True, "alt": True, "shift": False}
    shortcuts["delete_permanent"] = {"key": "3", "ctrl": True, "alt": False, "shift": True}
    lines = _write(tmp_path, shortcuts)
    assert "paste 66 1 1 0" in lines          # 'B' = 66
    assert "delete_permanent 51 1 0 1" in lines  # '3' = 51


def test_copy_and_cut_are_written_for_the_global_file_hook(tmp_path):
    lines = _write(tmp_path, DEFAULT_SHORTCUTS)
    assert "copy 67 1 0 0" in lines
    assert "cut 88 1 0 0" in lines


def test_unmappable_key_is_skipped_not_fatal(tmp_path):
    shortcuts = dict(DEFAULT_SHORTCUTS)
    shortcuts["paste"] = {"key": "F1", "ctrl": True, "alt": False, "shift": False}
    lines = _write(tmp_path, shortcuts)
    assert not any(line.startswith("paste") for line in lines)
    assert "delete_recycle 46 0 0 0" in lines  # 其余动作照写


def test_delete_key_name_is_case_insensitive(tmp_path):
    shortcuts = dict(DEFAULT_SHORTCUTS)
    shortcuts["delete_recycle"] = {"key": "delete", "ctrl": False, "alt": False, "shift": False}
    lines = _write(tmp_path, shortcuts)
    assert "delete_recycle 46 0 0 0" in lines


def test_write_is_atomic_no_part_file_left(tmp_path):
    config_path = tmp_path / "file_clip_shortcuts.txt"
    si.write_shortcut_config(DEFAULT_SHORTCUTS, config_path=str(config_path))
    assert config_path.exists()
    assert not (tmp_path / "file_clip_shortcuts.txt.part").exists()


def test_overwrite_replaces_previous_content(tmp_path):
    config_path = tmp_path / "file_clip_shortcuts.txt"
    si.write_shortcut_config(DEFAULT_SHORTCUTS, config_path=str(config_path))
    shortcuts = dict(DEFAULT_SHORTCUTS)
    shortcuts["paste"] = {"key": "p", "ctrl": True, "alt": False, "shift": False}
    si.write_shortcut_config(shortcuts, config_path=str(config_path))
    lines = config_path.read_text(encoding="ascii").splitlines()
    assert "paste 80 1 0 0" in lines
    assert "paste 86 1 0 0" not in lines
