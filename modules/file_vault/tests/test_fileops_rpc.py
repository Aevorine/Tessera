"""file_clip fileops RPC 层（copy/cut/clipboard_status/paste/delete）的进程内测试。
不需要 _data_dir/_imk，但会碰真实 Windows 剪贴板（同 modules/file_clip/tests/run_tests.py）。"""

import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import backend_server  # noqa: E402
from core.fileops import clipboard as file_clipboard  # noqa: E402


@pytest.fixture(autouse=True)
def clean_clipboard():
    """每个测试从空的 file-clip 剪贴板状态开始并自行清理。

    真实 CF_HDROP 剪贴板可能被 Ditto、Win+V、Explorer 等短暂占用，core/fileops/clipboard.py 的重试
    不一定每次赢；copy/cut 后写入未落定时读到空，所以测试在每次 copy/cut 后短暂 sleep。"""
    import time as _time
    for _ in range(5):
        try:
            file_clipboard.clear_clipboard()
            break
        except file_clipboard.ClipboardError:
            _time.sleep(0.05)
    _time.sleep(0.1)
    yield
    for _ in range(5):
        try:
            file_clipboard.clear_clipboard()
            break
        except file_clipboard.ClipboardError:
            _time.sleep(0.05)
    _time.sleep(0.1)


def _write_file(path: Path, content: bytes = b"hello") -> Path:
    path.write_bytes(content)
    return path


def test_copy_then_status_then_paste_keeps_source(tmp_path):
    src_dir = tmp_path / "src"
    dest_dir = tmp_path / "dest"
    src_dir.mkdir()
    dest_dir.mkdir()
    f = _write_file(src_dir / "single.txt", b"hello world")

    res = backend_server.rpc_file_clip_copy({"paths": [str(f)]})
    assert res == {"ok": True, "count": 1}

    import time as _time
    _time.sleep(0.1)  # let the clipboard write settle before reading back

    status = backend_server.rpc_file_clip_clipboard_status({})
    assert status["ok"] is True
    assert status["has_files"] is True
    assert status["is_cut"] is False
    assert os.path.normcase(status["paths"][0]) == os.path.normcase(str(f))

    result = backend_server.rpc_file_clip_paste(
        {"dest_dir": str(dest_dir), "on_conflict": "rename"}, request_id=1
    )
    assert result["ok"] is True
    assert result["files_done"] == 1
    assert (dest_dir / "single.txt").read_bytes() == b"hello world"
    # copy, not cut - source must still be there
    assert f.exists()


def test_cut_then_paste_removes_source_and_clears_clipboard(tmp_path):
    src_dir = tmp_path / "src"
    dest_dir = tmp_path / "dest"
    src_dir.mkdir()
    dest_dir.mkdir()
    f = _write_file(src_dir / "single.txt")

    res = backend_server.rpc_file_clip_cut({"paths": [str(f)]})
    assert res == {"ok": True, "count": 1}

    import time as _time
    _time.sleep(0.1)  # let clipboard settle after cut before paste

    result = backend_server.rpc_file_clip_paste(
        {"dest_dir": str(dest_dir), "on_conflict": "rename"}, request_id=2
    )
    assert result["ok"] is True
    assert (dest_dir / "single.txt").exists()
    assert not f.exists()

    # clipboard auto-clears after a successful cut+paste, same as Explorer
    status = backend_server.rpc_file_clip_clipboard_status({})
    assert status["has_files"] is False


def test_paste_with_empty_clipboard_errors(tmp_path):
    result = backend_server.rpc_file_clip_paste(
        {"dest_dir": str(tmp_path), "on_conflict": "rename"}, request_id=3
    )
    assert result == {"ok": False, "error": "file_clip.clipboard_empty"}


def test_copy_conflict_rename_keeps_both(tmp_path):
    src_dir = tmp_path / "src"
    dest_dir = tmp_path / "dest"
    src_dir.mkdir()
    dest_dir.mkdir()
    f = _write_file(src_dir / "dup.txt", b"source content")
    (dest_dir / "dup.txt").write_bytes(b"existing content")

    backend_server.rpc_file_clip_copy({"paths": [str(f)]})
    import time as _time
    _time.sleep(0.1)
    result = backend_server.rpc_file_clip_paste(
        {"dest_dir": str(dest_dir), "on_conflict": "rename"}, request_id=4
    )
    assert result["ok"] is True
    assert (dest_dir / "dup.txt").read_bytes() == b"existing content"
    assert (dest_dir / "dup (2).txt").read_bytes() == b"source content"


def test_copy_many_small_files(tmp_path):
    src_dir = tmp_path / "src"
    dest_dir = tmp_path / "dest"
    src_dir.mkdir()
    dest_dir.mkdir()
    paths = [str(_write_file(src_dir / f"f{i}.txt", f"content-{i}".encode())) for i in range(200)]

    backend_server.rpc_file_clip_copy({"paths": paths})
    import time as _time
    _time.sleep(0.1)
    result = backend_server.rpc_file_clip_paste(
        {"dest_dir": str(dest_dir), "on_conflict": "rename"}, request_id=5
    )
    assert result["ok"] is True
    assert result["files_done"] == 200
    assert len(list(dest_dir.iterdir())) == 200


def test_delete_permanent_removes_files(tmp_path):
    d = tmp_path / "to_delete"
    d.mkdir()
    f1 = _write_file(d / "a.txt")
    f2 = _write_file(d / "b.txt")

    result = backend_server.rpc_file_clip_delete(
        {"paths": [str(f1), str(f2)], "recycle": False}, request_id=6
    )
    assert result["ok"] is True
    assert result["files_done"] == 2
    assert not f1.exists()
    assert not f2.exists()


def test_delete_recycle_removes_from_original_location(tmp_path):
    d = tmp_path / "to_recycle"
    d.mkdir()
    f = _write_file(d / "a.txt")

    result = backend_server.rpc_file_clip_delete(
        {"paths": [str(f)], "recycle": True}, request_id=7
    )
    assert result["ok"] is True
    assert not f.exists()


def test_delete_with_no_paths_errors():
    result = backend_server.rpc_file_clip_delete({"paths": [], "recycle": True}, request_id=8)
    assert result == {"ok": False, "error": "file_clip.no_paths"}
