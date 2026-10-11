# File Vault 批量传输引擎 M1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 File Vault 后端支持"提交即返回、后台线程执行"的批量任务模型，并把加密文件（`.ivault`）的批量加密/解密流程接入统一的预检/冲突/执行引擎，使批量任务运行期间应用其它页面不再被阻塞。

**Architecture:** 新增 `modules/file_vault/batch_engine.py` 提供三个可复用的通用原语（异步任务提交哨兵、流式 SHA-256、批内输出路径去重改名算法）；`backend_server.py` 的 `dispatch()`/`serve()` 学会识别"已异步提交"的哨兵值，不再对这类请求立即写回结果；新增 `files_batch_preflight`/`files_batch_execute` 两个 RPC，均通过线程执行；前端新增共享的 `BatchConflictDialog` 组件消费预检结果，`FilesPane.tsx` 的批量加密/解密改为调用这两个新 RPC。

**Tech Stack:** Python 3.9+ stdlib（`threading`、`hashlib`）、现有 `container.py` 加解密原语；React + TypeScript + shadcn/radix UI 组件；现有 NDJSON stdin/stdout RPC 协议。

**Spec 依据：** [docs/superpowers/specs/2026-07-20-batch-transfer-engine-design.md](../specs/2026-07-20-batch-transfer-engine-design.md) 第 3、4、5（前两行）、7 节。

---

## 实施前必读的设计澄清（本计划对 spec 的具体化，非偏离）

1. **RPC 线路字段命名统一为 snake_case**：spec §4.1 用 TS 风格示例展示了 `BatchPlanItem`/`BatchPreflightResult` 等类型，字段名是 camelCase（如 `duplicateOutputsInBatch`）。但本仓库现有全部 RPC 线路字段（`original_filename`、`sha256_plaintext`、`file_index`、`added_count`、`error_params` 等）都是 snake_case，`ipcTypes.ts` 里对应的 TS interface 字段名也原样跟随 snake_case（例如 `ContainerHeader.sha256_plaintext`、`NoteImportProgress.file_index`）。本计划延续这个约定：线路上和 TS 类型里都用 snake_case（`duplicate_outputs_in_batch`、`conflict_reason` 等），这是对 spec 示例的具体化，不改变其语义。
2. **`files_batch_preflight` 与 `files_batch_execute` 都通过线程执行**：spec §3 的结论是"批量传输类 RPC"整体放入工作线程，预检阶段的流式哈希本身也可能耗时（大文件），所以两者都用下面 Task 1 建的 `submit_batch_task` 提交，而不是只有执行阶段用。
3. **`duplicate_in_batch` 的自动改名候选与磁盘冲突分开表示**：`BatchPlanItem` 增加一个后端计算好的 `suggested_rename_path` 字段，只在 `status == 'conflict'` 且 `conflict_reason == 'name_exists_diff_content'` 时才会有值——前端选择"改名"时直接使用这个值，不需要在前端重新实现改名算法。批内重复（`duplicate_in_batch`）在预检阶段已经把 `output_path` 改成了不冲突的最终路径，前端直接按 `status == 'new'` 一样对待即可（只是分组展示上单独标一下）。

---

## Task 1: `batch_engine.py` — 异步任务提交原语

**Files:**
- Create: `modules/file_vault/batch_engine.py`
- Test: `modules/file_vault/tests/test_batch_engine.py`

设计要点：`submit_batch_task` 立刻 spawn 一个 daemon 线程并返回哨兵值 `ASYNC_DEFERRED`，调用方（RPC handler）把这个哨兵值当作自己的返回值交给 `dispatch()`；`dispatch()`/`serve()`（Task 4）学会识别这个哨兵、不再对它做立即写回。这与仓库里已有的 `fileops/service.py` 的 `_run_with_progress`（spawn 线程后用 `while thread.is_alive(): sleep()` 轮询、handler 依然阻塞到线程结束才返回）**完全不同**——这里 handler 必须立刻返回，不能等线程结束，否则 `serve()` 的 stdin 读取循环还是会被卡住。

- [ ] **Step 1: 写失败测试**

```python
# modules/file_vault/tests/test_batch_engine.py
import time

from modules.file_vault import batch_engine


def test_submit_batch_task_returns_immediately_and_delivers_result_via_write():
    written = []

    def fn():
        time.sleep(0.05)
        return {"ok": True, "value": 42}

    start = time.monotonic()
    result = batch_engine.submit_batch_task(request_id=7, fn=fn, write=written.append)
    elapsed = time.monotonic() - start

    assert result is batch_engine.ASYNC_DEFERRED
    assert elapsed < 0.05, "submit_batch_task must return before fn() finishes"

    deadline = time.monotonic() + 1.0
    while not written and time.monotonic() < deadline:
        time.sleep(0.005)

    assert written == [{"id": 7, "result": {"ok": True, "value": 42}}]


def test_submit_batch_task_converts_vault_error_to_transport_error():
    from modules.file_vault import errors

    written = []

    def fn():
        raise errors.VaultError("files.some_error")

    batch_engine.submit_batch_task(request_id=9, fn=fn, write=written.append)

    deadline = time.monotonic() + 1.0
    while not written and time.monotonic() < deadline:
        time.sleep(0.005)

    assert written == [{"id": 9, "error": {"message": "files.some_error"}}]


def test_submit_batch_task_converts_unexpected_exception_to_internal_unexpected():
    written = []

    def fn():
        raise RuntimeError("boom")

    batch_engine.submit_batch_task(request_id=11, fn=fn, write=written.append)

    deadline = time.monotonic() + 1.0
    while not written and time.monotonic() < deadline:
        time.sleep(0.005)

    assert written == [{"id": 11, "error": {"message": "internal.unexpected"}}]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_batch_engine.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'modules.file_vault.batch_engine'`，因为文件还不存在）

- [ ] **Step 3: 实现 `batch_engine.py`**

```python
# modules/file_vault/batch_engine.py
"""批量传输任务的通用后台执行原语，供 backend_server.py 的批量 RPC 复用。"""
from __future__ import annotations

import threading
from typing import Callable

from modules.file_vault import errors

# dispatch()/serve() 看到这个哨兵值时，不会立即把它当结果写回——
# 真正的结果由 submit_batch_task 内部起的线程稍后自己调用 write() 交付。
ASYNC_DEFERRED = object()


def submit_batch_task(
    request_id,
    fn: Callable[[], dict],
    write: Callable[[dict], None],
) -> object:
    """立刻返回 ASYNC_DEFERRED；fn() 在独立的 daemon 线程里执行，
    结果或错误通过 write() 以现有 NDJSON 协议的最终消息形状交付。
    """

    def run() -> None:
        try:
            result = fn()
        except errors.VaultError as exc:
            write({"id": request_id, "error": {"message": exc.code}})
            return
        except Exception:
            write({"id": request_id, "error": {"message": "internal.unexpected"}})
            return
        write({"id": request_id, "result": result})

    threading.Thread(target=run, daemon=True).start()
    return ASYNC_DEFERRED
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_batch_engine.py -v`
Expected: PASS（3 项）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/batch_engine.py modules/file_vault/tests/test_batch_engine.py
git commit -m "feat(file_vault): add async batch task submission primitive"
```

---

## Task 2: `batch_engine.py` — 流式 SHA-256 助手

**Files:**
- Modify: `modules/file_vault/batch_engine.py`
- Test: `modules/file_vault/tests/test_batch_engine.py`

`modules/file_vault` 目前没有任何计算普通明文文件 SHA-256 的现成函数（`container.py` 只在加密/解密的同一遍读取里顺带算，不能单独复用）。这里补一个独立的流式版本，供预检阶段对目标已存在的明文文件（解密场景）或源明文文件（加密场景）计算哈希用。

- [ ] **Step 1: 写失败测试**

```python
def test_sha256_of_file_matches_hashlib(tmp_path):
    import hashlib

    p = tmp_path / "sample.bin"
    p.write_bytes(b"a" * 1000 + b"b" * 1000)

    expected = hashlib.sha256(p.read_bytes()).hexdigest()
    assert batch_engine.sha256_of_file(p) == expected


def test_sha256_of_file_streams_in_chunks_not_all_at_once(tmp_path, monkeypatch):
    p = tmp_path / "sample.bin"
    p.write_bytes(b"x" * 10)

    read_sizes = []
    real_open = open

    def spy_open(*args, **kwargs):
        f = real_open(*args, **kwargs)
        orig_read = f.read

        def read(size=-1):
            read_sizes.append(size)
            return orig_read(size)

        f.read = read
        return f

    monkeypatch.setattr("builtins.open", spy_open)
    batch_engine.sha256_of_file(p, chunk_size=4)
    assert all(s == 4 for s in read_sizes[:-1]), "must call read(chunk_size) repeatedly, not read() with no size"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_batch_engine.py -v -k sha256`
Expected: FAIL（`AttributeError: module 'batch_engine' has no attribute 'sha256_of_file'`）

- [ ] **Step 3: 实现**

在 `batch_engine.py` 顶部加 `import hashlib`，并追加：

```python
def sha256_of_file(path, chunk_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_batch_engine.py -v`
Expected: PASS（5 项）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/batch_engine.py modules/file_vault/tests/test_batch_engine.py
git commit -m "feat(file_vault): add streaming sha256_of_file helper"
```

---

## Task 3: `batch_engine.py` — 批内输出路径去重改名算法

**Files:**
- Modify: `modules/file_vault/batch_engine.py`
- Test: `modules/file_vault/tests/test_batch_engine.py`

这是对 `rpc_note_export_files`（`backend_server.py`）里已有的 `used_names` + `" (2)"` 后缀算法的抽取通用化，供 M1 的加密文件批量场景和未来 M2/M3 复用。与笔记导出版本的关键区别：笔记导出按"文件名"去重（因为都落在同一个目录），这里按**完整路径**去重（更通用，不假设所有条目都在同一目录），后缀只加在文件名的 stem 部分。

- [ ] **Step 1: 写失败测试**

```python
from pathlib import Path


def test_resolve_batch_output_paths_no_collision_returns_unchanged():
    candidates = [("a", Path("/out/x.ivault")), ("b", Path("/out/y.ivault"))]
    resolved = batch_engine.resolve_batch_output_paths(candidates)
    assert resolved["a"] == (Path("/out/x.ivault"), False)
    assert resolved["b"] == (Path("/out/y.ivault"), False)


def test_resolve_batch_output_paths_renames_second_collision():
    candidates = [("a", Path("/out/x.ivault")), ("b", Path("/out/x.ivault"))]
    resolved = batch_engine.resolve_batch_output_paths(candidates)
    assert resolved["a"] == (Path("/out/x.ivault"), False)
    assert resolved["b"] == (Path("/out/x (2).ivault"), True)


def test_resolve_batch_output_paths_renames_three_way_collision_sequentially():
    candidates = [
        ("a", Path("/out/x.ivault")),
        ("b", Path("/out/x.ivault")),
        ("c", Path("/out/x.ivault")),
    ]
    resolved = batch_engine.resolve_batch_output_paths(candidates)
    assert resolved["a"] == (Path("/out/x.ivault"), False)
    assert resolved["b"] == (Path("/out/x (2).ivault"), True)
    assert resolved["c"] == (Path("/out/x (3).ivault"), True)


def test_resolve_batch_output_paths_different_dirs_same_name_do_not_collide():
    candidates = [("a", Path("/out1/x.ivault")), ("b", Path("/out2/x.ivault"))]
    resolved = batch_engine.resolve_batch_output_paths(candidates)
    assert resolved["a"] == (Path("/out1/x.ivault"), False)
    assert resolved["b"] == (Path("/out2/x.ivault"), False)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_batch_engine.py -v -k resolve_batch_output_paths`
Expected: FAIL（`AttributeError`）

- [ ] **Step 3: 实现**

```python
from pathlib import Path
from typing import Dict, List, Tuple


def resolve_batch_output_paths(
    candidates: List[Tuple[str, Path]],
) -> Dict[str, Tuple[Path, bool]]:
    """按顺序为每个 (key, 期望输出路径) 解决批次内部的路径冲突。

    返回 {key: (最终路径, 是否因批内冲突被改名)}。冲突判定按完整路径比较，
    不同目录下的同名文件不算冲突。改名只作用于文件名的 stem 部分，
    追加 " (2)"、" (3)" ... 直到不再与已分配的路径冲突。
    """
    used_paths: set = set()
    resolved: Dict[str, Tuple[Path, bool]] = {}
    for key, path in candidates:
        candidate = path
        suffix = 2
        renamed = False
        while str(candidate) in used_paths:
            candidate = path.with_name(f"{path.stem} ({suffix}){path.suffix}")
            suffix += 1
            renamed = True
        used_paths.add(str(candidate))
        resolved[key] = (candidate, renamed)
    return resolved
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_batch_engine.py -v`
Expected: PASS（9 项）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/batch_engine.py modules/file_vault/tests/test_batch_engine.py
git commit -m "feat(file_vault): add batch output path dedup/rename algorithm"
```

---

## Task 4: 扩展测试用的 `BackendClient`，支持并发式收发

**Files:**
- Modify: `modules/file_vault/tests/test_backend_server.py`

现有 `BackendClient.call()` 是"发一条、堵住读到那条的最终结果才返回"的严格串行模式，无法用来断言"批量任务运行期间另一个 RPC 没被卡住"。这里补两个低层方法：`send()` 只发送不等待，`read_one()` 读一行原始消息（可能是某个请求的 progress 或 result/error）。保留原有 `call()` 不变（内部改写成基于这两个新方法的组合，避免重复实现）。

- [ ] **Step 1: 写失败测试（先验证新方法存在即可，行为在 Task 6 的并发测试里验证）**

```python
def test_backend_client_send_and_read_one_low_level_roundtrip(client):
    req_id = client.send("identity_exists", {})
    msg = client.read_one()
    assert msg["id"] == req_id
    assert "result" in msg
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k send_and_read_one`
Expected: FAIL（`AttributeError: 'BackendClient' object has no attribute 'send'`）

- [ ] **Step 3: 实现**

在 `test_backend_server.py` 的 `BackendClient` 类里，把现有的 `call()` 方法体替换成基于 `send`/`read_one` 的实现，并新增这两个方法（保持类里其它方法如 `close()` 不变）：

```python
class BackendClient:
    # ... __init__ 不变 ...

    def send(self, method: str, params: dict) -> int:
        """只发送请求，返回分配的 request id，不等待响应。"""
        self._next_id += 1
        req_id = self._next_id
        self.proc.stdin.write(json.dumps({"id": req_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        return req_id

    def read_one(self) -> dict:
        """读取一行原始 NDJSON 消息（可能属于任意一个在途请求）。"""
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"backend_server.py closed stdout unexpectedly (stderr: {self.proc.stderr.read()})")
        return json.loads(line)

    def call(self, method: str, params: dict):
        """发送一条请求，阻塞读到属于这条请求的最终结果（原有语义不变）。"""
        req_id = self.send(method, params)
        progress_events = []
        while True:
            msg = self.read_one()
            assert msg["id"] == req_id
            if "progress" in msg:
                progress_events.append(msg["progress"])
                continue
            if "error" in msg:
                return None, progress_events, msg["error"]["message"]
            return msg["result"], progress_events, None
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k send_and_read_one`
Expected: PASS

再跑一次已有的完整测试文件，确认 `call()` 的重构没有破坏任何既有测试：

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: 全部 PASS（包括改动前就存在的测试）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/tests/test_backend_server.py
git commit -m "test(file_vault): add low-level send/read_one to BackendClient for concurrency tests"
```

---

## Task 5: `dispatch()`/`serve()` 识别 `ASYNC_DEFERRED` 哨兵

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`

这一步只改协议骨架，不引入任何真正使用它的 RPC（那是 Task 7/9），所以先用一个测试专用的假 RPC 方法验证机制本身工作正常，避免把"协议骨架对不对"和"具体批量业务逻辑对不对"混在一次测试里调试。

- [ ] **Step 1: 写失败测试**

在 `test_backend_server.py` 顶部找到现有的 import 区块，确认已 `import time`（多数此类测试文件已有；若没有则补上）。新增：

```python
def test_async_deferred_rpc_returns_result_later_without_blocking_dispatch_return(client):
    # 复用已解锁状态所需的最小 setup（如现有其它测试的通用 setup helper）；
    # 若本文件已有 unlock 的公共 fixture/helper，直接调用它，不要重复手写。
    req_id = client.send("__test_async_echo", {"value": 123})
    msg = client.read_one()
    assert msg["id"] == req_id
    assert msg["result"] == {"ok": True, "value": 123}
```

这个测试依赖 `backend_server.py` 里临时注册一个仅测试用的 `__test_async_echo` 方法（下一步实现，稳定后不会保留在生产代码路径里被其它地方调用，但作为一个真实注册的 `_METHODS_WITH_PROGRESS` 条目留存是可以接受的最小验证手段，成本远低于为了测试骨架去 mock 私有函数）。

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k async_deferred`
Expected: FAIL（`Unknown method: __test_async_echo`，即 `msg["error"]["message"] == "Unknown method: __test_async_echo"`，断言 `msg["result"]` 时 KeyError）

- [ ] **Step 3: 实现**

在 `backend_server.py` 顶部 import 区加入：

```python
from . import batch_engine
```

在 `dispatch()` 函数（现有代码，只改 `try` 块内那几行）里，把：

```python
        if method in _METHODS_WITH_PROGRESS:
            result = _METHODS_WITH_PROGRESS[method](params, request_id)
        elif method in _METHODS:
            result = _METHODS[method](params)
        else:
            return {"id": request_id, "error": {"message": f"Unknown method: {method}"}}
        return {"id": request_id, "result": result}
```

改成：

```python
        if method in _METHODS_WITH_PROGRESS:
            result = _METHODS_WITH_PROGRESS[method](params, request_id)
        elif method in _METHODS:
            result = _METHODS[method](params)
        else:
            return {"id": request_id, "error": {"message": f"Unknown method: {method}"}}
        if result is batch_engine.ASYNC_DEFERRED:
            return batch_engine.ASYNC_DEFERRED
        return {"id": request_id, "result": result}
```

在 `serve()` 函数里，把：

```python
        _write(dispatch(request))
```

改成：

```python
        response = dispatch(request)
        if response is not batch_engine.ASYNC_DEFERRED:
            _write(response)
```

新增测试专用 RPC handler（放在 `_METHODS_WITH_PROGRESS` 字典定义之前的任意合适位置，紧挨着其它 `rpc_*` 函数）：

```python
def rpc___test_async_echo(params, request_id):
    def fn():
        return {"ok": True, "value": params["value"]}

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

在 `_METHODS_WITH_PROGRESS` 字典字面量里加一行：

```python
    "__test_async_echo": rpc___test_async_echo,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k async_deferred`
Expected: PASS

再跑一次全量测试确认没有破坏其它 RPC 的同步返回路径（`ASYNC_DEFERRED` 分支只在极少数新 handler 返回该哨兵时触发，其它所有现有 handler 返回普通 dict，行为应完全不变）：

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "feat(file_vault): dispatch/serve recognize ASYNC_DEFERRED for thread-backed RPCs"
```

---

## Task 6: 并发回归测试——批量任务运行期间其它 RPC 不被卡住

**Files:**
- Modify: `modules/file_vault/tests/test_backend_server.py`

这是 spec §9.1 明确要求的测试：验证 M1 真正解决了"批量任务阻塞整个后端"的问题，而不只是协议骨架能跑。用 Task 5 的 `__test_async_echo` handler 改造成一个可控制耗时的版本太绕，这里直接验证"发起一个已知会耗时的异步 RPC，再发一个正常同步 RPC，同步 RPC 的响应必须先于异步 RPC 的最终结果被读到"。

- [ ] **Step 1: 写失败测试**

先扩展 `__test_async_echo` 使其可控制耗时（修改 Task 5 写的 handler，不新增方法）：

```python
def rpc___test_async_echo(params, request_id):
    delay = params.get("delay_s", 0)

    def fn():
        if delay:
            time.sleep(delay)
        return {"ok": True, "value": params["value"]}

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

（确认 `test_backend_server.py` / `backend_server.py` 顶部已 `import time`；`backend_server.py` 按 Task 1 报告已导入。）

新增测试：

```python
def test_async_rpc_does_not_block_unrelated_synchronous_rpc(client):
    slow_id = client.send("__test_async_echo", {"value": "slow", "delay_s": 0.3})
    fast_id = client.send("identity_exists", {})

    first_msg = client.read_one()
    assert first_msg["id"] == fast_id, (
        "identity_exists must respond before the slow async task finishes, "
        "proving the stdin dispatch loop was not blocked by it"
    )

    second_msg = client.read_one()
    assert second_msg["id"] == slow_id
    assert second_msg["result"] == {"ok": True, "value": "slow"}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k does_not_block`
Expected: 在 Task 5 完成后，这一步实际应当已经 PASS（因为线程模型已经就位）——如果确实是 PASS，跳过 Step 3，直接进 Step 4 确认；如果 FAIL，说明 Task 5 的接线有问题，回去检查 `serve()`/`dispatch()` 的改动。

- [ ] **Step 3: （如 Step 2 失败才需要）排查修复**

最常见的错漏：`serve()` 里忘记把 `_write(dispatch(request))` 换成检查哨兵的版本、或者 handler 里漏了 `return batch_engine.submit_batch_task(...)` 直接同步执行了 `fn()`。对照 Task 5 Step 3 的代码逐行核对。

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k does_not_block`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "test(file_vault): verify async batch RPCs no longer block the dispatch loop"
```

---

## Task 7: `rpc_files_batch_preflight` — 加密方向

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`

预检输入：`method`（`encrypt_file`/`decrypt_file`）+ `items: [{key, input_path, output_path}]`（`output_path` 是前端按现有逻辑构造的"期望"输出路径，即 Task 前 FilesPane 已有的 `joinPath(outDir, basename(p) + '.ivault')` 之类的候选路径，不是最终路径）。

处理顺序（对应 spec §4.1 澄清）：

1. 用 `batch_engine.resolve_batch_output_paths` 解决批内路径冲突，得到每项的"批内已去重"输出路径 + 是否被批内改名。
2. 对每项按批内去重后的路径检查磁盘：
   - 目标不存在 → 若批内被改名过，`status='conflict', conflict_reason='duplicate_in_batch'`；否则 `status='new'`。
   - 目标存在 → 按 encrypt 方向的内容比较规则（源文件流式哈希 vs 目标容器 `sha256_plaintext`）：相同 → `status='unchanged'`；不同或目标不是合法容器 → `status='conflict', conflict_reason='name_exists_diff_content'`，并算出 `suggested_rename_path`（复用 `resolve_batch_output_paths`，把这一项的候选路径当作与"已存在的目标"强制冲突来求下一个可用名）。
   - 源文件读取失败（不存在/无权限）→ `status='error'`。

- [ ] **Step 1: 写失败测试**

```python
def test_files_batch_preflight_encrypt_classifies_new_unchanged_conflict(client, tmp_path):
    client.call("setup_complete", {
        "password": "test-password-" + "123", "email": "", "recovery_key_ack": True,
    })  # 若与现有测试的 setup 参数不一致，对照本文件其它测试里实际使用的 setup_complete 调用签名调整
    client.call("unlock_password", {"password": "test-password-" + "123"})

    src_a = tmp_path / "a.txt"
    src_a.write_text("hello a", encoding="utf-8")
    src_b = tmp_path / "b.txt"
    src_b.write_text("hello b", encoding="utf-8")
    src_c = tmp_path / "c.txt"
    src_c.write_text("hello c", encoding="utf-8")

    out_dir = tmp_path / "out"
    out_dir.mkdir()

    # 预先放一个已经是 a.txt 加密结果的容器，内容与 src_a 一致 -> 应判 unchanged
    result, _, error = client.call("encrypt_file", {
        "input_path": str(src_a), "output_path": str(out_dir / "a.txt.ivault"),
    })
    assert error is None and result["ok"] is True

    # 预先放一个文件名为 b.txt.ivault 但内容对不上 src_b 的容器 -> 应判 conflict/name_exists_diff_content
    other = tmp_path / "other.txt"
    other.write_text("not b", encoding="utf-8")
    result, _, error = client.call("encrypt_file", {
        "input_path": str(other), "output_path": str(out_dir / "b.txt.ivault"),
    })
    assert error is None and result["ok"] is True

    items = [
        {"key": "a", "input_path": str(src_a), "output_path": str(out_dir / "a.txt.ivault")},
        {"key": "b", "input_path": str(src_b), "output_path": str(out_dir / "b.txt.ivault")},
        {"key": "c", "input_path": str(src_c), "output_path": str(out_dir / "c.txt.ivault")},
    ]
    result, progress, error = client.call("files_batch_preflight", {"method": "encrypt_file", "items": items})
    assert error is None
    assert result["ok"] is True

    by_key = {item["key"]: item for item in result["items"]}
    assert by_key["a"]["status"] == "unchanged"
    assert by_key["b"]["status"] == "conflict"
    assert by_key["b"]["conflict_reason"] == "name_exists_diff_content"
    assert by_key["b"]["suggested_rename_path"] == str(out_dir / "b.txt (2).ivault")
    assert by_key["c"]["status"] == "new"
    assert result["duplicate_outputs_in_batch"] == []


def test_files_batch_preflight_encrypt_detects_batch_internal_duplicate(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    src_a = tmp_path / "dir1" / "x.txt"
    src_a.parent.mkdir()
    src_a.write_text("content a", encoding="utf-8")
    src_b = tmp_path / "dir2" / "x.txt"
    src_b.parent.mkdir()
    src_b.write_text("content b", encoding="utf-8")

    out_dir = tmp_path / "out"
    out_dir.mkdir()

    items = [
        {"key": "a", "input_path": str(src_a), "output_path": str(out_dir / "x.txt.ivault")},
        {"key": "b", "input_path": str(src_b), "output_path": str(out_dir / "x.txt.ivault")},
    ]
    result, _, error = client.call("files_batch_preflight", {"method": "encrypt_file", "items": items})
    assert error is None and result["ok"] is True

    by_key = {item["key"]: item for item in result["items"]}
    assert by_key["a"]["status"] == "new"
    assert by_key["a"]["output_path"] == str(out_dir / "x.txt.ivault")
    assert by_key["b"]["status"] == "conflict"
    assert by_key["b"]["conflict_reason"] == "duplicate_in_batch"
    assert by_key["b"]["output_path"] == str(out_dir / "x.txt (2).ivault")
    assert result["duplicate_outputs_in_batch"] == ["b"]


def test_files_batch_preflight_encrypt_marks_unreadable_source_as_error(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    missing = tmp_path / "does-not-exist.txt"
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    items = [{"key": "a", "input_path": str(missing), "output_path": str(out_dir / "does-not-exist.txt.ivault")}]
    result, _, error = client.call("files_batch_preflight", {"method": "encrypt_file", "items": items})
    assert error is None and result["ok"] is True
    assert result["items"][0]["status"] == "error"
    assert result["items"][0]["error_code"]
```

（注：以上三个测试里对 `setup_complete` 的调用参数是按常见字段名猜测的占位——实现前先打开 `test_backend_server.py` 顶部已有的任意一个使用 `setup_complete`/`unlock_password` 的测试，复制其真实参数形状，不要照抄本计划里的占位签名。这是唯一需要在动手前对照真实文件核实的地方。）

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k files_batch_preflight`
Expected: FAIL（`Unknown method: files_batch_preflight`）

- [ ] **Step 3: 实现**

在 `backend_server.py` 里新增（放在 `rpc_encrypt_file`/`rpc_decrypt_file` 附近）：

```python
def _classify_encrypt_preflight_item(item, imk):
    key = item["key"]
    input_path = Path(item["input_path"])
    candidate_output = Path(item["output_path"])
    source_label = input_path.name

    if not input_path.is_file():
        return {
            "key": key, "source_label": source_label,
            "input_path": str(input_path), "output_path": str(candidate_output),
            "suggested_rename_path": None, "status": "error",
            "conflict_reason": None, "error_code": "files.source_not_found",
        }

    if not candidate_output.exists():
        return {
            "key": key, "source_label": source_label,
            "input_path": str(input_path), "output_path": str(candidate_output),
            "suggested_rename_path": None, "status": "new",
            "conflict_reason": None, "error_code": None,
        }

    try:
        header = container.read_header(candidate_output, imk)
        target_hash = header.get("sha256_plaintext")
    except (container.InvalidContainerError, container.ContainerIntegrityError):
        target_hash = None

    if target_hash is not None:
        try:
            source_hash = batch_engine.sha256_of_file(input_path)
        except OSError:
            return {
                "key": key, "source_label": source_label,
                "input_path": str(input_path), "output_path": str(candidate_output),
                "suggested_rename_path": None, "status": "error",
                "conflict_reason": None, "error_code": "files.source_not_found",
            }
        if source_hash == target_hash:
            return {
                "key": key, "source_label": source_label,
                "input_path": str(input_path), "output_path": str(candidate_output),
                "suggested_rename_path": None, "status": "unchanged",
                "conflict_reason": None, "error_code": None,
            }

    # 强制与已存在目标冲突求下一个可用名：用一个占位 key 把"已存在的目标"当成已占用
    suggested = batch_engine.resolve_batch_output_paths(
        [("__existing__", candidate_output), (key, candidate_output)]
    )[key][0]
    return {
        "key": key, "source_label": source_label,
        "input_path": str(input_path), "output_path": str(candidate_output),
        "suggested_rename_path": str(suggested), "status": "conflict",
        "conflict_reason": "name_exists_diff_content", "error_code": None,
    }


def rpc_files_batch_preflight(params, request_id):
    imk = _require_imk()
    method = params["method"]
    raw_items = params["items"]

    def fn():
        candidates = [(item["key"], Path(item["output_path"])) for item in raw_items]
        resolved = batch_engine.resolve_batch_output_paths(candidates)

        plan_items = []
        for item in raw_items:
            key = item["key"]
            final_output, renamed_in_batch = resolved[key]
            patched_item = dict(item, output_path=str(final_output))
            if method == "encrypt_file":
                classified = _classify_encrypt_preflight_item(patched_item, imk)
            else:
                classified = _classify_decrypt_preflight_item(patched_item, imk)

            if renamed_in_batch and classified["status"] == "new":
                classified["status"] = "conflict"
                classified["conflict_reason"] = "duplicate_in_batch"
            plan_items.append(classified)

        duplicate_keys = [
            it["key"] for it in plan_items if it["conflict_reason"] == "duplicate_in_batch"
        ]
        return {"ok": True, "items": plan_items, "duplicate_outputs_in_batch": duplicate_keys}

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

在 `_METHODS_WITH_PROGRESS` 字典里加一行：

```python
    "files_batch_preflight": rpc_files_batch_preflight,
```

注意：这一步 `_classify_decrypt_preflight_item` 还不存在（Task 8 才实现），先给它一个占位定义使当前测试能跑（本任务测试只覆盖 `method == "encrypt_file"` 分支）：

```python
def _classify_decrypt_preflight_item(item, imk):
    raise NotImplementedError("implemented in Task 8")
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k files_batch_preflight`
Expected: PASS（3 项）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "feat(file_vault): add files_batch_preflight for encrypt direction"
```

---

## Task 8: `rpc_files_batch_preflight` — 解密方向

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`

解密方向的源是 `.ivault` 容器（自带 `sha256_plaintext`，读 header 即可，不需要重新流式哈希源），目标是明文文件（若已存在，需要流式哈希比较）。

- [ ] **Step 1: 写失败测试**

```python
def test_files_batch_preflight_decrypt_classifies_new_unchanged_conflict(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    src_a = tmp_path / "a.txt"
    src_a.write_text("hello a", encoding="utf-8")
    container_a = tmp_path / "a.txt.ivault"
    result, _, error = client.call("encrypt_file", {"input_path": str(src_a), "output_path": str(container_a)})
    assert error is None and result["ok"] is True

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "a.txt").write_text("hello a", encoding="utf-8")  # 与 container_a 明文一致 -> unchanged
    (out_dir / "b.txt").write_text("different content", encoding="utf-8")  # 稍后与其冲突

    src_b = tmp_path / "b.txt"
    src_b.write_text("hello b", encoding="utf-8")
    container_b = tmp_path / "b.txt.ivault"
    result, _, error = client.call("encrypt_file", {"input_path": str(src_b), "output_path": str(container_b)})
    assert error is None and result["ok"] is True

    src_c = tmp_path / "c.txt"
    src_c.write_text("hello c", encoding="utf-8")
    container_c = tmp_path / "c.txt.ivault"
    result, _, error = client.call("encrypt_file", {"input_path": str(src_c), "output_path": str(container_c)})
    assert error is None and result["ok"] is True

    items = [
        {"key": "a", "input_path": str(container_a), "output_path": str(out_dir / "a.txt")},
        {"key": "b", "input_path": str(container_b), "output_path": str(out_dir / "b.txt")},
        {"key": "c", "input_path": str(container_c), "output_path": str(out_dir / "c.txt")},
    ]
    result, _, error = client.call("files_batch_preflight", {"method": "decrypt_file", "items": items})
    assert error is None and result["ok"] is True

    by_key = {item["key"]: item for item in result["items"]}
    assert by_key["a"]["status"] == "unchanged"
    assert by_key["b"]["status"] == "conflict"
    assert by_key["b"]["conflict_reason"] == "name_exists_diff_content"
    assert by_key["c"]["status"] == "new"


def test_files_batch_preflight_decrypt_marks_invalid_container_as_error(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    not_a_container = tmp_path / "not-real.ivault"
    not_a_container.write_bytes(b"garbage data, not a real container")
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    items = [{"key": "a", "input_path": str(not_a_container), "output_path": str(out_dir / "not-real")}]
    result, _, error = client.call("files_batch_preflight", {"method": "decrypt_file", "items": items})
    assert error is None and result["ok"] is True
    assert result["items"][0]["status"] == "error"
    assert result["items"][0]["error_code"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k "preflight_decrypt"`
Expected: FAIL（`NotImplementedError`）

- [ ] **Step 3: 实现**

用真正的实现替换 Task 7 里的占位 `_classify_decrypt_preflight_item`：

```python
def _classify_decrypt_preflight_item(item, imk):
    key = item["key"]
    input_path = Path(item["input_path"])
    candidate_output = Path(item["output_path"])
    source_label = input_path.name

    try:
        header = container.read_header(input_path, imk)
    except (container.InvalidContainerError, container.ContainerIntegrityError) as exc:
        return {
            "key": key, "source_label": source_label,
            "input_path": str(input_path), "output_path": str(candidate_output),
            "suggested_rename_path": None, "status": "error",
            "conflict_reason": None, "error_code": exc.code,
        }

    if not candidate_output.exists():
        return {
            "key": key, "source_label": source_label,
            "input_path": str(input_path), "output_path": str(candidate_output),
            "suggested_rename_path": None, "status": "new",
            "conflict_reason": None, "error_code": None,
        }

    source_hash = header.get("sha256_plaintext")
    try:
        target_hash = batch_engine.sha256_of_file(candidate_output)
    except OSError:
        target_hash = None

    if source_hash is not None and source_hash == target_hash:
        return {
            "key": key, "source_label": source_label,
            "input_path": str(input_path), "output_path": str(candidate_output),
            "suggested_rename_path": None, "status": "unchanged",
            "conflict_reason": None, "error_code": None,
        }

    suggested = batch_engine.resolve_batch_output_paths(
        [("__existing__", candidate_output), (key, candidate_output)]
    )[key][0]
    return {
        "key": key, "source_label": source_label,
        "input_path": str(input_path), "output_path": str(candidate_output),
        "suggested_rename_path": str(suggested), "status": "conflict",
        "conflict_reason": "name_exists_diff_content", "error_code": None,
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k preflight`
Expected: 全部 PASS（Task 7 + Task 8 共 5 项）

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "feat(file_vault): add files_batch_preflight for decrypt direction"
```

---

## Task 9: `rpc_files_batch_execute`

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`

输入：`{method, cipher?, delete_source?, items: [{key, input_path, output_path, action: 'run'|'skip'}]}`（`output_path` 是前端根据预检结果 + 用户冲突决策算出的**最终**路径；`action='skip'` 覆盖"未勾选的 unchanged 项"和"用户选择跳过的冲突项"两种情况，两者在汇总里分开计数靠前端自己在调用前分类，后端只需要知道跳过原因分类——见下方 `skip_reason` 字段）。

为了让汇总能区分"跳过-内容相同"和"跳过-用户选择"，`action='skip'` 的 item 需要带一个 `skip_reason: 'unchanged'|'user'`。为了让汇总能区分"改名"和"覆盖"，`action='run'` 的 item 需要带一个 `write_mode: 'new'|'overwrite'|'rename'`（前端在调用前就知道：`status=='new'` 或 `duplicate_in_batch` → `'new'`；用户选覆盖 → `'overwrite'`；用户选改名 → `'rename'`）。

- [ ] **Step 1: 写失败测试**

```python
def test_files_batch_execute_mixed_outcomes(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    src_ok = tmp_path / "ok.txt"
    src_ok.write_text("ok content", encoding="utf-8")
    src_skip = tmp_path / "skip.txt"
    src_skip.write_text("skip content", encoding="utf-8")
    src_overwrite = tmp_path / "overwrite.txt"
    src_overwrite.write_text("new content", encoding="utf-8")
    src_missing = tmp_path / "missing.txt"  # 不创建，制造一个执行期失败

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    existing_target = out_dir / "overwrite.txt.ivault"
    other_src = tmp_path / "stale.txt"
    other_src.write_text("stale content", encoding="utf-8")
    result, _, error = client.call("encrypt_file", {"input_path": str(other_src), "output_path": str(existing_target)})
    assert error is None and result["ok"] is True

    items = [
        {"key": "ok", "input_path": str(src_ok), "output_path": str(out_dir / "ok.txt.ivault"),
         "action": "run", "write_mode": "new"},
        {"key": "skip", "input_path": str(src_skip), "output_path": str(out_dir / "skip.txt.ivault"),
         "action": "skip", "skip_reason": "user"},
        {"key": "overwrite", "input_path": str(src_overwrite), "output_path": str(existing_target),
         "action": "run", "write_mode": "overwrite"},
        {"key": "missing", "input_path": str(src_missing), "output_path": str(out_dir / "missing.txt.ivault"),
         "action": "run", "write_mode": "new"},
    ]
    result, progress, error = client.call("files_batch_execute", {
        "method": "encrypt_file", "items": items, "delete_source": False,
    })
    assert error is None and result["ok"] is True

    summary = result["summary"]
    assert summary["success"] == 2  # ok + overwrite
    assert summary["skipped_by_user"] == 1
    assert summary["skipped_unchanged"] == 0
    assert summary["overwritten"] == 1
    assert summary["renamed"] == 0
    assert len(summary["failed"]) == 1
    assert summary["failed"][0]["key"] == "missing"

    assert (out_dir / "ok.txt.ivault").exists()
    assert not (out_dir / "skip.txt.ivault").exists()

    # overwrite 之后目标内容应对应新源文件，而不是旧的 stale.txt
    decrypted = tmp_path / "check.txt"
    result, _, error = client.call("decrypt_file", {"input_path": str(existing_target), "output_path": str(decrypted)})
    assert error is None and result["ok"] is True
    assert decrypted.read_text(encoding="utf-8") == "new content"

    assert len(progress) >= 1
    assert progress[-1]["done"] == progress[-1]["total"]


def test_files_batch_execute_rename_write_mode_increments_summary(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    src = tmp_path / "renamed.txt"
    src.write_text("renamed content", encoding="utf-8")
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    items = [
        {"key": "a", "input_path": str(src), "output_path": str(out_dir / "renamed.txt (2).ivault"),
         "action": "run", "write_mode": "rename"},
    ]
    result, _, error = client.call("files_batch_execute", {
        "method": "encrypt_file", "items": items, "delete_source": False,
    })
    assert error is None and result["ok"] is True
    assert result["summary"]["renamed"] == 1
    assert result["summary"]["success"] == 1
    assert (out_dir / "renamed.txt (2).ivault").exists()


def test_files_batch_execute_one_failure_does_not_abort_remaining_items(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    src_good = tmp_path / "good.txt"
    src_good.write_text("good", encoding="utf-8")

    items = [
        {"key": "bad", "input_path": str(tmp_path / "nope.txt"),
         "output_path": str(out_dir / "nope.txt.ivault"), "action": "run", "write_mode": "new"},
        {"key": "good", "input_path": str(src_good),
         "output_path": str(out_dir / "good.txt.ivault"), "action": "run", "write_mode": "new"},
    ]
    result, _, error = client.call("files_batch_execute", {
        "method": "encrypt_file", "items": items, "delete_source": False,
    })
    assert error is None and result["ok"] is True
    assert result["summary"]["success"] == 1
    assert len(result["summary"]["failed"]) == 1
    assert (out_dir / "good.txt.ivault").exists()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k files_batch_execute`
Expected: FAIL（`Unknown method: files_batch_execute`）

- [ ] **Step 3: 实现**

```python
def rpc_files_batch_execute(params, request_id):
    imk = _require_imk()
    method = params["method"]
    cipher = params.get("cipher") or crypto.DEFAULT_FILE_CIPHER
    delete_source = params.get("delete_source", False)
    items = params["items"]

    def fn():
        summary = {
            "success": 0, "skipped_unchanged": 0, "skipped_by_user": 0,
            "renamed": 0, "overwritten": 0, "failed": [],
        }
        total = len(items)
        for index, item in enumerate(items):
            key = item["key"]
            on_progress = _throttled_progress(
                request_id,
                extra={"item_index": index, "total_items": total, "item_label": Path(item["input_path"]).name},
            )
            if item["action"] == "skip":
                if item.get("skip_reason") == "unchanged":
                    summary["skipped_unchanged"] += 1
                else:
                    summary["skipped_by_user"] += 1
                on_progress(index + 1, total)
                continue

            input_path = item["input_path"]
            output_path = item["output_path"]
            try:
                if method == "encrypt_file":
                    container.encrypt_file(input_path, output_path, imk, on_progress=on_progress, cipher=cipher)
                else:
                    container.decrypt_file(input_path, output_path, imk, on_progress=on_progress)
            except (container.InvalidContainerError, container.ContainerIntegrityError, container.SamePathError) as exc:
                summary["failed"].append({"key": key, "error": exc.code, "error_params": exc.params})
                on_progress(index + 1, total)
                continue
            except OSError as exc:
                summary["failed"].append({"key": key, "error": "files.io_error", "error_params": {"detail": str(exc)}})
                on_progress(index + 1, total)
                continue

            if delete_source:
                try:
                    container.secure_delete_file(Path(input_path))
                except Exception:
                    pass  # 与现有 rpc_encrypt_file/rpc_decrypt_file 一致：删源失败不影响本项已成功的加解密结果

            summary["success"] += 1
            if item.get("write_mode") == "overwrite":
                summary["overwritten"] += 1
            elif item.get("write_mode") == "rename":
                summary["renamed"] += 1
            on_progress(index + 1, total)

        return {"ok": True, "summary": summary}

    return batch_engine.submit_batch_task(request_id, fn, _write)
```

在 `_METHODS_WITH_PROGRESS` 字典里加一行：

```python
    "files_batch_execute": rpc_files_batch_execute,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k files_batch_execute`
Expected: PASS（3 项）

再跑整个后端测试套件，确认没有破坏任何既有 RPC：

Run: `python -X utf8 -m pytest modules/file_vault -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "feat(file_vault): add files_batch_execute RPC"
```

---

## Task 10: 清理测试专用 RPC

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Modify: `modules/file_vault/tests/test_backend_server.py`

Task 5/6 引入的 `__test_async_echo` 完成了它的使命（验证协议骨架），现在 `files_batch_preflight`/`files_batch_execute` 已经是更真实的验证对象。保留它会让 `_METHODS_WITH_PROGRESS` 混入一个生产代码不需要的方法名，予以移除；对应的两个测试改为直接用 `files_batch_execute`（一个耗时项 + 紧跟一个 `identity_exists`）来验证并发不阻塞，语义等价但覆盖真实 RPC。

- [ ] **Step 1: 修改测试**

把 `test_async_deferred_rpc_returns_result_later_without_blocking_dispatch_return` 和 `test_async_rpc_does_not_block_unrelated_synchronous_rpc` 里对 `__test_async_echo` 的依赖，替换成一个真实的 `files_batch_execute` 调用（1 个会执行的小文件项即可，不需要刻意的 `delay_s`——真实的加密调用本身有可测的非零耗时）：

```python
def test_async_rpc_does_not_block_unrelated_synchronous_rpc(client, tmp_path):
    client.call("setup_complete", {"password": "test-password-" + "123", "email": "", "recovery_key_ack": True})
    client.call("unlock_password", {"password": "test-password-" + "123"})

    src = tmp_path / "a.txt"
    src.write_bytes(b"x" * (8 * 1024 * 1024))  # 大到足够让加密耗时可观察
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    slow_id = client.send("files_batch_execute", {
        "method": "encrypt_file",
        "items": [{"key": "a", "input_path": str(src), "output_path": str(out_dir / "a.txt.ivault"),
                   "action": "run", "write_mode": "new"}],
        "delete_source": False,
    })
    fast_id = client.send("identity_exists", {})

    seen_fast_before_slow_result = False
    while True:
        msg = client.read_one()
        if msg["id"] == fast_id and "result" in msg:
            seen_fast_before_slow_result = True
        if msg["id"] == slow_id and "result" in msg:
            break
    assert seen_fast_before_slow_result
```

删除原来针对 `__test_async_echo` 的两个测试（已被上面替代 / 已被 Task 7-9 的真实 preflight/execute 测试覆盖了"协议骨架能跑通"这一点）。

- [ ] **Step 2: 运行测试确认新测试通过**

Run: `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -v -k does_not_block`
Expected: PASS

- [ ] **Step 3: 从 `backend_server.py` 删除 `rpc___test_async_echo` 及其在 `_METHODS_WITH_PROGRESS` 里的注册行**

- [ ] **Step 4: 运行完整测试套件确认无回归**

Run: `python -X utf8 -m pytest modules/file_vault -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "test(file_vault): replace test-only async RPC with real files_batch_execute in concurrency test"
```

---

## Task 11: 前端共享类型 — `ipcTypes.ts`

**Files:**
- Modify: `modules/file_vault/ui/src/shared/ipcTypes.ts`

- [ ] **Step 1: 在 `NoteImportProgress` 定义之后（约现有第 880 行附近，`export type VaultMethodName = ...` 之前）插入共享批量类型**

```ts
export type BatchConflictReason = 'name_exists_diff_content' | 'duplicate_in_batch'
export type BatchItemStatus = 'new' | 'unchanged' | 'conflict' | 'error'

export interface BatchPlanItem {
  key: string
  source_label: string
  input_path: string
  output_path: string
  suggested_rename_path: string | null
  status: BatchItemStatus
  conflict_reason: BatchConflictReason | null
  error_code: string | null
}

export interface BatchPreflightResult {
  items: BatchPlanItem[]
  duplicate_outputs_in_batch: string[]
}

export type BatchWriteMode = 'new' | 'overwrite' | 'rename'
export type BatchSkipReason = 'unchanged' | 'user'

export interface BatchExecuteItem {
  key: string
  input_path: string
  output_path: string
  action: 'run' | 'skip'
  write_mode?: BatchWriteMode
  skip_reason?: BatchSkipReason
}

export interface BatchExecuteSummary {
  success: number
  skipped_unchanged: number
  skipped_by_user: number
  renamed: number
  overwritten: number
  failed: Array<{ key: string; error: string; error_params?: Record<string, unknown> }>
}

export interface BatchExecuteProgress extends ProgressEvent {
  item_index: number
  total_items: number
  item_label: string
}
```

- [ ] **Step 2: 在 `VaultMethods` interface 里、`encrypt_file`/`decrypt_file` 条目附近新增两个方法条目**

```ts
files_batch_preflight: {
  params: { method: 'encrypt_file' | 'decrypt_file'; items: Array<{ key: string; input_path: string; output_path: string }> }
  result:
    | ({ ok: true } & BatchPreflightResult)
    | { ok: false; error: string; error_params?: Record<string, string | number> }
}
files_batch_execute: {
  params: {
    method: 'encrypt_file' | 'decrypt_file'
    items: BatchExecuteItem[]
    cipher?: FileCipher
    delete_source?: boolean
  }
  result:
    | { ok: true; summary: BatchExecuteSummary }
    | { ok: false; error: string; error_params?: Record<string, string | number> }
}
```

- [ ] **Step 3: 类型检查**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无新增类型错误（此时 `BatchConflictDialog`/`FilesPane.tsx` 还没用到这些新类型，纯新增不会破坏现有代码）

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/shared/ipcTypes.ts
git commit -m "feat(file_vault): add shared batch preflight/execute IPC types"
```

---

## Task 12: 共享组件 — `BatchConflictDialog`

**Files:**
- Create: `modules/file_vault/ui/src/components/shared/BatchConflictDialog.tsx`

参照 `PasswordScreen.tsx` 里 `ImportPreviewDialog` 的结构（受控 `open`/`onOpenChange`，内部 `useState` 管理行选择状态，`flex max-h-[85vh] flex-col` + 内部 `min-h-0 flex-1 overflow-y-auto` 滚动区 + 底部按钮行）。这是第一个被拆到共享目录的对话框组件，因此新建 `components/shared/` 目录。

- [ ] **Step 1: 编写组件（含四个状态分组、conflict 子分组、应用到全部、执行进度、汇总展示）**

```tsx
// modules/file_vault/ui/src/components/shared/BatchConflictDialog.tsx
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { BatchExecuteItem, BatchExecuteProgress, BatchExecuteSummary, BatchPlanItem, BatchWriteMode } from '@/shared/ipcTypes'

export type ConflictResolution = 'overwrite' | 'rename' | 'skip'

export interface BatchConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: BatchPlanItem[]
  namespace: string
  onExecute: (items: BatchExecuteItem[]) => Promise<{ ok: true; summary: BatchExecuteSummary } | { ok: false; error: string }>
  progress: BatchExecuteProgress | null
}

export function BatchConflictDialog({ open, onOpenChange, items, namespace, onExecute, progress }: BatchConflictDialogProps) {
  const { t } = useTranslation(namespace)
  const [forceIncludeUnchanged, setForceIncludeUnchanged] = useState<Set<string>>(new Set())
  const [resolutions, setResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  const [executing, setExecuting] = useState(false)
  const [summary, setSummary] = useState<BatchExecuteSummary | null>(null)

  useEffect(() => {
    if (open) {
      setForceIncludeUnchanged(new Set())
      setResolutions(new Map())
      setExecuting(false)
      setSummary(null)
    }
  }, [open, items])

  const newItems = useMemo(() => items.filter((i) => i.status === 'new'), [items])
  const unchangedItems = useMemo(() => items.filter((i) => i.status === 'unchanged'), [items])
  const duplicateInBatchItems = useMemo(
    () => items.filter((i) => i.status === 'conflict' && i.conflict_reason === 'duplicate_in_batch'),
    [items],
  )
  const nameConflictItems = useMemo(
    () => items.filter((i) => i.status === 'conflict' && i.conflict_reason === 'name_exists_diff_content'),
    [items],
  )
  const errorItems = useMemo(() => items.filter((i) => i.status === 'error'), [items])

  function setAllResolutions(resolution: ConflictResolution) {
    const next = new Map(resolutions)
    for (const item of nameConflictItems) next.set(item.key, resolution)
    setResolutions(next)
  }

  function buildExecuteItems(): BatchExecuteItem[] {
    const result: BatchExecuteItem[] = []
    for (const item of newItems) {
      result.push({ key: item.key, input_path: item.input_path, output_path: item.output_path, action: 'run', write_mode: 'new' as BatchWriteMode })
    }
    for (const item of duplicateInBatchItems) {
      result.push({ key: item.key, input_path: item.input_path, output_path: item.output_path, action: 'run', write_mode: 'new' as BatchWriteMode })
    }
    for (const item of unchangedItems) {
      if (forceIncludeUnchanged.has(item.key)) {
        result.push({ key: item.key, input_path: item.input_path, output_path: item.output_path, action: 'run', write_mode: 'overwrite' as BatchWriteMode })
      } else {
        result.push({ key: item.key, input_path: item.input_path, output_path: item.output_path, action: 'skip', skip_reason: 'unchanged' })
      }
    }
    for (const item of nameConflictItems) {
      const resolution = resolutions.get(item.key) ?? 'skip'
      if (resolution === 'skip') {
        result.push({ key: item.key, input_path: item.input_path, output_path: item.output_path, action: 'skip', skip_reason: 'user' })
      } else if (resolution === 'overwrite') {
        result.push({ key: item.key, input_path: item.input_path, output_path: item.output_path, action: 'run', write_mode: 'overwrite' })
      } else {
        result.push({ key: item.key, input_path: item.input_path, output_path: item.suggested_rename_path ?? item.output_path, action: 'run', write_mode: 'rename' })
      }
    }
    return result
  }

  async function handleConfirm() {
    setExecuting(true)
    const res = await onExecute(buildExecuteItems())
    setExecuting(false)
    if (res.ok) setSummary(res.summary)
  }

  const canConfirm = !executing && nameConflictItems.every((i) => resolutions.has(i.key))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('batchConflictDialogTitle')}</DialogTitle>
        </DialogHeader>

        {summary ? (
          <div className="space-y-2 text-sm">
            <p>{t('batchSummarySuccess', { count: summary.success })}</p>
            <p>{t('batchSummarySkippedUnchanged', { count: summary.skipped_unchanged })}</p>
            <p>{t('batchSummarySkippedByUser', { count: summary.skipped_by_user })}</p>
            <p>{t('batchSummaryRenamed', { count: summary.renamed })}</p>
            <p>{t('batchSummaryOverwritten', { count: summary.overwritten })}</p>
            {summary.failed.length > 0 && (
              <div>
                <p>{t('batchSummaryFailed', { count: summary.failed.length })}</p>
                <ul className="list-disc pl-5">
                  {summary.failed.map((f) => (
                    <li key={f.key}>{f.key}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <Button onClick={() => onOpenChange(false)}>{t('batchCloseButton')}</Button>
            </div>
          </div>
        ) : executing ? (
          <div className="space-y-2 pt-2">
            <p className="text-sm text-muted-foreground">
              {progress ? t('batchExecuteProgressLabel', { current: progress.item_index + 1, total: progress.total_items, fileName: progress.item_label }) : ''}
            </p>
            <Progress value={progress ? ((progress.item_index + 1) / progress.total_items) * 100 : 0} />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
              {nameConflictItems.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">{t('batchGroupConflict', { count: nameConflictItems.length })}</h4>
                    <Select onValueChange={(v) => setAllResolutions(v as ConflictResolution)}>
                      <SelectTrigger className="w-40"><SelectValue placeholder={t('batchApplyToAll')} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="overwrite">{t('batchResolutionOverwrite')}</SelectItem>
                        <SelectItem value="rename">{t('batchResolutionRename')}</SelectItem>
                        <SelectItem value="skip">{t('batchResolutionSkip')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {nameConflictItems.map((item) => (
                    <div key={item.key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{item.source_label}</span>
                      <Select value={resolutions.get(item.key) ?? ''} onValueChange={(v) => setResolutions(new Map(resolutions).set(item.key, v as ConflictResolution))}>
                        <SelectTrigger className="w-36"><SelectValue placeholder={t('batchChooseResolution')} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="overwrite">{t('batchResolutionOverwrite')}</SelectItem>
                          <SelectItem value="rename">{t('batchResolutionRename')}</SelectItem>
                          <SelectItem value="skip">{t('batchResolutionSkip')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </section>
              )}

              {duplicateInBatchItems.length > 0 && (
                <section className="space-y-1">
                  <h4 className="text-sm font-medium">{t('batchGroupDuplicateInBatch', { count: duplicateInBatchItems.length })}</h4>
                  {duplicateInBatchItems.map((item) => (
                    <p key={item.key} className="text-sm text-muted-foreground">{item.source_label} → {item.output_path}</p>
                  ))}
                </section>
              )}

              {unchangedItems.length > 0 && (
                <section className="space-y-1">
                  <h4 className="text-sm font-medium">{t('batchGroupUnchanged', { count: unchangedItems.length })}</h4>
                  {unchangedItems.map((item) => (
                    <div key={item.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={forceIncludeUnchanged.has(item.key)}
                        onCheckedChange={(v) => {
                          const next = new Set(forceIncludeUnchanged)
                          if (v === true) next.add(item.key)
                          else next.delete(item.key)
                          setForceIncludeUnchanged(next)
                        }}
                      />
                      <Label className="font-normal">{item.source_label}</Label>
                    </div>
                  ))}
                </section>
              )}

              {newItems.length > 0 && (
                <section>
                  <h4 className="text-sm font-medium">{t('batchGroupNew', { count: newItems.length })}</h4>
                </section>
              )}

              {errorItems.length > 0 && (
                <section className="space-y-1">
                  <h4 className="text-sm font-medium text-destructive">{t('batchGroupError', { count: errorItems.length })}</h4>
                  {errorItems.map((item) => (
                    <p key={item.key} className="text-sm text-destructive">{item.source_label}</p>
                  ))}
                </section>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t('batchCancelButton')}</Button>
              <Button disabled={!canConfirm} onClick={handleConfirm}>{t('batchConfirmButton')}</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无类型错误（此时还没有任何地方 import 这个组件，只验证组件自身类型正确）

- [ ] **Step 3: 提交**

```bash
git add modules/file_vault/ui/src/components/shared/BatchConflictDialog.tsx
git commit -m "feat(file_vault): add shared BatchConflictDialog component"
```

---

## Task 13: i18n — 6 个语言的 `files.json` 新增批量冲突文案 + 新增错误码翻译

**Files:**
- Modify: `modules/file_vault/ui/src/i18n/locales/{en,zh,fr,es,ru,ar}/files.json`
- Modify: `modules/file_vault/ui/src/i18n/locales/{en,zh,fr,es,ru,ar}/errors.json`

Task 7/9 引入了两个新的后端错误码 `files.source_not_found`（预检时源文件不存在/不可读）和 `files.io_error`（执行阶段的 `OSError`），这两个码目前在 6 个 `errors.json` 里都不存在。`translateError()`（`ui/src/i18n/errors.ts`）对未收录的错误码会退化成一个不具体的兜底文案，所以这两个码必须补上翻译，否则批量流程里的这两类失败会展示成没有信息量的通用错误。参照 `errors.json` 现有的 `notes.import_read_failed`/`notes.export_write_failed` 等"带 `{{detail}}` 占位符"的错误码风格。

- [ ] **Step 1: 在每个语言的 `errors.json` 里新增两个 key（先在 `zh` 写好参考值，再对每个语言翻译）**

`zh/errors.json`（参考值，插在文件末尾 `"common.unknown"` 之前即可）：

```json
"files.source_not_found": "源文件不存在或无法读取",
"files.io_error": "文件读写失败：{{detail}}",
```

`en`/`fr`/`es`/`ru`/`ar` 用对应语言的合理翻译，`{{detail}}` 占位符名称必须与 `zh` 完全一致。

- [ ] **Step 2: 在每个语言的 `files.json` 里新增以下 key（先在 `zh` 写好参考值，再对每个语言翻译；沿用现有 `camelCase` + `{{}}` 插值风格）**

```json
"batchConflictDialogTitle": "批量导入/导出确认",
"batchGroupNew": "将新建（{{count}}）",
"batchGroupUnchanged": "内容相同，默认跳过（{{count}}）",
"batchGroupDuplicateInBatch": "批次内重名，已自动改名（{{count}}）",
"batchGroupConflict": "需要选择处理方式（{{count}}）",
"batchGroupError": "无法处理（{{count}}）",
"batchApplyToAll": "应用到全部",
"batchChooseResolution": "选择处理方式",
"batchResolutionOverwrite": "覆盖",
"batchResolutionRename": "自动改名",
"batchResolutionSkip": "跳过",
"batchCancelButton": "取消",
"batchConfirmButton": "确认执行",
"batchCloseButton": "关闭",
"batchExecuteProgressLabel": "正在处理 {{current}}/{{total}}：{{fileName}}",
"batchSummarySuccess": "成功：{{count}}",
"batchSummarySkippedUnchanged": "跳过（内容相同）：{{count}}",
"batchSummarySkippedByUser": "跳过（用户选择）：{{count}}",
"batchSummaryRenamed": "已改名：{{count}}",
"batchSummaryOverwritten": "已覆盖：{{count}}",
"batchSummaryFailed": "失败：{{count}}"
```

（`en`/`fr`/`es`/`ru`/`ar` 用对应语言的合理翻译，插值占位符 `{{count}}`/`{{current}}`/`{{total}}`/`{{fileName}}` 名称必须与 `zh` 完全一致，否则 `t()` 调用时的变量替换会失效。）

- [ ] **Step 3: 校验 6 个 `files.json` 和 6 个 `errors.json` 各自的 key 集合完全一致**

Run:
```bash
cd modules/file_vault/ui/src/i18n/locales
python -c "
import json, sys
langs = ['en','zh','fr','es','ru','ar']
for fname in ['files.json', 'errors.json']:
    sets = {}
    for l in langs:
        with open(f'{l}/{fname}', encoding='utf-8') as f:
            sets[l] = set(json.load(f).keys())
    ref = sets['zh']
    for l in langs:
        if sets[l] != ref:
            print(fname, l, 'missing:', ref - sets[l], 'extra:', sets[l] - ref)
            sys.exit(1)
    print(fname, 'all locales match')
"
```
Expected: `files.json all locales match` 和 `errors.json all locales match`

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/i18n/locales/*/files.json modules/file_vault/ui/src/i18n/locales/*/errors.json
git commit -m "i18n(file_vault): add batch conflict dialog strings and new error codes for all locales"
```

---

## Task 14: `FilesPane.tsx` — 加密批量流程接入预检/冲突引擎

**Files:**
- Modify: `modules/file_vault/ui/src/components/FilesPane.tsx`

替换现有 `handleEncrypt` 里"多选源文件 → 直接拼输出路径 → `runBatch`"的路径，改为"多选源文件 → 拼候选输出路径 → 调 `files_batch_preflight` → 打开 `BatchConflictDialog` → 用户确认 → 调 `files_batch_execute`"。单文件加密（已有单独的 `saveFile` 对话框分支）不受影响，继续走原有单文件路径不接入批量引擎（单文件没有"批内冲突"概念，现有 `read_header`/覆盖确认已经是操作系统对话框级别的保护，超出 M1 范围）。

- [ ] **Step 1: 新增状态与预检/执行的调用函数**

在现有 state 声明区（约第 62-79 行附近）新增：

```ts
const [batchDialogOpen, setBatchDialogOpen] = useState(false)
const [batchDialogItems, setBatchDialogItems] = useState<BatchPlanItem[]>([])
const [batchDialogMethod, setBatchDialogMethod] = useState<FileMethod>('encrypt_file')
const [batchExecuteProgress, setBatchExecuteProgress] = useState<BatchExecuteProgress | null>(null)
```

对应在文件顶部 import 区补充类型：

```ts
import type { BatchExecuteItem, BatchExecuteProgress, BatchExecuteSummary, BatchPlanItem } from '@/shared/ipcTypes'
import { BatchConflictDialog } from '@/components/shared/BatchConflictDialog'
```

**重入保护说明**：现有的 `busyLabel`/`showProgress`（`showProgress = busyLabel !== null`，约第 62/374 行）已经是这个组件里 Encrypt/Decrypt/Scan 等按钮的唯一禁用开关（约第 389/400/408/415/423/433/438/480/495/498 行都用 `disabled={showProgress}`）。批量预检/对话框/执行这整段新流程必须复用同一个开关，覆盖从"点击 Encrypt/Decrypt 按钮"到"对话框完全关闭"的整个窗口——否则用户能在预检请求进行中（对话框还没弹出）再次点击按钮，触发第二个并发批量流程，而 `handleBatchExecute` 按 `payload.method === 'files_batch_execute'` 过滤 progress、`BatchConflictDialog` 同一时刻只允许一个的假设（spec §4.2）都会被打破。做法：`setBusyLabel(...)` 在发起预检请求前设置（Step 2），只在对话框关闭时才清空，用一个包一层的 `onOpenChange` 处理：

```ts
function handleBatchDialogOpenChange(open: boolean) {
  setBatchDialogOpen(open)
  if (!open) {
    setBusyLabel(null)
  }
}
```

新增一个通用的执行回调（加密/解密复用同一个，区别只在 `method`/`cipher`/`deleteSource`）：

```ts
async function handleBatchExecute(items: BatchExecuteItem[]) {
  const label = batchDialogMethod === 'encrypt_file' ? t('encryptLabel') : t('decryptLabel')
  const unsubscribe = vaultApi.onProgress((payload) => {
    if (payload.method === 'files_batch_execute') {
      setBatchExecuteProgress(payload as unknown as BatchExecuteProgress)
    }
  })
  try {
    const withDelete = batchDialogMethod === 'encrypt_file' ? deleteSourceOnEncrypt : deleteSourceOnDecrypt
    const res = await vaultApi.call('files_batch_execute', {
      method: batchDialogMethod,
      items,
      cipher: batchDialogMethod === 'encrypt_file' ? cipher : undefined,
      delete_source: withDelete,
    })
    if (!res.ok) {
      toast.error(translateError(res.error, res.error_params))
      return { ok: false as const, error: res.error }
    }
    const failed = res.summary.failed.length
    if (failed === 0) {
      toast.success(t('batchCompleteToast', { label, count: res.summary.success }))
    } else {
      toast.error(t('batchPartialCompleteToast', { label, success: res.summary.success, total: items.length, failed }))
    }
    return { ok: true as const, summary: res.summary }
  } finally {
    unsubscribe()
    setBatchExecuteProgress(null)
  }
  // 注意：这里故意不清空 busyLabel——批量执行结束后 BatchConflictDialog 切到汇总视图，
  // 用户还要点"关闭"才算这一整轮批量流程结束，busyLabel 由 handleBatchDialogOpenChange
  // 在对话框真正关闭时统一清空（见上面的重入保护说明）。
}
```

- [ ] **Step 2: 改造 `handleEncrypt` 的多文件分支**

找到现有 `handleEncrypt` 里构造 `items`（`joinPath(outDir, ...)`）之后直接调用 `runBatch(...)` 的那段，替换为：

```ts
const candidateItems = inputPaths.map((p) => ({
  key: p,
  input_path: p,
  output_path: joinPath(outDir, `${basename(p)}.ivault`),
}))

setBusyLabel(t('encryptLabel'))
const preflight = await vaultApi.call('files_batch_preflight', { method: 'encrypt_file', items: candidateItems })
if (!preflight.ok) {
  setBusyLabel(null)
  toast.error(translateError(preflight.error, preflight.error_params))
  return
}

setBatchDialogMethod('encrypt_file')
setBatchDialogItems(preflight.items)
setBatchDialogOpen(true)
```

`setBusyLabel(t('encryptLabel'))` 从这里开始就让 Encrypt/Decrypt/Scan 等按钮进入 `disabled={showProgress}` 状态（见 Step 1 的重入保护说明），直到对话框关闭（`handleBatchDialogOpenChange` 里清空）才恢复可点击——覆盖了预检请求进行中（对话框还没弹出）这段窗口。

保留原有 `runBatch`/`BatchItem`/`BatchProgressState` 定义暂不删除（`handleEncrypt`/`handleDecrypt` 的**单文件**分支仍在用它们）——只替换多文件分支的这一段。

- [ ] **Step 3: 渲染 `BatchConflictDialog`**

在组件 JSX 返回值的合适位置（其它 `<Dialog>` 附近）新增：

```tsx
<BatchConflictDialog
  open={batchDialogOpen}
  onOpenChange={handleBatchDialogOpenChange}
  items={batchDialogItems}
  namespace="files"
  onExecute={handleBatchExecute}
  progress={batchExecuteProgress}
/>
```

注意这里传的是 Step 1 定义的 `handleBatchDialogOpenChange`（而不是直接传 `setBatchDialogOpen`），确保对话框以任何方式关闭（取消按钮、汇总页的关闭按钮、点击遮罩、Esc）都会连带清空 `busyLabel`。

- [ ] **Step 4: 手动验证（此任务无自动化前端测试基础设施，按 spec §9.2 走查）**

Run: `cd modules/file_vault/ui && npm run dev`，在应用里：
1. 选择两个内容不同、但都不存在对应 `.ivault` 的源文件加密 → 应直接走完（对话框里两项都在"将新建"分组，或如果两者都"新建"其实可以考虑跳过对话框，见 Step 5 的可选优化）。
2. 对同一目标目录重复执行一次同样的加密 → 第二次应显示"内容相同，默认跳过"分组。
3. 修改其中一个源文件内容后重新执行 → 应落入"需要选择处理方式"分组，验证覆盖/改名/跳过三个选项都生效。
4. 构造两个不同源文件、故意让候选输出路径撞车（例如两个不同目录下同名文件一起选中）→ 验证"批次内重名，已自动改名"分组展示正确、执行后两个文件都存在。

Expected: 以上四种路径行为符合预期，执行期间切换到笔记/密码页面不卡顿。

- [ ] **Step 5: （可选，视 Step 4 走查体验决定）新增/新建 直接跳过对话框的优化**

如果预检结果里所有项都是 `status === 'new'`（没有任何 unchanged/conflict/error），可以考虑跳过弹窗直接调用 `files_batch_execute`（体验更"极快"）。这是体验优化，不是本任务的验收硬性要求；如果做，逻辑是：

```ts
if (preflight.items.every((i) => i.status === 'new')) {
  const items = preflight.items.map((i) => ({ key: i.key, input_path: i.input_path, output_path: i.output_path, action: 'run' as const, write_mode: 'new' as const }))
  await handleBatchExecuteDirectly(items)  // 复用 handleBatchExecute 的逻辑但不依赖对话框的 progress state
  return
}
```
若时间有限可以跳过这一步，等 M2/M3 一起评估是否值得做成通用行为。

- [ ] **Step 6: 提交**

```bash
git add modules/file_vault/ui/src/components/FilesPane.tsx
git commit -m "feat(file_vault): wire batch encrypt flow through preflight/conflict engine"
```

---

## Task 15: `FilesPane.tsx` — 解密批量流程接入预检/冲突引擎

**Files:**
- Modify: `modules/file_vault/ui/src/components/FilesPane.tsx`

对称地改造 `handleDecrypt` 的多文件分支。注意现有代码里，多文件解密之前有一段对每个文件调用 `read_header` 的预处理（用于取 `original_filename` 构造输出路径、并把读 header 失败的文件放进 `headerFailures`）——这段逻辑继续保留（构造候选输出路径仍然需要 `original_filename`），只是构造完 `candidateItems` 之后，原来直接进 `runBatch` 的地方改成先走 `files_batch_preflight`。`headerFailures` 里的文件不参与预检（本来就读不出 header，不用再让预检去处理，直接作为固定失败项在执行完之后合并进最终汇总提示里，与现状一致）。

- [ ] **Step 1: 改造 `handleDecrypt` 的多文件分支**

找到现有：

```ts
const items = validPaths.map((p) => ({ input_path: p, output_path: joinPath(outDir, originalNames[p]) }))
```

替换为：

```ts
const candidateItems = validPaths.map((p) => ({
  key: p,
  input_path: p,
  output_path: joinPath(outDir, originalNames[p]),
}))

setBusyLabel(t('decryptLabel'))
const preflight = await vaultApi.call('files_batch_preflight', { method: 'decrypt_file', items: candidateItems })
if (!preflight.ok) {
  setBusyLabel(null)
  toast.error(translateError(preflight.error, preflight.error_params))
  return
}

setBatchDialogMethod('decrypt_file')
setBatchDialogItems(preflight.items)
setBatchDialogOpen(true)
```

和 Task 14 Step 2 一样，`setBusyLabel(t('decryptLabel'))` 覆盖预检请求进行中到对话框关闭的整个窗口，防止用户重复点击 Decrypt 触发第二个并发批量流程；对应的 `handleBatchDialogOpenChange`（Task 14 Step 1 已定义，两个方向共用同一个）负责在对话框关闭时清空。

`headerFailures`（若非空）在关闭对话框后的汇总提示里展示——最小实现是维持现状：`headerFailures` 不为空时，先用现有的 `toast.error` 展示这些预检前就失败的文件（与当前代码行为一致），再继续走上面的预检/对话框流程处理 `validPaths`。

- [ ] **Step 2: 复用 Task 14 的 `BatchConflictDialog` 渲染、`handleBatchExecute`、`handleBatchDialogOpenChange`**

`handleBatchExecute` 已经按 `batchDialogMethod` 区分了 encrypt/decrypt（`cipher` 只在 encrypt 时传，`label` 按方向选 `encryptLabel`/`decryptLabel`），无需为解密单独写一份；`<BatchConflictDialog>` 的渲染（含 `onOpenChange={handleBatchDialogOpenChange}`）也已经是通用的，无需改动。

- [ ] **Step 3: 手动验证**

Run: `cd modules/file_vault/ui && npm run dev`，重复 Task 14 Step 4 的四种场景，改为解密方向（用之前加密产出的 `.ivault` 文件做源）。额外验证：两个 `original_filename` 相同的 `.ivault`（例如从不同来源分别加密了同名但内容不同的文件）一起解密到同一目录 → 应落入"批次内重名，已自动改名"。

Expected: 行为对称、正确，无卡顿。

- [ ] **Step 4: 提交**

```bash
git add modules/file_vault/ui/src/components/FilesPane.tsx
git commit -m "feat(file_vault): wire batch decrypt flow through preflight/conflict engine"
```

---

## Task 16: 完整验证与收尾

**Files:** 无新增/修改（纯验证）

- [ ] **Step 1: 后端全量测试**

Run: `python -X utf8 -m pytest modules/file_vault -q`
Expected: 全部 PASS，无回归

- [ ] **Step 2: 前端 lint 与类型检查**

Run: `cd modules/file_vault/ui && npm run lint`
Expected: 无错误

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 前端构建**

Run: `cd modules/file_vault/ui && npm run build`
Expected: 构建成功

- [ ] **Step 4: 确认桌面快捷方式/注册表指向的可执行文件已更新**

按项目既有约定（每次 File Vault 代码变更后的标准收尾步骤），确认构建产物已经是最新的，快捷方式指向的 exe 反映本次改动。

- [ ] **Step 5: 最终手动 GUI 走查确认清单（对应 spec §9.2 + §10 完成标准）**

- [ ] 加密批量：多选/全选、内容相同跳过、同名不同内容三种解决方式、批内重名自动改名
- [ ] 解密批量：同上四种场景
- [ ] 批量执行进度条与最终汇总数字准确
- [ ] 大文件（如几百 MB）与大量小文件（如 50+ 个）两种场景下，执行期间切换到笔记/密码页面不卡顿
- [ ] 单文件加密/解密（未接入批量引擎的路径）行为未受影响

- [ ] **Step 6: 提交（若走查中有小修复，跟随对应修复提交；若全部通过无需改动，跳过本步）**

M1 完成。M2（笔记）将复用本里程碑产出的 `batch_engine.py`（`submit_batch_task`/`sha256_of_file`/`resolve_batch_output_paths`）、`ipcTypes.ts` 共享批量类型、`BatchConflictDialog` 组件——这三者是 M1 交付给后续里程碑的可复用资产。
