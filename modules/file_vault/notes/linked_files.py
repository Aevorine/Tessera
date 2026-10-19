"""关联笔记的文件侧操作：编码/换行探测、原位安全写回、文件夹扫描。

关联笔记的正文就是用户磁盘上的原文件。这里只碰文件系统，不碰数据库；
notes/service.py 负责把结果记进 notes 表。
"""

import os
import re
import time
import uuid
from pathlib import Path
from typing import Iterator, Optional

NOTE_EXTENSIONS = (".txt", ".md", ".markdown")

# 关联笔记走整篇读写（≤8MB 的小笔记通道），更大的文件不关联，改为复制进笔记库。
LINK_MAX_BYTES = 8 * 1024 * 1024

_UNSAFE_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_REPLACE_RETRY_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.8)


def norm_key(path: str) -> str:
    """路径比较键：Windows 大小写不敏感、分隔符统一。"""
    return os.path.normcase(os.path.abspath(path))


def is_note_file(name: str) -> bool:
    return name.lower().endswith(NOTE_EXTENSIONS)


def detect(raw: bytes) -> tuple[str, str]:
    """(编码, 换行)。编码只认 UTF-8（含 BOM）与 GBK；换行按首次出现的样式，无换行时用 CRLF。"""
    if raw.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"
    else:
        try:
            raw.decode("utf-8")
            encoding = "utf-8"
        except UnicodeDecodeError:
            raw.decode("gbk")  # 两种都不是就抛 UnicodeDecodeError，由调用方报解码失败
            encoding = "gbk"
    index = raw.find(b"\n")
    if index == -1:
        return encoding, "\r\n"
    return encoding, "\r\n" if index > 0 and raw[index - 1:index] == b"\r" else "\n"


def read_text(path: str, encoding: str) -> str:
    """按记录的编码读，换行统一成 \\n（编辑器内部表示）。"""
    with open(path, "r", encoding=encoding or "utf-8", errors="replace", newline=None) as handle:
        return handle.read()


def read_head(path: str, encoding: str, max_chars: int) -> str:
    with open(path, "r", encoding=encoding or "utf-8", errors="replace", newline=None) as handle:
        return handle.read(max_chars)


def write_text(path: str, content: str, encoding: str, newline: str) -> str:
    """原位安全写回：同目录临时文件写完再替换，换行与编码沿用原文件。

    原编码装不下新内容（GBK 文件里写了 emoji 等）时改存 UTF-8，返回实际使用的编码。
    替换被杀软/索引器短暂占用拒绝时退避重试。
    """
    target = Path(path)
    used = encoding or "utf-8"
    try:
        data = content.replace("\n", newline or "\r\n").encode(used)
    except UnicodeEncodeError:
        used = "utf-8"
        data = content.replace("\n", newline or "\r\n").encode(used)
    temp = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(temp, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _replace_with_retry(temp, target)
    finally:
        try:
            temp.unlink()
        except OSError:
            pass
    return used


def _replace_with_retry(source: Path, target: Path) -> None:
    for delay in _REPLACE_RETRY_DELAYS:
        try:
            os.replace(source, target)
            return
        except PermissionError:
            time.sleep(delay)
    os.replace(source, target)


def safe_stem(title: str) -> str:
    stem = _UNSAFE_NAME_CHARS.sub("_", title).strip().rstrip(".")
    return stem[:120] or "未命名"


def unique_path(directory: Path, stem: str, suffix: str, *, current: Optional[str] = None) -> Path:
    """directory 下不与已有文件冲突的 stem+suffix；current 是笔记自己的文件（改名时不算冲突）。"""
    candidate = directory / f"{stem}{suffix}"
    index = 2
    while candidate.exists() and (current is None or norm_key(str(candidate)) != norm_key(current)):
        candidate = directory / f"{stem} ({index}){suffix}"
        index += 1
    return candidate


def scan_folder(root: str) -> Iterator[tuple[str, os.stat_result]]:
    """递归列出 root 下的笔记文件，跳过隐藏目录与写回用的临时文件。"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or not is_note_file(name):
                continue
            full = os.path.join(dirpath, name)
            try:
                yield full, os.stat(full)
            except OSError:
                continue
