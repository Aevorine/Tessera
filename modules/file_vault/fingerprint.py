"""Windows Hello fingerprint unlock. SLOT_FINGERPRINT keeps its slot name, but the secret behind
it is now a random value gated by a real Hello prompt, so each unlock needs a sensor touch.

Paths (all block the calling thread; backend_server.py runs them on a batch thread):
1. request_verification_for_window(hwnd, message): native helper fingerprint_verify.exe, prompt on top of that window.
2. request_verification(message): winrt UserConsentVerifier fallback; prompt may appear behind the app.
3. preferred_chain(): non-blocking; lists biometric hardware via the helper (--modalities), ordered
   face > fingerprint > iris (see BIOMETRIC_PRIORITY for why it cannot pick the prompt's modality).

The helper is never killed on timeout: the window-aware prompt is modal to the caller's HWND, and
killing the helper leaves that window disabled forever. The helper owns the deadline
(HELPER_DEADLINE_SECONDS via --timeout-ms) and this module keeps stdin OPEN (closing it = cancel),
killing only after cooperative cancel fails. cancel_active_verification() is exposed as RPC for a real cancel button.
"""

import asyncio
import os
import secrets
import subprocess
import threading
import time

from core.logging import get_logger
from modules.file_vault.errors import VaultError

logger = get_logger(__name__)

# 三层超时预算必须严格递增，只有最内层先到点，错误码才指向真正原因：
#   helper 自己 90 s（自行 Cancel 并退出，窗口必被恢复）
#   本模块 proc.wait() 95 s（仅 helper 没兑现自己的截止时才动粗）
#   pythonBridge.ts 180 s（见 SILENT_TIMEOUT_OVERRIDES）
HELPER_DEADLINE_SECONDS = 90
HELPER_KILL_GRACE_SECONDS = 5

# 登录页挂载时自动发起的那次用更短预算。凭据界面对 hwnd 模态，验证期间整个应用窗口被禁用；
# 自动发起意味着每次打开都锁住登录页，提示框没浮到前面（多显示器、远程桌面）时用户完全点不动。
# 25 秒足够正常操作，之后自动落到密码。
AUTO_ATTEMPT_DEADLINE_SECONDS = 25
# 发出 CANCEL 之后等它自己收尾多久。helper 那边的宽限期是 2 秒，这里多给一点
# 余量覆盖进程调度和管道往返。
CANCEL_GRACE_SECONDS = 4.0

# 仅 Windows 存在的 CREATE_NO_WINDOW（0x08000000）。用字典 ** 展开而非直传 creationflags，
# 因为测试要能在 Linux 上跑，非 Windows 的 subprocess 传它会 TypeError。
_NO_WINDOW_KWARGS = (
    {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    if os.name == "nt"
    else {}
)


class FingerprintUnavailableError(VaultError):
    """Windows Hello is unusable here, or the call failed for a system-level reason (not user cancel/failure)."""


_slot_lock = threading.Lock()
_slot_held_since: "float | None" = None

# 超过此时长未释放就认定持有者已死，强制回收。锁在 stdin 线程抢、批处理线程放，
# 任何没走到 finally 的路径都会让它永久锁定，之后只能拿到
# auth.fingerprint_verification_in_progress 且只有重启能消除，故必须自愈。
# 阈值 = helper 截止 + 杀进程宽限 + 10 秒，正常流程绝不会撞上。
STALE_SLOT_SECONDS = HELPER_DEADLINE_SECONDS + HELPER_KILL_GRACE_SECONDS + 10


def acquire_verification_slot() -> bool:
    """非阻塞：True 表示可发起一次真实验证，False 表示已有验证在途。Windows Hello 与 winrt 回退路径
    （COM/STA）不能并发两次验证，所以不排队。调用方仍须在 finally 里 release_verification_slot()，自愈只是兜底。"""
    global _slot_held_since
    with _slot_lock:
        if _slot_held_since is not None:
            age = time.monotonic() - _slot_held_since
            if age < STALE_SLOT_SECONDS:
                return False
            logger.warning(
                "Reclaiming a stale fingerprint verification slot held for %.1fs", age
            )
        _slot_held_since = time.monotonic()
    # 新的一次验证从干净状态开始：上一次留下的取消请求不能把它也一起毙掉。
    # 放在 _slot_lock 之外，避免 _slot_lock -> _active_lock 的嵌套持有。
    _clear_cancellation_request()
    return True


def release_verification_slot() -> None:
    """释放槽位，幂等：重复调用或自愈回收后再调都静默无操作。调用点都在 finally 里，收尾抛异常会让错误码传不出去。"""
    global _slot_held_since
    with _slot_lock:
        _slot_held_since = None


def verification_in_progress() -> bool:
    """槽位当前是否被（未过期地）持有。诊断与测试用。"""
    with _slot_lock:
        return _slot_held_since is not None and (
            time.monotonic() - _slot_held_since < STALE_SLOT_SECONDS
        )


# 在途的 helper 子进程。cancel_active_verification() 靠它找到该向谁发 CANCEL。
_active_lock = threading.Lock()
_active_proc: "subprocess.Popen | None" = None

# 「取消已到但验证还没真正开始」。槽位在派发线程抢（rpc_unlock_fingerprint），helper 要等批处理线程
# 跑到 _drive_verifier 才启动，窗口内用户取消时 cancel_active_verification() 找不到进程而落空，
# 被放弃的验证随后照样弹框并占满预算。用标志盖住这段：启动前预检，注册时再对账。
_cancel_requested = False


def request_cancellation() -> None:
    """记下"这次验证已经不需要了"。对还没启动的验证有效——这正是
    cancel_active_verification() 覆盖不到的那段窗口。"""
    global _cancel_requested
    with _active_lock:
        _cancel_requested = True


def cancellation_requested() -> bool:
    """启动 helper 之前的预检。True 就别弹那个提示框了。"""
    with _active_lock:
        return _cancel_requested


def _clear_cancellation_request() -> None:
    global _cancel_requested
    with _active_lock:
        _cancel_requested = False


def _set_active_process(proc) -> bool:
    """注册在途 helper。返回 True 表示注册前已有人请求取消（落在 Popen 与注册之间），调用方必须立刻收场，否则取消丢失。"""
    global _active_proc
    with _active_lock:
        _active_proc = proc
        return _cancel_requested


def _clear_active_process(proc) -> None:
    global _active_proc
    with _active_lock:
        if _active_proc is proc:
            _active_proc = None


def cancel_active_verification() -> bool:
    """请求撤销进行中的验证；返回 True 表示确实撤掉了一个在途进程。

    先协商：往 helper stdin 写 CANCEL 让它调 IAsyncInfo::Cancel，这是把主窗口从禁用态救回的唯一干净途径。
    CANCEL_GRACE_SECONDS 内无结果才杀进程，窗口可能仍被禁用，由 Electron 侧 win.setEnabled(true) 兜底（main.ts vault:call 的 finally）。
    返回值只表示是否撤掉在途进程，调用方据此决定是否放槽位；放掉仍在弹框的验证的槽位会导致并发弹出。
    尚未启动的情形由 request_cancellation() 的标志负责。
    """
    # 先立标志：即使下面找不到进程（验证还没启动），这次取消也不会丢。
    request_cancellation()
    with _active_lock:
        proc = _active_proc
    if proc is None or proc.poll() is not None:
        return False

    try:
        if proc.stdin is not None and not proc.stdin.closed:
            proc.stdin.write(b"CANCEL\n")
            proc.stdin.flush()
    except (OSError, ValueError):
        pass  # 管道已经没了；下面的轮询会看到进程也没了

    # 用轮询而不是 proc.wait()：验证线程自己也在 wait 同一个 Popen，
    # 两个线程同时 wait 同一个对象没必要冒这个险。
    deadline = time.monotonic() + CANCEL_GRACE_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return True
        time.sleep(0.05)

    logger.warning("fingerprint_verify.exe ignored CANCEL; killing it")
    try:
        proc.kill()
    except OSError:
        pass
    return True


def _verifier_exe() -> str:
    """Absolute path to the compiled fingerprint_verify.exe helper."""
    return os.path.join(os.path.dirname(__file__), "c", "fingerprint_verify.exe")


_availability_cache: "bool | None" = None
_availability_lock = threading.Lock()


def is_available(*, refresh: bool = False) -> bool:
    """True if Windows Hello is configured and usable. Never raises; failure to check counts as unavailable.

    进程内缓存：登录页每次挂载都问，WinRT 往返加首次 import 要几十到几百毫秒，在弹框关键路径上。配置变了用 refresh=True。"""
    global _availability_cache
    if _availability_cache is not None and not refresh:
        return _availability_cache
    with _availability_lock:
        if _availability_cache is not None and not refresh:
            return _availability_cache
        _availability_cache = _check_availability()
        return _availability_cache


def _check_availability() -> bool:
    try:
        from winrt.windows.security.credentials.ui import (
            UserConsentVerifier,
            UserConsentVerifierAvailability,
        )
    except ImportError:
        return False

    async def _check():
        return await UserConsentVerifier.check_availability_async()

    try:
        availability = asyncio.run(_check())
    except Exception:
        logger.warning("Failed to check Windows Hello availability", exc_info=True)
        return False
    return availability == UserConsentVerifierAvailability.AVAILABLE


def status_is_warm() -> bool:
    """两项探测都已经有缓存结果，biometric_status 可以不排队直接回答。"""
    return _availability_cache is not None and _modalities_cache is not None


def prewarm() -> None:
    """后端一启动就在后台预做两项探测，把 100~400 ms 的 WinRT import + 可用性检查 + helper 枚举藏进后端冷启动期。永不抛异常。"""
    try:
        is_available()
        available_modalities()
    except Exception:
        logger.warning("biometric prewarm failed", exc_info=True)


def generate_bio_secret() -> bytes:
    """A fresh random secret to store in keyring at setup/rebind time,
    HKDF'd exactly like the TOTP/email factors' secrets."""
    return secrets.token_bytes(32)


# 生物识别模态优先级链。Windows Hello 的 UserConsentVerifier 不接受「用哪个模态」参数，
# 由系统按用户注册情况决定，应用不能也不该干预（能指定就能把用户引向最弱模态）。
# 这条链只决定应用层三件事：界面显示哪个图标和文案；自动发起哪个因子；某层不可用时的降级顺序
# （人脸→指纹→虹膜→通用 Hello→密码）。硬件清单来自 WinBio（helper --modalities），Hello 是否配置来自 UserConsentVerifier，两者都为真才算可用。
BIOMETRIC_PRIORITY = ("face", "fingerprint", "iris")

_modalities_cache: "dict[str, bool] | None" = None
_modalities_lock = threading.Lock()


def available_modalities(*, refresh: bool = False) -> "dict[str, bool]":
    """本机存在的生物识别硬件，永不抛异常，探测不出当作没有。进程内缓存，避免登录页每次挂载都拉子进程；插拔可用 refresh=True。"""
    global _modalities_cache
    if _modalities_cache is not None and not refresh:
        return dict(_modalities_cache)

    with _modalities_lock:
        # 双重检查：等锁期间可能已经有人填好了。
        if _modalities_cache is not None and not refresh:
            return dict(_modalities_cache)

        found = {name: False for name in BIOMETRIC_PRIORITY}
        exe = _verifier_exe()
        if os.path.isfile(exe):
            try:
                proc = subprocess.run(
                    [exe, "--modalities"],
                    capture_output=True,
                    timeout=10,
                    **_NO_WINDOW_KWARGS,
                )
                for line in proc.stdout.decode("utf-8", errors="replace").splitlines():
                    key, sep, value = line.strip().partition("=")
                    if sep and key in found:
                        found[key] = value.strip() == "1"
            except Exception:
                logger.warning("Biometric modality probe failed", exc_info=True)

        _modalities_cache = found
        return dict(found)


def preferred_chain(*, refresh: bool = False) -> "list[str]":
    """本机可用的生物识别方式，按 人脸 → 指纹 → 虹膜 排序。空列表表示无硬件或 Hello 未配置，界面都应落到密码。"""
    if not (is_available(refresh=True) if refresh else is_available()):
        return []
    modalities = available_modalities(refresh=refresh)
    return [name for name in BIOMETRIC_PRIORITY if modalities.get(name)]


def preferred_modality(*, refresh: bool = False) -> "str | None":
    """链条最顶上那个，没有则 None。不造 'hello' 兜底档：chain 为空时都该回落密码，造了只会显示按不出结果的按钮。"""
    chain = preferred_chain(refresh=refresh)
    return chain[0] if chain else None


def _pipe_reader(stream, sink: list) -> threading.Thread:
    """在独立线程把管道读干净放进 sink；否则管道缓冲写满会让 helper 阻塞在写、我们阻塞在 wait，死锁并卡死登录页。"""

    def _run():
        try:
            sink.append(stream.read() or b"")
        except (OSError, ValueError):
            pass

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _drive_verifier(proc, message_bytes: bytes, deadline_seconds: int) -> "tuple[int | None, str, str]":
    """喂进提示语、等 helper 自己收场、回收输出。全程不关 stdin：对 helper 而言 EOF 就是取消信号（见 C 源文件头部 stdin 协议）。"""
    if _set_active_process(proc):
        # 取消请求落在 Popen 和这次注册之间。现在进程有了，补撤一次——否则用户
        # 已经点过取消，提示框却照弹不误。
        cancel_active_verification()
    out_chunks: list = []
    err_chunks: list = []
    readers = [_pipe_reader(proc.stdout, out_chunks), _pipe_reader(proc.stderr, err_chunks)]
    try:
        try:
            proc.stdin.write(message_bytes + b"\n")
            proc.stdin.flush()
        except (OSError, ValueError):
            # helper 已经没了。不在这里报错——下面拿到 returncode 和 stderr
            # 之后再判，那样错误信息里还带着它临死前说了什么。
            pass

        try:
            proc.wait(timeout=deadline_seconds + HELPER_KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            # helper 连自己的截止都没兑现，只能强杀；这会让主窗口留在禁用态，故 Electron 侧有 win.setEnabled(true) 兜底。
            logger.warning("fingerprint_verify.exe overran its own deadline; killing it")
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            raise FingerprintUnavailableError("fingerprint.verification_timeout")
    finally:
        _clear_active_process(proc)
        for t in readers:
            t.join(timeout=2)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except (OSError, ValueError):
                pass

    stdout = b"".join(out_chunks).decode("utf-8", errors="replace").strip()
    stderr = b"".join(err_chunks).decode("utf-8", errors="replace").strip()
    return proc.returncode, stdout, stderr


def clamp_deadline(seconds) -> int:
    """把调用方（最终来自渲染进程）给的预算夹进合法区间。没给或看不懂就用默认值，不是不限时。
    它决定窗口被系统禁用多久，所以拒绝 0/负数（提示框刚弹就撤）和超过 helper 上限的值。"""
    try:
        value = int(seconds)
    except (TypeError, ValueError):
        return HELPER_DEADLINE_SECONDS
    return max(5, min(HELPER_DEADLINE_SECONDS, value))


def request_verification_for_window(
    hwnd: int,
    message: str = "请验证指纹以解锁 Tessera",
    timeout_seconds: "int | None" = None,
) -> bool:
    """Like request_verification(), but with a parent hwnd so the Hello dialog is on top; uses fingerprint_verify.exe.

    Returns True only on successful verification, False if cancelled/denied. Raises FingerprintUnavailableError for system-level problems."""

    # 预检：用户在验证真正启动前就撤了。槽位在派发线程抢、helper 在批处理线程启动，取消易落在其间；
    # 不检查则被放弃的验证照样弹框、禁用主窗口并占满预算。回报 False，等同用户点了取消。
    if cancellation_requested():
        return False

    exe = _verifier_exe()
    if not os.path.isfile(exe):
        raise FingerprintUnavailableError("fingerprint.helper_not_found")

    message_bytes = message.encode("utf-8", errors="replace")
    # Cap at ~2000 bytes to fit the C stdin buffer (2048); the actual
    # Windows Hello dialog has a 255-char limit anyway.
    if len(message_bytes) > 2000:
        message_bytes = message_bytes[:2000]

    deadline = clamp_deadline(HELPER_DEADLINE_SECONDS if timeout_seconds is None else timeout_seconds)
    argv = [
        exe,
        "0x{:X}".format(hwnd if hwnd >= 0 else (hwnd & 0xFFFFFFFFFFFFFFFF)),
        "--timeout-ms={}".format(int(deadline * 1000)),
    ]
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # 兜住「控制台黑框」。根因是 fingerprint_verify.c 缺 -mwindows 被链成控制台程序（已修），
            # 但用户机器上可能有已打进安装包的旧 CUI exe（构建脚本按 mtime 决定是否重编），
            # CREATE_NO_WINDOW 让父进程一侧也不给窗口，与 exe 子系统无关。
            **_NO_WINDOW_KWARGS,
        )
    except FileNotFoundError:
        raise FingerprintUnavailableError("fingerprint.helper_not_found")
    except Exception as exc:
        logger.warning("fingerprint_verify.exe invocation failed", exc_info=True)
        raise FingerprintUnavailableError("fingerprint.verification_error", detail=str(exc)) from exc

    returncode, stdout, stderr = _drive_verifier(proc, message_bytes, deadline)

    if returncode == 0 and "Verified" in stdout:
        return True

    if "Canceled" in stdout or "Canceled" in stderr or returncode == 1:
        return False

    # Map known error patterns from the C helper's stderr (or from
    # the fallback winrt path's error codes) to i18n keys.
    combined = stderr + "\n" + stdout
    lowered = combined.lower()
    # 必须排在其它模式之前：这条是 helper 自己的截止时间到了，它已经
    # Cancel + 正常退出，窗口是好的。跟"传感器忙"之类系统级故障是两回事。
    if "verification_timeout" in lowered:
        raise FingerprintUnavailableError("fingerprint.verification_timeout")
    if "device_not_present" in lowered or "device not present" in lowered:
        raise FingerprintUnavailableError("fingerprint.device_not_present")
    if "not_configured" in lowered or "not configured" in lowered:
        raise FingerprintUnavailableError("fingerprint.not_configured")
    if "disabled_by_policy" in lowered or "disabled by policy" in lowered:
        raise FingerprintUnavailableError("fingerprint.disabled_by_policy")
    if "device_busy" in lowered or "device busy" in lowered:
        raise FingerprintUnavailableError("fingerprint.device_busy")
    if "retries_exhausted" in lowered or "retries exhausted" in lowered:
        raise FingerprintUnavailableError("fingerprint.retries_exhausted")
    if "not_found" in lowered:
        raise FingerprintUnavailableError("fingerprint.helper_not_found")

    # 没命中任何已知模式：只写日志会让用户只看到「指纹验证失败」。带上 detail，让 UnlockTabs.tsx /
    # SettingsScreen.tsx 的 translateError(error, error_params) 把原始 stdout/stderr 拼进提示（同 email.send_failed）。
    logger.warning("fingerprint_verify.exe unknown failure: rc=%s stdout=%r stderr=%r",
                   returncode, stdout, stderr)
    detail = combined.strip() or f"exit code {returncode}"
    raise FingerprintUnavailableError("fingerprint.verification_failed", detail=detail)


def request_verification(
    message: str = "请验证指纹以解锁 Tessera",
    timeout_seconds: "int | None" = None,
) -> bool:
    """Blocks on the native Windows Hello prompt. Returns True on success, False if the user simply cancelled
    (like a wrong password). Raises FingerprintUnavailableError only for system-level problems; callers show a distinct message.

    Prefer request_verification_for_window(hwnd, message): this fallback has no parent window and the dialog may appear behind the app."""
    try:
        from winrt.windows.security.credentials.ui import (
            UserConsentVerificationResult,
            UserConsentVerifier,
        )
    except ImportError as exc:
        raise FingerprintUnavailableError("fingerprint.component_not_installed") from exc

    async def _verify():
        return await UserConsentVerifier.request_verification_async(message)

    # 这条路以前没有超时：UserConsentVerifier 一直等用户操作，而这条路径正是「无父窗口、框可能在后面」，
    # 看不见的框永远等不到操作，槽位永不释放。asyncio.run 无法从外部打断，故放到 daemon 线程上按截止时间放弃等待；
    # 线程会挂到系统对话框有结果或进程退出，但不持锁，且槽位有 STALE_SLOT_SECONDS 自愈。
    box: dict = {}

    def _run():
        try:
            box["value"] = asyncio.run(_verify())
        except BaseException as exc:  # noqa: BLE001 - 原样转交给调用线程
            box["error"] = exc

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()
    worker.join(clamp_deadline(HELPER_DEADLINE_SECONDS if timeout_seconds is None else timeout_seconds))
    if worker.is_alive():
        raise FingerprintUnavailableError("fingerprint.verification_timeout")
    if "error" in box:
        logger.warning("Windows Hello verification call failed", exc_info=box["error"])
        raise FingerprintUnavailableError("fingerprint.verification_error") from box["error"]
    result = box["value"]

    if result == UserConsentVerificationResult.VERIFIED:
        return True
    if result == UserConsentVerificationResult.CANCELED:
        return False

    codes = {
        UserConsentVerificationResult.DEVICE_NOT_PRESENT: "fingerprint.device_not_present",
        UserConsentVerificationResult.NOT_CONFIGURED_FOR_USER: "fingerprint.not_configured",
        UserConsentVerificationResult.DISABLED_BY_POLICY: "fingerprint.disabled_by_policy",
        UserConsentVerificationResult.DEVICE_BUSY: "fingerprint.device_busy",
        UserConsentVerificationResult.RETRIES_EXHAUSTED: "fingerprint.retries_exhausted",
    }
    if result in codes:
        raise FingerprintUnavailableError(codes[result])
    # 同上面 C helper 分支的理由——不认识的 result 值同样带上 detail，而不是
    # 只报一句通用的"验证失败"。
    raise FingerprintUnavailableError("fingerprint.verification_failed", detail=f"result={result!r}")
