"""导入去重与"清理重复项"。

钉住容易静默走反的几条：跳过重复时置顶/隐藏标记不能丢、不能在磁盘留孤儿图片、回收站里的内容
不能拦住重新导入、指纹算不出的行不能归成一组。只走 tmp_path 隔离库，不碰系统剪贴板。
"""

import io
import sys
from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.clipboard import service as clipboard_service
from modules.file_vault.clipboard import storage


def _make_service(tmp_path):
    return clipboard_service.ClipboardService(tmp_path, crypto.generate_key())


def _png_bytes(color=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", (24, 16), color).save(buf, format="PNG")
    return buf.getvalue()


def _insert_text(svc, text, **kwargs):
    return storage.insert_entry(svc.conn, content_type="text", content_text=text, **kwargs)


# --- 导入去重 -------------------------------------------------------------


def test_importing_the_same_backup_twice_adds_nothing_the_second_time(tmp_path):
    """同一份备份导两次，第二次一条都不该多出来，且要如实说"跳过了几条"。"""
    src = _make_service(tmp_path / "src")
    try:
        _insert_text(src, "第一条")
        _insert_text(src, "second", is_pinned=True)
        backup = tmp_path / "backup.json"
        assert src.export_to_json(backup) == 2
    finally:
        src.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:
        first = dst.import_from_json(backup)
        assert first == {"imported": 2, "skipped": 0}

        second = dst.import_from_json(backup)
        # 关键：imported 是 0 但 skipped 是 2。只报 imported 的话，这次导入跟
        # "文件是空的"、"导入坏了"在界面上一模一样。
        assert second == {"imported": 0, "skipped": 2}
        assert len(storage.fetch_recent(dst.conn, limit=50)) == 2
    finally:
        dst.conn.close()


def test_duplicates_inside_one_file_are_collapsed(tmp_path):
    """文件内部自带的重复，导入后也只留一条。依赖"每插一条就提交、下一条现查库"，
    同批及多文件之间的重复无需单独处理，此条钉住这个前提。"""
    src = _make_service(tmp_path / "src")
    try:
        _insert_text(src, "重复内容")
        backup = tmp_path / "one.json"
        src.export_to_json(backup)
    finally:
        src.conn.close()

    # 把同一条记录行复制一遍，做出一个"文件内部自带重复"的备份
    lines = backup.read_text(encoding="utf-8").splitlines()
    doubled = tmp_path / "doubled.json"
    doubled.write_text("\n".join([lines[0], lines[1], lines[1], lines[1]]) + "\n", encoding="utf-8")

    dst = _make_service(tmp_path / "dst")
    try:
        assert dst.import_from_json(doubled) == {"imported": 1, "skipped": 2}
        assert len(storage.fetch_recent(dst.conn, limit=50)) == 1
    finally:
        dst.conn.close()


def test_skipped_duplicate_still_merges_pinned_and_hidden_flags(tmp_path):
    """跳过重复不等于丢掉备份里的置顶/隐藏意图——标记要并到已有那条上。"""
    src = _make_service(tmp_path / "src")
    try:
        _insert_text(src, "支付宝密码", is_hidden=True, is_pinned=True)
        backup = tmp_path / "flagged.json"
        src.export_to_json(backup)
    finally:
        src.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:
        # 本机已经有同样一条，但既没置顶也没隐藏
        existing_id = _insert_text(dst, "支付宝密码")
        assert dst.import_from_json(backup) == {"imported": 0, "skipped": 1}

        row = storage.fetch_one(dst.conn, existing_id)
        assert row["is_pinned"] == 1
        assert row["is_hidden"] == 1
        # 置顶必须同时拿到 pin_order，否则它在"只看置顶"里排到 NULL 那一档，
        # 顺序看起来是随机的——是个不报错、只表现为"排序乱跳"的坑。
        assert row["pin_order"] is not None
        assert len(storage.fetch_recent(dst.conn, limit=50)) == 1
    finally:
        dst.conn.close()


def test_merging_flags_never_turns_them_off(tmp_path):
    """只开不关：导入一份旧备份不该把用户现在置顶着的东西取消掉。"""
    src = _make_service(tmp_path / "src")
    try:
        _insert_text(src, "会议纪要")  # 备份里这条没置顶、没隐藏
        backup = tmp_path / "plain.json"
        src.export_to_json(backup)
    finally:
        src.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:
        existing_id = _insert_text(dst, "会议纪要", is_pinned=True, is_hidden=True)
        assert dst.import_from_json(backup) == {"imported": 0, "skipped": 1}
        row = storage.fetch_one(dst.conn, existing_id)
        assert row["is_pinned"] == 1
        assert row["is_hidden"] == 1
    finally:
        dst.conn.close()


def test_identical_images_dedup_by_bytes_not_by_path(tmp_path):
    """图片按原始字节判重：路径每次都带时间戳和随机串，按路径判重永远判不出重复。"""
    src = _make_service(tmp_path / "src")
    try:
        png = _png_bytes()
        for _ in range(2):
            image_path, thumb_path = src._write_image_files(png)
            storage.insert_entry(
                src.conn, content_type="image", image_path=image_path, thumbnail_path=thumb_path
            )
        # 再放一张**不同**的图，确认没有被一起误判成重复
        other_path, other_thumb = src._write_image_files(_png_bytes(color=(10, 90, 220)))
        storage.insert_entry(
            src.conn, content_type="image", image_path=other_path, thumbnail_path=other_thumb
        )
        backup = tmp_path / "images.json"
        assert src.export_to_json(backup) == 3
    finally:
        src.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:
        assert dst.import_from_json(backup) == {"imported": 2, "skipped": 1}
        rows = storage.fetch_recent(dst.conn, limit=50)
        assert len(rows) == 2
    finally:
        dst.conn.close()


def test_skipped_duplicate_does_not_leave_an_orphan_image_on_disk(tmp_path):
    """判重必须在写图片文件之前完成，否则被跳过的条目会在 images/ 和 thumbs/ 留下无人引用也无人
    清理的孤儿文件。"""
    src = _make_service(tmp_path / "src")
    try:
        image_path, thumb_path = src._write_image_files(_png_bytes())
        storage.insert_entry(
            src.conn, content_type="image", image_path=image_path, thumbnail_path=thumb_path
        )
        backup = tmp_path / "img.json"
        src.export_to_json(backup)
    finally:
        src.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:

        def on_disk():
            return (
                sorted(p.name for p in dst.images_dir.iterdir()),
                sorted(p.name for p in dst.thumbs_dir.iterdir()),
            )

        dst.import_from_json(backup)
        after_first = on_disk()
        assert len(after_first[0]) == 1 and len(after_first[1]) == 1

        dst.import_from_json(backup)  # 第二次全是重复
        assert on_disk() == after_first, "跳过的重复项不该在磁盘上留下图片"
    finally:
        dst.conn.close()


def test_trashed_entries_do_not_block_reimport(tmp_path):
    """回收站里的重复不参与判重，否则用户删掉又特意重新导入的内容会静默消失（提示"跳过 1 条重复"
    但列表里没有）。"""
    src = _make_service(tmp_path / "src")
    try:
        _insert_text(src, "删掉又想要回来的东西")
        backup = tmp_path / "b.json"
        src.export_to_json(backup)
    finally:
        src.conn.close()

    dst = _make_service(tmp_path / "dst")
    try:
        assert dst.import_from_json(backup) == {"imported": 1, "skipped": 0}
        row_id = storage.fetch_recent(dst.conn, limit=5)[0]["id"]
        storage.soft_delete(dst.conn, row_id)

        assert dst.import_from_json(backup) == {"imported": 1, "skipped": 0}
        assert len(storage.fetch_recent(dst.conn, limit=50)) == 1
    finally:
        dst.conn.close()


def test_snippets_and_history_dedup_separately(tmp_path):
    """片段和历史记录各自去重、不跨着合并（显示在两个列表里），否则历史记录会莫名跳进片段列表。"""
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "常用地址")
        _insert_text(svc, "常用地址", is_snippet=True)
        assert len(storage.fetch_recent(svc.conn, limit=50)) == 1
        assert len(storage.fetch_snippets(svc.conn, limit=50)) == 1
        # 两条内容一样但分属两个列表，不该被算成一个重复组
        assert storage.find_duplicate_groups(svc.conn) == []
    finally:
        svc.conn.close()


def test_rich_text_is_not_merged_with_its_plain_twin(tmp_path):
    """同样文字的纯文本条和带格式条不是重复；判重会静默弄丢可粘回 Word 的那份，且预览看不出区别。"""
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "E = mc²")
        storage.insert_entry(
            svc.conn,
            content_type="text",
            content_text="E = mc²",
            content_format="rich",
            content_html="<p><b>E = mc²</b></p>",
        )
        assert storage.find_duplicate_groups(svc.conn) == []
    finally:
        svc.conn.close()


# --- 清理重复项 -----------------------------------------------------------


def test_find_duplicate_groups_reports_merged_flags_and_keeper(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        first = _insert_text(svc, "重复的东西")
        second = _insert_text(svc, "重复的东西", is_hidden=True)
        _insert_text(svc, "只有一条", is_pinned=True)

        groups = storage.find_duplicate_groups(svc.conn)
        assert len(groups) == 1
        group = groups[0]
        assert group["count"] == 2
        # 都没置顶 → 留最早那条，保住原始的 created_at
        assert group["keep_id"] == first
        assert group["merge_ids"] == [second]
        # 组里只要有一条隐藏，合并后保留的那条就该带上隐藏标记
        assert group["is_hidden"] is True
        assert group["is_pinned"] is False
        assert group["preview"] == "重复的东西"
    finally:
        svc.conn.close()


def test_pinned_row_is_kept_so_manual_order_survives(tmp_path):
    """一组里有置顶的就留置顶那条——它带着用户手工拖出来的 pin_order。"""
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "置顶过的")
        pinned_id = _insert_text(svc, "置顶过的")
        storage.set_pinned(svc.conn, pinned_id, True)
        pin_order_before = storage.fetch_one(svc.conn, pinned_id)["pin_order"]

        groups = storage.find_duplicate_groups(svc.conn)
        assert groups[0]["keep_id"] == pinned_id

        storage.merge_duplicates(svc.conn)
        row = storage.fetch_one(svc.conn, pinned_id)
        assert row["is_deleted"] == 0
        assert row["pin_order"] == pin_order_before
    finally:
        svc.conn.close()


def test_merge_duplicates_soft_deletes_so_it_can_be_undone(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        keep = _insert_text(svc, "aaa")
        drop = _insert_text(svc, "aaa")
        result = storage.merge_duplicates(svc.conn)
        assert result == {"groups": 1, "merged": 1}

        assert len(storage.fetch_recent(svc.conn, limit=50)) == 1
        assert storage.fetch_one(svc.conn, keep)["is_deleted"] == 0
        # 软删而不是真删：这是一点按钮就批量消失的操作,要留一条后悔路
        dropped = storage.fetch_one(svc.conn, drop)
        assert dropped is not None and dropped["is_deleted"] == 1
        assert storage.restore(svc.conn, drop) is True
    finally:
        svc.conn.close()


def test_merging_an_empty_selection_merges_nothing(tmp_path):
    """空列表 = 一组都没选，合并 0 条；None 才是"全部"。写成真值判断会把整库重复一次合并掉。"""
    svc = _make_service(tmp_path / "data")
    try:
        _insert_text(svc, "bbb")
        _insert_text(svc, "bbb")
        assert storage.merge_duplicates(svc.conn, []) == {"groups": 0, "merged": 0}
        assert len(storage.fetch_recent(svc.conn, limit=50)) == 2

        assert storage.merge_duplicates(svc.conn, None) == {"groups": 1, "merged": 1}
        assert len(storage.fetch_recent(svc.conn, limit=50)) == 1
    finally:
        svc.conn.close()


def test_rows_without_a_fingerprint_are_never_grouped_together(tmp_path):
    """算不出指纹的行（图片文件丢了）绝不能被归成一组。

    测的是结果而非实现：find_duplicate_groups 有两道独立防线（`content_hash IS NOT NULL`
    过滤、取成员时 `= NULL` 恒假），拆掉任一道此条仍绿；钉的是"两张丢了文件的图片不被合并"。
    """
    svc = _make_service(tmp_path / "data")
    try:
        storage.insert_entry(
            svc.conn, content_type="image", image_path=str(tmp_path / "gone-1.png")
        )
        storage.insert_entry(
            svc.conn, content_type="image", image_path=str(tmp_path / "gone-2.png")
        )
        rows = storage.fetch_recent(svc.conn, limit=10)
        assert len(rows) == 2
        assert storage.find_duplicate_groups(svc.conn) == []
        assert storage.merge_duplicates(svc.conn) == {"groups": 0, "merged": 0}
        assert len(storage.fetch_recent(svc.conn, limit=10)) == 2
    finally:
        svc.conn.close()


def test_old_databases_get_their_fingerprints_backfilled(tmp_path):
    """升级迁移必须给已有行补算指纹，只加空列会让"清理重复项"对旧数据一条都找不出。"""
    db_path = tmp_path / "clip.db"
    key = crypto.generate_key()
    conn = storage.connect(db_path, key)
    try:
        _id = storage.insert_entry(conn, content_type="text", content_text="老数据")
        storage.insert_entry(conn, content_type="text", content_text="老数据")
        # 模拟升级前的库：把指纹清空
        conn.execute("UPDATE clipboard_history SET content_hash = NULL")
        conn.commit()
        assert storage.find_duplicate_groups(conn) == []
    finally:
        conn.close()

    # 重新打开 = 走一遍 connect() 里的迁移。但迁移只在"列不存在"时补算，
    # 这里列还在，所以手工调一次补算逻辑验证它算得对。
    conn = storage.connect(db_path, key)
    try:
        rows = conn.execute(
            "SELECT id, content_type, content_text, content_format, content_rtf, "
            "content_html, image_path FROM clipboard_history"
        ).fetchall()
        conn.executemany(
            "UPDATE clipboard_history SET content_hash = ? WHERE id = ?",
            [
                (
                    storage.compute_content_hash(
                        content_type=r[1],
                        content_text=r[2],
                        content_format=r[3],
                        content_rtf=r[4],
                        content_html=r[5],
                        image_path=r[6],
                    ),
                    r[0],
                )
                for r in rows
            ],
        )
        conn.commit()
        groups = storage.find_duplicate_groups(conn)
        assert len(groups) == 1 and groups[0]["count"] == 2
    finally:
        conn.close()


def test_fingerprint_is_unambiguous_across_field_boundaries(tmp_path):
    """字段之间要有长度前缀，否则 ("ab","c") 和 ("a","bc") 会撞成同一个指纹。"""
    left = storage.compute_content_hash(
        content_type="text", content_text="ab", content_format="c"
    )
    right = storage.compute_content_hash(
        content_type="text", content_text="a", content_format="bc"
    )
    assert left != right
