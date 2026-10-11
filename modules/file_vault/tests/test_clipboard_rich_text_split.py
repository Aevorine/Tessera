"""富文本剪贴板条目：纯文本与 HTML 分开存。

根因：剪贴板同时有 HTML 和纯文本时，捕获只读 HTML 整个塞进 content_text，粘贴又把它同时写进
「纯文本」和「HTML」两个槽，记事本等纯文本目标拿到的就是源码；全文搜索还会匹配到 CSS 属性名。

跑法：`python -X utf8 -m pytest modules/file_vault/tests/test_clipboard_rich_text_split.py -q`
"""

import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.clipboard import service as clipboard_service
from modules.file_vault.clipboard import storage

# 用户原话里那一段（截断到关键部分），拿真实样本测比自己编一个像样
USER_REPORTED_HTML = (
    '<h1 class="font-heading text-2xl leading-tight font-semibold tracking-tight" '
    'style="box-sizing: border-box; border: 0px solid rgb(219, 233, 233); margin: 0px; '
    'font-family: &quot;Times New Roman&quot;, SimSun, 宋体, serif; color: rgb(23, 52, 61);">'
    "剪贴板历史</h1>"
)


def test_the_exact_html_the_user_pasted_becomes_plain_text():
    assert storage.html_to_plain_text(USER_REPORTED_HTML) == "剪贴板历史"


def test_block_tags_become_line_breaks_not_run_together_words():
    # `<p>a</p><p>b</p>` 全部去标签会连成 "ab"，那是另一种坏掉
    assert storage.html_to_plain_text("<p>第一段</p><p>第二段</p>") == "第一段\n第二段"
    assert storage.html_to_plain_text("<div>a<br>b</div>") == "a\nb"


def test_script_and_style_contents_are_dropped_entirely():
    """它们的"文字"是代码，不是给人看的内容。"""
    assert storage.html_to_plain_text("<style>.x{color:red}</style><p>只要这句</p>") == "只要这句"
    assert storage.html_to_plain_text("<script>alert(1)</script>正文") == "正文"


def test_entities_are_decoded():
    assert storage.html_to_plain_text("<span>5 &lt; 10 &amp;&amp; 真</span>") == "5 < 10 && 真"


def test_empty_input_is_not_a_crash():
    assert storage.html_to_plain_text("") == ""
    assert storage.html_to_plain_text(None) == ""


def _make_service(tmp_path):
    return clipboard_service.ClipboardService(tmp_path, crypto.generate_key())


def test_plain_text_and_html_land_in_separate_columns(tmp_path):
    svc = _make_service(tmp_path / "data")
    try:
        row_id = storage.insert_entry(
            svc.conn,
            content_type="text",
            content_format="rich",
            content_text="剪贴板历史",
            content_html=USER_REPORTED_HTML,
        )
        row = storage.fetch_one(svc.conn, row_id)
        # 列表/预览/搜索看到的必须是人看的那段字，不是标记
        assert row["content_text"] == "剪贴板历史"
        assert "style=" not in (row["content_text"] or "")
        # HTML 仍然留着，粘回 Word 时要用
        assert storage.fetch_html_payload(svc.conn, row_id) == USER_REPORTED_HTML
    finally:
        svc.conn.close()


def test_search_no_longer_matches_css_property_names(tmp_path):
    """以前 content_text 里就是 HTML，搜 "border" 会搜出一堆根本没提过这个词的条目。"""
    svc = _make_service(tmp_path / "data")
    try:
        storage.insert_entry(
            svc.conn,
            content_type="text",
            content_format="rich",
            content_text="剪贴板历史",
            content_html=USER_REPORTED_HTML,
        )
        assert storage.fetch_search(svc.conn, "border") == []
        assert len(storage.fetch_search(svc.conn, "剪贴板历史")) == 1
    finally:
        svc.conn.close()


def test_existing_rich_rows_are_repaired_by_the_migration(tmp_path):
    """老库中 content_format='rich' 行的 content_text 存的是 HTML 源码；迁移要把 HTML 挪进
    content_html 并抽出纯文本回填，只加空列的话这些历史条目粘出来仍是一串 style。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    db_path = data_dir / "clipboard.db"

    # 手工造一个"迁移前"的库：有 content_rtf 但没有 content_html，
    # 且富文本行的 content_text 里塞的是 HTML。
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_type TEXT NOT NULL,
            content_text TEXT,
            content_format TEXT,
            image_path TEXT,
            thumbnail_path TEXT,
            source_app TEXT,
            is_pinned INTEGER DEFAULT 0,
            is_sensitive INTEGER DEFAULT 0,
            is_hidden INTEGER DEFAULT 0,
            is_snippet INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0,
            is_truncated INTEGER DEFAULT 0,
            content_rtf TEXT,
            copy_count INTEGER DEFAULT 1,
            pin_order REAL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO clipboard_history (content_type, content_text, content_format, created_at, updated_at)"
        " VALUES ('text', ?, 'rich', '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
        (USER_REPORTED_HTML,),
    )
    conn.execute(
        "INSERT INTO clipboard_history (content_type, content_text, content_format, created_at, updated_at)"
        " VALUES ('text', '本来就是纯文本', 'plain', '2026-01-01T00:00:00', '2026-01-01T00:00:00')"
    )
    conn.commit()
    conn.close()

    # 直接调迁移本身，不走 storage.connect()——那条路会连带跑 SQLCipher 的
    # PRAGMA key，而这里造的是一个普通 sqlite 文件，只为验证这一个迁移。
    conn = sqlite3.connect(db_path)
    storage._migrate_clipboard_html_column(conn)

    rich = conn.execute(
        "SELECT content_text, content_html FROM clipboard_history WHERE content_format = 'rich'"
    ).fetchone()
    assert rich[0] == "剪贴板历史", "老的富文本行必须被修成纯文本"
    assert rich[1] == USER_REPORTED_HTML, "HTML 原文不能丢，粘回 Word 还要用"

    plain = conn.execute(
        "SELECT content_text, content_html FROM clipboard_history WHERE content_format = 'plain'"
    ).fetchone()
    assert plain[0] == "本来就是纯文本", "纯文本行不该被动"
    assert plain[1] is None
    conn.close()


def test_migration_is_idempotent(tmp_path):
    """connect() 每次都跑迁移，第二次必须什么都不做，否则已修好的 content_text 会被当 HTML 再抽一遍，
    含尖括号的正文会丢字符。"""
    svc = _make_service(tmp_path / "data")
    try:
        row_id = storage.insert_entry(
            svc.conn,
            content_type="text",
            content_format="rich",
            content_text="a < b 且 c > d",
            content_html="<p>a &lt; b 且 c &gt; d</p>",
        )
        storage._migrate_clipboard_html_column(svc.conn)
        storage._migrate_clipboard_html_column(svc.conn)
        row = storage.fetch_one(svc.conn, row_id)
        assert row["content_text"] == "a < b 且 c > d"
    finally:
        svc.conn.close()
