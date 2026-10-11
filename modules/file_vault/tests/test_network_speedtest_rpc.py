"""backend_server.py 测速 RPC 层的进程内测试：直接设 backend_server._data_dir/_imk 并像普通函数
一样调用 rpc_*，事后还原全局。刻意不用子进程 `client` fixture：未 mock 的 network_speedtest_run
会真的发出 HTTPS 请求，使测试慢且受网络影响；进程内 monkeypatch speedtest_service 仍能覆盖真实
RPC/存储接线。"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import backend_server  # noqa: E402
from modules.file_vault.network_speedtest import service as speedtest_service  # noqa: E402


@pytest.fixture
def unlocked_backend(tmp_path):
    original_data_dir = getattr(backend_server, "_data_dir", None)
    original_imk = getattr(backend_server, "_imk", None)
    original_history_service = backend_server._network_speedtest_history_service
    backend_server._data_dir = tmp_path
    backend_server._imk = b"x" * 32
    backend_server._network_speedtest_history_service = None
    try:
        yield tmp_path
    finally:
        backend_server._data_dir = original_data_dir
        backend_server._imk = original_imk
        backend_server._network_speedtest_history_service = original_history_service


def _fake_result(**overrides):
    fields = dict(
        ping_ms=20.0,
        jitter_ms=1.0,
        loss_ratio=0.0,
        dns_ms=5.0,
        download_mbps=100.0,
        upload_mbps=20.0,
        node_label=speedtest_service.NODE_LABEL,
        ipv4="1.2.3.4",
        ipv6=None,
    )
    fields.update(overrides)
    return speedtest_service.SpeedTestResult(**fields)


def test_run_records_history_when_unlocked(unlocked_backend, monkeypatch):
    monkeypatch.setattr(speedtest_service, "run_speed_test", lambda connection_mode=None, on_phase=None: _fake_result())

    result = backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=1)

    assert result["ok"] is True
    assert result["history_id"] is not None
    assert result["dns_ms"] == 5.0
    assert result["anomaly"] is None  # 首次测速没有历史基线可比

    history = backend_server.rpc_network_speedtest_history_list({})
    assert history["ok"] is True
    assert len(history["results"]) == 1
    assert history["results"][0]["download_mbps"] == 100.0


def test_run_skips_history_recording_when_vault_not_unlocked(unlocked_backend, monkeypatch):
    monkeypatch.setattr(speedtest_service, "run_speed_test", lambda connection_mode=None, on_phase=None: _fake_result())
    backend_server._imk = None  # 覆盖 fixture 的解锁状态，模拟未解锁

    result = backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=1)

    assert result["ok"] is True  # 测速本身不要求解锁，照常返回结果
    assert result["history_id"] is None
    assert result["anomaly"] is None


def test_run_reports_anomaly_when_result_far_below_baseline(unlocked_backend, monkeypatch):
    monkeypatch.setattr(speedtest_service, "run_speed_test", lambda connection_mode=None, on_phase=None: _fake_result(download_mbps=100.0, ping_ms=20.0))
    backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=1)
    backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=2)

    monkeypatch.setattr(speedtest_service, "run_speed_test", lambda connection_mode=None, on_phase=None: _fake_result(download_mbps=10.0, ping_ms=20.0))
    result = backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=3)

    assert result["anomaly"] is not None
    assert result["anomaly"]["baseline_download_mbps"] == 100.0


def test_history_set_tag_and_clear_round_trip(unlocked_backend, monkeypatch):
    monkeypatch.setattr(speedtest_service, "run_speed_test", lambda connection_mode=None, on_phase=None: _fake_result())
    run_result = backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=1)
    record_id = run_result["history_id"]

    tag_result = backend_server.rpc_network_speedtest_history_set_tag({"id": record_id, "tag": "家里WiFi"})
    assert tag_result == {"ok": True}

    listed = backend_server.rpc_network_speedtest_history_list({"environment_tag": "家里WiFi"})
    assert len(listed["results"]) == 1
    assert listed["tags"] == ["家里WiFi"]

    clear_result = backend_server.rpc_network_speedtest_history_clear({})
    assert clear_result == {"ok": True, "cleared_count": 1}
    assert backend_server.rpc_network_speedtest_history_list({})["results"] == []


def test_history_set_tag_reports_error_for_unknown_id(unlocked_backend):
    result = backend_server.rpc_network_speedtest_history_set_tag({"id": 999999, "tag": "x"})
    assert result == {"ok": False, "error": "network_speedtest.history_entry_not_found"}


def test_run_defaults_to_multi_connection_mode_when_omitted(unlocked_backend, monkeypatch):
    captured = {}

    def fake_run_speed_test(connection_mode=None, on_phase=None):
        captured["connection_mode"] = connection_mode
        return _fake_result()

    monkeypatch.setattr(speedtest_service, "run_speed_test", fake_run_speed_test)
    result = backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=1)

    assert result["ok"] is True
    assert captured["connection_mode"] == "multi"
    assert result["connection_mode"] == "single"  # 回传的是_fake_result里SpeedTestResult自己的默认值，不是请求参数


def test_run_forwards_explicit_connection_mode_to_service(unlocked_backend, monkeypatch):
    captured = {}

    def fake_run_speed_test(connection_mode=None, on_phase=None):
        captured["connection_mode"] = connection_mode
        return _fake_result(connection_mode=connection_mode)

    monkeypatch.setattr(speedtest_service, "run_speed_test", fake_run_speed_test)
    result = backend_server.rpc_network_speedtest_run({"network_type": "local", "connection_mode": "single"}, request_id=1)

    assert result["ok"] is True
    assert captured["connection_mode"] == "single"
    assert result["connection_mode"] == "single"


def test_run_rejects_invalid_connection_mode(unlocked_backend):
    result = backend_server.rpc_network_speedtest_run({"network_type": "local", "connection_mode": "bogus"}, request_id=1)
    assert result == {"ok": False, "error": "network_speedtest.invalid_request"}


def test_run_passes_through_new_result_fields_and_gaming_rating(unlocked_backend, monkeypatch):
    monkeypatch.setattr(
        speedtest_service,
        "run_speed_test",
        lambda connection_mode=None, on_phase=None: _fake_result(
            connection_mode="multi",
            ping_min_ms=18.0,
            ping_max_ms=24.0,
            download_loaded_ping_ms=260.0,
            upload_loaded_ping_ms=22.0,
            ping_ms=20.0,
        ),
    )

    result = backend_server.rpc_network_speedtest_run({"network_type": "local"}, request_id=1)

    assert result["connection_mode"] == "multi"
    assert result["ping_min_ms"] == 18.0
    assert result["ping_max_ms"] == 24.0
    assert result["download_loaded_ping_ms"] == 260.0
    assert result["upload_loaded_ping_ms"] == 22.0
    # download方向加压延迟260ms - 空闲20ms = 240ms delta，明显超标，gaming评级要体现出来
    assert result["ratings"]["gaming"]["stars"] == 4

    history_row = backend_server.rpc_network_speedtest_history_list({})["results"][0]
    assert history_row["connection_mode"] == "multi"
    assert history_row["download_loaded_ping_ms"] == 260.0
