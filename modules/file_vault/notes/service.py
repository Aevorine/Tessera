"""Thin wrapper over notes/storage.py that owns the encrypted connection lifecycle.

Like ClipboardService but without background listeners: notes change only by explicit user action.
"""

import hashlib
import io
import os
import re
import time
from collections import OrderedDict
import uuid
from pathlib import Path
from typing import Callable, Optional

from PIL import Image, UnidentifiedImageError

from core.logging import get_logger
from modules.file_vault import errors, ui_settings
from modules.file_vault.notes import category_paths, classifier, segmented_content, storage

logger = get_logger(__name__)

TRASH_RETENTION_DAYS = 7

# Same 256x256 cap as clipboard/service.py's THUMBNAIL_MAX_SIZE, for the
# same reason (small enough to load a gallery of them instantly).
THUMBNAIL_MAX_SIZE = (256, 256)

# Read/write chunk (~1M chars) for the disk_plain import stream: keeps huge imports out of memory
# while on_progress stays responsive.
_STREAM_CHUNK_CHARS = 1_000_000

# 全文检索只索引正文的前 2MB，超限笔记只有开头可搜。FTS5 倒排索引体积随文本量增长，80MB 笔记会
# 让索引涨几十 MB、写入数秒；在超大文件里找东西本应在编辑器内搜。前端 8MB 阈值是独立常量，无耦合。
_FTS_INDEX_MAX_BYTES = 2 * 1024 * 1024

# 超过此大小，create_note_from_file 在导入时就切成 note_content_segments，而不是等
# open_segment_session 首次打开再转换（见 _convert_legacy_note_to_segments），
# 避免点开笔记时现付几十秒转换代价。与前端 LARGE_NOTE_THRESHOLD_BYTES 数值相同但各自独立。
_EAGER_SEGMENT_THRESHOLD_BYTES = 8 * 1024 * 1024

def _truncate_to_bytes(text: str, max_bytes: int) -> str:
    """把字符串截到不超过 max_bytes（UTF-8），不切出半个字符。

    先用 `len(text) <= max_bytes` 短路（ASCII 下字符数即字节上界），超限才 encode 一次；
    `errors="ignore"` 丢掉硬切产生的半个字符，得到最长合法前缀。
    """
    if len(text) <= max_bytes:
        return text
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


_MARKDOWN_EXTENSIONS = {".md", ".markdown"}

# Segment sessions are light but bounded, so repeatedly opening large notes without closing
# cannot grow backend memory unboundedly.
_SEGMENT_SESSION_TTL_SECONDS = 30 * 60
_MAX_SEGMENT_SESSIONS = 8


def _detect_format_from_path(path: str) -> str:
    """'markdown' for .md/.markdown files, else 'plain'; sets notes.format on import."""
    return "markdown" if Path(path).suffix.lower() in _MARKDOWN_EXTENSIONS else "plain"


def _read_text_with_fallback(path: Path, *, on_progress: Optional[Callable[[int, int], None]] = None) -> str:
    """Decodes UTF-8 first, falling back to GBK (the only two supported txt encodings).

    For the encrypted_db import path, where the whole text lands in memory anyway; still read in
    _STREAM_CHUNK_CHARS pieces so on_progress fires. Raises UnicodeDecodeError/OSError for the caller
    to map to notes.import_decode_failed/import_read_failed.
    """
    try:
        return _read_text_streaming(path, "utf-8", on_progress)
    except UnicodeDecodeError:
        return _read_text_streaming(path, "gbk", on_progress)


def _read_text_streaming(path: Path, encoding: str, on_progress: Optional[Callable[[int, int], None]]) -> str:
    total_hint = path.stat().st_size or 1
    pieces: list[str] = []
    read_bytes = 0
    with open(path, "r", encoding=encoding) as f:
        while True:
            piece = f.read(_STREAM_CHUNK_CHARS)
            if not piece:
                break
            pieces.append(piece)
            read_bytes += len(piece.encode("utf-8"))
            if on_progress is not None:
                on_progress(min(read_bytes, total_hint), total_hint)
    return "".join(pieces)


_CHUNK_CACHE_MAX_ENTRIES = 6
# 8 MiB 的字符数量级。够放下几篇很大的笔记，又不至于让后端常驻内存明显变胖。
_CHUNK_CACHE_MAX_CHARS = 8 * 1024 * 1024
# 闲置过期时间，出于安全而非性能：解密后的正文在内存里越久越可能被崩溃转储/内存取证看到。
_CHUNK_CACHE_TTL_SECONDS = 120.0


def _is_note_id(value) -> bool:
    # bool 是 int 的子类，不挡的话 True 会被当成 id=1。
    return isinstance(value, int) and not isinstance(value, bool)


def _seconds_since(stamp: str) -> float:
    """notes/note_revisions 的时间戳是本地时间 'YYYY-MM-DDTHH:MM:SS'。解析不了就当很久以前。"""
    try:
        return time.time() - time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError, OverflowError):
        return float("inf")


def _clip(text: str, limit: int = 24) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


class NotesService:
    def __init__(self, data_dir: Path, key: bytes):
        self.data_dir = data_dir
        # Only used when storage_mode is 'disk_plain'; always created so enabling it later needs no setup.
        self.images_dir = data_dir / "notes_images"
        self.thumbs_dir = data_dir / "notes_thumbnails"
        # Same, for note text stored as a plain file (storage.py content_storage_mode).
        self.texts_dir = data_dir / "notes_texts"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)
        self.texts_dir.mkdir(parents=True, exist_ok=True)

        self.conn = storage.connect(data_dir / "notes.db", key)
        _, purged_images, purged_content_paths = storage.purge_expired_deleted(self.conn, days=TRASH_RETENTION_DAYS)
        self._cleanup_image_files(purged_images)
        self._cleanup_text_files(purged_content_paths)
        self._ensure_fts_index()

        # get_content_chunk 的 encrypted_db 解密缓存：小 LRU，用户常在几条笔记间来回跳，避免每次重新解密。
        # 缓存里是明文，所以有两道闸：总字符数上限 _CHUNK_CACHE_MAX_CHARS、存活时长
        # _CHUNK_CACHE_TTL_SECONDS；锁定金库时后端进程会被换掉（pythonBridge.ts restartForLock）。
        self._chunk_read_cache: "OrderedDict[int, tuple]" = OrderedDict()

        # write_content_chunk 的进行中会话。与读缓存不同，disk_plain 会话持有文件句柄和磁盘临时文件，
        # 换笔记必须走 _abort_write_session 关闭/删除，不能只丢字典项。
        self._write_sessions: dict[int, dict] = {}
        # Segmented-reader sessions carry only note/session metadata.  Text is
        # fetched one bounded segment at a time from SQLCipher storage.
        self._segment_sessions: dict[str, dict] = {}

    def stop(self) -> None:
        for note_id in list(self._write_sessions):
            self._abort_write_session(note_id)
        self._segment_sessions.clear()
        self.conn.close()

    def _prune_segment_sessions(self) -> None:
        """Drops sessions idle past _SEGMENT_SESSION_TTL_SECONDS, so a crashed renderer cannot leak them."""
        now = time.monotonic()
        expired = [
            sid for sid, session in self._segment_sessions.items()
            if now - session["created_at"] > _SEGMENT_SESSION_TTL_SECONDS
        ]
        for sid in expired:
            self._segment_sessions.pop(sid, None)

    def _require_segment_session(self, session_id: str) -> dict:
        self._prune_segment_sessions()
        session = self._segment_sessions.get(session_id)
        if session is None:
            raise errors.VaultError("notes.segment_session_not_found")
        session["created_at"] = time.monotonic()  # sliding expiry on activity
        return session

    def list_notes(self, sort: Optional[str] = None) -> list:
        return self._merge_tags(storage.fetch_list(self.conn, sort=sort))

    def reorder_notes(self, ordered_ids) -> int:
        """Applies a hand-dragged order; returns how many notes moved.

        Validates ids here so a malformed payload becomes a UI-visible VaultError, not a TypeError.
        """
        if not isinstance(ordered_ids, list):
            raise errors.VaultError("notes.invalid_order")
        clean: list[int] = []
        seen: set[int] = set()
        for raw in ordered_ids:
            # bool 是 int 的子类，不挡的话 True 会被当成 id=1 悄悄改掉第一条笔记。
            if not isinstance(raw, int) or isinstance(raw, bool):
                raise errors.VaultError("notes.invalid_order")
            if raw in seen:  # 同一条出现两次，位置本身就是矛盾的，不猜用户想要哪个
                raise errors.VaultError("notes.invalid_order")
            seen.add(raw)
            clean.append(raw)
        return storage.set_manual_order(self.conn, clean)

    def get_note(self, note_id: int) -> Optional[dict]:
        row = storage.fetch_one(self.conn, note_id)
        if row is None or row["is_deleted"]:
            return None
        note = self._normalize_note_row(row)
        note["tags"] = [t["name"] for t in storage.get_tags_for_note(self.conn, note_id)]
        # 由后端算 fts_truncated，阈值只在后端定义一处，前端复制会漂移成"提示能搜到其实搜不到"。
        note["fts_truncated"] = self.fts_index_truncated(row["content_length"])
        note["fts_indexed_bytes"] = _FTS_INDEX_MAX_BYTES
        return note

    def search_notes(
        self,
        *,
        query: str = "",
        category: Optional[str] = None,
        tag: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: Optional[int] = None,
        sort: Optional[str] = None,
    ) -> list:
        """`limit=None` 用 storage 的默认值，默认条数只在 storage.search_notes 定义；负数 = 不限。"""
        limit_kwarg = {} if limit is None else {"limit": limit}
        return self._merge_tags(
            storage.search_notes(
                self.conn,
                query=query,
                category=category,
                tag=tag,
                date_from=date_from,
                date_to=date_to,
                sort=sort,
                **limit_kwarg,
            )
        )

    def find_notes_mentioning_title(self, note_id: int, title: str) -> list:
        return self._merge_tags(storage.find_notes_mentioning_title(self.conn, note_id, title))

    def open_segment_session(self, note_id: int) -> dict:
        """Opens a bounded reader/editor session for already-segmented text."""
        if not isinstance(note_id, int) or isinstance(note_id, bool):
            raise errors.VaultError("notes.note_not_found")
        self._prune_segment_sessions()
        row = storage.fetch_metadata(self.conn, note_id)
        if row is None or row["is_deleted"]:
            raise errors.VaultError("notes.note_not_found")
        count = storage.count_segments(self.conn, note_id)
        if count == 0:
            count = self._convert_legacy_note_to_segments(note_id, row)
        if len(self._segment_sessions) >= _MAX_SEGMENT_SESSIONS:
            # The detail pane never needs this many sessions: evict the oldest instead of growing unbounded.
            oldest_id = min(self._segment_sessions, key=lambda sid: self._segment_sessions[sid]["created_at"])
            self._segment_sessions.pop(oldest_id, None)
        session_id = uuid.uuid4().hex
        self._segment_sessions[session_id] = {"note_id": note_id, "created_at": time.monotonic()}
        return {"session_id": session_id, "segment_count": count, "note": row}

    def get_segment(self, session_id: str, ordinal: int) -> dict:
        session = self._require_segment_session(session_id)
        if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal < 0:
            raise errors.VaultError("notes.segment_not_found")
        segment = storage.fetch_segment(self.conn, session["note_id"], ordinal)
        if segment is None:
            raise errors.VaultError("notes.segment_not_found")
        return {"segment": segment, "segment_count": storage.count_segments(self.conn, session["note_id"])}

    def put_segment(self, session_id: str, segment_id: int, expected_revision: int, content: str) -> dict:
        session = self._require_segment_session(session_id)
        if not isinstance(segment_id, int) or isinstance(segment_id, bool):
            raise errors.VaultError("notes.segment_not_found")
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 1:
            raise errors.VaultError("notes.segment_revision_conflict")
        if not isinstance(content, str):
            raise errors.VaultError("notes.segment_too_large", limit_bytes=segmented_content.MAX_SEGMENT_BYTES, actual_bytes=0)
        try:
            byte_size = segmented_content.validate_segment_content(content)
        except ValueError:
            raise errors.VaultError(
                "notes.segment_too_large", limit_bytes=segmented_content.MAX_SEGMENT_BYTES, actual_bytes=len(content.encode("utf-8"))
            )
        # Ownership check: a session may only write segments of its own note, so a stale or forged
        # segment_id (other note, second window) cannot cross-write.
        existing = self.conn.execute(
            "SELECT note_id FROM note_content_segments WHERE id = ?", (segment_id,)
        ).fetchone()
        if existing is None:
            raise errors.VaultError("notes.segment_not_found")
        if existing[0] != session["note_id"]:
            raise errors.VaultError("notes.segment_session_not_found")
        self._ensure_baseline(session["note_id"])
        segment = storage.update_segment(
            self.conn, segment_id, expected_revision=expected_revision, content=content, byte_size=byte_size
        )
        if segment is None:
            raise errors.VaultError("notes.segment_revision_conflict")
        # 分段笔记的正文不进快照（见 _revision_can_hold_body），这里只记下"什么时候
        # 改过正文"；一段时间里连续保存多段会合并成一条。
        self._record_revision(session["note_id"], "edit", force=True)
        return {"segment": segment}

    def close_segment_session(self, session_id: str) -> None:
        self._segment_sessions.pop(session_id, None)

    def migrate_legacy_large_notes(self) -> None:
        """Convert legacy large notes before the renderer opens one."""
        for row in storage.fetch_list(self.conn):
            if row["content_length"] <= _EAGER_SEGMENT_THRESHOLD_BYTES:
                continue
            if storage.count_segments(self.conn, row["id"]) != 0:
                continue
            try:
                self._convert_legacy_note_to_segments(row["id"], row)
            except Exception as exc:
                logger.warning("Could not migrate legacy large note %s: %s", row["id"], exc)

    def _convert_legacy_note_to_segments(self, note_id: int, row: dict) -> int:
        """One-time conversion of a legacy note body into bounded segment rows.

        Runs in one SQLite transaction with clearing the legacy body, so a failure rolls back and the
        note stays retryable on the next open_segment_session. `row` needs only
        content_storage_mode/content_length/preview.
        """
        legacy = storage.fetch_one(self.conn, note_id)
        if legacy is None:
            raise errors.VaultError("notes.content_not_found")
        try:
            if row["content_storage_mode"] == "disk_plain":
                path = legacy.get("content_path")
                if not path:
                    raise errors.VaultError("notes.content_not_found")
                try:
                    count = storage.replace_segments_uncommitted(
                        self.conn, note_id, self._stream_split_disk_plain(Path(path), "utf-8")
                    )
                except UnicodeDecodeError:
                    count = storage.replace_segments_uncommitted(
                        self.conn, note_id, self._stream_split_disk_plain(Path(path), "gbk")
                    )
                except OSError as exc:
                    raise errors.VaultError("notes.content_not_found") from exc
            else:
                if not legacy["content"]:
                    raise errors.VaultError("notes.content_not_found")
                count = storage.replace_segments_uncommitted(
                    self.conn,
                    note_id,
                    ((s.content, s.byte_size) for s in segmented_content.split_text(legacy["content"])),
                )
            if count == 0:
                raise errors.VaultError("notes.content_not_found")
            storage.update_note(
                self.conn,
                note_id,
                content="",
                content_byte_size=row["content_length"],
                content_preview=row["preview"],
                _commit=False,
            )
        except Exception:
            self.conn.rollback()
            raise
        self.conn.commit()
        return count

    def _stream_split_disk_plain(self, path: Path, encoding: str):
        """Reads a disk_plain note's source file in bounded _STREAM_CHUNK_CHARS pieces, carrying at most
        one incomplete boundary segment between reads; never holds the whole file."""
        carry = ""
        with open(path, "r", encoding=encoding) as f:
            while True:
                chunk = f.read(_STREAM_CHUNK_CHARS)
                text = carry + chunk
                if not chunk:
                    for piece in segmented_content.split_text(text):
                        yield piece.content, piece.byte_size
                    return
                pieces = list(segmented_content.split_text(text))
                if len(pieces) <= 1:
                    carry = text
                    continue
                for piece in pieces[:-1]:
                    yield piece.content, piece.byte_size
                carry = pieces[-1].content

    def export_note_text(self, note_id: int, out_path: Path) -> bool:
        """Streams a note's current full text to out_path.

        Once segmented, segments are authoritative: a disk_plain source file goes stale on edit and must
        not be read again. Notes without segments fall back to get_note().
        """
        row = storage.fetch_metadata(self.conn, note_id)
        if row is None or row["is_deleted"]:
            return False
        count = storage.count_segments(self.conn, note_id)
        if count > 0:
            with open(out_path, "w", encoding="utf-8") as f:
                for ordinal in range(count):
                    segment = storage.fetch_segment(self.conn, note_id, ordinal)
                    f.write(segment["content"] if segment else "")
            return True
        note = self.get_note(note_id)
        if note is None:
            return False
        out_path.write_text(note["content"], encoding="utf-8")
        return True

    def get_note_title(self, note_id: int) -> Optional[str]:
        row = storage.fetch_metadata(self.conn, note_id)
        if row is None or row["is_deleted"]:
            return None
        return row["title"]

    def _merge_tags(self, rows: list) -> list:
        """Attaches `tags: list[str]` to each list row using one extra query for the whole batch."""
        if not rows:
            return rows
        tag_names = storage.get_tag_names_for_notes(self.conn, [row["id"] for row in rows])
        for row in rows:
            row["tags"] = tag_names.get(row["id"], [])
        return rows

    def _ensure_fts_index(self) -> None:
        """Builds the initial FTS5 index after an upgrade; the completion marker is stored only after all
        active notes are indexed."""
        marker = self.conn.execute(
            "SELECT value FROM settings WHERE key = 'notes_fts_index_version'"
        ).fetchone()
        if marker and marker[0] == "1":
            return
        for row in storage.fetch_list(self.conn):
            self._reindex_fts(row["id"])
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('notes_fts_index_version', '1')"
        )
        self.conn.commit()

    def _reindex_fts(self, note_id: int) -> None:
        """Refreshes one note's FTS row after content/title/category/tag changes (see _FTS_INDEX_MAX_BYTES)."""
        row = storage.fetch_one(self.conn, note_id)
        if row is None or row["is_deleted"]:
            return
        content_for_index = self._content_for_index(row)
        tags = [t["name"] for t in storage.get_tags_for_note(self.conn, note_id)]
        storage.reindex_note_fts(self.conn, note_id, title=row["title"], content=content_for_index, category=row["category"], tags=tags)

    def _reindex_fts_bulk(self, note_ids: list[int]) -> None:
        """Batched _reindex_fts for bulk actions: per-note lookups, but a single FTS delete/insert/commit."""
        entries = []
        for note_id in note_ids:
            row = storage.fetch_one(self.conn, note_id)
            if row is None or row["is_deleted"]:
                continue
            content_for_index = self._content_for_index(row)
            tags = [t["name"] for t in storage.get_tags_for_note(self.conn, note_id)]
            entries.append((note_id, row["title"], content_for_index, row["category"], tags))
        storage.reindex_notes_fts_bulk(self.conn, entries)

    def _content_for_index(self, row: dict) -> str:
        """要写进 FTS 的正文：小笔记全文，超限笔记取真正的前 2MB。

        超限时不能走 `_normalize_note_row(row)["content"]`，那会把整篇读进内存；改用有界读取
        _bounded_content。
        """
        if row["content_length"] <= _FTS_INDEX_MAX_BYTES:
            return self._normalize_note_row(row)["content"]
        return self._bounded_content(row, _FTS_INDEX_MAX_BYTES)

    def _bounded_content(self, row: dict, max_bytes: int) -> str:
        """读笔记开头不超过 max_bytes（UTF-8）的正文，绝不整篇读进内存。

        三种存储形态（disk_plain 按块读、encrypted_db 截断整行、分段存储逐段取）只在这里统一处理。
        按字节而非字符截断，因为上限针对索引体积/内存；末尾回退到字符边界。
        """
        note_id = row["id"]
        if row.get("content_storage_mode") == "disk_plain" and row.get("content_path"):
            try:
                with open(row["content_path"], "r", encoding="utf-8", errors="replace") as handle:
                    return _truncate_to_bytes(handle.read(max_bytes), max_bytes)
            except OSError:
                # 文件读不到时退回 preview——索引少一点内容远好过让一次改标签/
                # 改分类的操作整个失败。
                return row.get("preview") or ""

        content = row.get("content") or ""
        if content:
            return _truncate_to_bytes(content, max_bytes)

        pieces: list[str] = []
        total = 0
        ordinal = 0
        while total < max_bytes:
            segment = storage.fetch_segment(self.conn, note_id, ordinal)
            if segment is None:
                break
            pieces.append(segment["content"])
            total += segment["byte_size"]
            ordinal += 1
        return _truncate_to_bytes("".join(pieces), max_bytes)

    @staticmethod
    def fts_index_truncated(content_length: int) -> bool:
        """这篇笔记是不是只索引了开头一段。前端据此在详情页标注"本篇仅索引前
        2MB"——搜不到某段内容时用户得知道原因，而不是以为搜索坏了。"""
        return content_length > _FTS_INDEX_MAX_BYTES

    def get_content_chunk(self, note_id: int, cursor: Optional[int], max_chars: int) -> dict:
        """Serves a large note in bounded pieces so the viewer/editor never sends the full text in one
        IPC message. cursor is None on the first call; pass back next_cursor until eof is True.

        disk_plain seeks into the file each call (O(chunk), no cache needed). encrypted_db has no partial
        read (blobopen needs Python 3.11+, project targets 3.9), so the first call decodes the whole row
        into self._chunk_read_cache for later chunks.
        """
        # 续读先只取元数据：`fetch_one` 会 SELECT 整个 content 列（加密库里可能几百 MB），
        # 每段都付一次这个代价，缓存就白做了；命中缓存时不碰 content 列。
        if cursor is not None:
            # 走旁表而非 fetch_metadata：后者要读 content 之后的列，会走完大列的溢出页链，
            # 代价接近读全文；旁表是整数主键点查。
            version = storage.fetch_content_version(self.conn, note_id)
            if version is None or version["is_deleted"]:
                raise errors.VaultError("notes.note_not_found")
            if version["storage_mode"] != "disk_plain":
                cached = self._cache_get(note_id, version["version"])
                if cached is not None:
                    return self._slice_content(cached, cursor, max_chars)

        row = storage.fetch_one(self.conn, note_id)
        if row is None or row["is_deleted"]:
            raise errors.VaultError("notes.note_not_found")

        if row["content_storage_mode"] == "disk_plain":
            try:
                with open(row["content_path"], "r", encoding="utf-8") as f:
                    if cursor:
                        f.seek(cursor)
                    chunk = f.read(max_chars)
                    next_cursor = f.tell()
            except OSError:
                raise errors.VaultError("notes.content_not_found")
            return {"chunk": chunk, "next_cursor": next_cursor, "eof": len(chunk) < max_chars}

        # 用 `updated_at` 作缓存有效性凭据：靠在多个写方法里手动清缓存，漏一个就会静默读到旧内容；
        # 这里顺手比一个字段，新增写路径也无需改这里。
        version = storage.fetch_content_version(self.conn, note_id)
        self._cache_put(note_id, row["content"], version["version"] if version else None)
        # 读到底**不再丢弃**——留着正是为了"翻走再翻回来"那一下。存活时长和
        # 总量上限负责兜住内存与暴露面，见 __init__ 里那段注释。
        return self._slice_content(row["content"], cursor, max_chars)

    @staticmethod
    def _slice_content(full_content: str, cursor: Optional[int], max_chars: int) -> dict:
        start = cursor or 0
        chunk = full_content[start : start + max_chars]
        next_cursor = start + len(chunk)
        return {"chunk": chunk, "next_cursor": next_cursor, "eof": next_cursor >= len(full_content)}

    # --- 正文缓存（LRU + 总量上限 + 存活时长）---

    def _cache_get(self, note_id: int, stamp) -> Optional[str]:
        entry = self._chunk_read_cache.get(note_id)
        if entry is None:
            return None
        content, stored_at, cached_stamp = entry
        if cached_stamp != stamp:
            self._chunk_read_cache.pop(note_id, None)
            return None
        if time.time() - stored_at > _CHUNK_CACHE_TTL_SECONDS:
            self._chunk_read_cache.pop(note_id, None)
            return None
        self._chunk_read_cache.move_to_end(note_id)
        return content

    def _cache_put(self, note_id: int, content: str, stamp) -> None:
        # 单篇就超过总量上限时，索性不缓存：放进去会立刻把别人全挤掉，而它自己
        # 下一次也留不住，纯粹是白占一次内存峰值。
        if len(content) > _CHUNK_CACHE_MAX_CHARS:
            self._chunk_read_cache.pop(note_id, None)
            return
        self._chunk_read_cache[note_id] = (content, time.time(), stamp)
        self._chunk_read_cache.move_to_end(note_id)
        total = sum(len(text) for text, _, _ in self._chunk_read_cache.values())
        while self._chunk_read_cache and (
            len(self._chunk_read_cache) > _CHUNK_CACHE_MAX_ENTRIES
            or total > _CHUNK_CACHE_MAX_CHARS
        ):
            _, (evicted, _ts, _st) = self._chunk_read_cache.popitem(last=False)
            total -= len(evicted)

    def forget_cached_content(self, note_id: Optional[int] = None) -> None:
        """把缓存里的解密正文丢掉。笔记被改 / 被删 / 被清空时必须调，否则下一次
        读到的是旧内容——而"内容是旧的"在界面上跟"内容是对的"长得一模一样。"""
        if note_id is None:
            self._chunk_read_cache.clear()
        else:
            self._chunk_read_cache.pop(note_id, None)

    def write_content_chunk(self, note_id: int, chunk: str, *, is_first: bool, is_last: bool) -> dict:
        """Counterpart to get_content_chunk for saving a large existing note in chunks.

        is_first opens a fresh session (aborting any other note's; the UI edits one note at a time);
        is_last finalizes. disk_plain streams to a temp file and os.replace()s it into content_path only
        when complete, so a crash can't leave a half-written file. encrypted_db accumulates in memory,
        then reuses storage.update_note. Only note_content_write_chunk calls this; title/category stay
        on update_note.
        """
        if is_first:
            row = storage.fetch_one(self.conn, note_id)
            if row is None or row["is_deleted"]:
                raise errors.VaultError("notes.note_not_found")
            for other_id in list(self._write_sessions):
                self._abort_write_session(other_id)
            if row["content_storage_mode"] == "disk_plain":
                temp_path = self.texts_dir / f".write-{note_id}-{uuid.uuid4().hex[:8]}.tmp"
                self._write_sessions[note_id] = {
                    "mode": "disk_plain",
                    "content_path": row["content_path"],
                    "temp_path": temp_path,
                    "file": open(temp_path, "w", encoding="utf-8"),
                    "byte_size": 0,
                    "preview": "",
                }
            else:
                self._write_sessions[note_id] = {"mode": "encrypted_db", "buffer": []}

        session = self._write_sessions.get(note_id)
        if session is None:
            # No session for this note: the frontend always starts with is_first=True, so this is a caller bug.
            raise errors.VaultError("notes.write_session_not_found")

        if session["mode"] == "disk_plain":
            session["byte_size"] += len(chunk.encode("utf-8"))
            if session["byte_size"] > storage.NOTE_BYTE_LIMIT:
                self._abort_write_session(note_id)
                raise errors.VaultError(
                    "notes.content_too_large", limit_bytes=storage.NOTE_BYTE_LIMIT, actual_bytes=session["byte_size"]
                )
            session["file"].write(chunk)
            if len(session["preview"]) < storage.PREVIEW_CHARS:
                # Chunk sizes can be smaller than PREVIEW_CHARS, so accumulate the preview across chunks.
                session["preview"] = (session["preview"] + chunk)[: storage.PREVIEW_CHARS]
        else:
            session["buffer"].append(chunk)

        if not is_last:
            return {"done": False}

        self._ensure_baseline(note_id)
        if session["mode"] == "disk_plain":
            session["file"].close()
            self._write_sessions.pop(note_id, None)
            os.replace(session["temp_path"], session["content_path"])
            storage.update_note(
                self.conn,
                note_id,
                content="",
                content_byte_size=session["byte_size"],
                content_preview=session["preview"],
            )
        else:
            full_content = "".join(self._write_sessions.pop(note_id)["buffer"])
            if not storage.update_note(self.conn, note_id, content=full_content):
                raise errors.VaultError("notes.note_not_found")

        self._reindex_fts(note_id)
        self._record_revision(note_id, "edit", force=True)
        return {"done": True, "note": self._normalize_note_row(storage.fetch_one(self.conn, note_id), include_content=False)}

    def _abort_write_session(self, note_id: int) -> None:
        """Closes/deletes the note's write session without finalizing; a no-op if none exists."""
        session = self._write_sessions.pop(note_id, None)
        if session is None:
            return
        if session["mode"] == "disk_plain":
            session["file"].close()
            session["temp_path"].unlink(missing_ok=True)

    def create_note(
        self, *, title: str, category: str, content: str, encrypt: bool = True, format: str = "plain",
        hidden: bool = False
    ) -> dict:
        """encrypt fixes content_storage_mode for this note once, forever.

        True (default) stores text in the encrypted notes.db; False writes a plain .txt under
        self.texts_dir and records only the path in the encrypted row.

        `hidden` is applied at INSERT, not by a follow-up set_hidden: a note meant to be hidden must never
        be visible, even if a crash hit between two statements.
        """
        content_storage_mode = "encrypted_db" if encrypt else "disk_plain"
        content_path = self._write_text_file(content) if not encrypt else None
        note_id = storage.insert_note(
            self.conn,
            title=title,
            category=category,
            content=content,
            content_storage_mode=content_storage_mode,
            content_path=content_path,
            format=format,
            is_hidden=hidden,
        )
        self._reindex_fts(note_id)
        self._record_revision(note_id, "create", force=True)
        return self.get_note(note_id)

    def create_note_from_file(
        self, *, title: str, category: str, source_path: str, encrypt: bool,
        on_progress: Optional[Callable[[int, int], None]] = None, hidden: bool = False
    ) -> dict:
        """Like create_note but takes a path, for importing txt files that can be hundreds of MB.

        encrypted_db reads it fully and delegates; disk_plain streams to its final location re-encoded as
        UTF-8, computing size/preview on the way. An empty `category` triggers auto-classification (only
        this path does; a non-empty one is never overridden); with `hidden`, scoring uses the hidden
        scope's catalog. The result omits `content`. Notes past _EAGER_SEGMENT_THRESHOLD_BYTES are
        segmented here so the first open is not a whole-file conversion.
        """
        format = _detect_format_from_path(source_path)
        classify_scope = "hidden" if hidden else "normal"
        if encrypt:
            content = _read_text_with_fallback(Path(source_path), on_progress=on_progress)
            if not category:
                category = classifier.classify(title, content, self._classify_candidates(classify_scope)) or ""
            note = self.create_note(
                title=title, category=category, content=content, encrypt=True, format=format, hidden=hidden
            )
            if note["content_length"] > _EAGER_SEGMENT_THRESHOLD_BYTES:
                self._convert_legacy_note_to_segments(note["id"], note)
            note.pop("content", None)
            return note

        stem = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        dest_path = self.texts_dir / f"{stem}.txt"
        try:
            byte_size, preview, classify_excerpt = self._stream_copy_text_file(
                Path(source_path), dest_path, on_progress=on_progress
            )
        except errors.VaultError:
            raise
        except OSError as exc:
            raise errors.VaultError("notes.import_read_failed", detail=str(exc))
        if not category:
            category = classifier.classify(title, classify_excerpt, self._classify_candidates(classify_scope)) or ""
        note_id = storage.insert_note(
            self.conn,
            title=title,
            category=category,
            content="",
            content_storage_mode="disk_plain",
            content_path=str(dest_path),
            format=format,
            content_byte_size=byte_size,
            content_preview=preview,
            is_hidden=hidden,
        )
        if byte_size > _EAGER_SEGMENT_THRESHOLD_BYTES:
            self._convert_legacy_note_to_segments(note_id, storage.fetch_metadata(self.conn, note_id))
        self._reindex_fts(note_id)
        self._record_revision(note_id, "create", force=True)
        result = self._normalize_note_row(storage.fetch_one(self.conn, note_id), include_content=False)
        result["tags"] = []
        return result

    def _classify_candidates(self, scope: str) -> list:
        """Category names notes/classifier.py may match an imported file against.

        The managed catalog (with keywords) plus category text already used by notes in this scope, so
        frontend preset categories (never "created" in the backend) count once used. Deduped by name;
        catalog entries come first and their keywords win.
        """
        candidates: dict[str, list[str]] = {}
        for row in storage.list_categories(self.conn, scope):
            candidates[row["name"]] = classifier.split_keywords(row["keywords"])
        for name in storage.list_categories_in_use(self.conn, scope):
            candidates.setdefault(name, [])
        return [{"name": name, "keywords": keywords} for name, keywords in candidates.items()]

    # 一次重分类最多检查的笔记数：预览要读每篇摘要打分（disk_plain 还要读文件），更大规模应是后台任务。
    _RECLASSIFY_SCAN_LIMIT = 500

    def reclassify_preview(self, scope: str, *, include_categorized: bool = False) -> dict:
        """重跑自动分类，只返回会怎么改，不写库。

        强制「预览 → 确认 → 应用」，因为规则打分器不知道用户为何手工归档，自动回溯会静默推翻手工分类。
        `include_categorized=False`（默认）只看未分类笔记，绝不碰已有归属的。
        """
        candidates = self._classify_candidates(scope)
        if not candidates:
            return {"changes": [], "scanned": 0, "truncated": False}

        is_hidden = 1 if scope == "hidden" else 0
        where_category = "" if include_categorized else "AND category = ''"
        rows = self.conn.execute(
            f"SELECT id, title, category FROM notes "
            f"WHERE is_deleted = 0 AND is_hidden = ? {where_category} "
            f"ORDER BY id DESC LIMIT ?",
            (is_hidden, self._RECLASSIFY_SCAN_LIMIT + 1),
        ).fetchall()
        truncated = len(rows) > self._RECLASSIFY_SCAN_LIMIT
        rows = rows[: self._RECLASSIFY_SCAN_LIMIT]

        changes = []
        for note_id, title, current_category in rows:
            excerpt = self._classify_excerpt_for(note_id)
            suggested = classifier.classify(title or "", excerpt, candidates)
            # 分类器返回 None 表示"没有任何候选匹配得上"。这**不是**"应该清空
            # 分类"的意思——绝不能把它当成一个把已分类笔记打回未分类的信号。
            if not suggested or suggested == current_category:
                continue
            changes.append(
                {
                    "id": note_id,
                    "title": title or "",
                    "from_category": current_category,
                    "to_category": suggested,
                }
            )
        return {"changes": changes, "scanned": len(rows), "truncated": truncated}

    def reclassify_apply(self, changes: list) -> int:
        """把用户在预览里确认过的改动写入，返回实际改动篇数。

        参数用预览返回的列表而非重跑分类器，保证确认的和实际发生的一致。每项带 `from_category`
        做乐观并发校验：预览后分类被改过就跳过，不覆盖更新的值。
        """
        applied_ids = []
        batch_id = uuid.uuid4().hex
        for change in changes:
            # 每项都当不可信输入：列表经过前端（可剔行）回传，非字典元素会让 RPC 抛 AttributeError。
            if not isinstance(change, dict):
                continue
            note_id = change.get("id")
            to_category = change.get("to_category")
            if not isinstance(note_id, int) or not isinstance(to_category, str):
                continue
            try:
                to_category = category_paths.validate_path(to_category)
            except category_paths.CategoryPathError:
                continue
            current = storage.fetch_metadata(self.conn, note_id)
            if current is None or current["category"] != change.get("from_category", ""):
                continue
            self._ensure_baseline(note_id)
            if storage.update_note(self.conn, note_id, category=to_category):
                applied_ids.append(note_id)
        for note_id in applied_ids:
            self._reindex_fts(note_id)
            self._record_revision(note_id, "bulk_category", batch_id=batch_id)
        return len(applied_ids)

    def _classify_excerpt_for(self, note_id: int) -> str:
        """取笔记开头一小段正文用于分类打分，绝不整篇读进内存。

        复用 _bounded_content 的有界读取，上限比 FTS 小得多；80MB 和 2KB 的笔记开销必须一样。
        """
        row = storage.fetch_one(self.conn, note_id)
        if row is None:
            return ""
        # CLASSIFY_EXCERPT_CHARS 是字符数而 _bounded_content 按字节截：乘 3（CJK 最多 3 字节）保证不少读，
        # 再按字符数精确截。
        raw = self._bounded_content(row, classifier.CLASSIFY_EXCERPT_CHARS * 3)
        return raw[: classifier.CLASSIFY_EXCERPT_CHARS]

    def update_note(self, note_id: int, *, title=None, category=None, content=None) -> Optional[dict]:
        return self._update_note(note_id, title=title, category=category, content=content)

    def _update_note(
        self, note_id: int, *, title=None, category=None, content=None,
        kind: Optional[str] = None, batch_id: Optional[str] = None, summary: Optional[str] = None,
    ) -> Optional[dict]:
        """update_note 本体，外加时间线：kind=None 时由 _record_revision 按实际
        变化判定是 edit 还是 metadata；批量修改 / 恢复 / 撤销传各自的 kind。"""
        self._ensure_baseline(note_id)
        if content is not None:
            current = storage.fetch_one(self.conn, note_id)
            if current is not None and current["content_storage_mode"] == "disk_plain" and current["content_path"]:
                try:
                    Path(current["content_path"]).write_text(content, encoding="utf-8")
                except OSError:
                    raise errors.VaultError("notes.content_write_failed")
        ok = storage.update_note(self.conn, note_id, title=title, category=category, content=content)
        if not ok:
            return None
        self._reindex_fts(note_id)
        self._record_revision(note_id, kind, batch_id=batch_id, summary=summary)
        return self.get_note(note_id)

    def update_note_metadata(self, note_id: int, *, title=None, category=None) -> Optional[dict]:
        """Updates title/category and returns a list-shaped row via fetch_metadata, never loading the body."""
        self._ensure_baseline(note_id)
        ok = storage.update_note(self.conn, note_id, title=title, category=category)
        if not ok:
            return None
        self._reindex_fts(note_id)
        self._record_revision(note_id)
        row = storage.fetch_metadata(self.conn, note_id)
        if row is None or row["is_deleted"]:
            return None
        row["tags"] = [tag["name"] for tag in storage.get_tags_for_note(self.conn, note_id)]
        return row

    def set_format(self, note_id: int, format: str) -> Optional[dict]:
        """Lets the user re-tag a note as plain/markdown after creation; detected format isn't final."""
        if format not in ("plain", "markdown"):
            raise errors.VaultError("notes.invalid_format", format=format)
        ok = storage.update_note(self.conn, note_id, format=format)
        if not ok:
            return None
        return self._normalize_note_row(storage.fetch_one(self.conn, note_id))

    def _write_text_file(self, content: str) -> str:
        """Same naming scheme as _write_image_files: millisecond timestamp + short uuid."""
        stem = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        path = self.texts_dir / f"{stem}.txt"
        path.write_text(content, encoding="utf-8")
        return str(path)

    def _stream_copy_text_file(
        self, source_path: Path, dest_path: Path, *, on_progress: Optional[Callable[[int, int], None]] = None
    ) -> tuple[int, str, str]:
        """Streams source_path into dest_path as UTF-8 in _STREAM_CHUNK_CHARS pieces (disk_plain notes are
        always UTF-8 on disk), never holding the file as one string.

        Returns (byte_size, preview, classify_excerpt) so the caller needs no second pass; the excerpt is
        bounded by classifier.CLASSIFY_EXCERPT_CHARS. If UTF-8 fails midway, the partial dest is discarded
        and the copy retried once with GBK; if that fails too, UnicodeDecodeError propagates for
        notes.import_decode_failed.
        """
        total_hint = source_path.stat().st_size or 1
        last_error: Optional[UnicodeDecodeError] = None
        for encoding in ("utf-8", "gbk"):
            written_bytes = 0
            preview = ""
            classify_excerpt = ""
            try:
                with open(source_path, "r", encoding=encoding) as src, open(dest_path, "w", encoding="utf-8") as dst:
                    while True:
                        chunk = src.read(_STREAM_CHUNK_CHARS)
                        if not chunk:
                            break
                        if len(preview) < storage.PREVIEW_CHARS:
                            preview = (preview + chunk)[: storage.PREVIEW_CHARS]
                        if len(classify_excerpt) < classifier.CLASSIFY_EXCERPT_CHARS:
                            classify_excerpt = (classify_excerpt + chunk)[: classifier.CLASSIFY_EXCERPT_CHARS]
                        dst.write(chunk)
                        written_bytes += len(chunk.encode("utf-8"))
                        if written_bytes > storage.NOTE_BYTE_LIMIT:
                            raise errors.VaultError(
                                "notes.content_too_large",
                                limit_bytes=storage.NOTE_BYTE_LIMIT,
                                actual_bytes=written_bytes,
                            )
                        if on_progress is not None:
                            on_progress(min(written_bytes, total_hint), total_hint)
            except UnicodeDecodeError as exc:
                last_error = exc
                dest_path.unlink(missing_ok=True)
                continue
            except (OSError, errors.VaultError):
                dest_path.unlink(missing_ok=True)
                raise
            return written_bytes, preview, classify_excerpt
        raise last_error

    def _normalize_note_row(self, row: dict, *, include_content: bool = True) -> dict:
        """Normalizes a storage.py full row to one with real `content` for either storage mode, so RPC
        handlers stay unaware of the modes. content_path is internal and never leaves this module.

        include_content=False skips reading a disk_plain file back (import flows don't need it)."""
        row = dict(row)
        if not include_content:
            row.pop("content", None)
        elif row.get("content_storage_mode") == "disk_plain":
            path = row.get("content_path")
            try:
                row["content"] = Path(path).read_text(encoding="utf-8") if path else ""
            except OSError:
                raise errors.VaultError("notes.content_not_found")
        row.pop("content_path", None)
        return row

    def set_pinned(self, note_id: int, pinned: bool) -> bool:
        return storage.set_pinned(self.conn, note_id, pinned)

    def set_pinned_bulk(self, note_ids: list[int], pinned: bool) -> int:
        return storage.set_pinned_bulk(self.conn, note_ids, pinned)

    def set_hidden(self, note_id: int, hidden: bool) -> bool:
        return storage.set_hidden(self.conn, note_id, hidden)

    def set_hidden_bulk(self, note_ids: list[int], hidden: bool) -> int:
        return storage.set_hidden_bulk(self.conn, note_ids, hidden)

    def delete_note(self, note_id: int) -> bool:
        return storage.soft_delete(self.conn, note_id)

    def delete_notes_bulk(self, note_ids: list[int]) -> int:
        return storage.soft_delete_bulk(self.conn, note_ids)

    def restore_notes_bulk(self, note_ids: list[int]) -> int:
        count = storage.restore_bulk(self.conn, note_ids)
        # A note trashed before the FTS backfill ran was never indexed; restoring must reindex it.
        self._reindex_fts_bulk(note_ids)
        return count

    def update_category_bulk(self, note_ids: list[int], category: str) -> int:
        return self.update_category_bulk_with_batch(note_ids, category)[0]

    def update_category_bulk_with_batch(self, note_ids: list[int], category: str) -> tuple[int, str]:
        """同 update_category_bulk，另外返回这一批在时间线上共用的 batch_id（供整批撤销）。"""
        batch_id = uuid.uuid4().hex
        for note_id in note_ids:
            self._ensure_baseline(note_id)
        count = storage.update_category_bulk(self.conn, note_ids, category)
        self._reindex_fts_bulk(note_ids)
        for note_id in note_ids:
            self._record_revision(note_id, "bulk_category", batch_id=batch_id)
        return count, batch_id

    def move_to_hidden_bulk(self, note_ids: list[int], category: str) -> int:
        """一步完成「隐藏 + 归入某个隐藏分类」。

        分类路径仍走 category_paths 校验：隐藏区不是放宽校验的理由（超长路径同样撑坏侧边栏、参与前缀 LIKE）。
        """
        # validate_path（严格），不是 normalize_path（宽松）：这是一条**写入**
        # 路径，`财务//2026` 是用户的输入错误，当面报比悄悄吞掉那个空段好。
        category = category_paths.validate_path(category or "")
        batch_id = uuid.uuid4().hex
        for note_id in note_ids:
            self._ensure_baseline(note_id)
        count = storage.move_to_hidden_bulk(self.conn, note_ids, category)
        self._reindex_fts_bulk(note_ids)
        for note_id in note_ids:
            self._record_revision(note_id, "bulk_category", batch_id=batch_id)
        return count

    def restore_note(self, note_id: int) -> bool:
        restored = storage.restore(self.conn, note_id)
        if restored:
            # See restore_notes_bulk's comment: a note trashed before the FTS
            # backfill ran was never indexed and needs it done here instead.
            self._reindex_fts(note_id)
        return restored

    def list_trash(self) -> list:
        return self._merge_tags(storage.fetch_deleted(self.conn))

    def hard_delete_note(self, note_id: int) -> bool:
        ok, removed_images, removed_content_paths = storage.hard_delete(self.conn, note_id)
        self._cleanup_image_files(removed_images)
        self._cleanup_text_files(removed_content_paths)
        return ok

    def hard_delete_notes_bulk(self, note_ids: list[int]) -> int:
        count, removed_images, removed_content_paths = storage.hard_delete_bulk(self.conn, note_ids)
        self._cleanup_image_files(removed_images)
        self._cleanup_text_files(removed_content_paths)
        return count

    def list_categories(self, scope: str) -> list:
        return storage.list_categories(self.conn, scope)

    def create_category(self, name: str, scope: str, keywords: str = "") -> dict:
        return storage.create_category(self.conn, name, scope, keywords=keywords)

    def set_category_keywords(self, category_id: int, keywords: str) -> Optional[dict]:
        return storage.set_category_keywords(self.conn, category_id, keywords)

    def category_impact(self, category_id: int) -> Optional[dict]:
        """删除/重命名前的影响范围预览（子分类数、直接笔记数、子孙笔记数）。
        前端拿它弹确认框，让用户在看得见后果的前提下选删除语义。"""
        return storage.category_impact(self.conn, category_id)

    def delete_category(self, category_id: int, mode: str = "promote") -> Optional[dict]:
        """mode='promote' 子分类提升到父级（笔记一篇不丢），
        mode='cascade' 删整棵子树（子树下的笔记变成未分类，笔记本身不删）。"""
        return storage.delete_category(self.conn, category_id, mode)

    def rename_category(self, category_id: int, new_name: str) -> Optional[dict]:
        """重命名 / 移动一个分类连同它整棵子树——物化路径下这是同一个操作。"""
        return storage.rename_category(self.conn, category_id, new_name)

    def list_tags(self, scope: str) -> list:
        return storage.list_tags(self.conn, scope)

    def create_tag(self, name: str, scope: str) -> dict:
        return storage.create_tag(self.conn, name, scope)

    def delete_tag(self, tag_id: int) -> bool:
        affected_note_ids = storage.get_note_ids_for_tag(self.conn, tag_id)
        deleted = storage.delete_tag(self.conn, tag_id)
        if deleted:
            for note_id in affected_note_ids:
                self._reindex_fts(note_id)
        return deleted

    def get_tags_for_note(self, note_id: int) -> list:
        return storage.get_tags_for_note(self.conn, note_id)

    def set_note_tags(self, note_id: int, tag_ids: list[int]) -> Optional[dict]:
        if self.get_note(note_id) is None:
            return None
        storage.set_note_tags(self.conn, note_id, tag_ids)
        self._reindex_fts(note_id)
        return self.get_note(note_id)

    def add_tag_bulk(self, note_ids: list[int], tag_id: int) -> int:
        count = storage.add_tag_bulk(self.conn, note_ids, tag_id)
        self._reindex_fts_bulk(note_ids)
        return count

    def add_image(self, note_id: int, image_bytes: bytes) -> dict:
        """Validates raw image bytes (rejects non-images/corrupt data), builds the thumbnail, and picks the
        storage backend from the current setting.

        Shared by the disk-import and clipboard-paste RPCs; storage.py only persists what it is handed.
        Each image keeps its own mode (note_images.storage_mode), so changing the setting never touches
        saved images."""
        if self.get_note(note_id) is None:
            raise errors.VaultError("notes.note_not_found")
        if len(image_bytes) > storage.NOTE_IMAGE_BYTE_LIMIT:
            raise errors.VaultError(
                "notes.image_too_large", limit_bytes=storage.NOTE_IMAGE_BYTE_LIMIT, actual_bytes=len(image_bytes)
            )
        try:
            img = Image.open(io.BytesIO(image_bytes))
            img.load()
        except UnidentifiedImageError:
            raise errors.VaultError("notes.image_invalid")
        fmt = (img.format or "PNG").lower()
        mime_type = f"image/{fmt}"
        thumb = img.convert("RGBA") if img.mode == "P" else img
        thumb.thumbnail(THUMBNAIL_MAX_SIZE, Image.LANCZOS)
        buf = io.BytesIO()
        thumb.save(buf, format="PNG")
        thumbnail_bytes = buf.getvalue()

        storage_mode = ui_settings.load_note_image_storage_mode(self.data_dir)
        if storage_mode == "disk_plain":
            image_path, thumbnail_path = self._write_image_files(image_bytes, thumbnail_bytes, fmt)
            row = storage.insert_image(
                self.conn,
                note_id,
                mime_type=mime_type,
                byte_size=len(image_bytes),
                storage_mode="disk_plain",
                image_path=image_path,
                thumbnail_path=thumbnail_path,
            )
        else:
            row = storage.insert_image(
                self.conn,
                note_id,
                mime_type=mime_type,
                byte_size=len(image_bytes),
                storage_mode="encrypted_db",
                image_data=image_bytes,
                thumbnail_data=thumbnail_bytes,
            )
        return self._normalize_meta_row(row)

    def _write_image_files(self, image_bytes: bytes, thumbnail_bytes: bytes, ext: str) -> tuple[str, str]:
        """Same naming scheme as clipboard/service.py's _write_image_files. ext follows the original format;
        the thumbnail is always re-encoded as .png."""
        stem = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        image_path = self.images_dir / f"{stem}.{ext}"
        image_path.write_bytes(image_bytes)
        thumb_path = self.thumbs_dir / f"{stem}.png"
        thumb_path.write_bytes(thumbnail_bytes)
        return str(image_path), str(thumb_path)

    def _read_bytes_for_mode(self, row: dict, *, full: bool) -> bytes:
        """Normalizes a storage.py row to plain bytes for either backend, hiding the modes from RPC handlers."""
        if row["storage_mode"] == "disk_plain":
            path = row["image_path"] if full else row["thumbnail_path"]
            try:
                return Path(path).read_bytes()
            except OSError:
                raise errors.VaultError("notes.image_not_found")
        return row["image_data"] if full else row["thumbnail_data"]

    def _normalize_meta_row(self, row: dict) -> dict:
        return {
            "id": row["id"],
            "note_id": row["note_id"],
            "mime_type": row["mime_type"],
            "byte_size": row["byte_size"],
            "created_at": row["created_at"],
            "thumbnail_data": self._read_bytes_for_mode(row, full=False),
        }

    def _normalize_full_row(self, row: dict) -> dict:
        return {
            "id": row["id"],
            "note_id": row["note_id"],
            "mime_type": row["mime_type"],
            "byte_size": row["byte_size"],
            "created_at": row["created_at"],
            "image_data": self._read_bytes_for_mode(row, full=True),
        }

    def list_images(self, note_id: int) -> list:
        normalized = []
        for row in storage.list_images(self.conn, note_id):
            try:
                normalized.append(self._normalize_meta_row(row))
            except errors.VaultError:
                # Thumbnail file missing (removed outside the app): drop only this image, don't fail the list.
                logger.warning("note image %s: file missing on disk, omitting from gallery", row.get("id"))
        return normalized

    def get_image(self, image_id: int) -> Optional[dict]:
        row = storage.get_image(self.conn, image_id)
        if row is None:
            return None
        return self._normalize_full_row(row)

    def delete_image(self, image_id: int) -> bool:
        removed = storage.delete_image(self.conn, image_id)
        if removed is None:
            return False
        self._cleanup_image_files([removed])
        return True

    def _cleanup_text_files(self, paths: list[str]) -> None:
        """Best-effort: a missing or unremovable text file must not block the requested delete."""
        for path in paths:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                logger.exception("failed to remove note text file %s", path)

    def _cleanup_image_files(self, rows: list) -> None:
        """Removes files for rows from storage.py's delete paths; only disk_plain rows have files.

        Best-effort: a missing or unremovable file must not block the delete."""
        for row in rows:
            if row.get("storage_mode") != "disk_plain":
                continue
            for key in ("image_path", "thumbnail_path"):
                path = row.get(key)
                if not path:
                    continue
                try:
                    Path(path).unlink(missing_ok=True)
                except OSError:
                    logger.exception("failed to remove note image file %s", path)

    # --- 修改时间线 ---
    # 记录一律在改完之后由 _record_revision 生成，不让十几条写路径各拼各的，免得漏记。

    def _revision_body(self, note_id: int) -> tuple[Optional[dict], Optional[str]]:
        """(元数据行, 可进快照的正文)；正文太大、分段存储或读不到时为 None。

        分段笔记不进快照：每改一段就拼整篇存一份，会还回分段存储省下的空间。"""
        meta = storage.fetch_metadata(self.conn, note_id)
        if meta is None:
            return None, None
        if meta["content_length"] > storage.REVISION_CONTENT_LIMIT or storage.count_segments(self.conn, note_id):
            return meta, None
        row = storage.fetch_one(self.conn, note_id)
        if row["content_storage_mode"] == "disk_plain":
            # 不走 _bounded_content：它在文件读不到时退回 preview，那对索引是
            # 合理的降级，放进快照就成了"恢复后正文只剩 200 字"。
            try:
                return meta, Path(row["content_path"]).read_text(encoding="utf-8") if row["content_path"] else ""
            except OSError:
                return meta, None
        return meta, row["content"] or ""

    def _ensure_baseline(self, note_id: int) -> None:
        """升级前就存在的笔记第一次被改之前，先把它改之前的样子记成 'baseline'，
        否则时间线的第一条就已经是改过之后的，"原来是什么样"再也找不回来。"""
        if storage.has_revisions(self.conn, note_id):
            return
        meta, body = self._revision_body(note_id)
        if meta is None:
            return
        storage.insert_revision(
            self.conn, note_id=note_id, kind="baseline", title=meta["title"], category=meta["category"],
            content=body, content_length=meta["content_length"], created_at=meta["updated_at"],
        )

    def _record_revision(
        self, note_id: int, kind: Optional[str] = None, *,
        batch_id: Optional[str] = None, summary: Optional[str] = None, force: bool = False,
    ) -> None:
        """记一条笔记现在的样子。kind=None 时按实际变化判定 edit / metadata，没变就不记；
        force 用于新建、分块/分段保存（正文可能不进快照、无法比较）和合并（需留痕）。"""
        meta, body = self._revision_body(note_id)
        if meta is None:
            return
        recent = storage.latest_revisions(self.conn, note_id, 2)
        latest = recent[0] if recent else None
        if latest is not None and not force:
            body_changed = (
                latest["content_length"] != meta["content_length"]
                or (body is not None and latest["has_content"] and latest["content"] != body)
                or (body is None) != (not latest["has_content"])
            )
            meta_changed = latest["title"] != meta["title"] or latest["category"] != meta["category"]
            if not body_changed and not meta_changed:
                return
            if kind is None:
                kind = "edit" if body_changed else "metadata"
        kind = kind or "edit"

        # 连续自动保存：两分钟内接着上一条 'edit' 就覆盖它，免得时间线刷出几百条；
        # 覆盖后的说明要对比被覆盖那条之前的一版，所以取两条。
        if (
            kind == "edit" and batch_id is None and latest is not None and latest["kind"] == "edit"
            and latest["batch_id"] is None and _seconds_since(latest["created_at"]) < 120
        ):
            previous = recent[1] if len(recent) > 1 else None
            storage.overwrite_revision(
                self.conn, latest["id"], title=meta["title"], category=meta["category"], content=body,
                content_length=meta["content_length"],
                summary=summary if summary is not None else self._describe_revision(previous, meta, body),
            )
            return
        storage.insert_revision(
            self.conn, note_id=note_id, kind=kind, title=meta["title"], category=meta["category"],
            content=body, content_length=meta["content_length"], batch_id=batch_id,
            summary=summary if summary is not None else self._describe_revision(latest, meta, body),
        )
        storage.prune_revisions(self.conn, note_id)

    @staticmethod
    def _describe_revision(previous: Optional[dict], meta: dict, body: Optional[str]) -> str:
        if previous is None:
            return f"{meta['content_length']} 字节"
        parts = []
        if previous["title"] != meta["title"]:
            parts.append(f"标题 {_clip(previous['title'])} → {_clip(meta['title'])}")
        if previous["category"] != meta["category"]:
            parts.append(f"分类 {previous['category'] or '未分类'} → {meta['category'] or '未分类'}")
        if previous.get("content") is not None and body is not None:
            delta = len(body) - len(previous["content"])
            if delta > 0:
                parts.append(f"正文 +{delta} 字")
            elif delta < 0:
                parts.append(f"正文 −{-delta} 字")
            elif body != previous["content"]:
                parts.append("正文改动")
        elif previous["content_length"] != meta["content_length"]:
            parts.append("正文改动")
        return "、".join(parts)

    def list_revisions(self, note_id: int, limit: int = storage.MAX_REVISIONS_PER_NOTE) -> list:
        if storage.fetch_metadata(self.conn, note_id) is None:
            raise errors.VaultError("notes.note_not_found")
        return storage.list_revisions(self.conn, note_id, limit)

    def get_revision(self, revision_id: int) -> dict:
        revision = storage.get_revision(self.conn, revision_id)
        if revision is None:
            raise errors.VaultError("notes.revision_not_found")
        return revision

    def timeline(self, note_ids: Optional[list[int]], limit: int) -> list:
        return storage.revision_timeline(self.conn, note_ids, limit)

    def _apply_revision(self, note_id: int, revision: dict, *, kind: str, batch_id: Optional[str], summary: str) -> Optional[dict]:
        """把一篇笔记改回某一版。在回收站里的先还原出来——时间线上能看到被删的
        笔记，从那里点「恢复到此版本」的人要的显然是把它找回来。"""
        meta = storage.fetch_metadata(self.conn, note_id)
        if meta is None:
            return None
        if meta["is_deleted"]:
            self.restore_note(note_id)
        content = None
        if revision["has_content"]:
            _, current_body = self._revision_body(note_id)
            # 当前正文进不了快照（变大了或已转成分段存储）时不回写正文：拿一份
            # 2 MiB 以内的旧正文去覆盖一篇分段大笔记，会把它截成那一小段。
            if current_body is not None:
                content = revision["content"]
        return self._update_note(
            note_id, title=revision["title"], category=revision["category"], content=content,
            kind=kind, batch_id=batch_id, summary=summary,
        )

    def restore_revision(self, revision_id: int) -> dict:
        revision = self.get_revision(revision_id)
        note = self._apply_revision(
            revision["note_id"], revision, kind="restore", batch_id=None,
            summary=f"恢复到 {revision['created_at'].replace('T', ' ')[:16]} 的版本",
        )
        if note is None:
            raise errors.VaultError("notes.note_not_found")
        return note

    def batch_undo(self, batch_id: str) -> int:
        """把这一批里每篇笔记恢复到这批改动之前的那一版。撤销本身也共用一个新的
        batch_id，所以"撤销了撤销"同样可以再整批撤回去。"""
        revisions = storage.batch_revisions(self.conn, batch_id) if isinstance(batch_id, str) and batch_id else []
        if not revisions:
            raise errors.VaultError("notes.batch_not_found")
        undo_batch = uuid.uuid4().hex
        restored = 0
        seen: set[int] = set()
        for revision in revisions:
            note_id = revision["note_id"]
            if note_id in seen:
                continue
            seen.add(note_id)
            meta = storage.fetch_metadata(self.conn, note_id)
            if meta is None:
                continue
            before = storage.revision_before(self.conn, note_id, revision["id"])
            if meta["is_deleted"]:
                # 合并重复项时被移进回收站的那几篇：撤销就是把它们拿回来。
                self.restore_note(note_id)
            elif before is None:
                continue
            restored += 1
            if before is not None:
                self._apply_revision(note_id, before, kind="undo", batch_id=undo_batch, summary="撤销批量修改")
        return restored

    # --- 批量修改 -----------------------------------------------------------

    @staticmethod
    def _compile_bulk_op(op) -> tuple:
        """(kind, 查找用的正则, 插入/替换文本)。参数不对一律报错，不猜。"""
        if not isinstance(op, dict) or op.get("kind") not in ("replace", "prepend", "append"):
            raise errors.VaultError("notes.invalid_request")
        kind = op["kind"]
        if kind != "replace":
            text = op.get("text")
            if not isinstance(text, str) or not text:
                raise errors.VaultError("notes.invalid_request")
            return kind, None, text
        find, replacement = op.get("find"), op.get("replace", "")
        if not isinstance(find, str) or not isinstance(replacement, str):
            raise errors.VaultError("notes.invalid_request")
        if not find:
            raise errors.VaultError("notes.bulk_edit_empty_find")
        source = find if op.get("regex") else re.escape(find)
        if op.get("whole_word"):
            source = rf"\b(?:{source})\b"
        try:
            pattern = re.compile(source, 0 if op.get("match_case") else re.IGNORECASE)
        except re.error as exc:
            raise errors.VaultError("notes.bulk_edit_invalid_regex", detail=str(exc))
        if not op.get("regex"):
            # 字面替换：替换文本里的反斜杠就是反斜杠，不能被当成 \1 之类的组引用。
            replacement = replacement.replace("\\", "\\\\")
        return kind, pattern, replacement

    @staticmethod
    def _apply_bulk_op(kind: str, pattern, text: str, body: str) -> tuple:
        """(新正文, 改了几处, 改前片段, 改后片段)。"""
        if kind == "prepend":
            return text + body, 1, body[:60], (text + body)[: 60 + len(text)]
        if kind == "append":
            return body + text, 1, body[-60:], (body + text)[-(60 + len(text)):]
        first = pattern.search(body)
        if first is None:
            return body, 0, "", ""
        try:
            new_body, count = pattern.subn(text, body)
            start, end = max(0, first.start() - 30), min(len(body), first.end() + 30)
            after = body[start:first.start()] + first.expand(text) + body[first.end():end]
        except (re.error, IndexError) as exc:
            # 替换文本里引用了不存在的组（\3 但只有两组）——编译时查不出来。
            raise errors.VaultError("notes.bulk_edit_invalid_regex", detail=str(exc))
        return new_body, count, body[start:end], after

    @staticmethod
    def _bulk_candidates(note_ids) -> list[int]:
        if not isinstance(note_ids, list) or not all(_is_note_id(n) for n in note_ids):
            raise errors.VaultError("notes.invalid_request")
        return list(dict.fromkeys(note_ids))

    def bulk_edit_preview(self, note_ids, op) -> dict:
        kind, pattern, text = self._compile_bulk_op(op)
        items = []
        total = 0
        for note_id in self._bulk_candidates(note_ids):
            meta, body = self._revision_body(note_id)
            if meta is None or meta["is_deleted"]:
                items.append({"note_id": note_id, "title": "", "matches": 0, "sample_before": "", "sample_after": "", "skipped": "not_found"})
                continue
            if body is None:
                # 超限的正文不批量改：改完要进时间线才撤得回来，而它进不了快照。
                items.append({"note_id": note_id, "title": meta["title"], "matches": 0, "sample_before": "", "sample_after": "", "skipped": "too_large"})
                continue
            _, count, before, after = self._apply_bulk_op(kind, pattern, text, body)
            total += count
            items.append({"note_id": note_id, "title": meta["title"], "matches": count, "sample_before": before, "sample_after": after})
        return {"items": items, "total_matches": total}

    def bulk_edit_apply(self, note_ids, op) -> dict:
        kind, pattern, text = self._compile_bulk_op(op)
        batch_id = uuid.uuid4().hex
        changed = 0
        total = 0
        for note_id in self._bulk_candidates(note_ids):
            meta, body = self._revision_body(note_id)
            if meta is None or meta["is_deleted"] or body is None:
                continue
            new_body, count, _, _ = self._apply_bulk_op(kind, pattern, text, body)
            if count == 0 or new_body == body:
                continue
            summary = {"replace": f"替换 {count} 处", "prepend": "开头插入文本", "append": "末尾追加文本"}[kind]
            if self._update_note(note_id, content=new_body, kind="bulk_edit", batch_id=batch_id, summary=summary) is not None:
                changed += 1
                total += count
        return {"batch_id": batch_id, "changed_count": changed, "total_matches": total}

    # --- 去重 ---------------------------------------------------------------

    @staticmethod
    def _dedupe_key(body: str) -> str:
        """忽略换行风格、每行行尾空白和首尾空白——这些差异肉眼看不出来，却会让
        同一段内容被当成两篇。"""
        lines = body.replace("\r\n", "\n").replace("\r", "\n").strip().split("\n")
        normalized = "\n".join(line.rstrip() for line in lines)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def duplicates_scan(self, scope: str = "normal") -> list:
        if scope not in ("normal", "hidden"):
            raise errors.VaultError("notes.invalid_request")
        want_hidden = 1 if scope == "hidden" else 0
        buckets: dict[str, list[dict]] = {}
        for row in storage.fetch_list(self.conn):
            if int(row["is_hidden"] or 0) != want_hidden:
                continue
            _, body = self._revision_body(row["id"])
            if body is None:
                continue
            buckets.setdefault(self._dedupe_key(body), []).append(row)
        groups = []
        for rows in buckets.values():
            if len(rows) < 2:
                continue
            rows.sort(key=lambda r: (r["updated_at"], r["id"]), reverse=True)
            same_title = len({r["title"].strip() for r in rows}) == 1
            groups.append({
                "reason": "title_content" if same_title else "content",
                "notes": [
                    {k: r[k] for k in ("id", "title", "category", "content_length", "is_pinned", "is_hidden", "created_at", "updated_at")}
                    for r in rows
                ],
            })
        groups.sort(key=lambda g: g["notes"][0]["updated_at"], reverse=True)
        return groups

    def duplicates_merge(self, groups) -> dict:
        """每组留 keep_id，其余进回收站（7 天内能还原，整批撤销也能拿回来），
        它们的标签并到留下的那篇上——标签是用户手工打的，丢了找不回来。"""
        if not isinstance(groups, list) or not groups:
            raise errors.VaultError("notes.duplicates_invalid")
        plan: list[tuple[int, list[int]]] = []
        used: set[int] = set()
        for entry in groups:
            keep_id = entry.get("keep_id") if isinstance(entry, dict) else None
            remove_ids = entry.get("remove_ids") if isinstance(entry, dict) else None
            if not _is_note_id(keep_id) or not isinstance(remove_ids, list) or not remove_ids:
                raise errors.VaultError("notes.duplicates_invalid")
            ids = [keep_id, *remove_ids]
            if not all(_is_note_id(i) for i in ids) or len(set(ids)) != len(ids) or used & set(ids):
                raise errors.VaultError("notes.duplicates_invalid")
            for note_id in ids:
                meta = storage.fetch_metadata(self.conn, note_id)
                if meta is None or meta["is_deleted"]:
                    raise errors.VaultError("notes.duplicates_invalid")
            used.update(ids)
            plan.append((keep_id, remove_ids))

        batch_id = uuid.uuid4().hex
        removed = 0
        for keep_id, remove_ids in plan:
            keep_title = storage.fetch_metadata(self.conn, keep_id)["title"]
            tag_ids = {t["id"] for t in storage.get_tags_for_note(self.conn, keep_id)}
            for note_id in remove_ids:
                tag_ids.update(t["id"] for t in storage.get_tags_for_note(self.conn, note_id))
                self._ensure_baseline(note_id)
                # 先留痕再删：整批撤销靠这一条找到"这篇是被这次合并删掉的"。
                self._record_revision(note_id, "merge", batch_id=batch_id, summary=f"并入《{_clip(keep_title)}》后移入回收站", force=True)
            storage.set_note_tags(self.conn, keep_id, sorted(tag_ids))
            removed += storage.soft_delete_bulk(self.conn, remove_ids)
            self._ensure_baseline(keep_id)
            self._reindex_fts(keep_id)
            self._record_revision(keep_id, "merge", batch_id=batch_id, summary=f"合并了 {len(remove_ids)} 篇重复笔记", force=True)
        return {"removed_count": removed, "batch_id": batch_id}
