# 自动任务执行引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `modules/file_vault/` 现有 Electron 应用内新增"自动任务执行"能力：用户提交需求后，后端编排 `claude` CLI 子进程（隔离 worktree 或直接原目录、全自动或分级放行）无人值守完成开发任务，状态与日志加密存储并复用已解锁的 IMK，额度耗尽时可自动/手动续跑。

**Architecture:** 新增 `task_store.py`（复用 `crypto.py` 的单 blob AES-256-GCM 模式，与 `passwords.py` 同构）负责 meta/日志的加密读写；`task_engine.py` 是状态机 + worktree 生命周期 + `claude` 子进程编排核心；`backend_server.py` 新增 10 个 RPC 并扩展 NDJSON 协议支持"无请求 id 的任务事件推送"；Electron 侧扩展 `pythonBridge.ts`/`preload.ts` 转发任务事件；渲染进程新增 `TaskListScreen.tsx`/`TaskDetailScreen.tsx`。外部 `task_watcher.ps1` 负责额度恢复的定时探测。

**Tech Stack:** Python 3.9（`subprocess`、`threading`、既有 `cryptography` 依赖）、TypeScript/React/Electron（现有 `file_vault/ui`）、PowerShell 7+、Claude Code CLI（`claude` 命令）。

**已知技术风险（Task 0 必须先验证，后续任务据此调整）：**
1. `claude -p ... --output-format stream-json` 的真实事件字段名/类型未知，spec 和本计划里的匹配逻辑都是占位，必须先跑一次真实调用采样。
2. "分级自动"模式设想的"危险操作暂停等待你在 UI 里确认"，依赖 `claude` 的非交互 `-p` 模式能在**运行过程中**暂停并接受一次追加输入来放行某个工具调用——这个能力目前不确定存在。Task 0 必须验证；如果不存在，分级自动降级为：用 `--allowedTools`/`--disallowedTools`（如果 CLI 支持）预先禁止危险操作类别（禁止的调用直接失败，不是暂停等待），这个降级方案在 Task 6 里已经写好作为 fallback。

---

## Phase 0：投产前必须先做的调研

### Task 0: 采样真实 stream-json 输出，验证分级自动的可行性

**Files:**
- Create: `modules/file_vault/tests/fixtures/stream_json_sample.jsonl`（真实采样，供后续 Task 5 写解析逻辑时对照）
- Create: `docs/superpowers/plans/2026-07-09-auto-task-engine-investigation-notes.md`（记录发现）

- [ ] **Step 1**: 在一个临时目录跑一次真实 CLI 调用，捕获完整输出：
  ```bash
  cd /tmp && mkdir claude_probe && cd claude_probe && git init -q
  echo "hello" > a.txt
  claude -p "读取 a.txt 的内容，告诉我它有几个字符" --output-format stream-json --dangerously-skip-permissions > stream_sample.jsonl 2> stderr_sample.txt
  echo "退出码: $?"
  ```
- [ ] **Step 2**: 把 `stream_sample.jsonl` 复制到 `modules/file_vault/tests/fixtures/stream_json_sample.jsonl`，逐行确认：每行的顶层 `type` 字段有哪些取值（预期类似 `system`/`assistant`/`user`/`result`，但以实际输出为准）；`result` 类型的事件里，成功/失败分别长什么样，`session_id` 在哪个字段。
- [ ] **Step 3**: 故意制造一次"需要澄清"的场景（给一个信息不足、`claude` 大概率会反问的任务描述），观察它是通过哪种事件表达"我需要你回答一个问题"——记录下确切的事件结构。
- [ ] **Step 4**: 验证 `--resume <session_id> -p "<追加内容>" --output-format stream-json` 确实能接续同一个 session（用上一步拿到的 session_id 试一次）。
- [ ] **Step 5**: 验证"分级自动"的可行性：查 `claude --help` 或官方文档，确认是否存在 `--allowedTools`/`--disallowedTools`/`--permission-mode` 之类的参数。如果存在能"运行中暂停等待一次额外输入来批准某个工具调用"的机制，记录具体用法；如果不存在，在 investigation-notes 里明确写"降级方案：用 `--disallowedTools` 拉黑危险操作类别，拒绝直接体现为该次工具调用失败，不是真正的暂停等待"。
- [ ] **Step 6**: 把以上全部发现写入 `docs/superpowers/plans/2026-07-09-auto-task-engine-investigation-notes.md`，包括：`type` 取值枚举、`result` 事件的成功/失败字段结构、`session_id` 字段路径、"需要澄清"事件的样子、额度耗尽/限流报错在 stdout 还是 stderr 出现、分级自动的可行性结论。
- [ ] **Step 7**: Commit：
  ```bash
  git add modules/file_vault/tests/fixtures/stream_json_sample.jsonl docs/superpowers/plans/2026-07-09-auto-task-engine-investigation-notes.md
  git commit -m "Capture real claude CLI stream-json sample for auto-task engine parsing"
  ```

**这一步不能跳过或臆测代替**——Task 5（事件分类逻辑）和 Task 6（分级自动实现）都直接依赖这里的真实发现，凭猜测写会返工。

---

## Phase 1：后端状态机与 RPC

### Task 1: `task_store.py` — meta 的加密读写

**Files:**
- Create: `modules/file_vault/task_store.py`
- Test: `modules/file_vault/tests/test_task_store.py`

- [ ] **Step 1: 写失败测试**

```python
# modules/file_vault/tests/test_task_store.py
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, task_store


@pytest.fixture
def imk():
    return crypto.generate_key()


def test_save_and_load_meta_round_trip(tmp_path, imk):
    meta = {"status": "QUEUED", "description": "do the thing"}
    task_store.save_meta(tmp_path, "task-1", meta, imk)
    loaded = task_store.load_meta(tmp_path, "task-1", imk)
    assert loaded == meta


def test_load_meta_missing_task_raises(tmp_path, imk):
    with pytest.raises(task_store.TaskStoreError):
        task_store.load_meta(tmp_path, "does-not-exist", imk)


def test_load_meta_wrong_imk_raises(tmp_path, imk):
    task_store.save_meta(tmp_path, "task-1", {"status": "QUEUED"}, imk)
    wrong_imk = crypto.generate_key()
    with pytest.raises(task_store.TaskStoreError):
        task_store.load_meta(tmp_path, "task-1", wrong_imk)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_task_store.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'modules.file_vault.task_store'`）

- [ ] **Step 3: 实现 `task_store.py`**

```python
"""Encrypted storage for the auto-task engine's per-task state and logs.

Mirrors passwords.py's single-blob AES-256-GCM pattern, not container.py's
chunked file format - task metadata and logs are small structured JSON
(not arbitrary large file bytes), so a whole-blob re-encrypt on every save
is simpler and already far faster than needed. Reuses the same IMK session
file_vault's file/password encryption already unlocks - no extra KDF cost
beyond the one Scrypt call at login.
"""

import base64
import json
from pathlib import Path
from typing import List

from modules.file_vault import crypto

TASKS_DIRNAME = "tasks"
META_FILENAME = "meta.json.enc"
LOG_FILENAME = "log.json.enc"
FORMAT_VERSION = 1


class TaskStoreError(Exception):
    """A task's meta/log couldn't be found, decrypted, or parsed."""


def task_dir(data_dir, task_id: str) -> Path:
    return Path(data_dir) / TASKS_DIRNAME / task_id


def _write_blob(path: Path, plaintext: bytes, imk: bytes) -> None:
    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
    content_nonce = crypto.random_nonce()
    ciphertext = crypto.aead_encrypt(fk, content_nonce, plaintext)

    blob = {
        "format_version": FORMAT_VERSION,
        "fk_wrap": {
            "nonce": base64.b64encode(fk_nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
        },
        "nonce": base64.b64encode(content_nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    tmp_path.replace(path)


def _read_blob(path: Path, imk: bytes) -> bytes:
    if not path.exists():
        raise TaskStoreError(f"找不到任务数据：{path}")
    with open(path, "r", encoding="utf-8") as f:
        try:
            blob = json.load(f)
        except json.JSONDecodeError as exc:
            raise TaskStoreError("任务数据文件格式不正确") from exc

    if blob.get("format_version") != FORMAT_VERSION:
        raise TaskStoreError(f"不支持的任务数据格式版本: {blob.get('format_version')!r}")

    try:
        fk_nonce = base64.b64decode(blob["fk_wrap"]["nonce"])
        wrapped_fk = base64.b64decode(blob["fk_wrap"]["wrapped_fk"])
        content_nonce = base64.b64decode(blob["nonce"])
        ciphertext = base64.b64decode(blob["ciphertext"])
    except (KeyError, TypeError, ValueError) as exc:
        raise TaskStoreError("任务数据文件格式不正确") from exc

    try:
        fk = crypto.unwrap_key(imk, fk_nonce, wrapped_fk)
        return crypto.aead_decrypt(fk, content_nonce, ciphertext)
    except crypto.InvalidTag as exc:
        raise TaskStoreError("无法用当前密钥解开任务数据（密钥不匹配或文件已损坏）") from exc


def save_meta(data_dir, task_id: str, meta: dict, imk: bytes) -> None:
    path = task_dir(data_dir, task_id) / META_FILENAME
    plaintext = json.dumps(meta, ensure_ascii=False).encode("utf-8")
    _write_blob(path, plaintext, imk)


def load_meta(data_dir, task_id: str, imk: bytes) -> dict:
    path = task_dir(data_dir, task_id) / META_FILENAME
    plaintext = _read_blob(path, imk)
    try:
        return json.loads(plaintext.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise TaskStoreError("任务元数据内容已损坏") from exc


def list_task_ids(data_dir) -> List[str]:
    """Returns task ids that have a meta file, in no particular order."""
    tasks_root = Path(data_dir) / TASKS_DIRNAME
    if not tasks_root.exists():
        return []
    return [p.parent.name for p in tasks_root.glob(f"*/{META_FILENAME}")]


def save_log_events(data_dir, task_id: str, events: list, imk: bytes) -> None:
    """Overwrites the whole log with `events` (caller passes the full
    accumulated list - see task_engine.py's in-memory buffer)."""
    path = task_dir(data_dir, task_id) / LOG_FILENAME
    plaintext = json.dumps(events, ensure_ascii=False).encode("utf-8")
    _write_blob(path, plaintext, imk)


def load_log_events(data_dir, task_id: str, imk: bytes) -> list:
    path = task_dir(data_dir, task_id) / LOG_FILENAME
    if not (task_dir(data_dir, task_id) / LOG_FILENAME).exists():
        return []
    plaintext = _read_blob(path, imk)
    try:
        return json.loads(plaintext.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise TaskStoreError("任务日志内容已损坏") from exc


def delete_task_data(data_dir, task_id: str) -> None:
    """Removes meta/log for a discarded task. Does NOT touch the worktree -
    that's task_engine.py's responsibility (git-specific cleanup)."""
    import shutil

    d = task_dir(data_dir, task_id)
    if d.exists():
        shutil.rmtree(d)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_task_store.py -v`
Expected: PASS（3 passed）

- [ ] **Step 5: Commit**

```bash
git add modules/file_vault/task_store.py modules/file_vault/tests/test_task_store.py
git commit -m "Add task_store.py for encrypted auto-task meta/log persistence"
```

---

### Task 2: `task_store.py` — 日志追加与并发写入语义补测试

**Files:**
- Test: `modules/file_vault/tests/test_task_store.py`（追加）

- [ ] **Step 1: 写失败测试**

```python
def test_log_events_round_trip(tmp_path, imk):
    events = [{"type": "assistant", "text": "hi"}, {"type": "result", "subtype": "success"}]
    task_store.save_log_events(tmp_path, "task-1", events, imk)
    loaded = task_store.load_log_events(tmp_path, "task-1", imk)
    assert loaded == events


def test_load_log_events_empty_before_any_save(tmp_path, imk):
    assert task_store.load_log_events(tmp_path, "never-existed", imk) == []


def test_list_task_ids_returns_only_tasks_with_meta(tmp_path, imk):
    task_store.save_meta(tmp_path, "task-a", {"status": "QUEUED"}, imk)
    task_store.save_meta(tmp_path, "task-b", {"status": "QUEUED"}, imk)
    ids = task_store.list_task_ids(tmp_path)
    assert set(ids) == {"task-a", "task-b"}


def test_delete_task_data_removes_directory(tmp_path, imk):
    task_store.save_meta(tmp_path, "task-1", {"status": "QUEUED"}, imk)
    task_store.delete_task_data(tmp_path, "task-1")
    assert not task_store.task_dir(tmp_path, "task-1").exists()
```

- [ ] **Step 2: 跑测试确认失败**（`list_task_ids`/`delete_task_data` 已在 Task 1 实现了，这里应该直接 PASS——如果 PASS 说明 Task 1 的实现已经覆盖，直接进 Step 4）

Run: `python -m pytest modules/file_vault/tests/test_task_store.py -v`
Expected: 若已在 Task 1 写完 `list_task_ids`/`delete_task_data`，7 passed；否则先补实现再跑。

- [ ] **Step 3: （如有缺失）补实现**——本计划 Task 1 的代码已包含这两个函数，通常不需要改动。

- [ ] **Step 4: Commit**

```bash
git add modules/file_vault/tests/test_task_store.py
git commit -m "Add log/list/delete coverage for task_store.py"
```

---

### Task 3: `task_engine.py` — 状态常量、任务数据模型、worktree/baseline 辅助函数

**Files:**
- Create: `modules/file_vault/task_engine.py`
- Test: `modules/file_vault/tests/test_task_engine.py`

**先决条件**：本任务的 git 相关代码需要一个真实临时 git 仓库做测试目标，测试里用 `subprocess.run(["git", "init", ...])` 现造，不依赖开发机上任何真实项目。

- [ ] **Step 1: 写失败测试**

```python
# modules/file_vault/tests/test_task_engine.py
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, task_engine


@pytest.fixture
def imk():
    return crypto.generate_key()


@pytest.fixture
def git_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


def test_create_isolated_worktree(git_repo, tmp_path):
    worktree_path = tmp_path / "wt-1"
    task_engine.create_worktree(git_repo, worktree_path, branch_name="task/abc123")
    assert worktree_path.exists()
    assert (worktree_path / "README.md").exists()
    branches = subprocess.run(
        ["git", "branch", "--list", "task/abc123"], cwd=git_repo, capture_output=True, text=True, check=True
    ).stdout
    assert "task/abc123" in branches


def test_discard_worktree_removes_it_and_branch(git_repo, tmp_path):
    worktree_path = tmp_path / "wt-1"
    task_engine.create_worktree(git_repo, worktree_path, branch_name="task/abc123")
    task_engine.discard_worktree(git_repo, worktree_path, branch_name="task/abc123")
    assert not worktree_path.exists()
    branches = subprocess.run(
        ["git", "branch", "--list", "task/abc123"], cwd=git_repo, capture_output=True, text=True, check=True
    ).stdout
    assert "task/abc123" not in branches


def test_record_baseline_returns_current_head(git_repo):
    head = task_engine.record_baseline(git_repo)
    expected = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=git_repo, capture_output=True, text=True, check=True
    ).stdout.strip()
    assert head == expected


def test_new_task_id_is_unique():
    a = task_engine.new_task_id()
    b = task_engine.new_task_id()
    assert a != b
    assert isinstance(a, str) and len(a) > 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_task_engine.py -v`
Expected: FAIL（`ModuleNotFoundError`）

- [ ] **Step 3: 实现 `task_engine.py`（第一部分：模型 + git 辅助函数）**

```python
"""Orchestrates Claude Code CLI subprocesses for the auto-task engine.

Owns: task_id generation, git worktree/baseline lifecycle, spawning
`claude`, classifying its stream-json output into the task state machine,
and pushing async task_event notifications back through backend_server.py.
Persistence (encrypted meta/log) is entirely task_store.py's job - this
module never touches disk encryption directly.
"""

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from modules.file_vault import task_store

# --- Status constants ---
STATUS_QUEUED = "QUEUED"
STATUS_RUNNING = "RUNNING"
STATUS_WAITING_INPUT = "WAITING_INPUT"
STATUS_QUOTA_BLOCKED = "QUOTA_BLOCKED"
STATUS_DONE_PENDING_REVIEW = "DONE_PENDING_REVIEW"
STATUS_FAILED = "FAILED"
STATUS_MERGED = "MERGED"
STATUS_DISCARDED = "DISCARDED"

# --- Autonomy modes ---
MODE_ISOLATED_FULL_AUTO = "isolated_full_auto"
MODE_DIRECT_FULL_AUTO = "direct_full_auto"
MODE_GRADED_AUTO = "graded_auto"
ALL_MODES = (MODE_ISOLATED_FULL_AUTO, MODE_DIRECT_FULL_AUTO, MODE_GRADED_AUTO)
USES_WORKTREE = (MODE_ISOLATED_FULL_AUTO, MODE_GRADED_AUTO)

DEFAULT_FOLLOWUP_PROMPT = "继续"

# 分级自动模式（MODE_GRADED_AUTO）的权限处理不需要一个工具黑名单常量 -
# Task 0 实测确认，claude -p 模式下不带 --dangerously-skip-permissions 时,
# 需要授权的操作会被自动拒绝而不是把进程挂起等待（见 TaskEngine.spawn 和
# investigation notes）。graded_auto 就是"不传 --dangerously-skip-permissions"，
# 没有更多要做的。

def _resolve_claude_command() -> list:
    """IDEAL1_CLAUDE_EXECUTABLE (override for tests, see fake_claude.py) is a
    JSON-encoded argv list, not a shell-quoted string. An earlier version of
    this plan used shlex.split() on a space-joined string - discovered
    during implementation that shlex.split() treats backslash as an escape
    character even on Windows, corrupting Windows paths like sys.executable
    (the local Python install) and breaking every test that spawns the fake
    CLI. JSON avoids that ambiguity entirely regardless of platform."""
    raw = os.environ.get("IDEAL1_CLAUDE_EXECUTABLE", "claude")
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(p) for p in parsed]
    except (json.JSONDecodeError, ValueError):
        pass
    return [raw]


class TaskEngineError(Exception):
    """git/subprocess plumbing failed in a way the caller needs to see."""


def new_task_id() -> str:
    return str(uuid.uuid4())


def create_worktree(target_dir, worktree_path, branch_name: str) -> None:
    worktree_path = Path(worktree_path)
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "worktree", "add", str(worktree_path), "-b", branch_name],
        cwd=target_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise TaskEngineError(f"创建隔离工作区失败: {result.stderr.strip()}")


def discard_worktree(target_dir, worktree_path, branch_name: str) -> None:
    """Best-effort: removes the worktree and its branch. Used for both the
    'discard' outcome and FAILED/DISCARDED cleanup."""
    subprocess.run(
        ["git", "worktree", "remove", "--force", str(worktree_path)],
        cwd=target_dir,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "branch", "-D", branch_name],
        cwd=target_dir,
        capture_output=True,
        text=True,
    )


def record_baseline(target_dir) -> str:
    """Direct-mode (no worktree): record HEAD before the task runs, so
    task_review_diff can later show 'git diff <baseline>..HEAD plus
    working tree' even though there's no separate branch."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=target_dir, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def diff_summary(target_dir, *, baseline: Optional[str] = None) -> str:
    """baseline given (direct mode) -> diff against that commit + working
    tree. baseline omitted (worktree mode) -> diff of the worktree itself
    against its parent branch's merge-base."""
    if baseline:
        result = subprocess.run(
            ["git", "diff", baseline], cwd=target_dir, capture_output=True, text=True, check=True
        )
    else:
        result = subprocess.run(
            ["git", "diff", "HEAD"], cwd=target_dir, capture_output=True, text=True, check=True
        )
    return result.stdout


def revert_direct_changes(target_dir, baseline: str) -> None:
    """direct_full_auto discard: restore tracked files, leave untracked
    files alone (caller/UI is told about them separately - deleting
    unknown new files without asking is exactly the kind of silent data
    loss this project avoids elsewhere, e.g. secure_delete_file's opt-in
    pattern in container.py)."""
    subprocess.run(["git", "checkout", "--", "."], cwd=target_dir, capture_output=True, text=True)


def list_untracked_files(target_dir) -> list:
    result = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=target_dir,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_task_engine.py -v`
Expected: PASS（5 passed）

- [ ] **Step 5: Commit**

```bash
git add modules/file_vault/task_engine.py modules/file_vault/tests/test_task_engine.py
git commit -m "Add task_engine.py git worktree/baseline lifecycle helpers"
```

---

### Task 4: `task_engine.py` — stream-json 事件分类

**依赖**：Task 0 采样到的 `modules/file_vault/tests/fixtures/stream_json_sample.jsonl` 和 investigation notes。写这个任务前先读一遍那两个文件，把下面代码里的字段名换成真实字段名——下面的代码是**占位实现**，按最常见的 Claude Code stream-json 形状写的（`type` 分 `system`/`assistant`/`user`/`result`，`result` 事件带 `subtype`/`is_error`/`session_id`），实现时以 Task 0 的真实采样为准。

**Files:**
- Modify: `modules/file_vault/task_engine.py`
- Test: `modules/file_vault/tests/test_task_engine.py`（追加）
- Test fixture: `modules/file_vault/tests/fixtures/stream_json_sample.jsonl`（Task 0 产出）

- [ ] **Step 1: 写失败测试**（先用 Task 0 的真实采样文件里挑一行"正常完成"和一行"需要澄清"的事件，构造成断言；下面是占位示例，写代码时替换成采样文件里的真实内容）

```python
import json

from modules.file_vault import task_engine


def test_classify_normal_completion_event():
    event = {"type": "result", "subtype": "success", "is_error": False, "session_id": "sess-1"}
    outcome = task_engine.classify_event(event)
    assert outcome.kind == "done"
    assert outcome.session_id == "sess-1"


def test_classify_quota_exceeded_from_result_text_fallback():
    # api_error_status 缺失时的兜底路径 - 主判据是 api_error_status，见下面
    # test_classify_quota_exceeded_from_api_error_status。
    event = {
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": True,
        "api_error_status": None,
        "terminal_reason": "error",
        "session_id": "sess-1",
        "result": "Claude usage limit reached for this session",
    }
    outcome = task_engine.classify_event(event)
    assert outcome.kind == "quota_blocked"


def test_classify_generic_failure_from_result_event():
    event = {
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": True,
        "api_error_status": None,
        "terminal_reason": "error",
        "session_id": "sess-1",
        "result": "unexpected tool error",
    }
    outcome = task_engine.classify_event(event)
    assert outcome.kind == "failed"


def test_classify_quota_exceeded_from_api_error_status():
    # Task 0 未能实测到真实限流时的确切字段值（不能故意刷爆账号额度去触
    # 发），但确认了 result 事件带 api_error_status 字段，限流类错误预期
    # 会在这里带上 HTTP 429 - 这是比文本关键词更可靠的主判据。
    event = {
        "type": "result",
        "is_error": True,
        "api_error_status": 429,
        "terminal_reason": "error",
        "session_id": "sess-1",
        "result": "some error text that doesn't mention quota at all",
    }
    outcome = task_engine.classify_event(event)
    assert outcome.kind == "quota_blocked"


def test_classify_non_result_event_is_just_log():
    event = {"type": "assistant", "message": {"content": [{"type": "text", "text": "working on it"}]}}
    outcome = task_engine.classify_event(event)
    assert outcome.kind == "log_only"


def test_load_fixture_sample_lines_all_classify_without_crashing():
    fixture = Path(__file__).parent / "fixtures" / "stream_json_sample.jsonl"
    for line in fixture.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        outcome = task_engine.classify_event(event)
        assert outcome.kind in ("log_only", "done", "quota_blocked", "failed", "waiting_input")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_task_engine.py -v -k classify`
Expected: FAIL（`AttributeError: module 'task_engine' has no attribute 'classify_event'`）

- [ ] **Step 3: 实现事件分类**（追加到 `task_engine.py`）——Task 0 的真实调研（见 `docs/superpowers/plans/2026-07-09-auto-task-engine-investigation-notes.md`）确认 `result` 事件带 `terminal_reason`/`api_error_status` 字段，比原计划设想的"文本关键词匹配"可靠得多，作为主判据；文本关键词降级为没有这些字段时的兜底。

```python
from dataclasses import dataclass


# 兜底：只在 api_error_status 缺失时才会用到（见 classify_event）。Task 0
# 没能实测到真实限流时的确切字段值（不能故意刷爆账号额度去验证），如果
# 之后在实际使用中遇到一次真实限流，把观察到的措辞回填到这里。
QUOTA_EXCEEDED_MARKERS = (
    "usage limit",
    "rate limit",
    "quota",
)


@dataclass
class EventOutcome:
    kind: str  # "log_only" | "done" | "quota_blocked" | "failed" | "waiting_input"
    session_id: Optional[str] = None
    summary: Optional[str] = None
    question: Optional[str] = None


def classify_event(event: dict) -> EventOutcome:
    event_type = event.get("type")
    session_id = event.get("session_id")

    if event_type != "result":
        return EventOutcome(kind="log_only", session_id=session_id)

    if not event.get("is_error"):
        return EventOutcome(kind="done", session_id=session_id, summary=event.get("result"))

    # 主判据：api_error_status 是 HTTP 状态码（限流预期是 429）- 比文本匹配
    # 可靠，不依赖措辞。
    if event.get("api_error_status") == 429:
        return EventOutcome(kind="quota_blocked", session_id=session_id, summary=event.get("result"))

    # 兜底：字段缺失时退回文本关键词匹配。
    result_text = (event.get("result") or "").lower()
    if any(marker in result_text for marker in QUOTA_EXCEEDED_MARKERS):
        return EventOutcome(kind="quota_blocked", session_id=session_id, summary=event.get("result"))

    return EventOutcome(kind="failed", session_id=session_id, summary=event.get("result"))
```

**分级自动的"需要澄清"/"危险操作待确认"分类**：Task 0 调研确认了两件事——(1) `-p` 非交互模式下没有找到"运行中暂停、等待你实时批准"的机制；(2) 更重要的是，不带 `--dangerously-skip-permissions` 时，需要授权的操作（实测：`Write`）会被**自动拒绝**而不是把进程挂起等待——进程照常跑完，被拒绝的调用记录在 `result` 事件的 `permission_denials` 字段里。这意味着"分级自动"不需要一个独立的 `waiting_input` 事件分类分支，也不需要黑名单：任务照常走到 `done`，`EventOutcome` 不需要额外的 `permission_denials` 字段（`_finish_task` 需要的话可以直接从原始 `event` 里读，不用 `classify_event` 转发）。`WAITING_INPUT` 状态在当前版本里基本不会被真正触发（保留状态本身和 UI，标注为"预留"），这个结论已经写回 investigation notes。

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_task_engine.py -v`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add modules/file_vault/task_engine.py modules/file_vault/tests/test_task_engine.py
git commit -m "Add stream-json event classification to task_engine.py"
```

---

### Task 5: 测试用的假 `claude` 脚本

**Files:**
- Create: `modules/file_vault/tests/fixtures/fake_claude.py`

不跑真实 CLI（慢、耗额度、不可控），后续所有子进程编排测试都指向这个脚本。

- [ ] **Step 1: 实现**

```python
#!/usr/bin/env python
"""Stands in for the real `claude` CLI in tests. Reads its -p prompt for a
trigger keyword and prints a canned stream-json transcript matching that
scenario, then exits with the matching code. Selected via
IDEAL1_CLAUDE_EXECUTABLE=json.dumps([sys.executable, <this script's path>])
(see task_engine._resolve_claude_command).
"""
import argparse
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", dest="prompt", required=True)
    parser.add_argument("--output-format", default="stream-json")
    parser.add_argument("--resume", default=None)
    parser.add_argument("--dangerously-skip-permissions", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--cwd", default=None)
    args, _unknown = parser.parse_known_args()

    session_id = args.resume or "fake-session-1"
    # resumed=True lets tests tell "actually invoked with --resume" apart
    # from "coincidentally got the same fake session id" - see Task 17's
    # test, which asserts on this field to catch the resume-vs-fresh-start
    # bug class a plan review round caught (silently starting a brand new
    # session instead of resuming after an auto-retry).
    emit({"type": "system", "subtype": "init", "session_id": session_id, "resumed": args.resume is not None})
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": f"working on: {args.prompt}"}]}})

    # Lets tests reliably observe a task still RUNNING/occupying the single
    # concurrency slot (e.g. Task 8's test that a second task stays QUEUED
    # behind it) instead of racing the near-instant default completion -
    # discovered during Task 8 implementation that without this, the first
    # task could finish and free the slot before the test even checked the
    # second task's status.
    if "TRIGGER_SLOW" in args.prompt:
        time.sleep(2)

    if "TRIGGER_QUOTA" in args.prompt:
        emit(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "session_id": session_id,
                "result": "Claude usage limit reached for this session",
            }
        )
        sys.exit(1)

    if "TRIGGER_FAIL" in args.prompt:
        emit(
            {
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": True,
                "session_id": session_id,
                "result": "unexpected tool error",
            }
        )
        sys.exit(1)

    emit({"type": "result", "subtype": "success", "is_error": False, "session_id": session_id, "result": "done"})
    sys.exit(0)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 手动确认它能跑**

Run: `python modules/file_vault/tests/fixtures/fake_claude.py -p "hello" --output-format stream-json`
Expected: 三行 JSON，退出码 0（`echo $?` 确认）

- [ ] **Step 3: Commit**

```bash
git add modules/file_vault/tests/fixtures/fake_claude.py
git commit -m "Add fake claude CLI fixture for task engine subprocess tests"
```

---

### Task 6: `task_engine.py` — 子进程编排、后台读取线程、单任务并发门禁

**Files:**
- Modify: `modules/file_vault/task_engine.py`
- Test: `modules/file_vault/tests/test_task_engine.py`（追加）

- [ ] **Step 1: 写失败测试**

```python
import time


@pytest.fixture
def fake_claude_env(monkeypatch):
    import json

    fixture_path = Path(__file__).parent / "fixtures" / "fake_claude.py"
    # JSON-encoded argv list, not shell-quoted - see
    # task_engine._resolve_claude_command's docstring for why shlex.split()
    # doesn't work here on Windows. _resolve_claude_command() reads the env
    # var at call time inside spawn(), so no importlib.reload() is needed
    # to pick up a change made via monkeypatch mid-test.
    monkeypatch.setenv("IDEAL1_CLAUDE_EXECUTABLE", json.dumps([sys.executable, str(fixture_path)]))
    yield


def test_run_task_to_completion(git_repo, fake_claude_env):
    engine = task_engine.TaskEngine()
    events = []
    engine.spawn(prompt="do the thing", cwd=git_repo, on_event=events.append)
    engine.wait(timeout=10)
    kinds = [task_engine.classify_event(e).kind for e in events if e.get("type") == "result"]
    assert kinds == ["done"]
    assert engine.exit_code == 0


def test_run_task_quota_blocked(git_repo, fake_claude_env):
    engine = task_engine.TaskEngine()
    events = []
    engine.spawn(prompt="TRIGGER_QUOTA please", cwd=git_repo, on_event=events.append)
    engine.wait(timeout=10)
    kinds = [task_engine.classify_event(e).kind for e in events if e.get("type") == "result"]
    assert kinds == ["quota_blocked"]
    assert engine.exit_code != 0


def test_run_task_failed(git_repo, fake_claude_env):
    engine = task_engine.TaskEngine()
    events = []
    engine.spawn(prompt="TRIGGER_FAIL please", cwd=git_repo, on_event=events.append)
    engine.wait(timeout=10)
    kinds = [task_engine.classify_event(e).kind for e in events if e.get("type") == "result"]
    assert kinds == ["failed"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_task_engine.py -v -k run_task`
Expected: FAIL（`AttributeError: no attribute 'TaskEngine'`）

- [ ] **Step 3: 实现**（追加到 `task_engine.py`）

```python
class TaskEngine:
    """One instance wraps exactly one running `claude` subprocess. A
    background thread reads its stdout line by line and calls on_event for
    every parsed JSON line - the caller (backend_server.py, via the module-
    level runtime below) is responsible for persisting/broadcasting them."""

    def __init__(self):
        self._proc: Optional[subprocess.Popen] = None
        self._reader_thread: Optional[threading.Thread] = None
        self.exit_code: Optional[int] = None
        self.stderr_text: str = ""

    def spawn(
        self,
        *,
        prompt: str,
        cwd,
        on_event: Callable[[dict], None],
        resume_session_id: Optional[str] = None,
        skip_permissions: bool = True,
    ) -> None:
        # --verbose is required by the real CLI whenever -p is combined with
        # --output-format stream-json (confirmed in Task 0 - omitting it is
        # a hard error, not a warning: "Error: When using --print,
        # --output-format=stream-json requires --verbose").
        cmd = _resolve_claude_command() + ["-p", prompt, "--output-format", "stream-json", "--verbose"]
        if resume_session_id:
            cmd += ["--resume", resume_session_id]
        if skip_permissions:
            cmd.append("--dangerously-skip-permissions")
        # graded_auto (skip_permissions=False) deliberately passes no other
        # flag - see the note below the class for why no disallowed-tools
        # list is needed.

        self._proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

        def _read_loop():
            assert self._proc is not None
            for line in self._proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                on_event(event)
            self._proc.wait()
            self.exit_code = self._proc.returncode
            self.stderr_text = self._proc.stderr.read() if self._proc.stderr else ""

        self._reader_thread = threading.Thread(target=_read_loop, daemon=True)
        self._reader_thread.start()

    def wait(self, timeout: Optional[float] = None) -> None:
        if self._reader_thread:
            self._reader_thread.join(timeout=timeout)

    def is_running(self) -> bool:
        return self._reader_thread is not None and self._reader_thread.is_alive()

    def kill(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.kill()
```

**关于"分级自动"**：Task 0 实测确认，`-p` 非交互模式下不带 `--dangerously-skip-permissions` 时，需要授权的操作（实测 `Write`）会被自动拒绝而不是把进程挂起——进程正常跑完，被拒绝的调用记录在最终 `result` 事件的 `permission_denials` 字段里。这比最初设计的"黑名单 `--disallowedTools`"更简单也更安全（不需要维护一份危险操作模式列表，默认行为本身就是 fail-closed），所以 `spawn` 不需要 `disallowed_tools` 参数——`skip_permissions=False` 时就是"什么都不传"，剩下的交给 CLI 自己的默认权限模型。计划早期版本设计过一个 `DEFAULT_GRADED_DISALLOWED_TOOLS` 黑名单常量，已确认不需要，Task 8/9 里不会用到它。

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_task_engine.py -v`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add modules/file_vault/task_engine.py modules/file_vault/tests/test_task_engine.py
git commit -m "Add TaskEngine subprocess orchestration with background reader thread"
```

---

### Task 7: `backend_server.py` — NDJSON 协议扩展：无请求 id 的任务事件推送

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`（追加）

现有协议里所有推送（`progress`）都挂在某个正在被同步等待的请求 id 上。任务是长时间运行的后台工作，`task_create`/`task_resume` 必须立刻返回（不能同步阻塞到任务结束），后续状态变化通过一种新的、不挂靠任何请求 id 的消息类型推送：

```
{"task_event": {"task_id": "...", "status": "...", "new_events": [...]}}
```

- [ ] **Step 1: 写失败测试**（验证 `_write` 现在是线程安全的，且能发出不带 id 的消息）

```python
def test_task_event_message_has_no_id_field(client):
    # 直接单元测试 backend_server 模块级函数，不走完整 RPC 往返 -
    # 这里验证协议帧格式本身。
    import io
    import json as _json
    from modules.file_vault import backend_server

    buf = io.StringIO()
    backend_server._stdout_lock = backend_server.threading.Lock()
    old_stdout = backend_server.sys.stdout
    backend_server.sys.stdout = buf
    try:
        backend_server._write_task_event("task-1", {"status": "RUNNING", "new_events": []})
    finally:
        backend_server.sys.stdout = old_stdout

    msg = _json.loads(buf.getvalue().strip())
    assert "id" not in msg
    assert msg["task_event"]["task_id"] == "task-1"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k task_event`
Expected: FAIL（`AttributeError: module has no attribute '_write_task_event'`）

- [ ] **Step 3: 实现**（修改 `backend_server.py` 顶部和 `_write`）

```python
import threading  # 加到已有 import 块

_stdout_lock = threading.Lock()


def _write(msg: dict) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _write_task_event(task_id: str, payload: dict) -> None:
    """Unsolicited, not tied to any request id - task_engine.py's
    background reader thread calls this directly as tasks progress,
    concurrently with the main thread's synchronous request/response loop.
    _stdout_lock (used by _write too) keeps the two from interleaving
    mid-line."""
    _write({"task_event": {"task_id": task_id, **payload}})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k task_event`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Add thread-safe unsolicited task_event protocol message"
```

---

### Task 8: `backend_server.py` — 任务运行时状态 + `task_create`/`task_list`/`task_cancel`

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Modify: `modules/file_vault/tests/test_backend_server.py`（`BackendClient` 本身，先于本任务的新测试）
- Test: `modules/file_vault/tests/test_backend_server.py`（追加新用例）

维护模块级运行时状态（同 `_store`/`_imk` 的既有模式）：

```python
_RUNNING_TASK_ID: Optional[str] = None  # 全局单任务并发门禁
_RUNNING_ENGINE: Optional["task_engine.TaskEngine"] = None
_TASK_LOG_BUFFERS: Dict[str, list] = {}  # task_id -> 累积的 stream-json 事件（内存），定期 flush 到加密日志
```

**必须先做**：从这个任务开始，`rpc_task_create` 会在返回 RPC 响应之前，从后台就已经同步写出至少一条无 id 的 `task_event` 行（`_start_task` 一开始就调用 `_write_task_event`）。现有的 `BackendClient.call()`（`test_backend_server.py` 里，Task 7 之前就存在）读到第一行就 `assert msg["id"] == req_id`，如果先读到 `task_event` 行会直接 `KeyError`。这不是小概率巧合，是本任务每一个调用 `task_create` 的测试都会触发的必现问题——所以 `BackendClient` 的修补必须在写本任务的新测试**之前**先做，不能拖到 Task 9：

```python
# test_backend_server.py，替换现有 BackendClient.call 里读一行判断的那段
class BackendClient:
    def call(self, method: str, params: dict):
        self._next_id += 1
        req_id = self._next_id
        self.proc.stdin.write(json.dumps({"id": req_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()

        progress_events = []
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"backend_server.py closed stdout unexpectedly (stderr: {self.proc.stderr.read()})")
            msg = json.loads(line)
            if "task_event" in msg:
                continue  # 无 id 的异步任务事件，不属于本次请求的响应，跳过
            assert msg["id"] == req_id
            if "progress" in msg:
                progress_events.append(msg["progress"])
                continue
            if "error" in msg:
                return None, progress_events, msg["error"]["message"]
            return msg["result"], progress_events, None
```

跑一次既有测试确认这个改动本身不引入回归：

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: 全部 PASS（改动只是多跳过一种消息类型，既有用例不受影响）

Commit 这一步单独提交，方便后续任务定位：

```bash
git add modules/file_vault/tests/test_backend_server.py
git commit -m "Make BackendClient skip unsolicited task_event lines before adding task RPCs"
```

- [ ] **Step 1: 写失败测试**

```python
def test_task_create_queues_when_nothing_running(client, tmp_path):
    _setup_and_unlock(client)
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "a.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)

    result, _, error = client.call(
        "task_create",
        {
            "target_dir": str(repo),
            "description": "say hello",
            "autonomy_mode": "isolated_full_auto",
            "engine": "cli",
        },
    )
    assert error is None
    assert result["ok"] is True
    assert "task_id" in result

    result, _, _ = client.call("task_list", {})
    assert len(result["tasks"]) == 1
    assert result["tasks"][0]["status"] in ("QUEUED", "RUNNING")


def test_task_cancel_queued_task(client, tmp_path):
    _setup_and_unlock(client)
    # ...创建两个任务，第二个必然还是 QUEUED（单任务并发门禁），取消它
    # 具体 repo 搭建同上，省略重复代码，复用一个 helper。
```

（完整代码在实现阶段把上面创建临时 git 仓库的重复代码提成一个 `_make_git_repo(tmp_path)` 测试 helper，放在 `test_backend_server.py` 顶部。）

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k task_create`
Expected: FAIL（`Unknown method: task_create`）

- [ ] **Step 3: 实现**（追加到 `backend_server.py`）

```python
from modules.file_vault import task_engine, task_store  # 加到顶部 import

_RUNNING_TASK_ID: Optional[str] = None
_RUNNING_ENGINE = None
_TASK_LOG_BUFFERS: Dict[str, list] = {}


def _task_summary(meta: dict, task_id: str) -> dict:
    return {
        "task_id": task_id,
        "description": meta.get("description"),
        "target_dir": meta.get("target_dir"),
        "status": meta.get("status"),
        "autonomy_mode": meta.get("autonomy_mode"),
    }


def rpc_task_create(params):
    imk = _require_imk()
    task_id = task_engine.new_task_id()
    autonomy_mode = params["autonomy_mode"]
    target_dir = params["target_dir"]

    meta = {
        "format_version": 1,
        "task_id": task_id,
        "description": params["description"],
        "target_dir": target_dir,
        "autonomy_mode": autonomy_mode,
        "engine": params.get("engine", "cli"),
        "status": task_engine.STATUS_QUEUED,
        "worktree_path": None,
        "worktree_branch": None,
        "baseline_commit": None,
        "session_id": None,
        "pending_followup_prompt": task_engine.DEFAULT_FOLLOWUP_PROMPT,
        "last_checkpoint_summary": None,
        "blocked_at": None,
        "error_summary": None,
    }

    if autonomy_mode in task_engine.USES_WORKTREE:
        worktree_path = task_store.task_dir(_data_dir, task_id) / "worktree"
        branch_name = f"task/{task_id}"
        try:
            task_engine.create_worktree(target_dir, worktree_path, branch_name)
        except task_engine.TaskEngineError as exc:
            return {"ok": False, "error": str(exc)}
        meta["worktree_path"] = str(worktree_path)
        meta["worktree_branch"] = branch_name
    else:
        meta["baseline_commit"] = task_engine.record_baseline(target_dir)

    task_store.save_meta(_data_dir, task_id, meta, imk)
    _maybe_start_next_task(imk)
    return {"ok": True, "task_id": task_id}


def _maybe_start_next_task(imk: bytes) -> None:
    """The single-RUNNING gate AND the only place that starts a task. Every
    caller in this file - task_create, task_resume, task_retry,
    task_answer_prompt, and the unlock-time auto-retry in Task 17 - does
    nothing more than flip a task's status to QUEUED and then call this
    same choke point. That's deliberate: whether a restart should resume
    (--resume + pending_followup_prompt) or start fresh (original
    description) is derived entirely from the task's own persisted state
    inside _start_task (see its docstring), never from which caller
    happened to invoke it. An earlier version of this plan threaded an
    explicit resume=True/False parameter through a second, resume-specific
    entry point (_maybe_start_next_task_with_resume) - a plan review round
    caught that this silently broke for every caller except the one that
    remembered to use the resume-aware entry point (most importantly:
    Task 17's unlock-time auto-retry always went through the plain,
    non-resume-aware path, discarding log history and starting a brand
    new session instead of resuming). Do not reintroduce a second entry
    point - every restart path must go through this exact function."""
    global _RUNNING_TASK_ID, _RUNNING_ENGINE
    if _RUNNING_TASK_ID is not None:
        return

    for task_id in task_store.list_task_ids(_data_dir):
        meta = task_store.load_meta(_data_dir, task_id, imk)
        if meta["status"] != task_engine.STATUS_QUEUED:
            continue
        _start_task(task_id, meta, imk)
        return


def _start_task(task_id: str, meta: dict, imk: bytes) -> None:
    """Whether this is a fresh run or a resume is derived from meta itself,
    not from a caller-supplied flag (see _maybe_start_next_task's
    docstring for why): a task only ever gets a non-null session_id once
    its first claude subprocess has actually started responding (see
    _finish_task's QUOTA_BLOCKED branch), so 'session_id is set' is exactly
    'this task has run before and can be resumed'. task_retry explicitly
    clears session_id back to None specifically to force a fresh session
    instead of resuming a possibly-corrupted one - that flows through this
    same rule with no special-casing needed."""
    resume = meta.get("session_id") is not None
    global _RUNNING_TASK_ID, _RUNNING_ENGINE
    _RUNNING_TASK_ID = task_id
    meta["status"] = task_engine.STATUS_RUNNING
    task_store.save_meta(_data_dir, task_id, meta, imk)
    _write_task_event(task_id, {"status": task_engine.STATUS_RUNNING, "new_events": []})

    cwd = meta["worktree_path"] or meta["target_dir"]
    # graded_auto = 不传 --dangerously-skip-permissions，别的都不用做 -
    # Task 0 实测确认这样risky 操作会被自动拒绝而不是把进程挂起（见
    # TaskEngine.spawn 旁边的说明）。
    skip_permissions = meta["autonomy_mode"] != task_engine.MODE_GRADED_AUTO
    engine = task_engine.TaskEngine()
    _RUNNING_ENGINE = engine
    # 无条件把已持久化的日志读回内存再继续追加（没有历史时 load_log_events
    # 本来就返回 []，行为自然兼容全新任务）。"要不要 --resume 同一个
    # claude session"（上面的 resume 变量）和"要不要保留磁盘上的历史日志"
    # 是两件不相关的事，不能用同一个条件——Task 9 实现时发现写成
    # `if resume else []` 会导致 task_retry（resume=False，因为 FAILED
    # 任务从没设置过 session_id）把上一次失败的完整日志静默清空，跟设计里
    # "FAILED 时保留完整日志供事后审阅"直接矛盾。
    _TASK_LOG_BUFFERS[task_id] = task_store.load_log_events(_data_dir, task_id, imk)

    def on_event(event: dict):
        # 每个事件都整体重写一次加密日志（task_store.save_log_events 是
        # 全量覆盖，不是追加）——对个人工具场景下的任务日志体量（几十到
        # 几百个事件）来说，AES-256-GCM 的吞吐量下这仍然是毫秒级操作，
        # 累计成本可接受；如果之后出现单任务动辄上千事件的场景导致明显
        # 卡顿，再改成"每 N 个事件或每 T 秒 flush 一次"的批量写入，不在
        # 这次范围内。
        _TASK_LOG_BUFFERS[task_id].append(event)
        task_store.save_log_events(_data_dir, task_id, _TASK_LOG_BUFFERS[task_id], imk)
        _write_task_event(task_id, {"status": task_engine.STATUS_RUNNING, "new_events": [event]})

        outcome = task_engine.classify_event(event)
        if outcome.kind == "done":
            _finish_task(task_id, imk, task_engine.STATUS_DONE_PENDING_REVIEW, summary=outcome.summary)
        elif outcome.kind == "quota_blocked":
            _finish_task(
                task_id, imk, task_engine.STATUS_QUOTA_BLOCKED,
                summary=outcome.summary, session_id=outcome.session_id,
            )
        elif outcome.kind == "failed":
            _finish_task(task_id, imk, task_engine.STATUS_FAILED, summary=outcome.summary)

    prompt = meta["pending_followup_prompt"] if resume else meta["description"]
    session_id = meta["session_id"] if resume else None
    engine.spawn(
        prompt=prompt,
        cwd=cwd,
        on_event=on_event,
        resume_session_id=session_id,
        skip_permissions=skip_permissions,
    )


def _finish_task(task_id: str, imk: bytes, status: str, *, summary=None, session_id=None) -> None:
    global _RUNNING_TASK_ID, _RUNNING_ENGINE
    meta = task_store.load_meta(_data_dir, task_id, imk)
    meta["status"] = status
    if status == task_engine.STATUS_QUOTA_BLOCKED:
        meta["session_id"] = session_id
        meta["last_checkpoint_summary"] = summary
        meta["blocked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    elif status == task_engine.STATUS_FAILED:
        meta["error_summary"] = summary
    task_store.save_meta(_data_dir, task_id, meta, imk)
    _write_task_event(task_id, {"status": status})

    _RUNNING_TASK_ID = None
    _RUNNING_ENGINE = None
    _maybe_start_next_task(imk)


def rpc_task_list(params):
    imk = _require_imk()
    tasks = []
    for task_id in task_store.list_task_ids(_data_dir):
        meta = task_store.load_meta(_data_dir, task_id, imk)
        tasks.append(_task_summary(meta, task_id))
    return {"tasks": tasks}


def rpc_task_cancel(params):
    imk = _require_imk()
    task_id = params["task_id"]
    meta = task_store.load_meta(_data_dir, task_id, imk)
    if meta["status"] != task_engine.STATUS_QUEUED:
        return {"ok": False, "error": "只能取消排队中的任务"}
    if meta["autonomy_mode"] in task_engine.USES_WORKTREE and meta["worktree_path"]:
        task_engine.discard_worktree(meta["target_dir"], meta["worktree_path"], meta["worktree_branch"])
    task_store.delete_task_data(_data_dir, task_id)
    return {"ok": True}
```

`import time` 和 `import subprocess` 需要加到文件顶部（`subprocess` 目前只在测试文件用，`time` 是新增）。

- [ ] **Step 4: 注册到 `_METHODS`**

```python
_METHODS: Dict[str, Callable] = {
    # ...既有条目...
    "task_create": rpc_task_create,
    "task_list": rpc_task_list,
    "task_cancel": rpc_task_cancel,
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k "task_create or task_cancel"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Add task_create/task_list/task_cancel RPCs with single-RUNNING gate"
```

---

### Task 9: `backend_server.py` — 剩余 7 个 RPC（`task_get_log`/`task_answer_prompt`/`task_resume`/`task_retry`/`task_review_diff`/`task_merge`/`task_discard`）

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`（追加）

- [ ] **Step 1: 写失败测试**（用 Task 5 的 `fake_claude.py` 走完整 QUOTA_BLOCKED → task_resume → done 的路径，和 DONE_PENDING_REVIEW → task_merge / task_discard 路径。`BackendClient` 跳过 `task_event` 行的修补已经在 Task 8 做过了，这里只需要再加一个 `env` 参数，让不同测试能各自切换到假 CLI——环境变量要通过 `subprocess.Popen(..., env=...)` 传给子进程，不能用 `monkeypatch`，因为 `BackendClient` 跑的是独立子进程）

```python
class BackendClient:
    def __init__(self, data_dir: Path, env: dict = None):
        proc_env = {**__import__("os").environ, **(env or {})}
        self.proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", str(BACKEND_SCRIPT), "--data-dir", str(data_dir)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", cwd=str(PROJECT_ROOT), env=proc_env,
        )
        self._next_id = 0
    # call() 已经在 Task 8 加了 task_event 跳过逻辑，这里不用再改
```

同时把 `client` fixture 换成一个工厂 fixture，让新测试能传 `env`：

```python
@pytest.fixture
def client_factory(tmp_path):
    created = []

    def _make(env: dict = None):
        c = BackendClient(tmp_path / "data", env=env)
        created.append(c)
        return c

    yield _make
    for c in created:
        c.close()
```

`fake_claude.py` 的路径要编码成 JSON 数组，不是空格拼接的字符串——Task 6 实现时发现 `shlex.split()` 在 Windows 路径上把反斜杠当转义符处理，会把 `sys.executable`（`C:\Python\...` 这类）拆坏，`task_engine._resolve_claude_command()` 因此改成读 JSON：

```python
import json

FAKE_CLAUDE_ENV = {
    "IDEAL1_CLAUDE_EXECUTABLE": json.dumps(
        [sys.executable, str(PROJECT_ROOT / "modules/file_vault/tests/fixtures/fake_claude.py")]
    )
}


def test_quota_blocked_then_resume_completes(client_factory, tmp_path):
    # client_factory：把 fixture `client` 改造成工厂函数，允许传 env
    client = client_factory(env=FAKE_CLAUDE_ENV)
    _setup_and_unlock(client)
    repo = _make_git_repo(tmp_path)

    result, _, _ = client.call(
        "task_create",
        {"target_dir": str(repo), "description": "TRIGGER_QUOTA then help", "autonomy_mode": "direct_full_auto", "engine": "cli"},
    )
    task_id = result["task_id"]

    # 轮询直到状态变成 QUOTA_BLOCKED（fake_claude 立刻退出，几乎不用等）
    for _ in range(50):
        result, _, _ = client.call("task_list", {})
        status = next(t["status"] for t in result["tasks"] if t["task_id"] == task_id)
        if status == "QUOTA_BLOCKED":
            break
        time.sleep(0.1)
    assert status == "QUOTA_BLOCKED"

    result, _, error = client.call("task_resume", {"task_id": task_id})
    assert error is None
    assert result["ok"] is True

    for _ in range(50):
        result, _, _ = client.call("task_list", {})
        status = next(t["status"] for t in result["tasks"] if t["task_id"] == task_id)
        if status == "DONE_PENDING_REVIEW":
            break
        time.sleep(0.1)
    assert status == "DONE_PENDING_REVIEW"


def test_done_pending_review_then_discard(client_factory, tmp_path):
    # 类似上面，用不带 TRIGGER_ 前缀的 prompt 直接走到 DONE_PENDING_REVIEW，
    # 再调 task_discard，断言 worktree 被清理、meta 状态变 DISCARDED。


def test_failed_task_can_be_retried(client_factory, tmp_path):
    # 用 TRIGGER_FAIL，断言进 FAILED，worktree 不清理；调 task_retry，
    # 断言重新进 QUEUED/RUNNING（复用同一个 fake_claude，把 prompt 换成不
    # 触发 TRIGGER_ 的版本不现实，因为 task_retry 不改 description——这里
    # 直接断言"确实重新起了一个子进程"而不强求它这次会成功）。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k "quota_blocked or pending_review or retried"`
Expected: FAIL

- [ ] **Step 3: 实现**（追加到 `backend_server.py`）

```python
def rpc_task_get_log(params):
    imk = _require_imk()
    task_id = params["task_id"]
    offset = params.get("offset", 0)
    events = task_store.load_log_events(_data_dir, task_id, imk)
    return {"events": events[offset:], "next_offset": len(events)}


def rpc_task_answer_prompt(params):
    imk = _require_imk()
    task_id = params["task_id"]
    meta = task_store.load_meta(_data_dir, task_id, imk)
    if meta["status"] != task_engine.STATUS_WAITING_INPUT:
        return {"ok": False, "error": "该任务当前不在等待你输入"}
    meta["status"] = task_engine.STATUS_QUEUED
    meta["pending_followup_prompt"] = params["answer"]
    task_store.save_meta(_data_dir, task_id, meta, imk)
    # 不直接 spawn 这个 task_id - 统一走 _maybe_start_next_task，它会遵守
    # 单任务并发门禁（可能有别的任务正在跑，这个只是排到 QUEUED 队尾）,
    # 且是否续跑（--resume + pending_followup_prompt）由 _start_task 根据
    # meta 里 session_id 是否存在自动判断，不需要在这里指定。
    _maybe_start_next_task(imk)
    return {"ok": True}


def rpc_task_resume(params):
    imk = _require_imk()
    task_id = params["task_id"]
    meta = task_store.load_meta(_data_dir, task_id, imk)
    if meta["status"] != task_engine.STATUS_QUOTA_BLOCKED:
        return {"ok": False, "error": "该任务当前不是额度耗尽状态"}
    meta["status"] = task_engine.STATUS_QUEUED
    task_store.save_meta(_data_dir, task_id, meta, imk)
    _maybe_start_next_task(imk)
    return {"ok": True}


def rpc_task_retry(params):
    imk = _require_imk()
    task_id = params["task_id"]
    meta = task_store.load_meta(_data_dir, task_id, imk)
    if meta["status"] != task_engine.STATUS_FAILED:
        return {"ok": False, "error": "该任务当前不是失败状态"}
    meta["status"] = task_engine.STATUS_QUEUED
    meta["session_id"] = None  # 全新会话，不复用可能已损坏的 session - 这也是
    # _start_task 判断"是否续跑"的唯一依据：清空 session_id 后它会自动走
    # 全新 prompt（原始 description）而不是 pending_followup_prompt，不需要
    # 在这里额外传参区分。
    task_store.save_meta(_data_dir, task_id, meta, imk)
    _maybe_start_next_task(imk)
    return {"ok": True}


def rpc_task_review_diff(params):
    imk = _require_imk()
    meta = task_store.load_meta(_data_dir, params["task_id"], imk)
    diff = task_engine.diff_summary(
        meta["worktree_path"] or meta["target_dir"], baseline=meta.get("baseline_commit")
    )
    untracked = []
    if not meta["worktree_path"]:
        untracked = task_engine.list_untracked_files(meta["target_dir"])
    return {"diff": diff, "untracked_files": untracked}


def rpc_task_merge(params):
    imk = _require_imk()
    task_id = params["task_id"]
    meta = task_store.load_meta(_data_dir, task_id, imk)
    if not meta["worktree_path"]:
        return {"ok": False, "error": "直接原目录模式没有需要合并的独立分支，改动已经在你的工作区里"}
    result = subprocess.run(
        ["git", "merge", meta["worktree_branch"]], cwd=meta["target_dir"], capture_output=True, text=True
    )
    if result.returncode != 0:
        return {"ok": False, "error": f"合并失败: {result.stderr.strip()}"}
    task_engine.discard_worktree(meta["target_dir"], meta["worktree_path"], meta["worktree_branch"])
    meta["status"] = task_engine.STATUS_MERGED
    task_store.save_meta(_data_dir, task_id, meta, imk)
    return {"ok": True}


def rpc_task_discard(params):
    imk = _require_imk()
    task_id = params["task_id"]
    meta = task_store.load_meta(_data_dir, task_id, imk)
    if meta["worktree_path"]:
        task_engine.discard_worktree(meta["target_dir"], meta["worktree_path"], meta["worktree_branch"])
    elif meta.get("baseline_commit"):
        task_engine.revert_direct_changes(meta["target_dir"], meta["baseline_commit"])
    meta["status"] = task_engine.STATUS_DISCARDED
    task_store.save_meta(_data_dir, task_id, meta, imk)
    return {"ok": True}
```

`_start_task` 内部根据 `meta["session_id"]` 是否为 `None` 自动判断续跑与否（日志续跑读回历史）已经在 Task 8 里写完了。`rpc_task_resume`/`rpc_task_answer_prompt`/`rpc_task_retry` 都只需要把状态改成 `QUEUED`（`task_retry` 额外清一下 `session_id`）然后调用统一入口 `_maybe_start_next_task(imk)`，不需要、也不应该再有第二个"续跑专用"的入口函数——Task 8 的 `_maybe_start_next_task` 文档字符串里记录了为什么（早期版本有一个单独的 resume 入口，结果 Task 17 的解锁自检那条最重要的路径忘了走它，日志和 session 照样被吃掉，是一次计划评审才抓出来的真实 bug）。

`rpc_task_answer_prompt`/`WAITING_INPUT`：Task 0 调研已确认"没有真正的运行中暂停"机制，`WAITING_INPUT` 在当前版本里基本不会被触发（分级自动模式下风险操作是"自动拒绝、任务照常跑完"，不是"暂停等你批"）。保留 `WAITING_INPUT` 状态本身和 `rpc_task_answer_prompt` RPC 不删——`WAITING_INPUT` 相关 UI（Task 13）标注为"预留，当前版本内几乎不会触发"。

**如果调研结论相反（真的存在运行中暂停机制），补 `WAITING_INPUT` 分支时务必复制 `_finish_task` 的 `QUOTA_BLOCKED` 分支那个模式**：转 `WAITING_INPUT` 的那一刻必须同步把 `meta["session_id"] = session_id` 写进去，跟 `QUOTA_BLOCKED` 分支一模一样——`task_answer_prompt` 之后能不能正确 `--resume`、日志会不会被静默清空，完全靠这个字段驱动（`_start_task` 的 `resume` 判断只认 `session_id` 是否为 `None`，不认状态名）。这正是本计划 Task 8/9/17 那一轮返工在修的同一类 bug，`WAITING_INPUT` 分支如果补漏这一行会原样重现一次。

- [ ] **Step 4: 注册新方法到 `_METHODS`**

```python
_METHODS: Dict[str, Callable] = {
    # ...
    "task_get_log": rpc_task_get_log,
    "task_answer_prompt": rpc_task_answer_prompt,
    "task_resume": rpc_task_resume,
    "task_retry": rpc_task_retry,
    "task_review_diff": rpc_task_review_diff,
    "task_merge": rpc_task_merge,
    "task_discard": rpc_task_discard,
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v`
Expected: PASS（全部，含既有的密码/加解密测试没有回归）

- [ ] **Step 6: 跑全量 Python 测试套件确认没有破坏既有功能**

Run: `python -m pytest modules/file_vault/tests/ -v`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Add remaining 7 task RPCs: log/answer/resume/retry/diff/merge/discard"
```

---

## Phase 2：UI

### Task 10: `ipcTypes.ts` — 新增类型

**Files:**
- Modify: `modules/file_vault/ui/src/shared/ipcTypes.ts`

- [ ] **Step 1: 追加类型定义**

```typescript
export type TaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'QUOTA_BLOCKED'
  | 'DONE_PENDING_REVIEW'
  | 'FAILED'
  | 'MERGED'
  | 'DISCARDED'

export type AutonomyMode = 'isolated_full_auto' | 'direct_full_auto' | 'graded_auto'

export interface TaskSummary {
  task_id: string
  description: string
  target_dir: string
  status: TaskStatus
  autonomy_mode: AutonomyMode
}

export interface TaskLogEvent {
  type: string
  [key: string]: unknown
}

export interface TaskEventPayload {
  task_id: string
  status?: TaskStatus
  new_events?: TaskLogEvent[]
}

// 追加到 VaultMethods interface 内部：
//   task_create: { params: {...}; result: {...} }
//   ...等 10 个方法，逐一对应 backend_server.py 的 rpc_task_* 签名
```

- [ ] **Step 2: 在 `VaultMethods` interface 里插入 10 个方法条目**（紧跟 `send_test_email` 之后）

```typescript
  task_create: {
    params: { target_dir: string; description: string; autonomy_mode: AutonomyMode; engine: 'cli' | 'vscode' }
    result: { ok: true; task_id: string } | { ok: false; error: string }
  }
  task_list: { params: Record<string, never>; result: { tasks: TaskSummary[] } }
  task_cancel: { params: { task_id: string }; result: { ok: true } | { ok: false; error: string } }
  task_get_log: {
    params: { task_id: string; offset?: number }
    result: { events: TaskLogEvent[]; next_offset: number }
  }
  task_answer_prompt: { params: { task_id: string; answer: string }; result: { ok: true } | { ok: false; error: string } }
  task_resume: { params: { task_id: string }; result: { ok: true } | { ok: false; error: string } }
  task_retry: { params: { task_id: string }; result: { ok: true } | { ok: false; error: string } }
  task_review_diff: { params: { task_id: string }; result: { diff: string; untracked_files: string[] } }
  task_merge: { params: { task_id: string }; result: { ok: true } | { ok: false; error: string } }
  task_discard: { params: { task_id: string }; result: { ok: true } | { ok: false; error: string } }
```

- [ ] **Step 3: Commit**

```bash
git add modules/file_vault/ui/src/shared/ipcTypes.ts
git commit -m "Add TypeScript types for the 10 auto-task RPCs"
```

---

### Task 11: 协议扩展落到 Electron 侧 — `pythonBridge.ts`/`preload.ts`/`main.ts`

**Files:**
- Modify: `modules/file_vault/ui/electron/pythonBridge.ts`
- Modify: `modules/file_vault/ui/electron/preload.ts`
- Modify: `modules/file_vault/ui/electron/main.ts`
- Modify: `modules/file_vault/ui/src/shared/window.d.ts`（见 Step 4；`lib/vaultApi.ts` 本身是 `export const vaultApi = window.vaultAPI` 的薄封装，不需要改动）

- [ ] **Step 1: `pythonBridge.ts` 新增 task_event 转发**

```typescript
// 顶部新增
import type { TaskEventPayload, ... } from '../src/shared/ipcTypes'

export class PythonBridge {
  // ...既有字段...
  private taskEventListeners: ((payload: TaskEventPayload) => void)[] = []

  onTaskEvent(listener: (payload: TaskEventPayload) => void): () => void {
    this.taskEventListeners.push(listener)
    return () => {
      this.taskEventListeners = this.taskEventListeners.filter((l) => l !== listener)
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: {
      id?: number
      result?: unknown
      error?: { message: string }
      progress?: ProgressEvent
      task_event?: TaskEventPayload
    }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      console.error('[python] failed to parse line:', trimmed)
      return
    }

    if (msg.task_event) {
      for (const listener of this.taskEventListeners) listener(msg.task_event)
      return
    }

    const entry = this.pending.get(msg.id!)
    if (!entry) return
    // ...其余不变...
  }
}
```

- [ ] **Step 2: `main.ts` 转发到渲染进程**

```typescript
// createWindow() 里，紧跟现有 bridge = new PythonBridge(...) 之后
bridge.onTaskEvent((payload) => {
  win?.webContents.send('vault:taskEvent', payload)
})
```

- [ ] **Step 3: `preload.ts` 暴露订阅接口**

```typescript
contextBridge.exposeInMainWorld('vaultAPI', {
  call: /* 不变 */,
  onProgress: /* 不变 */,
  onTaskEvent: (callback: (payload: TaskEventPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TaskEventPayload) => callback(payload)
    ipcRenderer.on('vault:taskEvent', listener)
    return () => ipcRenderer.off('vault:taskEvent', listener)
  },
})
```

- [ ] **Step 4: `window.d.ts` 更新 `vaultAPI` 类型**（`modules/file_vault/ui/src/shared/window.d.ts`，加一行 `onTaskEvent: (callback: (payload: TaskEventPayload) => void) => () => void`）

- [ ] **Step 5: 手动验证类型检查通过**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无报错

- [ ] **Step 6: Commit**

```bash
git add modules/file_vault/ui/electron modules/file_vault/ui/src/shared/window.d.ts
git commit -m "Wire unsolicited task_event protocol messages through Electron main/preload"
```

---

### Task 12: `TaskListScreen.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/components/TaskListScreen.tsx`

参照 `PasswordScreen.tsx` 的整体结构（`w-[680px]` 卡片 + 列表 + 弹窗）。

- [ ] **Step 1: 实现**

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { vaultApi } from '@/lib/vaultApi'
import { electronApi } from '@/lib/electronApi'
import type { AutonomyMode, TaskStatus, TaskSummary } from '@/shared/ipcTypes'

const STATUS_LABEL: Record<TaskStatus, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  WAITING_INPUT: '等待你确认',
  QUOTA_BLOCKED: '额度耗尽',
  DONE_PENDING_REVIEW: '待审阅',
  FAILED: '失败',
  MERGED: '已合并',
  DISCARDED: '已丢弃',
}

export function TaskListScreen({ onBack, onOpenTask }: { onBack: () => void; onOpenTask: (taskId: string) => void }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [createOpen, setCreateOpen] = useState(false)

  async function reload() {
    const res = await vaultApi.call('task_list', {})
    setTasks(res.tasks)
  }

  useEffect(() => {
    reload()
    const unsubscribe = vaultApi.onTaskEvent(() => reload())
    const interval = setInterval(reload, 5000)
    return () => {
      unsubscribe()
      clearInterval(interval)
    }
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-10">
      <Card className="w-[680px]">
        <CardHeader>
          <CardTitle className="text-2xl">自动任务</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button className="w-full" onClick={() => setCreateOpen(true)}>
            新建任务
          </Button>
          <div className="max-h-[420px] space-y-2 overflow-y-auto">
            {tasks.length === 0 && <p className="text-sm text-muted-foreground">还没有任务</p>}
            {tasks.map((t) => (
              <button
                key={t.task_id}
                className="flex w-full items-center justify-between gap-2 rounded border p-2 text-left hover:bg-accent"
                onClick={() => onOpenTask(t.task_id)}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.description}</p>
                  <p className="truncate text-xs text-muted-foreground">{t.target_dir}</p>
                </div>
                <span className="shrink-0 rounded bg-muted px-2 py-1 text-xs">{STATUS_LABEL[t.status]}</span>
              </button>
            ))}
          </div>
          <Button className="w-full" variant="outline" onClick={onBack}>
            返回
          </Button>
        </CardContent>
      </Card>

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async () => {
          setCreateOpen(false)
          await reload()
        }}
      />
    </div>
  )
}

function CreateTaskDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: () => void
}) {
  const [targetDir, setTargetDir] = useState('')
  const [description, setDescription] = useState('')
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>('isolated_full_auto')
  const [engine, setEngine] = useState<'cli' | 'vscode'>('cli')
  const [error, setError] = useState('')

  async function pickDir() {
    const dir = await electronApi.openDirectory({ title: '选择目标项目目录' })
    if (dir) setTargetDir(dir)
  }

  async function handleCreate() {
    if (!targetDir || !description.trim()) {
      setError('目标目录和任务描述不能为空')
      return
    }
    if (engine === 'vscode') {
      toast.info('VS Code 手动接管模式暂未实现自动打开，请自行在 VS Code 中打开该目录')
    }
    const res = await vaultApi.call('task_create', {
      target_dir: targetDir,
      description,
      autonomy_mode: autonomyMode,
      engine,
    })
    if (!res.ok) {
      setError(res.error)
      return
    }
    setTargetDir('')
    setDescription('')
    setError('')
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>目标目录</Label>
            <div className="flex gap-2">
              <Input value={targetDir} readOnly placeholder="点击右侧选择" />
              <Button variant="outline" onClick={pickDir}>
                选择...
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-desc">任务描述</Label>
            <Input id="task-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>自主执行边界</Label>
            <Tabs value={autonomyMode} onValueChange={(v) => setAutonomyMode(v as AutonomyMode)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="isolated_full_auto">隔离全自动</TabsTrigger>
                <TabsTrigger value="direct_full_auto">原目录全自动</TabsTrigger>
                <TabsTrigger value="graded_auto">分级自动</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="space-y-2">
            <Label>执行引擎</Label>
            <Tabs value={engine} onValueChange={(v) => setEngine(v as 'cli' | 'vscode')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="cli">Claude Code CLI（全自动）</TabsTrigger>
                <TabsTrigger value="vscode">VS Code 插件（手动接管）</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={handleCreate}>
            创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add modules/file_vault/ui/src/components/TaskListScreen.tsx
git commit -m "Add TaskListScreen with task creation dialog"
```

---

### Task 13: `TaskDetailScreen.tsx`

**Files:**
- Create: `modules/file_vault/ui/src/components/TaskDetailScreen.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { vaultApi } from '@/lib/vaultApi'
import type { TaskLogEvent, TaskStatus, TaskSummary } from '@/shared/ipcTypes'

function eventToLine(e: TaskLogEvent): string {
  if (e.type === 'assistant') {
    const content = (e as any).message?.content ?? []
    const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    return text ? `[assistant] ${text}` : `[assistant] (工具调用)`
  }
  if (e.type === 'result') return `[result] ${(e as any).result ?? ''}`
  return `[${e.type}] ${JSON.stringify(e)}`
}

export function TaskDetailScreen({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [answer, setAnswer] = useState('')
  const [diff, setDiff] = useState<string | null>(null)
  const offsetRef = useRef(0)
  const logEndRef = useRef<HTMLDivElement>(null)

  async function reload() {
    const list = await vaultApi.call('task_list', {})
    const summary = list.tasks.find((t: TaskSummary) => t.task_id === taskId)
    if (summary) setStatus(summary.status)

    const log = await vaultApi.call('task_get_log', { task_id: taskId, offset: offsetRef.current })
    if (log.events.length > 0) {
      setLines((prev) => [...prev, ...log.events.map(eventToLine)])
      offsetRef.current = log.next_offset
    }
    if (summary && summary.status === 'DONE_PENDING_REVIEW') {
      const d = await vaultApi.call('task_review_diff', { task_id: taskId })
      setDiff(d.diff)
    }
  }

  useEffect(() => {
    offsetRef.current = 0
    setLines([])
    reload()
    const unsubscribe = vaultApi.onTaskEvent((p) => {
      if (p.task_id === taskId) reload()
    })
    const interval = setInterval(reload, 3000)
    return () => {
      unsubscribe()
      clearInterval(interval)
    }
  }, [taskId])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  async function submitAnswer() {
    const res = await vaultApi.call('task_answer_prompt', { task_id: taskId, answer })
    if (!res.ok) {
      toast.error('提交失败', { description: res.error })
      return
    }
    setAnswer('')
  }

  async function resumeNow() {
    const res = await vaultApi.call('task_resume', { task_id: taskId })
    if (!res.ok) toast.error('续跑失败', { description: res.error })
  }

  async function retryNow() {
    const res = await vaultApi.call('task_retry', { task_id: taskId })
    if (!res.ok) toast.error('重试失败', { description: res.error })
  }

  async function merge() {
    const res = await vaultApi.call('task_merge', { task_id: taskId })
    if (!res.ok) {
      toast.error('合并失败', { description: res.error })
      return
    }
    toast.success('已合并')
    onBack()
  }

  async function discard() {
    const res = await vaultApi.call('task_discard', { task_id: taskId })
    if (!res.ok) {
      toast.error('丢弃失败', { description: res.error })
      return
    }
    toast.success('已丢弃')
    onBack()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-10">
      <Card className="w-[680px]">
        <CardHeader>
          <CardTitle className="text-xl">任务详情 {status ? `（${status}）` : ''}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-[320px] overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-xs">
            {lines.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap break-words">
                {l}
              </p>
            ))}
            <div ref={logEndRef} />
          </div>

          {status === 'WAITING_INPUT' && (
            <div className="flex gap-2">
              <Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="回答 Claude Code 的问题..." />
              <Button onClick={submitAnswer}>提交</Button>
            </div>
          )}

          {status === 'QUOTA_BLOCKED' && (
            <div className="flex items-center justify-between rounded border p-2 text-sm">
              <span>额度已耗尽，等待自动探测恢复</span>
              <Button size="sm" onClick={resumeNow}>
                立即重试
              </Button>
            </div>
          )}

          {status === 'FAILED' && (
            <div className="flex items-center justify-between rounded border p-2 text-sm">
              <span>任务失败</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={retryNow}>
                  重试
                </Button>
                <Button size="sm" variant="destructive" onClick={discard}>
                  丢弃
                </Button>
              </div>
            </div>
          )}

          {status === 'DONE_PENDING_REVIEW' && (
            <div className="space-y-2">
              <pre className="max-h-[200px] overflow-y-auto rounded border bg-muted/30 p-2 text-xs">{diff}</pre>
              <div className="flex gap-2">
                <Button className="flex-1" onClick={merge}>
                  合并到主分支
                </Button>
                <Button className="flex-1" variant="destructive" onClick={discard}>
                  丢弃
                </Button>
              </div>
            </div>
          )}

          <Button className="w-full" variant="outline" onClick={onBack}>
            返回
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add modules/file_vault/ui/src/components/TaskDetailScreen.tsx
git commit -m "Add TaskDetailScreen with live log, prompt answer, and review/merge flow"
```

---

### Task 14: 接入导航 — `MainScreen.tsx` + `App.tsx`

**Files:**
- Modify: `modules/file_vault/ui/src/components/MainScreen.tsx`
- Modify: `modules/file_vault/ui/src/App.tsx`

- [ ] **Step 1: `MainScreen.tsx` 新增入口**（`onOpenTasks` prop，紧跟"密码管理"按钮之后加一个"自动任务"按钮，模式同 `handlePasswords`）

```tsx
export function MainScreen({
  onOpenSettings,
  onOpenPasswords,
  onOpenTasks,
}: {
  onOpenSettings: () => void
  onOpenPasswords: () => void
  onOpenTasks: () => void
}) {
  // ...
  function handleTasks() {
    onOpenTasks()
  }
  // ... JSX 里 "密码管理" 按钮之后加：
  <Button className="w-full" variant="outline" onClick={handleTasks} disabled={showProgress}>
    自动任务
  </Button>
}
```

- [ ] **Step 2: `App.tsx` 新增两个 view**

```tsx
import { TaskListScreen } from '@/components/TaskListScreen'
import { TaskDetailScreen } from '@/components/TaskDetailScreen'

type View = 'loading' | 'setup' | 'login' | 'main' | 'settings' | 'passwords' | 'tasks' | 'taskDetail'

function App() {
  const [view, setView] = useState<View>('loading')
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  // ...

  return (
    <>
      {/* ...既有分支... */}
      {view === 'main' && (
        <MainScreen
          onOpenSettings={() => setView('settings')}
          onOpenPasswords={() => setView('passwords')}
          onOpenTasks={() => setView('tasks')}
        />
      )}
      {view === 'tasks' && (
        <TaskListScreen
          onBack={() => setView('main')}
          onOpenTask={(taskId) => {
            setActiveTaskId(taskId)
            setView('taskDetail')
          }}
        />
      )}
      {view === 'taskDetail' && activeTaskId && (
        <TaskDetailScreen taskId={activeTaskId} onBack={() => setView('tasks')} />
      )}
      <Toaster />
    </>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `cd modules/file_vault/ui && npx tsc --noEmit`
Expected: 无报错

- [ ] **Step 4: Commit**

```bash
git add modules/file_vault/ui/src/components/MainScreen.tsx modules/file_vault/ui/src/App.tsx
git commit -m "Wire TaskListScreen/TaskDetailScreen into app navigation"
```

---

### Task 15: 手动走查（后端全量测试 + 一次真实端到端）

**Files:** 无新文件，验证性任务。

- [ ] **Step 1**: 跑全量 Python 测试

Run: `python -m pytest modules/file_vault/tests/ -v`
Expected: 全部 PASS

- [ ] **Step 2**: 跑一次真实 `npm run dev`，走一遍：登录 → 主界面点"自动任务" → 新建一个隔离 worktree 模式的真实小任务（用一个安全的临时 git 仓库，不要用真实工作项目试第一次）→ 观察日志实时显示 → 收到 `DONE_PENDING_REVIEW` → 点"合并到主分支" → 确认 worktree 清理、改动确实合并进去了。
- [ ] **Step 3**: 记录走查中发现的问题——Task 4 的 `classify_event` 已经按 Task 0 的真实调研结果实现（`terminal_reason`/`api_error_status` 为主判据），这一步主要是确认长任务、真实项目改动等 Task 0 没覆盖到的场景是否符合预期。

---

## Phase 3：额度恢复

### Task 16: `task_watcher.ps1`

**Files:**
- Create: `modules/file_vault/scripts/task_watcher.ps1`

- [ ] **Step 1: 实现**

```powershell
<#
额度恢复探测脚本。独立于任何 Claude Code 交互会话运行，不持有 IMK、不
接触加密数据 - 只做两件事：轻量探测 claude CLI 是否可用，可用时要么直接
调用本地跑着的 file_vault 后端的 task_resume RPC（应用已解锁），要么发一
条系统通知（应用未运行/未解锁，见设计文档"中断/恢复协议"一节）。

用法：
  powershell -File task_watcher.ps1 -IntervalMinutes 30
#>

param(
    [int]$IntervalMinutes = 30,
    [string]$DataDir = "$PSScriptRoot\..\data"
)

function Test-ClaudeAvailable {
    $probe = & claude -p "ping" --output-format json 2>&1
    return $LASTEXITCODE -eq 0
}

function Get-BlockedTaskIds {
    # meta.json.enc 是加密的，这个脚本读不了内容 - 只能列出 tasks/ 下的
    # 子目录名，交给 backend（如果在跑）自己判断哪些是 QUOTA_BLOCKED。
    $tasksDir = Join-Path $DataDir "tasks"
    if (-not (Test-Path $tasksDir)) { return @() }
    return Get-ChildItem $tasksDir -Directory | ForEach-Object { $_.Name }
}

function Test-BackendRunning {
    # file_vault Electron 应用把 backend_server.py 起成子进程，探测 python
    # 进程命令行里是否包含 backend_server.py 作为“应用是否在跑”的信号。
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue
    return $null -ne ($procs | Where-Object { $_.CommandLine -like "*backend_server.py*" })
}

Write-Host "task_watcher 启动，每 $IntervalMinutes 分钟探测一次。"

while ($true) {
    if (Test-ClaudeAvailable) {
        if (Test-BackendRunning) {
            Write-Host "$(Get-Date -Format o) 额度探测成功，且应用正在运行 - 续跑交给应用自身的解锁自检/后续手动重试完成（本脚本不直接调用 RPC，见设计文档）。"
        } else {
            Write-Host "$(Get-Date -Format o) 额度探测成功，但应用未运行 - 发送系统通知。"
            New-BurntToastNotification -Text "Ideal1 自动任务", "Claude Code 额度已恢复，打开并解锁 file_vault 以自动续跑等待中的任务。" -ErrorAction SilentlyContinue
            if (-not (Get-Module -ListAvailable -Name BurntToast)) {
                [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
                [System.Windows.Forms.MessageBox]::Show("Claude Code 额度已恢复，请打开并解锁 file_vault。", "Ideal1 自动任务") | Out-Null
            }
        }
    } else {
        Write-Host "$(Get-Date -Format o) 额度仍未恢复。"
    }
    Start-Sleep -Seconds ($IntervalMinutes * 60)
}
```

**关于"应用运行中直接调 RPC"没有实现**：`task_watcher.ps1` 是独立 PowerShell 进程，没有现成的方式直接对 `backend_server.py`（走 stdin/stdout NDJSON，只跟 Electron 主进程的一个句柄对话）发 RPC。要做到"应用已解锁时 watcher 直接触发 task_resume"，需要 `main.ts` 额外开一个本地 HTTP/命名管道端点桥接（不在本计划范围内，属于设计文档"范围之外"没覆盖到的一个实现细节缺口）。当前实现退而求其次：应用运行时不用 watcher 主动推，而是**在 Task 17 里让 backend_server.py 自己每次收到任意 RPC 请求时顺手检查一遍 QUOTA_BLOCKED 任务**（见下），加上解锁时的一次批量自检——用户只要在打开的应用里做任何操作（或哪怕什么都不做，靠 Task 17 的定时自检），就能不知不觉触发续跑，不需要 watcher 真的把 RPC 打进去。这比原设计简单，行为上达到同样效果。

- [ ] **Step 2: 手动确认脚本能跑（不需要真的等 30 分钟）**

Run: `powershell -File modules/file_vault/scripts/task_watcher.ps1 -IntervalMinutes 1`（跑起来后 Ctrl+C 手动停掉，确认没有语法错误、`Test-ClaudeAvailable`/`Test-BackendRunning` 各自能返回布尔值不报错）

- [ ] **Step 3: Commit**

```bash
git add modules/file_vault/scripts/task_watcher.ps1
git commit -m "Add task_watcher.ps1 quota-recovery polling script"
```

---

### Task 17: 解锁自检 — 解锁成功后自动重试所有 `QUOTA_BLOCKED` 任务

**Files:**
- Modify: `modules/file_vault/backend_server.py`
- Test: `modules/file_vault/tests/test_backend_server.py`（追加）

- [ ] **Step 1: 写失败测试**

```python
def test_unlock_retries_quota_blocked_tasks(client_factory, tmp_path):
    client = client_factory(env=FAKE_CLAUDE_ENV)
    _setup_and_unlock(client)
    repo = _make_git_repo(tmp_path)
    result, _, _ = client.call(
        "task_create",
        {"target_dir": str(repo), "description": "TRIGGER_QUOTA please", "autonomy_mode": "direct_full_auto", "engine": "cli"},
    )
    task_id = result["task_id"]
    _wait_for_status(client, task_id, "QUOTA_BLOCKED")

    events_before, _, _ = client.call("task_get_log", {"task_id": task_id})
    assert len(events_before["events"]) > 0  # 第一次跑至少留下了几条事件

    # 模拟"应用重启后重新解锁" - 再调一次 unlock_password
    client.call("unlock_password", {"password": "test-password-" + "123"})

    _wait_for_status(client, task_id, "DONE_PENDING_REVIEW")

    events_after, _, _ = client.call("task_get_log", {"task_id": task_id})
    # 这两个断言是本任务真正要防住的 bug：round-2 计划评审发现"解锁自检"
    # 这条路径曾经会静默丢日志、且从不传 --resume（直接重开一个全新
    # session，等于假装在续跑实际是重新开始）。只断言最终状态是
    # DONE_PENDING_REVIEW（之前的写法）两个问题都测不出来。
    assert len(events_after["events"]) > len(events_before["events"])  # 第一次的事件历史还在，不是被清空重写
    assert events_after["events"][: len(events_before["events"])] == events_before["events"]  # 前缀完全一致
    resumed_flags = [e.get("resumed") for e in events_after["events"] if e.get("type") == "system"]
    assert True in resumed_flags  # 第二次子进程确实带了 --resume，不是重开的新会话
```

（`_wait_for_status` 是把 Task 9 测试里重复的轮询逻辑提成的 helper，放在文件顶部；`task_get_log` 的返回值结构是 `{"events": [...], "next_offset": ...}`，这里只用到 `events`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k unlock_retries`
Expected: FAIL（解锁后没有自动续跑，任务停在 QUOTA_BLOCKED）

- [ ] **Step 3: 实现**——在每个 `rpc_unlock_*` 成功路径末尾调用同一个自检函数（`rpc_unlock_password`/`rpc_unlock_totp`/`rpc_unlock_recovery`/`rpc_unlock_email_finish`/`rpc_unlock_fingerprint` 五处都要加）

```python
def _retry_all_quota_blocked_tasks(imk: bytes) -> None:
    """Called right after any successful unlock. At most one of these will
    actually spawn (the single-RUNNING gate in _maybe_start_next_task
    handles the rest by leaving them QUEUED) - see design doc's
    '解锁自检' behavior."""
    for task_id in task_store.list_task_ids(_data_dir):
        meta = task_store.load_meta(_data_dir, task_id, imk)
        if meta["status"] == task_engine.STATUS_QUOTA_BLOCKED:
            meta["status"] = task_engine.STATUS_QUEUED
            task_store.save_meta(_data_dir, task_id, meta, imk)
    _maybe_start_next_task(imk)
```

在 `rpc_unlock_password` 末尾（其余四个 unlock 方法同样加）：

```python
def rpc_unlock_password(params):
    global _imk
    store = _require_store()
    try:
        _imk = identity.unlock_via_password(store, params["password"])
        _retry_all_quota_blocked_tasks(_imk)
        return {"ok": True}
    except identity.UnlockError as exc:
        return {"ok": False, "error": str(exc)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest modules/file_vault/tests/test_backend_server.py -v -k unlock_retries`
Expected: PASS

- [ ] **Step 5: 跑全量测试确认没有回归**

Run: `python -m pytest modules/file_vault/tests/ -v`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add modules/file_vault/backend_server.py modules/file_vault/tests/test_backend_server.py
git commit -m "Auto-retry QUOTA_BLOCKED tasks on every successful unlock"
```

---

### Task 18: 最终端到端验证清单（手动，无法自动化）

- [ ] 全新克隆/临时项目上完整走一遍：新建任务（隔离模式）→ 额度未耗尽时正常跑完 → 审阅 diff → 合并。
- [ ] 用一个信息明显不足的任务描述，观察它是走 `WAITING_INPUT`（如果 Task 0 调研证实存在）还是直接在 `result` 里带着问题收敛成 `DONE_PENDING_REVIEW`（如果不存在）——确认 UI 呈现符合实际情况。
- [ ] 用 `direct_full_auto` 模式跑一个任务，确认没有创建 worktree、`git diff` 展示的是相对 baseline 的改动、"丢弃"确实执行了 `git checkout -- .`。
- [ ] 手动模拟 FAILED（给一个必然会报错的任务，比如指向不存在的文件的操作），确认状态正确、worktree 保留、"重试"能重新起一个子进程。
- [ ] 跑 `task_watcher.ps1`，人工制造一次额度耗尽（或者跳过，如果没有低成本的真实触发方式，在 investigation notes 里记录"未做真实额度耗尽验证，逻辑靠 fake_claude 单测覆盖"）。
- [ ] 确认关闭并重新打开应用、重新解锁后，之前的任务列表（含 `QUOTA_BLOCKED`/`FAILED`/`DONE_PENDING_REVIEW` 各状态）都还在，数据没丢。

---

## 已知遗留 / 明确不在本计划范围内

- `task_watcher.ps1` 无法在"应用已解锁运行中"时主动推 RPC（见 Task 16 说明），退而求其次靠"解锁自检 + 任意后续 RPC 调用顺手触发"达到等价效果——如果之后要做到真正的"应用开着、watcher 一探测到就立刻续跑，不需要用户碰应用"，需要额外给 `main.ts` 加一个本地 IPC 端点，这是一个新的子任务，不在这次范围内。
- "分级自动"的真正实现强依赖 Task 0 的调研结论，本计划已经写好了两条分支（真暂停 vs `--disallowedTools` 降级），但没法在写计划这一刻就确定选哪条——执行到 Task 0 时必须先定，回填后续任务。
- VS Code 引擎选项目前只在 UI 弹窗里给一句提示，没有真正"打开 VS Code 并预填简报文件"的实现——设计文档已经标注这是手动接管模式，这次先不做那个便利功能，按钮存在但只提示。
