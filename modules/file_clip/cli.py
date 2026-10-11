#!/usr/bin/env python
"""file_clip 命令行入口。

用法（从项目根目录运行）：
    python -X utf8 modules/file_clip/cli.py copy <路径...>     # 复制到剪贴板（=Ctrl+C）
    python -X utf8 modules/file_clip/cli.py cut <路径...>      # 剪切到剪贴板（=Ctrl+X）
    python -X utf8 modules/file_clip/cli.py paste <目标目录>    # 高速粘贴（=Ctrl+V）
    python -X utf8 modules/file_clip/cli.py status             # 看剪贴板上有什么

    python -X utf8 modules/file_clip/cli.py delete <路径...> --yes    # 高速永久删除
    python -X utf8 modules/file_clip/cli.py delete <路径...> --recycle # 删到回收站

paste 选项：
    --on-conflict rename|skip|overwrite   重名处理，默认 rename（自动改名保留两者）
    --threads N                           并行线程数，默认自动
    --gui                                 弹进度小窗显示实时速度

（queue-delete / paste-window 是右键菜单和 C 钩子的内部入口，日常不用手敲。）
"""

import argparse
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_clip import clipboard  # noqa: E402
from modules.file_clip import engine  # noqa: E402


def _ensure_utf8_stdout() -> None:
    # pythonw（无控制台）下 stdout/stderr 是 None，print 会炸——补成黑洞
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _fmt_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n} B"


def cmd_mark(paths, move: bool) -> int:
    """copy / cut：把文件放上系统剪贴板。"""
    resolved = []
    for p in paths:
        ap = os.path.abspath(p)
        if not os.path.lexists(ap):
            print(f"错误：路径不存在：{ap}")
            return 1
        resolved.append(ap)
    clipboard.set_file_drop(resolved, move=move)
    word = "剪切" if move else "复制"
    print(f"已{word} {len(resolved)} 个条目到剪贴板：")
    for p in resolved[:10]:
        print(f"  {p}")
    if len(resolved) > 10:
        print(f"  ... 等共 {len(resolved)} 个")
    print("现在可以用本模块 paste 粘贴，也可以直接在资源管理器里 Ctrl+V。")
    return 0


def cmd_paste(dest: str, on_conflict: str, threads, gui: bool = False) -> int:
    if gui:
        from modules.file_clip import progress_ui

        return progress_ui.gui_paste(dest, on_conflict=on_conflict, threads=threads)
    got = clipboard.get_file_drop()
    if got is None:
        print("剪贴板上没有文件。先在资源管理器 Ctrl+C/Ctrl+X，或用本模块 copy/cut。")
        return 1
    paths, is_cut = got
    op = "移动（剪切粘贴）" if is_cut else "复制粘贴"
    print(f"{op} {len(paths)} 个条目 → {os.path.abspath(dest)}")

    report = engine.transfer(
        paths, dest, move=is_cut, on_conflict=on_conflict, threads=threads
    )
    _print_report(report)

    if is_cut and report.ok:
        # 与资源管理器一致：剪切的内容粘贴成功后清空剪贴板，防止误贴第二次
        clipboard.clear_clipboard()
    return 0 if report.ok else 2


def _print_report(report: engine.TransferReport) -> None:
    speed = report.bytes_done / report.elapsed / 1024 / 1024 if report.elapsed > 0 else 0
    if report.operation in ("delete", "recycle"):
        rate = report.files_done / report.elapsed if report.elapsed > 0 else 0
        word = "移入回收站" if report.operation == "recycle" else "永久删除"
        print(f"—— {word}完成 ——")
        print(
            f"删除：{report.files_done}/{report.files_total} 个文件，"
            f"释放 {_fmt_size(report.bytes_done)}，"
            f"耗时 {report.elapsed:.2f}s，平均 {rate:,.0f} 文件/秒"
        )
        if report.errors:
            print(f"失败 {len(report.errors)} 个：")
            for path, msg in report.errors[:10]:
                print(f"  {path}: {msg}")
        return
    print(f"—— {'移动' if report.operation == 'move' else '复制'}完成 ——")
    if report.fast_moved:
        print(f"同盘瞬移（改名不搬数据）：{len(report.fast_moved)} 个条目")
    if report.files_total:
        print(
            f"拷贝：{report.files_done}/{report.files_total} 个文件，"
            f"{_fmt_size(report.bytes_done)}，"
            f"耗时 {report.elapsed:.2f}s，平均 {speed:,.0f} MB/s"
        )
    else:
        print(f"耗时 {report.elapsed:.2f}s")
    if report.renamed:
        print(f"重名自动改名 {len(report.renamed)} 个：")
        for old, new in report.renamed[:5]:
            print(f"  {os.path.basename(old)} -> {os.path.basename(new)}")
        if len(report.renamed) > 5:
            print(f"  ... 等共 {len(report.renamed)} 个")
    if report.skipped:
        print(f"跳过 {len(report.skipped)} 个：")
        for p in report.skipped[:5]:
            print(f"  {p}")
        if len(report.skipped) > 5:
            print(f"  ... 等共 {len(report.skipped)} 个")
    if report.cancelled:
        print("已被用户中断，未完成。")
    if report.errors:
        print(f"失败 {len(report.errors)} 个：")
        for path, msg in report.errors[:10]:
            print(f"  {path}: {msg}")
        if len(report.errors) > 10:
            print(f"  ... 等共 {len(report.errors)} 个")


def cmd_delete(paths, recycle: bool, gui: bool, yes: bool, threads) -> int:
    ap = [os.path.abspath(p) for p in paths]
    if gui:
        from modules.file_clip import progress_ui

        return progress_ui.gui_delete(ap, recycle=recycle, assume_yes=yes)
    if not recycle and not yes:
        print("永久删除不可恢复。确认请加 --yes（或用 --recycle 删到回收站 / --gui 弹确认框）。")
        return 1
    report = engine.delete_items(ap, recycle=recycle, threads=threads)
    _print_report(report)
    return 0 if report.ok else 2


def cmd_queue_delete(path: str, recycle: bool) -> int:
    """资源管理器右键多选入口：每个选中项各来一个进程，先到者当「队长」，
    收集 ~0.8 秒内所有兄弟进程报上来的路径，合并成一批、只弹一个窗口。"""
    import ctypes
    import tempfile
    import time as _time
    import uuid
    from ctypes import wintypes as _wt

    mode = "recycle" if recycle else "perm"
    qdir = os.path.join(tempfile.gettempdir(), f"file_clip_delq_{mode}")
    os.makedirs(qdir, exist_ok=True)
    with open(os.path.join(qdir, uuid.uuid4().hex + ".q"), "w", encoding="utf-8") as f:
        f.write(os.path.abspath(path))

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, _wt.BOOL, _wt.LPCWSTR]
    k32.CreateMutexW.restype = _wt.HANDLE
    ERROR_ALREADY_EXISTS = 183
    handle = k32.CreateMutexW(None, True, f"Local\\file_clip_delq_{mode}")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        k32.CloseHandle(handle)
        return 0  # 兄弟进程：路径已入队，交给队长

    def sweep():
        got = []
        try:
            names = os.listdir(qdir)
        except OSError:
            return got
        for name in names:
            p = os.path.join(qdir, name)
            try:
                with open(p, encoding="utf-8") as f:
                    got.append(f.read().strip())
                os.unlink(p)
            except OSError:
                pass
        return got

    entries = []
    quiet = 0
    while quiet < 2:  # 连续两轮没有新条目就收工
        _time.sleep(0.25)
        new = sweep()
        if new:
            entries += new
            quiet = 0
        else:
            quiet += 1
    k32.ReleaseMutex(handle)
    k32.CloseHandle(handle)
    _time.sleep(0.15)
    entries += sweep()  # 收尾：捡漏刚错过班车的兄弟

    paths = list(dict.fromkeys(e for e in entries if e))
    if not paths:
        return 0
    if os.environ.get("FILE_CLIP_DELETE_NOGUI") == "1":  # 自动化测试通道
        report = engine.delete_items(paths, recycle=recycle)
        _print_report(report)
        return 0 if report.ok else 2
    from modules.file_clip import progress_ui

    return progress_ui.gui_delete(paths, recycle=recycle)


def cmd_paste_window(hwnd_str: str, on_conflict: str, threads) -> int:
    """C 钩子入口：接管 Ctrl+V 后带着前台窗口句柄来这里解析目标文件夹并粘贴。"""
    from modules.file_clip.hotkey_agent import (
        _class_name,
        _inject_ctrl_v,
        resolve_target_folder,
    )

    hwnd = int(hwnd_str)
    target = resolve_target_folder(hwnd, _class_name(hwnd))
    if not target:
        _inject_ctrl_v()  # 解析不出（虚拟位置等）→ 把 Ctrl+V 还给系统正常粘贴
        return 0
    from modules.file_clip import progress_ui

    return progress_ui.gui_paste(target, on_conflict=on_conflict, threads=threads)


def cmd_copy_selection(hwnd_str: str, move: bool) -> int:
    """把资源管理器当前选中项写入系统文件剪贴板。

    C 钩子在源码模式下指向本模块 CLI，因此这个入口必须与
    ``core.fileops.hook_cli`` 保持同一契约。解析不到真实文件时恢复一次
    原生 Ctrl+C/Ctrl+X，避免钩子吞掉虚拟位置或剪贴板暂时忙时的按键。
    """
    from core.fileops.window_resolve import (
        inject_ctrl_c,
        inject_ctrl_x,
        resolve_selected_items,
    )

    paths = resolve_selected_items(int(hwnd_str))
    if not paths:
        (inject_ctrl_x if move else inject_ctrl_c)()
        return 0
    try:
        clipboard.set_file_drop(paths, move=move)
    except clipboard.ClipboardError:
        (inject_ctrl_x if move else inject_ctrl_c)()
    return 0


def cmd_delete_selection(hwnd_str: str, permanent: bool) -> int:
    """C 钩子入口：资源管理器里按 Delete / Shift+Delete，带前台窗口句柄来这里
    取当前选中项并高速删除（Delete→回收站，Shift+Delete→永久，永久先弹确认框）。"""
    from modules.file_clip.hotkey_agent import resolve_selected_items

    paths = resolve_selected_items(int(hwnd_str))
    if not paths:
        return 0  # 没有选中任何东西 → 什么都不做（与系统 Delete 一致）
    from modules.file_clip import progress_ui

    return progress_ui.gui_delete(paths, recycle=not permanent)


def show_status_and_usage() -> str:
    """给 scripts/run.py run file_clip 用：显示剪贴板状态 + 用法。"""
    _ensure_utf8_stdout()
    got = clipboard.get_file_drop()
    if got is None:
        print("剪贴板：空（没有待粘贴的文件）")
    else:
        paths, is_cut = got
        print(f"剪贴板：{len(paths)} 个待{'剪切' if is_cut else '复制'}条目")
        for p in paths[:10]:
            print(f"  {p}")
        if len(paths) > 10:
            print(f"  ... 等共 {len(paths)} 个")
    print()
    print(__doc__.strip())
    return "ok"


def main(argv=None) -> int:
    _ensure_utf8_stdout()
    parser = argparse.ArgumentParser(
        prog="file_clip", description="高性能文件复制/剪切/粘贴，与系统剪贴板互通"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_copy = sub.add_parser("copy", help="复制文件到剪贴板（=Ctrl+C）")
    p_copy.add_argument("paths", nargs="+")

    p_cut = sub.add_parser("cut", help="剪切文件到剪贴板（=Ctrl+X）")
    p_cut.add_argument("paths", nargs="+")

    p_paste = sub.add_parser("paste", help="把剪贴板上的文件高速粘贴到目标目录（=Ctrl+V）")
    p_paste.add_argument("dest")
    p_paste.add_argument(
        "--on-conflict",
        choices=["rename", "skip", "overwrite"],
        default="rename",
        help="重名处理：rename=自动改名保留两者（默认）/ skip=跳过 / overwrite=覆盖",
    )
    p_paste.add_argument("--threads", type=int, default=None, help="并行线程数（默认自动）")
    p_paste.add_argument("--gui", action="store_true", help="弹进度小窗显示实时速度")

    sub.add_parser("status", help="查看剪贴板上有什么")

    p_del = sub.add_parser("delete", help="高速删除文件/文件夹")
    p_del.add_argument("paths", nargs="+")
    p_del.add_argument("--recycle", action="store_true", help="删到回收站（可恢复）")
    p_del.add_argument("--gui", action="store_true", help="弹进度小窗（永久删除会先弹确认）")
    p_del.add_argument("--yes", action="store_true", help="跳过永久删除确认")
    p_del.add_argument("--threads", type=int, default=None)

    p_qdel = sub.add_parser("queue-delete", help="（内部）右键菜单多选收集入口")
    p_qdel.add_argument("path")
    group = p_qdel.add_mutually_exclusive_group(required=True)
    group.add_argument("--permanent", action="store_true")
    group.add_argument("--recycle", action="store_true")

    p_pw = sub.add_parser("paste-window", help="（内部）C 钩子入口：按窗口句柄粘贴")
    p_pw.add_argument("hwnd")
    p_pw.add_argument("--on-conflict", choices=["rename", "skip", "overwrite"], default="rename")
    p_pw.add_argument("--threads", type=int, default=None)
    p_pw.add_argument("--gui", action="store_true")  # 兼容参数，粘贴一律走小窗

    p_cs = sub.add_parser("copy-selection", help="（内部）C 钩子入口：按窗口句柄复制或剪切选中项")
    p_cs.add_argument("hwnd")
    p_cs.add_argument("--cut", action="store_true")

    p_ds = sub.add_parser("delete-selection", help="（内部）C 钩子入口：按窗口句柄删除选中项")
    p_ds.add_argument("hwnd")
    ds_group = p_ds.add_mutually_exclusive_group(required=True)
    ds_group.add_argument("--permanent", action="store_true")
    ds_group.add_argument("--recycle", action="store_true")
    p_ds.add_argument("--gui", action="store_true")  # 兼容参数，删除一律走小窗

    args = parser.parse_args(argv)
    if args.command == "copy":
        return cmd_mark(args.paths, move=False)
    if args.command == "cut":
        return cmd_mark(args.paths, move=True)
    if args.command == "paste":
        return cmd_paste(args.dest, args.on_conflict, args.threads, args.gui)
    if args.command == "status":
        show_status_and_usage()
        return 0
    if args.command == "delete":
        return cmd_delete(args.paths, args.recycle, args.gui, args.yes, args.threads)
    if args.command == "queue-delete":
        return cmd_queue_delete(args.path, recycle=args.recycle)
    if args.command == "paste-window":
        return cmd_paste_window(args.hwnd, args.on_conflict, args.threads)
    if args.command == "copy-selection":
        return cmd_copy_selection(args.hwnd, args.cut)
    if args.command == "delete-selection":
        return cmd_delete_selection(args.hwnd, args.permanent)
    return 1


if __name__ == "__main__":
    sys.exit(main())
