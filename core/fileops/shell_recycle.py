"""Windows Shell recycle-bin adapter with truthful per-item progress.

``IFileOperation`` reports each finished item via ``IFileOperationProgressSink`` but has no
abort method (only ``GetAnyOperationsAborted`` afterwards), so no cancel path is exposed.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Iterable, Optional

if TYPE_CHECKING:
    from core.fileops.engine import TransferReport


S_OK = 0x00000000
E_ACCESSDENIED = 0x80070005

# IFileOperation flags from shellapi.h.  Kept here so contract tests do not
# need pywin32 or a live Shell.
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOERRORUI = 0x0400


@dataclass(frozen=True)
class RecycleAvailability:
    available: bool
    reason: str = ""


def _failed_hresult(value: int) -> bool:
    return bool(int(value) & 0x80000000)


def _format_hresult(value: int) -> str:
    return f"0x{int(value) & 0xFFFFFFFF:08X}"


def _default_item_path(item) -> str:
    try:
        from win32com.shell import shellcon

        return item.GetDisplayName(shellcon.SHGDN_FORPARSING)
    except Exception:
        return str(item)


class IFileOperationProgressSink:
    """State mapper for the documented Shell progress-sink callbacks."""

    def __init__(self, report: "TransferReport", item_path: Callable = _default_item_path):
        self.report = report
        self._item_path = item_path

    def StartOperations(self):
        self.report.mark_running()

    def FinishOperations(self, hr_result):
        if _failed_hresult(hr_result):
            self.report.add_error("回收站", f"Shell operation failed: {_format_hresult(hr_result)}")

    def PreDeleteItem(self, _flags, item):
        path = self._item_path(item)
        self.report.set_current_path(path)
        self.report.note_recycle_item_started(path)

    def PostDeleteItem(self, _flags, item, hr_delete, _newly_created):
        path = self._item_path(item)
        self.report.set_current_path(path)
        if _failed_hresult(hr_delete):
            self.report.add_error(path, f"Shell delete failed: {_format_hresult(hr_delete)}")
        else:
            self.report.note_recycle_item_done(path)

    # 其余 IFileOperationProgressSink 方法对只删除的操作是空实现，但 Shell COM 接口要求存在。
    def PreRenameItem(self, *_args): pass
    def PostRenameItem(self, *_args): pass
    def PreMoveItem(self, *_args): pass
    def PostMoveItem(self, *_args): pass
    def PreCopyItem(self, *_args): pass
    def PostCopyItem(self, *_args): pass
    def PreNewItem(self, *_args): pass
    def PostNewItem(self, *_args): pass
    def UpdateProgress(self, *_args): pass
    def ResetTimer(self): pass
    def PauseTimer(self): pass
    def ResumeTimer(self): pass


_COM_SINK_METHODS = (
    "StartOperations", "FinishOperations", "PreRenameItem", "PostRenameItem",
    "PreMoveItem", "PostMoveItem", "PreCopyItem", "PostCopyItem",
    "PreDeleteItem", "PostDeleteItem", "PreNewItem", "PostNewItem",
    "UpdateProgress", "ResetTimer", "PauseTimer", "ResumeTimer",
)


def _make_pywin32_progress_sink(sink):
    """Return the policy object passed directly to ``pythoncom.WrapObject``.
    ``DesignatedWrapPolicy`` must wrap a separate target; self-wrapping clears its interface list."""
    from win32com.server.policy import DesignatedWrapPolicy
    from win32com.shell import shell

    class _CallbackTarget:
        _com_interfaces_ = [shell.IID_IFileOperationProgressSink]
        _public_methods_ = _COM_SINK_METHODS

        def __init__(self, target):
            self._sink = target

        def StartOperations(self): return self._sink.StartOperations()
        def FinishOperations(self, *args): return self._sink.FinishOperations(*args)
        def PreRenameItem(self, *args): return self._sink.PreRenameItem(*args)
        def PostRenameItem(self, *args): return self._sink.PostRenameItem(*args)
        def PreMoveItem(self, *args): return self._sink.PreMoveItem(*args)
        def PostMoveItem(self, *args): return self._sink.PostMoveItem(*args)
        def PreCopyItem(self, *args): return self._sink.PreCopyItem(*args)
        def PostCopyItem(self, *args): return self._sink.PostCopyItem(*args)
        def PreDeleteItem(self, *args): return self._sink.PreDeleteItem(*args)
        def PostDeleteItem(self, *args): return self._sink.PostDeleteItem(*args)
        def PreNewItem(self, *args): return self._sink.PreNewItem(*args)
        def PostNewItem(self, *args): return self._sink.PostNewItem(*args)
        def UpdateProgress(self, *args): return self._sink.UpdateProgress(*args)
        def ResetTimer(self): return self._sink.ResetTimer()
        def PauseTimer(self): return self._sink.PauseTimer()
        def ResumeTimer(self): return self._sink.ResumeTimer()

    class _ProgressSinkPolicy(DesignatedWrapPolicy):
        pass

    return _ProgressSinkPolicy(_CallbackTarget(sink))


class _Pywin32Backend:
    def __init__(self):
        import pythoncom
        from win32com.shell import shell

        self.pythoncom = pythoncom
        self.shell = shell

    def initialize(self):
        self.pythoncom.CoInitializeEx(self.pythoncom.COINIT_APARTMENTTHREADED)

    def uninitialize(self):
        self.pythoncom.CoUninitialize()

    def create_operation(self):
        return self.pythoncom.CoCreateInstance(
            self.shell.CLSID_FileOperation,
            None,
            self.pythoncom.CLSCTX_INPROC_SERVER,
            self.shell.IID_IFileOperation,
        )

    def create_item(self, path: str):
        return self.shell.SHCreateItemFromParsingName(path, None, self.shell.IID_IShellItem)

    def wrap_sink(self, sink):
        wrapper = _make_pywin32_progress_sink(sink)
        return self.pythoncom.WrapObject(wrapper, self.shell.IID_IFileOperationProgressSink)


def availability() -> RecycleAvailability:
    if os.name != "nt":
        return RecycleAvailability(False, "Windows Shell is unavailable")
    try:
        _Pywin32Backend()
    except Exception as exc:
        return RecycleAvailability(False, str(exc))
    return RecycleAvailability(True)


def unavailable_fallback(report: "TransferReport", reason: str) -> RecycleAvailability:
    """Mark the SHFileOperation path as explicitly unobservable/un-cancellable."""
    report.set_recycle_capabilities(indeterminate=True)
    return RecycleAvailability(False, reason)


def recycle_items(
    paths: Iterable[str], report: "TransferReport", backend=None,
) -> bool:
    """Queue and perform one Shell recycle operation on a COM-initialized worker.

    Returns ``False`` only when COM failed before any Shell work began (safe to fall back to
    SHFileOperation); later failures go to ``report`` and are never retried.
    """
    try:
        backend = backend or _Pywin32Backend()
    except Exception:
        return False
    source_paths = list(paths)
    state = {"started": False, "result": False}

    def run():
        operation = None
        cookie: Optional[int] = None
        initialized = False
        try:
            backend.initialize()
            initialized = True
            operation = backend.create_operation()
            operation.SetOperationFlags(
                FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
            )
            sink = IFileOperationProgressSink(report)
            cookie = operation.Advise(backend.wrap_sink(sink))
            for path in source_paths:
                operation.DeleteItem(backend.create_item(path), None)
            state["started"] = True
            operation.PerformOperations()
            if operation.GetAnyOperationsAborted():
                report.mark_cancelled()
            state["result"] = True
        except Exception as exc:
            if state["started"]:
                report.add_error("回收站", str(exc))
                state["result"] = True
        finally:
            if operation is not None and cookie is not None:
                try:
                    operation.Unadvise(cookie)
                except Exception:
                    pass
            if initialized:
                backend.uninitialize()

    worker = threading.Thread(target=run, name="shell-recycle-worker", daemon=False)
    worker.start()
    worker.join()
    return bool(state["result"])
