"""Safe HTTP-fetch bridge for AI chat: lets the model read a public web page or JSON endpoint, since GUI automation can't reliably type into Chromium.

Only public hosts: the hostname is resolved up front and rejected if any address is loopback/private/link-local/reserved/multicast.
Redirects are not followed (each hop would need the same check; auto-following is how it gets bypassed); a redirect is returned as data for the model to fetch explicitly.
"""

import ipaddress
import socket
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from modules.file_vault import errors

_TIMEOUT_SECONDS = 15
_CHUNK_SIZE = 8192
_MAX_DOWNLOAD_BYTES = 1_500_000
_MAX_RETURNED_CHARS = 12_000
_ALLOWED_CONTENT_TYPES = (
    "text/html",
    "text/plain",
    "text/javascript",
    "application/json",
    "application/xml",
    "text/xml",
    "application/javascript",
    "application/x-javascript",
)
_USER_AGENT = "Mozilla/5.0 (compatible; Ideal1FileVaultAI/1.0)"


class WebFetchError(errors.VaultError):
    """A user-facing failure while fetching a URL for the AI."""


def _invalid_url() -> WebFetchError:
    return WebFetchError("ai.web_fetch_invalid_url")


def _blocked_host() -> WebFetchError:
    return WebFetchError("ai.web_fetch_blocked_host")


def _is_unsafe_address(ip: "ipaddress._BaseAddress") -> bool:
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified


def _literal_ip(host: str) -> Optional["ipaddress._BaseAddress"]:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _proxy_will_mediate(url: str) -> bool:
    """True if a system/env HTTP(S) proxy is configured for this URL and the connection will go through it."""
    parsed = urlparse(url)
    if not parsed.hostname:
        return False
    try:
        proxies = urllib.request.getproxies()
        if not proxies.get(parsed.scheme):
            return False
        return not urllib.request.proxy_bypass(parsed.hostname)
    except Exception:
        return False


def _resolve_pinned_address(host: str, url: str) -> Optional[str]:
    """Resolve `host` exactly once, reject it if any address is loopback/private/link-local (incl. 169.254.169.254)/reserved/multicast/unspecified, and return the single IP the connection must be pinned to.

    Must be the ONLY DNS resolution: `fetch` reuses the result, since a second connect-time lookup is a DNS-rebinding hole (attacker DNS returns a public IP to validation, an internal one later).
    Returns None when a proxy mediates the connection (fake-IP proxy resolvers make local resolution meaningless); the proxy is trusted. Raises _blocked_host() on failure or unsafe address."""
    if _proxy_will_mediate(url):
        return None
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise _blocked_host()
    if not infos:
        raise _blocked_host()
    pinned: Optional[str] = None
    for info in infos:
        raw_addr = info[4][0]
        try:
            ip = ipaddress.ip_address(raw_addr.split("%", 1)[0])
        except ValueError:
            raise _blocked_host()
        if _is_unsafe_address(ip):
            raise _blocked_host()
        if pinned is None:
            pinned = raw_addr
    return pinned


def _validate_url(url: Any) -> Tuple[str, Optional[str]]:
    """Return (url, pinned_ip); pinned_ip is None for a literal-IP host (validated directly) or proxy-mediated URLs."""
    if not isinstance(url, str) or not url.strip():
        raise _invalid_url()
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise _invalid_url()
    literal = _literal_ip(parsed.hostname)
    if literal is not None:
        if _is_unsafe_address(literal):
            raise _blocked_host()
        return url, None
    pinned_ip = _resolve_pinned_address(parsed.hostname, url)
    return url, pinned_ip


class _TextExtractor(HTMLParser):
    """Minimal HTML-to-text: drops script/style/noscript bodies, avoiding a full HTML-parser dependency."""

    _SKIP_TAGS = {"script", "style", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._parts: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0 and data.strip():
            self._parts.append(data.strip())

    def text(self) -> str:
        return "\n".join(self._parts)


def _extract_text(body: str, content_type: str) -> str:
    if "html" in content_type:
        extractor = _TextExtractor()
        extractor.feed(body)
        return extractor.text()
    return body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Report a 3xx as-is instead of following it: each hop would need the SSRF host check re-run.
    Returning None makes urllib raise HTTPError, which `fetch` already handles."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def fetch(arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch one URL and return readable text. Ordinary HTTP failures (404, bad content type, redirect) don't raise; malformed/blocked URLs and transport failures raise VaultError, same as desktop_control.execute.

    Uses urllib, not `requests`: arbitrary hosts must go through the user's system/VPN proxy, and urllib3 has had tunnel connections reset by a common local proxy client (cause unknown)."""
    url, pinned_ip = _validate_url(arguments.get("url"))
    parsed = urlparse(url)
    connect_url = url
    if pinned_ip:
        # Bracket IPv6 literals for a netloc (`[::1]:443`, not `::1:443` -
        # the latter is ambiguous with the port separator).
        host_for_netloc = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
        netloc = f"{host_for_netloc}:{parsed.port}" if parsed.port else host_for_netloc
        connect_url = parsed._replace(netloc=netloc).geturl()
    req = urllib.request.Request(connect_url, headers={"Host": parsed.hostname, "User-Agent": _USER_AGENT})
    try:
        resp = _opener.open(req, timeout=_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            return {
                "ok": False,
                "status": exc.code,
                "redirected_to": exc.headers.get("Location", ""),
                "note": "Not followed automatically - fetch the target URL explicitly if you want it.",
            }
        return {"ok": False, "status": exc.code}
    except (urllib.error.URLError, OSError) as exc:
        raise WebFetchError("ai.web_fetch_failed", detail=str(exc)) from exc

    try:
        content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if content_type and not any(content_type.startswith(t) for t in _ALLOWED_CONTENT_TYPES):
            return {"ok": False, "error": "unsupported_content_type", "content_type": content_type}

        chunks = []
        total = 0
        while total < _MAX_DOWNLOAD_BYTES:
            chunk = resp.read(_CHUNK_SIZE)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        raw = b"".join(chunks)
        status_code = resp.status
        charset = resp.headers.get_content_charset()
    finally:
        resp.close()

    try:
        body = raw.decode(charset or "utf-8", errors="replace")
    except LookupError:
        body = raw.decode("utf-8", errors="replace")

    text = _extract_text(body, content_type)
    truncated = len(text) > _MAX_RETURNED_CHARS or total >= _MAX_DOWNLOAD_BYTES
    return {
        "ok": True,
        "status": status_code,
        "content_type": content_type,
        "text": text[:_MAX_RETURNED_CHARS],
        "truncated": truncated,
    }
