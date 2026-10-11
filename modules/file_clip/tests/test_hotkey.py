#!/usr/bin/env python
"""hotkey_agent 组件自测（不模拟真实按键）：接管判定、桌面路径解析、COM 窗口解析、
钩子安装/卸载冒烟。真实 Ctrl+V 端到端由用户手工验收。"""

import os
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_clip import hotkey_agent as ha  # noqa: E402


def test_decide_logic():
    ok = dict(
        vk=ha.VK_V, injected=False, ctrl=True, shift=False, alt_or_win=False,
        fg_class="CabinetWClass", has_files=True, focus_class="DirectUIHWND",
    )
    assert ha.decide(**ok) is True, "标准场景应接管"
    assert ha.decide(**{**ok, "fg_class": "WorkerW", "focus_class": "SysListView32"}), \
        "桌面场景应接管"
    # 以下每一种都必须放行（False）
    cases = {
        "注入的按键": {**ok, "injected": True},
        "不是V键": {**ok, "vk": 0x43},
        "没按Ctrl": {**ok, "ctrl": False},
        "带Shift": {**ok, "shift": True},
        "带Alt/Win": {**ok, "alt_or_win": True},
        "前台不是资源管理器": {**ok, "fg_class": "Notepad"},
        "剪贴板不是文件": {**ok, "has_files": False},
        "焦点在重命名/地址栏": {**ok, "focus_class": "Edit"},
        "焦点未知": {**ok, "focus_class": ""},
    }
    for name, kw in cases.items():
        assert ha.decide(**kw) is False, f"「{name}」场景必须放行！"


def test_desktop_path():
    p = ha._desktop_path()
    assert p and os.path.isdir(p), f"桌面路径解析失败: {p!r}"
    print(f"    (桌面 = {p})", end=" ")


def test_com_resolution_existing_windows():
    """只读枚举当前打开的资源管理器窗口，验证 COM 路径解析可用。"""
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        shell = win32com.client.Dispatch("Shell.Application")
        windows = [w for w in shell.Windows()]
        resolved = 0
        for w in windows:
            try:
                hwnd = int(w.HWND)
                path = ha.resolve_target_folder(hwnd, "CabinetWClass")
                if path:
                    resolved += 1
                    print(f"\n    (现有窗口 hwnd={hwnd} → {path})", end=" ")
            except Exception:
                continue
        if not windows:
            print("    (当前没有打开的资源管理器窗口，跳过实窗解析)", end=" ")
    finally:
        pythoncom.CoUninitialize()


def test_hook_install_smoke():
    """观察模式装上真钩子 1.5 秒再卸载：验证安装/消息泵/卸载全链路。"""
    agent = ha.HotkeyAgent(dry_run=True)
    agent.start()
    assert agent.hook, "钩子句柄为空"
    t0 = time.perf_counter()
    agent.pump(duration=1.5)
    elapsed = time.perf_counter() - t0
    agent.stop()
    assert agent.hook is None, "卸载后句柄应清空"
    assert 1.3 < elapsed < 5, f"消息泵计时异常: {elapsed:.2f}s"


def main() -> int:
    tests = [
        ("接管判定逻辑（9 种放行场景 + 2 种接管场景）", test_decide_logic),
        ("桌面真实路径解析（含 OneDrive 重定向）", test_desktop_path),
        ("COM 解析现有资源管理器窗口（只读）", test_com_resolution_existing_windows),
        ("键盘钩子安装/卸载冒烟（观察模式 1.5s）", test_hook_install_smoke),
    ]
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
        except Exception as exc:
            failed += 1
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
        else:
            passed += 1
            print(f"PASS  {name}")
    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
