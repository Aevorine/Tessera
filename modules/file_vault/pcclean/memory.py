"""内存清理与实时内存占用。

这是清理套件里最容易骗人的一项：Windows 不需要第三方「释放内存」。「已用内存」里很大一部分是待机列表
（standby list，已读入、暂时无人用的缓存页），随时可回收；强行倒掉只让数字好看，之后每次打开都要重新读盘，
净效果是变慢。所以：
1. 默认只做 `EmptyWorkingSet`，且只对空闲超过阈值的长期后台大内存进程（如开了几十个标签的浏览器），对刚启动的进程无意义甚至有害。
2. 清待机列表是单独开关，默认关闭，界面必须写清代价。
3. 报告同时给「释放了多少」和「待机列表有多少」，让用户看到那个大数字其实是缓存。
不假装能优化物理内存不足，那只能加内存或关程序。
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from typing import Dict, List, Optional, Tuple

from modules.file_vault.pcclean.model import (
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)

IS_WINDOWS = os.name == "nt"

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_SET_QUOTA = 0x0100
PROCESS_QUERY_INFORMATION = 0x0400


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", wintypes.DWORD),
        ("dwMemoryLoad", wintypes.DWORD),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


class PERFORMANCE_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("CommitTotal", ctypes.c_size_t),
        ("CommitLimit", ctypes.c_size_t),
        ("CommitPeak", ctypes.c_size_t),
        ("PhysicalTotal", ctypes.c_size_t),
        ("PhysicalAvailable", ctypes.c_size_t),
        ("SystemCache", ctypes.c_size_t),
        ("KernelTotal", ctypes.c_size_t),
        ("KernelPaged", ctypes.c_size_t),
        ("KernelNonpaged", ctypes.c_size_t),
        ("PageSize", ctypes.c_size_t),
        ("HandleCount", wintypes.DWORD),
        ("ProcessCount", wintypes.DWORD),
        ("ThreadCount", wintypes.DWORD),
    ]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def memory_status() -> Dict[str, int]:
    """当前内存状况。这是「实时内存占用」那个磁贴的数据源。"""
    if not IS_WINDOWS:
        return {}
    stat = MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(stat)
    perf = PERFORMANCE_INFORMATION()
    perf.cb = ctypes.sizeof(perf)
    try:
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
        ctypes.windll.psapi.GetPerformanceInfo(ctypes.byref(perf), perf.cb)
    except (OSError, AttributeError):
        return {}
    page = perf.PageSize or 4096
    return {
        "total_bytes": int(stat.ullTotalPhys),
        "available_bytes": int(stat.ullAvailPhys),
        "used_bytes": int(stat.ullTotalPhys - stat.ullAvailPhys),
        "load_percent": int(stat.dwMemoryLoad),
        # SystemCache 就是那块"看起来被占用、其实随时能还回来"的量。
        # 把它单独报出来是这个面板最有价值的一个数字。
        "cache_bytes": int(perf.SystemCache * page),
        "commit_total_bytes": int(perf.CommitTotal * page),
        "commit_limit_bytes": int(perf.CommitLimit * page),
        "process_count": int(perf.ProcessCount),
        "thread_count": int(perf.ThreadCount),
        "handle_count": int(perf.HandleCount),
    }


def _enum_processes() -> List[int]:
    if not IS_WINDOWS:
        return []
    count = 4096
    while True:
        buf = (wintypes.DWORD * count)()
        needed = wintypes.DWORD()
        try:
            ok = ctypes.windll.psapi.EnumProcesses(
                ctypes.byref(buf), ctypes.sizeof(buf), ctypes.byref(needed)
            )
        except (OSError, AttributeError):
            return []
        if not ok:
            return []
        returned = needed.value // ctypes.sizeof(wintypes.DWORD)
        if returned < count:
            return [buf[i] for i in range(returned) if buf[i]]
        count *= 2
        if count > 262144:
            return [buf[i] for i in range(returned) if buf[i]]


def _process_name(handle) -> str:
    buf = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(len(buf))
    try:
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(
            handle, 0, buf, ctypes.byref(size)
        ):
            return os.path.basename(buf.value)
    except (OSError, AttributeError):
        pass
    return ""


def _working_set(handle) -> int:
    counters = PROCESS_MEMORY_COUNTERS_EX()
    counters.cb = ctypes.sizeof(counters)
    try:
        if ctypes.windll.psapi.GetProcessMemoryInfo(
            handle, ctypes.byref(counters), counters.cb
        ):
            return int(counters.WorkingSetSize)
    except (OSError, AttributeError):
        pass
    return 0


# 绝不动这些进程的工作集。对系统进程做 EmptyWorkingSet 会让整机在接下来
# 几秒里明显卡顿（它们马上又要把页面读回来），得不偿失。
_SKIP_PROCESSES = {
    "system", "system idle process", "registry", "smss.exe", "csrss.exe",
    "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe", "fontdrvhost.exe",
    "dwm.exe", "memcompression", "msmpeng.exe",
}


def scan_memory(task: ScanTask, *, min_working_set_mb: float = 50.0) -> ScanReport:
    """列出当前工作集超过阈值的进程供用户挑选压缩；全列有两三百条，绝大多数只占几 MB，压缩无意义。"""
    items: List[CleanItem] = []
    if not IS_WINDOWS:
        return task.report(items, errors=["memory.windows_only"])

    threshold = int(min_working_set_mb * 1024 * 1024)
    pids = _enum_processes()
    kernel32 = ctypes.windll.kernel32

    opened = 0
    refused = 0
    for index, pid in enumerate(pids):
        if task.cancelled():
            break
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, False, pid
        )
        if not handle:
            # 打不开的进程绝大多数是系统级的（非提权进程本来就够不着），
            # 但**全部打不开**说明的是别的事——所以这个数要记下来交给界面。
            refused += 1
            continue
        opened += 1
        try:
            name = _process_name(handle)
            if not name or name.lower() in _SKIP_PROCESSES:
                continue
            ws = _working_set(handle)
            if ws < threshold:
                continue
            items.append(CleanItem(
                item_id=f"memory:{pid}",
                category="memory",
                label=name,
                size_bytes=ws,
                path=str(pid),
                importance=Importance.COMMON,
                reason="pcclean.memory.workingSet",
                default_selected=False,
                detail={"pid": pid, "process": name, "working_set": ws},
            ))
        finally:
            kernel32.CloseHandle(handle)
        if index % 25 == 0:
            task.progress(index, max(1, len(pids)))

    items.sort(key=lambda i: i.size_bytes, reverse=True)
    task.progress(len(pids), max(1, len(pids)))
    return task.report(items, probes=opened, denied=refused)


def trim_working_sets(pids: List[int]) -> Dict[str, int]:
    """对指定进程调 EmptyWorkingSet。`freed_bytes` 是工作集减少量，不是释放的物理内存（页多进了
    待机列表），界面不能说成「释放了 X GB 内存」，那是虚报。"""
    result = {"attempted": 0, "succeeded": 0, "freed_bytes": 0}
    if not IS_WINDOWS:
        return result
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    for pid in pids:
        result["attempted"] += 1
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, False, int(pid)
        )
        if not handle:
            continue
        try:
            before = _working_set(handle)
            try:
                ok = psapi.EmptyWorkingSet(handle)
            except (OSError, AttributeError):
                ok = False
            if ok:
                after = _working_set(handle)
                result["succeeded"] += 1
                result["freed_bytes"] += max(0, before - after)
        finally:
            kernel32.CloseHandle(handle)
    return result


def purge_standby_list() -> Dict[str, object]:
    """清空待机列表。需要管理员权限，通常不该用：仅适用于跑完吃满内存的任务（大型编译、视频导出）后
    缓存命中率变差的场景，日常点只会变慢。调用方必须在界面写清楚，且默认关闭。"""
    result: Dict[str, object] = {"ok": False, "error": "", "before": {}, "after": {}}
    if not IS_WINDOWS:
        result["error"] = "memory.windows_only"
        return result

    result["before"] = memory_status()
    try:
        ntdll = ctypes.windll.ntdll
        # SystemMemoryListInformation = 80；MemoryPurgeStandbyList = 4
        command = ctypes.c_int(4)
        status = ntdll.NtSetSystemInformation(80, ctypes.byref(command),
                                              ctypes.sizeof(command))
        if status != 0:
            # 0xC0000061 = STATUS_PRIVILEGE_NOT_HELD —— 没提权
            result["error"] = ("pcclean.memory.needsElevation"
                               if status in (0xC0000061, -1073741727)
                               else f"ntstatus.{status & 0xFFFFFFFF:08X}")
            return result
    except (OSError, AttributeError) as exc:
        result["error"] = f"pcclean.memory.apiUnavailable:{type(exc).__name__}"
        return result

    result["ok"] = True
    result["after"] = memory_status()
    return result
