"""SQLCipher-encrypted SQLite storage for speedtest history. Same pattern as notes/storage.py and clipboard/storage.py:
takes a raw 32-byte key (derived from the IMK by backend_server.py). New table, so "CREATE TABLE IF NOT EXISTS" needs no migration."""

import sqlite3
import time
from typing import Optional
from pathlib import Path

from sqlcipher3 import dbapi2 as sqlcipher

HISTORY_LIST_DEFAULT_LIMIT = 200
# 异常/变差提醒对比的是"最近这么多条同类历史"的平均值，不是全部历史——
# 网络环境是会变的（换路由器、换运营商...），拿太久以前的记录来比没有意义。
ANOMALY_BASELINE_SAMPLE_SIZE = 10
# 下载速度低于历史均值的此比例、或延迟高于历史均值的此倍数，即判定「比平时差」；命名常量，调整只改这两个数。
# 两个条件任一命中即算异常，因为下载变慢和延迟变高是不同的变差表现。
ANOMALY_DOWNLOAD_RATIO = 0.6
ANOMALY_PING_RATIO = 1.5


def is_anomalous(baseline: Optional[dict], *, download_mbps: Optional[float], ping_ms: Optional[float]) -> bool:
    if not baseline or download_mbps is None or ping_ms is None:
        return False
    if download_mbps < baseline["avg_download_mbps"] * ANOMALY_DOWNLOAD_RATIO:
        return True
    return ping_ms > baseline["avg_ping_ms"] * ANOMALY_PING_RATIO

_SCHEMA = """
CREATE TABLE IF NOT EXISTS speedtest_history (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at              TEXT NOT NULL,
    network_type            TEXT NOT NULL,
    node                    TEXT NOT NULL,
    environment_tag         TEXT,
    ping_ms                 REAL,
    jitter_ms               REAL,
    loss_ratio              REAL,
    dns_ms                  REAL,
    download_mbps           REAL,
    upload_mbps             REAL,
    ipv4                    TEXT,
    ipv6                    TEXT,
    connection_mode         TEXT,
    ping_min_ms             REAL,
    ping_max_ms             REAL,
    download_loaded_ping_ms REAL,
    upload_loaded_ping_ms   REAL
);
CREATE INDEX IF NOT EXISTS idx_speedtest_history_created_at ON speedtest_history(created_at);
CREATE INDEX IF NOT EXISTS idx_speedtest_history_network_type ON speedtest_history(network_type);
"""


def _hex_key(key: bytes) -> str:
    return "x'" + key.hex() + "'"


def connect(db_path: Path, key: bytes) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlcipher.connect(str(db_path), check_same_thread=False)
    conn.execute(f"PRAGMA key = \"{_hex_key(key)}\"")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def _row_to_dict(cur: sqlite3.Cursor, row) -> dict:
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


def insert_result(
    conn: sqlite3.Connection,
    *,
    network_type: str,
    node: str,
    environment_tag: Optional[str] = None,
    ping_ms: Optional[float] = None,
    jitter_ms: Optional[float] = None,
    loss_ratio: Optional[float] = None,
    dns_ms: Optional[float] = None,
    download_mbps: Optional[float] = None,
    upload_mbps: Optional[float] = None,
    ipv4: Optional[str] = None,
    ipv6: Optional[str] = None,
    connection_mode: Optional[str] = None,
    ping_min_ms: Optional[float] = None,
    ping_max_ms: Optional[float] = None,
    download_loaded_ping_ms: Optional[float] = None,
    upload_loaded_ping_ms: Optional[float] = None,
) -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        """
        INSERT INTO speedtest_history
            (created_at, network_type, node, environment_tag, ping_ms, jitter_ms, loss_ratio,
             dns_ms, download_mbps, upload_mbps, ipv4, ipv6, connection_mode, ping_min_ms,
             ping_max_ms, download_loaded_ping_ms, upload_loaded_ping_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now, network_type, node, environment_tag, ping_ms, jitter_ms, loss_ratio, dns_ms,
            download_mbps, upload_mbps, ipv4, ipv6, connection_mode, ping_min_ms, ping_max_ms,
            download_loaded_ping_ms, upload_loaded_ping_ms,
        ),
    )
    conn.commit()
    return cur.lastrowid


def list_results(
    conn: sqlite3.Connection,
    *,
    network_type: Optional[str] = None,
    environment_tag: Optional[str] = None,
    limit: int = HISTORY_LIST_DEFAULT_LIMIT,
) -> list:
    query = "SELECT * FROM speedtest_history WHERE 1=1"
    args: list = []
    if network_type is not None:
        query += " AND network_type = ?"
        args.append(network_type)
    if environment_tag is not None:
        query += " AND environment_tag = ?"
        args.append(environment_tag)
    query += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    cur = conn.execute(query, args)
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def list_distinct_tags(conn: sqlite3.Connection) -> list:
    cur = conn.execute(
        "SELECT DISTINCT environment_tag FROM speedtest_history WHERE environment_tag IS NOT NULL AND environment_tag != '' ORDER BY environment_tag"
    )
    return [row[0] for row in cur.fetchall()]


def set_tag(conn: sqlite3.Connection, record_id: int, tag: Optional[str]) -> bool:
    cur = conn.execute("UPDATE speedtest_history SET environment_tag = ? WHERE id = ?", (tag, record_id))
    conn.commit()
    return cur.rowcount > 0


def clear_history(conn: sqlite3.Connection) -> int:
    cur = conn.execute("SELECT COUNT(*) FROM speedtest_history")
    count = cur.fetchone()[0]
    conn.execute("DELETE FROM speedtest_history")
    conn.commit()
    return count


def fetch_baseline(conn: sqlite3.Connection, *, network_type: str, environment_tag: Optional[str]) -> Optional[dict]:
    """Average download/ping over the last ANOMALY_BASELINE_SAMPLE_SIZE rows of the same network_type (+environment_tag if given),
    the baseline for "worse than usual". None if there is no prior row."""
    query = "SELECT download_mbps, ping_ms FROM speedtest_history WHERE network_type = ? AND download_mbps IS NOT NULL"
    args: list = [network_type]
    if environment_tag is not None:
        query += " AND environment_tag = ?"
        args.append(environment_tag)
    query += " ORDER BY id DESC LIMIT ?"
    args.append(ANOMALY_BASELINE_SAMPLE_SIZE)
    rows = conn.execute(query, args).fetchall()
    if not rows:
        return None
    downloads = [r[0] for r in rows if r[0] is not None]
    pings = [r[1] for r in rows if r[1] is not None]
    if not downloads or not pings:
        return None
    return {
        "avg_download_mbps": sum(downloads) / len(downloads),
        "avg_ping_ms": sum(pings) / len(pings),
        "sample_size": len(rows),
    }


class NetworkSpeedtestHistoryService:
    """Thin connection-owning wrapper like NotesService/ClipboardService, small enough to skip a service.py;
    network_speedtest/service.py is the live-measurement logic, a separate concern."""

    def __init__(self, data_dir: Path, key: bytes):
        self.conn = connect(data_dir / "network_speedtest_history.db", key)

    def record_result(self, **fields) -> int:
        return insert_result(self.conn, **fields)

    def list_history(self, *, network_type: Optional[str] = None, environment_tag: Optional[str] = None, limit: int = HISTORY_LIST_DEFAULT_LIMIT) -> list:
        return list_results(self.conn, network_type=network_type, environment_tag=environment_tag, limit=limit)

    def list_tags(self) -> list:
        return list_distinct_tags(self.conn)

    def set_tag(self, record_id: int, tag: Optional[str]) -> bool:
        return set_tag(self.conn, record_id, tag)

    def clear(self) -> int:
        return clear_history(self.conn)

    def baseline_for(self, *, network_type: str, environment_tag: Optional[str]) -> Optional[dict]:
        return fetch_baseline(self.conn, network_type=network_type, environment_tag=environment_tag)
