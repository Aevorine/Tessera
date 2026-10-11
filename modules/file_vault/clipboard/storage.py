"""剪贴板历史的 SQLCipher 加密 SQLite 存储，schema 见 task-progress-clipboard.md 第四节。
新增 is_truncated（超大内容只存摘要+提示，不静默失败）和 FTS5 虚拟表 clipboard_history_fts。
密钥管理不在此：调用方传入 32 字节原始密钥（由金库 IMK 派生），便于独立测试。"""

import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from sqlcipher3 import dbapi2 as sqlcipher

from core.logging import get_logger

logger = get_logger(__name__)

SCHEMA_VERSION = "2"

# 内容大小上限——超过就只存摘要,见 fit_text_to_limit / decide should_skip_image_bytes。
# 这两个数字是这一步的实现细节,不是用户方案的一部分,后面如果要做成可配置项再挪到 settings 表。
TEXT_BYTE_LIMIT = 2 * 1024 * 1024  # 2 MiB of UTF-8 text
IMAGE_RAW_BYTE_LIMIT = 20 * 1024 * 1024  # 20 MiB of raw DIB pixel data
# RTF 只是粘回 Office 的兜底附加数据，不是主内容：存不下就丢，体验退回纯文本/HTML，
# 不值得做截断摘要。上限按 Base64 编码前的原始字节算。
RTF_RAW_BYTE_LIMIT = 512 * 1024  # 512 KiB

# 可选设置项键名
SETTING_MAX_ENTRIES = "max_entries"
SETTING_CLEANUP_DAYS = "cleanup_days"
SETTING_CLEANUP_HOURS = "cleanup_hours"
# 敏感条目（由 sensitive_detector 判定）的存活时长，单位分钟，0 = 关闭。
# 与 cleanup_days 互不替代：后者以天计且只是软删除（回收站 7 天），保护不了刚复制的密钥；
# 本条按分钟计且硬删除，回收站里还读得出的密钥等于没删。
SETTING_SENSITIVE_TTL_MINUTES = "sensitive_ttl_minutes"
# 上一次跑完"每日定时清理"的本地日期（YYYY-MM-DD），保证一天只跑一次。
SETTING_LAST_DAILY_CLEANUP = "last_daily_cleanup"

# 设置默认值
DEFAULT_MAX_ENTRIES = 500
DEFAULT_CLEANUP_HOURS = "04:00"  # 每天凌晨 4 点执行清理

# 置顶手工排序（稀疏分数）的间隙常量：取 1024 而非 1，新置顶用 min - STEP 即可排最前、不动其它行，
# 对折插入也有余量（可连续对折 10 次才到 1，REAL 之后还能继续）。
PIN_ORDER_STEP = 1024.0
# 相邻差值小于此数视为间隙将尽，插入前先整段重编号；不等双精度算不出中间值
# （(a+b)/2 会等于 a 或 b，排序未定义）。1e-6 约需连续对折 30 次才触发，属兜底路径。
PIN_ORDER_MIN_GAP = 1e-6


_SCHEMA = """
CREATE TABLE IF NOT EXISTS clipboard_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type  TEXT NOT NULL,
    content_text  TEXT,
    content_format TEXT,
    image_path    TEXT,
    thumbnail_path TEXT,
    source_app    TEXT,
    is_pinned     INTEGER DEFAULT 0,
    is_sensitive  INTEGER DEFAULT 0,
    is_hidden     INTEGER DEFAULT 0,
    is_snippet    INTEGER DEFAULT 0,
    is_deleted    INTEGER DEFAULT 0,
    is_truncated  INTEGER DEFAULT 0,
    content_rtf   TEXT,
    -- 富文本条目的 HTML 源。**跟 content_text 分开存**，这是刻意的：
    -- 剪贴板上同时有 HTML 和纯文本时，以前只读 HTML 并把它塞进 content_text，
    -- 于是粘贴到任何只认纯文本的地方（记事本、代码编辑器、聊天框）出来的是
    -- 一整串带 style= 的源码。顺带还让搜索能匹配到 CSS 属性名、列表预览在渲染
    -- 别人的样式。现在 content_text 永远是**人看的那段字**，HTML 只在粘回
    -- Word/邮件这类目标时才用得上。
    content_html  TEXT,
    copy_count    INTEGER DEFAULT 1,
    -- 置顶内容的手工排序位置（用户拖拽结果）。只对 is_pinned = 1 的行有意义，
    -- 取消置顶时置回 NULL。用 REAL 而不是连续整数是为了让"拖到 A、B 之间"变成
    -- 一次单行 UPDATE：新值取 (A + B) / 2，前后行都不用动。连续整数方案要把
    -- 插入点之后的每一行都 +1，一次拖拽写整表。
    -- 反复对折约 50 次后双精度会耗尽精度（相邻两值相等），所以插入前要检查
    -- 间隙，太小就整段重编号——见 PIN_ORDER_MIN_GAP / renumber_pinned。
    -- 排序方向：值越小越靠前（新置顶的项取 min - PIN_ORDER_STEP，落到最前面）。
    pin_order     REAL,
    -- 内容指纹（sha256 十六进制），用来判断两条记录"是不是同一份内容"。
    -- 存成一列而不是每次比较时现算：去重要在导入的每一条上做一次查询，
    -- 现算意味着把整张表读出来重新哈希一遍——几千条记录 × 每次导入。
    -- 算不出指纹的行（图片文件丢了）留 NULL，**NULL 永远不等于 NULL**，
    -- 正好等于"这条不参与去重"，不需要额外的标志位。
    -- 具体算法见 compute_content_hash。
    content_hash  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist_apps (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_clipboard_history_created_at ON clipboard_history(created_at);
CREATE INDEX IF NOT EXISTS idx_clipboard_history_is_deleted ON clipboard_history(is_deleted);
CREATE INDEX IF NOT EXISTS idx_clipboard_history_is_sensitive ON clipboard_history(is_sensitive);
"""

# pin_order 索引不能放进 _SCHEMA：_SCHEMA 先于列迁移执行，升级中的老库此时没有该列，
# CREATE INDEX 会报 no such column 打断 connect()。故随 ALTER TABLE 放在
# _migrate_clipboard_pin_order_column；用部分索引（WHERE）只覆盖置顶的几十行。
_PIN_ORDER_INDEX = """
CREATE INDEX IF NOT EXISTS idx_clipboard_history_pin_order
    ON clipboard_history(pin_order) WHERE is_pinned = 1 AND is_deleted = 0;
"""

# content_hash 索引同样不能进 _SCHEMA（理由同 pin_order）。做成只覆盖未删除行的部分索引：
# 去重只比对还在列表里的内容，回收站里的重复不该拦下导入，否则删掉又重新导入的内容会静默消失。
_CONTENT_HASH_INDEX = """
CREATE INDEX IF NOT EXISTS idx_clipboard_history_content_hash
    ON clipboard_history(content_hash) WHERE is_deleted = 0;
"""


def _hex_key(key: bytes) -> str:
    return "x'" + key.hex() + "'"


def _col_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    return col in cols


def _migrate_column(conn: sqlite3.Connection, table: str, col: str, definition: str) -> None:
    """Add a column if it doesn't exist. No-op when already present."""
    if _col_exists(conn, table, col):
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")
    conn.commit()


def _migrate_clipboard_hidden_column(conn: sqlite3.Connection) -> None:
    _migrate_column(conn, "clipboard_history", "is_hidden",
                    "is_hidden INTEGER NOT NULL DEFAULT 0")


def _migrate_clipboard_snippet_column(conn: sqlite3.Connection) -> None:
    _migrate_column(conn, "clipboard_history", "is_snippet",
                    "is_snippet INTEGER NOT NULL DEFAULT 0")


def _migrate_clipboard_pin_order_column(conn: sqlite3.Connection) -> None:
    """加 pin_order 列并给已有置顶项初始排序：老库该列全是 NULL，ORDER BY 下 NULL 无序，置顶区会随机
    跳动；
    按默认顺序（id DESC）补分数，保证升级后与升级前一致。"""
    if not _col_exists(conn, "clipboard_history", "pin_order"):
        conn.execute("ALTER TABLE clipboard_history ADD COLUMN pin_order REAL")
        rows = conn.execute(
            "SELECT id FROM clipboard_history WHERE is_pinned = 1 AND is_deleted = 0 ORDER BY id DESC"
        ).fetchall()
        conn.executemany(
            "UPDATE clipboard_history SET pin_order = ? WHERE id = ?",
            [((index + 1) * PIN_ORDER_STEP, row[0]) for index, row in enumerate(rows)],
        )
    # 建索引放在列存在之后，且对新库/老库都要执行（新库走 _SCHEMA 建的表已经带
    # pin_order 列，但索引不在 _SCHEMA 里——见 _PIN_ORDER_INDEX 的注释）。
    conn.executescript(_PIN_ORDER_INDEX)
    conn.commit()


def compute_content_hash(
    *,
    content_type: str,
    content_text: Optional[str] = None,
    content_format: Optional[str] = None,
    content_rtf: Optional[str] = None,
    content_html: Optional[str] = None,
    image_bytes: Optional[bytes] = None,
    image_path: Optional[str] = None,
) -> Optional[str]:
    """算内容指纹，相同指纹视为同一份内容（去重用）。

    只含内容本身，不含 source_app / 时间 / 复制次数 / 置顶隐藏标记。
    富文本的 RTF / HTML 载荷必须进指纹：同样一行 E = mc²，纯文本条与 Word 复制来的条粘贴结果不同，
    判成重复会悄悄丢掉可粘回公式的那份，且预览上看不出。
    字段用长度前缀拼接，否则 ("ab","c") 与 ("a","bc") 同指纹。
    图片按原始字节算而非路径（路径每次保存都不同）；无字节且读不到文件时返回 None，表示不参与去重。
    """
    digest = hashlib.sha256()
    digest.update(content_type.encode("utf-8"))
    for part in (content_text, content_format, content_rtf, content_html):
        raw = b"" if part is None else str(part).encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    if content_type == "image":
        if image_bytes is None and image_path:
            try:
                image_bytes = Path(image_path).read_bytes()
            except OSError:
                # 图片文件不在了（被清理、手删、跨机器搬库）：返回 None 退出去重，
                # 否则"无图"指纹会让两张不同的图撞成同一张。
                return None
        if image_bytes is None:
            return None
        digest.update(len(image_bytes).to_bytes(8, "big"))
        digest.update(image_bytes)
    return digest.hexdigest()


def _migrate_clipboard_content_hash_column(conn: sqlite3.Connection) -> None:
    """加 content_hash 列并给已有行补算指纹：老库该列为 NULL 而 NULL 不参与去重，
    "清理重复项"会对升级前的数据一条都找不出来。图片行需读原文件，读不到留 NULL；
    受 max_entries（默认 500）限制，一次性开销可忽略。"""
    already_had = _col_exists(conn, "clipboard_history", "content_hash")
    _migrate_column(conn, "clipboard_history", "content_hash", "content_hash TEXT")
    if not already_had:
        rows = conn.execute(
            "SELECT id, content_type, content_text, content_format, content_rtf, "
            "content_html, image_path FROM clipboard_history"
        ).fetchall()
        updates = []
        for row_id, ctype, ctext, cformat, crtf, chtml, ipath in rows:
            updates.append(
                (
                    compute_content_hash(
                        content_type=ctype,
                        content_text=ctext,
                        content_format=cformat,
                        content_rtf=crtf,
                        content_html=chtml,
                        image_path=ipath,
                    ),
                    row_id,
                )
            )
        conn.executemany(
            "UPDATE clipboard_history SET content_hash = ? WHERE id = ?", updates
        )
    conn.executescript(_CONTENT_HASH_INDEX)
    conn.commit()


_HTML_TAG_RE = re.compile(r"<[^>]+>")
# 块级标签换成换行，否则 `<p>a</p><p>b</p>` 抽出来会连成 "ab"。
_HTML_BLOCK_RE = re.compile(r"</?(?:p|div|br|tr|li|h[1-6]|table)\b[^>]*>", re.IGNORECASE)
# script/style 连内容一起丢——它们的"文字"是代码，不是给人看的。
_HTML_DROP_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_HTML_ENTITIES = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&#39;": "'", "&apos;": "'",
}


def html_to_plain_text(html: str) -> str:
    """从 HTML 抽出给人看的纯文本。刻意用保守正则而非 HTML 解析库：只要可搜索、可预览、
    可粘进记事本，抽差最坏是多几个空格，HTML 原文仍在 content_html 里。"""
    if not html:
        return ""
    text = _HTML_DROP_RE.sub("", html)
    text = _HTML_BLOCK_RE.sub("\n", text)
    text = _HTML_TAG_RE.sub("", text)
    for entity, char in _HTML_ENTITIES.items():
        text = text.replace(entity, char)
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _migrate_clipboard_rtf_column(conn: sqlite3.Connection) -> None:
    _migrate_column(conn, "clipboard_history", "content_rtf",
                    "content_rtf TEXT")


def _migrate_clipboard_html_column(conn: sqlite3.Connection) -> None:
    """加 content_html 并修正已有富文本行：老库 content_format='rich' 的行，content_text 存的是 HTML
     源码。
    迁移时把 HTML 挪进 content_html，再抽纯文本回填 content_text，使新旧数据一致。
    抽取用保守做法（去标签 + 反转义常见实体，不引第三方解析库），抽错最坏多几个空格，原文没丢。"""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(clipboard_history)").fetchall()}
    if not cols:
        return
    already_had = "content_html" in cols
    _migrate_column(conn, "clipboard_history", "content_html", "content_html TEXT")
    if already_had:
        return
    rows = conn.execute(
        "SELECT id, content_text FROM clipboard_history WHERE content_format = 'rich' AND content_text IS NOT NULL"
    ).fetchall()
    for row_id, html in rows:
        conn.execute(
            "UPDATE clipboard_history SET content_html = ?, content_text = ? WHERE id = ?",
            (html, html_to_plain_text(html), row_id),
        )
    conn.commit()


def _rebuild_fts(conn: sqlite3.Connection) -> None:
    """Rebuild FTS index for existing rows. Safe to call on fresh DB."""
    conn.executescript("""
        CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_history_fts USING fts5(
            content_text, source_app,
            content='clipboard_history',
            content_rowid='id',
            tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS clipboard_history_ai AFTER INSERT ON clipboard_history BEGIN
            INSERT INTO clipboard_history_fts(rowid, content_text, source_app)
            VALUES (new.id, new.content_text, new.source_app);
        END;
        CREATE TRIGGER IF NOT EXISTS clipboard_history_ad AFTER DELETE ON clipboard_history BEGIN
            INSERT INTO clipboard_history_fts(clipboard_history_fts, rowid, content_text, source_app)
            VALUES ('delete', old.id, old.content_text, old.source_app);
        END;
        CREATE TRIGGER IF NOT EXISTS clipboard_history_au AFTER UPDATE ON clipboard_history BEGIN
            INSERT INTO clipboard_history_fts(clipboard_history_fts, rowid, content_text, source_app)
            VALUES ('delete', old.id, old.content_text, old.source_app);
            INSERT INTO clipboard_history_fts(rowid, content_text, source_app)
            VALUES (new.id, new.content_text, new.source_app);
        END;
    """)
    conn.commit()
    # Populate FTS from existing rows (no-op on first run)
    conn.executescript("""
        INSERT OR REPLACE INTO clipboard_history_fts(rowid, content_text, source_app)
        SELECT id, content_text, source_app FROM clipboard_history;
    """)
    conn.commit()


def connect(db_path: Path, key: bytes) -> sqlite3.Connection:
    """打开（必要时创建）加密剪贴板库；`key` 与已有库不符时抛 sqlcipher.DatabaseError，调用方靠它发
    现密钥错误。"""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlcipher.connect(str(db_path), check_same_thread=False)
    conn.execute(f"PRAGMA key = \"{_hex_key(key)}\"")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    # 先建表——migration 函数要求表已存在（依赖 PRAGMA table_info）
    conn.executescript(_SCHEMA)
    # 再跑列迁移（对已有数据库升级，对新数据库无操作）
    _migrate_clipboard_hidden_column(conn)
    _migrate_clipboard_snippet_column(conn)
    _migrate_clipboard_rtf_column(conn)
    _migrate_clipboard_html_column(conn)
    _migrate_clipboard_pin_order_column(conn)
    # 补指纹要放在 _rebuild_fts **之前**：那之后 AFTER UPDATE 触发器就存在了，
    # 一次全表补算会顺带把 FTS 索引整个删一遍再写一遍，纯属白费。
    _migrate_clipboard_content_hash_column(conn)
    # 最后建 FTS（虚表 + 触发器 + 填充已有数据）
    _rebuild_fts(conn)
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    conn.commit()
    return conn


def fit_text_to_limit(text: str) -> tuple[str, bool]:
    """Returns (text_to_store, was_truncated)."""
    encoded = text.encode("utf-8")
    if len(encoded) <= TEXT_BYTE_LIMIT:
        return text, False
    preview = encoded[:200].decode("utf-8", errors="ignore")
    summary = (
        f"{preview}...\n\n[内容过大：共 {len(encoded)} 字节，超过 "
        f"{TEXT_BYTE_LIMIT} 字节上限，仅保存前段摘要]"
    )
    return summary, True


def should_skip_image_bytes(raw_dib_len: int) -> bool:
    return raw_dib_len > IMAGE_RAW_BYTE_LIMIT


def should_skip_rtf_bytes(raw_len: int) -> bool:
    return raw_len > RTF_RAW_BYTE_LIMIT


# --- 查询列快捷方式（所有 SELECT 查询共用同一个列名列表，一处维护）---

_COLS = (
    "id, content_type, content_text, content_format, image_path, thumbnail_path, "
    "source_app, is_pinned, is_sensitive, is_hidden, is_snippet, is_deleted, is_truncated, "
    "copy_count, pin_order, created_at, updated_at"
    # content_rtf / content_html 有意不在此列：列表接口一次渲染几千行，每行拖完整 HTML/RTF 是浪费，
    # 粘回 Word 时才用（fetch_rtf_payload / fetch_html_payload 单取）。导出是例外，见 fetch_all_for_
    # export。
)
# 同一份列表加上 "h." 表前缀——fetch_search 需要跟 clipboard_history_fts 虚表
# JOIN，两边都有同名的 content_text 列，裸列名会报 "ambiguous column name"。
_COLS_H = ", ".join(f"h.{c.strip()}" for c in _COLS.split(","))


def _row_to_dict(cur: sqlite3.Cursor) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def insert_entry(
    conn: sqlite3.Connection,
    *,
    content_type: str,
    content_text: Optional[str] = None,
    content_format: Optional[str] = None,
    content_rtf_b64: Optional[str] = None,
    content_html: Optional[str] = None,
    image_path: Optional[str] = None,
    thumbnail_path: Optional[str] = None,
    source_app: Optional[str] = None,
    is_truncated: bool = False,
    is_pinned: bool = False,
    is_sensitive: bool = False,
    is_hidden: bool = False,
    is_snippet: bool = False,
    copy_count: int = 1,
    created_at: Optional[str] = None,
    updated_at: Optional[str] = None,
    content_hash: Optional[str] = None,
) -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    # 指纹默认现算。调用方**已经拿着图片原始字节**时应当自己算好传进来
    # （导入路径就是这样），否则这里会把刚写下去的 PNG 再读一遍。
    if content_hash is None:
        content_hash = compute_content_hash(
            content_type=content_type,
            content_text=content_text,
            content_format=content_format,
            content_rtf=content_rtf_b64,
            content_html=content_html,
            image_path=image_path,
        )
    cur = conn.execute(
        """
        INSERT INTO clipboard_history
            (content_type, content_text, content_format, content_rtf, content_html, image_path, thumbnail_path,
             source_app, is_truncated, is_pinned, is_sensitive, is_hidden, is_snippet,
             copy_count, created_at, updated_at, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            content_type,
            content_text,
            content_format,
            content_rtf_b64,
            content_html,
            image_path,
            thumbnail_path,
            source_app,
            1 if is_truncated else 0,
            1 if is_pinned else 0,
            1 if is_sensitive else 0,
            1 if is_hidden else 0,
            1 if is_snippet else 0,
            copy_count,
            created_at or now,
            updated_at or now,
            content_hash,
        ),
    )
    conn.commit()
    return cur.lastrowid


def fetch_recent(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    cur = conn.execute(
        f"""
        SELECT {_COLS}
        FROM clipboard_history
        WHERE is_deleted = 0 AND is_snippet = 0
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    )
    return _row_to_dict(cur)


def fetch_snippets(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    cur = conn.execute(
        f"""
        SELECT {_COLS}
        FROM clipboard_history
        WHERE is_deleted = 0 AND is_snippet = 1
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    )
    return _row_to_dict(cur)


def update_snippet_text(conn: sqlite3.Connection, entry_id: int, content_text: str) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE clipboard_history SET content_text = ?, updated_at = ? "
        "WHERE id = ? AND is_snippet = 1 AND is_deleted = 0",
        (content_text, now, entry_id),
    )
    conn.commit()
    return cur.rowcount > 0


def set_pinned(conn: sqlite3.Connection, entry_id: int, pinned: bool) -> bool:
    """置顶/取消置顶：置顶排到手工序最前；取消必须把 pin_order 置回 NULL，
    否则再次置顶会悄悄回到旧位置，还会让部分索引堆积无用行。"""
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    if pinned:
        order = _next_pin_order_front(conn)
        cur = conn.execute(
            "UPDATE clipboard_history SET is_pinned = 1, pin_order = ?, updated_at = ? "
            "WHERE id = ? AND is_deleted = 0",
            (order, now, entry_id),
        )
    else:
        cur = conn.execute(
            "UPDATE clipboard_history SET is_pinned = 0, pin_order = NULL, updated_at = ? "
            "WHERE id = ? AND is_deleted = 0",
            (now, entry_id),
        )
    conn.commit()
    return cur.rowcount > 0


# --- 置顶手工排序 ---------------------------------------------------------


def _next_pin_order_front(conn: sqlite3.Connection) -> float:
    """新置顶项的排序值：当前最小值再减一个步长（越小越靠前）。
    置顶区为空时返回 PIN_ORDER_STEP 而非 0，给"拖到最前"留出向下取值的空间。"""
    row = conn.execute(
        "SELECT MIN(pin_order) FROM clipboard_history "
        "WHERE is_pinned = 1 AND is_deleted = 0 AND pin_order IS NOT NULL"
    ).fetchone()
    current_min = row[0] if row and row[0] is not None else None
    if current_min is None:
        return PIN_ORDER_STEP
    return current_min - PIN_ORDER_STEP


def fetch_pinned_ordered(conn: sqlite3.Connection) -> list[dict]:
    """按手工序返回全部置顶项。`pin_order IS NULL` 的行排最后（SQLite 默认排最前）：
    NULL 只出现在迁移后绕过 set_pinned 的异常路径，放末尾更符合预期，也易在 UI 上被发现。"""
    cur = conn.execute(
        f"""
        SELECT {_COLS}
        FROM clipboard_history
        WHERE is_pinned = 1 AND is_deleted = 0
        ORDER BY pin_order IS NULL, pin_order ASC, id DESC
        """
    )
    return _row_to_dict(cur)


def renumber_pinned(conn: sqlite3.Connection) -> int:
    """按当前顺序把所有置顶项的 pin_order 重排成整齐的 STEP 倍数，返回重编号行数。
    间隙耗尽时的兜底，会写全部置顶行，只在 _pin_order_between 判断间隙不够时调用。"""
    rows = conn.execute(
        "SELECT id FROM clipboard_history WHERE is_pinned = 1 AND is_deleted = 0 "
        "ORDER BY pin_order IS NULL, pin_order ASC, id DESC"
    ).fetchall()
    conn.executemany(
        "UPDATE clipboard_history SET pin_order = ? WHERE id = ?",
        [((index + 1) * PIN_ORDER_STEP, row[0]) for index, row in enumerate(rows)],
    )
    conn.commit()
    return len(rows)


def move_pinned(conn: sqlite3.Connection, entry_id: int, before_id: Optional[int], after_id: Optional[int]) -> Optional[float]:
    """把置顶项 entry_id 移到 before_id（移动后紧邻其上，None = 最前）和 after_id（紧邻其下，
    None = 最后）之间，返回新排序值；entry_id 已被删除/取消置顶则返回 None。
    用相邻项 id 而非下标表达位置：并发（另一窗口取消置顶、监听器插入）会使下标失效，
    而"放在这两条之间"的意图不会；其中一条已不在置顶区时按剩下那条处理。"""
    row = conn.execute(
        "SELECT 1 FROM clipboard_history WHERE id = ? AND is_pinned = 1 AND is_deleted = 0",
        (entry_id,),
    ).fetchone()
    if row is None:
        return None

    new_order = _pin_order_between(conn, entry_id, before_id, after_id)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    conn.execute(
        "UPDATE clipboard_history SET pin_order = ?, updated_at = ? WHERE id = ?",
        (new_order, now, entry_id),
    )
    conn.commit()
    return new_order


def _pin_order_of(conn: sqlite3.Connection, entry_id: Optional[int], exclude_id: int) -> Optional[float]:
    """取某置顶项当前的 pin_order；不存在 / 非置顶 / 就是被移动的那一项则返回 None。
    exclude_id 避免前端算出的邻居包含被拖动项自己，否则边界等于原值，看起来像没移动。"""
    if entry_id is None or entry_id == exclude_id:
        return None
    row = conn.execute(
        "SELECT pin_order FROM clipboard_history "
        "WHERE id = ? AND is_pinned = 1 AND is_deleted = 0 AND pin_order IS NOT NULL",
        (entry_id,),
    ).fetchone()
    return row[0] if row is not None else None


def _prev_pin_order(conn: sqlite3.Connection, anchor: float, exclude_id: int) -> Optional[float]:
    """紧邻 anchor 上方那一项的 pin_order（真实相邻，从库里查，不听调用方的）。"""
    row = conn.execute(
        "SELECT MAX(pin_order) FROM clipboard_history "
        "WHERE is_pinned = 1 AND is_deleted = 0 AND pin_order IS NOT NULL "
        "AND pin_order < ? AND id != ?",
        (anchor, exclude_id),
    ).fetchone()
    return row[0] if row is not None and row[0] is not None else None


def _next_pin_order(conn: sqlite3.Connection, anchor: float, exclude_id: int) -> Optional[float]:
    """紧邻 anchor 下方那一项的 pin_order。"""
    row = conn.execute(
        "SELECT MIN(pin_order) FROM clipboard_history "
        "WHERE is_pinned = 1 AND is_deleted = 0 AND pin_order IS NOT NULL "
        "AND pin_order > ? AND id != ?",
        (anchor, exclude_id),
    ).fetchone()
    return row[0] if row is not None and row[0] is not None else None


def _pin_order_bounds(
    conn: sqlite3.Connection, entry_id: int, before_id: Optional[int], after_id: Optional[int]
) -> tuple[Optional[float], Optional[float]]:
    """把调用方给的两个邻居 id 解析成一对真实相邻的边界值。

    只把其中一个当锚点，另一边从库里现查真正紧邻它的项，不采信两个 id 确实相邻：
    若中间其实夹着别的项（前端状态过期等），直接取 (before + after) / 2 每次得同一个中点，
    多次拖拽后多项 pin_order 相同、排序未定义。
    优先用 after_id 当锚点（拖放语义是"放到这一项之前"），不可用时退回 before_id；
    都不可用返回 (None, None)，由调用方决定。
    """
    anchor_after = _pin_order_of(conn, after_id, entry_id)
    if anchor_after is not None:
        return _prev_pin_order(conn, anchor_after, entry_id), anchor_after

    anchor_before = _pin_order_of(conn, before_id, entry_id)
    if anchor_before is not None:
        return anchor_before, _next_pin_order(conn, anchor_before, entry_id)

    return None, None


def _pin_order_between(
    conn: sqlite3.Connection, entry_id: int, before_id: Optional[int], after_id: Optional[int]
) -> float:
    before, after = _pin_order_bounds(conn, entry_id, before_id, after_id)

    if before is not None and after is not None:
        if after - before < PIN_ORDER_MIN_GAP:
            # 间隙将尽：整段重编号（保持顺序不变，数值恢复为整齐的 STEP 倍数）后重新解析边界。
            renumber_pinned(conn)
            before, after = _pin_order_bounds(conn, entry_id, before_id, after_id)
            if before is None or after is None:
                # 重编号过程中锚点消失（另一个窗口取消了置顶）——退化成"移到最前"
                return _next_pin_order_front(conn)
        midpoint = (before + after) / 2.0
        if midpoint <= before or midpoint >= after:
            # 双精度已经算不出严格居中的值了（MIN_GAP 之外的最后一道防线）。
            # 落在边界上等于跟邻居撞成同一个排序值，绝不能写进去。
            renumber_pinned(conn)
            before, after = _pin_order_bounds(conn, entry_id, before_id, after_id)
            if before is None or after is None:
                return _next_pin_order_front(conn)
            return (before + after) / 2.0
        return midpoint

    if after is not None:
        # 只有下邻居 → 移到最前面
        return after - PIN_ORDER_STEP
    if before is not None:
        # 只有上邻居 → 移到最后面
        return before + PIN_ORDER_STEP
    # 两个邻居都没有（置顶区只剩这一项）——保持一个确定的值，不留 NULL
    return PIN_ORDER_STEP


def set_hidden(conn: sqlite3.Connection, entry_id: int, hidden: bool) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE clipboard_history SET is_hidden = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
        (1 if hidden else 0, now, entry_id),
    )
    conn.commit()
    return cur.rowcount > 0


def fetch_one(conn: sqlite3.Connection, entry_id: int) -> Optional[dict]:
    cur = conn.execute(f"SELECT {_COLS} FROM clipboard_history WHERE id = ?", (entry_id,))
    row = cur.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))



def fetch_rtf_payload(conn: sqlite3.Connection, entry_id: int) -> Optional[str]:
    cur = conn.execute("SELECT content_rtf FROM clipboard_history WHERE id = ?", (entry_id,))
    row = cur.fetchone()
    return row[0] if row else None


def fetch_html_payload(conn: sqlite3.Connection, entry_id: int) -> Optional[str]:
    """按 id 取富文本条目的 HTML 源；与 fetch_rtf_payload 一样单取、不进列表接口（粘回 Word 时才用）
    。"""
    cur = conn.execute("SELECT content_html FROM clipboard_history WHERE id = ?", (entry_id,))
    row = cur.fetchone()
    return row[0] if row else None


# --- 全文搜索（FTS5）---


# 不用空格分词的文字（汉字、假名、泰文）。命中这些字符时光靠 FTS5 的 MATCH
# 搜不全——理由和 notes/storage.py 的 _needs_substring_pass 完全一样。
_UNSEGMENTED_SCRIPT_RE = re.compile("[㐀-䶿一-鿿豈-﫿぀-ヿ฀-๿]")


def _like_escape(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def fetch_search(conn: sqlite3.Connection, query: str, limit: int = 50) -> list[dict]:
    """用 FTS5 全文搜索剪贴板历史，只返回未删除的非片段行。
    语法：词默认 AND，`OR` 为或，后缀 `*` 前缀匹配，双引号短语精确匹配。

    含中日泰文的查询会额外做一遍子串匹配再并入结果：`unicode61` 把无标点的中文整段当一个 token，
    只靠 MATCH 搜不到"预算"，表现为复制过的东西搜不到且不报错。
    """
    if not query or not query.strip():
        return fetch_recent(conn, limit=limit)
    stripped = query.strip()
    rows: list[dict] = []
    try:
        cur = conn.execute(
            f"""
            SELECT {_COLS_H}
            FROM clipboard_history_fts f
            JOIN clipboard_history h ON h.id = f.rowid
            WHERE clipboard_history_fts MATCH ?
              AND h.is_deleted = 0 AND h.is_snippet = 0
            ORDER BY rank
            LIMIT ?
            """,
            (stripped, limit),
        )
        rows = _row_to_dict(cur)
    except sqlcipher.DatabaseError as exc:
        # 用户输入的 `(`、`AND`、`*` 都是 FTS5 语法。语法不合法时不回落到 fetch_recent
        # （会把最近几条当成命中项），交给下面的子串匹配，它对任何输入都成立。
        logger.warning("FTS search query failed (invalid syntax?): %s", exc)
        rows = []
        if not _UNSEGMENTED_SCRIPT_RE.search(stripped):
            return _substring_search(conn, stripped, limit)

    if not _UNSEGMENTED_SCRIPT_RE.search(stripped):
        return rows

    seen = {row["id"] for row in rows}
    for row in _substring_search(conn, stripped, limit):
        if row["id"] not in seen:
            seen.add(row["id"])
            rows.append(row)
    return rows[:limit]


def _substring_search(conn: sqlite3.Connection, query: str, limit: int) -> list[dict]:
    """按子串搜正文和来源程序名，词之间 AND（对齐 FTS5）。直接查 clipboard_history 而非 FTS 表：
    后者是 external content，文本本就在源表里。"""
    conditions = ["h.is_deleted = 0", "h.is_snippet = 0"]
    params: list = []
    for term in query.split():
        conditions.append("(h.content_text LIKE ? ESCAPE '\\' OR h.source_app LIKE ? ESCAPE '\\')")
        pattern = f"%{_like_escape(term)}%"
        params.extend([pattern, pattern])
    cur = conn.execute(
        f"SELECT {_COLS_H} FROM clipboard_history h WHERE {' AND '.join(conditions)} ORDER BY h.id DESC LIMIT ?",
        (*params, limit),
    )
    return _row_to_dict(cur)


# --- 软删除 / 回收站 ---


def soft_delete(conn: sqlite3.Connection, entry_id: int) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE clipboard_history SET is_deleted = 1, is_pinned = 0, pin_order = NULL, updated_at = ? WHERE id = ? AND is_deleted = 0",
        (now, entry_id),
    )
    conn.commit()
    return cur.rowcount > 0


def soft_delete_bulk(conn: sqlite3.Connection, entry_ids: list[int]) -> int:
    if not entry_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in entry_ids)
    cur = conn.execute(
        f"UPDATE clipboard_history SET is_deleted = 1, is_pinned = 0, pin_order = NULL, updated_at = ? "
        f"WHERE id IN ({placeholders}) AND is_deleted = 0",
        (now, *entry_ids),
    )
    conn.commit()
    return cur.rowcount


def restore(conn: sqlite3.Connection, entry_id: int) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE clipboard_history SET is_deleted = 0, updated_at = ? WHERE id = ? AND is_deleted = 1",
        (now, entry_id),
    )
    conn.commit()
    return cur.rowcount > 0


def restore_bulk(conn: sqlite3.Connection, entry_ids: list[int]) -> int:
    if not entry_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in entry_ids)
    cur = conn.execute(
        f"UPDATE clipboard_history SET is_deleted = 0, updated_at = ? "
        f"WHERE id IN ({placeholders}) AND is_deleted = 1",
        (now, *entry_ids),
    )
    conn.commit()
    return cur.rowcount


def hard_delete(conn: sqlite3.Connection, entry_id: int) -> tuple[bool, Optional[str], Optional[str]]:
    cur = conn.execute(
        "SELECT image_path, thumbnail_path FROM clipboard_history WHERE id = ?", (entry_id,)
    )
    row = cur.fetchone()
    image_path, thumbnail_path = row if row else (None, None)
    cur = conn.execute("DELETE FROM clipboard_history WHERE id = ?", (entry_id,))
    conn.commit()
    return cur.rowcount > 0, image_path, thumbnail_path


def hard_delete_bulk(conn: sqlite3.Connection, entry_ids: list[int]) -> list[dict]:
    if not entry_ids:
        return []
    placeholders = ",".join("?" for _ in entry_ids)
    cur = conn.execute(
        f"SELECT id, image_path, thumbnail_path FROM clipboard_history WHERE id IN ({placeholders})",
        entry_ids,
    )
    rows = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
    if rows:
        conn.execute(f"DELETE FROM clipboard_history WHERE id IN ({placeholders})", entry_ids)
        conn.commit()
    return rows


def fetch_deleted(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    cur = conn.execute(
        f"""
        SELECT {_COLS}
        FROM clipboard_history
        WHERE is_deleted = 1
        ORDER BY updated_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return _row_to_dict(cur)


def purge_expired_deleted(conn: sqlite3.Connection, days: int = 7) -> list[dict]:
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - days * 86400))
    cur = conn.execute(
        """
        SELECT id, image_path, thumbnail_path FROM clipboard_history
        WHERE is_deleted = 1 AND updated_at < ?
        """,
        (cutoff,),
    )
    rows = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
    if rows:
        conn.executemany("DELETE FROM clipboard_history WHERE id = ?", [(r["id"],) for r in rows])
        conn.commit()
    return rows


# --- 按最大条目数清理（用于超限自动清理）---


def enforce_max_entries(conn: sqlite3.Connection, max_entries: Optional[int] = None) -> int:
    """历史超过 max_entries 时硬删除最旧的条目，不动置顶、隐藏和片段；返回删除条数。"""
    if max_entries is None:
        max_entries = get_setting_int(conn, SETTING_MAX_ENTRIES, DEFAULT_MAX_ENTRIES)
    # 片段（is_snippet）是用户保存的模板，不算历史（同 fetch_recent 口径），不能占配额，
    # 否则片段越多真实历史被挤得越狠。
    cur = conn.execute("SELECT COUNT(*) FROM clipboard_history WHERE is_deleted = 0 AND is_snippet = 0")
    total = cur.fetchone()[0]
    if total <= max_entries:
        return 0
    excess = total - max_entries
    # Find the oldest non-pinned, non-hidden, non-snippet, non-deleted ids to remove
    cur = conn.execute(
        """
        SELECT id, image_path, thumbnail_path FROM clipboard_history
        WHERE is_deleted = 0 AND is_pinned = 0 AND is_hidden = 0 AND is_snippet = 0
        ORDER BY id ASC
        LIMIT ?
        """,
        (excess,),
    )
    to_remove = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
    if not to_remove:
        return 0
    ids = [r["id"] for r in to_remove]
    placeholders = ",".join("?" for _ in ids)
    conn.execute(f"DELETE FROM clipboard_history WHERE id IN ({placeholders})", ids)
    conn.commit()
    logger.info("auto-cleanup: removed %d oldest entries (total %d, max %d)",
                len(to_remove), total, max_entries)
    return len(to_remove)


def enforce_age_cleanup(conn: sqlite3.Connection, cleanup_days: Optional[int] = None) -> int:
    """把超过 cleanup_days 的活跃条目软删除进回收站（0/未设置 = 不清理；置顶/隐藏/片段豁免，
    同 enforce_max_entries），TRASH_RETENTION_DAYS 后由 purge_expired_deleted 彻底删除；返回移动条数
    。"""
    if cleanup_days is None:
        cleanup_days = get_setting_int(conn, SETTING_CLEANUP_DAYS, 0)
    if cleanup_days <= 0:
        return 0
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - cleanup_days * 86400))
    cur = conn.execute(
        """
        SELECT id FROM clipboard_history
        WHERE is_deleted = 0 AND is_pinned = 0 AND is_hidden = 0 AND is_snippet = 0
          AND created_at < ?
        """,
        (cutoff,),
    )
    ids = [row[0] for row in cur.fetchall()]
    if not ids:
        return 0
    return soft_delete_bulk(conn, ids)


def purge_expired_sensitive(
    conn: sqlite3.Connection, ttl_minutes: Optional[int] = None
) -> list[dict]:
    """彻底抹掉超过存活时长的敏感条目，返回被删的行（含图片/缩略图路径，文件由调用方删）；
    0 / 未设置 = 关闭，返回空列表。与其它清理规则不同，三点都是故意的：
    1. 硬删除，不进回收站：回收站里还读得出的 API Key 等于没删。
    2. 回收站里的副本也一并抹，所以不筛 is_deleted。
    3. 置顶和片段豁免（用户明确要留的），豁免写在 SQL 里而不靠调用方记得筛。
    """
    if ttl_minutes is None:
        ttl_minutes = get_setting_int(conn, SETTING_SENSITIVE_TTL_MINUTES, 0)
    if ttl_minutes <= 0:
        return []
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - ttl_minutes * 60))
    cur = conn.execute(
        """
        SELECT id, image_path, thumbnail_path FROM clipboard_history
        WHERE is_sensitive = 1 AND is_pinned = 0 AND is_snippet = 0
          AND created_at < ?
        """,
        (cutoff,),
    )
    rows = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
    if rows:
        conn.executemany("DELETE FROM clipboard_history WHERE id = ?", [(r["id"],) for r in rows])
        conn.commit()
    return rows


def due_for_daily_cleanup(conn: sqlite3.Connection, now=None) -> bool:
    """现在该不该跑"每天 HH:MM 的定时清理"。

    cleanup_hours 以前没有任何地方读它去安排清理（只在服务启动时跑一次），能改能存却不生效。
    判据是"今天的 HH:MM 已过且今天还没跑过"：按本地日期而非"距上次满 24 小时"，
    墙上时钟的概念在跨夏令时或改系统时间时才不漂。
    """
    raw = get_setting(conn, SETTING_CLEANUP_HOURS, DEFAULT_CLEANUP_HOURS) or DEFAULT_CLEANUP_HOURS
    try:
        hh, mm = int(raw[:2]), int(raw[3:5])
    except (ValueError, IndexError):
        hh, mm = 4, 0
    tm = now or time.localtime()
    if (tm.tm_hour, tm.tm_min) < (hh, mm):
        return False
    return get_setting(conn, SETTING_LAST_DAILY_CLEANUP) != time.strftime("%Y-%m-%d", tm)


def mark_daily_cleanup_done(conn: sqlite3.Connection, now=None) -> None:
    set_setting(conn, SETTING_LAST_DAILY_CLEANUP, time.strftime("%Y-%m-%d", now or time.localtime()))


# --- 应用黑名单 ---


def list_blacklist(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.execute("SELECT id, app_name FROM blacklist_apps ORDER BY app_name")
    return [{"id": row[0], "app_name": row[1]} for row in cur.fetchall()]


def add_blacklist(conn: sqlite3.Connection, app_name: str) -> dict:
    cur = conn.execute("INSERT INTO blacklist_apps (app_name) VALUES (?)", (app_name,))
    conn.commit()
    return {"id": cur.lastrowid, "app_name": app_name}


def remove_blacklist(conn: sqlite3.Connection, entry_id: int) -> bool:
    cur = conn.execute("DELETE FROM blacklist_apps WHERE id = ?", (entry_id,))
    conn.commit()
    return cur.rowcount > 0


def is_blacklisted(conn: sqlite3.Connection, app_name: Optional[str]) -> bool:
    if not app_name:
        return False
    cur = conn.execute(
        "SELECT 1 FROM blacklist_apps WHERE lower(app_name) = lower(?) LIMIT 1", (app_name,)
    )
    return cur.fetchone() is not None


# --- 设置读写（settings 表）---


def get_setting(conn: sqlite3.Connection, key: str, default: Optional[str] = None) -> Optional[str]:
    cur = conn.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = cur.fetchone()
    return row[0] if row else default


def get_setting_int(conn: sqlite3.Connection, key: str, default: int) -> int:
    val = get_setting(conn, key)
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value)
    )
    conn.commit()


def get_all_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return all non-schema-version settings as a flat dict, with defaults
    for any unset key. Used by the UI settings page."""
    return {
        "max_entries": get_setting_int(conn, SETTING_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
        "cleanup_days": get_setting_int(conn, SETTING_CLEANUP_DAYS, 0),
        "cleanup_hours": get_setting(conn, SETTING_CLEANUP_HOURS, DEFAULT_CLEANUP_HOURS),
        "sensitive_ttl_minutes": get_setting_int(conn, SETTING_SENSITIVE_TTL_MINUTES, 0),
    }


def update_settings(conn: sqlite3.Connection, updates: dict[str, Any]) -> None:
    """Apply user-facing settings changes. Accepts a partial dict; only the
    provided keys are written. Validates values before committing."""
    for key, value in updates.items():
        if key == "max_entries":
            clamped = max(50, min(5000, int(value)))
            set_setting(conn, SETTING_MAX_ENTRIES, str(clamped))
        elif key == "cleanup_days":
            clamped = max(0, min(365, int(value)))
            set_setting(conn, SETTING_CLEANUP_DAYS, str(clamped))
        elif key == "cleanup_hours":
            # 必须符合 HH:MM 格式
            val = str(value).strip()
            if len(val) == 5 and val[2] == ":":
                hh, mm = val[:2], val[3:]
                if hh.isdigit() and mm.isdigit() and 0 <= int(hh) < 24 and 0 <= int(mm) < 60:
                    set_setting(conn, SETTING_CLEANUP_HOURS, val)
        elif key == "sensitive_ttl_minutes":
            # 上限 1440 分钟（一天）。再长就该用 cleanup_days 那条规则了，而不是
            # 让"自动过期"这个名字承诺一件它其实不擅长的事。
            clamped = max(0, min(1440, int(value)))
            set_setting(conn, SETTING_SENSITIVE_TTL_MINUTES, str(clamped))
        # 其他未知 key 静默忽略，不做硬异常——让未来的扩展可以安全追加设置


# 去重：导入（find_live_duplicate，命中只并标记）和"清理重复项"（find_duplicate_groups 预览，
# 确认后 merge_duplicates）共用 compute_content_hash 的判定，且只跟未删除的行比：
# 回收站里的重复不参与，否则删掉又重新导入的内容会"导入成功却没多出来"。


def find_live_duplicate(
    conn: sqlite3.Connection, content_hash: Optional[str], *, is_snippet: bool = False
) -> Optional[int]:
    """按内容指纹找一条还在列表里的同款记录，返回其 id；指纹为空（算不出的图片行）返回 None，不参与
    去重。
    is_snippet 参与匹配：片段与历史在不同列表，合并会让历史记录莫名跳进片段列表，两边各自去重。"""
    if not content_hash:
        return None
    row = conn.execute(
        "SELECT id FROM clipboard_history "
        "WHERE content_hash = ? AND is_deleted = 0 AND is_snippet = ? "
        "ORDER BY id LIMIT 1",
        (content_hash, 1 if is_snippet else 0),
    ).fetchone()
    return row[0] if row else None


def merge_entry_flags(
    conn: sqlite3.Connection, entry_id: int, *, pinned: bool = False, hidden: bool = False
) -> bool:
    """把重复项的置顶/隐藏标记并到保留的那条上，返回是否真的改了。

    只开不关：已有那条代表用户此刻状态，导入旧备份不应取消他现在置顶的内容；
    备份里标了而本机没标的要补上，否则"跳过重复"会悄悄丢掉用户意图。
    置顶走 set_pinned 而非直接 UPDATE，才能同时得到 pin_order，否则置顶区顺序随机。
    """
    row = conn.execute(
        "SELECT is_pinned, is_hidden FROM clipboard_history WHERE id = ? AND is_deleted = 0",
        (entry_id,),
    ).fetchone()
    if row is None:
        return False
    changed = False
    if pinned and not row[0]:
        set_pinned(conn, entry_id, True)
        changed = True
    if hidden and not row[1]:
        set_hidden(conn, entry_id, True)
        changed = True
    return changed


def _pick_keeper(members: list[tuple]) -> int:
    """一组重复里保留哪条。members 是 (id, is_pinned) 元组。
    优先留已置顶的（带着手工拖出的 pin_order，免得置顶区顺序跳动）；都没置顶则留 id 最小的，
    保住最早的 created_at。"""
    pinned = [m[0] for m in members if m[1]]
    return min(pinned) if pinned else min(m[0] for m in members)


def find_duplicate_groups(conn: sqlite3.Connection, *, preview_chars: int = 80) -> list[dict]:
    """列出所有重复组供"清理重复项"对话框预览：每组保留哪条、合并几条、合并后标记、预览文字。
    这是删东西，必须先给用户看再动手。

    指纹为 NULL 的行（图片文件丢了）靠两道独立防线排除：这里的 `content_hash IS NOT NULL`，
    以及按 `content_hash = ?` 取成员时 SQL 的 `= NULL` 恒为假。GROUP BY 把 NULL 归一组而 `=` 不匹配
    NULL，
    方向相反，只靠一条的话改动另一处会悄悄失效，导致互不相干的丢失图片被合并进回收站。
    """
    groups = conn.execute(
        """
        SELECT content_hash, is_snippet, COUNT(*) AS n
        FROM clipboard_history
        WHERE is_deleted = 0 AND content_hash IS NOT NULL
        GROUP BY content_hash, is_snippet
        HAVING n > 1
        ORDER BY n DESC, MIN(id)
        """
    ).fetchall()
    result: list[dict] = []
    for content_hash, is_snippet, count in groups:
        rows = conn.execute(
            "SELECT id, is_pinned, is_hidden, content_type, content_text "
            "FROM clipboard_history "
            "WHERE content_hash = ? AND is_snippet = ? AND is_deleted = 0 "
            "ORDER BY id",
            (content_hash, is_snippet),
        ).fetchall()
        if len(rows) < 2:
            continue
        keep_id = _pick_keeper([(r[0], r[1]) for r in rows])
        text = next((r[4] for r in rows if r[4]), None) or ""
        preview = text[:preview_chars]
        result.append(
            {
                "content_hash": content_hash,
                "is_snippet": bool(is_snippet),
                "count": count,
                "keep_id": keep_id,
                "merge_ids": [r[0] for r in rows if r[0] != keep_id],
                "content_type": rows[0][3],
                "preview": preview,
                "is_pinned": any(bool(r[1]) for r in rows),
                "is_hidden": any(bool(r[2]) for r in rows),
            }
        )
    return result


def find_near_duplicate_groups(conn: sqlite3.Connection, *, preview_chars: int = 80) -> list[dict]:
    """返回形状同 find_duplicate_groups，但按近似度分组；口径同精确去重（只看未删除的文字条目），
    判定见 near_dup.py。组标识用 keep_id 而非内容哈希（近似组里每条哈希都不同），前端与 merge 用同一
    个键。"""
    from modules.file_vault.clipboard import near_dup

    rows = conn.execute(
        "SELECT id, is_pinned, is_hidden, content_type, content_text FROM clipboard_history"
        " WHERE is_deleted = 0 AND content_type != 'image' AND content_text IS NOT NULL"
        " ORDER BY id"
    ).fetchall()
    by_id = {r[0]: r for r in rows}
    # 精确重复交给 find_duplicate_groups，这里把它们排掉，免得同一组在两个
    # 对话框里各出现一次——用户会以为是两组，合并完发现只少了一批。
    exact_ids = set()
    for group in find_duplicate_groups(conn, preview_chars=1):
        exact_ids.update(group["merge_ids"])

    groups = near_dup.group_near_duplicates(
        [(r[0], r[4]) for r in rows if r[0] not in exact_ids]
    )
    result: list[dict] = []
    for members in groups:
        member_rows = [by_id[i] for i in members if i in by_id]
        if len(member_rows) < 2:
            continue
        keep_id = _pick_keeper([(r[0], r[1]) for r in member_rows])
        text = next((r[4] for r in member_rows if r[4]), None) or ""
        result.append(
            {
                "keep_id": keep_id,
                "count": len(member_rows),
                "merge_ids": [r[0] for r in member_rows if r[0] != keep_id],
                "content_type": member_rows[0][3],
                "preview": text[:preview_chars],
                "is_pinned": any(bool(r[1]) for r in member_rows),
                "is_hidden": any(bool(r[2]) for r in member_rows),
            }
        )
    return result


def merge_near_duplicates(conn: sqlite3.Connection, keep_ids: Optional[list] = None) -> dict:
    """按 keep_id 合并近似组，软删除留后悔路。`keep_ids` None = 全部，列表 = 只合并所列组；
    空列表是用户一组都没选，应合并 0 条，绝不能当成不筛而合并整库（同 merge_duplicates 和导出）。"""
    if keep_ids is not None and not keep_ids:
        return {"groups": 0, "merged": 0}
    selected = None if keep_ids is None else set(keep_ids)
    groups = merged = 0
    for group in find_near_duplicate_groups(conn):
        if selected is not None and group["keep_id"] not in selected:
            continue
        merge_entry_flags(conn, group["keep_id"], pinned=group["is_pinned"], hidden=group["is_hidden"])
        merged += soft_delete_bulk(conn, group["merge_ids"])
        groups += 1
    return {"groups": groups, "merged": merged}


def merge_duplicates(
    conn: sqlite3.Connection, content_hashes: Optional[list[str]] = None
) -> dict:
    """合并重复组：每组留一条并并入标记，其余软删除进回收站（一次点击批量消失，留后悔路；
    回收站行不参与去重，不会干扰下次导入）。
    `content_hashes` None = 全部，列表 = 只合并所列组；空列表是用户一组都没选，
    应合并 0 条，绝不能当成不筛而合并整库。"""
    if content_hashes is not None and not content_hashes:
        return {"groups": 0, "merged": 0}
    selected = None if content_hashes is None else set(content_hashes)
    groups = 0
    merged = 0
    for group in find_duplicate_groups(conn):
        if selected is not None and group["content_hash"] not in selected:
            continue
        merge_entry_flags(
            conn, group["keep_id"], pinned=group["is_pinned"], hidden=group["is_hidden"]
        )
        merged += soft_delete_bulk(conn, group["merge_ids"])
        groups += 1
    return {"groups": groups, "merged": merged}


# --- 导出 / 导入（JSON，方便换电脑迁移历史记录）---


def fetch_all_for_export(
    conn: sqlite3.Connection,
    *,
    only_pinned: bool = False,
    only_hidden: bool = False,
    ids: Optional[list] = None,
) -> list[dict]:
    """导出用的行；三个筛选条件为与关系，都不传即全部。
    `ids` 的 None（不按 id 筛）与空列表（用户一条都没勾，应导出 0 条）不同；
    写成 `if ids:` 会把没勾选当成不筛而导出整库，是静默的严重错误。"""
    where = ["is_deleted = 0"]
    args: list = []
    if only_pinned:
        where.append("is_pinned = 1")
    if only_hidden:
        where.append("is_hidden = 1")
    if ids is not None:
        if not ids:
            return []
        where.append(f"id IN ({','.join('?' * len(ids))})")
        args.extend(ids)
    # 比 _COLS 多 RTF 和 HTML 两列。列表接口不该为几千行各拖完整标记，但导出必须带上，
    # 否则导出再导入后格式全丢（Word 公式粘回变纯文本），且不报错，用户粘贴时才发现，那时原记录可能
    # 已被清理。
    cur = conn.execute(
        f"""
        SELECT {_COLS}, content_rtf, content_html
        FROM clipboard_history
        WHERE {' AND '.join(where)}
        ORDER BY id
        """,
        args,
    )
    return _row_to_dict(cur)
