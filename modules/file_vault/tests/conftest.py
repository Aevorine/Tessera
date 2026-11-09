"""测试会话前后清掉一次性 keyring 命名空间（ideal1-file-vault-test-*）。

BackendClient.close() 会逐项删，但测试被中断或强杀时走不到那里，残留会在凭据管理器里越积越多。
只匹配带 -test- 的目标名，真实的 ideal1-file-vault 条目不受影响。
"""
import ctypes
import sys

import pytest



def sweep_test_credentials() -> int:
    if sys.platform != "win32":
        return 0
    from ctypes import wintypes

    class CREDENTIALW(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD), ("CredentialBlob", ctypes.c_void_p),
            ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
        ]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    count = wintypes.DWORD()
    creds = ctypes.POINTER(ctypes.POINTER(CREDENTIALW))()
    # 过滤串只支持结尾 *，目标名可能带 "user@" 前缀，故全量枚举后自己匹配
    if not advapi.CredEnumerateW(None, 0, ctypes.byref(count), ctypes.byref(creds)):
        return 0  # ERROR_NOT_FOUND：没有残留
    try:
        targets = [(creds[i].contents.TargetName, creds[i].contents.Type) for i in range(count.value)]
    finally:
        advapi.CredFree(creds)
    deleted = 0
    for name, ctype in targets:
        if "ideal1-file-vault-test-" in name and advapi.CredDeleteW(name, ctype, 0):
            deleted += 1
    return deleted


@pytest.fixture(scope="session", autouse=True)
def _sweep_test_keyring():
    sweep_test_credentials()
    yield
    sweep_test_credentials()
