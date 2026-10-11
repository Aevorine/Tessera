"""SQLCipher-encrypted SQLite storage for AI chat history, opened with a raw 32-byte key
derived from the Vault IMK by backend_server.py (same pattern as notes/clipboard storage).

A whole conversation is one JSON `messages` array in a single row, upserted as it grows (never
edited per message). `first_question` is snapshotted at save time so the list avoids parsing
`messages`. No soft-delete: deletion is immediate and permanent.
"""

import json
import sqlite3
import time
from pathlib import Path
from typing import List, Optional

from sqlcipher3 import dbapi2 as sqlcipher

SCHEMA_VERSION = "1"

FIRST_QUESTION_PREVIEW_CHARS = 200

_LIST_COLUMNS = "id, first_question, message_count, created_at, updated_at"
_FULL_COLUMNS = "id, first_question, messages, message_count, created_at, updated_at"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_conversations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    first_question TEXT NOT NULL DEFAULT '',
    messages       TEXT NOT NULL DEFAULT '[]',
    message_count  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
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
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    conn.commit()
    return conn


def _first_question_of(messages: list) -> str:
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "user":
            return str(m.get("content", ""))[:FIRST_QUESTION_PREVIEW_CHARS]
    return ""


def _row_to_dict(cur, row) -> dict:
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


def save_conversation(conn, messages: List[dict], conversation_id: Optional[int] = None) -> int:
    """Insert a new conversation, or update in place when `conversation_id` exists (the UI upserts
    the same row on every exchange). Returns the row id."""
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    first_question = _first_question_of(messages)
    payload = json.dumps(messages, ensure_ascii=False)

    if conversation_id is not None:
        cur = conn.execute(
            "UPDATE ai_conversations SET first_question = ?, messages = ?, message_count = ?, updated_at = ? "
            "WHERE id = ?",
            (first_question, payload, len(messages), now, conversation_id),
        )
        conn.commit()
        if cur.rowcount > 0:
            return conversation_id

    cur = conn.execute(
        "INSERT INTO ai_conversations (first_question, messages, message_count, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (first_question, payload, len(messages), now, now),
    )
    conn.commit()
    return cur.lastrowid


def fetch_list(conn) -> List[dict]:
    """Metadata only (no `messages`) - keeps the history list fast
    regardless of how long individual conversations get."""
    cur = conn.execute(f"SELECT {_LIST_COLUMNS} FROM ai_conversations ORDER BY id DESC")
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def fetch_one(conn, conversation_id: int) -> Optional[dict]:
    cur = conn.execute(f"SELECT {_FULL_COLUMNS} FROM ai_conversations WHERE id = ?", (conversation_id,))
    row = cur.fetchone()
    if row is None:
        return None
    d = _row_to_dict(cur, row)
    d["messages"] = json.loads(d["messages"])
    return d


def delete_bulk(conn, conversation_ids: List[int]) -> int:
    if not conversation_ids:
        return 0
    placeholders = ",".join("?" for _ in conversation_ids)
    cur = conn.execute(f"DELETE FROM ai_conversations WHERE id IN ({placeholders})", conversation_ids)
    conn.commit()
    return cur.rowcount


def delete_all(conn) -> int:
    cur = conn.execute("DELETE FROM ai_conversations")
    conn.commit()
    return cur.rowcount
