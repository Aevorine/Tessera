import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.network_speedtest import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "network_speedtest_history.db", crypto.generate_key())


def _insert(conn, **overrides):
    fields = dict(
        network_type="local",
        node="Cloudflare",
        environment_tag=None,
        ping_ms=20.0,
        jitter_ms=1.5,
        loss_ratio=0.0,
        dns_ms=5.0,
        download_mbps=100.0,
        upload_mbps=20.0,
        ipv4="1.2.3.4",
        ipv6=None,
    )
    fields.update(overrides)
    return storage.insert_result(conn, **fields)


def test_insert_and_list_results_returns_newest_first(tmp_path):
    conn = _connect(tmp_path)
    first_id = _insert(conn, download_mbps=50.0)
    second_id = _insert(conn, download_mbps=80.0)

    rows = storage.list_results(conn)

    assert [r["id"] for r in rows] == [second_id, first_id]
    assert rows[0]["download_mbps"] == 80.0


def test_insert_and_list_results_round_trips_connection_mode_and_loaded_ping_fields(tmp_path):
    conn = _connect(tmp_path)
    record_id = _insert(
        conn,
        connection_mode="multi",
        ping_min_ms=10.0,
        ping_max_ms=30.0,
        download_loaded_ping_ms=45.0,
        upload_loaded_ping_ms=55.0,
    )

    row = storage.list_results(conn)[0]

    assert row["id"] == record_id
    assert row["connection_mode"] == "multi"
    assert row["ping_min_ms"] == 10.0
    assert row["ping_max_ms"] == 30.0
    assert row["download_loaded_ping_ms"] == 45.0
    assert row["upload_loaded_ping_ms"] == 55.0


def test_insert_without_new_fields_leaves_them_null(tmp_path):
    """Older-shaped calls (before this round's new columns existed) must
    still work - all five new fields are optional and default to NULL."""
    conn = _connect(tmp_path)
    _insert(conn)

    row = storage.list_results(conn)[0]

    assert row["connection_mode"] is None
    assert row["ping_min_ms"] is None
    assert row["download_loaded_ping_ms"] is None


def test_list_results_filters_by_network_type_and_tag(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn, network_type="local", environment_tag="家里WiFi")
    proxy_id = _insert(conn, network_type="proxy", environment_tag="公司网络")

    proxy_rows = storage.list_results(conn, network_type="proxy")
    tagged_rows = storage.list_results(conn, environment_tag="公司网络")

    assert [r["id"] for r in proxy_rows] == [proxy_id]
    assert [r["id"] for r in tagged_rows] == [proxy_id]


def test_set_tag_updates_existing_row_and_reports_missing(tmp_path):
    conn = _connect(tmp_path)
    record_id = _insert(conn, environment_tag=None)

    assert storage.set_tag(conn, record_id, "手机热点") is True
    assert storage.list_results(conn)[0]["environment_tag"] == "手机热点"
    assert storage.set_tag(conn, record_id + 999, "不存在") is False


def test_list_distinct_tags_excludes_null_and_empty(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn, environment_tag="家里WiFi")
    _insert(conn, environment_tag="家里WiFi")
    _insert(conn, environment_tag="公司网络")
    _insert(conn, environment_tag=None)

    assert storage.list_distinct_tags(conn) == ["公司网络", "家里WiFi"]


def test_clear_history_removes_all_rows_and_returns_count(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn)
    _insert(conn)

    removed = storage.clear_history(conn)

    assert removed == 2
    assert storage.list_results(conn) == []


def test_fetch_baseline_returns_none_with_no_prior_history(tmp_path):
    conn = _connect(tmp_path)
    assert storage.fetch_baseline(conn, network_type="local", environment_tag=None) is None


def test_fetch_baseline_averages_recent_same_network_type_rows(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn, network_type="local", download_mbps=100.0, ping_ms=10.0)
    _insert(conn, network_type="local", download_mbps=80.0, ping_ms=20.0)
    _insert(conn, network_type="proxy", download_mbps=1.0, ping_ms=999.0)  # different network_type, must not leak in

    baseline = storage.fetch_baseline(conn, network_type="local", environment_tag=None)

    assert baseline["avg_download_mbps"] == 90.0
    assert baseline["avg_ping_ms"] == 15.0
    assert baseline["sample_size"] == 2


def test_fetch_baseline_scopes_by_environment_tag_when_given(tmp_path):
    conn = _connect(tmp_path)
    _insert(conn, network_type="local", environment_tag="家里WiFi", download_mbps=100.0, ping_ms=10.0)
    _insert(conn, network_type="local", environment_tag="公司网络", download_mbps=10.0, ping_ms=50.0)

    baseline = storage.fetch_baseline(conn, network_type="local", environment_tag="家里WiFi")

    assert baseline["sample_size"] == 1
    assert baseline["avg_download_mbps"] == 100.0


def test_is_anomalous_returns_false_without_baseline():
    assert storage.is_anomalous(None, download_mbps=1.0, ping_ms=999.0) is False


def test_is_anomalous_flags_low_download():
    baseline = {"avg_download_mbps": 100.0, "avg_ping_ms": 20.0}
    assert storage.is_anomalous(baseline, download_mbps=50.0, ping_ms=20.0) is True


def test_is_anomalous_flags_high_ping():
    baseline = {"avg_download_mbps": 100.0, "avg_ping_ms": 20.0}
    assert storage.is_anomalous(baseline, download_mbps=100.0, ping_ms=35.0) is True


def test_is_anomalous_false_when_within_normal_range():
    baseline = {"avg_download_mbps": 100.0, "avg_ping_ms": 20.0}
    assert storage.is_anomalous(baseline, download_mbps=90.0, ping_ms=22.0) is False


def test_history_service_delegates_record_list_tag_and_clear(tmp_path):
    from modules.file_vault import crypto

    service = storage.NetworkSpeedtestHistoryService(tmp_path, crypto.generate_key())
    record_id = service.record_result(network_type="local", node="Cloudflare", download_mbps=90.0, ping_ms=15.0)

    assert [r["id"] for r in service.list_history()] == [record_id]
    assert service.set_tag(record_id, "家里WiFi") is True
    assert service.list_tags() == ["家里WiFi"]
    assert service.baseline_for(network_type="local", environment_tag=None)["sample_size"] == 1
    assert service.clear() == 1
    assert service.list_history() == []
