import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import activity_log, crypto

KEY = crypto.generate_key()


def _connect(tmp_path):
    return activity_log.connect(tmp_path / "activity.db", KEY)


def test_fetch_recent_empty_when_nothing_recorded(tmp_path):
    conn = _connect(tmp_path)
    try:
        assert activity_log.fetch_recent(conn) == []
    finally:
        conn.close()


def test_record_then_fetch_recent_round_trips(tmp_path):
    conn = _connect(tmp_path)
    try:
        activity_log.record(conn, "files", "encrypt", "report.docx")
        rows = activity_log.fetch_recent(conn)
        assert len(rows) == 1
        assert rows[0]["module"] == "files"
        assert rows[0]["action"] == "encrypt"
        assert rows[0]["label"] == "report.docx"
        assert rows[0]["created_at"]
    finally:
        conn.close()


def test_fetch_recent_orders_newest_first(tmp_path):
    conn = _connect(tmp_path)
    try:
        activity_log.record(conn, "notes", "save", "first")
        activity_log.record(conn, "notes", "save", "second")
        activity_log.record(conn, "notes", "save", "third")
        labels = [row["label"] for row in activity_log.fetch_recent(conn)]
        assert labels == ["third", "second", "first"]
    finally:
        conn.close()


def test_fetch_recent_respects_limit(tmp_path):
    conn = _connect(tmp_path)
    try:
        for i in range(10):
            activity_log.record(conn, "clipboard", "capture", f"entry-{i}")
        assert len(activity_log.fetch_recent(conn, limit=3)) == 3
    finally:
        conn.close()


def test_record_rejects_unknown_module(tmp_path):
    conn = _connect(tmp_path)
    try:
        with pytest.raises(ValueError):
            activity_log.record(conn, "not-a-real-module", "action", "label")
    finally:
        conn.close()


def test_record_prunes_beyond_max_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(activity_log, "MAX_ROWS", 5)
    conn = _connect(tmp_path)
    try:
        for i in range(8):
            activity_log.record(conn, "passwords", "add", f"site-{i}.com")
        rows = activity_log.fetch_recent(conn, limit=100)
        assert len(rows) == 5
        assert [r["label"] for r in rows] == [
            "site-7.com", "site-6.com", "site-5.com", "site-4.com", "site-3.com",
        ]
    finally:
        conn.close()


def test_clear_all_removes_every_row(tmp_path):
    conn = _connect(tmp_path)
    try:
        activity_log.record(conn, "files", "decrypt", "a.ivault")
        activity_log.record(conn, "files", "decrypt", "b.ivault")
        activity_log.clear_all(conn)
        assert activity_log.fetch_recent(conn) == []
    finally:
        conn.close()


def test_data_persists_across_reconnect_with_same_key(tmp_path):
    conn = _connect(tmp_path)
    try:
        activity_log.record(conn, "notes", "save", "persisted note")
    finally:
        conn.close()

    reconnected = _connect(tmp_path)
    try:
        rows = activity_log.fetch_recent(reconnected)
        assert len(rows) == 1
        assert rows[0]["label"] == "persisted note"
    finally:
        reconnected.close()


def test_wrong_key_cannot_read_existing_database(tmp_path):
    conn = _connect(tmp_path)
    try:
        activity_log.record(conn, "notes", "save", "secret title")
    finally:
        conn.close()

    wrong_key = crypto.generate_key()
    # SQLCipher 因版本不同，会在 connect() 时或首次真实查询时才暴露错误密钥，两者都算检测到。
    with pytest.raises(Exception):
        bad_conn = activity_log.connect(tmp_path / "activity.db", wrong_key)
        try:
            bad_conn.execute("SELECT * FROM activity_log").fetchall()
        finally:
            bad_conn.close()
