"""Plaintext remnant scanner: after a file is encrypted (even securely deleted), other plaintext
copies often survive and defeat the encryption without touching a key. Sources checked:

  - the source file's own directory: editor owner/backup files (``~$xxx.docx``, ``*.bak``,
``*.wbk``)
  - WPS automatic backup dirs (``%APPDATA%/kingsoft/office6/backup`` and sibling ``*backup*``); WPS
    "文档修复" resurrects content from its own plaintext backup, not the ciphertext
  - Office AutoRecover/UnsavedFiles caches
  - same-name copies on fixed drives (WPS "深度检索" found the user's untouched copy this way);
    best-effort with a hard time budget, since a partial walk beats one taking minutes

scan_remnants() only reports candidates; deletion is a separate call so the UI shows findings first.
Name-related files get ``matched=True``; others in backup caches (opaque names like ``et_1772.bk``)
are listed unmatched for the user to decide.
"""

import os
import sys
import time
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

CATEGORY_SAME_DIR = "same_dir"
CATEGORY_WPS_BACKUP = "wps_backup"
CATEGORY_OFFICE_AUTORECOVER = "office_autorecover"
CATEGORY_SAME_NAME_DISK = "same_name_disk"

# Hard cap for the whole-disk same-name walk. Hit the budget -> stop and
# return what was found so far; encryption UX can't hang on a huge drive.
NAME_SCAN_TIME_BUDGET_SECONDS = 15.0

# Directory names never worth descending into for user documents.
_PRUNE_DIR_NAMES = {
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "$recycle.bin",
    "system volume information",
    "$windows.~bt",
    "recovery",
    "node_modules",
    ".git",
    "__pycache__",
    # AppData caches are covered by the targeted scan_dirs categories.
    "appdata",
}

# Shared backup caches only report files newer than this (old unrelated backups are noise);
# same-directory matches are exempt.
BACKUP_MAX_AGE_DAYS = 180

_SAME_DIR_BACKUP_SUFFIXES = (".bak", ".wbk", ".asd", ".sav")


def _default_scan_dirs() -> List[Tuple[str, Path]]:
    """(category, directory) pairs for the editor backup caches present on
    this machine. Missing ones are simply skipped."""
    dirs: List[Tuple[str, Path]] = []
    appdata = os.environ.get("APPDATA")
    localappdata = os.environ.get("LOCALAPPDATA")

    if appdata:
        office6 = Path(appdata) / "kingsoft" / "office6"
        if office6.is_dir():
            for child in office6.iterdir():
                if child.is_dir() and "backup" in child.name.lower():
                    dirs.append((CATEGORY_WPS_BACKUP, child))
        for office_app in ("Word", "Excel", "PowerPoint"):
            d = Path(appdata) / "Microsoft" / office_app
            if d.is_dir():
                dirs.append((CATEGORY_OFFICE_AUTORECOVER, d))
    if localappdata:
        d = Path(localappdata) / "Microsoft" / "Office" / "UnsavedFiles"
        if d.is_dir():
            dirs.append((CATEGORY_OFFICE_AUTORECOVER, d))
    return dirs


def _stems(source: Path) -> List[str]:
    """Name fragments that identify the source file: full name, and the stem
    without extension (only when long enough to not match everything)."""
    fragments = [source.name.lower()]
    stem = source.stem.lower()
    if len(stem) >= 3:
        fragments.append(stem)
    return fragments


def _is_owner_file_of(candidate_name: str, source_name: str) -> bool:
    """Office/WPS owner files are '~$' + the original name with its first
    one or two characters dropped (e.g. '~$cument.docx' for 'document.docx')."""
    if not candidate_name.startswith("~$"):
        return False
    remainder = candidate_name[2:].lower()
    src = source_name.lower()
    return bool(remainder) and (src.endswith(remainder) or remainder in src)


def _matches_source(candidate: Path, source: Path) -> bool:
    name = candidate.name.lower()
    if _is_owner_file_of(candidate.name, source.name):
        return True
    return any(frag in name for frag in _stems(source))


def _same_dir_candidates(source: Path) -> Iterable[Path]:
    directory = source.parent
    if not directory.is_dir():
        return
    for candidate in directory.iterdir():
        if not candidate.is_file():
            continue
        # The source itself (if it still exists) and its encrypted copy are
        # not remnants.
        if candidate.name.lower() == source.name.lower():
            continue
        if candidate.suffix.lower() == ".ivault":
            continue
        name = candidate.name
        if _is_owner_file_of(name, source.name):
            yield candidate
            continue
        lowered = name.lower()
        if not _matches_source(candidate, source):
            continue
        if lowered.endswith(_SAME_DIR_BACKUP_SUFFIXES) or lowered.startswith("backup of "):
            yield candidate


def _fixed_drive_roots() -> List[Path]:
    """Same-name walk roots: user profile first, then fixed drives; network/removable skipped."""
    roots: List[Path] = []
    home = Path.home()
    if home.is_dir():
        roots.append(home)
    if sys.platform == "win32":
        import ctypes
        import string

        DRIVE_FIXED = 3
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if ctypes.windll.kernel32.GetDriveTypeW(drive) == DRIVE_FIXED:
                roots.append(Path(drive))
    return roots


def _name_matches_for_disk_scan(candidate_name: str, sources: List[Path]) -> bool:
    """Whole-disk hit = exact filename, or full stem at the START followed by a separator
    ('<stem> - 副本.docx', '<stem>(1).docx'); not any name merely containing a stem word."""
    lowered = candidate_name.lower()
    if lowered.endswith(".ivault"):
        return False
    for source in sources:
        if lowered == source.name.lower():
            return True
        stem = source.stem.lower()
        if len(stem) >= 4 and lowered.startswith(stem):
            rest = lowered[len(stem):]
            if rest and not rest[0].isalnum():
                return True
    return False


_NAME_SCAN_MAX_DEPTH = 10


def _same_name_disk_candidates(
    sources: List[Path],
    roots: List[Path],
    time_budget: float,
    skip_paths: set,
) -> Iterable[Path]:
    """Breadth-first walk (stray copies live shallow); each root gets an equal slice of the
    remaining budget so a huge C:\\ cannot starve D:\\ and E:\\."""
    if time_budget <= 0 or not roots:
        return
    from collections import deque

    global_deadline = time.monotonic() + time_budget
    visited: set = set()
    for i, root in enumerate(roots):
        now = time.monotonic()
        if now >= global_deadline:
            return
        deadline = min(now + (global_deadline - now) / (len(roots) - i), global_deadline)
        queue = deque([(Path(root), 0)])
        while queue:
            if time.monotonic() > deadline:
                break
            directory, depth = queue.popleft()
            key = os.path.normcase(str(directory))
            if key in visited:  # home sits inside one of the drives
                continue
            visited.add(key)
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if depth < _NAME_SCAN_MAX_DEPTH and entry.name.lower() not in _PRUNE_DIR_NAMES:
                                    queue.append((Path(entry.path), depth + 1))
                            elif entry.is_file(follow_symlinks=False) and _name_matches_for_disk_scan(
                                entry.name, sources
                            ):
                                if os.path.normcase(entry.path) not in skip_paths:
                                    yield Path(entry.path)
                        except OSError:
                            continue
            except OSError:
                continue


def _item(path: Path, category: str, matched: bool) -> dict:
    stat = path.stat()
    return {
        "path": str(path),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "category": category,
        "matched": matched,
    }


def scan_remnants(
    source_paths: Iterable[str],
    scan_dirs: Optional[List[Tuple[str, Path]]] = None,
    name_scan_roots: Optional[List[Path]] = None,
    name_scan_budget: float = NAME_SCAN_TIME_BUDGET_SECONDS,
) -> List[dict]:
    """Scan for plaintext remnants of the source files; returns {path, size, mtime, category,
    matched} dicts, matched-first then newest-first. Never raises on unreadable candidates.

    name_scan_roots: roots for the same-name search (default profile + fixed drives; [] disables).
    """
    sources = [Path(p) for p in source_paths]
    if scan_dirs is None:
        scan_dirs = _default_scan_dirs()
    if name_scan_roots is None:
        name_scan_roots = _fixed_drive_roots()

    items: dict = {}

    for source in sources:
        for candidate in _same_dir_candidates(source):
            try:
                items[str(candidate)] = _item(candidate, CATEGORY_SAME_DIR, True)
            except OSError:
                continue

    cutoff = time.time() - BACKUP_MAX_AGE_DAYS * 24 * 3600
    for category, directory in scan_dirs:
        try:
            candidates = [p for p in directory.rglob("*") if p.is_file()]
        except OSError:
            continue
        for candidate in candidates:
            key = str(candidate)
            if key in items:
                continue
            try:
                matched = any(_matches_source(candidate, source) for source in sources)
                entry = _item(candidate, category, matched)
            except OSError:
                continue
            if not matched and entry["mtime"] < cutoff:
                continue
            items[key] = entry

    # The sources themselves (when still on disk) and everything already
    # reported must not resurface as "disk copies" of themselves.
    skip_paths = {os.path.normcase(str(s)) for s in sources}
    skip_paths.update(os.path.normcase(k) for k in items)
    for candidate in _same_name_disk_candidates(sources, name_scan_roots, name_scan_budget, skip_paths):
        key = str(candidate)
        if key in items:
            continue
        try:
            if not candidate.is_file():
                continue
            items[key] = _item(candidate, CATEGORY_SAME_NAME_DISK, True)
        except OSError:
            continue

    return sorted(items.values(), key=lambda it: (not it["matched"], -it["mtime"]))
