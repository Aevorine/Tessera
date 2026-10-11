# -*- coding: utf-8 -*-
"""查密码是否在公开泄露库里，而不把密码告诉任何人（k-匿名）。

本机算 SHA-1（大写十六进制），只发前 5 位；服务器返回该前缀下约 800 条后缀和次数，
由本机比对，服务器结构上看不到密码。
- 必须带 `Add-Padding: true`，否则响应长度唯一，旁观流量者可反推所查的桶。
- 同前缀合并成一次请求，避免请求数泄露密码条数。
这是唯一会主动联网的金库功能：只能由用户点击触发，不后台定时、不启动时静默执行。
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from typing import Callable, Dict, Iterable, List, Optional, Tuple

RANGE_URL = "https://api.pwnedpasswords.com/range/{prefix}"
# 服务器偶尔会抽风或被墙。超时给短一点：这是一个用户点了之后站在那儿等结果的
# 操作，卡 30 秒不如早点告诉他"没连上"。
TIMEOUT_SECONDS = 10.0

__all__ = [
    "sha1_prefix_suffix",
    "parse_range_response",
    "check_many",
    "BreachCheckError",
]


class BreachCheckError(RuntimeError):
    """联网这一步失败了。`code` 是给前端翻译用的稳定字符串。"""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(code if not detail else "{}: {}".format(code, detail))
        self.code = code
        self.detail = detail


def sha1_prefix_suffix(password: str) -> Tuple[str, str]:
    """返回 (前 5 位, 后 35 位) 大写十六进制。用 SHA-1 只因泄露库按它建索引。"""
    # HIBP requires SHA-1 for its range lookup; this is not a password-storage KDF.
    digest = hashlib.sha1(password.encode("utf-8"), usedforsecurity=False).hexdigest().upper()
    return digest[:5], digest[5:]


def parse_range_response(text: str) -> Dict[str, int]:
    """把 `后缀:次数` 逐行解析成字典；坏行跳过而不抛异常，最坏只是该条查不到。"""
    out: Dict[str, int] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        suffix, _, count = line.partition(":")
        try:
            out[suffix.strip().upper()] = int(count.strip().replace(",", ""))
        except ValueError:
            continue
    return out


def _default_fetch(prefix: str) -> str:
    import requests  # 延迟导入：这个模块只在用户点了检查时才被用到

    try:
        resp = requests.get(
            RANGE_URL.format(prefix=prefix),
            # 见模块头注释：不带这个头，响应体积会把"你查的是哪个桶"泄露给
            # 任何能看到流量大小的人。
            headers={"Add-Padding": "true", "User-Agent": "Tessera-BreachCheck"},
            timeout=TIMEOUT_SECONDS,
        )
    except Exception as exc:
        raise BreachCheckError("breach.network_failed", type(exc).__name__)
    if resp.status_code != 200:
        raise BreachCheckError("breach.bad_status", str(resp.status_code))
    return resp.text


def check_many(
    items: Iterable[Tuple[str, str]],
    fetch: Optional[Callable[[str], str]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, int]:
    """`items` 为 (条目 id, 密码) 序列，返回 {条目 id: 泄露次数}，只含次数 > 0 的条目。
    同前缀合并请求，相同密码只哈希一次。"""
    fetch = fetch or _default_fetch
    # 前缀 -> [(条目 id, 后缀)]
    buckets: Dict[str, List[Tuple[str, str]]] = defaultdict(list)
    for entry_id, password in items:
        if not password:
            continue  # 空密码没有"泄露"可言，也不该白发一个请求
        prefix, suffix = sha1_prefix_suffix(password)
        buckets[prefix].append((entry_id, suffix))

    found: Dict[str, int] = {}
    total = len(buckets)
    for done, (prefix, members) in enumerate(sorted(buckets.items()), start=1):
        table = parse_range_response(fetch(prefix))
        for entry_id, suffix in members:
            count = table.get(suffix, 0)
            if count > 0:
                found[entry_id] = count
        if on_progress:
            on_progress(done, total)
    return found
