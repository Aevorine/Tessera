import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import ui_settings


def test_load_sort_mode_defaults_to_recent_when_file_missing(tmp_path):
    assert ui_settings.load_sort_mode(tmp_path) == "recent"


def test_save_then_load_round_trips(tmp_path):
    ui_settings.save_sort_mode(tmp_path, "alphabetical")
    assert ui_settings.load_sort_mode(tmp_path) == "alphabetical"


@pytest.mark.parametrize("mode", ["recent", "alphabetical", "host"])
def test_all_supported_modes_round_trip(tmp_path, mode):
    ui_settings.save_sort_mode(tmp_path, mode)
    assert ui_settings.load_sort_mode(tmp_path) == mode


def test_save_rejects_unknown_mode(tmp_path):
    with pytest.raises(ValueError):
        ui_settings.save_sort_mode(tmp_path, "not-a-real-mode")


def test_load_falls_back_to_default_for_corrupt_json(tmp_path):
    ui_settings.settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ui_settings.settings_path(tmp_path).write_text("{not json", encoding="utf-8")
    assert ui_settings.load_sort_mode(tmp_path) == "recent"


def test_load_falls_back_to_default_for_non_object_json(tmp_path):
    ui_settings.settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ui_settings.settings_path(tmp_path).write_text("[1, 2, 3]", encoding="utf-8")
    assert ui_settings.load_sort_mode(tmp_path) == "recent"


def test_load_falls_back_to_default_for_unknown_saved_mode(tmp_path):
    ui_settings.settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ui_settings.settings_path(tmp_path).write_text('{"sort_mode": "bogus"}', encoding="utf-8")
    assert ui_settings.load_sort_mode(tmp_path) == "recent"


def test_save_overwrites_previous_value(tmp_path):
    ui_settings.save_sort_mode(tmp_path, "host")
    ui_settings.save_sort_mode(tmp_path, "recent")
    assert ui_settings.load_sort_mode(tmp_path) == "recent"


def _all_unlocked(**overrides):
    """期望的模块锁字典：全部关闭，再按 kwargs 打开指定的几个。
    从 `LOCKABLE_MODULES` 派生而非写死：用例断言的是"默认全关"和"只动指定的那个"，
    不是"模块清单恰好是这几个"，否则每次新增可锁模块都会撞红六个用例。"""
    expected = {module: False for module in ui_settings.LOCKABLE_MODULES}
    for module, value in overrides.items():
        assert module in expected, f"unknown lockable module in test: {module}"
        expected[module] = value
    return expected


def test_load_module_lock_settings_defaults_to_all_unlocked_when_file_missing(tmp_path):
    assert ui_settings.load_module_lock_settings(tmp_path) == _all_unlocked()


@pytest.mark.parametrize("module", ui_settings.LOCKABLE_MODULES)
def test_save_then_load_module_lock_round_trips(tmp_path, module):
    ui_settings.save_module_lock_setting(tmp_path, module, True)
    settings = ui_settings.load_module_lock_settings(tmp_path)
    assert settings[module] is True
    other_modules = [m for m in ui_settings.LOCKABLE_MODULES if m != module]
    assert all(settings[m] is False for m in other_modules)


def test_save_module_lock_setting_only_touches_its_own_module(tmp_path):
    ui_settings.save_module_lock_setting(tmp_path, "files", True)
    ui_settings.save_module_lock_setting(tmp_path, "clipboard", True)
    settings = ui_settings.load_module_lock_settings(tmp_path)
    assert settings == _all_unlocked(files=True, clipboard=True)


def test_save_module_lock_setting_rejects_unknown_module(tmp_path):
    with pytest.raises(ValueError):
        ui_settings.save_module_lock_setting(tmp_path, "not-a-real-module", True)


def test_load_module_lock_settings_falls_back_to_default_for_corrupt_json(tmp_path):
    ui_settings.module_lock_settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ui_settings.module_lock_settings_path(tmp_path).write_text("{not json", encoding="utf-8")
    assert ui_settings.load_module_lock_settings(tmp_path) == _all_unlocked()


def test_load_module_lock_settings_falls_back_to_default_for_non_object_json(tmp_path):
    ui_settings.module_lock_settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ui_settings.module_lock_settings_path(tmp_path).write_text("[1, 2, 3]", encoding="utf-8")
    assert ui_settings.load_module_lock_settings(tmp_path) == _all_unlocked()


def test_load_module_lock_settings_ignores_non_boolean_stored_value(tmp_path):
    ui_settings.module_lock_settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ui_settings.module_lock_settings_path(tmp_path).write_text('{"files": "yes"}', encoding="utf-8")
    assert ui_settings.load_module_lock_settings(tmp_path) == _all_unlocked()


def test_save_module_lock_setting_overwrites_previous_value(tmp_path):
    ui_settings.save_module_lock_setting(tmp_path, "passwords", True)
    ui_settings.save_module_lock_setting(tmp_path, "passwords", False)
    assert ui_settings.load_module_lock_settings(tmp_path)["passwords"] is False


# File-manager shortcuts


def _shortcuts_with(**overrides):
    shortcuts = {
        action: dict(binding)
        for action, binding in ui_settings.DEFAULT_FILE_MANAGER_SHORTCUTS.items()
    }
    shortcuts.update(overrides)
    return shortcuts


def test_load_file_manager_shortcuts_defaults_when_file_missing(tmp_path):
    assert ui_settings.load_file_manager_shortcuts(tmp_path) == ui_settings.DEFAULT_FILE_MANAGER_SHORTCUTS


def test_save_then_load_file_manager_shortcuts_round_trips(tmp_path):
    saved = ui_settings.save_file_manager_shortcuts(
        tmp_path, _shortcuts_with(copy={"key": "d", "ctrl": True, "alt": False, "shift": False})
    )
    assert saved["copy"] == {"key": "d", "ctrl": True, "alt": False, "shift": False}
    assert ui_settings.load_file_manager_shortcuts(tmp_path) == saved


def test_save_file_manager_shortcuts_normalizes_uppercase_key(tmp_path):
    saved = ui_settings.save_file_manager_shortcuts(
        tmp_path, _shortcuts_with(copy={"key": "D", "ctrl": True, "alt": False, "shift": False})
    )
    assert saved["copy"]["key"] == "d"


def test_save_file_manager_shortcuts_rejects_missing_action(tmp_path):
    shortcuts = _shortcuts_with()
    del shortcuts["paste"]
    with pytest.raises(ValueError, match="settings.shortcut_invalid"):
        ui_settings.save_file_manager_shortcuts(tmp_path, shortcuts)


def test_save_file_manager_shortcuts_rejects_letter_without_ctrl_or_alt(tmp_path):
    with pytest.raises(ValueError, match="settings.shortcut_invalid"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path, _shortcuts_with(copy={"key": "c", "ctrl": False, "alt": False, "shift": True})
        )


def test_save_file_manager_shortcuts_rejects_delete_key_for_non_delete_action(tmp_path):
    with pytest.raises(ValueError, match="settings.shortcut_invalid"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path, _shortcuts_with(copy={"key": "Delete", "ctrl": False, "alt": False, "shift": False})
        )


def test_save_file_manager_shortcuts_rejects_delete_key_with_ctrl(tmp_path):
    with pytest.raises(ValueError, match="settings.shortcut_invalid"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path,
            _shortcuts_with(delete_recycle={"key": "Delete", "ctrl": True, "alt": False, "shift": False}),
        )


def test_save_file_manager_shortcuts_rejects_multi_char_non_delete_key(tmp_path):
    with pytest.raises(ValueError, match="settings.shortcut_invalid"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path, _shortcuts_with(copy={"key": "F1", "ctrl": True, "alt": False, "shift": False})
        )


def test_save_file_manager_shortcuts_rejects_non_boolean_modifier(tmp_path):
    with pytest.raises(ValueError, match="settings.shortcut_invalid"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path, _shortcuts_with(copy={"key": "c", "ctrl": "yes", "alt": False, "shift": False})
        )


def test_save_file_manager_shortcuts_rejects_two_actions_on_same_combo(tmp_path):
    with pytest.raises(ValueError, match="settings.shortcut_conflict"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path, _shortcuts_with(cut={"key": "c", "ctrl": True, "alt": False, "shift": False})
        )


@pytest.mark.parametrize(
    "binding",
    [
        {"key": "v", "ctrl": True, "alt": False, "shift": True},  # default global clipboard panel
        {"key": "n", "ctrl": True, "alt": False, "shift": True},  # default global quick note
        {"key": "k", "ctrl": True, "alt": False, "shift": False},  # fixed command palette
    ],
)
def test_save_file_manager_shortcuts_rejects_reserved_defaults(tmp_path, binding):
    with pytest.raises(ValueError, match="settings.shortcut_reserved"):
        ui_settings.save_file_manager_shortcuts(tmp_path, _shortcuts_with(paste=binding))


def test_save_file_manager_shortcuts_caller_reserved_replaces_global_defaults(tmp_path):
    # Once the app-global shortcuts are customized, the caller passes their
    # CURRENT combos - the old defaults must stop being blocked...
    custom_reserved = frozenset({("g", True, True, False)})
    saved = ui_settings.save_file_manager_shortcuts(
        tmp_path,
        _shortcuts_with(paste={"key": "v", "ctrl": True, "alt": False, "shift": True}),
        reserved_signatures=custom_reserved,
    )
    assert saved["paste"] == {"key": "v", "ctrl": True, "alt": False, "shift": True}
    # ...the new combos are blocked instead...
    with pytest.raises(ValueError, match="settings.shortcut_reserved"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path,
            _shortcuts_with(paste={"key": "g", "ctrl": True, "alt": True, "shift": False}),
            reserved_signatures=custom_reserved,
        )
    # ...and the fixed command palette stays blocked no matter what.
    with pytest.raises(ValueError, match="settings.shortcut_reserved"):
        ui_settings.save_file_manager_shortcuts(
            tmp_path,
            _shortcuts_with(paste={"key": "k", "ctrl": True, "alt": False, "shift": False}),
            reserved_signatures=custom_reserved,
        )


def test_load_file_manager_shortcuts_skips_reserved_check(tmp_path):
    # 与 DEFAULT 全局键冲突的已存文件（全局键被自定义改走时合法）必须原样加载，不能被静默重置为默认。
    ui_settings.save_file_manager_shortcuts(
        tmp_path,
        _shortcuts_with(paste={"key": "v", "ctrl": True, "alt": False, "shift": True}),
        reserved_signatures=frozenset(),
    )
    loaded = ui_settings.load_file_manager_shortcuts(tmp_path)
    assert loaded["paste"] == {"key": "v", "ctrl": True, "alt": False, "shift": True}


def test_load_file_manager_shortcuts_falls_back_to_defaults_for_corrupt_json(tmp_path):
    path = ui_settings.file_manager_shortcuts_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert ui_settings.load_file_manager_shortcuts(tmp_path) == ui_settings.DEFAULT_FILE_MANAGER_SHORTCUTS


def test_load_file_manager_shortcuts_falls_back_to_defaults_for_conflicting_content(tmp_path):
    import json as json_module

    path = ui_settings.file_manager_shortcuts_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json_module.dumps(_shortcuts_with(cut={"key": "c", "ctrl": True, "alt": False, "shift": False})),
        encoding="utf-8",
    )
    assert ui_settings.load_file_manager_shortcuts(tmp_path) == ui_settings.DEFAULT_FILE_MANAGER_SHORTCUTS


def test_reserved_signatures_from_bindings_converts_and_lowercases():
    signatures = ui_settings.reserved_signatures_from_bindings(
        [
            {"key": "V", "ctrl": True, "alt": False, "shift": True},
            {"key": "n", "ctrl": True, "alt": False, "shift": True},
        ]
    )
    assert signatures == frozenset({("v", True, False, True), ("n", True, False, True)})


@pytest.mark.parametrize(
    "bindings",
    [
        "not-a-list",
        [{"key": "", "ctrl": True, "alt": False, "shift": False}],
        [{"key": "v", "ctrl": "yes", "alt": False, "shift": False}],
        ["not-a-dict"],
    ],
)
def test_reserved_signatures_from_bindings_rejects_malformed_input(bindings):
    with pytest.raises(ValueError, match="settings.invalid_request"):
        ui_settings.reserved_signatures_from_bindings(bindings)
