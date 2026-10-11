"""file_clip：高性能文件复制/剪切/粘贴，与 Windows 系统剪贴板互通。

用法：python -X utf8 modules/file_clip/cli.py copy|cut <路径...> / paste <目标目录>
[--on-conflict rename|skip|overwrite] / status
"""

MODULE_META = {
    "name": "file_clip",
    "description": "高性能文件复制/剪切/粘贴（Ctrl+C/X/V），与系统剪贴板互通，支持大文件与海量小文件",
    "version": "0.1.0",
}


def register(ctx):
    """Optional: called to wire this module into the app context."""


def run(ctx):
    """Entry point for `python scripts/run.py run file_clip` —— 显示剪贴板状态和用法。"""
    from modules.file_clip.cli import show_status_and_usage

    return show_status_and_usage()
