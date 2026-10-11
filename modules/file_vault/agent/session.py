# -*- coding: utf-8 -*-
"""跟 backend_server.py 通话的最小客户端。

协议就是 NDJSON over stdio：一行一条 `{"id": N, "method": ..., "params": {...}}`
过去，一行一条响应回来。三件事容易写错，这里都处理了：

1. **stderr 必须一直有人读。** 管道缓冲区只有几十 KB，后端写满之后就卡在
   write 上，于是再也不往 stdout 写响应 —— 两个进程各自阻塞在对方身上，
   CPU 都是 0%，看起来像"卡住了"。后台线程持续抽干。
2. **主动推送的事件没有 id。** 剪贴板监听线程会往同一个 stdout 写
   `{"event": "clipboard_new_entry", ...}`。不滤掉的话，只要跑的时候系统剪贴板
   恰好变了一次，下一个 `msg["id"]` 就 KeyError，报错跟真正的原因毫无关系。
3. **耗时操作会先发若干条 progress 再发结果。** 收到带 progress 的消息要接着等，
   不能当成最终响应。

这三条都不是推测，是 tests/test_backend_server.py 里那个客户端用血换来的注释，
这里照搬。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_SCRIPT = PROJECT_ROOT / "modules" / "file_vault" / "backend_server.py"


class VaultError(RuntimeError):
    """后端回了一个错误码。`code` 是 `auth.not_unlocked` 这样的字符串。"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class VaultSession:
    """一次性的后端会话。用 `with` 起，退出时自动收尾。"""

    def __init__(self, data_dir: Optional[Path] = None, timeout: float = 600.0):
        argv = [sys.executable, "-X", "utf8", str(BACKEND_SCRIPT)]
        if data_dir is not None:
            argv += ["--data-dir", str(data_dir)]
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=str(PROJECT_ROOT),
            env=dict(os.environ),
        )
        self._next_id = 0
        self._timeout = timeout
        self._stderr: list = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    # --- 生命周期 ---------------------------------------------------------

    def __enter__(self) -> "VaultSession":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            # 收尾是清理不是断言：等不到就杀掉。后端退出前要收 SQLCipher 连接，
            # 机器忙的时候能拖很久，卡在这儿只会让命令行看起来是死的。
            self.proc.kill()
            self.proc.wait(timeout=10)

    def _drain_stderr(self) -> None:
        try:
            if self.proc.stderr is not None:
                for line in self.proc.stderr:
                    self._stderr.append(line)
        except (ValueError, OSError):
            pass  # 管道在关闭过程中被合上，正常收尾

    def stderr_text(self) -> str:
        return "".join(self._stderr)

    # --- 往返 -------------------------------------------------------------

    def call(self, method: str, params: Optional[dict] = None,
             on_progress: Optional[Callable[[dict], None]] = None) -> Any:
        """发一个请求，等到最终结果。后端回错误码时抛 VaultError。"""
        self._next_id += 1
        req_id = self._next_id
        payload = json.dumps({"id": req_id, "method": method, "params": params or {}},
                             ensure_ascii=False)
        self.proc.stdin.write(payload + "\n")
        self.proc.stdin.flush()
        while True:
            msg = self._read_one()
            if msg.get("id") != req_id:
                continue  # 别的在途请求的响应，这个客户端一次只发一个，正常不该出现
            if "progress" in msg:
                if on_progress:
                    on_progress(msg["progress"])
                continue
            if "error" in msg:
                raise VaultError(msg["error"].get("message", "unknown"))
            return msg.get("result")

    def _read_one(self) -> dict:
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(
                "后端进程提前退出了。它的 stderr：\n" + (self.stderr_text() or "（空）")
            )
        msg = json.loads(line)
        if "id" not in msg:
            return self._read_one()  # 主动推送的事件（剪贴板新条目等），跳过
        return msg

    # --- 便利封装 ---------------------------------------------------------

    def identity_exists(self) -> bool:
        return bool(self.call("identity_exists").get("exists"))

    def unlock(self, password: str) -> None:
        """用主密码解锁。失败抛 VaultError，错误码原样透出。"""
        result = self.call("unlock_password", {"password": password})
        if not result.get("ok"):
            raise VaultError(result.get("error", "auth.unlock_failed"))
