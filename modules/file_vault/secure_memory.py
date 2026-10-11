# -*- coding: utf-8 -*-
"""尽量不让密钥材料落到磁盘上（尽力而为，失败不抛异常，只在返回值如实报告）。

CPython 做不到把密钥只留在锁定内存：`bytes` 不可变，切片/拼接/传 C 扩展都可能复制副本；
真正抹掉已解锁密钥靠换掉整个进程（见 electron/pythonBridge.ts 的 restartForLock）。
本模块能做到：
1. `SetProcessWorkingSetSizeEx` + `QUOTA_LIMITS_HARDWS_MIN_ENABLE` 硬钉工作集，防换出到页面文件。
2. 用 `SetErrorMode` 禁止崩溃转储（转储含主密钥快照）。
3. `SecretBuffer`：自己分配的缓冲区可抹干净并锁页（对已有 `bytes` 无效）。
非 Windows 平台退化为空操作并如实报告。
"""

from __future__ import annotations

import os
from typing import Dict, Optional

__all__ = ["harden_process", "SecretBuffer", "is_supported"]

# SetErrorMode 的两个位。合起来的效果是：严重错误不弹系统对话框、崩溃不弹
# "程序已停止工作"那个框，也就不会走到生成转储那一步。
_SEM_FAILCRITICALERRORS = 0x0001
_SEM_NOGPFAULTERRORBOX = 0x0002

# SetProcessWorkingSetSizeEx 的标志。HARDWS_MIN_ENABLE 才是关键那一位：
# 不带它的话最小工作集只是一个"建议"，系统内存紧张时照样把页面换出去。
_QUOTA_LIMITS_HARDWS_MIN_ENABLE = 0x00000001
_QUOTA_LIMITS_HARDWS_MAX_DISABLE = 0x00000008

# 要锁的最小工作集 64 MiB，与后端常驻集同量级；过大（超物理内存一定比例）会使
# SetProcessWorkingSetSizeEx 直接失败，导致一项都不生效。
_MIN_WORKING_SET_BYTES = 64 * 1024 * 1024
_MAX_WORKING_SET_BYTES = 512 * 1024 * 1024


def is_supported() -> bool:
    return os.name == "nt"


def harden_process() -> Dict[str, bool]:
    """尽力加固当前进程，返回各项是否生效：`no_swap`（工作集钉在物理内存）、`no_crash_dump`、
    `supported`（平台支持）。

    任一项为 False 不是错误（如缺 `SE_INC_WORKING_SET_NAME` 权限），如实报出供调用方记日志。
    """
    result = {"supported": is_supported(), "no_swap": False, "no_crash_dump": False}
    if not is_supported():
        return result
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        # --- 1. 崩溃不生成转储 ---
        try:
            kernel32.SetErrorMode(_SEM_FAILCRITICALERRORS | _SEM_NOGPFAULTERRORBOX)
            result["no_crash_dump"] = True
        except Exception:
            pass

        # --- 2. 工作集钉在物理内存里 ---
        try:
            kernel32.SetProcessWorkingSetSizeEx.argtypes = [
                wintypes.HANDLE,
                ctypes.c_size_t,
                ctypes.c_size_t,
                wintypes.DWORD,
            ]
            kernel32.SetProcessWorkingSetSizeEx.restype = wintypes.BOOL
            ok = kernel32.SetProcessWorkingSetSizeEx(
                kernel32.GetCurrentProcess(),
                ctypes.c_size_t(_MIN_WORKING_SET_BYTES),
                ctypes.c_size_t(_MAX_WORKING_SET_BYTES),
                _QUOTA_LIMITS_HARDWS_MIN_ENABLE | _QUOTA_LIMITS_HARDWS_MAX_DISABLE,
            )
            result["no_swap"] = bool(ok)
        except Exception:
            pass
    except Exception:
        # ctypes 都加载不了的极端情况。加固失败绝不能让后端起不来。
        pass
    return result


class SecretBuffer:
    """自己分配、页面锁定、用完抹零的可变缓冲区，用法 `with SecretBuffer(32) as buf`。

    只对全程由我们控制的字节有意义，不要拿来"保护"已有 `bytes`（原件仍在，只是多一份副本）。
    `locked` 报告页面是否真锁住；锁不住时仍可用，只是少了不被换出的保证。
    """

    def __init__(self, size: int):
        import ctypes

        if size <= 0:
            raise ValueError("size must be positive")
        self._ctypes = ctypes
        self._size = size
        self._buf = ctypes.create_string_buffer(size)
        self.locked = self._lock_pages()

    def _lock_pages(self) -> bool:
        if not is_supported():
            return False
        try:
            ctypes = self._ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.VirtualLock.argtypes = [wintypes.LPVOID, ctypes.c_size_t]
            kernel32.VirtualLock.restype = wintypes.BOOL
            return bool(kernel32.VirtualLock(
                ctypes.cast(self._require_live(), ctypes.c_void_p), ctypes.c_size_t(self._size)
            ))
        except Exception:
            return False

    def _require_live(self):
        # 抹掉之后再用是调用方的 bug。让它当场报一句说得清的话，别退化成
        # 一句 `NoneType has no attribute raw`——后者会把人引到 ctypes 上去查。
        if self._buf is None:
            raise RuntimeError("这块缓冲区已经抹掉了，不能再读写")
        return self._buf

    def write(self, data: bytes) -> None:
        buf = self._require_live()
        if len(data) > self._size:
            raise ValueError("data does not fit in this buffer")
        self._ctypes.memmove(buf, data, len(data))

    def read(self, length: Optional[int] = None) -> bytes:
        """取出内容。**这一步必然产生一份普通的 `bytes` 副本**，那份副本不受本
        缓冲区的任何保护。尽量晚调用、尽量少调用。"""
        buf = self._require_live()
        return buf.raw[: length if length is not None else self._size]

    def zeroize(self) -> None:
        """用 0 覆盖整块内存，并解锁页面。可以重复调用。"""
        if self._buf is None:
            return
        try:
            self._ctypes.memset(self._buf, 0, self._size)  # type: ignore[arg-type]
        except Exception:
            pass
        if self.locked:
            try:
                ctypes = self._ctypes
                from ctypes import wintypes

                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.VirtualUnlock.argtypes = [wintypes.LPVOID, ctypes.c_size_t]
                kernel32.VirtualUnlock(
                    ctypes.cast(self._buf, ctypes.c_void_p), ctypes.c_size_t(self._size)
                )
            except Exception:
                pass
            self.locked = False
        self._buf = None

    def __enter__(self) -> "SecretBuffer":
        return self

    def __exit__(self, *exc) -> None:
        self.zeroize()
