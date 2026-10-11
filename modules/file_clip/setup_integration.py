# 重导出 core.fileops.system_integration 的通用接口，仅保留 file_clip 独有的
# 右键菜单/桌面快捷方式 install/uninstall；file_vault 直接 import core 版本。

import argparse
import os
import subprocess
import sys
import tempfile
import winreg
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.fileops.system_integration import (  # noqa: E402,F401
    HOOK_EXE,
    HOOK_SRC,
    NATIVE_BUTTONS_ON_MARKER,
    UI_SCAN_PS1,
    build_hook_agent,
    is_running,
    native_buttons_enabled,
    restart_agent,
    start_agent,
    stop_agent,
)

MODULE_DIR = PROJECT_ROOT / "modules" / "file_clip"
CLI = str(MODULE_DIR / "cli.py")
# HOOK_EXE 用上面导入的 core 那份；此处曾重复定义指向已无人编译的
# modules/file_clip/c/ 旧路径，导致 status/install 误报"未编译"。
SHORTCUT_NAME = "file_clip 热键代理.lnk"

# Win11 经典右键菜单：写完这个空 CLSID 键，第三方菜单项在右键时第一层直接可见。
CLASSIC_MENU_KEY = (
    r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32"
)

import sys as _sys
_pyw = Path(_sys.executable).with_name("pythonw.exe")
PYTHON_GUI = str(_pyw) if _pyw.exists() else _sys.executable


def _gui_cmd(rest: str) -> str:
    return f'"{PYTHON_GUI}" -X utf8 "{CLI}" {rest}'


# (注册表键, 菜单文字, 命令)。Background/桌面用 %V，文件/文件夹图标用 %1。
MENU_ENTRIES = [
    (r"Software\Classes\Directory\Background\shell\file_clip_paste",
     "file_clip 高速粘贴", _gui_cmd('paste "%V" --gui')),
    (r"Software\Classes\Directory\shell\file_clip_paste",
     "file_clip 高速粘贴", _gui_cmd('paste "%1" --gui')),
    (r"Software\Classes\DesktopBackground\shell\file_clip_paste",
     "file_clip 高速粘贴", _gui_cmd('paste "%V" --gui')),
    (r"Software\Classes\AllFilesystemObjects\shell\file_clip_delete",
     "file_clip 高速删除（永久）", _gui_cmd('queue-delete "%1" --permanent')),
    (r"Software\Classes\AllFilesystemObjects\shell\file_clip_recycle",
     "file_clip 删到回收站", _gui_cmd('queue-delete "%1" --recycle')),
]


def _enable_classic_menu() -> None:
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, CLASSIC_MENU_KEY) as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, "")


def _disable_classic_menu() -> bool:
    parent = CLASSIC_MENU_KEY.rsplit("\\", 1)[0]
    ok = False
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, CLASSIC_MENU_KEY)
        ok = True
    except OSError:
        pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, parent)
    except OSError:
        pass
    return ok


def _classic_menu_on() -> bool:
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER, CLASSIC_MENU_KEY).Close()
        return True
    except OSError:
        return False


def _restart_explorer() -> None:
    """让右键菜单改动生效。tasklist 输出非 UTF-8（中文 Windows 为 GBK），
    errors="replace" 防 -X utf8 下解码炸掉。"""
    subprocess.run(["taskkill", "/F", "/IM", "explorer.exe"],
                   capture_output=True, text=True, errors="replace")
    subprocess.Popen(["explorer.exe"])


def _desktop_dir() -> str:
    from modules.file_clip.hotkey_agent import _desktop_path

    p = _desktop_path()
    if not p:
        raise RuntimeError("解析不到桌面路径")
    return p


def _startup_dir() -> str:
    return os.path.join(
        os.environ["APPDATA"], "Microsoft", "Windows",
        "Start Menu", "Programs", "Startup",
    )


def _make_shortcut(lnk_path: str) -> None:
    import win32com.client

    shell = win32com.client.Dispatch("WScript.Shell")
    sc = shell.CreateShortCut(lnk_path)
    sc.TargetPath = HOOK_EXE
    sc.Arguments = f'"{PYTHON_GUI}" "{CLI}" rename'
    sc.WorkingDirectory = str(PROJECT_ROOT)
    sc.Description = "file_clip：资源管理器 Ctrl+V 高速粘贴代理（C 版，无窗口）"
    sc.Save()


def _delete_key_tree(root, key_path: str) -> bool:
    try:
        winreg.DeleteKey(root, key_path + r"\command")
    except OSError:
        pass
    try:
        winreg.DeleteKey(root, key_path)
        return True
    except OSError:
        return False


# ---- install / uninstall / status（file_clip 独有，不走 core）----

def install() -> None:
    build_hook_agent()
    print(f"✓ C 钩子代理已就绪：{HOOK_EXE}")
    for key_path, text, command in MENU_ENTRIES:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
            winreg.SetValueEx(k, None, 0, winreg.REG_SZ, text)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path + r"\command") as k:
            winreg.SetValueEx(k, None, 0, winreg.REG_SZ, command)
    print("✓ 右键菜单已添加：高速粘贴 ×3 处、高速删除（永久）、删到回收站")
    print("  （Win11 默认右键菜单保持不变，这些项在「显示更多选项」里；"
          "想第一层直接可见可另外执行 menu-classic-on）")

    desktop_lnk = os.path.join(_desktop_dir(), SHORTCUT_NAME)
    _make_shortcut(desktop_lnk)
    print(f"✓ 桌面快捷方式（→ C 代理）：{desktop_lnk}")
    startup_lnk = os.path.join(_startup_dir(), SHORTCUT_NAME)
    _make_shortcut(startup_lnk)
    print(f"✓ 开机自启（→ C 代理，无窗口）：{startup_lnk}")

    restart_agent(CLI, on_conflict="rename")
    nb_msg = "（含原生按钮接管）" if native_buttons_enabled() else "（原生按钮接管未启用）"
    print(f"✓ C 钩子代理已启动 {nb_msg}：Ctrl+V / Delete / Shift+Delete 高速接管，"
          "工具栏与右键菜单的粘贴/删除按钮同样接管")
    print("  右键菜单新增项不需要重启资源管理器，下次右键即可看到"
          "（想恢复经典菜单第一层直达可执行 menu-classic-on，会重启一次资源管理器）")


def uninstall() -> None:
    if stop_agent():
        print("✓ 已发送停止信号给运行中的钩子代理（会一并结束 UIA 扫描子进程）")
    removed = sum(
        _delete_key_tree(winreg.HKEY_CURRENT_USER, kp) for kp, _, _ in MENU_ENTRIES
    )
    print(f"✓ 右键菜单已移除（{removed}/{len(MENU_ENTRIES)} 处）")
    if _disable_classic_menu():
        print("✓ 已恢复 Win11 默认右键菜单")
    for d in (_desktop_dir(), _startup_dir()):
        lnk = os.path.join(d, SHORTCUT_NAME)
        if os.path.exists(lnk):
            os.unlink(lnk)
            print(f"✓ 已删除 {lnk}")
    tmp = tempfile.gettempdir()
    for name in ("file_clip_native_buttons_off", "file_clip_native_buttons_on", "file_clip_hotrects.txt",
                 "file_clip_hotrects.txt.tmp", "file_clip_mouse_hook.log"):
        p = os.path.join(tmp, name)
        if os.path.exists(p):
            try:
                os.unlink(p)
            except OSError:
                pass
    _restart_explorer()
    print("✓ 已重启资源管理器让菜单恢复生效")
    print("卸载完成，系统恢复原样。")


def status() -> None:
    print(f"[{'已编译' if os.path.exists(HOOK_EXE) else '未编译'}] C 钩子代理: {HOOK_EXE}")
    running = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq hook_agent.exe", "/NH"],
        capture_output=True, text=True, errors="replace",
    ).stdout
    print(f"[{'运行中' if 'hook_agent.exe' in running else '未运行'}] 钩子代理进程")
    print(f"[{'已开启' if _classic_menu_on() else '未开启'}] 经典右键菜单（第一层直达）")
    nb_on = native_buttons_enabled()
    print(f"[{'已开启' if nb_on else '已关闭'}] 原生按钮接管（工具栏+右键图标行的粘贴/删除）"
          + ("" if os.path.exists(UI_SCAN_PS1) else "（UIA 脚本缺失，无法启用）"))
    if nb_on:
        scanning = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq powershell.exe", "/NH"],
            capture_output=True, text=True, errors="replace",
        ).stdout
        print(f"    [{'运行中' if 'powershell.exe' in scanning else '未运行——重启一次代理试试'}] UIA 扫描子进程")
    for key_path, text, _ in MENU_ENTRIES:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path + r"\command"):
                print(f"[已装] {text}: {key_path.split(chr(92))[-1]}")
        except OSError:
            print(f"[未装] {text}")
    for label, d in (("桌面快捷方式", _desktop_dir()), ("开机自启", _startup_dir())):
        lnk = os.path.join(d, SHORTCUT_NAME)
        print(f"[{'已装' if os.path.exists(lnk) else '未装'}] {label}: {lnk}")


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="file_clip 系统集成安装器")
    parser.add_argument(
        "action",
        choices=["install", "uninstall", "status", "start", "stop",
                 "menu-classic-on", "menu-classic-off",
                 "native-buttons-on", "native-buttons-off"],
    )
    args = parser.parse_args(argv)
    if args.action == "start":
        build_hook_agent()
        start_agent(CLI, on_conflict="rename")
        print("✓ 钩子代理已启动（无窗口，用 stop 停止）")
        return 0
    if args.action == "stop":
        print("✓ 已停止" if stop_agent() else "没有运行中的代理")
        return 0
    if args.action == "menu-classic-on":
        _enable_classic_menu()
        _restart_explorer()
        print("✓ 已切回经典右键菜单（本模块菜单项第一层直接可见）；用 menu-classic-off 恢复默认")
        return 0
    if args.action == "menu-classic-off":
        changed = _disable_classic_menu()
        _restart_explorer()
        print("✓ 已恢复 Win11 默认右键菜单" if changed else "本就是 Win11 默认右键菜单，无需改动")
        return 0
    if args.action == "native-buttons-on":
        with open(NATIVE_BUTTONS_ON_MARKER, "w", encoding="utf-8") as f:
            f.write("on")
        restart_agent(CLI, on_conflict="rename")
        print("✓ 已开启原生按钮接管（工具栏「粘贴/删除」+ 右键菜单图标行），代理已重启生效")
        print("  警告：2026-07-21 实测这条鼠标钩子路径仍会间歇性让整个钩子代理崩溃"
              "（连带影响已验证稳定的 Ctrl+V/Delete 键盘快捷键），根因未完全查清，"
              "默认是关闭的——开启前请知情，出现资源管理器快捷键突然失灵时先执行"
              "native-buttons-off 排除")
        return 0
    if args.action == "native-buttons-off":
        if os.path.exists(NATIVE_BUTTONS_ON_MARKER):
            os.unlink(NATIVE_BUTTONS_ON_MARKER)
        restart_agent(CLI, on_conflict="rename")
        print("✓ 已关闭原生按钮接管（回退纯键盘版：Ctrl+V / Delete / Shift+Delete 仍然生效），代理已重启生效")
        return 0
    {"install": install, "uninstall": uninstall, "status": status}[args.action]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
