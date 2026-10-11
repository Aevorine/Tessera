"""Plaintext UI-preference store, separate from the encrypted vault (passwords.py); non-secret display prefs only, so no IMK."""

import json
from pathlib import Path

SETTINGS_FILENAME = "password_ui_settings.json"
SORT_MODES = ("recent", "alphabetical", "host")
DEFAULT_SORT_MODE = "recent"

MODULE_LOCK_FILENAME = "module_lock_settings.json"
# "pcclean" 代表整个清理套件而非每个标签页（见 ui/src/shared/ipcTypes.ts 的 LockableModule）。
# 追加而非插入：旧文件缺该键时由 load_module_lock_settings 用默认值补，保持向前兼容。
LOCKABLE_MODULES = ("files", "clipboard", "passwords", "recoverycodes", "notes", "ai", "network", "filemanager", "pcclean")
DEFAULT_MODULE_LOCK_SETTINGS = {module: False for module in LOCKABLE_MODULES}


def settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / SETTINGS_FILENAME


def load_sort_mode(data_dir: Path) -> str:
    """Return the saved sort mode, or DEFAULT_SORT_MODE if the file is missing or invalid (never block the password list)."""
    path = settings_path(data_dir)
    if not path.exists():
        return DEFAULT_SORT_MODE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return DEFAULT_SORT_MODE
    mode = data.get("sort_mode") if isinstance(data, dict) else None
    return mode if mode in SORT_MODES else DEFAULT_SORT_MODE


def save_sort_mode(data_dir: Path, mode: str) -> None:
    if mode not in SORT_MODES:
        raise ValueError(f"invalid sort mode: {mode!r}")
    path = settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps({"sort_mode": mode}), encoding="utf-8")
    tmp_path.replace(path)


def module_lock_settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / MODULE_LOCK_FILENAME


def load_module_lock_settings(data_dir: Path) -> dict:
    """Per-module 'require fresh unlock factor' toggle; non-secret plaintext, no IMK needed. Missing/corrupt data falls back to unlocked per module so one bad key can't block the others."""
    path = module_lock_settings_path(data_dir)
    if not path.exists():
        return dict(DEFAULT_MODULE_LOCK_SETTINGS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(DEFAULT_MODULE_LOCK_SETTINGS)
    if not isinstance(data, dict):
        return dict(DEFAULT_MODULE_LOCK_SETTINGS)
    return {
        module: bool(data.get(module, False)) if isinstance(data.get(module, False), bool) else False
        for module in LOCKABLE_MODULES
    }


def save_module_lock_setting(data_dir: Path, module: str, enabled: bool) -> None:
    if module not in LOCKABLE_MODULES:
        raise ValueError(f"invalid module: {module!r}")
    settings = load_module_lock_settings(data_dir)
    settings[module] = bool(enabled)
    path = module_lock_settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps(settings), encoding="utf-8")
    tmp_path.replace(path)


NOTE_IMAGE_SETTINGS_FILENAME = "notes_image_settings.json"
NOTE_IMAGE_STORAGE_MODES = ("encrypted_db", "disk_plain")
DEFAULT_NOTE_IMAGE_STORAGE_MODE = "encrypted_db"


def note_image_settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / NOTE_IMAGE_SETTINGS_FILENAME


def load_note_image_storage_mode(data_dir: Path) -> str:
    """Backend for new note images: 'encrypted_db' (inside the SQLCipher notes.db) or 'disk_plain' (plain files, like clipboard images).
    Non-secret plaintext preference; only affects images added afterwards (see note_images.storage_mode in notes/storage.py)."""
    path = note_image_settings_path(data_dir)
    if not path.exists():
        return DEFAULT_NOTE_IMAGE_STORAGE_MODE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return DEFAULT_NOTE_IMAGE_STORAGE_MODE
    mode = data.get("storage_mode") if isinstance(data, dict) else None
    return mode if mode in NOTE_IMAGE_STORAGE_MODES else DEFAULT_NOTE_IMAGE_STORAGE_MODE


def save_note_image_storage_mode(data_dir: Path, mode: str) -> None:
    if mode not in NOTE_IMAGE_STORAGE_MODES:
        raise ValueError(f"invalid note image storage mode: {mode!r}")
    path = note_image_settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps({"storage_mode": mode}), encoding="utf-8")
    tmp_path.replace(path)


NOTE_TEXT_SETTINGS_FILENAME = "notes_text_settings.json"
NOTE_TEXT_STORAGE_MODES = ("encrypted_db", "disk_plain")
DEFAULT_NOTE_TEXT_STORAGE_MODE = "encrypted_db"

FILE_MANAGER_SHORTCUTS_FILENAME = "file_manager_shortcuts.json"
FILE_MANAGER_SHORTCUT_ACTIONS = (
    "copy",
    "cut",
    "paste",
    "delete_recycle",
    "delete_permanent",
)
DEFAULT_FILE_MANAGER_SHORTCUTS = {
    "copy": {"key": "c", "ctrl": True, "alt": False, "shift": False},
    "cut": {"key": "x", "ctrl": True, "alt": False, "shift": False},
    "paste": {"key": "v", "ctrl": True, "alt": False, "shift": False},
    "delete_recycle": {"key": "Delete", "ctrl": False, "alt": False, "shift": False},
    "delete_permanent": {"key": "Delete", "ctrl": False, "alt": False, "shift": True},
}
# 仅保存时校验：文件管理器快捷键不得占用的组合。Ctrl+K 是固定命令面板；两个全局快捷键只是默认值，
# 用户改过后 RPC 层传入当前绑定。加载时刻意不校验，否则碰撞会在每次读取时静默重置全部绑定。
_BUILTIN_RESERVED_SHORTCUT_SIGNATURES = frozenset({
    ("k", True, False, False),  # application command palette (fixed)
})
_DEFAULT_RESERVED_SHORTCUT_SIGNATURES = frozenset({
    ("v", True, False, True),   # Electron global clipboard panel (default)
    ("n", True, False, True),   # Electron global quick note (default)
})


def file_manager_shortcuts_path(data_dir: Path) -> Path:
    return Path(data_dir) / FILE_MANAGER_SHORTCUTS_FILENAME


def _shortcut_signature(binding: dict) -> tuple:
    return (binding["key"].lower(), binding["ctrl"], binding["alt"], binding["shift"])


def reserved_signatures_from_bindings(bindings) -> frozenset:
    """Convert the frontend's current global shortcuts ({key, ctrl, alt, shift} dicts) into signature tuples for the reserved check. Raises ValueError on malformed input."""
    if not isinstance(bindings, list):
        raise ValueError("settings.invalid_request")
    signatures = set()
    for binding in bindings:
        if not isinstance(binding, dict):
            raise ValueError("settings.invalid_request")
        key = binding.get("key")
        modifiers = (binding.get("ctrl"), binding.get("alt"), binding.get("shift"))
        if not isinstance(key, str) or not key or not all(isinstance(value, bool) for value in modifiers):
            raise ValueError("settings.invalid_request")
        signatures.add((key.lower(),) + modifiers)
    return frozenset(signatures)


def _validate_file_manager_shortcuts(candidate, reserved_signatures=None) -> dict:
    if not isinstance(candidate, dict) or set(candidate) != set(FILE_MANAGER_SHORTCUT_ACTIONS):
        raise ValueError("settings.shortcut_invalid")

    normalized = {}
    for action in FILE_MANAGER_SHORTCUT_ACTIONS:
        binding = candidate[action]
        if not isinstance(binding, dict) or set(binding) != {"key", "ctrl", "alt", "shift"}:
            raise ValueError("settings.shortcut_invalid")
        key = binding["key"]
        modifiers = (binding["ctrl"], binding["alt"], binding["shift"])
        if not isinstance(key, str) or not key or not all(isinstance(value, bool) for value in modifiers):
            raise ValueError("settings.shortcut_invalid")
        normalized_key = key.lower()
        is_delete = normalized_key == "delete"
        is_single_alphanumeric = len(normalized_key) == 1 and normalized_key.isalnum()
        if is_single_alphanumeric:
            if not (binding["ctrl"] or binding["alt"]):
                raise ValueError("settings.shortcut_invalid")
        elif not is_delete:
            raise ValueError("settings.shortcut_invalid")
        if is_delete and action not in ("delete_recycle", "delete_permanent"):
            raise ValueError("settings.shortcut_invalid")
        if is_delete and (binding["ctrl"] or binding["alt"]):
            raise ValueError("settings.shortcut_invalid")
        normalized[action] = {
            "key": "Delete" if is_delete else normalized_key,
            "ctrl": binding["ctrl"],
            "alt": binding["alt"],
            "shift": binding["shift"],
        }

    signatures = [_shortcut_signature(binding) for binding in normalized.values()]
    if len(set(signatures)) != len(signatures):
        raise ValueError("settings.shortcut_conflict")
    reserved = _BUILTIN_RESERVED_SHORTCUT_SIGNATURES | (
        _DEFAULT_RESERVED_SHORTCUT_SIGNATURES
        if reserved_signatures is None
        else frozenset(reserved_signatures)
    )
    if any(signature in reserved for signature in signatures):
        raise ValueError("settings.shortcut_reserved")
    return normalized


def load_file_manager_shortcuts(data_dir: Path) -> dict:
    path = file_manager_shortcuts_path(data_dir)
    if not path.exists():
        return {action: dict(binding) for action, binding in DEFAULT_FILE_MANAGER_SHORTCUTS.items()}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return _validate_file_manager_shortcuts(data, reserved_signatures=frozenset())
    except (OSError, ValueError):
        return {action: dict(binding) for action, binding in DEFAULT_FILE_MANAGER_SHORTCUTS.items()}


def save_file_manager_shortcuts(data_dir: Path, shortcuts: dict, reserved_signatures=None) -> dict:
    normalized = _validate_file_manager_shortcuts(shortcuts, reserved_signatures=reserved_signatures)
    path = file_manager_shortcuts_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps(normalized), encoding="utf-8")
    tmp_path.replace(path)
    return normalized



def note_text_settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / NOTE_TEXT_SETTINGS_FILENAME


def load_note_text_storage_mode(data_dir: Path) -> str:
    """UI default only: which choice the encrypt toggle in note-creation/folder-import dialogs starts on.
    Each note-text write carries an explicit `encrypt` flag; the backend never reads this setting. Non-secret, no IMK."""
    path = note_text_settings_path(data_dir)
    if not path.exists():
        return DEFAULT_NOTE_TEXT_STORAGE_MODE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return DEFAULT_NOTE_TEXT_STORAGE_MODE
    mode = data.get("storage_mode") if isinstance(data, dict) else None
    return mode if mode in NOTE_TEXT_STORAGE_MODES else DEFAULT_NOTE_TEXT_STORAGE_MODE


def save_note_text_storage_mode(data_dir: Path, mode: str) -> None:
    if mode not in NOTE_TEXT_STORAGE_MODES:
        raise ValueError(f"invalid note text storage mode: {mode!r}")
    path = note_text_settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps({"storage_mode": mode}), encoding="utf-8")
    tmp_path.replace(path)


NOTE_SORT_SETTINGS_FILENAME = "notes_sort_settings.json"
# 必须与 notes/storage.py 的 _SORT_CLAUSES 逐字对齐；不 import 它，因为会拉起 sqlcipher，
# 而本模块只做不碰加密层的显示偏好。漂移由 test_notes_sort_order.py 的断言挡住。
NOTE_SORT_MODES = ("created", "updated", "title", "manual")
DEFAULT_NOTE_SORT_MODE = "created"


def note_sort_settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / NOTE_SORT_SETTINGS_FILENAME


def load_note_sort_mode(data_dir: Path) -> str:
    """Notes list sort order; non-secret plaintext, outside the IMK. Default 'created' matches the pre-configurable ordering, so upgraded vaults look unchanged."""
    path = note_sort_settings_path(data_dir)
    if not path.exists():
        return DEFAULT_NOTE_SORT_MODE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return DEFAULT_NOTE_SORT_MODE
    mode = data.get("sort_mode") if isinstance(data, dict) else None
    return mode if mode in NOTE_SORT_MODES else DEFAULT_NOTE_SORT_MODE


def save_note_sort_mode(data_dir: Path, mode: str) -> None:
    if mode not in NOTE_SORT_MODES:
        raise ValueError(f"invalid note sort mode: {mode!r}")
    path = note_sort_settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps({"sort_mode": mode}), encoding="utf-8")
    tmp_path.replace(path)
