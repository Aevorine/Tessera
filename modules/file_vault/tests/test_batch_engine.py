import threading
import time
from pathlib import Path

from modules.file_vault import batch_engine


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


def test_submit_batch_task_bounds_concurrent_execution(monkeypatch):
    # 回归：大批量任务（如数百文件加密）同一时刻运行的 fn() 不得超过闸门上限，即使各任务线程已立即
    # 启动。强制小上限使测试快且与机器 CPU 数无关（默认值由 os.cpu_count() 算）。
    # 闸门已改为"总数 + 批量分开计数"（见 batch_engine 留位注释），所以这里直接压两个上限。
    monkeypatch.setattr(batch_engine, "_MAX_CONCURRENT_TASKS", 2)
    monkeypatch.setattr(batch_engine, "_MAX_BULK_TASKS", 2)

    lock = threading.Lock()
    concurrent_count = 0
    max_seen = 0

    def fn():
        nonlocal concurrent_count, max_seen
        with lock:
            concurrent_count += 1
            max_seen = max(max_seen, concurrent_count)
        time.sleep(0.05)
        with lock:
            concurrent_count -= 1
        return {"ok": True}

    written = []
    for i in range(6):
        batch_engine.submit_batch_task(request_id=i, fn=fn, write=written.append)

    deadline = time.monotonic() + 2.0
    while len(written) < 6 and time.monotonic() < deadline:
        time.sleep(0.01)

    assert len(written) == 6
    assert max_seen <= 2, f"expected at most 2 concurrent executions, saw {max_seen}"
