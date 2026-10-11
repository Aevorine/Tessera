"""批量传输任务的通用后台执行原语，供 backend_server.py 的批量 RPC 复用。"""
from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path
from typing import Callable, Dict, List, Tuple

from modules.file_vault import errors

# dispatch()/serve() 看到这个哨兵值时，不会立即把它当结果写回——
# 真正的结果由 submit_batch_task 内部起的线程稍后自己调用 write() 交付。
ASYNC_DEFERRED = object()

# 信号量限制同时执行的批量任务数，否则大批量每项一个线程、并发无上限。
# 线程仍是立即 start() 的 daemon 线程（不用线程池，免得关窗时被池收尾卡住），
# 只节流 fn() 的并发。
_MAX_CONCURRENT_TASKS = min(32, max(4, (os.cpu_count() or 4) * 2))

# 两档优先级：批量任务最多占 N-1 个槽，永远给交互式留一个。
# 不抢占（写文件的任务不能安全打断）；交互请求最坏只等一个批量项做完。
PRIORITY_INTERACTIVE = "interactive"
PRIORITY_BULK = "bulk"

_gate_lock = threading.Condition()
_running_total = 0
_running_bulk = 0
# 批量任务的上限。至少留 1 个槽给交互式；核数很少时也要保证这条成立。
_MAX_BULK_TASKS = max(1, _MAX_CONCURRENT_TASKS - 1)


def _acquire(priority: str) -> None:
    global _running_total, _running_bulk
    is_bulk = priority == PRIORITY_BULK
    with _gate_lock:
        while True:
            if _running_total < _MAX_CONCURRENT_TASKS and (
                not is_bulk or _running_bulk < _MAX_BULK_TASKS
            ):
                _running_total += 1
                if is_bulk:
                    _running_bulk += 1
                return
            _gate_lock.wait()


def _release(priority: str) -> None:
    global _running_total, _running_bulk
    with _gate_lock:
        _running_total -= 1
        if priority == PRIORITY_BULK:
            _running_bulk -= 1
        # notify_all 而不是 notify：等待队列里混着两种优先级，唤醒一个可能唤到
        # 一个此刻仍然不满足条件的批量任务，而真正能跑的交互式任务继续睡着。
        _gate_lock.notify_all()


def gate_state() -> dict:
    """当前闸门占用情况。给诊断用——"点了没反应"时第一个要问的就是它。"""
    with _gate_lock:
        return {
            "running": _running_total,
            "bulk": _running_bulk,
            "max": _MAX_CONCURRENT_TASKS,
            "maxBulk": _MAX_BULK_TASKS,
        }


def submit_batch_task(
    request_id,
    fn: Callable[[], dict],
    write: Callable[[dict], None],
    priority: str = PRIORITY_BULK,
) -> object:
    """立刻返回 ASYNC_DEFERRED；fn() 在 daemon 线程执行（并发受闸门限制，超限排队），
    结果经 write() 以 NDJSON 终态消息交付。priority 默认 bulk，
    用户正等结果的调用方要传 PRIORITY_INTERACTIVE。"""

    def run() -> None:
        _acquire(priority)
        try:
            result = fn()
        except errors.VaultError as exc:
            message = {"id": request_id, "error": {"message": exc.code}}
        except Exception:
            message = {"id": request_id, "error": {"message": "internal.unexpected"}}
        else:
            message = {"id": request_id, "result": result}
        finally:
            # 放 finally：以后新增 return 分支才不会漏释放，否则闸门会永久少一个槽。
            _release(priority)
        write(message)

    threading.Thread(target=run, daemon=True).start()
    return ASYNC_DEFERRED


def sha256_of_file(path, chunk_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def resolve_batch_output_paths(
    candidates: List[Tuple[str, Path]],
) -> Dict[str, Tuple[Path, bool]]:
    """按顺序解决批内路径冲突，返回 {key: (最终路径, 是否被改名)}。
    按完整路径判冲突，只给 stem 追加 " (2)"、" (3)"…"""
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
