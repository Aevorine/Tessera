"""SQLCipher-encrypted SQLite storage for the TXT notes module.

Same pattern as clipboard/storage.py: opens a database from a raw 32-byte key (derived from the
Vault IMK by backend_server.py) and doesn't know where the key comes from.
- List reads never return the full `content` column; the UI fetches it with `fetch_one` on open.
- Soft delete + 7-day trash, plus explicit hard_delete/hard_delete_bulk.
- No truncation on save (unlike clipboard): that would silently lose authored data.
  NOTE_BYTE_LIMIT is only a sanity ceiling against pathological input.
"""

import re
import sqlite3
import time
from pathlib import Path
from typing import NoReturn, Optional

from sqlcipher3 import dbapi2 as sqlcipher

from modules.file_vault import errors
from modules.file_vault.notes import category_paths

SCHEMA_VERSION = "1"

# Sanity ceiling only, to fail fast on pathological input (e.g. multi-GB binary-as-text). 2 GiB so
# legit large disk_plain imports pass; the chunked RPCs in notes/service.py make that size viable.
NOTE_BYTE_LIMIT = 2 * 1024 * 1024 * 1024

# Sanity ceiling for images: covers real photos without bloating the encrypted database.
NOTE_IMAGE_BYTE_LIMIT = 20 * 1024 * 1024

PREVIEW_CHARS = 200

# 修改时间线单条记录的正文快照上限，超过只记标题/分类/长度，否则大笔记每次保存都整篇复制进库。
# 与 service._FTS_INDEX_MAX_BYTES 同值但各自独立。
REVISION_CONTENT_LIMIT = 2 * 1024 * 1024
# 每篇笔记最多留多少条修改记录，超出从旧的删（最早那条 baseline/create 保留）。
MAX_REVISIONS_PER_NOTE = 200
_REVISION_LIST_COLUMNS = "id, note_id, kind, batch_id, title, category, content_length, has_content, summary, created_at"

_IMAGE_LIST_COLUMNS = "id, note_id, mime_type, byte_size, created_at, storage_mode, thumbnail_data, thumbnail_path"
_IMAGE_FULL_COLUMNS = "id, note_id, mime_type, byte_size, created_at, storage_mode, image_data, image_path"
_IMAGE_PATH_COLUMNS = "id, storage_mode, image_path, thumbnail_path"

# linked_path 只对关联笔记给出（那是用户自己的文件位置）；disk_plain 的内部路径不外露。
_LIST_COLUMNS = (
    "id, title, category, preview, content_length, content_storage_mode, format, is_pinned, is_hidden, "
    "is_deleted, sort_order, created_at, updated_at, is_linked, "
    "CASE WHEN is_linked = 1 THEN content_path END AS linked_path"
)
_FULL_COLUMNS = (
    "id, title, category, content, content_storage_mode, content_path, format, preview, content_length, "
    "is_pinned, is_hidden, is_deleted, sort_order, created_at, updated_at, "
    "is_linked, linked_encoding, linked_newline, linked_mtime, linked_folder_id"
)
_LINKED_FOLDER_COLUMNS = "id, path, category, is_hidden, created_at"

# 排序模式 → ORDER BY 片段。列带 `notes.` 前缀，列表与搜索（`notes_fts JOIN notes`）共用一份。
# 四个模式都以 is_pinned DESC 打头（置顶不是一种排序），末尾兜 notes.id DESC 作决胜键：
# updated_at 精度只到秒、title 会重名、sort_order 默认全 0，没有它并列行顺序不保证，翻页会跳。
_SORT_CLAUSES = {
    # 默认。等价于改动前全库硬编码的那句，升级上来的用户看到的顺序一模一样。
    "created": "ORDER BY notes.is_pinned DESC, notes.id DESC",
    "updated": "ORDER BY notes.is_pinned DESC, notes.updated_at DESC, notes.id DESC",
    "title": "ORDER BY notes.is_pinned DESC, notes.title COLLATE NOCASE ASC, notes.id DESC",
    # sort_order 默认 0、reorder 从 1 开始发号，所以「还没被手动摆过的笔记」
    # （含新建的）自然浮在最上面，而不是掉进队尾让人找不到。
    "manual": "ORDER BY notes.is_pinned DESC, notes.sort_order ASC, notes.id DESC",
}
SORT_MODES = tuple(_SORT_CLAUSES)
DEFAULT_SORT_MODE = "created"


def order_clause(sort: Optional[str]) -> str:
    """Unknown/None 一律退回默认排序而不是抛错：排序是显示偏好，一个存坏的
    偏好值不该让笔记列表整个打不开。"""
    return _SORT_CLAUSES.get(sort or "", _SORT_CLAUSES[DEFAULT_SORT_MODE])

_SCHEMA = """
-- 一张极小的「这条笔记现在是第几版」旁表，外加三个触发器保持同步。
--
-- 为什么需要它：SQLite 按列顺序存记录，读一个**排在超大列后面**的列，要先把那
-- 个大列的溢出页链整条走完。`content` 是第 4 列，`updated_at`/`is_deleted` 都排
-- 在它后面——于是"只想知道这条笔记有没有变"也要付几乎等于读全文的代价。
-- 4 MB 的笔记实测：SELECT id 是 0.0 ms、SELECT title 是 0.0 ms，
-- 而 SELECT updated_at 要 37.4 ms、SELECT content 要 48.4 ms。
--
-- 分段读一篇大笔记要来回几十次，每次都付这 37 ms，就是"大笔记翻页发涩"的来源。
-- 有了这张旁表之后，那一步变成对一个整数主键的点查。
--
-- **用触发器而不是在写路径里手工维护**：写笔记的路径有十几条（新建、更新、
-- 分块写、导入、批量删、恢复、硬删…），手工维护漏掉任何一条的表现都是缓存
-- 读到旧内容——而旧内容在界面上跟对的内容长得一模一样，不报任何错。触发器
-- 由 SQLite 保证"只要 notes 变了就一定跟着变"，忘不掉。
CREATE TABLE IF NOT EXISTS note_version (
    note_id      INTEGER PRIMARY KEY,
    version      INTEGER NOT NULL,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    storage_mode TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL DEFAULT '',
    category       TEXT NOT NULL DEFAULT '',
    content        TEXT NOT NULL DEFAULT '',
    -- 正文实际落在哪 - 跟 note_images.storage_mode 同一套模式：'encrypted_db'
    -- （默认）时 content 列本身就是正文，享受整库 SQLCipher 加密；'disk_plain'
    -- 时 content 列固定存空字符串，正文改存成 content_path 指向的磁盘明文
    -- .txt 文件（notes/service.py 负责实际读写文件，本表只记路径）。每条
    -- 笔记创建时选定，之后不再改变（跟图片的存储模式选择同一个不可变模型）。
    content_storage_mode TEXT NOT NULL DEFAULT 'encrypted_db' CHECK (content_storage_mode IN ('encrypted_db', 'disk_plain')),
    content_path   TEXT,
    -- 'plain'（默认）还是'markdown' - 决定要不要把这条笔记的正文当Markdown
    -- 解析（章节识别规则、源码/预览/分屏三视图、导出格式选项都靠这个字段
    -- 分流，见 notes/service.py 里按文件后缀写入的逻辑）。用户也可以在
    -- 笔记详情页手动切换（note_format_set），不是一旦认定就不能改。
    format         TEXT NOT NULL DEFAULT 'plain' CHECK (format IN ('plain', 'markdown')),
    preview        TEXT NOT NULL DEFAULT '',
    content_length INTEGER NOT NULL DEFAULT 0,
    is_pinned      INTEGER DEFAULT 0,
    is_hidden      INTEGER DEFAULT 0,
    is_deleted     INTEGER DEFAULT 0,
    -- 手动排序位，只在 sort='manual' 时参与排序（见 _SORT_CLAUSES）。0 = 用户
    -- 还没摆过这一条，排在已摆过的前面；set_manual_order 从 1 开始发号。
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    -- 关联笔记：正文就是 content_path 处用户自己的文件（disk_plain），保存写回原文件。
    -- 编码/换行沿用原文件；linked_mtime 是上次同步时的文件修改时间，用来发现外部改动。
    is_linked        INTEGER NOT NULL DEFAULT 0,
    linked_encoding  TEXT NOT NULL DEFAULT '',
    linked_newline   TEXT NOT NULL DEFAULT '',
    linked_mtime     REAL NOT NULL DEFAULT 0,
    linked_folder_id INTEGER
);

-- 关联文件夹：之后放进去的新文件由 sync 自动建成关联笔记，分类 = category/子目录。
CREATE TABLE IF NOT EXISTS linked_folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL UNIQUE,
    category   TEXT NOT NULL DEFAULT '',
    is_hidden  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- 手动创建的分类目录，独立于 notes.category 这个自由文本字段存在——这张表
-- 让用户能"提前建一个还没有笔记用的分类"并让它持续出现在筛选栏/快捷按钮里。
-- 【契约在递归分类落地时改过】早期版本里删除这里的一行完全不影响笔记的
-- category 文本。那在扁平分类下勉强说得通，但多级分类下会留下一批指向已经
-- 不存在的路径的笔记——它们在分类树里既不属于任何节点、又不是未分类，用户
-- 在 UI 上根本点不到，等于凭空消失。现在 delete_category 必须显式选一种语义
-- （promote：笔记归到父级；cascade：整棵子树的笔记变成未分类），两种都不会
-- 留下悬空引用。见 delete_category 的 docstring。
-- scope 区分普通笔记和隐藏笔记两套独立分类池——隐藏笔记场景更偏私密，
-- 用户不想让两边的分类混在一起。
-- keywords：导入文件自动分类用的可选同义词（逗号分隔的一段文本，见
-- notes/classifier.py），不填也完全不影响——分类名本身就是最基础的匹配
-- 依据，keywords 只是在此之上加分，让"文件没提到分类名字本身，但提到了
-- 它的同义词"也能被匹配到。
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    scope      TEXT NOT NULL CHECK (scope IN ('normal', 'hidden')),
    keywords   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (name, scope)
);

-- 笔记内容里可以挂的图片——支持两种存储方式（storage_mode），用户可以在
-- 设置里选、随时切换：'encrypted_db' 把图片本身存成这张表的二进制字段，
-- 跟笔记正文一样享受 SQLCipher 整库加密；'disk_plain' 跟 clipboard_images
-- 一样落地成磁盘上的普通文件，这张表只记路径，性能更好、库体积更小，但
-- 图片文件本身不受加密保护。每一行各自记住自己是哪种模式写入的——切换
-- 设置只影响新增的图片，已经存好的图片不会被回头转换。image_data/
-- thumbnail_data 只在 encrypted_db 模式下有值，image_path/thumbnail_path
-- 只在 disk_plain 模式下有值。展示用的缩略图单独存一份，列表接口只读
-- thumbnail_data/thumbnail_path 不读 image_data/image_path，跟 notes 表
-- fetch_list/fetch_one 的"列表轻、详情重"是同一个思路。彻底删除笔记
-- （hard_delete/hard_delete_bulk/purge_expired_deleted）时要连带清理这里
-- 的行（以及 disk_plain 模式对应的磁盘文件，由 notes/service.py 负责），
-- 否则会留下孤儿数据。
CREATE TABLE IF NOT EXISTS note_images (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id        INTEGER NOT NULL,
    storage_mode   TEXT NOT NULL DEFAULT 'encrypted_db' CHECK (storage_mode IN ('encrypted_db', 'disk_plain')),
    image_data     BLOB,
    thumbnail_data BLOB,
    image_path     TEXT,
    thumbnail_path TEXT,
    mime_type      TEXT NOT NULL,
    byte_size      INTEGER NOT NULL,
    created_at     TEXT NOT NULL
);

-- 标签——跟 categories（笔记的"文件夹"）是两个独立概念：一条笔记只能在一个
-- 文件夹里（notes.category 单值），但可以挂任意多个标签（多对多，靠
-- note_tags 关联表）。"多级文件夹"没有走单独的父子关系表——notes.category
-- 本来就是自由文本，允许写成"工作/项目A"这种带斜杠的路径形式，前端按"/"
-- 切分渲染成树，删除/重命名都是纯文本操作，不需要额外的parent_id外键和
-- 级联维护逻辑，用最小的改动换到"多级"的效果。
CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    scope      TEXT NOT NULL CHECK (scope IN ('normal', 'hidden')),
    created_at TEXT NOT NULL,
    UNIQUE (name, scope)
);

CREATE TABLE IF NOT EXISTS note_tags (
    note_id INTEGER NOT NULL,
    tag_id  INTEGER NOT NULL,
    PRIMARY KEY (note_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);

-- 全文检索索引——独立的FTS5虚拟表，不用 content='' 的contentless模式（那种
-- 需要触发器精确同步，disk_plain笔记的正文根本不在notes表里，触发器读不到
-- 真实内容），改成手动在 reindex_note_fts/delete_note_fts 里维护，rowid跟
-- notes.id保持一致。tags列存的是空格分隔的标签名文本（不是外键），标签
-- 变化时跟正文变化一样重新调 reindex_note_fts 整行覆盖。
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, category, tags,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Canonical body storage for new segmented large notes.  Segment data is
-- inside the existing SQLCipher database, so the encrypted storage posture
-- remains unchanged.  Legacy rows keep their original body until a later,
-- verified migration can switch them to this representation.
CREATE TABLE IF NOT EXISTS note_content_segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL,
    ordinal     INTEGER NOT NULL,
    content     TEXT NOT NULL,
    byte_size   INTEGER NOT NULL,
    revision    INTEGER NOT NULL DEFAULT 1,
    UNIQUE (note_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_note_content_segments_note_ordinal
    ON note_content_segments(note_id, ordinal);

-- 笔记的修改时间线：每行是一篇笔记在某次改动**之后**的标题 + 分类 + 正文。
-- 老笔记第一次被改之前先补一行 'baseline'（改之前的样子），见 notes/service.py
-- 的 _ensure_baseline。content 放在最后一列，理由跟上面 note_version 那段一样：
-- 列时间线只读前面的小列，不去走正文的溢出页链。正文超过 REVISION_CONTENT_LIMIT
-- 时 content 为 NULL、has_content 为 0，只记元数据。
CREATE TABLE IF NOT EXISTS note_revisions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id        INTEGER NOT NULL,
    kind           TEXT    NOT NULL,
    batch_id       TEXT,
    title          TEXT    NOT NULL DEFAULT '',
    category       TEXT    NOT NULL DEFAULT '',
    content_length INTEGER NOT NULL DEFAULT 0,
    has_content    INTEGER NOT NULL DEFAULT 0,
    summary        TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL,
    content        TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions(note_id, id);
CREATE INDEX IF NOT EXISTS idx_note_revisions_batch ON note_revisions(batch_id);

CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted);
CREATE INDEX IF NOT EXISTS idx_notes_is_pinned ON notes(is_pinned);
CREATE INDEX IF NOT EXISTS idx_note_images_note_id ON note_images(note_id);
-- 递归分类靠前缀匹配取整棵子树（`WHERE category LIKE '工作/项目A/%'`），
-- SQLite 只有在存在这个索引时才能把前缀 LIKE 优化成索引范围扫描，否则每次按
-- 分类筛选/删除子树/重命名子树都是全表扫。分类树越深、笔记越多，这个差距越大。
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
CREATE INDEX IF NOT EXISTS idx_notes_is_linked ON notes(is_linked);

-- 触发器必须排在 notes 表之后：executescript 是顺序执行的，表还没建就
-- CREATE TRIGGER 会直接报 no such table。
CREATE TRIGGER IF NOT EXISTS note_version_after_insert AFTER INSERT ON notes BEGIN
    INSERT OR REPLACE INTO note_version (note_id, version, is_deleted, storage_mode)
    VALUES (new.id,
            (SELECT IFNULL(MAX(version), 0) + 1 FROM note_version),
            new.is_deleted, new.content_storage_mode);
END;

CREATE TRIGGER IF NOT EXISTS note_version_after_update AFTER UPDATE ON notes BEGIN
    INSERT OR REPLACE INTO note_version (note_id, version, is_deleted, storage_mode)
    VALUES (new.id,
            (SELECT IFNULL(MAX(version), 0) + 1 FROM note_version),
            new.is_deleted, new.content_storage_mode);
END;

CREATE TRIGGER IF NOT EXISTS note_version_after_delete AFTER DELETE ON notes BEGIN
    DELETE FROM note_version WHERE note_id = old.id;
END;
"""


def _hex_key(key: bytes) -> str:
    return "x'" + key.hex() + "'"


def _migrate_note_images_schema(conn: sqlite3.Connection) -> None:
    """Upgrades an old note_images table to the storage_mode shape; no-op for new or migrated DBs.

    SQLite can't relax NOT NULL in place, so the table is rebuilt; old rows were all encrypted blobs
    and become storage_mode='encrypted_db'."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(note_images)").fetchall()}
    if not cols or "storage_mode" in cols:
        return
    conn.executescript(
        """
        ALTER TABLE note_images RENAME TO note_images_old;
        CREATE TABLE note_images (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id        INTEGER NOT NULL,
            storage_mode   TEXT NOT NULL DEFAULT 'encrypted_db' CHECK (storage_mode IN ('encrypted_db', 'disk_plain')),
            image_data     BLOB,
            thumbnail_data BLOB,
            image_path     TEXT,
            thumbnail_path TEXT,
            mime_type      TEXT NOT NULL,
            byte_size      INTEGER NOT NULL,
            created_at     TEXT NOT NULL
        );
        INSERT INTO note_images (id, note_id, storage_mode, image_data, thumbnail_data, mime_type, byte_size, created_at)
            SELECT id, note_id, 'encrypted_db', image_data, thumbnail_data, mime_type, byte_size, created_at
            FROM note_images_old;
        DROP TABLE note_images_old;
        """
    )
    conn.commit()


def _migrate_notes_content_storage_mode(conn: sqlite3.Connection) -> None:
    """Adds content_storage_mode to an old notes table; no-op for new or migrated DBs.

    No rebuild needed; existing rows are tagged 'encrypted_db', the only mode that existed."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
    if not cols or "content_storage_mode" in cols:
        return
    conn.executescript(
        """
        ALTER TABLE notes ADD COLUMN content_storage_mode TEXT NOT NULL DEFAULT 'encrypted_db'
            CHECK (content_storage_mode IN ('encrypted_db', 'disk_plain'));
        ALTER TABLE notes ADD COLUMN content_path TEXT;
        """
    )
    conn.commit()


def _migrate_notes_format_column(conn: sqlite3.Connection) -> None:
    """Adds the format column to an old notes table; no-op for new or migrated DBs. Old rows become 'plain'."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
    if not cols or "format" in cols:
        return
    conn.executescript(
        "ALTER TABLE notes ADD COLUMN format TEXT NOT NULL DEFAULT 'plain' CHECK (format IN ('plain', 'markdown'));"
    )
    conn.commit()


def _migrate_categories_keywords_column(conn: sqlite3.Connection) -> None:
    """Adds the keywords column to an old categories table; no-op for new or migrated DBs. Old rows get ''."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(categories)").fetchall()}
    if not cols or "keywords" in cols:
        return
    conn.executescript("ALTER TABLE categories ADD COLUMN keywords TEXT NOT NULL DEFAULT '';")
    conn.commit()


def _migrate_notes_sort_order_column(conn: sqlite3.Connection) -> None:
    """Adds sort_order to an old notes table; no-op for new or migrated DBs.

    Old rows get 0 ("never hand-placed"), so an upgraded vault opens in id order, not shuffled."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
    if not cols or "sort_order" in cols:
        return
    conn.executescript("ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;")
    conn.commit()


def _migrate_notes_linked_columns(conn: sqlite3.Connection) -> None:
    """Adds the linked-file columns to an old notes table; no-op for new or migrated DBs."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
    if not cols or "is_linked" in cols:
        return
    conn.executescript(
        """
        ALTER TABLE notes ADD COLUMN is_linked INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE notes ADD COLUMN linked_encoding TEXT NOT NULL DEFAULT '';
        ALTER TABLE notes ADD COLUMN linked_newline TEXT NOT NULL DEFAULT '';
        ALTER TABLE notes ADD COLUMN linked_mtime REAL NOT NULL DEFAULT 0;
        ALTER TABLE notes ADD COLUMN linked_folder_id INTEGER;
        """
    )
    conn.commit()


def connect(db_path: Path, key: bytes) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlcipher.connect(str(db_path), check_same_thread=False)
    conn.execute(f"PRAGMA key = \"{_hex_key(key)}\"")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    _migrate_note_images_schema(conn)
    _migrate_notes_content_storage_mode(conn)
    _migrate_notes_format_column(conn)
    _migrate_categories_keywords_column(conn)
    _migrate_notes_sort_order_column(conn)
    _migrate_notes_linked_columns(conn)
    conn.executescript(_SCHEMA)
    _backfill_note_versions(conn)
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    conn.commit()
    return conn


def _backfill_note_versions(conn: sqlite3.Connection) -> None:
    """老库第一次打开时填充旁表，之后由触发器维护。

    要读 content 之后的列（大笔记有几十毫秒代价），所以只在缺行时才读：先用只碰主键的 NOT EXISTS 找缺的 id。
    """
    missing = [row[0] for row in conn.execute(
        "SELECT id FROM notes WHERE NOT EXISTS"
        " (SELECT 1 FROM note_version WHERE note_version.note_id = notes.id)"
    )]
    if not missing:
        return
    start = conn.execute("SELECT IFNULL(MAX(version), 0) FROM note_version").fetchone()[0]
    for offset, note_id in enumerate(missing, start=1):
        row = conn.execute(
            "SELECT is_deleted, content_storage_mode FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        conn.execute(
            "INSERT OR REPLACE INTO note_version (note_id, version, is_deleted, storage_mode)"
            " VALUES (?, ?, ?, ?)",
            (note_id, start + offset, row[0], row[1]),
        )
    conn.commit()


def fetch_content_version(conn: sqlite3.Connection, note_id: int) -> Optional[dict]:
    """这条笔记现在是第几版、删没删、正文存在哪。**不碰 content 那一列**，
    所以跟笔记多大完全无关——这正是它存在的理由，见 _SCHEMA 里的注释。"""
    row = conn.execute(
        "SELECT version, is_deleted, storage_mode FROM note_version WHERE note_id = ?",
        (note_id,),
    ).fetchone()
    if row is None:
        return None
    return {"version": row[0], "is_deleted": bool(row[1]), "storage_mode": row[2]}


def _preview_of(content: str) -> str:
    return content[:PREVIEW_CHARS]


def _validate_size(byte_size: int) -> None:
    if byte_size > NOTE_BYTE_LIMIT:
        raise errors.VaultError("notes.content_too_large", limit_bytes=NOTE_BYTE_LIMIT, actual_bytes=byte_size)


def _row_to_dict(cur: sqlite3.Cursor, row) -> dict:
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


def insert_note(
    conn: sqlite3.Connection,
    *,
    title: str = "",
    category: str = "",
    content: str = "",
    content_storage_mode: str = "encrypted_db",
    content_path: Optional[str] = None,
    format: str = "plain",
    content_byte_size: Optional[int] = None,
    content_preview: Optional[str] = None,
    is_pinned: bool = False,
    is_hidden: bool = False,
    created_at: Optional[str] = None,
    updated_at: Optional[str] = None,
    linked: Optional[dict] = None,
) -> int:
    """`content` is always the real text; preview/content_length derive from it either way.

    Only what lands in the column depends on content_storage_mode: 'encrypted_db' stores the text,
    'disk_plain' stores '' because notes/service.py already wrote the file at content_path (this
    module never touches the filesystem). content_byte_size/content_preview let a streaming caller
    supply known size and preview without materializing the file; omitted, they derive from `content`."""
    byte_size = content_byte_size if content_byte_size is not None else len(content.encode("utf-8"))
    _validate_size(byte_size)
    preview = content_preview if content_preview is not None else _preview_of(content)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    persisted_content = content if content_storage_mode == "encrypted_db" else ""
    linked = linked or {}
    cur = conn.execute(
        """
        INSERT INTO notes
            (title, category, content, content_storage_mode, content_path, format,
             preview, content_length, is_pinned, is_hidden, created_at, updated_at,
             is_linked, linked_encoding, linked_newline, linked_mtime, linked_folder_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            title,
            category,
            persisted_content,
            content_storage_mode,
            content_path,
            format,
            preview,
            byte_size,
            1 if is_pinned else 0,
            1 if is_hidden else 0,
            created_at or now,
            updated_at or now,
            1 if linked else 0,
            linked.get("encoding", ""),
            linked.get("newline", ""),
            linked.get("mtime", 0.0),
            linked.get("folder_id"),
        ),
    )
    conn.commit()
    return cur.lastrowid


def replace_segments(conn: sqlite3.Connection, note_id: int, segments: list[tuple[str, int]]) -> None:
    """Atomically replaces one note's bounded encrypted segments."""
    replace_segments_uncommitted(conn, note_id, segments)
    conn.commit()


def replace_segments_uncommitted(conn: sqlite3.Connection, note_id: int, segments) -> int:
    """Like replace_segments but takes any iterable and leaves the transaction open.

    For the legacy-note conversion in notes/service.py: streams segments without holding a list, and
    the delete + inserts + legacy content clear must commit or roll back atomically. executemany
    keeps the per-row binding loop in the driver's C code."""
    conn.execute("DELETE FROM note_content_segments WHERE note_id = ?", (note_id,))
    count = 0

    def _params():
        nonlocal count
        for ordinal, (content, byte_size) in enumerate(segments):
            count = ordinal + 1
            yield (note_id, ordinal, content, byte_size)

    conn.executemany(
        "INSERT INTO note_content_segments (note_id, ordinal, content, byte_size) VALUES (?, ?, ?, ?)",
        _params(),
    )
    return count


def fetch_segment(conn: sqlite3.Connection, note_id: int, ordinal: int) -> Optional[dict]:
    cur = conn.execute(
        "SELECT id, note_id, ordinal, content, byte_size, revision FROM note_content_segments WHERE note_id = ? AND ordinal = ?",
        (note_id, ordinal),
    )
    row = cur.fetchone()
    return _row_to_dict(cur, row) if row is not None else None


def count_segments(conn: sqlite3.Connection, note_id: int) -> int:
    return conn.execute("SELECT COUNT(*) FROM note_content_segments WHERE note_id = ?", (note_id,)).fetchone()[0]


def update_segment(conn: sqlite3.Connection, segment_id: int, *, expected_revision: int, content: str, byte_size: int) -> Optional[dict]:
    cur = conn.execute(
        "UPDATE note_content_segments SET content = ?, byte_size = ?, revision = revision + 1 "
        "WHERE id = ? AND revision = ?",
        (content, byte_size, segment_id, expected_revision),
    )
    if cur.rowcount == 0:
        conn.rollback()
        return None
    conn.commit()
    row = conn.execute(
        "SELECT id, note_id, ordinal, content, byte_size, revision FROM note_content_segments WHERE id = ?", (segment_id,)
    ).fetchone()
    return {"id": row[0], "note_id": row[1], "ordinal": row[2], "content": row[3], "byte_size": row[4], "revision": row[5]}


def update_note(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    title: Optional[str] = None,
    category: Optional[str] = None,
    content: Optional[str] = None,
    format: Optional[str] = None,
    content_byte_size: Optional[int] = None,
    content_preview: Optional[str] = None,
    _commit: bool = True,
) -> bool:
    """Partial update: only non-None columns change. False if the note is missing or trashed.

    content_storage_mode never changes here; the existing mode decides what lands in `content`
    (disk_plain: service.py already overwrote the file at content_path). content_byte_size/
    content_preview mirror insert_note so chunked disk_plain saves skip re-deriving from full text."""
    byte_size: Optional[int] = None
    if content is not None:
        byte_size = content_byte_size if content_byte_size is not None else len(content.encode("utf-8"))
        _validate_size(byte_size)
        row = conn.execute(
            "SELECT content_storage_mode FROM notes WHERE id = ? AND is_deleted = 0", (note_id,)
        ).fetchone()
        if row is None:
            return False
        row_storage_mode = row[0]

    sets: list[str] = []
    values: list = []
    if title is not None:
        sets.append("title = ?")
        values.append(title)
    if category is not None:
        sets.append("category = ?")
        values.append(category)
    if format is not None:
        sets.append("format = ?")
        values.append(format)
    if content is not None:
        sets.append("content = ?")
        values.append(content if row_storage_mode == "encrypted_db" else "")
        sets.append("preview = ?")
        values.append(content_preview if content_preview is not None else _preview_of(content))
        sets.append("content_length = ?")
        values.append(byte_size)
    if not sets:
        return fetch_one(conn, note_id) is not None

    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    sets.append("updated_at = ?")
    values.append(now)
    values.append(note_id)

    cur = conn.execute(
        f"UPDATE notes SET {', '.join(sets)} WHERE id = ? AND is_deleted = 0",
        values,
    )
    if _commit:
        conn.commit()
    return cur.rowcount > 0


def fetch_list(conn: sqlite3.Connection, sort: Optional[str] = None) -> list[dict]:
    """Metadata only (no `content`) - see module docstring for why."""
    cur = conn.execute(
        f"SELECT {_LIST_COLUMNS} FROM notes WHERE is_deleted = 0 {order_clause(sort)}"
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def set_manual_order(conn: sqlite3.Connection, ordered_ids: list[int]) -> int:
    """Assigns sort_order 1..N in the given order; returns how many rows moved.

    Starts at 1: 0 means "never hand-placed", so new notes keep floating to the top. Missing or
    trashed ids are skipped (the drag UI can be one revision stale). Does NOT touch updated_at: it is
    a display preference and bumping it would reshuffle 'updated' sort and trigger sync change detection.
    """
    live = {
        row[0]
        for row in conn.execute("SELECT id FROM notes WHERE is_deleted = 0").fetchall()
    }
    moved = 0
    for position, note_id in enumerate(ordered_ids, start=1):
        if note_id not in live:
            continue
        cur = conn.execute(
            "UPDATE notes SET sort_order = ? WHERE id = ? AND sort_order != ?",
            (position, note_id, position),
        )
        moved += cur.rowcount
    conn.commit()
    return moved


def fetch_one(conn: sqlite3.Connection, note_id: int) -> Optional[dict]:
    """Full row including `content` - used when a note is actually opened."""
    cur = conn.execute(f"SELECT {_FULL_COLUMNS} FROM notes WHERE id = ?", (note_id,))
    row = cur.fetchone()
    if row is None:
        return None
    return _row_to_dict(cur, row)


def fetch_metadata(conn: sqlite3.Connection, note_id: int) -> Optional[dict]:
    """One note's list-shaped metadata without selecting its body.

    Large-note title/category updates must not use ``fetch_one``: selecting a huge SQLCipher TEXT
    defeats chunked editing.
    """
    cur = conn.execute(f"SELECT {_LIST_COLUMNS} FROM notes WHERE id = ?", (note_id,))
    row = cur.fetchone()
    if row is None:
        return None
    return _row_to_dict(cur, row)


def set_pinned(conn: sqlite3.Connection, note_id: int, pinned: bool) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE notes SET is_pinned = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
        (1 if pinned else 0, now, note_id),
    )
    conn.commit()
    return cur.rowcount > 0


def set_pinned_bulk(conn: sqlite3.Connection, note_ids: list[int], pinned: bool) -> int:
    if not note_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"UPDATE notes SET is_pinned = ?, updated_at = ? WHERE id IN ({placeholders}) AND is_deleted = 0",
        (1 if pinned else 0, now, *note_ids),
    )
    conn.commit()
    return cur.rowcount


def set_hidden(conn: sqlite3.Connection, note_id: int, hidden: bool) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE notes SET is_hidden = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
        (1 if hidden else 0, now, note_id),
    )
    conn.commit()
    return cur.rowcount > 0


def set_hidden_bulk(conn: sqlite3.Connection, note_ids: list[int], hidden: bool) -> int:
    if not note_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"UPDATE notes SET is_hidden = ?, updated_at = ? WHERE id IN ({placeholders}) AND is_deleted = 0",
        (1 if hidden else 0, now, *note_ids),
    )
    conn.commit()
    return cur.rowcount


# --- 软删除 / 回收站（7 天内可恢复，用户可随时"彻底删除"提前清空）---


def soft_delete(conn: sqlite3.Connection, note_id: int) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE notes SET is_deleted = 1, is_pinned = 0, updated_at = ? WHERE id = ? AND is_deleted = 0",
        (now, note_id),
    )
    conn.commit()
    return cur.rowcount > 0


def soft_delete_bulk(conn: sqlite3.Connection, note_ids: list[int]) -> int:
    if not note_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"UPDATE notes SET is_deleted = 1, is_pinned = 0, updated_at = ? "
        f"WHERE id IN ({placeholders}) AND is_deleted = 0",
        (now, *note_ids),
    )
    conn.commit()
    return cur.rowcount


def restore(conn: sqlite3.Connection, note_id: int) -> bool:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        "UPDATE notes SET is_deleted = 0, updated_at = ? WHERE id = ? AND is_deleted = 1",
        (now, note_id),
    )
    conn.commit()
    return cur.rowcount > 0


def restore_bulk(conn: sqlite3.Connection, note_ids: list[int]) -> int:
    if not note_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"UPDATE notes SET is_deleted = 0, updated_at = ? WHERE id IN ({placeholders}) AND is_deleted = 1",
        (now, *note_ids),
    )
    conn.commit()
    return cur.rowcount


def move_to_hidden_bulk(conn: sqlite3.Connection, note_ids: list[int], category: str) -> int:
    """把一批笔记同时设为隐藏并归入 `category`（隐藏侧路径，可为空串或多级路径）。

    刻意用一条 UPDATE 而非 set_hidden_bulk + update_category_bulk：两步之间失败会留下
    「已隐藏但仍是可见分类名」的中间态，用户找不到笔记。
    """
    if not note_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"UPDATE notes SET is_hidden = 1, category = ?, updated_at = ? "
        f"WHERE id IN ({placeholders}) AND is_deleted = 0",
        (category, now, *note_ids),
    )
    conn.commit()
    return cur.rowcount


def update_category_bulk(conn: sqlite3.Connection, note_ids: list[int], category: str) -> int:
    if not note_ids:
        return 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"UPDATE notes SET category = ?, updated_at = ? WHERE id IN ({placeholders}) AND is_deleted = 0",
        (category, now, *note_ids),
    )
    conn.commit()
    return cur.rowcount


def fetch_deleted(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    cur = conn.execute(
        f"SELECT {_LIST_COLUMNS} FROM notes WHERE is_deleted = 1 ORDER BY updated_at DESC LIMIT ?",
        (limit,),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def _images_for_notes(conn: sqlite3.Connection, note_ids: list[int]) -> list[dict]:
    """Path/mode info (not bytes) of images attached to these notes, so the caller can unlink
    disk_plain files after deleting the rows (file I/O lives in notes/service.py)."""
    if not note_ids:
        return []
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(f"SELECT {_IMAGE_PATH_COLUMNS} FROM note_images WHERE note_id IN ({placeholders})", note_ids)
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def _content_paths_for_notes(conn: sqlite3.Connection, note_ids: list[int]) -> list[str]:
    """disk_plain notes' text file paths, for unlinking after row deletion (like _images_for_notes)."""
    if not note_ids:
        return []
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"SELECT content_path FROM notes WHERE id IN ({placeholders}) "
        f"AND content_storage_mode = 'disk_plain' AND content_path IS NOT NULL AND is_linked = 0",
        note_ids,
    )
    return [row[0] for row in cur.fetchall()]


def linked_files_for_notes(conn: sqlite3.Connection, note_ids: list[int]) -> list[dict]:
    """关联笔记的原文件（含所属关联文件夹）。硬删时由 service 决定送回收站还是只解除关联。"""
    if not note_ids:
        return []
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"SELECT id, content_path, linked_folder_id FROM notes WHERE id IN ({placeholders}) AND is_linked = 1",
        note_ids,
    )
    return [{"id": row[0], "path": row[1], "folder_id": row[2]} for row in cur.fetchall()]


def expired_linked_files(conn: sqlite3.Connection, days: int = 7) -> list[dict]:
    """purge_expired_deleted 即将清掉的关联笔记的原文件（同一截止时间）。"""
    ids = [row[0] for row in conn.execute(
        "SELECT id FROM notes WHERE is_deleted = 1 AND is_linked = 1 AND updated_at < ?", (_purge_cutoff(days),)
    ).fetchall()]
    return linked_files_for_notes(conn, ids)


def linked_note_index(conn: sqlite3.Connection) -> list[dict]:
    """全部关联笔记（含回收站里的）的路径与同步状态，供文件夹同步比对。"""
    cur = conn.execute(
        "SELECT id, content_path, is_deleted, linked_mtime, content_length, linked_folder_id "
        "FROM notes WHERE is_linked = 1"
    )
    return [
        {"id": r[0], "path": r[1], "is_deleted": bool(r[2]), "mtime": r[3], "size": r[4], "folder_id": r[5]}
        for r in cur.fetchall()
    ]


def update_linked_state(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    content_path: Optional[str] = None,
    encoding: Optional[str] = None,
    mtime: Optional[float] = None,
    folder_id: Optional[int] = -1,
) -> None:
    """改关联笔记的文件位置/编码/同步时间；folder_id=-1 表示不动，None 表示脱离文件夹。"""
    sets: list[str] = []
    values: list = []
    if content_path is not None:
        sets.append("content_path = ?")
        values.append(content_path)
    if encoding is not None:
        sets.append("linked_encoding = ?")
        values.append(encoding)
    if mtime is not None:
        sets.append("linked_mtime = ?")
        values.append(mtime)
    if folder_id != -1:
        sets.append("linked_folder_id = ?")
        values.append(folder_id)
    if not sets:
        return
    values.append(note_id)
    conn.execute(f"UPDATE notes SET {', '.join(sets)} WHERE id = ? AND is_linked = 1", values)
    conn.commit()


def list_linked_folders(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.execute(f"SELECT {_LINKED_FOLDER_COLUMNS} FROM linked_folders ORDER BY id")
    rows = [_row_to_dict(cur, row) for row in cur.fetchall()]
    counts = dict(conn.execute(
        "SELECT linked_folder_id, COUNT(*) FROM notes "
        "WHERE is_linked = 1 AND is_deleted = 0 AND linked_folder_id IS NOT NULL GROUP BY linked_folder_id"
    ).fetchall())
    for row in rows:
        row["is_hidden"] = bool(row["is_hidden"])
        row["note_count"] = counts.get(row["id"], 0)
    return rows


def fetch_linked_folder(conn: sqlite3.Connection, folder_id: int) -> Optional[dict]:
    cur = conn.execute(f"SELECT {_LINKED_FOLDER_COLUMNS} FROM linked_folders WHERE id = ?", (folder_id,))
    row = cur.fetchone()
    if row is None:
        return None
    folder = _row_to_dict(cur, row)
    folder["is_hidden"] = bool(folder["is_hidden"])
    return folder


def insert_linked_folder(conn: sqlite3.Connection, *, path: str, category: str, is_hidden: bool) -> int:
    cur = conn.execute(
        "INSERT INTO linked_folders (path, category, is_hidden, created_at) VALUES (?, ?, ?, ?)",
        (path, category, 1 if is_hidden else 0, time.strftime("%Y-%m-%dT%H:%M:%S")),
    )
    conn.commit()
    return cur.lastrowid


def delete_linked_folder(conn: sqlite3.Connection, folder_id: int) -> bool:
    """只停止同步；已有笔记保留，仍关联各自的文件。"""
    conn.execute("UPDATE notes SET linked_folder_id = NULL WHERE linked_folder_id = ?", (folder_id,))
    cur = conn.execute("DELETE FROM linked_folders WHERE id = ?", (folder_id,))
    conn.commit()
    return cur.rowcount > 0


def hard_delete(conn: sqlite3.Connection, note_id: int) -> tuple[bool, list[dict], list[str]]:
    """Permanent delete ("彻底删除"), meant for trashed notes but not enforced (like purge_expired_deleted).

    Also deletes the note's images to avoid orphan rows. Returns removed image rows and any disk_plain
    content path so the caller can unlink the files."""
    removed_images = _images_for_notes(conn, [note_id])
    removed_content_paths = _content_paths_for_notes(conn, [note_id])
    conn.execute("DELETE FROM note_images WHERE note_id = ?", (note_id,))
    conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
    conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (note_id,))
    conn.execute("DELETE FROM note_revisions WHERE note_id = ?", (note_id,))
    cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    conn.commit()
    return cur.rowcount > 0, removed_images, removed_content_paths


def hard_delete_bulk(conn: sqlite3.Connection, note_ids: list[int]) -> tuple[int, list[dict], list[str]]:
    if not note_ids:
        return 0, [], []
    removed_images = _images_for_notes(conn, note_ids)
    removed_content_paths = _content_paths_for_notes(conn, note_ids)
    placeholders = ",".join("?" for _ in note_ids)
    conn.execute(f"DELETE FROM note_images WHERE note_id IN ({placeholders})", note_ids)
    conn.execute(f"DELETE FROM note_tags WHERE note_id IN ({placeholders})", note_ids)
    conn.execute(f"DELETE FROM notes_fts WHERE rowid IN ({placeholders})", note_ids)
    conn.execute(f"DELETE FROM note_revisions WHERE note_id IN ({placeholders})", note_ids)
    cur = conn.execute(f"DELETE FROM notes WHERE id IN ({placeholders})", note_ids)
    conn.commit()
    return cur.rowcount, removed_images, removed_content_paths


def _purge_cutoff(days: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - days * 86400))


def purge_expired_deleted(conn: sqlite3.Connection, days: int = 7) -> tuple[int, list[dict], list[str]]:
    cutoff = _purge_cutoff(days)
    expired_ids = [
        row[0]
        for row in conn.execute(
            "SELECT id FROM notes WHERE is_deleted = 1 AND updated_at < ?", (cutoff,)
        ).fetchall()
    ]
    removed_images = _images_for_notes(conn, expired_ids)
    removed_content_paths = _content_paths_for_notes(conn, expired_ids)
    if expired_ids:
        placeholders = ",".join("?" for _ in expired_ids)
        conn.execute(f"DELETE FROM note_images WHERE note_id IN ({placeholders})", expired_ids)
        conn.execute(f"DELETE FROM note_tags WHERE note_id IN ({placeholders})", expired_ids)
        conn.execute(f"DELETE FROM notes_fts WHERE rowid IN ({placeholders})", expired_ids)
        conn.execute(f"DELETE FROM note_revisions WHERE note_id IN ({placeholders})", expired_ids)
    cur = conn.execute(
        "DELETE FROM notes WHERE is_deleted = 1 AND updated_at < ?",
        (cutoff,),
    )
    conn.commit()
    return cur.rowcount, removed_images, removed_content_paths


# --- 手动分类管理（跟笔记本身的 category 自由文本字段是两回事，见上面
# categories 表的注释）---


def list_categories(conn: sqlite3.Connection, scope: str) -> list[dict]:
    cur = conn.execute(
        "SELECT id, name, scope, keywords, created_at FROM categories WHERE scope = ? ORDER BY name COLLATE NOCASE",
        (scope,),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def _raise_path_error(exc: category_paths.CategoryPathError) -> NoReturn:
    """把 category_paths 的纯字符串异常翻译成 VaultError（category_paths 刻意不依赖 errors 模块）。"""
    raise errors.VaultError(exc.code, **exc.params) from exc


def create_category(conn: sqlite3.Connection, name: str, scope: str, keywords: str = "") -> dict:
    """Idempotent: an existing (name, scope) returns the existing row. `keywords` applies only on first
    creation (use set_category_keywords to edit).

    多级路径会自动补建每一级父分类（只写空 keywords），否则树里出现有子无父的悬空节点，
    点击、加关键词、删除行为都会异常。
    """
    try:
        name = category_paths.validate_path(name)
    except category_paths.CategoryPathError as exc:
        _raise_path_error(exc)
    if not name:
        raise errors.VaultError("notes.category_name_required")
    _validate_category_scope(scope)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    # 父级用 INSERT OR IGNORE 逐条补——已经存在的原样保留（连同它自己的
    # keywords），只补真正缺的那几行。
    for parent in category_paths.parent_paths(name):
        conn.execute(
            "INSERT OR IGNORE INTO categories (name, scope, keywords, created_at) VALUES (?, ?, '', ?)",
            (parent, scope, now),
        )
    conn.execute(
        "INSERT OR IGNORE INTO categories (name, scope, keywords, created_at) VALUES (?, ?, ?, ?)",
        (name, scope, keywords.strip(), now),
    )
    conn.commit()
    cur = conn.execute(
        "SELECT id, name, scope, keywords, created_at FROM categories WHERE name = ? AND scope = ?",
        (name, scope),
    )
    return _row_to_dict(cur, cur.fetchone())


def _validate_category_scope(scope: str) -> None:
    if scope not in ("normal", "hidden"):
        raise errors.VaultError("notes.invalid_category_scope")


def set_category_keywords(conn: sqlite3.Connection, category_id: int, keywords: str) -> Optional[dict]:
    """Edits an existing catalog entry's keywords (create_category sets them only once); None if missing."""
    cur = conn.execute(
        "UPDATE categories SET keywords = ? WHERE id = ?", (keywords.strip(), category_id)
    )
    if cur.rowcount == 0:
        conn.rollback()
        return None
    conn.commit()
    cur = conn.execute(
        "SELECT id, name, scope, keywords, created_at FROM categories WHERE id = ?", (category_id,)
    )
    return _row_to_dict(cur, cur.fetchone())


def fetch_category(conn: sqlite3.Connection, category_id: int) -> Optional[dict]:
    cur = conn.execute(
        "SELECT id, name, scope, keywords, created_at FROM categories WHERE id = ?", (category_id,)
    )
    row = cur.fetchone()
    return _row_to_dict(cur, row) if row is not None else None


def category_impact(conn: sqlite3.Connection, category_id: int) -> Optional[dict]:
    """删除/重命名分类前先算清会波及什么，供前端确认框展示（子分类数、笔记数）。

    分类树是层级结构，误删可能连带影响几十篇笔记的归属，所以必须先算后删。
    """
    category = fetch_category(conn, category_id)
    if category is None:
        return None
    name = category["name"]
    scope = category["scope"]
    is_hidden = 1 if scope == "hidden" else 0
    prefix = name + category_paths.SEPARATOR

    child_rows = conn.execute(
        "SELECT name FROM categories WHERE scope = ? AND name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE",
        (scope, _like_prefix(prefix)),
    ).fetchall()
    children = [row[0] for row in child_rows]

    # 笔记数分直接挂载和挂在子孙上两类：两种删除语义下去向不同，确认框要分别说清。
    direct_count = conn.execute(
        "SELECT COUNT(*) FROM notes WHERE category = ? AND is_deleted = 0 AND is_hidden = ?",
        (name, is_hidden),
    ).fetchone()[0]
    descendant_count = conn.execute(
        "SELECT COUNT(*) FROM notes WHERE category LIKE ? ESCAPE '\\' AND is_deleted = 0 AND is_hidden = ?",
        (_like_prefix(prefix), is_hidden),
    ).fetchone()[0]

    return {
        "id": category_id,
        "name": name,
        "scope": scope,
        "children": children,
        "child_count": len(children),
        "direct_note_count": direct_count,
        "descendant_note_count": descendant_count,
    }


def _like_prefix(prefix: str) -> str:
    r"""把字面前缀转成安全的 LIKE 模式，配合 SQL 的 `ESCAPE '\'`。

    用户分类名可含通配符 `%` `_`，不转义会匹配无关路径；反斜杠也要先转义。
    """
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + "%"


def delete_category(conn: sqlite3.Connection, category_id: int, mode: str = "promote") -> Optional[dict]:
    """删除一个分类，语义由调用方（用户在确认框中）明确选择。

    - `mode='promote'`：只删这一级，子分类提升到父级；直接笔记归到父级（顶级则未分类）。
    - `mode='cascade'`：删整棵子树，其下笔记全部变未分类（不删笔记）。
    不默认 cascade：它一次让几十篇笔记失去归属，promote 则易恢复。返回统计（同 category_impact），
    分类不存在返回 None。
    """
    if mode not in ("promote", "cascade"):
        raise errors.VaultError("notes.invalid_category_delete_mode")
    impact = category_impact(conn, category_id)
    if impact is None:
        return None

    name = impact["name"]
    scope = impact["scope"]
    is_hidden = 1 if scope == "hidden" else 0
    prefix = name + category_paths.SEPARATOR
    parent = category_paths.parent_of(name)
    like_prefix = _like_prefix(prefix)

    # 先收集受影响的笔记（UPDATE 后就匹配不到原条件了），改完要重建其 FTS 行，否则搜索仍命中旧路径。
    affected_note_ids = [
        row[0]
        for row in conn.execute(
            "SELECT id FROM notes WHERE is_deleted = 0 AND is_hidden = ? AND (category = ? OR category LIKE ? ESCAPE '\\')",
            (is_hidden, name, like_prefix),
        ).fetchall()
    ]

    if mode == "cascade":
        conn.execute(
            "DELETE FROM categories WHERE scope = ? AND (name = ? OR name LIKE ? ESCAPE '\\')",
            (scope, name, like_prefix),
        )
        conn.execute(
            "UPDATE notes SET category = '', updated_at = ? "
            "WHERE is_deleted = 0 AND is_hidden = ? AND (category = ? OR category LIKE ? ESCAPE '\\')",
            (time.strftime("%Y-%m-%dT%H:%M:%S"), is_hidden, name, like_prefix),
        )
    else:
        # 提升：必须先删自己再改子孙路径，否则会与提升上来的同名子分类撞 UNIQUE(name, scope)。
        conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        _rebase_prefix(conn, scope=scope, old_prefix=name, new_prefix=parent, is_hidden=is_hidden)
        # 直接挂在被删分类上的笔记归到父级（parent 为空即未分类）
        conn.execute(
            "UPDATE notes SET category = ?, updated_at = ? WHERE is_deleted = 0 AND is_hidden = ? AND category = ?",
            (parent, time.strftime("%Y-%m-%dT%H:%M:%S"), is_hidden, name),
        )

    conn.commit()
    _reindex_categories_for_notes(conn, affected_note_ids)
    return impact


def _rebase_prefix(
    conn: sqlite3.Connection, *, scope: str, old_prefix: str, new_prefix: str, is_hidden: int
) -> None:
    """把 old_prefix 下的整棵子树搬到 new_prefix 下：categories 和 notes 各一条前缀替换 UPDATE。

    物化路径的好处是不用递归。`new_prefix` 为空表示提升到顶级（去掉前缀及其后的分隔符）。
    在 SQL 里用 substr 拼接，保持单语句原子；SQLite substr 从 1 起，故截取起点为 len(old_prefix) + 1。
    """
    like_prefix = _like_prefix(old_prefix + category_paths.SEPARATOR)
    cut = len(old_prefix) + 1  # +1 跳过 old_prefix 本身；下面再按需跳过分隔符
    if new_prefix:
        # `工作/项目A/需求` → `归档/项目A` + `/需求`
        conn.execute(
            "UPDATE categories SET name = ? || substr(name, ?) WHERE scope = ? AND name LIKE ? ESCAPE '\\'",
            (new_prefix, cut, scope, like_prefix),
        )
        conn.execute(
            "UPDATE notes SET category = ? || substr(category, ?), updated_at = ? "
            "WHERE is_deleted = 0 AND is_hidden = ? AND category LIKE ? ESCAPE '\\'",
            (new_prefix, cut, time.strftime("%Y-%m-%dT%H:%M:%S"), is_hidden, like_prefix),
        )
    else:
        # 提升到顶级：连分隔符一起去掉，所以起点再 +1
        conn.execute(
            "UPDATE categories SET name = substr(name, ?) WHERE scope = ? AND name LIKE ? ESCAPE '\\'",
            (cut + 1, scope, like_prefix),
        )
        conn.execute(
            "UPDATE notes SET category = substr(category, ?), updated_at = ? "
            "WHERE is_deleted = 0 AND is_hidden = ? AND category LIKE ? ESCAPE '\\'",
            (cut + 1, time.strftime("%Y-%m-%dT%H:%M:%S"), is_hidden, like_prefix),
        )


def rename_category(conn: sqlite3.Connection, category_id: int, new_name: str) -> Optional[dict]:
    """重命名/移动一个分类，连同整棵子树和相关笔记（物化路径下两者都是前缀替换）。

    动手前三道校验：1. 目标路径合法（字符、深度、长度）；2. 不能移进自己的子孙里；
    3. 子树整体下移后最深一条不能超过 MAX_DEPTH（原有每一层都会变深）。返回更新后的行，不存在返回 None。
    """
    category = fetch_category(conn, category_id)
    if category is None:
        return None
    old_name = category["name"]
    scope = category["scope"]
    is_hidden = 1 if scope == "hidden" else 0

    # 先校验并规范化路径再跟旧名比，顺序不能反：validate_move 把「移到自己身上」当非法，
    # 但改名对话框里没改文字直接确定是正常操作，应静默忽略。
    try:
        normalized = category_paths.validate_path(new_name)
    except category_paths.CategoryPathError as exc:
        _raise_path_error(exc)
    if normalized == old_name:
        return category
    try:
        new_name = category_paths.validate_move(old_name, normalized)
    except category_paths.CategoryPathError as exc:
        _raise_path_error(exc)

    like_prefix = _like_prefix(old_name + category_paths.SEPARATOR)
    deepest = conn.execute(
        "SELECT name FROM categories WHERE scope = ? AND name LIKE ? ESCAPE '\\' "
        "ORDER BY LENGTH(name) - LENGTH(REPLACE(name, '/', '')) DESC LIMIT 1",
        (scope, like_prefix),
    ).fetchone()
    if deepest is not None:
        try:
            category_paths.check_resulting_depth(deepest[0], old_name, new_name)
        except category_paths.CategoryPathError as exc:
            _raise_path_error(exc)

    # 目标已经被另一个分类占用——前缀替换会撞 UNIQUE(name, scope)。与其让约束在
    # 事务中途炸出一个数据库层的报错，不如提前给一个用户能看懂的错误码。
    conflict = conn.execute(
        "SELECT 1 FROM categories WHERE scope = ? AND name = ? AND id != ?", (scope, new_name, category_id)
    ).fetchone()
    if conflict is not None:
        raise errors.VaultError("notes.category_already_exists", name=new_name)

    affected_note_ids = [
        row[0]
        for row in conn.execute(
            "SELECT id FROM notes WHERE is_deleted = 0 AND is_hidden = ? AND (category = ? OR category LIKE ? ESCAPE '\\')",
            (is_hidden, old_name, like_prefix),
        ).fetchall()
    ]

    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    # 移动到一个还不存在的父路径下时，把缺的父级补齐——否则又会出现悬空节点
    # （跟 create_category 里补父级是同一个理由）。
    for parent in category_paths.parent_paths(new_name):
        conn.execute(
            "INSERT OR IGNORE INTO categories (name, scope, keywords, created_at) VALUES (?, ?, '', ?)",
            (parent, scope, now),
        )
    # 先改子孙再改自己：反过来的话自己改完之后，子孙的 LIKE 前缀就对不上了。
    _rebase_prefix(conn, scope=scope, old_prefix=old_name, new_prefix=new_name, is_hidden=is_hidden)
    conn.execute("UPDATE categories SET name = ? WHERE id = ?", (new_name, category_id))
    conn.execute(
        "UPDATE notes SET category = ?, updated_at = ? WHERE is_deleted = 0 AND is_hidden = ? AND category = ?",
        (new_name, now, is_hidden, old_name),
    )
    conn.commit()
    _reindex_categories_for_notes(conn, affected_note_ids)
    return fetch_category(conn, category_id)


def _reindex_categories_for_notes(conn: sqlite3.Connection, note_ids: list[int]) -> None:
    """分类路径变化后重建这些笔记的 FTS 行。

    `category` 是 notes_fts 的一列且该表手动维护（无触发器），不重建则新分类名搜不到、旧名反而能搜到。
    disk_plain 笔记 content 为空，读到什么写什么：改名不应顺带重读磁盘上的正文。
    """
    if not note_ids:
        return
    placeholders = ",".join("?" for _ in note_ids)
    rows = conn.execute(
        f"SELECT id, title, content, category FROM notes WHERE id IN ({placeholders})", note_ids
    ).fetchall()
    tag_names = get_tag_names_for_notes(conn, note_ids)
    reindex_notes_fts_bulk(
        conn,
        [(row[0], row[1], row[2], row[3], tag_names.get(row[0], [])) for row in rows],
    )


def list_categories_in_use(conn: sqlite3.Connection, scope: str) -> list[str]:
    """Distinct non-empty `category` values on active notes in this scope.

    Lets a category only ever picked from frontend presets (never create_category'd; their text is
    frontend i18n) become a classify() candidate once used."""
    is_hidden = 1 if scope == "hidden" else 0
    cur = conn.execute(
        "SELECT DISTINCT category FROM notes WHERE category != '' AND is_deleted = 0 AND is_hidden = ? "
        "ORDER BY category COLLATE NOCASE",
        (is_hidden,),
    )
    return [row[0] for row in cur.fetchall()]


# --- 标签（多对多，见上面 tags/note_tags 表的注释）---


def _validate_scope(scope: str) -> None:
    if scope not in ("normal", "hidden"):
        raise errors.VaultError("notes.invalid_tag_scope")


def list_tags(conn: sqlite3.Connection, scope: str) -> list[dict]:
    _validate_scope(scope)
    cur = conn.execute(
        "SELECT id, name, scope, created_at FROM tags WHERE scope = ? ORDER BY name COLLATE NOCASE",
        (scope,),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def create_tag(conn: sqlite3.Connection, name: str, scope: str) -> dict:
    """Idempotent, same pattern as create_category."""
    _validate_scope(scope)
    name = name.strip()
    if not name:
        raise errors.VaultError("notes.tag_name_required")
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    conn.execute("INSERT OR IGNORE INTO tags (name, scope, created_at) VALUES (?, ?, ?)", (name, scope, now))
    conn.commit()
    cur = conn.execute("SELECT id, name, scope, created_at FROM tags WHERE name = ? AND scope = ?", (name, scope))
    return _row_to_dict(cur, cur.fetchone())


def delete_tag(conn: sqlite3.Connection, tag_id: int) -> bool:
    """Deletes the tag and every note's assignment of it (a tag has no meaning without the tag row)."""
    conn.execute("DELETE FROM note_tags WHERE tag_id = ?", (tag_id,))
    cur = conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    conn.commit()
    return cur.rowcount > 0


def get_note_ids_for_tag(conn: sqlite3.Connection, tag_id: int) -> list[int]:
    """Returns the notes currently carrying tag_id before it is removed."""
    return [
        row[0]
        for row in conn.execute("SELECT note_id FROM note_tags WHERE tag_id = ?", (tag_id,)).fetchall()
    ]


def get_tags_for_note(conn: sqlite3.Connection, note_id: int) -> list[dict]:
    """Full tag objects (id+name), used by the detail page's tag editor
    which needs ids to remove individual tags, not just display names."""
    cur = conn.execute(
        "SELECT tags.id, tags.name FROM note_tags JOIN tags ON tags.id = note_tags.tag_id "
        "WHERE note_tags.note_id = ? ORDER BY tags.name COLLATE NOCASE",
        (note_id,),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def get_tag_names_for_notes(conn: sqlite3.Connection, note_ids: list[int]) -> dict[int, list[str]]:
    """Tag names keyed by note id, merged into list rows so fetch_list stays one query."""
    if not note_ids:
        return {}
    placeholders = ",".join("?" for _ in note_ids)
    cur = conn.execute(
        f"SELECT note_tags.note_id, tags.name FROM note_tags JOIN tags ON tags.id = note_tags.tag_id "
        f"WHERE note_tags.note_id IN ({placeholders}) ORDER BY tags.name COLLATE NOCASE",
        note_ids,
    )
    result: dict[int, list[str]] = {}
    for note_id, name in cur.fetchall():
        result.setdefault(note_id, []).append(name)
    return result


def set_note_tags(conn: sqlite3.Connection, note_id: int, tag_ids: list[int]) -> None:
    """Full replace: the note's tag set becomes exactly tag_ids (detail-page editor), unlike
    the additive add_tags_bulk."""
    conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
    if tag_ids:
        conn.executemany(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)",
            [(note_id, tag_id) for tag_id in tag_ids],
        )
    conn.commit()


def add_tag_bulk(conn: sqlite3.Connection, note_ids: list[int], tag_id: int) -> int:
    """Batch-tag: adds tag_id to each note without touching existing tags. Skips trashed notes (as
    update_category_bulk does) so a stale id list can't tag a deleted note."""
    if not note_ids:
        return 0
    placeholders = ",".join("?" for _ in note_ids)
    valid_ids = [
        row[0]
        for row in conn.execute(f"SELECT id FROM notes WHERE id IN ({placeholders}) AND is_deleted = 0", note_ids).fetchall()
    ]
    if not valid_ids:
        return 0
    conn.executemany(
        "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)",
        [(note_id, tag_id) for note_id in valid_ids],
    )
    conn.commit()
    return len(valid_ids)


# --- 全文检索（FTS5，见上面 notes_fts 表的注释）---


def reindex_note_fts(conn: sqlite3.Connection, note_id: int, *, title: str, content: str, category: str, tags: list[str]) -> None:
    """(Re)indexes one note's searchable text via delete+insert (FTS5 has no partial-column UPDATE).

    `content` is whatever the caller has: callers streaming a large note (write_content_chunk) pass a
    truncated preview on purpose, so very large notes match only title/category/tags/prefix."""
    conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (note_id,))
    conn.execute(
        "INSERT INTO notes_fts (rowid, title, content, category, tags) VALUES (?, ?, ?, ?, ?)",
        (note_id, title, content, category, " ".join(tags)),
    )
    conn.commit()


def reindex_notes_fts_bulk(conn: sqlite3.Connection, entries: list[tuple[int, str, str, str, list[str]]]) -> None:
    """Batched reindex_note_fts: one DELETE/INSERT/commit for the batch instead of per-note disk syncs."""
    if not entries:
        return
    ids = [entry[0] for entry in entries]
    placeholders = ",".join("?" for _ in ids)
    conn.execute(f"DELETE FROM notes_fts WHERE rowid IN ({placeholders})", ids)
    conn.executemany(
        "INSERT INTO notes_fts (rowid, title, content, category, tags) VALUES (?, ?, ?, ?, ?)",
        [(note_id, title, content, category, " ".join(tags)) for note_id, title, content, category, tags in entries],
    )
    conn.commit()


def _sanitize_fts_query(raw: str) -> str:
    """Turns user input into a safe FTS5 query: each word is a quoted phrase (embedded quotes escaped),
    joined by implicit AND, so operators like AND/OR/NOT/*/() are literal text and never a syntax error."""
    terms = raw.strip().split()
    if not terms:
        return ""
    return " ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)


_SEARCH_COLUMNS = (
    "notes.id, notes.title, notes.category, notes.preview, notes.content_length, notes.content_storage_mode, "
    "notes.format, notes.is_pinned, notes.is_hidden, notes.is_deleted, notes.created_at, notes.updated_at, "
    "notes.is_linked, CASE WHEN notes.is_linked = 1 THEN notes.content_path END AS linked_path"
)

# 不用空格分词的文字。命中这些字符时，光靠 FTS5 的 MATCH 是搜不全的——见
# _needs_substring_pass 的说明。
_UNSEGMENTED_SCRIPT_RE = re.compile(
    "[㐀-䶿一-鿿豈-﫿"  # 汉字（含扩展A、兼容区）
    "぀-ヿ"  # 日文假名
    "฀-๿]"  # 泰文
)


def _needs_substring_pass(query: str) -> bool:
    """该查询是否需要额外走一遍子串匹配。

    unicode61 分词器把汉字、假名、泰文归为字母数字，无标点的整段中文成为一个 token，
    搜「预算」命不中「本季度预算超支」且不报错。这是分词器固有行为，故对含这类文字的查询
    多跑一遍子串 LIKE（同 find_notes_mentioning_title）；英文仍只走 FTS（bm25、走索引）。
    """
    return bool(_UNSEGMENTED_SCRIPT_RE.search(query))


def _like_escape(term: str) -> str:
    """LIKE 模式里的 `%` `_` `\\` 要转义，否则用户搜 `100%` 会变成通配符。"""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_notes(
    conn: sqlite3.Connection,
    *,
    query: str = "",
    category: Optional[str] = None,
    tag: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 300,
    sort: Optional[str] = None,
) -> list[dict]:
    """Full-text search over title/content/category/tags with optional category/tag/date-range
    narrowing, all ANDed. Only active notes; never re-selects `content` (metadata only).

    中日泰文等不分词的查询会额外走子串匹配并并入结果（见 _needs_substring_pass），否则 FTS5 静默
    返回空。FTS 命中（bm25）在前，子串多找到的接在后面。"""
    narrowing = _narrowing_conditions(category=category, tag=tag, date_from=date_from, date_to=date_to)

    sanitized_query = _sanitize_fts_query(query)
    if not sanitized_query:
        # 纯筛选（没打字）没有相关度，必须沿用用户选的排序，否则「按标题排」在选了分类后会静默失效。
        rows = _run_notes_query(conn, "FROM notes", [], order_clause(sort), narrowing, limit)
        return rows

    fts_rows = _run_notes_query(
        conn,
        "FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid",
        [("notes_fts MATCH ?", sanitized_query)],
        "ORDER BY bm25(notes_fts)",
        narrowing,
        limit,
    )
    if not _needs_substring_pass(query):
        return fts_rows

    like_terms = [
        (
            "("
            "notes_fts.title LIKE ? ESCAPE '\\' OR notes_fts.content LIKE ? ESCAPE '\\' "
            "OR notes_fts.category LIKE ? ESCAPE '\\' OR notes_fts.tags LIKE ? ESCAPE '\\'"
            ")",
            f"%{_like_escape(term)}%",
        )
        for term in query.strip().split()
    ]
    # 每词一个条件、四列 OR、词之间 AND，与 _sanitize_fts_query 的隐式 AND 对齐。
    # 子串这一趟没有 bm25，组内按用户选的排序；FTS 命中那批仍在前。
    substring_rows = _run_notes_query(
        conn,
        "FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid",
        [(condition, *([value] * 4)) for condition, value in like_terms],
        order_clause(sort),
        narrowing,
        limit,
    )

    seen = {row["id"] for row in fts_rows}
    merged = list(fts_rows)
    for row in substring_rows:
        if row["id"] not in seen:
            seen.add(row["id"])
            merged.append(row)
    return merged[:limit]


def _narrowing_conditions(
    *,
    category: Optional[str],
    tag: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
) -> list[tuple]:
    """分类/标签/时间范围这三组筛选条件，两条查询路径共用一份，避免只改一边。"""
    narrowing: list[tuple] = []
    if category:
        narrowing.append(("notes.category = ?", category))
    if tag:
        narrowing.append(
            (
                "notes.id IN (SELECT note_tags.note_id FROM note_tags JOIN tags ON tags.id = note_tags.tag_id WHERE tags.name = ?)",
                tag,
            )
        )
    if date_from:
        narrowing.append(("notes.updated_at >= ?", date_from))
    if date_to:
        narrowing.append(("notes.updated_at <= ?", date_to))
    return narrowing


def _run_notes_query(
    conn: sqlite3.Connection,
    from_clause: str,
    query_conditions: list[tuple],
    order_clause: str,
    narrowing: list[tuple],
    limit: int,
) -> list[dict]:
    """每个条件是 `(SQL 片段, 参数...)`，顺序即绑定顺序。"""
    conditions = ["notes.is_deleted = 0"]
    params: list = []
    for condition, *values in [*query_conditions, *narrowing]:
        conditions.append(condition)
        params.extend(values)
    where_clause = " AND ".join(conditions)
    cur = conn.execute(
        f"SELECT {_SEARCH_COLUMNS} {from_clause} WHERE {where_clause} {order_clause} LIMIT ?",
        (*params, limit),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def find_notes_mentioning_title(conn: sqlite3.Connection, note_id: int, title: str, limit: int = 10) -> list[dict]:
    """「标题共同出现」提示：查其它笔记正文是否原样出现本篇标题，是推迟的双向 [[链接]] 的低成本替代。

    不用 notes_fts MATCH 短语：unicode61 把无标点的连续中文整段当一个 token，标题嵌在长句中间时
    永不命中。改对 notes_fts.content 做子串 LIKE（它存完整正文，而 notes.content 对 disk_plain 为空）；
    全表扫描对个人笔记量级够快。标题为空/纯空白返回空列表。"""
    stripped = title.strip()
    if not stripped:
        return []
    escaped = stripped.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like_pattern = f"%{escaped}%"
    cur = conn.execute(
        f"""
        SELECT {_SEARCH_COLUMNS}
        FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
        WHERE notes_fts.content LIKE ? ESCAPE '\\' AND notes.is_deleted = 0 AND notes.id != ?
        ORDER BY notes.id DESC
        LIMIT ?
        """,
        (like_pattern, note_id, limit),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


# --- 笔记内容里挂的图片（跟 note_images 表的注释一样：整库加密保护，
# 缩略图/原图分开存，列表接口只读缩略图不读原图）---


def _validate_image_size(byte_size: int) -> None:
    if byte_size > NOTE_IMAGE_BYTE_LIMIT:
        raise errors.VaultError(
            "notes.image_too_large", limit_bytes=NOTE_IMAGE_BYTE_LIMIT, actual_bytes=byte_size
        )


def insert_image(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    mime_type: str,
    byte_size: int,
    storage_mode: str,
    image_data: Optional[bytes] = None,
    thumbnail_data: Optional[bytes] = None,
    image_path: Optional[str] = None,
    thumbnail_path: Optional[str] = None,
) -> dict:
    """storage_mode picks the column pair holding the image: 'encrypted_db' uses image_data/thumbnail_data
    (BLOB), 'disk_plain' uses image_path/thumbnail_path (files already written by notes/service.py).

    byte_size is the original size, passed in so the disk_plain path can validate before writing."""
    _validate_image_size(byte_size)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    cur = conn.execute(
        """
        INSERT INTO note_images
            (note_id, storage_mode, image_data, thumbnail_data, image_path, thumbnail_path, mime_type, byte_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (note_id, storage_mode, image_data, thumbnail_data, image_path, thumbnail_path, mime_type, byte_size, now),
    )
    conn.commit()
    # Meta shape (thumbnail, no image_data), same as list_images, so the gallery needs no extra round trip.
    cur = conn.execute(f"SELECT {_IMAGE_LIST_COLUMNS} FROM note_images WHERE id = ?", (cur.lastrowid,))
    return _row_to_dict(cur, cur.fetchone())


def list_images(conn: sqlite3.Connection, note_id: int) -> list[dict]:
    """Metadata + thumbnail only (no image_data/image_path), keeping the gallery fast.

    Includes storage_mode/thumbnail_path so notes/service.py can load disk_plain thumbnails."""
    cur = conn.execute(
        f"SELECT {_IMAGE_LIST_COLUMNS} FROM note_images WHERE note_id = ? ORDER BY id",
        (note_id,),
    )
    return [_row_to_dict(cur, row) for row in cur.fetchall()]


def get_image(conn: sqlite3.Connection, image_id: int) -> Optional[dict]:
    """Full row including `image_data`/`image_path` - used when actually
    viewing an image full-size."""
    cur = conn.execute(f"SELECT {_IMAGE_FULL_COLUMNS} FROM note_images WHERE id = ?", (image_id,))
    row = cur.fetchone()
    if row is None:
        return None
    return _row_to_dict(cur, row)


def delete_image(conn: sqlite3.Connection, image_id: int) -> Optional[dict]:
    """Returns the removed row's path/mode info (so the caller can unlink a
    disk_plain file), or None if this id didn't exist."""
    cur = conn.execute(f"SELECT {_IMAGE_PATH_COLUMNS} FROM note_images WHERE id = ?", (image_id,))
    row = cur.fetchone()
    if row is None:
        return None
    removed = _row_to_dict(cur, row)
    conn.execute("DELETE FROM note_images WHERE id = ?", (image_id,))
    conn.commit()
    return removed


# --- 修改时间线（note_revisions）---


def _revision_to_dict(cur: sqlite3.Cursor, row) -> dict:
    d = _row_to_dict(cur, row)
    d["has_content"] = bool(d["has_content"])
    return d


def insert_revision(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    kind: str,
    title: str,
    category: str,
    content: Optional[str],
    content_length: int,
    batch_id: Optional[str] = None,
    summary: str = "",
    created_at: Optional[str] = None,
) -> int:
    """content 为 None 表示这一版不存正文快照（太大，或读不到）。"""
    cur = conn.execute(
        "INSERT INTO note_revisions"
        " (note_id, kind, batch_id, title, category, content_length, has_content, summary, created_at, content)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            note_id, kind, batch_id, title, category, content_length,
            0 if content is None else 1, summary,
            created_at or time.strftime("%Y-%m-%dT%H:%M:%S"), content,
        ),
    )
    conn.commit()
    return cur.lastrowid


def overwrite_revision(
    conn: sqlite3.Connection,
    revision_id: int,
    *,
    title: str,
    category: str,
    content: Optional[str],
    content_length: int,
    summary: str,
) -> None:
    """连续打字的自动保存合并进上一条 'edit'：内容换成最新的，时间也挪到现在。"""
    conn.execute(
        "UPDATE note_revisions SET title = ?, category = ?, content_length = ?, has_content = ?,"
        " summary = ?, created_at = ?, content = ? WHERE id = ?",
        (
            title, category, content_length, 0 if content is None else 1, summary,
            time.strftime("%Y-%m-%dT%H:%M:%S"), content, revision_id,
        ),
    )
    conn.commit()


def has_revisions(conn: sqlite3.Connection, note_id: int) -> bool:
    return conn.execute("SELECT 1 FROM note_revisions WHERE note_id = ? LIMIT 1", (note_id,)).fetchone() is not None


def latest_revisions(conn: sqlite3.Connection, note_id: int, count: int = 2) -> list[dict]:
    """最新的 count 条，带正文，新的在前。合并连续编辑时要同时看最新一条和它前一条。"""
    cur = conn.execute(
        f"SELECT {_REVISION_LIST_COLUMNS}, content FROM note_revisions WHERE note_id = ? ORDER BY id DESC LIMIT ?",
        (note_id, count),
    )
    return [_revision_to_dict(cur, row) for row in cur.fetchall()]


def list_revisions(conn: sqlite3.Connection, note_id: int, limit: int = MAX_REVISIONS_PER_NOTE) -> list[dict]:
    cur = conn.execute(
        f"SELECT {_REVISION_LIST_COLUMNS} FROM note_revisions WHERE note_id = ? ORDER BY id DESC LIMIT ?",
        (note_id, limit),
    )
    return [_revision_to_dict(cur, row) for row in cur.fetchall()]


def get_revision(conn: sqlite3.Connection, revision_id: int) -> Optional[dict]:
    cur = conn.execute(f"SELECT {_REVISION_LIST_COLUMNS}, content FROM note_revisions WHERE id = ?", (revision_id,))
    row = cur.fetchone()
    return _revision_to_dict(cur, row) if row is not None else None


def revision_before(conn: sqlite3.Connection, note_id: int, revision_id: int) -> Optional[dict]:
    """同一篇笔记里紧挨在 revision_id 之前的那一版（带正文）。"""
    cur = conn.execute(
        f"SELECT {_REVISION_LIST_COLUMNS}, content FROM note_revisions WHERE note_id = ? AND id < ? ORDER BY id DESC LIMIT 1",
        (note_id, revision_id),
    )
    row = cur.fetchone()
    return _revision_to_dict(cur, row) if row is not None else None


def batch_revisions(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    cur = conn.execute(
        f"SELECT {_REVISION_LIST_COLUMNS} FROM note_revisions WHERE batch_id = ? ORDER BY id ASC",
        (batch_id,),
    )
    return [_revision_to_dict(cur, row) for row in cur.fetchall()]


def prune_revisions(conn: sqlite3.Connection, note_id: int, keep: int = MAX_REVISIONS_PER_NOTE) -> None:
    """超出 keep 条时从旧的删。最早那条如果是 baseline/create——"最初是什么样"的
    唯一证据——就留着，从第二条开始删。"""
    ids = [row[0] for row in conn.execute(
        "SELECT id FROM note_revisions WHERE note_id = ? ORDER BY id ASC", (note_id,)
    ).fetchall()]
    overflow = len(ids) - keep
    if overflow <= 0:
        return
    first_kind = conn.execute("SELECT kind FROM note_revisions WHERE id = ?", (ids[0],)).fetchone()[0]
    start = 1 if first_kind in ("baseline", "create") else 0
    doomed = ids[start : start + overflow]
    placeholders = ",".join("?" for _ in doomed)
    conn.execute(f"DELETE FROM note_revisions WHERE id IN ({placeholders})", doomed)
    conn.commit()


def revision_timeline(conn: sqlite3.Connection, note_ids: Optional[list[int]], limit: int) -> list[dict]:
    """全部（或指定几篇）笔记的修改记录，新的在前，带笔记现在的标题和是否已删除。

    删除状态读 note_version 旁表而非 notes.is_deleted：后者在 content 之后，读它要走完大正文的溢出页链。"""
    cols = ", ".join(f"r.{c.strip()}" for c in _REVISION_LIST_COLUMNS.split(","))
    where = ""
    params: list = []
    if note_ids is not None:
        if not note_ids:
            return []
        where = f"WHERE r.note_id IN ({','.join('?' for _ in note_ids)})"
        params.extend(note_ids)
    params.append(limit)
    cur = conn.execute(
        f"SELECT {cols}, IFNULL(n.title, r.title) AS note_title,"
        f" CASE WHEN n.id IS NULL OR IFNULL(v.is_deleted, 0) = 1 THEN 1 ELSE 0 END AS note_deleted"
        f" FROM note_revisions r"
        f" LEFT JOIN notes n ON n.id = r.note_id"
        f" LEFT JOIN note_version v ON v.note_id = r.note_id"
        f" {where} ORDER BY r.id DESC LIMIT ?",
        params,
    )
    result = []
    for row in cur.fetchall():
        d = _revision_to_dict(cur, row)
        d["note_deleted"] = bool(d["note_deleted"])
        result.append(d)
    return result
