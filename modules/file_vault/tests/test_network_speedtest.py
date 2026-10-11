import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import statistics

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.network_speedtest import ratings, service


# --- ratings.py: boundary values from the requirement doc's threshold table ---

@pytest.mark.parametrize("ping_ms,download_mbps,expected", [
    (600, 50, 1),   # 延迟超标，即使下载很快也是1星
    (100, 0.5, 1),  # 下载低于1Mbps，即使延迟很好也是1星
    (400, 50, 2),
    (200, 50, 3),
    (100, 50, 4),
    (40, 50, 5),    # <50ms 且 >20Mbps
    (40, 10, 4),    # <50ms 但下载不够，封顶4星
])
def test_rate_browsing(ping_ms, download_mbps, expected):
    assert ratings.rate_browsing(ping_ms, download_mbps) == expected


@pytest.mark.parametrize("ping_ms,upload_mbps,expected", [
    (30, 0.5, 1),
    (30, 2, 2),
    (30, 4, 3),
    (30, 8, 4),
    (30, 15, 5),   # >10Mbps 且 <50ms
    (100, 15, 4),  # 上传够但延迟不够，封顶4星
])
def test_rate_streaming(ping_ms, upload_mbps, expected):
    assert ratings.rate_streaming(ping_ms, upload_mbps) == expected


@pytest.mark.parametrize("download_mbps,expected", [
    (1, 1), (3, 2), (7, 3), (15, 4), (30, 5),
])
def test_rate_video(download_mbps, expected):
    assert ratings.rate_video(download_mbps) == expected


@pytest.mark.parametrize("ping_ms,jitter_ms,loss_ratio,expected", [
    (200, 0, 0, 1),      # 延迟超标
    (50, 40, 0, 1),      # 抖动明显
    (120, 0, 0, 2),
    (70, 0, 0, 3),
    (30, 0, 0, 4),
    (10, 0, 0, 5),       # <20ms 且丢包率≈0
    (10, 0, 0.05, 4),    # 延迟够但丢包率不够，封顶4星
])
def test_rate_gaming(ping_ms, jitter_ms, loss_ratio, expected):
    assert ratings.rate_gaming(ping_ms, jitter_ms, loss_ratio) == expected


def test_rate_gaming_caps_at_four_stars_when_loaded_ping_spikes():
    # 空闲延迟/抖动/丢包本来都够5星，但加压延迟比空闲延迟高出远超阈值
    assert ratings.rate_gaming(10.0, 1.0, 0.0, loaded_ping_delta_ms=150.0) == 4


def test_rate_gaming_still_five_stars_when_loaded_ping_delta_small():
    assert ratings.rate_gaming(10.0, 1.0, 0.0, loaded_ping_delta_ms=20.0) == 5


def test_rate_gaming_unaffected_when_loaded_ping_delta_not_given():
    assert ratings.rate_gaming(10.0, 1.0, 0.0) == 5
    assert ratings.rate_gaming(10.0, 1.0, 0.0, loaded_ping_delta_ms=None) == 5


def test_stars_to_tier():
    assert ratings.stars_to_tier(1).color == "red"
    assert ratings.stars_to_tier(3).color == "yellow"
    assert ratings.stars_to_tier(5).color == "green"


def test_rate_all_returns_all_seven_scenarios():
    result = ratings.rate_all(ping_ms=20, jitter_ms=2, loss_ratio=0.0, download_mbps=60, upload_mbps=20)
    assert set(result.keys()) == {
        "browsing", "streaming", "video", "gaming", "overall_speed", "latency", "stability",
    }
    for entry in result.values():
        assert 1 <= entry["stars"] <= 5
        assert entry["tier"] in ("poor", "fair", "good")


def test_rate_all_uses_worse_of_download_upload_loaded_ping_for_gaming():
    # 空闲延迟10ms（本来该拿5星）；下载方向加压延迟250ms（delta=240，明显超标）
    # 比上传方向15ms（delta=5，正常）差得多，gaming评级要按更差的那个方向算。
    result = ratings.rate_all(
        ping_ms=10.0, jitter_ms=1.0, loss_ratio=0.0, download_mbps=50.0, upload_mbps=10.0,
        download_loaded_ping_ms=250.0, upload_loaded_ping_ms=15.0,
    )
    assert result["gaming"]["stars"] == 4


def test_rate_all_gaming_unaffected_when_loaded_ping_fields_omitted():
    result = ratings.rate_all(ping_ms=10.0, jitter_ms=1.0, loss_ratio=0.0, download_mbps=50.0, upload_mbps=10.0)
    assert result["gaming"]["stars"] == 5


# --- service.py (network I/O mocked - no real requests here) ---

class _StubSampler:
    """打桩用的最小采样器：`_measure_*` 现返回采样器（run_speed_test 还要取稳定度），桩须同形状。
    故意用真实小类而非 MagicMock：MagicMock 属性访问永远成功，"字段接错"会穿过断言而测试仍绿。"""

    def __init__(self, mbps: float, stability=None):
        self._mbps = mbps
        self._stability = stability

    def final_mbps(self) -> float:
        return self._mbps

    def stability_ratio(self):
        return self._stability


def _stub_sampler(mbps: float) -> "_StubSampler":
    return _StubSampler(mbps)



def _fake_response(status_code=200, content_chunks=None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.raise_for_status = MagicMock()
    if content_chunks is not None:
        resp.iter_content = MagicMock(return_value=iter(content_chunks))
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
    return resp


def test_build_session_direct_disables_trust_env_and_proxies():
    # 代理/VPN 测速移除后这是唯一保证：trust_env 必须关、proxies 必须空，否则 requests 会采纳系统代理
    # 或 HTTP_PROXY，量出的"本机网速"其实穿过了代理，数字正常却不是直连链路。
    session = service._build_session()
    assert session.trust_env is False
    assert session.proxies == {}


def _fake_json_response(payload):
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value=payload)
    return resp


def test_lookup_ip_returns_address_on_success():
    session = MagicMock()
    session.get = MagicMock(return_value=_fake_json_response({"ip": "203.0.113.7"}))
    assert service._lookup_ip(session, service._IPV4_URL) == "203.0.113.7"


def test_lookup_ip_returns_none_on_request_exception():
    import requests as real_requests
    session = MagicMock()
    session.get = MagicMock(side_effect=real_requests.RequestException("no route"))
    assert service._lookup_ip(session, service._IPV6_URL) is None


def test_lookup_ip_returns_none_on_malformed_response():
    session = MagicMock()
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(side_effect=ValueError("not json"))
    session.get = MagicMock(return_value=resp)
    assert service._lookup_ip(session, service._IPV4_URL) is None


def test_measure_ip_addresses_reports_each_family_independently():
    import requests as real_requests
    session = MagicMock()

    def fake_get(url, timeout):
        if url == service._IPV4_URL:
            return _fake_json_response({"ip": "203.0.113.7"})
        raise real_requests.RequestException("no ipv6 route")

    session.get = MagicMock(side_effect=fake_get)
    ipv4, ipv6 = service._measure_ip_addresses(session)
    assert ipv4 == "203.0.113.7"
    assert ipv6 is None


# 延迟探针已从 HTTPS GET 换成 TCP connect（见 service._tcp_rtt_ms：GET 裹着 TLS、HTTP 解析和
# 服务端处理时间），所以这些用例要打桩 _tcp_rtt_ms；继续打桩 session.get 会静默去连真实网络。
@pytest.fixture
def fast_ping(monkeypatch):
    """采样间隔清零，让这些用例不必真的等 16 × 50ms。"""
    monkeypatch.setattr(service, "_PING_INTERVAL_S", 0.0)


def _patch_rtt(monkeypatch, values):
    """按顺序返回给定的 RTT（None 代表这一次连不上）。用完之后一直返回最后一个。"""
    seq = list(values)
    def fake(address, family):
        return seq.pop(0) if len(seq) > 1 else seq[0]
    monkeypatch.setattr(service, "_tcp_rtt_ms", fake)


def test_measure_ping_computes_median_and_jitter(monkeypatch, fast_ping):
    _patch_rtt(monkeypatch, [20.0, 24.0, 20.0, 24.0])
    ping_ms, jitter_ms, loss_ratio, ping_min_ms, ping_max_ms = service._measure_ping(MagicMock())
    assert ping_ms > 0
    assert loss_ratio == 0.0
    assert ping_min_ms <= ping_ms <= ping_max_ms


def test_jitter_is_adjacent_difference_not_standard_deviation():
    """从 20 平滑爬到 70 的延迟曲线，标准差大但每步只跳 10。通话/游戏在意相邻包之间跳多少而非离均值
    多远，用标准差会把平稳变化的链路报成剧烈抖动。"""
    smooth_ramp = [20.0, 30.0, 40.0, 50.0, 60.0, 70.0]
    assert service._jitter_of(smooth_ramp) == pytest.approx(10.0)
    assert statistics.pstdev(smooth_ramp) > 15  # 旧口径会报这个数
    assert service._jitter_of([20.0]) == 0.0  # 单个样本没有"相邻"可言


def test_measure_ping_raises_when_all_samples_fail(monkeypatch, fast_ping):
    _patch_rtt(monkeypatch, [None])
    with pytest.raises(service.NetworkUnreachableError):
        service._measure_ping(MagicMock())


def test_measure_ping_raises_when_the_name_cannot_be_resolved(monkeypatch):
    """域名都解析不出来时不该去连一个不存在的地址，直接判定不可达。"""
    monkeypatch.setattr(service.socket, "getaddrinfo", MagicMock(side_effect=OSError("no such host")))
    with pytest.raises(service.NetworkUnreachableError):
        service._measure_ping(MagicMock())


def test_measure_ping_reports_partial_loss(monkeypatch, fast_ping):
    """连不上的那几次要计入失败率，而不是被悄悄跳过。"""
    failures = 3
    seq = [None] * failures + [20.0] * (service._PING_SAMPLE_COUNT - failures)
    monkeypatch.setattr(service, "_tcp_rtt_ms", lambda address, family: seq.pop(0))
    ping_ms, jitter_ms, loss_ratio, ping_min_ms, ping_max_ms = service._measure_ping(MagicMock())
    assert loss_ratio == pytest.approx(failures / service._PING_SAMPLE_COUNT)


@pytest.fixture
def no_warmup(monkeypatch):
    """关掉预热窗口：真实测速丢弃最初 _DOWNLOAD_WARMUP_S / _UPLOAD_WARMUP_S 的字节（跳过 TCP 慢启动），
    而这些用例的假 session 瞬间跑完，不关则所有字节落在预热窗口里、结果必为 0。预热另由
    test_*_warmup_* 单独测。"""
    monkeypatch.setattr(service, "_DOWNLOAD_WARMUP_S", 0.0)
    monkeypatch.setattr(service, "_UPLOAD_WARMUP_S", 0.0)


def test_measure_download_computes_mbps_from_transferred_bytes(no_warmup):
    session = MagicMock()
    chunks = [b"0" * service._DOWNLOAD_CHUNK_SIZE for _ in range(4)]
    session.get = MagicMock(return_value=_fake_response(content_chunks=chunks))
    # 假时钟被依次取走：start → 续请求循环的入口判断 → 每块一次 → 循环再判断一次
    # （这一次要 >= stop_time 才会退出，见 _download_from_url 的续请求说明）→ return。
    times = iter([0, 0.5, 1.0, 1.5, 2.0, 2.5, 11.0, 12.0])
    with patch.object(service, "_clock", side_effect=lambda: next(times)):
        mbps = service._measure_download(session).final_mbps()
    assert mbps > 0


def test_measure_download_raises_on_request_exception():
    import requests as real_requests
    session = MagicMock()
    session.get = MagicMock(side_effect=real_requests.RequestException("boom"))
    with pytest.raises(service.NetworkUnreachableError):
        service._measure_download(session).final_mbps()


def test_measure_upload_raises_on_request_exception():
    import requests as real_requests
    session = MagicMock()
    session.post = MagicMock(side_effect=real_requests.RequestException("boom"))
    with pytest.raises(service.NetworkUnreachableError):
        service._measure_upload(session).final_mbps()


def test_measure_upload_computes_mbps_from_generator_bytes_sent(no_warmup):
    session = MagicMock()

    def fake_post(url, data, timeout):
        total = 0
        for chunk in data:
            total += len(chunk)
        resp = _fake_response()
        resp._sent = total
        return resp

    session.post = MagicMock(side_effect=fake_post)
    with patch.object(service, "_UPLOAD_MAX_DURATION_S", 100.0), patch.object(service, "_UPLOAD_SIZE_BYTES", service._UPLOAD_CHUNK_SIZE * 3):
        mbps = service._measure_upload(session).final_mbps()
    assert mbps > 0


def test_run_speed_test_calls_on_phase_for_each_stage(monkeypatch):
    monkeypatch.setattr(service, "_measure_dns", lambda hostname: 5.0)
    monkeypatch.setattr(service, "_measure_ip_addresses", lambda session: ("1.2.3.4", None))
    monkeypatch.setattr(service, "_measure_ping", lambda session: (20.0, 1.0, 0.0, 18.0, 22.0))
    monkeypatch.setattr(service, "_measure_loaded_ping", lambda session, stop_event: [])
    monkeypatch.setattr(service, "_measure_download", lambda session, on_tick=None: _stub_sampler(50.0))
    monkeypatch.setattr(service, "_measure_upload", lambda session, on_tick=None: _stub_sampler(10.0))
    phases = []
    result = service.run_speed_test(on_phase=lambda phase, data: phases.append(phase))
    assert phases == ["dns", "ip", "ping", "download", "upload"]
    assert result.ping_ms == 20.0
    assert result.download_mbps == 50.0
    assert result.dns_ms == 5.0
    assert result.ipv4 == "1.2.3.4"
    assert result.ipv6 is None


def test_run_speed_test_handles_dns_lookup_failure_gracefully(monkeypatch):
    """A failed DNS measurement (None) must not abort the whole test - the
    other phases still run and dns_ms is just reported as None."""
    monkeypatch.setattr(service, "_measure_dns", lambda hostname: None)
    monkeypatch.setattr(service, "_measure_ip_addresses", lambda session: ("1.2.3.4", None))
    monkeypatch.setattr(service, "_measure_ping", lambda session: (20.0, 1.0, 0.0, 18.0, 22.0))
    monkeypatch.setattr(service, "_measure_loaded_ping", lambda session, stop_event: [])
    monkeypatch.setattr(service, "_measure_download", lambda session, on_tick=None: _stub_sampler(50.0))
    monkeypatch.setattr(service, "_measure_upload", lambda session, on_tick=None: _stub_sampler(10.0))
    result = service.run_speed_test(on_phase=None)
    assert result.dns_ms is None


def test_run_speed_test_forwards_live_ticks_before_final_phase_value(monkeypatch):
    """阶段进行中显示的数字必须来自 on_tick，而非只在末尾出现，否则"实时速度"只是提前展示终值。"""
    def fake_download(session, on_tick=None):
        if on_tick:
            on_tick(10.0)
            on_tick(30.0)
        return _stub_sampler(55.0)

    monkeypatch.setattr(service, "_measure_dns", lambda hostname: 5.0)
    monkeypatch.setattr(service, "_measure_ip_addresses", lambda session: ("1.2.3.4", "::1"))
    monkeypatch.setattr(service, "_measure_ping", lambda session: (20.0, 1.0, 0.0, 18.0, 22.0))
    monkeypatch.setattr(service, "_measure_loaded_ping", lambda session, stop_event: [])
    monkeypatch.setattr(service, "_measure_download", fake_download)
    monkeypatch.setattr(service, "_measure_upload", lambda session, on_tick=None: _stub_sampler(10.0))

    download_values = []

    def on_phase(phase, data):
        if phase == "download":
            download_values.append(data["download_mbps"])

    service.run_speed_test(on_phase=on_phase)
    assert download_values == [10.0, 30.0, 55.0]


def test_measure_download_reports_ticks_during_transfer(no_warmup):
    session = MagicMock()
    chunks = [b"0" * service._DOWNLOAD_CHUNK_SIZE for _ in range(4)]
    session.get = MagicMock(return_value=_fake_response(content_chunks=chunks))
    # start → 续请求循环入口 → 每块一次（间隔 >= _TICK_INTERVAL_S 所以块块都报数）
    # → 循环再判断（>= stop_time 退出）→ return。
    times = iter([0, 0.0, 0.3, 0.6, 0.9, 1.2, 11.0, 12.0])
    ticks = []
    with patch.object(service, "_clock", side_effect=lambda: next(times)):
        service._measure_download(session, on_tick=ticks.append).final_mbps()
    assert len(ticks) > 0
    assert all(v > 0 for v in ticks)


def test_measure_upload_reports_ticks_during_transfer(no_warmup):
    session = MagicMock()

    def fake_post(url, data, timeout):
        for _ in data:
            pass
        return _fake_response()

    session.post = MagicMock(side_effect=fake_post)
    ticks = []
    with patch.object(service, "_UPLOAD_MAX_DURATION_S", 100.0), patch.object(service, "_UPLOAD_SIZE_BYTES", service._UPLOAD_CHUNK_SIZE * 5):
        times = iter([0.0] + [i * 0.25 for i in range(1, 20)])
        with patch.object(service, "_clock", side_effect=lambda: next(times)):
            service._measure_upload(session, on_tick=ticks.append).final_mbps()
    assert len(ticks) > 0
    assert all(v > 0 for v in ticks)


# --- DNS 解析耗时 ---

def test_measure_dns_returns_elapsed_ms_on_success(monkeypatch):
    monkeypatch.setattr(service.socket, "getaddrinfo", lambda host, port: [("dummy",)])
    with patch.object(service, "_clock", side_effect=[0.0, 0.01]):
        result = service._measure_dns("speed.cloudflare.com")
    assert result == pytest.approx(10.0)


def test_measure_dns_returns_none_on_resolution_failure(monkeypatch):
    def raise_os_error(host, port):
        raise OSError("no such host")

    monkeypatch.setattr(service.socket, "getaddrinfo", raise_os_error)
    assert service._measure_dns("nonexistent.invalid") is None


def test_measure_dns_restores_previous_default_timeout(monkeypatch):
    service.socket.setdefaulttimeout(12.5)
    monkeypatch.setattr(service.socket, "getaddrinfo", lambda host, port: [("dummy",)])
    try:
        service._measure_dns("speed.cloudflare.com")
        assert service.socket.getdefaulttimeout() == 12.5
    finally:
        service.socket.setdefaulttimeout(None)


# 多连接并发下载/上传：线程调度顺序和精确计时不适合用固定的 time.monotonic 序列断言，改断言结果性
# 行为：总量聚合正确、单条流失败被隔离、全部失败报 NetworkUnreachableError。

def _fresh_stream_response(*_args, **_kwargs):
    """每次调用都返回全新的response/iterator，避免多个线程共享同一个
    已耗尽的迭代器导致互相干扰。"""
    chunks = [b"0" * 4096 for _ in range(4)]
    return _fake_response(content_chunks=chunks)


def test_measure_download_multi_aggregates_across_all_streams(no_warmup, monkeypatch):
    # 时间窗收到 0.2 秒：每条流读完手上那份会再要一份（见 _DOWNLOAD_REQUEST_SIZE_BYTES 的续请求说明），
    # 不收窗口则要真的跑满 _DOWNLOAD_MAX_DURATION_S。
    monkeypatch.setattr(service, "_DOWNLOAD_MAX_DURATION_S", 0.2)
    session = MagicMock()
    session.get = MagicMock(side_effect=_fresh_stream_response)
    mbps = service._measure_download_multi(session).final_mbps()
    assert mbps > 0
    # 每条流至少发一份请求；续请求让它**可能**发更多，所以这里是下界不是等号。
    assert session.get.call_count >= service._MULTI_CONNECTION_COUNT


# 真实故障：测速永远报"无法连接到网络"而网络正常。下载请求写死 200 MB，而
# speed.cloudflare.com/__down 有上限（实测 90 MB 通过、100 MB 返回 403）；403 被一律翻成
# NetworkUnreachableError，用户被指使去查正常的网线。钉死两点：请求大小须在服务端上限以下；
# 服务器回话了却拒绝时绝不能报成"连不上网"。


def test_download_request_size_stays_under_the_known_server_cap():
    """Cloudflare 的 __down 在 100 MB 就开始回 403（2026-08-01 实测）。
    这个上限不由我们控制，所以请求大小必须留出余量，并靠续请求补足时间窗。"""
    assert service._DOWNLOAD_REQUEST_SIZE_BYTES <= 90_000_000


def test_download_reports_server_rejection_not_a_dead_network():
    session = MagicMock()
    session.get = MagicMock(return_value=_fake_response(status_code=403, content_chunks=[]))
    with pytest.raises(service.SpeedTestServerError) as excinfo:
        service._measure_download(session).final_mbps()
    assert excinfo.value.status == 403
    assert excinfo.value.phase == "download"


def test_download_multi_reports_server_rejection_not_a_dead_network(monkeypatch):
    monkeypatch.setattr(service, "_MULTI_CONNECTION_COUNT", 3)
    session = MagicMock()
    session.get = MagicMock(side_effect=lambda *a, **k: _fake_response(status_code=403, content_chunks=[]))
    with pytest.raises(service.SpeedTestServerError) as excinfo:
        service._measure_download_multi(session).final_mbps()
    assert excinfo.value.status == 403


def test_download_keeps_requesting_until_the_time_window_closes(no_warmup, monkeypatch):
    """服务端单次请求给的字节可能远少于时间窗需要的量（上限、限流、短连接都会
    造成这个）。一份读完就收工的话，快线路测出来会明显偏低——必须续请求。"""
    monkeypatch.setattr(service, "_DOWNLOAD_MAX_DURATION_S", 0.25)
    session = MagicMock()
    session.get = MagicMock(side_effect=_fresh_stream_response)
    service._download_from_url(session, "https://example.invalid/down")
    assert session.get.call_count > 1


def test_measure_download_multi_raises_when_every_stream_fails():
    import requests as real_requests
    session = MagicMock()
    session.get = MagicMock(side_effect=real_requests.RequestException("boom"))
    with pytest.raises(service.NetworkUnreachableError):
        service._measure_download_multi(session).final_mbps()


def test_measure_download_multi_isolates_single_stream_failure(no_warmup):
    """一条流失败不该拖累其它流——聚合结果里仍能看到其它流贡献的字节数。"""
    import requests as real_requests
    session = MagicMock()
    lock = threading.Lock()
    call_count = {"n": 0}

    def flaky_get(*args, **kwargs):
        with lock:
            call_count["n"] += 1
            is_first_call = call_count["n"] == 1
        if is_first_call:
            raise real_requests.RequestException("this one stream is down")
        return _fresh_stream_response()

    session.get = MagicMock(side_effect=flaky_get)
    mbps = service._measure_download_multi(session).final_mbps()
    assert mbps > 0


def _consuming_fake_post(url, data, timeout):
    for _ in data:
        pass
    return _fake_response()


def test_measure_upload_multi_aggregates_across_all_streams(no_warmup):
    session = MagicMock()
    session.post = MagicMock(side_effect=_consuming_fake_post)
    mbps = service._measure_upload_multi(session).final_mbps()
    assert mbps > 0
    assert session.post.call_count == service._MULTI_CONNECTION_COUNT


def test_measure_upload_multi_raises_when_every_stream_fails():
    import requests as real_requests
    session = MagicMock()
    session.post = MagicMock(side_effect=real_requests.RequestException("boom"))
    with pytest.raises(service.NetworkUnreachableError):
        service._measure_upload_multi(session).final_mbps()


# --- 加压延迟（Loaded Latency / Bufferbloat） ---

# 加压延迟与空闲延迟必须用同一种探针（都是 TCP connect），否则两数不可比：相减结果里有一大截是
# 测法差异而非缓冲膨胀，所以这些用例也打桩 _tcp_rtt_ms。
def test_measure_loaded_ping_collects_samples_until_stop_event_set(monkeypatch):
    monkeypatch.setattr(service, "_tcp_rtt_ms", lambda address, family: 12.0)
    stop_event = threading.Event()

    def stopper():
        time.sleep(0.05)
        stop_event.set()

    threading.Thread(target=stopper, daemon=True).start()
    with patch.object(service, "_LOADED_PING_INTERVAL_S", 0.01):
        samples = service._measure_loaded_ping(MagicMock(), stop_event)
    assert len(samples) > 0
    assert all(sample >= 0 for sample in samples)


def test_measure_loaded_ping_returns_empty_list_when_stopped_immediately(monkeypatch):
    monkeypatch.setattr(service, "_tcp_rtt_ms", lambda address, family: 12.0)
    stop_event = threading.Event()
    stop_event.set()
    assert service._measure_loaded_ping(MagicMock(), stop_event) == []


def test_measure_loaded_ping_failed_samples_are_not_counted_but_do_not_crash(monkeypatch):
    stop_event = threading.Event()
    call_count = {"n": 0}

    def failing_probe(address, family):
        call_count["n"] += 1
        if call_count["n"] >= 3:
            stop_event.set()
        return None

    monkeypatch.setattr(service, "_tcp_rtt_ms", failing_probe)
    with patch.object(service, "_LOADED_PING_INTERVAL_S", 0.001):
        samples = service._measure_loaded_ping(MagicMock(), stop_event)
    assert samples == []
    assert call_count["n"] >= 3


def test_measure_loaded_ping_gives_up_quietly_when_the_name_cannot_be_resolved(monkeypatch):
    """解析不出来就返回空样本，**不能**让加压延迟采样把整个测速拖垮——
    它只是个附加指标，主流程的下载/上传不该因为它失败而失败。"""
    monkeypatch.setattr(service.socket, "getaddrinfo", MagicMock(side_effect=OSError("no such host")))
    stop_event = threading.Event()
    assert service._measure_loaded_ping(MagicMock(), stop_event) == []


def test_run_with_loaded_ping_returns_measure_result_and_collected_samples():
    session = MagicMock()
    session.get = MagicMock(return_value=_fake_response())

    def measure_fn():
        time.sleep(0.05)
        return 42.0

    with patch.object(service, "_LOADED_PING_INTERVAL_S", 0.01):
        result, samples = service._run_with_loaded_ping(session, measure_fn)
    assert result == 42.0
    assert len(samples) > 0


def _fail_if_called(*_args, **_kwargs):
    raise AssertionError("should not be called in this connection_mode")


def test_run_speed_test_multi_mode_uses_multi_connection_functions(monkeypatch):
    monkeypatch.setattr(service, "_measure_dns", lambda hostname: 5.0)
    monkeypatch.setattr(service, "_measure_ip_addresses", lambda session: ("1.2.3.4", None))
    monkeypatch.setattr(service, "_measure_ping", lambda session: (20.0, 1.0, 0.0, 18.0, 22.0))
    monkeypatch.setattr(service, "_measure_loaded_ping", lambda session, stop_event: [])
    monkeypatch.setattr(service, "_measure_download_multi", lambda session, on_tick=None: _stub_sampler(88.0))
    monkeypatch.setattr(service, "_measure_upload_multi", lambda session, on_tick=None: _stub_sampler(33.0))
    monkeypatch.setattr(service, "_measure_download", _fail_if_called)
    monkeypatch.setattr(service, "_measure_upload", _fail_if_called)

    result = service.run_speed_test(connection_mode="multi")

    assert result.connection_mode == "multi"
    assert result.download_mbps == 88.0
    assert result.upload_mbps == 33.0


def test_run_speed_test_single_mode_uses_single_connection_functions(monkeypatch):
    monkeypatch.setattr(service, "_measure_dns", lambda hostname: 5.0)
    monkeypatch.setattr(service, "_measure_ip_addresses", lambda session: ("1.2.3.4", None))
    monkeypatch.setattr(service, "_measure_ping", lambda session: (20.0, 1.0, 0.0, 18.0, 22.0))
    monkeypatch.setattr(service, "_measure_loaded_ping", lambda session, stop_event: [])
    monkeypatch.setattr(service, "_measure_download", lambda session, on_tick=None: _stub_sampler(12.0))
    monkeypatch.setattr(service, "_measure_upload", lambda session, on_tick=None: _stub_sampler(6.0))
    monkeypatch.setattr(service, "_measure_download_multi", _fail_if_called)
    monkeypatch.setattr(service, "_measure_upload_multi", _fail_if_called)

    result = service.run_speed_test(connection_mode="single")

    assert result.connection_mode == "single"
    assert result.download_mbps == 12.0


def test_run_speed_test_reports_ping_min_max_and_loaded_ping_medians(monkeypatch):
    monkeypatch.setattr(service, "_measure_dns", lambda hostname: 5.0)
    monkeypatch.setattr(service, "_measure_ip_addresses", lambda session: ("1.2.3.4", None))
    monkeypatch.setattr(service, "_measure_ping", lambda session: (20.0, 1.0, 0.0, 15.0, 25.0))
    monkeypatch.setattr(service, "_measure_download", lambda session, on_tick=None: _stub_sampler(50.0))
    monkeypatch.setattr(service, "_measure_upload", lambda session, on_tick=None: _stub_sampler(10.0))

    call_count = {"n": 0}

    def fake_loaded_ping(session, stop_event):
        call_count["n"] += 1
        return [100.0, 200.0, 300.0] if call_count["n"] == 1 else [40.0, 60.0]

    monkeypatch.setattr(service, "_measure_loaded_ping", fake_loaded_ping)

    result = service.run_speed_test()

    assert result.ping_min_ms == 15.0
    assert result.ping_max_ms == 25.0
    assert result.download_loaded_ping_ms == 200.0
    assert result.upload_loaded_ping_ms == 50.0


# 预热窗口：旧算法从发请求起计时，分母含 DNS、TCP/TLS 握手，尤其是 TCP 慢启动，4 秒窗口下结果
# 明显偏低；Ookla 的做法是丢掉爬坡段只统计稳态，这些用例钉住"确实丢掉了"。


def test_download_ignores_bytes_transferred_during_warmup():
    session = MagicMock()
    # 6 块：按下面的假时钟，前几块落在预热窗口（<2s）里，必须一个都不算。
    chunks = [b"0" * service._DOWNLOAD_CHUNK_SIZE for _ in range(6)]
    session.get = MagicMock(return_value=_fake_response(content_chunks=chunks))
    # time.monotonic 依次返回：起点 0，然后每块一个时刻
    times = iter([0, 0.1, 0.5, 1.0, 1.5, 2.5, 3.0, 3.5, 11.0, 4.0])
    with patch.object(service, "_clock", side_effect=lambda: next(times)):
        mbps = service._measure_download(session).final_mbps()

    chunk_bits = service._DOWNLOAD_CHUNK_SIZE * 8 / 1_000_000
    # 假时钟依次取值：start=0；续请求循环入口=0.1；6 个块读到 0.5/1.0/1.5/2.5/3.0/3.5；循环再判断=11.0
    # （>= stop_time 退出，不发第二份请求）。预热线 2.0：前 3 块整段丢掉；t=2.5 那块只钉计时起点、
    # 不计入；计入的是 3.0 和 3.5 两块。分母是 3.5 - 2.5 = 1.0 秒（最后一个字节到达减计时起点），
    # 不是函数返回前再读的时钟 4.0：多出的 0.5 秒是线程收尾和关连接，没传字节，算进去会平白压低速度。
    assert mbps == pytest.approx(chunk_bits * 2 / 1.0, rel=0.01)
    # 关键：预热没生效的话，分子是 6 块、分母从 0 起算，数字明显不同
    assert mbps != pytest.approx(chunk_bits * 6 / 4.0, rel=0.01)


def test_download_multi_ignores_warmup_bytes(no_warmup, monkeypatch):
    """多流版本跟单流用的是同一套预热逻辑，这里确认它真的接上了（而不是只有
    单流那条改了）——多流才是默认模式。"""
    monkeypatch.setattr(service, "_DOWNLOAD_WARMUP_S", 60.0)  # 整个测试都在预热期内
    monkeypatch.setattr(service, "_MULTI_CONNECTION_COUNT", 2)
    monkeypatch.setattr(service, "_DOWNLOAD_MAX_DURATION_S", 0.2)
    session = MagicMock()
    chunks = [b"0" * service._DOWNLOAD_CHUNK_SIZE for _ in range(4)]
    session.get = MagicMock(side_effect=lambda *a, **k: _fake_response(content_chunks=list(chunks)))

    mbps = service._measure_download_multi(session).final_mbps()
    # 全程都在预热期 → 一个字节都不计入 → 0。但因为 total>0，它**不能**被当成
    # "网络不可达"抛异常，那是另一回事。
    assert mbps == 0.0


def test_upload_multi_ignores_warmup_bytes(monkeypatch):
    monkeypatch.setattr(service, "_UPLOAD_WARMUP_S", 60.0)
    monkeypatch.setattr(service, "_MULTI_CONNECTION_COUNT", 2)
    monkeypatch.setattr(service, "_UPLOAD_MAX_DURATION_S", 0.2)
    session = MagicMock()
    session.post = MagicMock(side_effect=_consuming_fake_post)

    assert service._measure_upload_multi(session).final_mbps() == 0.0


def test_warmup_and_window_are_tuned_for_slow_start():
    """这几个数字是"跟 speedtest.net 对齐"的全部依据，改小了差距就会回来。"""
    assert service._DOWNLOAD_WARMUP_S >= 1.5
    assert service._UPLOAD_WARMUP_S >= 1.0
    # 测量窗口必须显著长于预热窗口，否则稳态样本太少、噪声压不住
    assert service._DOWNLOAD_MAX_DURATION_S >= service._DOWNLOAD_WARMUP_S * 3
    assert service._UPLOAD_MAX_DURATION_S >= service._UPLOAD_WARMUP_S * 3
    # 单条 TCP 流吃不满带宽（吞吐 ≈ 拥塞窗口/RTT），跨境链路尤其明显
    assert service._MULTI_CONNECTION_COUNT >= 8
    # 连接池要放得下所有并发流 + 加压延迟那条采样连接，否则会在池里排队，
    # 并发实际上退化成串行——那样连接数调多少都没用
    adapter = service._build_session().get_adapter("https://speed.cloudflare.com")
    assert adapter._pool_maxsize >= service._MULTI_CONNECTION_COUNT + 1


def test_timing_uses_a_high_resolution_clock_not_gettickcount():
    """计时必须走 perf_counter，不能退回 time.monotonic。

    Windows 上 `time.monotonic()` 基于 GetTickCount64()，分辨率 15.625 毫秒；perf_counter 是
    QueryPerformanceCounter，约 0.0001 毫秒。用 monotonic 时延迟/抖动/DNS 每个数都是 0、15 或 16
    （量化噪声，抖动尤其致命）。把 _clock 改成 time.monotonic 此条会红。
    """
    resolution_s = time.get_clock_info("perf_counter").resolution
    assert service._clock is not None
    # 被测的是 service 真正用的那个时钟，不是"perf_counter 本身好不好"。
    sample_a = service._clock()
    sample_b = service._clock()
    assert isinstance(sample_a, float)
    # 连续两次取值必须能分辨出差别（或至少时钟本身有亚毫秒分辨率）——
    # GetTickCount64 那种 15.6ms 一跳的时钟过不了这一关。
    assert resolution_s < 1e-3, "perf_counter 的分辨率不该低于 1 毫秒"
    import inspect
    source = inspect.getsource(service._clock)
    assert "perf_counter" in source, "_clock 必须用 perf_counter"
    assert "monotonic" not in source, "别改回 monotonic —— 它在 Windows 上是 15.6ms 一跳"
    assert sample_b >= sample_a
