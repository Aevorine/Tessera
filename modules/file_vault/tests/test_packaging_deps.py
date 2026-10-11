"""打包配置必须包含运行时用到的模块。

钩子助手是独立进程，progress_ui.py 用 tkinter 画窗口；spec 的 excludes 曾含 "tkinter"，
只在冻结产物里、用户第一次按 Delete 时才崩，源码开发发现不了，所以静态检查 spec。
"""

import ast
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SPEC = PROJECT_ROOT / "packaging" / "file_vault_backend.spec"

# 被冻结进后端的模块。它们的 import 都必须能在打包产物里解析到。
FROZEN_SOURCES = [
    PROJECT_ROOT / "core" / "fileops" / "progress_ui.py",
    PROJECT_ROOT / "core" / "fileops" / "hook_cli.py",
    PROJECT_ROOT / "core" / "fileops" / "engine.py",
]


def _excludes_from_spec() -> set:
    """读出 spec 里的 excludes 列表；用 ast 而非 exec，因 spec 依赖 PyInstaller 注入的全局名。"""
    text = SPEC.read_text(encoding="utf-8")
    match = re.search(r"^excludes\s*=\s*(\[[\s\S]*?\])", text, re.M)
    assert match, "spec 里找不到 excludes 列表"
    return set(ast.literal_eval(match.group(1)))


def _toplevel_imports(path: Path) -> set:
    """收集一个源文件里所有 import 的顶层模块名，含函数内的延迟 import。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                names.add(node.module.split(".")[0])
    return names


def test_frozen_code_does_not_import_an_excluded_module():
    excluded = _excludes_from_spec()
    problems = []
    for src in FROZEN_SOURCES:
        if not src.exists():
            continue
        for mod in _toplevel_imports(src):
            if mod in excluded:
                problems.append(f"{src.relative_to(PROJECT_ROOT)} 里 import 了被 excludes 排除的 {mod!r}")
    assert not problems, (
        "打包会把这些模块排除掉，但冻结进去的代码要用它们——"
        "表现是打包后一切正常，直到用户触发到那条代码路径才崩：\n  "
        + "\n  ".join(problems)
    )


def test_tkinter_is_not_excluded():
    """单拎出来写一条，因为这个坑刚踩过，值得有一条一眼能看懂的断言。"""
    assert "tkinter" not in _excludes_from_spec(), (
        "tkinter 不能排除：钩子助手用它画进度窗和永久删除确认框，"
        "排掉之后按 Delete / Ctrl+V 会直接崩。"
    )
