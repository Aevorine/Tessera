"""按需提权助手进程。

主应用永远以普通权限运行：Tessera 长期持有解密后的密钥材料，长期管理员进程被攻破会失陷整台机器。
只有清理套件的一小部分（注册表 HKLM、服务、WinSxS、还原点、系统目录）需要提权。流程：主进程写
JSON「作业单」到临时目录 → ShellExecuteW("runas") 拉起同一个后端 exe（`--pcclean-helper <作业单>`）
→ 用户点一次 UAC → 助手干活、写「结果单」后退出 → 主进程轮询。

用文件而不用管道：提权/非提权间的管道要处理 ACL，写错就是任何本地进程可连的通道；文件放在仅当前用户
可读写的目录里更安全。作业单绝不放密钥、保险库路径或自由文本，只含枚举出来的动作类型 + 目标标识，
助手侧再校验一遍，所以即使有人能写该目录，也超不出清理动作的范围。
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

IS_WINDOWS = os.name == "nt"

HELPER_FLAG = "--pcclean-helper"
_RESULT_POLL_S = 0.25
_DEFAULT_TIMEOUT_S = 180.0

# 助手允许执行的动作。**白名单，不是黑名单** —— 作业单里出现清单外的
# 动作一律拒绝执行并原样报错。
ALLOWED_ACTIONS = frozenset({
    "execute_items",
    "create_restore_point",
    "dism_cleanup",
    "disable_hibernation",
    "shrink_shadow_storage",
    "delete_windows_old",
    "purge_standby_list",
    "defrag_volume",
    "retrim_volume",
})


def is_elevated() -> bool:
    if not IS_WINDOWS:
        return os.geteuid() == 0 if hasattr(os, "geteuid") else False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (OSError, AttributeError):
        return False


def _job_dir() -> Path:
    """作业单目录。放在用户自己的 temp 下 —— 那里默认只有本人和 SYSTEM 可写。
    绝不放 `C:\\Windows\\Temp`（所有用户可写，等于把作业单交给任何人改）。"""
    base = Path(tempfile.gettempdir()) / "tessera-pcclean"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _self_command() -> List[str]:
    """怎么再启动一次自己：冻结（PyInstaller）后 `sys.executable` 就是后端 exe，直接带参数；
    源码模式要 `python -m modules.file_vault.backend_server`。混用会让 python.exe 解析
    `--pcclean-helper`，argparse exit 2，表现为点了没反应。"""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    repo_root = Path(__file__).resolve().parents[3]
    return [sys.executable, "-X", "utf8",
            str(repo_root / "modules" / "file_vault" / "backend_server.py")]


@dataclass
class HelperJob:
    action: str
    payload: Dict[str, Any]
    job_id: str = ""

    def __post_init__(self) -> None:
        if not self.job_id:
            self.job_id = uuid.uuid4().hex[:16]


def run_elevated(job: HelperJob, *, timeout_s: float = _DEFAULT_TIMEOUT_S,
                 data_dir: Optional[Path] = None) -> Dict[str, Any]:
    """拉起提权助手执行作业并同步等结果。调用方必须处理三种返回：
    `{"ok": True, ...}` 完成；`{"ok": False, "error": "pcclean.elevate.declined"}` 用户拒绝 UAC；
    `{"ok": False, "error": "pcclean.elevate.timeout"}` 超时。

    拒绝 UAC 是正常选择，界面应说「需要管理员权限，未授权所以跳过」，不弹红色失败。"""
    if not IS_WINDOWS:
        return {"ok": False, "error": "pcclean.elevate.windowsOnly"}
    if job.action not in ALLOWED_ACTIONS:
        return {"ok": False, "error": "pcclean.elevate.actionNotAllowed",
                "action": job.action}

    job_dir = _job_dir()
    job_path = job_dir / f"{job.job_id}.job.json"
    result_path = job_dir / f"{job.job_id}.result.json"

    payload = {
        "job_id": job.job_id,
        "action": job.action,
        "payload": job.payload,
        "data_dir": str(data_dir) if data_dir else "",
        "created_at": time.time(),
    }
    try:
        job_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        return {"ok": False, "error": f"pcclean.elevate.jobWriteFailed:{type(exc).__name__}"}

    command = _self_command()
    exe = command[0]
    args = command[1:] + [HELPER_FLAG, str(job_path)]
    # ShellExecuteW 的参数是一整个字符串，含空格的路径必须自己加引号 ——
    # 见项目简报第 4 区那条「PowerShell 传参会静默拆坏」，同一类坑。
    arg_string = " ".join(f'"{a}"' if " " in a else a for a in args)

    try:
        rc = ctypes.windll.shell32.ShellExecuteW(
            None, "runas", exe, arg_string, None, 0  # SW_HIDE
        )
    except (OSError, AttributeError) as exc:
        _cleanup(job_path, result_path)
        return {"ok": False, "error": f"pcclean.elevate.launchFailed:{type(exc).__name__}"}

    # ShellExecuteW 返回值 ≤32 是错误码。5 = ERROR_ACCESS_DENIED，
    # 也就是用户在 UAC 对话框上点了"否"。
    if rc <= 32:
        _cleanup(job_path, result_path)
        if rc == 5:
            return {"ok": False, "error": "pcclean.elevate.declined"}
        return {"ok": False, "error": "pcclean.elevate.launchFailed", "code": int(rc)}

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if result_path.exists():
            try:
                # 助手是先写临时文件再 os.replace 的，所以只要文件在就一定是完整的。
                result = json.loads(result_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                time.sleep(_RESULT_POLL_S)
                continue
            _cleanup(job_path, result_path)
            return result
        time.sleep(_RESULT_POLL_S)

    _cleanup(job_path, result_path)
    return {"ok": False, "error": "pcclean.elevate.timeout"}


def _cleanup(*targets: Path) -> None:
    for target in targets:
        try:
            if target.exists():
                target.unlink()
        except OSError:
            pass



def run_as_helper(job_path_raw: str) -> int:
    """助手进程入口，`backend_server.main()` 见到 `--pcclean-helper` 时调用，返回退出码。
    无论如何都要写结果文件，否则主进程只能等超时，用户看到的是卡住。"""
    job_path = Path(job_path_raw)
    result_path = job_path.with_name(job_path.name.replace(".job.json", ".result.json"))

    def _write(result: Dict[str, Any]) -> int:
        try:
            tmp = result_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(result, ensure_ascii=False, default=str),
                           encoding="utf-8")
            os.replace(tmp, result_path)
        except OSError:
            return 1
        return 0 if result.get("ok") else 2

    try:
        raw = json.loads(job_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return _write({"ok": False, "error": f"pcclean.helper.badJob:{type(exc).__name__}"})

    action = str(raw.get("action") or "")
    if action not in ALLOWED_ACTIONS:
        return _write({"ok": False, "error": "pcclean.helper.actionNotAllowed",
                       "action": action})

    # 作业单不能太老 —— 防的是有人留一份旧作业单在临时目录里等着被执行。
    created = float(raw.get("created_at") or 0)
    if created and time.time() - created > 600:
        return _write({"ok": False, "error": "pcclean.helper.jobExpired"})

    payload = raw.get("payload") or {}
    data_dir = Path(raw.get("data_dir") or ".")

    try:
        result = _dispatch_helper(action, payload, data_dir)
    except Exception as exc:
        result = {"ok": False, "error": f"pcclean.helper.failed:{type(exc).__name__}"}
    result.setdefault("action", action)
    return _write(result)


def _dispatch_helper(action: str, payload: Dict[str, Any],
                     data_dir: Path) -> Dict[str, Any]:
    from modules.file_vault.pcclean import actions as actions_mod
    from modules.file_vault.pcclean import memory as memory_mod
    from modules.file_vault.pcclean import toolbox
    from modules.file_vault.pcclean.model import CleanItem, Importance

    if action == "execute_items":
        items: List[CleanItem] = []
        for raw_item in payload.get("items") or []:
            if not isinstance(raw_item, dict):
                continue
            items.append(CleanItem(
                item_id=str(raw_item.get("item_id") or ""),
                category=str(raw_item.get("category") or ""),
                label=str(raw_item.get("label") or ""),
                size_bytes=int(raw_item.get("size_bytes") or 0),
                path=str(raw_item.get("path") or ""),
                # 提权侧**重新按 OPTIONAL 起判**，绝不信作业单里的 importance。
                importance=Importance.OPTIONAL,
                locked=False,
                detail=dict(raw_item.get("detail") or {}),
            ))
        result = actions_mod.execute(
            data_dir, items,
            create_restore_point=bool(payload.get("create_restore_point", False)),
        )
        return {"ok": not result.aborted, **result.to_dict()}

    if action == "create_restore_point":
        return toolbox.tool_create_restore_point(payload)

    if action == "purge_standby_list":
        return memory_mod.purge_standby_list()

    if action == "disable_hibernation":
        return toolbox.tool_toggle_hibernation({"enable": bool(payload.get("enable", False))})

    if action == "dism_cleanup":
        from modules.file_vault.pcclean.space import _run
        code, out = _run(
            ["dism.exe", "/Online", "/Cleanup-Image", "/StartComponentCleanup"],
            timeout=1800.0,
        )
        return {"ok": code == 0, "exit_code": code, "output": out[-2000:]}

    if action == "shrink_shadow_storage":
        from modules.file_vault.pcclean.space import _run
        drive = str(payload.get("drive") or "C:")
        max_size = str(payload.get("max_size") or "3%")
        code, out = _run(
            ["vssadmin.exe", "resize", "shadowstorage",
             f"/for={drive}", f"/on={drive}", f"/maxsize={max_size}"],
            timeout=180.0,
        )
        return {"ok": code == 0, "exit_code": code, "output": out[-2000:]}

    if action == "delete_windows_old":
        import shutil
        target = Path(str(payload.get("path") or ""))
        if not target.exists() or target.name.lower() != "windows.old":
            # 名字必须是 Windows.old —— 这条检查防的是作业单被改成别的路径。
            return {"ok": False, "error": "pcclean.helper.badTarget"}
        shutil.rmtree(target, ignore_errors=True)
        return {"ok": not target.exists(), "path": str(target)}

    if action in ("defrag_volume", "retrim_volume"):
        from modules.file_vault.pcclean.space import _run
        drive = str(payload.get("drive") or "C:").rstrip("\\")
        flag = "/L" if action == "retrim_volume" else "/O"
        # /O 让 defrag 自己按介质选策略；/L 是显式 retrim。
        # **绝不用 /D**（强制碎片整理）—— 在 SSD 上那是纯损耗。
        code, out = _run(["defrag.exe", drive, flag, "/V"], timeout=3600.0)
        return {"ok": code == 0, "exit_code": code, "output": out[-4000:],
                "mode": "retrim" if action == "retrim_volume" else "optimize"}

    return {"ok": False, "error": "pcclean.helper.actionNotAllowed", "action": action}


def helper_argv(argv: List[str]) -> Optional[str]:
    """从命令行认出助手模式并返回作业单路径。同 `backend_server._hook_cli_argv`：
    一个 exe 复用多入口时要在 argparse 之前摘出分支，否则 argparse 因不认识的参数直接退出。"""
    for index, arg in enumerate(argv):
        if arg == HELPER_FLAG and index + 1 < len(argv):
            return argv[index + 1]
    return None
