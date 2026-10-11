# -*- coding: utf-8 -*-
"""`tessera` 命令 —— 在终端里用金库，不必打开界面。

    tessera status
    tessera search 报销
    tessera note list
    tessera note new --title "会议纪要" --content-file notes.md
    tessera note get 12
    tessera clip list --limit 20
    tessera clip search 密钥
    tessera encrypt secret.docx
    tessera decrypt secret.docx.ivault -o secret.docx
    tessera tools

## 密码

需要金库的子命令会**交互式**问一次主密码（getpass，不回显、不进 shell 历史）。
非交互场景（脚本、CI、Claude Code）用 `--password-file <路径>`，或设环境变量
`TESSERA_PASSWORD_FILE`。

**永远不接受 `--password <明文>` 这种写法。** argv 在 Windows 上任何一个进程都
读得到，还会留在 shell 历史和进程列表里 —— 一个"方便"的开关会把整个金库的安全
模型作废，所以它根本不存在。

## 每条命令都要重新解锁一次

这是刻意的取舍。要免掉重复解锁就得有个常驻进程守着解开的密钥，那意味着一个本机
端口或命名管道 —— 攻击面变大。命令行是低频操作，多打一次密码换不新增监听面，
划算。要连续操作就用 `--password-file`。
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Optional

from modules.file_vault.agent.session import VaultError, VaultSession

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_VAULT = 3


def _stdin_is_console() -> bool:
    """标准输入的另一头真的坐着一个人吗。

    **不能只看 `isatty()` —— 在 Windows 上它会骗人。** Windows 的 `isatty()` 对
    *任何字符设备*都返回真，而 `NUL` 就是一个字符设备。于是：

        tessera note list < /dev/null     ->   isatty() == True   ← 实测

    （在 Git Bash 里逐个量过：默认 False、管道 False、`< /dev/null` **True**。）

    照着这个结果去调 `getpass()`，它在 Windows 上又不读 stdin 而是直接读控制台，
    于是进程**永远卡在那里等一个不会到来的按键**：没有报错、没有输出、CPU 0%，
    看起来就像"这条命令是死的"。跑在服务、计划任务，或任何把输入接到 NUL 的
    封装里都会中招。

    真正能分辨的是 `GetConsoleMode`：它只对真控制台句柄成功，对 NUL 失败。
    """
    if not sys.stdin or not sys.stdin.isatty():
        return False
    if os.name != "nt":
        return True
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = wintypes.DWORD()
        return bool(kernel32.GetConsoleMode(handle, ctypes.byref(mode)))
    except Exception:
        # 取不到就当没有控制台：宁可要求显式给密码，也不要卡死。
        return False


def _read_password(args) -> str:
    path = args.password_file or os.environ.get("TESSERA_PASSWORD_FILE")
    if path:
        # 整个文件去掉首尾空白就是密码。用文件而非环境变量：环境变量会被子进程继承、
        # 出现在进程环境里，文件至少能靠文件系统权限管住。
        return Path(path).read_text(encoding="utf-8").strip()
    if not _stdin_is_console():
        # 没有控制台就从标准输入读一行，这样 `echo pw | tessera ...` 能用。
        # 读不到东西就明确报错退出——绝不退回 getpass，那正是上面注释里说的死等。
        piped = sys.stdin.readline().strip() if sys.stdin else ""
        if piped:
            return piped
        raise SystemExit(
            "这条命令需要解锁金库，但这里既没有控制台可以安全地问你要密码，\n"
            "标准输入也没有内容。请用 --password-file <路径>，\n"
            "或设环境变量 TESSERA_PASSWORD_FILE，或把密码从管道送进来。"
        )
    return getpass.getpass("金库主密码：")


def _emit(args, human: str, payload) -> None:
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(human)


def _data_dir(args) -> Optional[Path]:
    return Path(args.data_dir) if args.data_dir else None


# --- 子命令 ---------------------------------------------------------------


def cmd_status(args) -> int:
    with VaultSession(data_dir=_data_dir(args)) as s:
        exists = s.identity_exists()
        info = s.call("data_dir_info", {})
    payload = {"initialised": exists, "data_dir": info.get("path"), "source": info.get("source")}
    human = "金库{}\n数据目录：{}".format("已建立" if exists else "尚未建立", payload["data_dir"])
    _emit(args, human, payload)
    return EXIT_OK


def cmd_tools(args) -> int:
    """列出电脑清理里那批小工具。不需要解锁 —— 它跟金库数据无关。"""
    with VaultSession(data_dir=_data_dir(args)) as s:
        result = s.call("pcclean_tools", {})
    tools = result.get("tools", [])
    lines = ["{:24} {}".format(t.get("id", ""), t.get("name", "")) for t in tools]
    _emit(args, "\n".join(lines) or "（没有可用工具）", tools)
    return EXIT_OK


def _unlocked(args) -> VaultSession:
    session = VaultSession(data_dir=_data_dir(args))
    try:
        if not session.identity_exists():
            raise SystemExit("这台机器上还没有金库。先打开 Tessera 走一遍首次设置。")
        session.unlock(_read_password(args))
    except BaseException:
        session.close()
        raise
    return session


def cmd_search(args) -> int:
    with _unlocked(args) as s:
        result = s.call("global_search", {"query": args.query})
    hits = result.get("results", [])
    lines = ["[{}] {}".format(h.get("module", ""), h.get("label", "")) for h in hits]
    _emit(args, "\n".join(lines) or "没有命中", hits)
    return EXIT_OK


def cmd_note_list(args) -> int:
    with _unlocked(args) as s:
        result = s.call("note_list", {})
    notes = result.get("notes", [])
    lines = ["{:>5}  {}".format(n.get("id"), n.get("title", "")) for n in notes]
    _emit(args, "\n".join(lines) or "还没有笔记", notes)
    return EXIT_OK


def cmd_note_get(args) -> int:
    with _unlocked(args) as s:
        result = s.call("note_get", {"id": args.id})
    if not result.get("ok"):
        print("取不到这条笔记：{}".format(result.get("error")), file=sys.stderr)
        return EXIT_VAULT
    note = result["note"]
    _emit(args, "# {}\n\n{}".format(note.get("title", ""), note.get("content", "")), note)
    return EXIT_OK


def cmd_note_new(args) -> int:
    content = args.content or ""
    if args.content_file:
        content = Path(args.content_file).read_text(encoding="utf-8")
    with _unlocked(args) as s:
        result = s.call("note_create", {
            "title": args.title,
            "content": content,
            "category": args.category or "",
            "format": args.format,
        })
    if not result.get("ok"):
        print("建不了这条笔记：{}".format(result.get("error")), file=sys.stderr)
        return EXIT_VAULT
    note = result["note"]
    _emit(args, "已建立笔记 #{}：{}".format(note["id"], note.get("title", "")), note)
    return EXIT_OK


def cmd_clip_list(args) -> int:
    with _unlocked(args) as s:
        result = s.call("clipboard_list", {"limit": args.limit})
    return _print_clips(args, result.get("entries", []))


def cmd_clip_search(args) -> int:
    with _unlocked(args) as s:
        result = s.call("clipboard_search", {"query": args.query, "limit": args.limit})
    return _print_clips(args, result.get("entries", []))


def _print_clips(args, entries) -> int:
    lines = []
    for entry in entries:
        # 敏感条目（密码/API Key/卡号）在列表里只报类型不报正文：命令行输出会进回滚缓冲、
        # 日志、被人瞥见；看正文须对单条做显式动作。
        if entry.get("is_sensitive"):
            text = "〔敏感内容，未显示〕"
        else:
            text = (entry.get("content_text") or "").replace("\n", " ")
        lines.append("{:>6}  {}".format(entry.get("id"), text[:100]))
    _emit(args, "\n".join(lines) or "剪贴板历史是空的", entries)
    return EXIT_OK


def _crypt(args, method: str, default_suffix: str, strip_suffix: Optional[str]) -> int:
    src = Path(args.input).expanduser().resolve()
    if not src.is_file():
        print("找不到这个文件：{}".format(src), file=sys.stderr)
        return EXIT_USAGE
    if args.output:
        dst = Path(args.output).expanduser().resolve()
    elif strip_suffix and src.name.endswith(strip_suffix):
        dst = src.with_name(src.name[: -len(strip_suffix)])
    else:
        dst = src.with_name(src.name + default_suffix)
    # 覆盖必须是显式的。加密的目标名是推出来的，撞上一个同名文件的概率不低，
    # 而这里覆盖掉的可能正是用户唯一那份原件。
    if dst.exists() and not args.force:
        print("目标已存在，加 --force 才会覆盖：{}".format(dst), file=sys.stderr)
        return EXIT_USAGE

    last = {"pct": -1}

    def progress(event):
        pct = int(event.get("percent", 0))
        if pct >= last["pct"] + 10 and not args.json:
            last["pct"] = pct
            print("  {}%".format(pct), file=sys.stderr)

    with _unlocked(args) as s:
        result = s.call(method, {"input_path": str(src), "output_path": str(dst)},
                        on_progress=progress)
    if not result.get("ok"):
        print("失败：{}".format(result.get("error")), file=sys.stderr)
        return EXIT_VAULT
    payload = dict(result)
    payload["output_path"] = str(dst)
    _emit(args, "完成：{}".format(dst), payload)
    return EXIT_OK


def cmd_encrypt(args) -> int:
    return _crypt(args, "encrypt_file", ".ivault", None)


def cmd_decrypt(args) -> int:
    return _crypt(args, "decrypt_file", ".decrypted", ".ivault")


# --- 参数表 ---------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tessera",
        description="在终端里用 Tessera 金库。需要金库的命令会问一次主密码。",
    )
    parser.add_argument("--data-dir", default=None, help="换一个数据目录（默认用应用自己那个）")
    parser.add_argument("--password-file", default=None,
                        help="从这个文件读主密码（非交互场景用）。也可用 TESSERA_PASSWORD_FILE")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是给人看的文本")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="金库建了没、数据目录在哪（不需要解锁）").set_defaults(func=cmd_status)
    sub.add_parser("tools", help="列出电脑清理里那批小工具（不需要解锁）").set_defaults(func=cmd_tools)

    search = sub.add_parser("search", help="跨笔记 / 剪贴板 / 密码库搜索")
    search.add_argument("query")
    search.set_defaults(func=cmd_search)

    note = sub.add_parser("note", help="笔记").add_subparsers(dest="note_command", required=True)
    note.add_parser("list", help="列出全部笔记").set_defaults(func=cmd_note_list)
    note_get = note.add_parser("get", help="打印一条笔记的正文")
    note_get.add_argument("id", type=int)
    note_get.set_defaults(func=cmd_note_get)
    note_new = note.add_parser("new", help="新建一条笔记")
    note_new.add_argument("--title", required=True)
    note_new.add_argument("--content", default=None)
    note_new.add_argument("--content-file", default=None, help="从文件读正文")
    note_new.add_argument("--category", default=None)
    note_new.add_argument("--format", default="markdown", choices=["plain", "markdown"])
    note_new.set_defaults(func=cmd_note_new)

    clip = sub.add_parser("clip", help="剪贴板历史").add_subparsers(dest="clip_command", required=True)
    clip_list = clip.add_parser("list", help="最近的条目")
    clip_list.add_argument("--limit", type=int, default=50)
    clip_list.set_defaults(func=cmd_clip_list)
    clip_search = clip.add_parser("search", help="全文搜索")
    clip_search.add_argument("query")
    clip_search.add_argument("--limit", type=int, default=50)
    clip_search.set_defaults(func=cmd_clip_search)

    enc = sub.add_parser("encrypt", help="把一个文件加密成 .ivault")
    enc.add_argument("input")
    enc.add_argument("-o", "--output", default=None)
    enc.add_argument("--force", action="store_true", help="目标已存在时覆盖")
    enc.set_defaults(func=cmd_encrypt)

    dec = sub.add_parser("decrypt", help="解开一个 .ivault")
    dec.add_argument("input")
    dec.add_argument("-o", "--output", default=None)
    dec.add_argument("--force", action="store_true", help="目标已存在时覆盖")
    dec.set_defaults(func=cmd_decrypt)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except VaultError as exc:
        # 后端的错误码原样透出：`auth.wrong_password` 这类字符串是稳定契约，
        # 脚本可以按它分支，比一句被翻译过的中文可靠。
        print("金库拒绝了这次操作：{}".format(exc.code), file=sys.stderr)
        return EXIT_VAULT
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
