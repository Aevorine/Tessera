"""跨模块"最近操作"时间线：给文件保险箱/笔记/密码库/剪贴板提供共享的极薄记录表，供 Files 面板展示。

安全边界：label 可能含笔记标题、文件名、密码条目网址，与正文同级敏感，必须存在加密数据库
（SQLCipher），不能是明文 JSON。密钥从 IMK 经 HKDF 派生专属密钥，不复用其它模块的
（见 backend_server.py 的 _ACTIVITY_LOG_KEY_SALT/_INFO）。只在各模块成功路径补一行 `record()`，
不新增模块耦合。
"""

import hashlib
import sqlite3
import time
from pathlib import Path
from typing import List, Optional

from sqlcipher3 import dbapi2 as sqlcipher

# 前端渲染时按这四个值选图标，新增模块时只需要前端加一条映射，不需要改这里。
MODULES = ("files", "notes", "passwords", "clipboard")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    module     TEXT NOT NULL,
    action     TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_log_id ON activity_log(id DESC);

-- 哈希链的锚点。裁掉旧记录之后，链的起点会往前移；把"被裁掉的最后一条的
-- 哈希"留在这里，剩下的记录才仍然能从一个已知值开始逐条验下去。
-- 只有一行，id 恒为 1。
CREATE TABLE IF NOT EXISTS chain_meta (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    anchor_hash  TEXT NOT NULL,
    trimmed      INTEGER NOT NULL DEFAULT 0
);
"""

# 链的起点。第一条记录的 prev_hash 就是它。
GENESIS_HASH = "0" * 64


def _entry_hash(prev_hash: str, module: str, action: str, label: str, created_at: str) -> str:
    """一条记录的哈希 = 上一条的哈希 + 这条的全部字段。

    分隔符用 \x1f 而非逗号/竖线：它不会出现在 module/action 里，也几乎不会出现在标题里，
    避免拼接式哈希的"分隔符注入"（改写字段而哈希不变）。
    """
    joined = "\x1f".join([prev_hash, module, action, label, created_at])
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()

# 时间线只是快速浏览不是审计日志，超过此条数的旧记录直接裁掉，避免无限增长。
MAX_ROWS = 500


def _hex_key(key: bytes) -> str:
    return "x'" + key.hex() + "'"


def connect(db_path: Path, key: bytes) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlcipher.connect(str(db_path), check_same_thread=False)
    conn.execute(f"PRAGMA key = \"{_hex_key(key)}\"")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    _migrate_chain(conn)
    conn.commit()
    return conn


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(row[1] == column for row in conn.execute(f"PRAGMA table_info({table})"))


def _migrate_chain(conn: sqlite3.Connection) -> None:
    """给老库补上 prev_hash / entry_hash 两列并把已有记录串成链。

    回填只表示"从现在起开始可信"，不能追认过去没被改过：它按当下内容算哈希，之前被改过的
    行照样自洽。签名链只能证明"签上之后没被动过"，别把"验证通过"读成"从未被动过手脚"。
    """
    if not _has_column(conn, "activity_log", "prev_hash"):
        conn.execute("ALTER TABLE activity_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''")
    if not _has_column(conn, "activity_log", "entry_hash"):
        conn.execute("ALTER TABLE activity_log ADD COLUMN entry_hash TEXT NOT NULL DEFAULT ''")
    conn.execute(
        "INSERT OR IGNORE INTO chain_meta (id, anchor_hash, trimmed) VALUES (1, ?, 0)",
        (GENESIS_HASH,),
    )
    rows = conn.execute(
        "SELECT id, module, action, label, created_at FROM activity_log"
        " WHERE entry_hash = '' ORDER BY id"
    ).fetchall()
    if not rows:
        return
    prev = _tail_hash(conn)
    for row_id, module, action, label, created_at in rows:
        digest = _entry_hash(prev, module, action, label, created_at)
        conn.execute(
            "UPDATE activity_log SET prev_hash = ?, entry_hash = ? WHERE id = ?",
            (prev, digest, row_id),
        )
        prev = digest


def _tail_hash(conn: sqlite3.Connection) -> str:
    """链的当前末端：最后一条已有哈希的记录的 entry_hash；一条都没有就用锚点。"""
    row = conn.execute(
        "SELECT entry_hash FROM activity_log WHERE entry_hash != '' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if row and row[0]:
        return row[0]
    anchor = conn.execute("SELECT anchor_hash FROM chain_meta WHERE id = 1").fetchone()
    return anchor[0] if anchor else GENESIS_HASH


def record(conn: sqlite3.Connection, module: str, action: str, label: str) -> None:
    """追加一条记录并裁剪超出 MAX_ROWS 的旧记录。
    只管写入、不吞异常（吞了会让真 bug 悄悄消失）；调用方按"记不上就算了"自行 try/except。"""
    if module not in MODULES:
        raise ValueError(f"invalid activity_log module: {module!r}")
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    prev = _tail_hash(conn)
    digest = _entry_hash(prev, module, action, label, now)
    conn.execute(
        "INSERT INTO activity_log (module, action, label, created_at, prev_hash, entry_hash)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (module, action, label, now, prev, digest),
    )
    _trim(conn)
    conn.commit()


def _trim(conn: sqlite3.Connection) -> None:
    """裁掉超出 MAX_ROWS 的旧记录，并把锚点推到最后一条被裁掉的那里。
    不推锚点的话，剩下首条的 prev_hash 指向已不存在的记录，verify_chain 会把正常裁剪误报成链断了。"""
    keep = [row[0] for row in conn.execute(
        "SELECT id FROM activity_log ORDER BY id DESC LIMIT ?", (MAX_ROWS,)
    )]
    if not keep:
        return
    oldest_kept = min(keep)
    row = conn.execute(
        "SELECT entry_hash FROM activity_log WHERE id < ? ORDER BY id DESC LIMIT 1",
        (oldest_kept,),
    ).fetchone()
    if row is None:
        return  # 没有要裁的
    cur = conn.execute("DELETE FROM activity_log WHERE id < ?", (oldest_kept,))
    conn.execute(
        "UPDATE chain_meta SET anchor_hash = ?, trimmed = trimmed + ? WHERE id = 1",
        (row[0], cur.rowcount),
    )


def verify_chain(conn: sqlite3.Connection) -> dict:
    """从锚点起逐条重算，检查链是否被动过。

    能查出改内容、删中间项、插入、重排；查不出有人从某处起整段重算（能改数据库就能改哈希），
    那需要把锚点放在库外。返回 {"ok", "checked", "trimmed", "broken_at"}，
    `broken_at` 为第一条对不上的记录 id，完好时为 None。
    """
    meta = conn.execute("SELECT anchor_hash, trimmed FROM chain_meta WHERE id = 1").fetchone()
    prev = meta[0] if meta else GENESIS_HASH
    trimmed = meta[1] if meta else 0
    checked = 0
    for row_id, module, action, label, created_at, stored_prev, stored_hash in conn.execute(
        "SELECT id, module, action, label, created_at, prev_hash, entry_hash"
        " FROM activity_log ORDER BY id"
    ):
        expected = _entry_hash(prev, module, action, label, created_at)
        if stored_prev != prev or stored_hash != expected:
            return {"ok": False, "checked": checked, "trimmed": trimmed, "broken_at": row_id}
        prev = stored_hash
        checked += 1
    return {"ok": True, "checked": checked, "trimmed": trimmed, "broken_at": None}


def fetch_recent(conn: sqlite3.Connection, limit: int = 50) -> List[dict]:
    cur = conn.execute(
        "SELECT id, module, action, label, created_at FROM activity_log ORDER BY id DESC LIMIT ?",
        (limit,),
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def clear_all(conn: sqlite3.Connection) -> None:
    """清空时间线。**锚点跟着回到起点**——用户主动清空是一次合法操作，不该让
    下一次校验因为"锚点指着一条已经不存在的记录"而报断链。"""
    conn.execute("DELETE FROM activity_log")
    conn.execute(
        "UPDATE chain_meta SET anchor_hash = ?, trimmed = 0 WHERE id = 1", (GENESIS_HASH,)
    )
    conn.commit()
