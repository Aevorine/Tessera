"""DeepSeek AI API client, decoupled from callers: chat dialog, clipboard actions and
file summary all just call `chat()`. The API key is never written inside the repo; callers
persist it via identity.py's save_ai_config/load_ai_config (OS keyring)."""

import time
from dataclasses import dataclass
from typing import Dict, List, Optional

import requests

from core.logging import get_logger
from modules.file_vault.errors import VaultError

logger = get_logger(__name__)

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"
LEGACY_DEEPSEEK_MODEL = "deepseek-chat"
OFFICIAL_DEEPSEEK_BASE_URLS = frozenset((DEFAULT_BASE_URL, f"{DEFAULT_BASE_URL}/v1"))
REQUEST_TIMEOUT_S = 60
# Small cap for the settings "test connection" call; it only proves key/endpoint work.
TEST_MAX_TOKENS = 8


@dataclass
class AiConfig:
    api_key: str
    model: str = DEFAULT_MODEL
    base_url: str = DEFAULT_BASE_URL

    def __post_init__(self) -> None:
        """Upgrade the retired official DeepSeek model without changing
        custom-compatible API endpoints that may still support it."""
        if (
            self.model == LEGACY_DEEPSEEK_MODEL
            and self.base_url.strip().rstrip("/").lower() in OFFICIAL_DEEPSEEK_BASE_URLS
        ):
            self.model = DEFAULT_MODEL


class AiError(VaultError):
    """Coded error for any AI-request failure - see errors.json's "ai.*"
    keys for the user-facing messages."""


def _request_message(
    config: AiConfig,
    messages: List[Dict],
    timeout: int,
    max_tokens: Optional[int] = None,
    tools: Optional[List[Dict]] = None,
) -> Dict:
    """Send one chat-completion request and return the raw assistant `message` dict (used by
    chat() and chat_with_tools()). Raises AiError, never a raw requests exception."""
    if not config.api_key:
        raise AiError("ai.not_configured")

    url = f"{config.base_url.rstrip('/')}/chat/completions"
    payload = {"model": config.model, "messages": messages, "stream": False}
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if tools:
        payload["tools"] = tools

    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=timeout,
            # DeepSeek is mainland-China-hosted and shouldn't use a proxy: requests auto-detects
            # system/registry proxies (e.g. VPN clients), which can reset the connection (ProxyError/
            # WinError 10054). Explicit None overrides HTTP_PROXY/HTTPS_PROXY and the registry setting.
            proxies={"http": None, "https": None},
        )
    except requests.RequestException as exc:
        raise AiError("ai.request_failed", detail=str(exc)) from exc

    if resp.status_code == 401:
        raise AiError("ai.invalid_api_key")
    if resp.status_code == 429:
        raise AiError("ai.rate_limited")
    if resp.status_code >= 400:
        raise AiError("ai.request_failed", detail=f"HTTP {resp.status_code}: {resp.text[:200]}")

    try:
        data = resp.json()
        return data["choices"][0]["message"]
    except (ValueError, KeyError, IndexError) as exc:
        raise AiError("ai.malformed_response") from exc


MODELS_TIMEOUT_S = 15


def list_models(config: AiConfig, timeout: int = MODELS_TIMEOUT_S) -> List[str]:
    """查询服务端提供的模型，返回 id 列表（OpenAI 兼容 `GET /models`，自建/中转端点也可用）。

    返回空列表不算失败：有的端点没实现或结构不认识，界面应退回手动填模型名。
    只有密钥不对和连不上才该报错，因为那时聊天也用不了。
    """
    if not config.api_key:
        raise AiError("ai.not_configured")

    url = f"{config.base_url.rstrip('/')}/models"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {config.api_key}"},
            timeout=timeout,
            # 跟 _request_message 同样的理由显式禁代理，见那里的长注释。
            proxies={"http": None, "https": None},
        )
    except requests.RequestException as exc:
        raise AiError("ai.request_failed", detail=str(exc)) from exc

    if resp.status_code == 401:
        raise AiError("ai.invalid_api_key")
    if resp.status_code >= 400:
        # 404 = 这个端点没实现 /models。不是错误，只是没有列表可给。
        logger.info("model listing unavailable at %s (HTTP %s)", url, resp.status_code)
        return []

    try:
        payload = resp.json()
    except ValueError:
        logger.info("model listing returned non-JSON from %s", url)
        return []

    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        logger.info("model listing had no usable 'data' array from %s", url)
        return []

    models = []
    for item in items:
        model_id = item.get("id") if isinstance(item, dict) else None
        if isinstance(model_id, str) and model_id.strip():
            models.append(model_id.strip())
    # 去重并按名字排序：同一个 id 出现两次是有的，而服务端给的顺序不稳定，
    # 每次打开设置看到的顺序都不一样会让人以为列表变了。
    return sorted(set(models))


# 模型说明目录：`GET /models` 只给 id，这张表补充名字和发布日期。
# 它只负责补充说明，绝不能用来过滤要显示的模型：列表以服务端实时返回为准，表里没有的
# 照样显示；反过来过滤会让新发布的模型在界面上无声消失。
# 日期取自 https://api-docs.deepseek.com/updates/（2026-08-01 核对）。
DEEPSEEK_MODEL_CATALOG: Dict[str, Dict[str, str]] = {
    "deepseek-v4-pro": {
        "label": "DeepSeek-V4-Pro",
        "released": "2026-04-24",
        "note": "1.6T 总参数 / 49B 激活，100 万 token 上下文，支持思考模式",
    },
    "deepseek-v4-flash": {
        "label": "DeepSeek-V4-Flash-0731",
        "released": "2026-07-31",
        "note": "284B 总参数 / 13B 激活，100 万 token 上下文，更快更省，支持思考模式",
    },
    # 这两个老名字官方已于 2026-07-24 停用，仍留在表里：用户配置可能还存着，
    # 界面要能说清"已停用，请换一个"，而不是显示成看似正常却调不通的选项。
    "deepseek-chat": {
        "label": "DeepSeek-Chat（已停用）",
        "released": "2024-05-17",
        "note": "旧接口名，官方已于 2026-07-24 停用，请改用 DeepSeek-V4 系列",
        "deprecated": "2026-07-24",
    },
    "deepseek-reasoner": {
        "label": "DeepSeek-Reasoner（已停用）",
        "released": "2025-01-20",
        "note": "旧接口名，官方已于 2026-07-24 停用，请改用 DeepSeek-V4 系列",
        "deprecated": "2026-07-24",
    },
}


def describe_models(model_ids: List[str]) -> List[Dict[str, str]]:
    """给模型 id 配上名字和发布日期；表里没有的原样保留（`label` 为 id、`released` 为 None）。

    有日期的按发布日期从新到旧排前，无日期的按 id 字母序排后，方便找最新的。
    """
    described = []
    for model_id in model_ids:
        meta = DEEPSEEK_MODEL_CATALOG.get(model_id, {})
        described.append(
            {
                "id": model_id,
                "label": meta.get("label") or model_id,
                "released": meta.get("released"),
                "note": meta.get("note"),
                "deprecated": meta.get("deprecated"),
            }
        )
    described.sort(key=lambda m: (m["released"] is None, "" if m["released"] is None else _invert_date(m["released"]), m["id"]))
    return described


def _invert_date(released: str) -> str:
    """把 YYYY-MM-DD 变成可以正序比较的"越新越小"字符串，这样一次 sort 就能
    做到「有日期的按新→旧、没日期的垫底」，不用写两遍排序。"""
    try:
        return "".join(str(9 - int(c)) if c.isdigit() else c for c in released)
    except Exception:
        return released


def chat(config: AiConfig, messages: List[Dict[str, str]], timeout: int = REQUEST_TIMEOUT_S, max_tokens: int = None) -> str:
    """Send a chat-completion request and return the assistant's reply
    text."""
    message = _request_message(config, messages, timeout, max_tokens)
    content = message.get("content")
    if not isinstance(content, str):
        raise AiError("ai.malformed_response")
    return content


def chat_with_tools(
    config: AiConfig,
    messages: List[Dict],
    tools: List[Dict],
    timeout: int = REQUEST_TIMEOUT_S,
    max_tokens: int = None,
) -> Dict:
    """Like chat(), but returns the raw assistant message dict: the model may return `tool_calls`
    instead of or alongside `content`. The caller executes the tool calls and continues."""
    return _request_message(config, messages, timeout, max_tokens, tools=tools)


def test_connection(config: AiConfig) -> float:
    """Raises AiError on failure; returns round-trip latency in ms, timed here so it excludes
    Electron<->Python IPC/JSON overhead."""
    start = time.perf_counter()
    chat(config, [{"role": "user", "content": "ping"}], timeout=20, max_tokens=TEST_MAX_TOKENS)
    return (time.perf_counter() - start) * 1000
