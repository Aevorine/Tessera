"""把 listener.py（捕获）接到 storage.py（持久化）：存图、生成缩略图、应用大小上限、写入行。
backend_server.py 的 RPC 层直接 import 它，cli.py 只是薄封装。"""

import base64
import io
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from PIL import Image

from core.logging import get_logger
from modules.file_vault.clipboard import classifier, paste, sensitive_detector, storage
from modules.file_vault.clipboard.focus_tracker import ForegroundTracker
from modules.file_vault.clipboard.listener import ClipboardEntry, ClipboardListener, dib_to_png_bytes, png_bytes_to_dib

logger = get_logger(__name__)

THUMBNAIL_MAX_SIZE = (256, 256)
TRASH_RETENTION_DAYS = 7
# 后台维护线程的唤醒间隔：敏感条目存活时长最小 1 分钟，巡查间隔不能比这长；再短只会无谓阻止笔记
# 本休眠。
MAINTENANCE_INTERVAL_SECONDS = 60
EXPORT_FORMAT_VERSION = 2
# v2 导出为逐行 NDJSON（首行 header + 每条一行），内存峰值降为单条记录（最多一张 20MB 图片）。
# 首行 format 字段是新旧格式的嗅探标记：认不出就整文件 json.loads 走 v1 兼容路径；后缀两代都是 .
# json。
EXPORT_FORMAT_NAME = "clipboard-history-ndjson"


class ClipboardService:
    def __init__(self, data_dir: Path, key: bytes, on_new_entry: Optional[Callable[[dict], None]] = None):
        self.data_dir = data_dir
        self.images_dir = data_dir / "clipboard_images"
        self.thumbs_dir = data_dir / "clipboard_thumbnails"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)

        self.conn = storage.connect(data_dir / "clipboard.db", key)
        self._on_new_entry = on_new_entry
        self._listener = ClipboardListener(self._handle_entry)
        self._focus_tracker = ForegroundTracker()
        self._paused = False
        self._maintenance_stop = threading.Event()
        self._maintenance_thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._purge_expired_trash()
        storage.enforce_age_cleanup(self.conn)
        self._purge_expired_sensitive()
        self._listener.start()
        self._focus_tracker.start()
        self._start_maintenance()

    def _purge_expired_trash(self) -> None:
        purged = storage.purge_expired_deleted(self.conn, days=TRASH_RETENTION_DAYS)
        for row in purged:
            for key in ("image_path", "thumbnail_path"):
                path = row.get(key)
                if path:
                    try:
                        Path(path).unlink(missing_ok=True)
                    except Exception:
                        logger.exception("failed to remove trash file %s", path)
        if purged:
            logger.info("purged %d expired trash entries (older than %d days)", len(purged), TRASH_RETENTION_DAYS)

    def stop(self) -> None:
        self._stop_maintenance()
        self._listener.stop()
        self._focus_tracker.stop()
        self.conn.close()

    # 为什么要独立线程而不是捕获后顺手清理：cleanup_hours 和敏感条目过期（sensitive_ttl_minutes）
    # 是时间到了就该发生的，挂在捕获路径上用户不复制就永不触发，而"复制密钥后去开会"正是最需要生效的
    # 场景。

    def _start_maintenance(self) -> None:
        if self._maintenance_thread is not None:
            return
        self._maintenance_stop.clear()
        self._maintenance_thread = threading.Thread(
            target=self._maintenance_loop, name="clipboard-maintenance", daemon=True
        )
        self._maintenance_thread.start()

    def _stop_maintenance(self) -> None:
        self._maintenance_stop.set()
        thread, self._maintenance_thread = self._maintenance_thread, None
        if thread is not None:
            # 等它自己醒过来退出。超时给足一个巡查周期还多一点：卡在这里不放
            # 会让整个应用退不掉，而这个线程本身没有不可中断的长任务。
            thread.join(timeout=MAINTENANCE_INTERVAL_SECONDS + 5)

    def _maintenance_loop(self) -> None:
        # wait() 返回 True 表示收到了停止信号，此时直接退出，不再做最后一轮——
        # 用 sleep() 的话关闭应用要等满一个周期。
        while not self._maintenance_stop.wait(MAINTENANCE_INTERVAL_SECONDS):
            try:
                self._purge_expired_sensitive()
                if storage.due_for_daily_cleanup(self.conn):
                    self._purge_expired_trash()
                    storage.enforce_age_cleanup(self.conn)
                    storage.enforce_max_entries(self.conn)
                    storage.mark_daily_cleanup_done(self.conn)
                    logger.info("daily clipboard cleanup ran")
            except Exception:
                # 维护线程死掉是静默的：清理从此不再发生，界面上一切正常。
                # 所以这里吞掉单轮异常继续巡查，但必须留下日志。
                logger.exception("clipboard maintenance tick failed")

    def _purge_expired_sensitive(self) -> None:
        purged = storage.purge_expired_sensitive(self.conn)
        for row in purged:
            self._cleanup_entry_files(row.get("image_path"), row.get("thumbnail_path"))
        if purged:
            logger.info("purged %d expired sensitive entries", len(purged))

    def mark_self_write(self, data: bytes) -> None:
        """应用自己写剪贴板前先调用，避免由此产生的 WM_CLIPBOARDUPDATE 被记成新条目。"""
        self._listener.self_write_tracker.mark(data)

    def list_recent(self, limit: int = 200) -> list:
        return storage.fetch_recent(self.conn, limit=limit)

    def search(self, query: str, limit: int = 200) -> list:
        """全文搜索剪贴板历史（FTS5）。"""
        return storage.fetch_search(self.conn, query, limit=limit)

    def set_pinned(self, entry_id: int, pinned: bool) -> bool:
        return storage.set_pinned(self.conn, entry_id, pinned)

    def list_pinned(self) -> list:
        """按用户拖拽出来的手工序返回置顶项。"""
        return storage.fetch_pinned_ordered(self.conn)

    def move_pinned(self, entry_id: int, before_id=None, after_id=None):
        """把置顶项移到 before_id / after_id 两个邻居之间，返回新排序值；该项已不是有效置顶项则返回 None。
        位置用相邻项 id 而非目标下标表达，原因见 storage.move_pinned 的并发失效说明。"""
        return storage.move_pinned(self.conn, entry_id, before_id, after_id)

    def set_hidden(self, entry_id: int, hidden: bool) -> bool:
        return storage.set_hidden(self.conn, entry_id, hidden)

    # --- 常用片段 ---

    def create_snippet(self, content_text: str) -> dict:
        row_id = storage.insert_entry(self.conn, content_type="text", content_text=content_text, is_snippet=True)
        return storage.fetch_one(self.conn, row_id)

    def list_snippets(self, limit: int = 500) -> list:
        return storage.fetch_snippets(self.conn, limit=limit)

    def update_snippet(self, entry_id: int, content_text: str) -> bool:
        return storage.update_snippet_text(self.conn, entry_id, content_text)

    def set_paused(self, paused: bool) -> None:
        """托盘"暂停记录"：监听线程照常跑，只让 _handle_entry 提前跳过不写库；
        比停掉再重启监听器省去重新注册隐藏窗口，恢复也是瞬间。"""
        self._paused = paused

    # --- 软删除 / 回收站 ---

    def delete_entry(self, entry_id: int) -> bool:
        return storage.soft_delete(self.conn, entry_id)

    def delete_entries_bulk(self, entry_ids: list[int]) -> int:
        return storage.soft_delete_bulk(self.conn, entry_ids)

    def restore_entry(self, entry_id: int) -> bool:
        return storage.restore(self.conn, entry_id)

    def restore_entries_bulk(self, entry_ids: list[int]) -> int:
        return storage.restore_bulk(self.conn, entry_ids)

    def list_trash(self, limit: int = 500) -> list:
        return storage.fetch_deleted(self.conn, limit=limit)

    def _cleanup_entry_files(self, image_path: Optional[str], thumbnail_path: Optional[str]) -> None:
        for path in (image_path, thumbnail_path):
            if path:
                try:
                    Path(path).unlink(missing_ok=True)
                except Exception:
                    logger.exception("failed to remove clipboard file %s", path)

    def hard_delete_entry(self, entry_id: int) -> bool:
        ok, image_path, thumbnail_path = storage.hard_delete(self.conn, entry_id)
        self._cleanup_entry_files(image_path, thumbnail_path)
        return ok

    def hard_delete_entries_bulk(self, entry_ids: list[int]) -> int:
        removed = storage.hard_delete_bulk(self.conn, entry_ids)
        for row in removed:
            self._cleanup_entry_files(row.get("image_path"), row.get("thumbnail_path"))
        return len(removed)

    # --- 应用黑名单 ---

    def list_blacklist(self) -> list:
        return storage.list_blacklist(self.conn)

    def add_blacklist(self, app_name: str) -> dict:
        return storage.add_blacklist(self.conn, app_name.strip())

    def remove_blacklist(self, entry_id: int) -> bool:
        return storage.remove_blacklist(self.conn, entry_id)

    # --- 设置管理 ---

    def get_settings(self) -> dict:
        return storage.get_all_settings(self.conn)

    def update_settings(self, updates: dict) -> None:
        storage.update_settings(self.conn, updates)

    def enforce_max_entries(self) -> int:
        """按设置的最大条目数自动清理最旧的记录。"""
        return storage.enforce_max_entries(self.conn)

    # --- 导出 / 导入 ---

    def export_to_json(
        self,
        output_path: Path,
        *,
        only_pinned: bool = False,
        only_hidden: bool = False,
        ids: Optional[list] = None,
    ) -> int:
        """流式导出（v2 NDJSON）：逐行写盘，图片 base64 同一时刻只在内存存一张；文本元数据仍一次取出。
        先写 .part 再原子替换目标，中途失败不留半成品。"""
        rows = storage.fetch_all_for_export(
            self.conn, only_pinned=only_pinned, only_hidden=only_hidden, ids=ids
        )
        out_path = Path(output_path)
        tmp_path = out_path.with_name(out_path.name + ".part")
        count = 0
        with tmp_path.open("w", encoding="utf-8") as fh:
            header = {
                "format": EXPORT_FORMAT_NAME,
                "format_version": EXPORT_FORMAT_VERSION,
                "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            fh.write(json.dumps(header, ensure_ascii=False) + "\n")
            for row in rows:
                item = dict(row)
                # image_path 是本机路径，换机导入无意义，不写入 JSON；图片内容改以 base64 内嵌。
                image_path = item.pop("image_path", None)
                if item["content_type"] == "image" and image_path:
                    try:
                        item["image_base64"] = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
                    except Exception:
                        logger.exception("failed to embed image for export, path=%s", image_path)
                fh.write(json.dumps(item, ensure_ascii=False) + "\n")
                count += 1
        tmp_path.replace(out_path)
        return count

    def _import_one_entry(self, item: dict) -> bool:
        """导入一条，返回 True = 插入新记录，False = 命中重复仅合并标记。

        顺序不能反：先算指纹判重，再写图片文件；否则被判重跳过的条目会在 images/ 和 thumbs/ 留下
        无人引用也无人清理的孤儿文件。
        """
        image_b64 = item.get("image_base64")
        image_bytes = None
        if image_b64:
            try:
                image_bytes = base64.b64decode(image_b64)
            except Exception:
                logger.exception("failed to decode imported image, keeping the row without its image")

        content_hash = storage.compute_content_hash(
            content_type=item["content_type"],
            content_text=item.get("content_text"),
            content_format=item.get("content_format"),
            content_rtf=item.get("content_rtf"),
            content_html=item.get("content_html"),
            image_bytes=image_bytes,
        )
        is_snippet = bool(item.get("is_snippet"))
        existing_id = storage.find_live_duplicate(self.conn, content_hash, is_snippet=is_snippet)
        if existing_id is not None:
            # 已经有一份了。不插新行，但备份里标着置顶/隐藏而本机没标的要补上，
            # 否则"跳过重复"会顺手把用户在导出文件里的那份意图丢掉。
            storage.merge_entry_flags(
                self.conn,
                existing_id,
                pinned=bool(item.get("is_pinned")),
                hidden=bool(item.get("is_hidden")),
            )
            return False

        image_path = thumb_path = None
        if image_bytes is not None:
            try:
                image_path, thumb_path = self._write_image_files(image_bytes)
            except Exception:
                logger.exception("failed to write imported image, keeping the row without its image")
        storage.insert_entry(
            self.conn,
            content_type=item["content_type"],
            content_text=item.get("content_text"),
            content_format=item.get("content_format"),
            # 富文本的两份格式载荷也要还原；以前没导出，导出再导入后格式全丢（粘回 Word 的公式变纯文本），且
            # 不报错。
            content_rtf_b64=item.get("content_rtf"),
            content_html=item.get("content_html"),
            image_path=image_path,
            thumbnail_path=thumb_path,
            source_app=item.get("source_app"),
            is_truncated=bool(item.get("is_truncated")),
            is_pinned=bool(item.get("is_pinned")),
            is_sensitive=bool(item.get("is_sensitive")),
            is_hidden=bool(item.get("is_hidden")),
            is_snippet=bool(item.get("is_snippet")),
            copy_count=item.get("copy_count", 1),
            created_at=item.get("created_at"),
            updated_at=item.get("updated_at"),
            content_hash=content_hash,
        )
        return True

    def import_from_json(self, input_path: Path) -> dict:
        """导入：读首行嗅探格式。v2 NDJSON header 则逐行流式导入（内存峰值为单条）；
        否则按 v1 整文件 json.loads（裸 "{" 缩进版或无 format 标记的对象都落到此兼容路径）。

        返回 `{"imported": 新增数, "skipped": 跳过的重复数}`，两个数都要上报，
        否则重复导入时"已导入 0 条"与文件为空、导入坏了无法区分。
        批内及多文件之间的重复自然被拦住：每插一条就提交，find_live_duplicate 能查到它。
        """
        path = Path(input_path)
        imported = skipped = 0
        with path.open("r", encoding="utf-8") as fh:
            first_line = fh.readline()
            is_ndjson = False
            try:
                first = json.loads(first_line)
                is_ndjson = isinstance(first, dict) and first.get("format") == EXPORT_FORMAT_NAME
            except ValueError:
                is_ndjson = False
            if is_ndjson:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    if self._import_one_entry(json.loads(line)):
                        imported += 1
                    else:
                        skipped += 1
                return {"imported": imported, "skipped": skipped}
        payload = json.loads(path.read_text(encoding="utf-8"))
        for item in payload.get("entries", []):
            if self._import_one_entry(item):
                imported += 1
            else:
                skipped += 1
        return {"imported": imported, "skipped": skipped}

    # --- 重复项清理 ---

    def find_duplicate_groups(self) -> list:
        """列出库里已经存在的重复组，供界面先预览、用户确认后再合并。"""
        return storage.find_duplicate_groups(self.conn)

    def find_near_duplicate_groups(self) -> list:
        return storage.find_near_duplicate_groups(self.conn)

    def merge_near_duplicates(self, keep_ids: Optional[list] = None) -> dict:
        return storage.merge_near_duplicates(self.conn, keep_ids)

    def merge_duplicates(self, content_hashes: Optional[list] = None) -> dict:
        """合并重复组。None = 全部；列表 = 只合并列出的那几组。"""
        return storage.merge_duplicates(self.conn, content_hashes)

    def paste_entry(self, entry_id: int, auto_paste: bool = True) -> dict:
        """点击即粘贴：把条目写回系统剪贴板（抑制自写，不记成新条目），再尽力恢复原焦点窗口并发 Ctrl+V。
        总是返回结果 dict 而不抛异常，原因见 paste.send_paste_to。"""
        row = storage.fetch_one(self.conn, entry_id)
        if row is None or row["is_deleted"]:
            return {"ok": False, "error": "clipboard.entry_not_found"}
        if row["is_truncated"]:
            # 存的只是摘要，不是原文——粘回去等于把提示语当内容贴进去，
            # 比什么都不做更糟，所以直接拒绝而不是"尽力而为"。
            return {"ok": False, "error": "clipboard.entry_truncated_cannot_paste"}

        if row["content_type"] == "image":
            if not row["image_path"]:
                return {"ok": False, "error": "clipboard.entry_not_found"}
            try:
                dib = png_bytes_to_dib(Path(row["image_path"]).read_bytes())
            except Exception:
                logger.exception("failed to prepare clipboard image for paste")
                return {"ok": False, "error": "clipboard.paste_failed"}
            self.mark_self_write(dib)
            wrote = paste.write_image_dib(dib)
        else:
            text = row["content_text"] or ""
            # html 取自 content_html 而非 content_text：以前 content_text 存的是 HTML 源码，
            # 两个槽装同一串标记，粘到记事本就是一整串 style。现在各装各的，目标程序认哪个拿哪个。
            html = None
            rtf = None
            if row["content_format"] == "rich":
                html = storage.fetch_html_payload(self.conn, entry_id)
                rtf_b64 = storage.fetch_rtf_payload(self.conn, entry_id)
                if rtf_b64:
                    rtf = base64.b64decode(rtf_b64)
            self.mark_self_write(text.encode("utf-8"))
            wrote = paste.write_text(text, html=html, rtf=rtf)

        if not wrote:
            return {"ok": False, "error": "clipboard.paste_failed"}

        pasted = False
        if auto_paste:
            hwnd = self._focus_tracker.get_last_external_hwnd()
            if hwnd:
                pasted = paste.send_paste_to(hwnd)

        return {"ok": True, "pasted": pasted}

    def _write_image_files(self, png_bytes: bytes) -> tuple[str, str]:
        stem = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        image_path = self.images_dir / f"{stem}.png"
        image_path.write_bytes(png_bytes)

        img = Image.open(io.BytesIO(png_bytes))
        img.thumbnail(THUMBNAIL_MAX_SIZE, Image.LANCZOS)
        thumb_path = self._save_thumbnail(img, stem)
        return str(image_path), str(thumb_path)

    def _save_thumbnail(self, img, stem: str) -> Path:
        """缩略图存 WebP，存不了退回 PNG。

        缩略图是面板滚动的唯一持续开销，同画质下 WebP 约为 PNG 的 1/3~1/5。原图仍是 PNG（用户查看和
        复制回剪贴板要还原的字节，不能有损）。quality=82：256×256 以内肉眼与 95 无差别但体积近半；
        method=4 折中，6 慢三倍而此步在捕获路径上。
        必须保留 PNG 回退：Pillow 可能没带 libwebp，抛 KeyError/OSError 会让整条捕获失败，图片静默进不了
        历史。
        """
        webp_path = self.thumbs_dir / f"{stem}.webp"
        try:
            img.save(webp_path, format="WEBP", quality=82, method=4)
            return webp_path
        except Exception:
            logger.warning("WebP 缩略图存不下来，退回 PNG", exc_info=True)
            png_path = self.thumbs_dir / f"{stem}.png"
            img.save(png_path, format="PNG")
            return png_path

    def _save_image(self, entry: ClipboardEntry) -> tuple[Optional[str], Optional[str], bool]:
        if storage.should_skip_image_bytes(entry.raw_dib_len):
            logger.warning("clipboard image too large (%d bytes), skipping full save", entry.raw_dib_len)
            return None, None, True

        try:
            png_bytes = dib_to_png_bytes(entry.image_dib_bytes)
        except Exception:
            logger.exception("failed to decode clipboard DIB image")
            return None, None, True

        image_path, thumb_path = self._write_image_files(png_bytes)
        return image_path, thumb_path, False

    def _handle_entry(self, entry: ClipboardEntry) -> None:
        try:
            if self._paused:
                return
            if storage.is_blacklisted(self.conn, entry.source_app):
                logger.info("skipping clipboard entry from blacklisted app %s", entry.source_app)
                return
            if entry.content_type == "image":
                image_path, thumb_path, truncated = self._save_image(entry)
                row_id = storage.insert_entry(
                    self.conn,
                    content_type="image",
                    content_format=None,
                    content_text=None if not truncated else "[图片过大，未保存原图]",
                    image_path=image_path,
                    thumbnail_path=thumb_path,
                    source_app=entry.source_app,
                    is_truncated=truncated,
                )
            else:
                text, truncated = storage.fit_text_to_limit(entry.text or "")
                # 分类只在未截断的原文上跑一次：截断后的摘要（含"[内容过大...]"提示语）分类无意义。
                # content_format 'rich' 直接归 text，分类规则与是否富文本无关。
                content_type = classifier.classify(entry.text or "") if not truncated else "text"

                # 敏感内容分类（不修改原文，只标记 is_sensitive）
                sensitive_type = sensitive_detector.classify(entry.text or "") if entry.text else "text"
                is_sensitive = sensitive_type == "sensitive"

                content_rtf_b64 = None
                if entry.rtf_bytes and not storage.should_skip_rtf_bytes(len(entry.rtf_bytes)):
                    content_rtf_b64 = base64.b64encode(entry.rtf_bytes).decode("ascii")
                # HTML 单独存一列，绝不写进 content_text（见 ClipboardEntry.html 和 storage 的 content_html）。
                # 原文被截断时连 HTML 一起丢：半截 HTML 粘出去是坏标记。
                content_html = entry.html if (entry.html and not truncated) else None
                row_id = storage.insert_entry(
                    self.conn,
                    content_type=content_type,
                    content_format=entry.content_format,
                    content_text=text,
                    content_rtf_b64=content_rtf_b64,
                    content_html=content_html,
                    source_app=entry.source_app,
                    is_truncated=truncated,
                    is_sensitive=is_sensitive,
                )
            logger.info("clipboard entry #%d recorded (type=%s)", row_id, entry.content_type)
            if self._on_new_entry:
                row = storage.fetch_one(self.conn, row_id)
                if row:
                    self._on_new_entry(row)
            storage.enforce_max_entries(self.conn)
        except Exception:
            logger.exception("failed to record clipboard entry")
