#!/usr/bin/env python
"""里程碑 1 的剪贴板监听 + 存储独立测试入口（`selftest` 跑验收，`listen` 持续监听）。
selftest 用真实的 SetClipboardData 触发 WM_CLIPBOARDUPDATE，按 task-progress-clipboard.md 的
7 个场景输出 PASS/FAIL，证据从加密库查回。"""

import argparse
import io
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import win32clipboard  # noqa: E402
from PIL import Image  # noqa: E402

from modules.file_vault.clipboard import storage  # noqa: E402
from modules.file_vault.clipboard.listener import open_clipboard_with_retry  # noqa: E402
from modules.file_vault.clipboard.service import ClipboardService  # noqa: E402

TEST_KEY = b"\x01" * 32  # 只用于本地自测，正式接入 IMK 派生密钥是里程碑二的事


def _image_to_dib(img: Image.Image) -> bytes:
    """PIL 只会整张写 .bmp 文件（14 字节文件头 + DIB），CF_DIB 只要后面那段。"""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="BMP")
    bmp_bytes = buf.getvalue()
    return bmp_bytes[14:]


def _clipboard_transaction(set_fn, attempts: int = 10, interval_s: float = 0.05) -> None:
    """监听线程会与测试写入并发读剪贴板（要测的就是真实监听器），写入方会遇到同样的"被占用"竞争，
    所以也给它同样的重试，避免偶发失败。"""
    last_exc = None
    for _ in range(attempts):
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                set_fn()
            finally:
                win32clipboard.CloseClipboard()
            return
        except Exception as exc:
            last_exc = exc
            time.sleep(interval_s)
    raise last_exc


def _set_clipboard_text(text: str) -> None:
    _clipboard_transaction(lambda: win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text))


def _set_clipboard_multi_format(text: str, html: str) -> None:
    """一次复制同时塞纯文本和 HTML 两种格式，模拟从浏览器/Word 复制富文本的场景。"""
    html_fmt = win32clipboard.RegisterClipboardFormat("HTML Format")

    def _set():
        win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
        win32clipboard.SetClipboardData(html_fmt, html.encode("utf-8"))

    _clipboard_transaction(_set)


def _set_clipboard_image(img: Image.Image) -> None:
    dib = _image_to_dib(img)
    _clipboard_transaction(lambda: win32clipboard.SetClipboardData(win32clipboard.CF_DIB, dib))


def _wait_for_row_count(conn, expected_min: int, timeout_s: float = 3.0) -> int:
    deadline = time.monotonic() + timeout_s
    count = 0
    while time.monotonic() < deadline:
        count = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        if count >= expected_min:
            return count
        time.sleep(0.05)
    return count


def run_selftest(data_dir: Path) -> bool:
    for old in (data_dir / "clipboard.db", data_dir / "clipboard.db-wal", data_dir / "clipboard.db-shm"):
        if old.exists():
            old.unlink()

    results = []

    def check(name: str, condition: bool, detail: str) -> None:
        results.append((name, condition, detail))
        print(f"[{'PASS' if condition else 'FAIL'}] {name}: {detail}")

    service = ClipboardService(data_dir, TEST_KEY)
    service.start()
    time.sleep(0.3)  # 等隐藏窗口真的建好、AddClipboardFormatListener 注册完成
    conn = service.conn

    try:
        # 1) 纯文本能被记录
        _set_clipboard_text("剪贴板历史记录测试 - 纯文本")
        n = _wait_for_row_count(conn, 1)
        row = storage.fetch_recent(conn, 1)[0] if n >= 1 else None
        check(
            "1-纯文本记录",
            row is not None and row["content_type"] == "text" and "纯文本" in (row["content_text"] or ""),
            f"记录数={n}, 内容={row['content_text'] if row else None}",
        )

        # 2) 图片能被记录，且原图/缩略图文件真的落盘
        before = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        img = Image.new("RGB", (64, 64), color=(255, 0, 0))
        _set_clipboard_image(img)
        n = _wait_for_row_count(conn, before + 1)
        row = storage.fetch_recent(conn, 1)[0]
        img_path = Path(row["image_path"]) if row["image_path"] else None
        thumb_path = Path(row["thumbnail_path"]) if row["thumbnail_path"] else None
        check(
            "2-图片记录+落盘",
            row["content_type"] == "image" and img_path is not None and img_path.exists() and thumb_path.exists(),
            f"content_type={row['content_type']}, image_path={img_path}, exists={img_path and img_path.exists()}",
        )

        # 3) 一次复制多种格式（纯文本+HTML）只产生一条记录，且按图片>富文本>纯文本取了 rich
        before = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        _set_clipboard_multi_format("plain fallback", "<html><body><b>rich</b></body></html>")
        time.sleep(0.5)
        after = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        row = storage.fetch_recent(conn, 1)[0]
        check(
            "3-多格式去重",
            after == before + 1 and row["content_format"] == "rich",
            f"新增记录数={after - before}（应为1）, 记录到的格式={row['content_format']}（应为 rich）",
        )

        # 4) 自身写回抑制：mark_self_write 之后写入同样内容，不应该产生新记录
        before = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        self_write_text = "程序自己粘贴回去的内容"
        service.mark_self_write(self_write_text.encode("utf-8"))
        _set_clipboard_text(self_write_text)
        time.sleep(0.5)
        after = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        check(
            "4-自身写回抑制",
            after == before,
            f"写回前记录数={before}, 写回后记录数={after}（应相等，即没有新增）",
        )

        # 5) 超大文本走摘要分支，不崩溃
        before = conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()[0]
        huge_text = "A" * (storage.TEXT_BYTE_LIMIT + 1000)
        _set_clipboard_text(huge_text)
        n = _wait_for_row_count(conn, before + 1)
        row = storage.fetch_recent(conn, 1)[0]
        check(
            "5-超大文本摘要",
            row["is_truncated"] == 1 and len(row["content_text"]) < len(huge_text),
            f"is_truncated={row['is_truncated']}, 存储内容长度={len(row['content_text'])}（原文 {len(huge_text)} 字符）",
        )

        # 6) 剪贴板被占用时的重试：真实跨线程 OpenClipboard 互斥在沙盒里时序不可靠（出现过假阳性），
        # 改为打桩 win32clipboard.OpenClipboard（前 2 次抛异常，第 3 次成功），
        # 确定性地测 open_clipboard_with_retry 的重试次数和退避。
        import modules.file_vault.clipboard.listener as listener_mod

        call_log = []
        real_open = win32clipboard.OpenClipboard

        def _flaky_open(*args, **kwargs):
            call_log.append(time.monotonic())
            if len(call_log) < 3:
                raise Exception("模拟剪贴板被其他程序占用")
            return real_open(*args, **kwargs)

        listener_mod.win32clipboard.OpenClipboard = _flaky_open
        try:
            opened = open_clipboard_with_retry()
            if opened:
                win32clipboard.CloseClipboard()
        finally:
            listener_mod.win32clipboard.OpenClipboard = real_open

        gaps = [b - a for a, b in zip(call_log, call_log[1:])]
        retried_with_backoff = len(call_log) == 3 and all(g >= 0.04 for g in gaps)
        check(
            "6-占用重试",
            opened and retried_with_backoff,
            f"尝试次数={len(call_log)}（应为3：前2次模拟占用失败，第3次成功), "
            f"重试间隔={[f'{g:.3f}s' for g in gaps]}（应各 >=0.04s，对应 50ms 退避), 最终打开成功={opened}",
        )

        # 5b) 超大图片同样走"跳过原图保存+提示"分支：真复制 >20MB 图片太慢，直接测 _save_image 超阈值的
        # 行为。
        from modules.file_vault.clipboard.listener import ClipboardEntry as _CE

        fake_big_entry = _CE(
            content_type="image",
            content_format=None,
            text=None,
            image_dib_bytes=b"\x00" * 100,  # 内容无所谓，函数应该在检查 raw_dib_len 后就跳过，不会真去解码
            raw_dib_len=storage.IMAGE_RAW_BYTE_LIMIT + 1,
            source_app=None,
        )
        img_path, thumb_path, img_truncated = service._save_image(fake_big_entry)
        check(
            "5b-超大图片摘要",
            img_path is None and thumb_path is None and img_truncated,
            f"image_path={img_path}（应为 None）, is_truncated={img_truncated}（应为 True）",
        )

        # 7) 数据库确实是 SQLCipher 加密的：用错误密钥打不开
        service.stop()
        wrong_key_ok = False
        try:
            bad_conn = storage.connect(data_dir / "clipboard.db", b"\x99" * 32)
            bad_conn.execute("SELECT COUNT(*) FROM clipboard_history").fetchone()
        except Exception as exc:
            wrong_key_ok = True
            wrong_key_detail = f"{type(exc).__name__}: {exc}"
        else:
            wrong_key_detail = "错误密钥居然读出来了，这是问题"
        check("7-加密验证", wrong_key_ok, wrong_key_detail)

    finally:
        try:
            service.stop()
        except Exception:
            pass

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} 条通过")
    return passed == len(results)


def run_listen(data_dir: Path) -> None:
    def on_new_entry(row: dict) -> None:
        print(f"[新记录] id={row['id']} type={row['content_type']} format={row['content_format']} "
              f"text={(row['content_text'] or '')[:50]!r} image={row['image_path']}")

    service = ClipboardService(data_dir, TEST_KEY, on_new_entry=on_new_entry)
    service.start()
    print("监听中，按 Ctrl+C 停止……复制点文本或图片试试看")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["selftest", "listen"])
    # 用专门子目录，不用真实的 modules/file_vault/data/：这里是 TEST_KEY 而非真实 IMK 派生密钥，
    # 写进 data/clipboard.db 会与 backend_server.py 解锁后的真库撞名，之后真解锁因密钥不符而打不开。
    parser.add_argument(
        "--data-dir", type=Path, default=PROJECT_ROOT / "modules" / "file_vault" / "data" / "clipboard_cli_test"
    )
    args = parser.parse_args()

    if args.command == "selftest":
        ok = run_selftest(args.data_dir)
        sys.exit(0 if ok else 1)
    else:
        run_listen(args.data_dir)


if __name__ == "__main__":
    main()
