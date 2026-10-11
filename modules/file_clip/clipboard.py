"""Windows 剪贴板文件列表读写的重导出层；
实现已提升到 core/fileops/clipboard.py，保留以免改动现有 import。"""

from core.fileops.clipboard import *  # noqa: F401,F403
from core.fileops.clipboard import (  # noqa: F401
    ClipboardError,
    get_file_drop,
    set_file_drop,
    clear_clipboard,
)
