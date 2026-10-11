"""Persistent display preferences shared by the app and FileHook runtime."""

import ctypes
import hashlib
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Mapping, Optional

from core.logging import get_logger


logger = get_logger(__name__)

DEFAULT_PREFERENCES = {
    "position": "bottom-right",
    "auto_hide_seconds": 5,
    "compact": False,
}
VALID_POSITIONS = frozenset({
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
})
VALID_AUTO_HIDE_SECONDS = frozenset({3, 5, 10})
PREFERENCES_FILENAME = "progress_preferences.json"
PREFERENCE_WRITE_LOCK_TIMEOUT_SECONDS = 2.0

# 换名重试：Windows 上 os.replace 会因别的进程（多为杀毒软件，开句柄不带
# FILE_SHARE_DELETE）短暂持有句柄报 ACCESS_DENIED(5)/SHARING_VIOLATION(32)，毫秒级，
# 退让重试即可；总时长压在 1 秒内，保存界面偏好宁可失败也不能卡住。
_REPLACE_RETRY_DELAYS_SECONDS = (0.01, 0.02, 0.04, 0.08, 0.15, 0.3, 0.4)
_REPLACE_RETRY_WINERRORS = frozenset({5, 32})

_WAIT_OBJECT_0 = 0
_WAIT_ABANDONED = 0x80
_WAIT_TIMEOUT = 0x102
_WAIT_FAILED = 0xFFFFFFFF

if os.name == "nt":
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateMutexW.argtypes = (
        ctypes.c_void_p,
        ctypes.c_bool,
        ctypes.c_wchar_p,
    )
    _kernel32.CreateMutexW.restype = ctypes.c_void_p
    _kernel32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
    _kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    _kernel32.ReleaseMutex.argtypes = (ctypes.c_void_p,)
    _kernel32.ReleaseMutex.restype = ctypes.c_bool
    _kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    _kernel32.CloseHandle.restype = ctypes.c_bool
else:
    _kernel32 = None


def preferences_path() -> Path:
    """Return the stable LocalAppData path used by every FileHook runtime."""
    from core.fileops.system_integration import _default_install_root

    return _default_install_root() / PREFERENCES_FILENAME


def _preference_mutex_name(target: Path) -> str:
    """Return a stable user-session mutex name for this exact target path."""
    normalized = str(target.resolve()).casefold().encode("utf-8")
    digest = hashlib.sha256(normalized).hexdigest()
    return f"Local\\Ideal1FileVaultProgressPreferences-{digest}"


@contextmanager
def _preference_write_lock(target: Path, timeout_seconds: Optional[float] = None):
    """Serialize preference replacement across app and independent hook processes."""
    if _kernel32 is None:
        yield
        return
    timeout = (
        PREFERENCE_WRITE_LOCK_TIMEOUT_SECONDS
        if timeout_seconds is None
        else timeout_seconds
    )
    timeout_ms = max(1, int(timeout * 1000))
    handle = _kernel32.CreateMutexW(None, False, _preference_mutex_name(target))
    if not handle:
        raise OSError(
            ctypes.get_last_error(), "could not create progress preference write lock"
        )
    acquired = False
    try:
        wait_result = _kernel32.WaitForSingleObject(handle, timeout_ms)
        if wait_result in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
            acquired = True
            if wait_result == _WAIT_ABANDONED:
                logger.warning("Recovered abandoned progress preference write lock")
        elif wait_result == _WAIT_TIMEOUT:
            raise OSError(1460, "timed out acquiring progress preference write lock")
        elif wait_result == _WAIT_FAILED:
            raise OSError(
                ctypes.get_last_error(), "could not acquire progress preference write lock"
            )
        else:
            raise OSError("could not acquire progress preference write lock")
        yield
    finally:
        if acquired:
            _kernel32.ReleaseMutex(handle)
        _kernel32.CloseHandle(handle)


def _replace_with_retry(temporary: Path, target: Path) -> None:
    """os.replace，但等过 Windows 上第三方进程造成的瞬时占用。

    只对 ACCESS_DENIED / SHARING_VIOLATION 重试；其他错误（路径不存在、磁盘满等）重试无益，须立刻抛出。
    """
    for delay in _REPLACE_RETRY_DELAYS_SECONDS:
        try:
            os.replace(temporary, target)
            return
        except OSError as exc:
            if getattr(exc, "winerror", None) not in _REPLACE_RETRY_WINERRORS:
                raise
            time.sleep(delay)
    # 最后一次不再吞异常：等了近一秒还占着，说明不是扫毒那种一闪而过的占用，
    # 调用方应该拿到真实的错误。
    os.replace(temporary, target)


def is_valid_preferences(preferences: object) -> bool:
    """Return whether *preferences* has exactly the supported preference values."""
    if not isinstance(preferences, Mapping):
        return False
    if set(preferences) != set(DEFAULT_PREFERENCES):
        return False
    return (
        preferences.get("position") in VALID_POSITIONS
        and type(preferences.get("auto_hide_seconds")) is int
        and preferences["auto_hide_seconds"] in VALID_AUTO_HIDE_SECONDS
        and type(preferences.get("compact")) is bool
    )


def load_preferences(path: Optional[Path] = None) -> dict:
    """Load valid preferences, falling back safely when absent or malformed."""
    target = Path(path) if path is not None else preferences_path()
    try:
        with target.open("r", encoding="utf-8") as handle:
            preferences = json.load(handle)
    except FileNotFoundError:
        return dict(DEFAULT_PREFERENCES)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "Progress preferences unavailable at %s; using defaults (%s)", target, exc
        )
        return dict(DEFAULT_PREFERENCES)
    if not is_valid_preferences(preferences):
        logger.warning("Invalid progress preferences at %s; using defaults", target)
        return dict(DEFAULT_PREFERENCES)
    return dict(preferences)


def save_preferences(preferences: Mapping, path: Optional[Path] = None) -> dict:
    """Atomically persist one validated preference set beside the target file."""
    if not is_valid_preferences(preferences):
        raise ValueError("invalid progress preferences")
    target = Path(path) if path is not None else preferences_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with _preference_write_lock(target):
        temporary = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                dir=target.parent,
                prefix=target.name + ".",
                suffix=".tmp",
            )
            temporary = Path(temporary_name)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(dict(preferences), handle, ensure_ascii=False, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            _replace_with_retry(temporary, target)
        except Exception:
            if temporary is not None:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass
            raise
    return dict(preferences)
