import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import remnants


def _paths(items):
    return {it["path"] for it in items}


def test_same_dir_backup_and_owner_files_are_found(tmp_path):
    source = tmp_path / "report.docx"
    source.write_bytes(b"plaintext")
    owner = tmp_path / "~$port.docx"  # Word owner-file naming: ~$ + name minus first 2 chars
    owner.write_bytes(b"owner")
    bak = tmp_path / "report.docx.bak"
    bak.write_bytes(b"backup copy")
    unrelated = tmp_path / "other.txt"
    unrelated.write_bytes(b"unrelated")

    items = remnants.scan_remnants([str(source)], scan_dirs=[], name_scan_roots=[])

    assert str(owner) in _paths(items)
    assert str(bak) in _paths(items)
    assert str(unrelated) not in _paths(items)
    assert all(it["matched"] for it in items)
    assert all(it["category"] == remnants.CATEGORY_SAME_DIR for it in items)


def test_source_itself_and_ivault_copies_are_not_remnants(tmp_path):
    source = tmp_path / "report.docx"
    source.write_bytes(b"plaintext")
    encrypted = tmp_path / "report.docx.ivault"
    encrypted.write_bytes(b"ciphertext")

    items = remnants.scan_remnants([str(source)], scan_dirs=[], name_scan_roots=[])
    assert items == []


def test_scan_works_when_source_was_already_deleted(tmp_path):
    # After "encrypt + securely delete source" the source path no longer
    # exists - remnant scanning must still find its leftovers by name.
    bak = tmp_path / "report.docx.bak"
    bak.write_bytes(b"backup copy")

    items = remnants.scan_remnants([str(tmp_path / "report.docx")], scan_dirs=[], name_scan_roots=[])
    assert _paths(items) == {str(bak)}


def test_backup_dir_files_matching_source_name_are_matched(tmp_path):
    backup_dir = tmp_path / "wps_backup"
    backup_dir.mkdir()
    related = backup_dir / "report.docx（自动备份）.docx"
    related.write_bytes(b"wps backup")
    opaque = backup_dir / "et_1772.bk"
    opaque.write_bytes(b"opaque backup")

    source = tmp_path / "docs" / "report.docx"
    items = remnants.scan_remnants(
        [str(source)], scan_dirs=[(remnants.CATEGORY_WPS_BACKUP, backup_dir)], name_scan_roots=[]
    )

    by_path = {it["path"]: it for it in items}
    assert by_path[str(related)]["matched"] is True
    assert by_path[str(opaque)]["matched"] is False
    # matched entries sort first so the UI pre-selects the right ones on top
    assert items[0]["path"] == str(related)


def test_old_unmatched_backup_files_are_skipped(tmp_path):
    import os

    backup_dir = tmp_path / "wps_backup"
    backup_dir.mkdir()
    stale = backup_dir / "ancient.bk"
    stale.write_bytes(b"old")
    old_time = time.time() - (remnants.BACKUP_MAX_AGE_DAYS + 10) * 24 * 3600
    os.utime(stale, (old_time, old_time))

    items = remnants.scan_remnants(
        [str(tmp_path / "report.docx")], scan_dirs=[(remnants.CATEGORY_WPS_BACKUP, backup_dir)], name_scan_roots=[]
    )
    assert items == []


def test_missing_backup_dir_is_ignored(tmp_path):
    items = remnants.scan_remnants(
        [str(tmp_path / "report.docx")],
        scan_dirs=[(remnants.CATEGORY_WPS_BACKUP, tmp_path / "does_not_exist")],
        name_scan_roots=[],
    )
    assert items == []


def test_default_scan_dirs_only_returns_existing_directories():
    for _category, directory in remnants._default_scan_dirs():
        assert directory.is_dir()


def test_same_name_disk_scan_finds_copies_in_other_folders(tmp_path):
    """WPS 文档修复/深度检索场景：加密源文件已不在，但同名副本（或 '<name> - 修复' 变体）
    留在完全不同的文件夹，正是全盘修复工具挖出并当作"已恢复"展示的内容。"""
    src_dir = tmp_path / "work"
    src_dir.mkdir()
    source = src_dir / "秋招面试备战手册-小明.docx"

    other = tmp_path / "resumes"
    other.mkdir()
    exact_copy = other / "秋招面试备战手册-小明.docx"
    exact_copy.write_bytes(b"the untouched original copy")
    repaired = other / "秋招面试备战手册-小明 - 修复.docx"
    repaired.write_bytes(b"wps repair output")
    unrelated = other / "完全无关的文件.docx"
    unrelated.write_bytes(b"unrelated")
    encrypted_copy = other / "秋招面试备战手册-小明.docx.ivault"
    encrypted_copy.write_bytes(b"ciphertext copy - not plaintext")

    items = remnants.scan_remnants([str(source)], scan_dirs=[], name_scan_roots=[tmp_path])

    found = _paths(items)
    assert str(exact_copy) in found
    assert str(repaired) in found
    assert str(unrelated) not in found
    assert str(encrypted_copy) not in found
    by_path = {it["path"]: it for it in items}
    assert by_path[str(exact_copy)]["category"] == remnants.CATEGORY_SAME_NAME_DISK
    assert by_path[str(exact_copy)]["matched"] is True


def test_same_name_disk_scan_skips_pruned_directories(tmp_path):
    (tmp_path / "node_modules").mkdir()
    hidden = tmp_path / "node_modules" / "report.docx"
    hidden.write_bytes(b"copy inside pruned dir")

    items = remnants.scan_remnants(
        [str(tmp_path / "elsewhere" / "report.docx")], scan_dirs=[], name_scan_roots=[tmp_path]
    )
    assert str(hidden) not in _paths(items)


def test_same_name_disk_scan_does_not_report_the_source_itself(tmp_path):
    source = tmp_path / "report.docx"
    source.write_bytes(b"the source still on disk")

    items = remnants.scan_remnants([str(source)], scan_dirs=[], name_scan_roots=[tmp_path])
    assert str(source) not in _paths(items)


def test_same_name_disk_scan_respects_time_budget(tmp_path):
    copy = tmp_path / "report.docx"
    copy.write_bytes(b"copy")
    # A zero budget means the walk stops before yielding anything.
    items = remnants.scan_remnants(
        [str(tmp_path / "other" / "report.docx")],
        scan_dirs=[],
        name_scan_roots=[tmp_path],
        name_scan_budget=0.0,
    )
    assert items == []


def test_common_word_stem_does_not_match_mid_filename(tmp_path):
    """'report.docx' must not flag every file merely containing 'report'
    somewhere in its name on a disk-wide walk."""
    other = tmp_path / "annual-report-2026.docx"
    other.write_bytes(b"different document")
    partial = tmp_path / "report summary.docx"  # stem + separator -> a real copy variant
    partial.write_bytes(b"variant")

    items = remnants.scan_remnants(
        [str(tmp_path / "elsewhere" / "report.docx")], scan_dirs=[], name_scan_roots=[tmp_path]
    )
    found = _paths(items)
    assert str(other) not in found
    assert str(partial) in found
