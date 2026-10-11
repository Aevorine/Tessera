# -*- coding: utf-8 -*-
"""把 Tessera 作为 MCP 服务器暴露出去，让 Claude Code 直接当工具调用。

装法（在 Claude Code 里跑一次）：

    claude mcp add tessera -- <python> -X utf8 -m modules.file_vault.agent.mcp_server

或者写进 `.mcp.json`：

    {"mcpServers": {"tessera": {
        "command": "<path-to-python>/python.exe",
        "args": ["-X", "utf8", "-m", "modules.file_vault.agent.mcp_server"],
        "cwd": "<project-root>",
        "env": {"TESSERA_MCP_PASSWORD_FILE": "D:/…/tessera-pw.txt"}
    }}}

## 密码只从文件来，绝不从对话里来

需要金库的工具在 `TESSERA_MCP_PASSWORD_FILE` 没设时**一律拒绝**，并在回答里说明
该怎么开。它**不会**反过来向模型要密码。

理由：MCP 工具的入参会原样进入模型上下文，并落进 Claude Code 的会话记录。一个
`password` 参数等于把金库主密码写进聊天记录，还会被后续每一轮重新读一遍。
把它设计成"根本没有这个参数"，比写一句"请勿在此填写密码"可靠得多。

## 默认只读，写操作要显式打开

`TESSERA_MCP_ALLOW_WRITE=1` 之前，建笔记 / 加密 / 解密这三个会改动东西的工具
不注册——`tools/list` 里根本看不到它们。模型选不了一个不存在的工具，这比在工具
内部临时判断可靠。

## stdout 是协议通道

任何调试输出都必须走 stderr。往 stdout 写一个字节的非协议内容，客户端解析就崩，
而报错内容跟真正的原因毫无关系。
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from modules.file_vault.agent.session import VaultError, VaultSession

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "tessera"

# 剪贴板列表里最多回多少条。模型的上下文很贵，一次灌 5000 条历史除了烧钱没有
# 任何用处——真要找东西该用 search 而不是把整个库读进来。
MAX_CLIPBOARD_ROWS = 50


def log(message: str) -> None:
    """调试输出。**只能走 stderr**，见模块头注释。"""
    print("[tessera-mcp] " + message, file=sys.stderr, flush=True)


class Unavailable(RuntimeError):
    """这次调用做不了，但不是崩溃——原因会原样讲给用户听。"""


class Backend:
    """按需起一个后端子进程并解锁，之后整个进程生命周期内复用。"""

    def __init__(self) -> None:
        self._session: Optional[VaultSession] = None
        self._unlocked = False

    def _password(self) -> str:
        path = os.environ.get("TESSERA_MCP_PASSWORD_FILE")
        if not path:
            raise Unavailable(
                "这个工具需要解锁金库，但没有配置密码来源，所以拒绝执行。\n"
                "打开方法：把主密码写进一个只有你自己能读的文件，然后在这个 MCP "
                "服务器的配置里设 TESSERA_MCP_PASSWORD_FILE 指向它。\n"
                "（不要把密码发在对话里——工具入参会进入模型上下文和会话记录。）"
            )
        try:
            secret = Path(path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise Unavailable("读不到 TESSERA_MCP_PASSWORD_FILE 指向的文件：{}".format(exc))
        if not secret:
            raise Unavailable("TESSERA_MCP_PASSWORD_FILE 指向的文件是空的。")
        return secret

    def plain(self) -> VaultSession:
        """拿一个后端会话，**不解锁**。给那些跟金库数据无关的工具用。"""
        if self._session is None:
            # `TESSERA_DATA_DIR` 换一个数据目录，跟命令行的 --data-dir 同义。
            # 不设就用应用自己那个（后端自行解析）。
            override = os.environ.get("TESSERA_DATA_DIR")
            self._session = VaultSession(data_dir=Path(override) if override else None)
        return self._session

    def unlocked(self) -> VaultSession:
        session = self.plain()
        if not self._unlocked:
            if not session.identity_exists():
                raise Unavailable("这台机器上还没有金库。先打开 Tessera 走一遍首次设置。")
            session.unlock(self._password())
            self._unlocked = True
        return session

    def close(self) -> None:
        if self._session is not None:
            self._session.close()
            self._session = None
            self._unlocked = False


BACKEND = Backend()


def allow_write() -> bool:
    return os.environ.get("TESSERA_MCP_ALLOW_WRITE") == "1"


# --- 工具实现 --------------------------------------------------------------


def tool_status(args: dict) -> str:
    session = BACKEND.plain()
    exists = session.identity_exists()
    info = session.call("data_dir_info", {})
    return json.dumps({
        "initialised": exists,
        "data_dir": info.get("path"),
        "write_tools_enabled": allow_write(),
        "password_source_configured": bool(os.environ.get("TESSERA_MCP_PASSWORD_FILE")),
    }, ensure_ascii=False, indent=2)


def tool_pcclean_tools(args: dict) -> str:
    result = BACKEND.plain().call("pcclean_tools", {})
    tools = [{"id": t.get("id"), "name": t.get("name")} for t in result.get("tools", [])]
    return json.dumps(tools, ensure_ascii=False, indent=2)


def tool_search(args: dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        raise Unavailable("query 不能为空。")
    result = BACKEND.unlocked().call("global_search", {"query": query})
    hits = [{"module": h.get("module"), "id": h.get("id"), "label": h.get("label")}
            for h in result.get("results", [])]
    return json.dumps(hits, ensure_ascii=False, indent=2)


def tool_note_list(args: dict) -> str:
    result = BACKEND.unlocked().call("note_list", {})
    notes = [{"id": n.get("id"), "title": n.get("title"), "category": n.get("category")}
             for n in result.get("notes", [])]
    return json.dumps(notes, ensure_ascii=False, indent=2)


def tool_note_get(args: dict) -> str:
    note_id = args.get("id")
    if note_id is None:
        raise Unavailable("要给出笔记 id。")
    result = BACKEND.unlocked().call("note_get", {"id": int(note_id)})
    if not result.get("ok"):
        raise Unavailable("取不到这条笔记：{}".format(result.get("error")))
    note = result["note"]
    return "# {}\n\n{}".format(note.get("title", ""), note.get("content", ""))


def tool_note_create(args: dict) -> str:
    title = (args.get("title") or "").strip()
    if not title:
        raise Unavailable("title 不能为空。")
    result = BACKEND.unlocked().call("note_create", {
        "title": title,
        "content": args.get("content") or "",
        "category": args.get("category") or "",
        "format": args.get("format") or "markdown",
    })
    if not result.get("ok"):
        raise Unavailable("建不了这条笔记：{}".format(result.get("error")))
    return "已建立笔记 #{}：{}".format(result["note"]["id"], result["note"].get("title", ""))


def _clip_rows(entries) -> str:
    rows = []
    for entry in entries[:MAX_CLIPBOARD_ROWS]:
        # 敏感条目（密码/API Key/卡号）永远不交出正文：进了模型上下文就进了会话记录。
        # 要用某条密钥，用户自己去应用里点。
        if entry.get("is_sensitive"):
            text = "〔敏感内容，未提供〕"
        else:
            text = entry.get("content_text") or ""
        rows.append({"id": entry.get("id"), "type": entry.get("content_type"), "text": text})
    return json.dumps(rows, ensure_ascii=False, indent=2)


def tool_clipboard_recent(args: dict) -> str:
    limit = min(int(args.get("limit") or 20), MAX_CLIPBOARD_ROWS)
    result = BACKEND.unlocked().call("clipboard_list", {"limit": limit})
    return _clip_rows(result.get("entries", []))


def tool_clipboard_search(args: dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        raise Unavailable("query 不能为空。")
    limit = min(int(args.get("limit") or 20), MAX_CLIPBOARD_ROWS)
    result = BACKEND.unlocked().call("clipboard_search", {"query": query, "limit": limit})
    return _clip_rows(result.get("entries", []))


def _crypt(args: dict, method: str, default_suffix: str, strip_suffix: Optional[str]) -> str:
    src = Path(str(args.get("input_path") or "")).expanduser()
    if not src.is_file():
        raise Unavailable("找不到这个文件：{}".format(src))
    src = src.resolve()
    raw_out = args.get("output_path")
    if raw_out:
        dst = Path(str(raw_out)).expanduser().resolve()
    elif strip_suffix and src.name.endswith(strip_suffix):
        dst = src.with_name(src.name[: -len(strip_suffix)])
    else:
        dst = src.with_name(src.name + default_suffix)
    # 覆盖永远拒绝，且没有 force 参数可以绕过。模型推错一个输出路径的代价是
    # 用户唯一那份原件被盖掉，而它不会知道自己推错了。
    if dst.exists():
        raise Unavailable("目标已存在，为安全起见不覆盖：{}".format(dst))
    result = BACKEND.unlocked().call(method, {"input_path": str(src), "output_path": str(dst)})
    if not result.get("ok"):
        raise Unavailable("失败：{}".format(result.get("error")))
    return "完成：{}".format(dst)


def tool_encrypt_file(args: dict) -> str:
    return _crypt(args, "encrypt_file", ".ivault", None)


def tool_decrypt_file(args: dict) -> str:
    return _crypt(args, "decrypt_file", ".decrypted", ".ivault")


# --- 工具表 ----------------------------------------------------------------

_STR = {"type": "string"}
_INT = {"type": "integer"}


def _tool(name: str, description: str, properties: dict, required: list,
          handler: Callable[[dict], str], write: bool = False) -> dict:
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required},
        "_handler": handler,
        "_write": write,
    }


ALL_TOOLS = [
    _tool("tessera_status",
          "Tessera 金库的状态：建了没、数据目录在哪、写操作有没有打开。不需要解锁。",
          {}, [], tool_status),
    _tool("tessera_pcclean_tools",
          "列出 Tessera 电脑清理里那批小工具（id 和名字）。不需要解锁。",
          {}, [], tool_pcclean_tools),
    _tool("tessera_search",
          "跨笔记、剪贴板历史、密码库搜索，返回命中项的模块 / id / 标题。不返回任何密码明文。",
          {"query": _STR}, ["query"], tool_search),
    _tool("tessera_note_list",
          "列出金库里全部笔记的 id、标题、分类（不含正文）。",
          {}, [], tool_note_list),
    _tool("tessera_note_get",
          "按 id 读一条笔记的完整正文。",
          {"id": _INT}, ["id"], tool_note_get),
    _tool("tessera_clipboard_recent",
          "最近的剪贴板历史条目。被判定为敏感的条目只报类型，不给正文。",
          {"limit": _INT}, [], tool_clipboard_recent),
    _tool("tessera_clipboard_search",
          "全文搜索剪贴板历史。被判定为敏感的条目只报类型，不给正文。",
          {"query": _STR, "limit": _INT}, ["query"], tool_clipboard_search),
    _tool("tessera_note_create",
          "在金库里新建一条笔记。",
          {"title": _STR, "content": _STR, "category": _STR,
           "format": {"type": "string", "enum": ["plain", "markdown"]}},
          ["title"], tool_note_create, write=True),
    _tool("tessera_encrypt_file",
          "把一个文件加密成 .ivault。目标已存在时拒绝，不覆盖。",
          {"input_path": _STR, "output_path": _STR}, ["input_path"], tool_encrypt_file, write=True),
    _tool("tessera_decrypt_file",
          "解开一个 .ivault 文件。目标已存在时拒绝，不覆盖。",
          {"input_path": _STR, "output_path": _STR}, ["input_path"], tool_decrypt_file, write=True),
]


def active_tools() -> Dict[str, dict]:
    return {t["name"]: t for t in ALL_TOOLS if allow_write() or not t["_write"]}


# --- JSON-RPC 循环 ----------------------------------------------------------


def _result(request_id: Any, payload: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def _error(request_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _text(body: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": body}], "isError": is_error}


def handle(request: dict) -> Optional[dict]:
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params") or {}

    # 通知（没有 id）不需要也不允许回响应。`notifications/initialized` 走这条。
    if request_id is None:
        return None

    if method == "initialize":
        return _result(request_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": "0.1.35"},
        })

    if method == "ping":
        return _result(request_id, {})

    if method == "tools/list":
        listed = [{k: v for k, v in tool.items() if not k.startswith("_")}
                  for tool in active_tools().values()]
        return _result(request_id, {"tools": listed})

    if method == "tools/call":
        name = str(params.get("name") or "")
        tool = active_tools().get(name)
        if tool is None:
            # 分两种情况说清楚，否则"工具不存在"会被当成拼错了名字反复重试。
            hidden = any(t["name"] == name for t in ALL_TOOLS)
            if hidden:
                return _result(request_id, _text(
                    "工具 {} 会改动数据，当前没有启用。要用它，请在这个 MCP 服务器的"
                    "配置里设 TESSERA_MCP_ALLOW_WRITE=1。".format(name), is_error=True))
            return _result(request_id, _text("没有这个工具：{}".format(name), is_error=True))
        try:
            return _result(request_id, _text(tool["_handler"](params.get("arguments") or {})))
        except Unavailable as exc:
            # 预期内的拒绝：讲清楚原因，让模型能把话转达给用户，而不是当成崩溃重试。
            return _result(request_id, _text(str(exc), is_error=True))
        except VaultError as exc:
            return _result(request_id, _text("金库拒绝了这次操作：{}".format(exc.code), is_error=True))
        except Exception as exc:
            log(traceback.format_exc())
            return _result(request_id, _text("{}: {}".format(type(exc).__name__, exc), is_error=True))

    return _error(request_id, -32601, "method not found: {}".format(method))


def main() -> int:
    # stdout 是协议通道，一个字节的杂音都会让客户端解析失败。
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    log("已启动。写操作：{}；密码来源：{}".format(
        "已启用" if allow_write() else "未启用",
        "已配置" if os.environ.get("TESSERA_MCP_PASSWORD_FILE") else "未配置"))
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            response = handle(request)
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
    finally:
        BACKEND.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
