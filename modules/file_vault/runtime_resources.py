"""开发 / PyInstaller 冻结两种模式下统一的资源路径解析。

冻结后 `__file__` 指向每次启动都不同的 `_MEIPASS`（one-file）或 `_internal`（one-dir），
散落的 `Path(__file__)` 会在用到时才报"文件不存在"，所以收敛到这里。
不负责用户数据目录，见 data_dir.py。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional


def is_frozen() -> bool:
    """是否跑在 PyInstaller 冻结产物里（`sys.frozen` 与 `sys._MEIPASS` 都查，别的冻结工具只设前者）。"""
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def resource_root() -> Path:
    """自带资源根目录：冻结时为 `sys._MEIPASS`，开发时为仓库根。

    one-file 的 `_MEIPASS` 每次启动都变，绝不能写进注册表 Run 项或持久化配置
    （见 data_dir.py::file_hook_runtime_dir）。
    """
    if is_frozen():
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent.parent


def resource_path(*parts: str) -> Path:
    """定位自带资源，相对路径从仓库根算起，两种模式写法一致。"""
    return resource_root().joinpath(*parts)


def find_resource(*candidates: tuple[str, ...]) -> Optional[Path]:
    """返回候选中第一个真实存在的资源路径，都没有返回 None（资源可选，由调用方决定降级还是报错）。"""
    for parts in candidates:
        path = resource_path(*parts)
        if path.exists():
            return path
    return None


def bundled_executable(name: str, *source_tree_parts: str) -> Optional[Path]:
    """找自带可执行文件；Windows 下自动补 `.exe` 再试一遍（`--add-binary` 有时保留原名）。"""
    names = [name]
    if os.name == "nt" and not name.lower().endswith(".exe"):
        names.append(name + ".exe")
    candidates: list[tuple[str, ...]] = []
    for candidate_name in names:
        # 冻结后平铺在 _MEIPASS 根下的情况
        candidates.append((candidate_name,))
        # 源码树 / one-dir 下保持原有目录结构的情况
        if source_tree_parts:
            candidates.append((*source_tree_parts, candidate_name))
    return find_resource(*candidates)
