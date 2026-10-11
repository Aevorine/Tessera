"""生物识别探测的进程内缓存与启动预热：登录页要毫秒级拿到 biometric_status，预热后不再走 WinRT、
不拉 helper、不排批处理队列。"""

import pytest

from modules.file_vault import backend_server, batch_engine, fingerprint


@pytest.fixture(autouse=True)
def _cold_caches():
    fingerprint._availability_cache = None
    fingerprint._modalities_cache = None
    yield
    fingerprint._availability_cache = None
    fingerprint._modalities_cache = None


def _count_checks(monkeypatch, value=True):
    calls = []

    def fake():
        calls.append(1)
        return value

    monkeypatch.setattr(fingerprint, "_check_availability", fake)
    return calls


def test_availability_is_checked_once_per_process(monkeypatch):
    calls = _count_checks(monkeypatch)
    assert fingerprint.is_available() is True
    assert fingerprint.is_available() is True
    assert len(calls) == 1


def test_refresh_bypasses_the_availability_cache(monkeypatch):
    calls = _count_checks(monkeypatch)
    fingerprint.is_available()
    fingerprint.is_available(refresh=True)
    assert len(calls) == 2


def test_prewarm_fills_both_caches(monkeypatch):
    _count_checks(monkeypatch)
    monkeypatch.setattr(fingerprint, "_verifier_exe", lambda: "Z:\\definitely-missing.exe")
    assert not fingerprint.status_is_warm()
    fingerprint.prewarm()
    assert fingerprint.status_is_warm()


def test_prewarm_never_raises(monkeypatch):
    def boom():
        raise RuntimeError("winrt exploded")

    monkeypatch.setattr(fingerprint, "_check_availability", boom)
    fingerprint.prewarm()


def test_biometric_status_answers_inline_once_warm(monkeypatch):
    _count_checks(monkeypatch)
    fingerprint.is_available()
    fingerprint._modalities_cache = {"face": False, "fingerprint": True, "iris": False}
    monkeypatch.setattr(backend_server, "_store", None)

    result = backend_server.rpc_biometric_status({}, request_id=7)

    assert result is not batch_engine.ASYNC_DEFERRED
    assert result["ok"] is True
    assert result["chain"] == ["fingerprint"]
    assert result["bound"] is False


def test_biometric_status_goes_to_the_batch_thread_while_cold(monkeypatch):
    submitted = []
    monkeypatch.setattr(
        batch_engine,
        "submit_batch_task",
        lambda request_id, fn, write, priority=None: submitted.append(request_id) or batch_engine.ASYNC_DEFERRED,
    )
    result = backend_server.rpc_biometric_status({}, request_id=9)
    assert result is batch_engine.ASYNC_DEFERRED
    assert submitted == [9]
