import io
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pytest
from modules.file_vault import fingerprint
from modules.file_vault.fingerprint import FingerprintUnavailableError


@pytest.fixture(autouse=True)
def _helper_exe_on_disk(tmp_path, monkeypatch):
    """让 `_verifier_exe()` 指向一个真实存在的占位文件。

    `request_verification_for_window` 先 `os.path.isfile(exe)`，而 `fingerprint_verify.exe` 是
    被 `.gitignore` 挡在仓库外的 C 编译产物：开发机有，CI 永远没有。不铺这层，CI 上这组用例在走到被测
    逻辑前就抛 `helper_not_found` 全部失败（其中两条期望的正是该错误码，会歪打正着地通过）。
    不 patch 全局 `os.path.isfile`（会波及 pytest 与其他库）；需要"文件不在"的用例自行 patch 覆盖。
    """
    fake_exe = tmp_path / "fingerprint_verify.exe"
    fake_exe.write_bytes(b"")
    monkeypatch.setattr(fingerprint, "_verifier_exe", lambda: str(fake_exe))
    yield


@pytest.fixture(autouse=True)
def _clean_module_state():
    """槽位、在途进程、取消标志都是模块级的，用例间必须清干净。

    `cancel_active_verification()` 会立起取消标志，`request_verification_for_window()` 启动前预检并
    返回 False；残留会让后面无关用例拿到"用户取消了"，极难排查。
    """
    fingerprint._clear_cancellation_request()
    fingerprint.release_verification_slot()
    fingerprint._set_active_process(None)
    yield
    fingerprint._clear_cancellation_request()
    fingerprint.release_verification_slot()
    fingerprint._set_active_process(None)


def test_generate_bio_secret_is_32_bytes_and_random():
    s1 = fingerprint.generate_bio_secret()
    s2 = fingerprint.generate_bio_secret()
    assert isinstance(s1, bytes)
    assert len(s1) == 32
    assert s1 != s2


def test_is_available_returns_a_bool_without_raising():
    # 不断言 True/False（取决于测试机的 Windows Hello 配置），只断言检查本身不抛异常且返回布尔值。
    result = fingerprint.is_available()
    assert isinstance(result, bool)


def test_request_verification_for_window_verified(monkeypatch):
    """When the C helper returns Verified stdout + exit 0, the function
    returns True."""
    monkeypatch.setattr("subprocess.Popen", _fake_popen_fn("Verified\n", "", 0))
    assert fingerprint.request_verification_for_window(0x1234) is True


def test_request_verification_for_window_canceled_via_stdout(monkeypatch):
    """Canceled in stdout + exit 1 → False (user dismissed the prompt)."""
    monkeypatch.setattr("subprocess.Popen", _fake_popen_fn("Canceled\n", "", 1))
    assert fingerprint.request_verification_for_window(0x1234) is False


def test_request_verification_for_window_canceled_via_stderr(monkeypatch):
    """Canceled in stderr + non-zero exit → False."""
    monkeypatch.setattr("subprocess.Popen", _fake_popen_fn("", "Canceled", 1))
    assert fingerprint.request_verification_for_window(0x1234) is False


def test_request_verification_for_window_helper_not_found(monkeypatch):
    """Missing exe (FileNotFoundError from subprocess) → FingerprintUnavailableError."""
    monkeypatch.setattr("subprocess.Popen", _raise_fn(FileNotFoundError("not found")))
    with pytest.raises(FingerprintUnavailableError, match="helper_not_found"):
        fingerprint.request_verification_for_window(0x1)


def test_request_verification_for_window_timeout_token_from_helper(monkeypatch):
    """辅助程序自己的截止时间到了会打印 `Error: verification_timeout` 并正常退出（非被我们杀）。
    要映射成 verification_timeout 而非落入"未知失败"：此时提示框已正常撤销，主窗口是好的。"""
    monkeypatch.setattr("subprocess.Popen", _fake_popen_fn("", "Error: verification_timeout", 2))
    with pytest.raises(FingerprintUnavailableError, match="verification_timeout"):
        fingerprint.request_verification_for_window(0x1)


def test_request_verification_for_window_kills_helper_that_overran_its_own_deadline(monkeypatch):
    """辅助程序连自己的截止时间都没兑现（wait 超时）则强杀并报 verification_timeout。这是仅剩的
    会强杀、也是唯一可能把主窗口留在禁用态的路径，所以断言 kill 被调用，别的路径绝不该。"""
    fake = _FakePopen("", "", 0, hang=True)
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: fake)
    with pytest.raises(FingerprintUnavailableError, match="verification_timeout"):
        fingerprint.request_verification_for_window(0x1)
    assert fake.killed is True


def test_request_verification_for_window_never_closes_stdin_before_the_helper_exits(monkeypatch):
    """对辅助程序来说 stdin 的 EOF 就是"取消"（见 fingerprint_verify.c 的 stdin 协议），所以退出前
    这一侧绝不能关管道；旧的 subprocess.run(input=...) 写完即关，会让验证框一弹出就被撤掉。"""
    fake = _FakePopen("Verified\n", "", 0)
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: fake)
    assert fingerprint.request_verification_for_window(0x1) is True
    assert fake.stdin.closed_before_exit is False


def test_request_verification_for_window_exe_missing_from_disk(monkeypatch):
    """The exe path exists but the file isn't actually there (os.path.isfile
    returns False) → FingerprintUnavailableError before even calling subprocess."""
    monkeypatch.setattr("os.path.isfile", lambda _p: False)
    with pytest.raises(FingerprintUnavailableError, match="helper_not_found"):
        fingerprint.request_verification_for_window(0x1)


def test_request_verification_for_window_system_error(mapped_error_key, monkeypatch):
    """Known error from the C helper stderr → wrapped as FingerprintUnavailableError
    with the corresponding i18n key."""
    monkeypatch.setattr("subprocess.Popen", _fake_popen_fn("", mapped_error_key, 2))
    with pytest.raises(FingerprintUnavailableError) as exc_info:
        fingerprint.request_verification_for_window(0x1)
    assert mapped_error_key in str(exc_info.value)


def test_request_verification_for_window_unmapped_failure_carries_detail(monkeypatch):
    """无法识别的 stderr/stdout 组合仍回落到 fingerprint.verification_failed，但必须把 C 辅助程序的
    原始输出作为 `detail` 带上，让界面能显示失败原因（见 errors.json 中 {{detail}} 插值）。"""
    monkeypatch.setattr("subprocess.Popen", _fake_popen_fn("", "Error: something_unexpected_from_windows", 2))
    with pytest.raises(FingerprintUnavailableError) as exc_info:
        fingerprint.request_verification_for_window(0x1)
    assert exc_info.value.code == "fingerprint.verification_failed"
    assert "something_unexpected_from_windows" in exc_info.value.params["detail"]


def test_request_verification_for_window_invocation_exception_carries_detail(monkeypatch):
    """启动 exe 时抛的通用异常（如 PermissionError）必须把消息作为 `detail` 带到
    fingerprint.verification_error，而不只是裸 i18n 码。"""
    monkeypatch.setattr("subprocess.Popen", _raise_fn(PermissionError("Access is denied")))
    with pytest.raises(FingerprintUnavailableError) as exc_info:
        fingerprint.request_verification_for_window(0x1)
    assert exc_info.value.code == "fingerprint.verification_error"
    assert "Access is denied" in exc_info.value.params["detail"]


def test_request_verification_for_window_passes_correct_args(monkeypatch):
    """HWND、提示语（走 stdin，避开 argv 的中文编码问题）和辅助程序自己的截止时间都要如实传下去；
    不传 --timeout-ms 则辅助程序用内置默认值，两侧预算就不一致。"""
    captured = []

    def capture(cmd, **kwargs):
        captured.append(cmd)
        return _FakePopen("Verified\n", "", 0)

    monkeypatch.setattr("subprocess.Popen", capture)
    fingerprint.request_verification_for_window(0xABCDEF, "Hello 世界")
    args = captured[0]
    assert "0xABCDEF" in args
    assert f"--timeout-ms={fingerprint.HELPER_DEADLINE_SECONDS * 1000}" in args


def test_request_verification_for_window_honours_a_shorter_deadline(monkeypatch):
    """登录页自动发起的那次要能传更短的预算：该参数控制的是应用窗口被系统禁用多久（验证框对窗口
    模态，期间界面点不动），所以必须真的传到辅助程序。"""
    captured = []

    def capture(cmd, **kwargs):
        captured.append(cmd)
        return _FakePopen("Verified\n", "", 0)

    monkeypatch.setattr("subprocess.Popen", capture)
    fingerprint.request_verification_for_window(0x1, timeout_seconds=25)
    assert "--timeout-ms=25000" in captured[0]


@pytest.mark.parametrize(
    "given,expected",
    [
        (None, fingerprint.HELPER_DEADLINE_SECONDS),
        ("垃圾", fingerprint.HELPER_DEADLINE_SECONDS),
        (0, 5),
        (-1, 5),
        (25, 25),
        (10**6, fingerprint.HELPER_DEADLINE_SECONDS),
    ],
)
def test_clamp_deadline_never_lets_the_caller_out_of_bounds(given, expected):
    """预算是渲染进程唯一能影响的数字，决定"窗口被禁用多久"，两个方向都要夹住：太大会锁窗口超过后端
    上限；0 或负数会让验证框刚弹出就被撤掉。看不懂的输入一律回落默认值，而非"不限时"。"""
    assert fingerprint.clamp_deadline(given) == expected


def test_request_verification_for_window_sends_the_message_over_stdin(monkeypatch):
    fake = _FakePopen("Verified\n", "", 0)
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: fake)
    fingerprint.request_verification_for_window(0x1, "Hello 世界")
    assert "Hello 世界" in fake.stdin.written.decode("utf-8")


# ── helpers ──────────────────────────────────────────────────────────

def _fake_popen_fn(stdout, stderr, returncode):
    def _fn(cmd, **kwargs):
        return _FakePopen(stdout, stderr, returncode)
    return _fn


def _raise_fn(exc):
    def _fn(cmd, **kwargs):
        raise exc
    return _fn


class _CompletedProcessFake:
    """`--modalities` 探测用。那条路径仍然是 subprocess.run：它是只读的、
    毫秒级的、也没有任何要取消的东西，不需要验证路径那一整套进程管理。"""

    def __init__(self, stdout: str, stderr: str, returncode: int):
        self.stdout = stdout.encode("utf-8")
        self.stderr = stderr.encode("utf-8")
        self.returncode = returncode


def _fake_run_fn(stdout, stderr, returncode):
    def _fn(cmd, **kwargs):
        return _CompletedProcessFake(stdout, stderr, returncode)
    return _fn


class _FakeStdin:
    """记录写入的字节，并记住它是在进程退出前还是后被关的（提前关 stdin 对辅助程序等于"取消"）。"""

    def __init__(self, owner):
        self._owner = owner
        self.written = b""
        self.closed = False
        self.closed_before_exit = False

    def write(self, data):
        self.written += data

    def flush(self):
        pass

    def close(self):
        if self._owner.returncode is None:
            self.closed_before_exit = True
        self.closed = True


class _FakePopen:
    def __init__(self, stdout: str, stderr: str, returncode: int, *, hang: bool = False):
        self.stdin = _FakeStdin(self)
        self.stdout = io.BytesIO(stdout.encode("utf-8"))
        self.stderr = io.BytesIO(stderr.encode("utf-8"))
        self._exit_code = returncode
        self._hang = hang
        self.returncode = None
        self.killed = False

    def wait(self, timeout=None):
        if self._hang:
            raise subprocess.TimeoutExpired(["fingerprint_verify.exe"], timeout or 0)
        self.returncode = self._exit_code
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def __repr__(self):
        return f"_FakePopen(rc={self.returncode}, killed={self.killed})"


# ── parametrized data for system error mapping ────────────────────────

ERROR_KEYS = [
    "fingerprint.device_not_present",
    "fingerprint.not_configured",
    "fingerprint.disabled_by_policy",
    "fingerprint.device_busy",
    "fingerprint.retries_exhausted",
    "fingerprint.helper_not_found",
    "fingerprint.verification_failed",
]


@pytest.fixture(params=ERROR_KEYS)
def mapped_error_key(request):
    return request.param


# ── single-flight lock tests ─────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_slot():
    """每条用例都从"槽位空着、没有在途进程"开始，结束时也还原。单飞槽位是模块级
    状态，一条用例漏放会让后面所有涉及它的用例莫名其妙地红。"""
    fingerprint.release_verification_slot()
    fingerprint._active_proc = None
    yield
    fingerprint.release_verification_slot()
    fingerprint._active_proc = None


def test_acquire_verification_slot_rejects_concurrent_second_attempt():
    assert fingerprint.acquire_verification_slot() is True
    try:
        assert fingerprint.acquire_verification_slot() is False
    finally:
        fingerprint.release_verification_slot()


def test_acquire_verification_slot_available_again_after_release():
    assert fingerprint.acquire_verification_slot() is True
    fingerprint.release_verification_slot()
    try:
        assert fingerprint.acquire_verification_slot() is True
    finally:
        fingerprint.release_verification_slot()


def test_release_verification_slot_is_idempotent():
    """重复释放或释放没持有的槽位必须静默无操作；裸 Lock.release() 会抛 RuntimeError，而调用点都在
    finally 里，会让出问题的流程连错误码都传不回去。"""
    fingerprint.release_verification_slot()
    fingerprint.acquire_verification_slot()
    fingerprint.release_verification_slot()
    fingerprint.release_verification_slot()  # 不该抛
    assert fingerprint.acquire_verification_slot() is True
    fingerprint.release_verification_slot()


def test_stale_verification_slot_is_reclaimed(monkeypatch):
    """持有超过阈值就强制回收。真实故障：槽位在 stdin 线程抢、在批处理线程放，任一没走到 finally 的
    路径都会让它永久锁住，之后每次"重新用 Windows Hello 解锁"都只拿到
    auth.fingerprint_verification_in_progress，只能重启应用。"""
    monkeypatch.setattr(fingerprint, "STALE_SLOT_SECONDS", 0.05)
    assert fingerprint.acquire_verification_slot() is True
    assert fingerprint.acquire_verification_slot() is False
    time.sleep(0.08)
    assert fingerprint.acquire_verification_slot() is True
    fingerprint.release_verification_slot()


# ── 取消在途验证 ──────────────────────────────────────────────────────

def test_cancel_active_verification_is_a_noop_when_nothing_is_running():
    """没有在途验证时返回 False。这**不是**错误——登录页的取消按钮在验证已经
    自己结束之后被点到是完全正常的。"""
    assert fingerprint.cancel_active_verification() is False


def test_cancel_before_the_helper_starts_is_not_lost():
    """用户报的 bug：`unlock_fingerprint 调用失败(...in_progress)`。

    槽位在派发线程抢，helper 要等批处理线程跑到 _drive_verifier 才启动；这段窗口里点"取消"找不到
    进程，那次已放弃的验证仍会弹框、禁用主窗口并占满预算，后续重试都拿 in_progress。
    现在取消会立标志，启动前预检到就直接收场。
    """
    assert fingerprint.acquire_verification_slot() is True
    # 还没有 helper 在跑：返回 False（确实没撤掉任何进程），但标志要立起来。
    assert fingerprint.cancel_active_verification() is False
    assert fingerprint.cancellation_requested() is True
    # 这一次绝不能弹出提示框。False = 用户取消，跟他在框上点取消是同一件事。
    assert fingerprint.request_verification_for_window(0) is False


def test_a_fresh_verification_is_not_killed_by_the_previous_cancel():
    """取消标志必须在下一次拿到槽位时清掉，否则"取消一次就再也验不了"：新验证被上次取消预检掉，
    且与用户自己点取消无法区分、不报错。"""
    fingerprint.request_cancellation()
    assert fingerprint.cancellation_requested() is True
    assert fingerprint.acquire_verification_slot() is True
    assert fingerprint.cancellation_requested() is False


def test_cancel_landing_between_popen_and_registration_still_takes_effect():
    """取消落在 Popen 与 _set_active_process 之间那几毫秒：注册时会把"已有人请求取消"回报给调用方，
    由它补撤一次，否则这次取消会丢，提示框照弹。"""
    fingerprint.request_cancellation()
    proc = _CancelAwarePopen()
    assert fingerprint._set_active_process(proc) is True
    assert fingerprint.cancel_active_verification() is True
    assert proc.stdin.written == b"CANCEL\n"


def test_cancel_active_verification_negotiates_over_stdin():
    """协商路径：写一行 CANCEL，辅助程序自己收场。这是把主窗口从禁用态救回来的唯一干净途径
    （凭据界面对主窗口模态，正常撤销系统才重新启用它），所以必须断言我们没有直接杀进程。"""
    proc = _CancelAwarePopen()
    fingerprint._set_active_process(proc)
    assert fingerprint.cancel_active_verification() is True
    assert proc.stdin.written == b"CANCEL\n"
    assert proc.killed is False


def test_cancel_active_verification_kills_a_helper_that_ignores_cancel(monkeypatch):
    """协商不成才动粗。慢，但仍然有界——用户点了取消就必须有个了断。"""
    monkeypatch.setattr(fingerprint, "CANCEL_GRACE_SECONDS", 0.1)
    proc = _FakePopen("", "", 0, hang=True)
    fingerprint._set_active_process(proc)
    assert fingerprint.cancel_active_verification() is True
    assert proc.killed is True


class _CancelAwarePopen(_FakePopen):
    """收到 CANCEL 之后就"退出"的假进程。"""

    def __init__(self):
        super().__init__("Canceled\n", "", 1)

    def poll(self):
        if self.returncode is None and self.stdin.written == b"CANCEL\n":
            self.returncode = 1
        return self.returncode


# 模态优先级链：「有人脸先人脸，否则指纹，依次往下」。链条是纯逻辑，探测结果用 monkeypatch 灌入，
# 不能以真机传感器为断言依据，否则换机器就红。


@pytest.fixture(autouse=True)
def _clear_modality_cache():
    """每条用例都从空缓存开始。available_modalities 的进程内缓存是有意为之
    （登录页每次挂载都要问），但会让用例之间互相污染。"""
    fingerprint._modalities_cache = None
    fingerprint._availability_cache = None
    yield
    fingerprint._modalities_cache = None
    fingerprint._availability_cache = None


def _probe_returning(text):
    """假装 C 辅助程序输出了 text。也顺便盖住 os.path.isfile——测试环境里
    exe 可能根本没编译出来。"""

    def _apply(monkeypatch):
        monkeypatch.setattr("os.path.isfile", lambda _p: True)
        monkeypatch.setattr("subprocess.run", _fake_run_fn(text, "", 0))

    return _apply


def test_available_modalities_parses_the_probe_output(monkeypatch):
    _probe_returning("face=1\nfingerprint=1\niris=0\n")(monkeypatch)
    assert fingerprint.available_modalities() == {
        "face": True,
        "fingerprint": True,
        "iris": False,
    }


def test_available_modalities_never_raises_when_the_probe_blows_up(monkeypatch):
    monkeypatch.setattr("os.path.isfile", lambda _p: True)
    monkeypatch.setattr("subprocess.run", _raise_fn(OSError("boom")))
    # 探测失败必须表现成"什么都没有"而不是异常：登录页在任何情况下都得渲染
    # 得出来，探不到最多是少一个便捷入口，不能变成进不去。
    assert fingerprint.available_modalities() == {
        "face": False,
        "fingerprint": False,
        "iris": False,
    }


def test_available_modalities_ignores_junk_lines(monkeypatch):
    _probe_returning("face=1\nnonsense\nsomething=1\nfingerprint=yes\niris=1\n")(monkeypatch)
    result = fingerprint.available_modalities()
    assert result["face"] is True
    assert result["iris"] is True
    # 只有恰好是 "1" 才算有；"yes" 不是协议的一部分，当作没有而不是猜。
    assert result["fingerprint"] is False
    assert set(result) == {"face", "fingerprint", "iris"}


def test_chain_puts_face_before_fingerprint_before_iris(monkeypatch):
    _probe_returning("face=1\nfingerprint=1\niris=1\n")(monkeypatch)
    monkeypatch.setattr(fingerprint, "is_available", lambda: True)
    assert fingerprint.preferred_chain() == ["face", "fingerprint", "iris"]
    assert fingerprint.preferred_modality() == "face"


def test_chain_falls_through_to_fingerprint_when_there_is_no_camera(monkeypatch):
    _probe_returning("face=0\nfingerprint=1\niris=0\n")(monkeypatch)
    monkeypatch.setattr(fingerprint, "is_available", lambda: True)
    assert fingerprint.preferred_chain() == ["fingerprint"]
    assert fingerprint.preferred_modality() == "fingerprint"


def test_hello_not_configured_empties_the_chain_even_with_hardware(monkeypatch):
    """有传感器但这台机器的 Windows Hello 没配好，等于用不了。界面必须直接
    落到密码，而不是先弹一个注定失败的系统框。"""
    _probe_returning("face=1\nfingerprint=1\niris=1\n")(monkeypatch)
    monkeypatch.setattr(fingerprint, "is_available", lambda: False)
    assert fingerprint.preferred_chain() == []
    assert fingerprint.preferred_modality() is None


def test_modalities_are_cached_until_asked_to_refresh(monkeypatch):
    calls = []

    def _counting_run(cmd, **kwargs):
        calls.append(cmd)
        return _fake_result("face=0\nfingerprint=1\niris=0\n", "", 0)

    monkeypatch.setattr("os.path.isfile", lambda _p: True)
    monkeypatch.setattr("subprocess.run", _counting_run)

    fingerprint.available_modalities()
    fingerprint.available_modalities()
    assert len(calls) == 1, "缓存没生效，登录页每次挂载都会白拉一个子进程"

    fingerprint.available_modalities(refresh=True)
    assert len(calls) == 2
