"""Contract tests for the Shell recycle-bin progress adapter."""

import threading

from core.fileops import engine, shell_recycle


def test_progress_sink_counts_only_successful_per_item_delete_callbacks():
    report = engine.TransferReport(operation="recycle")
    report.set_recycle_capabilities(indeterminate=False)
    sink = shell_recycle.IFileOperationProgressSink(
        report, item_path=lambda item: item["path"],
    )

    sink.StartOperations()
    sink.PreDeleteItem(0, {"path": r"D:\one.txt"})
    sink.PostDeleteItem(0, {"path": r"D:\one.txt"}, shell_recycle.S_OK, None)
    sink.PreDeleteItem(0, {"path": r"D:\locked.txt"})
    sink.PostDeleteItem(0, {"path": r"D:\locked.txt"}, shell_recycle.E_ACCESSDENIED, None)

    snapshot = report.snapshot()
    assert (snapshot.items_done, snapshot.items_total) == (1, 2)
    assert snapshot.current_path == r"D:\locked.txt"
    assert snapshot.errors == ((r"D:\locked.txt", "Shell delete failed: 0x80070005"),)


def test_recycle_runs_com_on_worker_and_records_shell_observed_abort_state():
    class Operation:
        def __init__(self):
            self.sink = None
            self.deleted = []
            self.unadvised = []

        def SetOperationFlags(self, flags):
            assert flags & shell_recycle.FOF_ALLOWUNDO

        def Advise(self, sink):
            self.sink = sink
            return 42

        def DeleteItem(self, item, _sink):
            self.deleted.append(item)

        def PerformOperations(self):
            self.sink.StartOperations()
            self.sink.PreDeleteItem(0, self.deleted[0])
            self.sink.PostDeleteItem(0, self.deleted[0], shell_recycle.S_OK, None)
            self.sink.FinishOperations(shell_recycle.S_OK)

        def GetAnyOperationsAborted(self):
            return True

        def Unadvise(self, cookie):
            self.unadvised.append(cookie)

    class Backend:
        def __init__(self):
            self.operation = Operation()
            self.events = []

        def initialize(self):
            self.events.append(("initialize", threading.current_thread().name))

        def uninitialize(self):
            self.events.append(("uninitialize", threading.current_thread().name))

        def create_operation(self):
            return self.operation

        def create_item(self, path):
            return {"path": path}

        def wrap_sink(self, sink):
            return sink

    backend = Backend()
    report = engine.TransferReport(operation="recycle")
    report.set_recycle_capabilities(indeterminate=False)

    assert shell_recycle.recycle_items([r"D:\one.txt"], report, backend=backend)
    report.finish()

    snapshot = report.snapshot()
    assert snapshot.phase == "cancelled"
    assert snapshot.cancel_requested
    assert snapshot.items_done == 1
    assert backend.operation.unadvised == [42]
    assert {thread for _event, thread in backend.events} == {"shell-recycle-worker"}


def test_unavailable_com_configures_explicit_indeterminate_no_cancel_fallback():
    report = engine.TransferReport(operation="recycle")

    fallback = shell_recycle.unavailable_fallback(report, "COM is unavailable")

    snapshot = report.snapshot()
    assert fallback.available is False
    assert snapshot.recycle and snapshot.indeterminate
    assert not snapshot.can_cancel


def test_delete_items_prefers_the_observable_shell_adapter_when_com_is_available(
    tmp_path, monkeypatch,
):
    source = tmp_path / "recycle-me.txt"
    source.write_text("payload", encoding="utf-8")
    calls = []

    monkeypatch.setattr(
        shell_recycle, "availability", lambda: shell_recycle.RecycleAvailability(True),
    )

    def recycle(paths, report):
        calls.append(list(paths))
        report.mark_running()
        report.note_recycle_item_started(str(source))
        report.note_recycle_item_done(str(source))
        return True

    monkeypatch.setattr(shell_recycle, "recycle_items", recycle)

    report = engine.delete_items([str(source)], recycle=True, live_progress=False)
    snapshot = report.snapshot()

    assert calls == [[str(source)]]
    assert (snapshot.items_done, snapshot.items_total) == (1, 1)
    assert not snapshot.indeterminate and not snapshot.can_cancel


def test_pywin32_backend_wraps_the_progress_sink_for_the_shell_interface():
    backend = shell_recycle._Pywin32Backend()
    backend.initialize()
    try:
        report = engine.TransferReport(operation="recycle")
        wrapped = backend.wrap_sink(shell_recycle.IFileOperationProgressSink(report))
        operation = backend.create_operation()
        cookie = operation.Advise(wrapped)
        operation.Unadvise(cookie)
    finally:
        backend.uninitialize()


def test_pywin32_policy_advertises_the_progress_sink_iid_and_callback_mapping():
    from win32com.shell import shell

    report = engine.TransferReport(operation="recycle")
    policy = shell_recycle._make_pywin32_progress_sink(
        shell_recycle.IFileOperationProgressSink(report),
    )

    assert policy._com_interfaces_ == [shell.IID_IFileOperationProgressSink]
    assert policy._obj_ is not policy
    assert policy._obj_._com_interfaces_ == [shell.IID_IFileOperationProgressSink]
    assert set(policy._obj_._public_methods_) <= set(policy._dispid_to_func_.values())
    for method in policy._obj_._public_methods_:
        assert callable(getattr(policy._obj_, method))
