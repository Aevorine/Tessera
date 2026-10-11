#!/usr/bin/env python
"""C 钩子代理（core/fileops/c/hook_agent.c）fork 出来执行实际操作的共用入口。

子命令：copy-selection / paste-window / delete-selection（参数见 argparse）。hook_agent.exe
的参数是通用的，file_clip 与 file_vault 都指向这里；逻辑同 modules/file_clip/cli.py。
"""

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops.window_resolve import (  # noqa: E402
    _class_name,
    _inject_ctrl_v,
    inject_ctrl_c,
    inject_ctrl_x,
    resolve_selected_items,
    resolve_target_folder,
)


def _ensure_utf8_stdout() -> None:
    # pythonw（无控制台）下 stdout/stderr 是 None，print 会炸——补成黑洞
    import os

    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def cmd_paste_window(hwnd_str: str, on_conflict: str, threads) -> int:
    """C 钩子入口：接管 Ctrl+V 后带着前台窗口句柄来这里解析目标文件夹并粘贴。"""
    hwnd = int(hwnd_str)
    target = resolve_target_folder(hwnd, _class_name(hwnd))
    if not target:
        _inject_ctrl_v()  # 解析不出（虚拟位置等）→ 把 Ctrl+V 还给系统正常粘贴
        return 0
    from core.fileops import progress_ui

    return progress_ui.gui_paste(
        target, on_conflict=on_conflict, threads=threads, trigger_hwnd=hwnd,
    )


def cmd_copy_selection(hwnd_str: str, move: bool) -> int:
    """Put the current Explorer selection on the standard Windows file clipboard."""
    paths = resolve_selected_items(int(hwnd_str))
    if not paths:
        (inject_ctrl_x if move else inject_ctrl_c)()
        return 0
    from core.fileops import clipboard

    try:
        clipboard.set_file_drop(paths, move=move)
    except clipboard.ClipboardError:
        # The original key was swallowed by the low-level hook. If another
        # clipboard owner wins the race, restore native Explorer semantics.
        (inject_ctrl_x if move else inject_ctrl_c)()
    return 0


def cmd_delete_selection(hwnd_str: str, permanent: bool) -> int:
    """C 钩子入口：资源管理器里按 Delete / Shift+Delete，带前台窗口句柄来这里
    取当前选中项并高速删除（Delete→回收站，Shift+Delete→永久，永久先弹确认框）。"""
    paths = resolve_selected_items(int(hwnd_str))
    if not paths:
        return 0  # 没有选中任何东西 → 什么都不做（与系统 Delete 一致）
    from core.fileops import progress_ui

    return progress_ui.gui_delete(paths, recycle=not permanent, trigger_hwnd=int(hwnd_str))


def main(argv=None) -> int:
    _ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description="file_clip/file_vault 共用的钩子代理执行入口")
    sub = parser.add_subparsers(dest="command", required=True)

    p_pw = sub.add_parser("paste-window", help="按窗口句柄粘贴")
    p_pw.add_argument("hwnd")
    p_pw.add_argument("--on-conflict", choices=["rename", "skip", "overwrite"], default="rename")
    p_pw.add_argument("--threads", type=int, default=None)
    p_pw.add_argument("--gui", action="store_true")  # 兼容参数：hook_agent.exe 固定带上，粘贴一律走小窗

    p_cs = sub.add_parser("copy-selection", help="按窗口句柄复制或剪切选中项")
    p_cs.add_argument("hwnd")
    p_cs.add_argument("--cut", action="store_true")

    p_ds = sub.add_parser("delete-selection", help="按窗口句柄删除选中项")
    p_ds.add_argument("hwnd")
    ds_group = p_ds.add_mutually_exclusive_group(required=True)
    ds_group.add_argument("--permanent", action="store_true")
    ds_group.add_argument("--recycle", action="store_true")
    p_ds.add_argument("--gui", action="store_true")  # 兼容参数：hook_agent.exe 固定带上，删除一律走小窗

    args = parser.parse_args(argv)
    if args.command == "paste-window":
        return cmd_paste_window(args.hwnd, args.on_conflict, args.threads)
    if args.command == "copy-selection":
        return cmd_copy_selection(args.hwnd, args.cut)
    if args.command == "delete-selection":
        return cmd_delete_selection(args.hwnd, args.permanent)
    return 1


if __name__ == "__main__":
    sys.exit(main())
