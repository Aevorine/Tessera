"""Narrow, safe bridge from File Vault's AI chat to cua-driver.

The model gets no shell or raw cua-driver surface, only a small allowlist; input goes via stdin.
Simulated-input actions are pinned to the no-focus-steal background mode; set_value has no such
mode and writes via ValuePattern, so it never touches OS focus.
"""

import json
import os
import subprocess
from typing import Any, Dict

from modules.file_vault import errors


# 见下面 _call_driver 里的说明。非 Windows 上留空，否则 subprocess 不认识这个参数。
_NO_WINDOW_KWARGS = (
    {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    if os.name == "nt"
    else {}
)

DRIVER_COMMAND = os.environ.get("IDEAL1_CUA_DRIVER_COMMAND", "cua-driver")
SESSION_NAME = "ideal1-file-vault-ai"
_TIMEOUT_SECONDS = 30
_MAX_TREE_CHARS = 14_000
_MAX_APP_RESULTS = 12
_MAX_TYPED_CHARS = 2_000


class DesktopControlError(errors.VaultError):
    """A user-facing failure while invoking the locally installed driver."""


def _invalid_request() -> DesktopControlError:
    return DesktopControlError("ai.desktop_request_invalid")


def _call_driver(tool: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Call the driver without a shell, returning its structured JSON reply."""
    try:
        completed = subprocess.run(
            [DRIVER_COMMAND, "call", tool],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
            # 同 fingerprint.py：无控制台的 GUI 应用拉起命令行程序会弹出控制台黑框；
            # 被调方 cua-driver 是外部命令，只能在父进程一侧关掉窗口分配。
            **_NO_WINDOW_KWARGS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DesktopControlError("ai.desktop_unavailable") from exc

    if completed.returncode != 0:
        raise DesktopControlError("ai.desktop_unavailable")
    try:
        result = json.loads(completed.stdout)
    except (TypeError, ValueError) as exc:
        raise DesktopControlError("ai.desktop_unavailable") from exc
    if not isinstance(result, dict):
        raise DesktopControlError("ai.desktop_unavailable")
    return result


def _require_int(arguments: Dict[str, Any], name: str) -> int:
    value = arguments.get(name)
    # bool is an int subclass in Python, but never a useful process/window id.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _invalid_request()
    return value


def _require_nonempty_string(arguments: Dict[str, Any], name: str, max_length: int = 200) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise _invalid_request()
    return value.strip()


def _background_payload(arguments: Dict[str, Any], names: tuple[str, ...]) -> Dict[str, Any]:
    payload = {name: arguments[name] for name in names if name in arguments}
    payload["delivery_mode"] = "background"
    payload["session"] = SESSION_NAME
    return payload


def _find_apps(arguments: Dict[str, Any]) -> Dict[str, Any]:
    query = _require_nonempty_string(arguments, "query", max_length=80).casefold()
    if len(query) < 2:
        raise _invalid_request()
    raw = _call_driver("list_apps", {})
    matching = []
    for app in raw.get("apps", []):
        if not isinstance(app, dict):
            continue
        name = app.get("name")
        if not isinstance(name, str) or query not in name.casefold():
            continue
        matching.append(
            {
                "name": name,
                "pid": app.get("pid", 0) if isinstance(app.get("pid", 0), int) else 0,
                "running": bool(app.get("running")),
                "active": bool(app.get("active")),
                "kind": app.get("kind") if isinstance(app.get("kind"), str) else "desktop",
            }
        )
        if len(matching) >= _MAX_APP_RESULTS:
            break
    return {"apps": matching}


def _list_windows(arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"pid": _require_int(arguments, "pid")}
    if isinstance(arguments.get("on_screen_only"), bool):
        payload["on_screen_only"] = arguments["on_screen_only"]
    raw = _call_driver("list_windows", payload)
    windows = raw.get("windows", [])
    return {"windows": windows[:30] if isinstance(windows, list) else []}


def _window_state(arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "pid": _require_int(arguments, "pid"),
        "window_id": _require_int(arguments, "window_id"),
        # File Vault's text-only chat cannot consume the image, and keeping it
        # out avoids sending a screenshot to the configured cloud AI service.
        "include_screenshot": False,
        "max_elements": 160,
        "max_depth": 12,
        "session": SESSION_NAME,
    }
    query = arguments.get("query")
    if isinstance(query, str) and query.strip():
        payload["query"] = query.strip()[:120]
    raw = _call_driver("get_window_state", payload)
    elements = raw.get("elements", [])
    safe_elements = []
    if isinstance(elements, list):
        for element in elements[:160]:
            if not isinstance(element, dict):
                continue
            safe_elements.append(
                {
                    key: element[key]
                    for key in ("element_index", "role", "label", "frame", "parent_index", "depth")
                    if key in element
                }
            )
    tree = raw.get("tree_markdown")
    return {
        "pid": payload["pid"],
        "window_id": payload["window_id"],
        "element_count": raw.get("element_count", len(safe_elements)),
        "tree_markdown": tree[:_MAX_TREE_CHARS] if isinstance(tree, str) else "",
        "elements": safe_elements,
        "degraded": bool(raw.get("degraded")),
    }


def _launch_app(arguments: Dict[str, Any]) -> Dict[str, Any]:
    # 不接受 driver path/launch_path/aumid/arguments：应用名由 cua-driver 已安装应用索引解析，
    # 防止 AI 执行任意本地程序或命令行。
    name = _require_nonempty_string(arguments, "name", max_length=120)
    return _call_driver("launch_app", {"name": name, "start_minimized": True})


def _click(arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload = _background_payload(arguments, ("pid", "window_id", "element_index", "button", "count"))
    _require_int(payload, "pid")
    _require_int(payload, "window_id")
    _require_int(payload, "element_index")
    if payload.get("button") not in (None, "left", "right", "middle"):
        raise _invalid_request()
    if "count" in payload and (isinstance(payload["count"], bool) or not isinstance(payload["count"], int) or not 1 <= payload["count"] <= 3):
        raise _invalid_request()
    return _call_driver("click", payload)


def _type_text(arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload = _background_payload(arguments, ("pid", "window_id", "element_index", "text", "delay_ms"))
    _require_int(payload, "pid")
    _require_int(payload, "window_id")
    _require_int(payload, "element_index")
    text = _require_nonempty_string(payload, "text", max_length=_MAX_TYPED_CHARS)
    payload["text"] = text
    if "delay_ms" in payload and (isinstance(payload["delay_ms"], bool) or not isinstance(payload["delay_ms"], int) or not 0 <= payload["delay_ms"] <= 200):
        raise _invalid_request()
    return _call_driver("type_text", payload)


def _set_value(arguments: Dict[str, Any]) -> Dict[str, Any]:
    # 刻意不走 _background_payload：cua-driver 的 set_value 没有 delivery_mode 概念
    # （ValuePattern.SetValue 是纯无障碍写入），且 schema 为 additionalProperties:false，
    # 带上 delivery_mode 会使调用失败。
    payload: Dict[str, Any] = {
        name: arguments[name] for name in ("pid", "window_id", "element_index", "value") if name in arguments
    }
    payload["session"] = SESSION_NAME
    _require_int(payload, "pid")
    _require_int(payload, "window_id")
    _require_int(payload, "element_index")
    payload["value"] = _require_nonempty_string(payload, "value", max_length=_MAX_TYPED_CHARS)
    return _call_driver("set_value", payload)


def _scroll(arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload = _background_payload(arguments, ("pid", "window_id", "direction", "amount", "by"))
    _require_int(payload, "pid")
    _require_int(payload, "window_id")
    if payload.get("direction") not in {"up", "down", "left", "right"}:
        raise _invalid_request()
    if "amount" in payload and (isinstance(payload["amount"], bool) or not isinstance(payload["amount"], int) or not 1 <= payload["amount"] <= 50):
        raise _invalid_request()
    if payload.get("by") not in (None, "line", "page"):
        raise _invalid_request()
    return _call_driver("scroll", payload)


_SAFE_KEYS = {"return", "tab", "escape", "up", "down", "left", "right", "space", "home", "end", "pageup", "pagedown"}


def _press_key(arguments: Dict[str, Any]) -> Dict[str, Any]:
    payload = _background_payload(arguments, ("pid", "window_id", "element_index", "key"))
    _require_int(payload, "pid")
    _require_int(payload, "window_id")
    _require_int(payload, "element_index")
    if payload.get("key") not in _SAFE_KEYS:
        raise _invalid_request()
    return _call_driver("press_key", payload)


_ACTIONS = {
    "desktop_find_apps": _find_apps,
    "desktop_list_windows": _list_windows,
    "desktop_get_window_state": _window_state,
    "desktop_launch_app": _launch_app,
    "desktop_click": _click,
    "desktop_type_text": _type_text,
    "desktop_set_value": _set_value,
    "desktop_scroll": _scroll,
    "desktop_press_key": _press_key,
}


def execute(action: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Execute one allowlisted model tool call against cua-driver."""
    handler = _ACTIONS.get(action)
    if handler is None:
        raise DesktopControlError("ai.desktop_action_blocked")
    if not isinstance(arguments, dict):
        raise _invalid_request()
    return handler(arguments)
