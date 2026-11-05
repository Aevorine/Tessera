"""AI 桌面动作的人工确认：动作执行前推一条确认请求给界面，等用户「允许 / 本轮全部允许 / 拒绝」；超时按拒绝。

读取类工具（找应用、列窗口、读窗口状态）和滚动不问；开应用、点击、输入、设值、按键必须问。
"""

import secrets
import threading
import time
from typing import Any, Callable, Dict, Optional

ACTION_TOOLS = frozenset({
    "desktop_launch_app",
    "desktop_click",
    "desktop_type_text",
    "desktop_set_value",
    "desktop_press_key",
})
DECISIONS = frozenset({"allow", "allow_all", "deny"})
TIMEOUT_S = 120.0
HEARTBEAT_S = 5.0
# 要输入的文字全文显示：上限与 desktop_control._MAX_TYPED_CHARS 相同，更长的执行时本来就会被拒
_MAX_TEXT_SHOWN = 2_000
_MAX_SHOWN = 300


def _clip(value: Any, limit: int = _MAX_SHOWN) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return value if len(value) <= limit else value[:limit] + "…"


def summarize(tool: str, arguments: Dict[str, Any], process_image: Callable[[int], Optional[str]]) -> Dict[str, Any]:
    """只挑界面要显示的字段：应用名 / 目标进程 / 要输入的文字 / 按键 / 鼠标键。"""
    out: Dict[str, Any] = {}
    if tool == "desktop_launch_app":
        out["app"] = _clip(arguments.get("name"))
    pid = arguments.get("pid")
    if isinstance(pid, int) and not isinstance(pid, bool):
        out["process"] = process_image(pid) or str(pid)
    if tool == "desktop_type_text":
        out["text"] = _clip(arguments.get("text"), _MAX_TEXT_SHOWN)
    if tool == "desktop_set_value":
        out["text"] = _clip(arguments.get("value"), _MAX_TEXT_SHOWN)
    if tool == "desktop_press_key":
        out["key"] = _clip(arguments.get("key"))
    if tool == "desktop_click":
        out["button"] = _clip(arguments.get("button")) or "left"
        count = arguments.get("count")
        if isinstance(count, int) and not isinstance(count, bool):
            out["count"] = count
    if isinstance(arguments.get("element_index"), int):
        out["element"] = arguments["element_index"]
    return {k: v for k, v in out.items() if v is not None}


class ApprovalBroker:
    """一次请求一个等待位；respond 由界面经 RPC 调用。锁定时后端进程整个重起，等待随之消失。"""

    def __init__(self, emit: Callable[[Dict[str, Any]], None], timeout_s: float = TIMEOUT_S):
        self._emit = emit
        self._timeout_s = timeout_s
        self._lock = threading.Lock()
        self._waiters: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def needs_approval(tool: str) -> bool:
        return tool in ACTION_TOOLS

    def request(self, tool: str, summary: Dict[str, Any], turn: Dict[str, Any]) -> str:
        """返回 allow / deny / timeout。turn 是一次 AI 回复的共享状态：「本轮全部允许」记在里面，
        turn["heartbeat"] 在等待期间每 HEARTBEAT_S 秒调一次。"""
        if not self.needs_approval(tool) or turn.get("allow_all"):
            return "allow"
        cid = secrets.token_hex(8)
        waiter: Dict[str, Any] = {"event": threading.Event(), "decision": None}
        with self._lock:
            self._waiters[cid] = waiter
        try:
            self._emit({"event": "ai_desktop_confirm", "id": cid, "tool": tool, "summary": summary,
                        "timeout_s": int(self._timeout_s)})
            heartbeat = turn.get("heartbeat")
            deadline = time.monotonic() + self._timeout_s
            while not waiter["event"].is_set():
                left = deadline - time.monotonic()
                if left <= 0 or waiter["event"].wait(min(HEARTBEAT_S, left)):
                    break
                if callable(heartbeat):
                    heartbeat()
        finally:
            with self._lock:
                self._waiters.pop(cid, None)
        decision = waiter["decision"]
        if decision is None:
            self._emit({"event": "ai_desktop_confirm_closed", "id": cid})
            return "timeout"
        if decision == "allow_all":
            turn["allow_all"] = True
            return "allow"
        return "allow" if decision == "allow" else "deny"

    def respond(self, cid: Any, decision: Any) -> bool:
        if not isinstance(cid, str) or decision not in DECISIONS:
            return False
        with self._lock:
            waiter = self._waiters.get(cid)
        if waiter is None:
            return False
        waiter["decision"] = decision
        waiter["event"].set()
        return True

    def pending(self) -> int:
        with self._lock:
            return len(self._waiters)
