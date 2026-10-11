"""主进程里不能被悄悄拆掉的几道闸。

这是源码断言而非行为测试（沙箱和 CI 跑不了 Electron）：防的是重构时顺手删掉一行安全检查、
功能照常且无测试变红；价值在于删那行代码时有人被拦住。
"""

import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
ELECTRON_MAIN = PROJECT_ROOT / "modules" / "file_vault" / "ui" / "electron" / "main.ts"


def test_electron_main_restricts_renderer_navigation_and_popups():
    source = ELECTRON_MAIN.read_text(encoding="utf-8")

    assert "setWindowOpenHandler" in source
    assert "will-navigate" in source
    assert "isTrustedRendererUrl" in source


def test_electron_main_validates_ipc_sender_and_keeps_remote_debugging_opt_in():
    source = ELECTRON_MAIN.read_text(encoding="utf-8")

    assert "assertTrustedRenderer" in source
    assert "senderFrame" in source
    assert "IDEAL1_ENABLE_REMOTE_DEBUGGING" in source


def test_ipc_sender_check_fails_closed_when_the_frame_is_gone():
    """`senderFrame` 自 Electron 35 起可空（frame 可能在主进程处理前被销毁）。空值必须当"拒绝"，
    否则 IPC 门禁在攻击者可制造的时序窗口里失效。

    盯的是为消 TS 报错把 `frame.url` 改成 `frame?.url ?? ''`（空 frame 进入 isTrustedRendererUrl('')）
    或 `frame!.url`（断言掉可空性）。
    """
    source = ELECTRON_MAIN.read_text(encoding="utf-8")

    body = re.search(
        r"function assertTrustedRenderer\([^)]*\)\s*\{(.*?)\n\}",
        source,
        re.S,
    )
    assert body is not None, "assertTrustedRenderer 不见了或者签名变了"
    code = body.group(1)

    assert "!frame" in code, "必须显式拒绝空的 senderFrame"
    assert "throw" in code, "检查不通过必须抛错，不能只是记日志"
    assert "senderFrame!" not in code, "不要用 ! 断言掉可空性——那正是这道检查要防的"


def test_open_external_is_restricted_to_an_https_allowlist():
    """`shell.openExternal` 把 URL 交给系统按协议处理：`file:` 能启动本地可执行文件，Windows 上一批
    自定义协议历史上被用于 RCE，而渲染进程跑着 Markdown、剪贴板富文本、OCR 文本等不可信内容。
    所以主进程侧必须校验协议和域名，渲染端传什么都绕不过。"""
    source = ELECTRON_MAIN.read_text(encoding="utf-8")

    assert "shell:openExternal" in source, "「关于」页的外链通道不见了"
    assert "ALLOWED_HOSTS" in source, "外链必须走域名白名单"
    assert "url.protocol !== 'https:'" in source, "只放行 https"
