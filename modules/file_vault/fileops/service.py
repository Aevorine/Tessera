"""应用内「文件管理」面板的复制/剪切/粘贴/删除，薄封装 core.fileops.engine / clipboard
（与 file_clip 同源，提升到 core/ 后互不 import）。

不需要保险箱解锁（IMK）：只做通用文件系统操作，不碰加密内容。
与 modules/file_vault/clipboard/（图片/文字历史）无关，本文件只处理 CF_HDROP 文件列表。
"""

import hashlib
import json
import os
import threading
import time
from collections import deque
from typing import Callable, Dict, List, Tuple

from core.fileops import clipboard as file_clipboard
from core.fileops import engine as file_engine
from core.fileops import progress_preferences, progress_ui

# 进度每 100ms 上报一次，既跟手又不刷爆 NDJSON 管道（与 backend_server.py 的 _throttled_progress 0.1s 对齐）。
_POLL_INTERVAL_S = 0.1


class FileClipError(RuntimeError):
    """携带一个 i18n 错误码（跟 errors.json 里 file_clip.* 键对应），
    而不是原始英文异常文本——跟 container.py 里其它给前端看的异常同一套风格。"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def copy_to_clipboard(paths: List[str]) -> None:
    if not paths:
        raise FileClipError("file_clip.no_paths")
    try:
        file_clipboard.set_file_drop(paths, move=False)
    except file_clipboard.ClipboardError as exc:
        raise FileClipError("file_clip.clipboard_busy") from exc


def cut_to_clipboard(paths: List[str]) -> None:
    if not paths:
        raise FileClipError("file_clip.no_paths")
    try:
        file_clipboard.set_file_drop(paths, move=True)
    except file_clipboard.ClipboardError as exc:
        raise FileClipError("file_clip.clipboard_busy") from exc


def read_clipboard_status() -> Dict:
    try:
        got = file_clipboard.get_file_drop()
    except file_clipboard.ClipboardError as exc:
        raise FileClipError("file_clip.clipboard_busy") from exc
    if got is None:
        return {"has_files": False, "paths": [], "is_cut": False}
    paths, is_cut = got
    return {"has_files": True, "paths": paths, "is_cut": is_cut}


def _report_to_dict(report: "file_engine.TransferReport") -> Dict:
    return {
        "ok": report.ok,
        "operation": report.operation,
        "files_total": report.files_total,
        "bytes_total": report.bytes_total,
        "files_done": report.files_done,
        "bytes_done": report.bytes_done,
        "fast_moved_count": len(report.fast_moved),
        "renamed": [{"from": a, "to": b} for a, b in report.renamed],
        "skipped": report.skipped,
        "errors": [{"path": a, "message": b} for a, b in report.errors],
        "elapsed": report.elapsed,
        "cancelled": report.cancelled,
    }


def _run_with_progress(
    fn: Callable[..., "file_engine.TransferReport"],
    on_progress: Callable[[int, int], None],
    **kwargs,
) -> "file_engine.TransferReport":
    """engine.transfer/delete_items 的进度模型是「创建 report 后回调一次，调用方轮询后台线程更新的计数」，
    不是流式回调。这里后台线程跑传输，主线程定期读 report 计数喂给 on_progress（符合
    _throttled_progress(request_id) 契约）。live_progress 固定关闭：stdout 是 NDJSON 管道，不能混入 ANSI 进度条。"""
    state: Dict = {"report": None, "final": None}

    def on_report(report: "file_engine.TransferReport") -> None:
        state["report"] = report

    def run() -> None:
        state["final"] = fn(on_report=on_report, live_progress=False, **kwargs)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    while state["report"] is None:
        time.sleep(0.005)
    report = state["report"]
    smoother = progress_ui.SpeedSmoother()
    running_since = None
    while thread.is_alive():
        snapshot = report.snapshot()
        now = time.perf_counter()
        if snapshot.phase == "running" and running_since is None:
            running_since = now
        speed = smoother.observe(progress_ui._progress_units(snapshot), now)
        eta = progress_ui.progress_eta(
            snapshot, speed, None if running_since is None else now - running_since,
        )
        _emit(on_progress, snapshot, speed, eta)
        time.sleep(_POLL_INTERVAL_S)
    final = state["final"]
    _emit(on_progress, final.snapshot(), 0.0, None, finished=True)
    return final


def _emit(on_progress, snapshot, speed: float, eta, finished: bool = False) -> None:
    """进度帧：done/total 与任务卡同一口径（拷贝按字节，删除/改名按条目），另附明细供界面显示。"""
    done, total = progress_ui.progress_fraction(snapshot)
    if finished:
        done = total
    on_progress(
        done, total,
        phase=snapshot.phase,
        scan_complete=snapshot.scan_complete,
        unit="bytes" if snapshot.operation in ("copy", "move") and snapshot.bytes_total else "items",
        files_done=snapshot.files_done,
        files_total=snapshot.files_total,
        bytes_done=snapshot.bytes_done,
        bytes_total=snapshot.bytes_total,
        speed=speed,
        eta=eta,
        current=os.path.basename(snapshot.current_path) or snapshot.current_path,
    )


def run_paste(dest_dir: str, on_conflict: str, on_progress: Callable[[int, int], None]) -> Dict:
    got = read_clipboard_status()
    if not got["has_files"]:
        raise FileClipError("file_clip.clipboard_empty")
    report = _run_with_progress(
        file_engine.transfer,
        on_progress,
        sources=got["paths"],
        dest_dir=dest_dir,
        move=got["is_cut"],
        on_conflict=on_conflict,
    )
    # 与资源管理器一致：剪切的内容粘贴成功后清空剪贴板，防止误贴第二次
    # （精确复刻 modules/file_clip/cli.py::cmd_paste 的既有行为）。
    if got["is_cut"] and report.ok:
        file_clipboard.clear_clipboard()
    result = _report_to_dict(report)
    _record_operation("paste", result, got["paths"])
    _record_history("paste", got["paths"], result)
    return result


def run_delete(paths: List[str], recycle: bool, on_progress: Callable[[int, int], None]) -> Dict:
    if not paths:
        raise FileClipError("file_clip.no_paths")
    report = _run_with_progress(
        file_engine.delete_items,
        on_progress,
        sources=paths,
        recycle=recycle,
    )
    result = _report_to_dict(report)
    op_name = "delete_recycle" if recycle else "delete_permanent"
    _record_operation(op_name, result, paths)
    _record_history(op_name, paths, result)
    return result


def clear_clipboard() -> None:
    """清空剪贴板上的文件列表（Esc 取消剪切/复制状态用）。"""
    file_clipboard.clear_clipboard()


def check_conflicts(paths: List[str], dest_dir: str, mode: str = 'all') -> List[Dict]:
    """检查目标目录中已存在的文件（冲突检测），不执行粘贴。
    返回冲突项列表（path、size、mtimeMs 等），供前端弹冲突对话框；mode='existing' 只返回目标已存在的，'all' 返回全部源文件元数据。"""
    result = []
    for p in (paths or []):
        name = os.path.basename(p)
        dest = os.path.join(dest_dir, name)
        exists = os.path.lexists(dest)
        src_size = os.path.getsize(p) if os.path.isfile(p) else 0
        dest_size = os.path.getsize(dest) if os.path.isfile(dest) else 0
        entry = {
            "name": name,
            "source_path": p,
            "dest_exists": exists,
            "source_size": src_size,
            "dest_size": dest_size,
        }
        if mode == 'existing' and not exists:
            continue
        result.append(entry)
    return result


# ---- 安全擦除 (E5) ----

def run_secure_erase(paths: List[str], on_progress: Callable[[int, int], None]) -> Dict:
    """安全覆写后删除，不可恢复。"""
    if not paths:
        raise FileClipError("file_clip.no_paths")
    items = [p for p in paths if os.path.lexists(p)]
    total = len(items)
    done = 0
    errors = []
    for p in items:
        try:
            file_engine.secure_erase(p)
        except Exception as exc:
            errors.append({"path": p, "message": str(exc)})
        done += 1
        on_progress(done, total)
    return {"ok": len(errors) == 0, "items_total": total, "items_done": done,
            "errors": errors, "elapsed": 0.0, "cancelled": False}


# ---- 智能去重 (E2)：粘贴前检测是否有重复文件可跳过 ----

def detect_duplicates(sources: List[str], dest_dir: str) -> Dict:
    """检测源文件中哪些在目标目录已有内容完全相同的副本。
    返回重复项列表及总大小——前端可在粘贴前提示用户选择跳过它们。"""
    duplicates = []
    for src in (sources or []):
        name = os.path.basename(src)
        dest = os.path.join(dest_dir, name)
        if not os.path.lexists(dest) or not os.path.isfile(src) or not os.path.isfile(dest):
            continue
        if file_engine.is_duplicate(src, dest):
            duplicates.append({"name": name, "source_path": src, "size": os.path.getsize(src)})
    return {"duplicates": duplicates, "count": len(duplicates),
            "total_bytes": sum(d["size"] for d in duplicates)}


# ---- 撤销 (E6)：会话级操作日志 ----

# 内存中的操作日志（环形缓冲区，最多 20 条）
_UNDO_LOG: deque = deque(maxlen=20)


def _record_operation(op: str, report: Dict, paths: List[str]) -> None:
    """记录一个已完成的操作，供撤销日志/历史面板展示。"""
    _UNDO_LOG.append({
        "sequence": len(_UNDO_LOG) + 1,
        "operation": op,  # "paste" | "delete_recycle" | "delete_permanent" | "secure_erase"
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "files_total": report.get("files_done", 0) or report.get("items_done", 0),
        "paths": paths,
        # 撤销「删到回收站」需按原路径从回收站程序化找回，撤销「粘贴」需重建目标路径（含冲突改名映射），
        # 两者均未实现，如实标 False，不给前端错误信号（见 undo_last()）。
        "reversible": False,
    })


def undo_last(recycle_method: Callable = None) -> Dict:
    """查询是否存在可撤销操作。文件级撤销尚未接入（见 _record_operation），如实返回不可撤销，
    假装成功会让用户误以为文件已找回。"""
    if not _UNDO_LOG:
        return {"ok": False, "error": "undo.nothing_to_undo"}
    # 不附带硬编码中文 description：前端 doUndo() 无 description 时回退到已翻译的 undoNothingToast，避免非中文界面弹出未走 i18n 的提示。
    return {"ok": False, "error": "undo.not_reversible"}


def get_undo_info() -> Dict:
    """返回最近一次可撤销操作的信息（用于前端 Ctrl+Z 提示）。"""
    if not _UNDO_LOG:
        return {"has_undo": False}
    last = _UNDO_LOG[-1]
    return {"has_undo": True, "operation": last["operation"],
            "files_total": last["files_total"],
            "reversible": last["reversible"],
            "timestamp": last["timestamp"],
            "description": f"撤销{last['operation']}"}


# ---- 文件操作历史 (E7) ----

_FILE_CLIP_HISTORY: deque = deque(maxlen=200)


def _record_history(op: str, paths: List[str], report: Dict) -> None:
    """记录文件操作历史（会话级），供 Ctrl+Shift+H 查看。
    存的是轻量元数据，不复制文件。"""
    _FILE_CLIP_HISTORY.appendleft({
        "operation": op,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "files_total": report.get("files_done", 0) or report.get("items_done", 0),
        "bytes_total": report.get("bytes_total", 0),
        "fast_moved_count": report.get("fast_moved_count", 0),
        "elapsed": report.get("elapsed", 0.0),
        "errors_count": len(report.get("errors", [])),
        "path_count": len(paths),
    })


def get_history(limit: int = 50) -> List[Dict]:
    return list(_FILE_CLIP_HISTORY)[:limit]


def clear_history() -> None:
    _FILE_CLIP_HISTORY.clear()


def set_hook_enabled(enabled: bool) -> dict:
    """编译（如需）+ 启动/停止 hook_agent.exe + 写/删自启动注册表项。"""
    from core.fileops import system_integration as si

    if enabled:
        si.build_hook_agent()
        runtime = si.provision_runtime()
        si.restart_agent(runtime, on_conflict="rename")
        si.set_autostart(True, runtime)
        return si.get_status(runtime)
    else:
        si.stop_agent()
        si.set_autostart(False)
    return si.get_status()


def get_hook_status() -> dict:
    """只读查询：编译状态 + 进程是否在跑 + 自启动是否注册。"""
    from core.fileops import system_integration as si

    return si.get_status()


def reconcile_hook_autostart() -> dict:
    """Repair a previously enabled hook when the app/backend starts."""
    from core.fileops import system_integration as si

    return si.reconcile_autostart()


def sync_hook_shortcuts(shortcuts: dict) -> dict:
    """把当前文件操作快捷键写进 C 钩子代理的键位配置，代理在运行则重启使其立即生效。由设置页显式调用，
    不藏在 shortcuts_set 里：保存设置必须无副作用（测试也不会碰真实系统进程）。"""
    from core.fileops import system_integration as si

    config_path = si.write_shortcut_config(shortcuts)
    restarted = False
    if si.is_running():
        runtime = si.provision_runtime()
        si.restart_agent(runtime, on_conflict="rename")
        if si.get_autostart():
            si.set_autostart(True, runtime)
        restarted = True
    return {"config_path": config_path, "agent_restarted": restarted}


def get_progress_preferences() -> dict:
    """Read task-card display settings from FileHook's stable runtime root."""
    return progress_preferences.load_preferences()


def set_progress_preferences(preferences: dict) -> dict:
    """Persist validated task-card display settings for app and hook consumers."""
    return progress_preferences.save_preferences(preferences)


def is_valid_progress_preferences(preferences: object) -> bool:
    """Expose the shared validation boundary to the RPC adapter."""
    return progress_preferences.is_valid_preferences(preferences)
