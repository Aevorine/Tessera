import email.message
import sys
import urllib.error
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import web_fetch


def _headers(content_type=None, location=None):
    msg = email.message.Message()
    if content_type is not None:
        msg["Content-Type"] = content_type
    if location is not None:
        msg["Location"] = location
    return msg


class _FakeResponse:
    def __init__(self, status=200, headers=None, chunks=None):
        self.status = status
        self.headers = headers or _headers()
        self._chunks = list(chunks or [])
        self.closed = False

    def read(self, size=-1):
        if not self._chunks:
            return b""
        return self._chunks.pop(0)

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def _no_system_proxy(monkeypatch):
    # 本组测试针对直连 DNS 解析的 SSRF 检查，它只在没有系统/环境代理介入时才会走到；
    # 在此固定为无代理，避免结果依赖运行机器的代理配置。
    monkeypatch.setattr(web_fetch, "_proxy_will_mediate", lambda url: False)


def test_rejects_non_http_schemes():
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "file:///etc/passwd"})
    assert exc.value.code == "ai.web_fetch_invalid_url"


def test_rejects_missing_or_blank_url():
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({})
    assert exc.value.code == "ai.web_fetch_invalid_url"


def test_blocks_loopback_host(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("127.0.0.1", 0))])
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "http://localhost/secret"})
    assert exc.value.code == "ai.web_fetch_blocked_host"


def test_blocks_private_network_host(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("192.168.1.1", 0))])
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "http://router.local/"})
    assert exc.value.code == "ai.web_fetch_blocked_host"


def test_blocks_link_local_metadata_host(monkeypatch):
    # 169.254.169.254 is the cloud-provider instance-metadata address - a
    # classic SSRF-via-tool target, must never be reachable from here.
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("169.254.169.254", 0))])
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "http://169.254.169.254/latest/meta-data/"})
    assert exc.value.code == "ai.web_fetch_blocked_host"


def test_blocks_host_that_fails_to_resolve(monkeypatch):
    def raise_gaierror(host, port):
        raise web_fetch.socket.gaierror("nope")

    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", raise_gaierror)
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "http://does-not-exist.invalid/"})
    assert exc.value.code == "ai.web_fetch_blocked_host"


def test_blocks_literal_private_ip_even_when_a_proxy_would_mediate(monkeypatch):
    # URL 里的字面 IP 直接检查，无论代理是否可信都必须拦截；只有经 DNS 解析的域名才享受"交给代理"的豁免。
    monkeypatch.setattr(web_fetch, "_proxy_will_mediate", lambda url: True)
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "http://192.168.1.1/"})
    assert exc.value.code == "ai.web_fetch_blocked_host"


def test_proxy_mediated_domain_skips_the_local_dns_check(monkeypatch):
    # 系统/环境代理（VPN、公司代理）可能用 fake-IP DNS 把所有主机名映射到 Python ipaddress 视为"私有"的保留段；
    # 本地解析再做范围检查会拦掉全部代理流量，所以有代理介入时跳过本地解析，信任代理。
    monkeypatch.setattr(web_fetch, "_proxy_will_mediate", lambda url: True)

    def fail_if_called(host, port):
        raise AssertionError("must not resolve DNS locally when a proxy mediates")

    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", fail_if_called)
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: _FakeResponse(
        status=200, headers=_headers("text/plain"), chunks=[b"ok"]
    ))

    result = web_fetch.fetch({"url": "https://qt.gtimg.cn/q=sh600519"})

    assert result["ok"] is True
    assert result["text"] == "ok"


def test_resolves_dns_exactly_once_and_pins_connection_to_that_address(monkeypatch):
    # DNS rebinding 漏洞回归：旧实现先解析一次校验主机名，urllib 建连时又解析一次，
    # 恶意权威服务器可首次返回安全 IP、之后返回 127.0.0.1/169.254.169.254/内网地址。
    # 必须只解析一次，且实际连接钉死到该地址，不能让 urllib 再解析主机名。
    call_count = {"n": 0}

    def fake_getaddrinfo(host, port):
        call_count["n"] += 1
        if call_count["n"] > 1:
            raise AssertionError("must resolve DNS exactly once, not re-resolve at connect time")
        return [(2, 1, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", fake_getaddrinfo)
    captured_requests = []

    def fake_open(req, timeout=None):
        captured_requests.append(req)
        return _FakeResponse(status=200, headers=_headers("text/plain"), chunks=[b"ok"])

    monkeypatch.setattr(web_fetch._opener, "open", fake_open)

    result = web_fetch.fetch({"url": "http://rebinding-target.example/page"})

    assert result["ok"] is True
    assert call_count["n"] == 1
    # Connection goes to the pinned IP, not back through the hostname
    # (which a rebinding DNS server could answer differently a 2nd time).
    assert captured_requests[0].full_url == "http://93.184.216.34/page"
    # Host header still carries the original hostname so name-based
    # virtual hosting on the server side keeps working.
    assert captured_requests[0].headers["Host"] == "rebinding-target.example"


def test_blocks_host_when_any_resolved_address_is_unsafe_even_if_others_are_public(monkeypatch):
    # 主机名解析出多个地址时，任一不安全即拦截，不能只看第一个：urllib 仍可能连到不安全的那个。
    monkeypatch.setattr(
        web_fetch.socket,
        "getaddrinfo",
        lambda host, port: [
            (2, 1, 6, "", ("93.184.216.34", 0)),
            (2, 1, 6, "", ("127.0.0.1", 0)),
        ],
    )
    with pytest.raises(web_fetch.WebFetchError) as exc:
        web_fetch.fetch({"url": "http://multi-homed.example/"})
    assert exc.value.code == "ai.web_fetch_blocked_host"


def test_allows_public_host_and_extracts_html_text(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    html = b"<html><head><style>body{color:red}</style></head><body><h1>Moutai</h1><script>evil()</script><p>1234.56</p></body></html>"
    fake_resp = _FakeResponse(status=200, headers=_headers("text/html; charset=utf-8"), chunks=[html])
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: fake_resp)

    result = web_fetch.fetch({"url": "http://example.com/quote"})

    assert result["ok"] is True
    assert result["status"] == 200
    assert "Moutai" in result["text"]
    assert "1234.56" in result["text"]
    assert "evil()" not in result["text"]
    assert "color:red" not in result["text"]
    assert fake_resp.closed is True


def test_decodes_non_utf8_charset_from_content_type(monkeypatch):
    # Chinese stock-quote endpoints commonly serve GBK-encoded bodies with
    # the charset declared only in the Content-Type header.
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    body = "贵州茅台 1253.00".encode("gbk")
    fake_resp = _FakeResponse(status=200, headers=_headers("text/html; charset=GBK"), chunks=[body])
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: fake_resp)

    result = web_fetch.fetch({"url": "http://example.com/quote"})

    assert result["ok"] is True
    assert "贵州茅台" in result["text"]
    assert "1253.00" in result["text"]


def test_passes_through_json_content_unmodified(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    body = b'{"price": 1234.56}'
    fake_resp = _FakeResponse(status=200, headers=_headers("application/json"), chunks=[body])
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: fake_resp)

    result = web_fetch.fetch({"url": "http://example.com/api/quote"})

    assert result["ok"] is True
    assert result["text"] == '{"price": 1234.56}'


def test_passes_through_javascript_quote_endpoints(monkeypatch):
    # 常用公开行情 API（新浪、腾讯等）以 JSONP 风格的 `application/javascript` 赋值返回数据，不能因内容类型被拒。
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    body = b'v_sh600519="1~Kweichow Moutai~600519~1253.00~...";'
    fake_resp = _FakeResponse(status=200, headers=_headers("application/javascript; charset=GB18030"), chunks=[body])
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: fake_resp)

    result = web_fetch.fetch({"url": "http://example.com/list=sh600519"})

    assert result["ok"] is True
    assert "1253.00" in result["text"]


def test_rejects_unsupported_content_type_without_downloading_body(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    fake_resp = _FakeResponse(status=200, headers=_headers("image/png"))

    def fail_if_read(size=-1):
        raise AssertionError("body must not be downloaded for a rejected content type")

    fake_resp.read = fail_if_read
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: fake_resp)

    result = web_fetch.fetch({"url": "http://example.com/logo.png"})

    assert result == {"ok": False, "error": "unsupported_content_type", "content_type": "image/png"}


def test_does_not_follow_redirects_automatically(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])

    def fake_open(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 302, "Found", _headers(location="http://example.com/new"), None
        )

    monkeypatch.setattr(web_fetch._opener, "open", fake_open)

    result = web_fetch.fetch({"url": "http://example.com/old"})

    assert result["ok"] is False
    assert result["redirected_to"] == "http://example.com/new"


def test_declines_to_follow_redirects_by_construction():
    # opener 带一个 redirect_request 恒返回 None 的重定向处理器，这是 urllib 拒绝而非跟随重定向的标准机制。
    handler = next(h for h in web_fetch._opener.handlers if isinstance(h, web_fetch._NoRedirect))
    assert handler.redirect_request(None, None, 302, "Found", _headers(), "http://example.com/new") is None


def test_reports_http_error_status_without_raising(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])

    def fake_open(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", _headers(), None)

    monkeypatch.setattr(web_fetch._opener, "open", fake_open)

    result = web_fetch.fetch({"url": "http://example.com/missing"})

    assert result == {"ok": False, "status": 404}


def test_truncates_oversized_text_and_flags_it(monkeypatch):
    monkeypatch.setattr(web_fetch.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    big_text = ("word " * 5000).encode("utf-8")
    fake_resp = _FakeResponse(status=200, headers=_headers("text/plain"), chunks=[big_text])
    monkeypatch.setattr(web_fetch._opener, "open", lambda req, timeout=None: fake_resp)

    result = web_fetch.fetch({"url": "http://example.com/huge"})

    assert result["ok"] is True
    assert result["truncated"] is True
    assert len(result["text"]) == web_fetch._MAX_RETURNED_CHARS
