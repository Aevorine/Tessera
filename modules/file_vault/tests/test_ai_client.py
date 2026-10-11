import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pytest

from modules.file_vault import ai_client
from modules.file_vault.ai_client import AiConfig, AiError

FAKE_CONFIG = AiConfig(api_key="sk-fake", model="deepseek-chat", base_url="https://api.deepseek.com")


class FakeResponse:
    def __init__(self, status_code, json_data=None, text=""):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text

    def json(self):
        if self._json_data is None:
            raise ValueError("no json")
        return self._json_data


def test_chat_without_api_key_raises_without_any_network_call(monkeypatch):
    def fail_post(*args, **kwargs):
        raise AssertionError("should never call requests.post when api_key is blank")

    monkeypatch.setattr(ai_client.requests, "post", fail_post)
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(AiConfig(api_key=""), [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.not_configured"


def test_chat_success_returns_reply_content(monkeypatch):
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None, **kwargs):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        return FakeResponse(200, {"choices": [{"message": {"content": "hello there"}}]})

    monkeypatch.setattr(ai_client.requests, "post", fake_post)
    reply = ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])

    assert reply == "hello there"
    assert captured["url"] == "https://api.deepseek.com/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk-fake"
    assert captured["json"]["model"] == "deepseek-v4-pro"
    assert captured["json"]["messages"] == [{"role": "user", "content": "hi"}]


def test_legacy_model_is_upgraded_for_official_v1_endpoint():
    config = AiConfig(api_key="sk-fake", model="deepseek-chat", base_url="https://api.deepseek.com/v1")

    assert config.model == "deepseek-v4-pro"


def test_chat_401_raises_invalid_api_key(monkeypatch):
    monkeypatch.setattr(ai_client.requests, "post", lambda *a, **k: FakeResponse(401))
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.invalid_api_key"


def test_chat_429_raises_rate_limited(monkeypatch):
    monkeypatch.setattr(ai_client.requests, "post", lambda *a, **k: FakeResponse(429))
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.rate_limited"


def test_chat_500_raises_request_failed(monkeypatch):
    monkeypatch.setattr(ai_client.requests, "post", lambda *a, **k: FakeResponse(500, text="boom"))
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.request_failed"


def test_chat_network_exception_raises_request_failed(monkeypatch):
    def raising_post(*args, **kwargs):
        raise ai_client.requests.RequestException("connection refused")

    monkeypatch.setattr(ai_client.requests, "post", raising_post)
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.request_failed"


def test_chat_malformed_response_raises_malformed_response(monkeypatch):
    monkeypatch.setattr(ai_client.requests, "post", lambda *a, **k: FakeResponse(200, {"unexpected": "shape"}))
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.malformed_response"


def test_test_connection_uses_small_max_tokens(monkeypatch):
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None, **kwargs):
        captured["json"] = json
        return FakeResponse(200, {"choices": [{"message": {"content": "pong"}}]})

    monkeypatch.setattr(ai_client.requests, "post", fake_post)
    latency_ms = ai_client.test_connection(FAKE_CONFIG)

    assert captured["json"]["max_tokens"] == ai_client.TEST_MAX_TOKENS
    assert isinstance(latency_ms, float)
    assert latency_ms >= 0


def test_chat_with_tools_sends_the_tools_payload_and_returns_raw_message(monkeypatch):
    captured = {}
    tools = [{"type": "function", "function": {"name": "read_skill", "parameters": {}}}]

    def fake_post(url, headers=None, json=None, timeout=None, **kwargs):
        captured["json"] = json
        return FakeResponse(200, {"choices": [{"message": {"content": "hi", "role": "assistant"}}]})

    monkeypatch.setattr(ai_client.requests, "post", fake_post)
    message = ai_client.chat_with_tools(FAKE_CONFIG, [{"role": "user", "content": "hi"}], tools)

    assert captured["json"]["tools"] == tools
    assert message == {"content": "hi", "role": "assistant"}


def test_chat_with_tools_returns_tool_calls_when_present(monkeypatch):
    tool_calls = [{"id": "call_1", "type": "function", "function": {"name": "read_skill", "arguments": '{"name": "translator"}'}}]

    def fake_post(url, headers=None, json=None, timeout=None, **kwargs):
        return FakeResponse(200, {"choices": [{"message": {"content": None, "tool_calls": tool_calls}}]})

    monkeypatch.setattr(ai_client.requests, "post", fake_post)
    message = ai_client.chat_with_tools(FAKE_CONFIG, [{"role": "user", "content": "hi"}], [{"type": "function"}])

    assert message["tool_calls"] == tool_calls


def test_chat_with_tools_without_api_key_raises_without_any_network_call(monkeypatch):
    def fail_post(*args, **kwargs):
        raise AssertionError("should never call requests.post when api_key is blank")

    monkeypatch.setattr(ai_client.requests, "post", fail_post)
    with pytest.raises(AiError) as exc_info:
        ai_client.chat_with_tools(AiConfig(api_key=""), [{"role": "user", "content": "hi"}], [{"type": "function"}])
    assert exc_info.value.code == "ai.not_configured"


def test_chat_raises_malformed_response_when_content_is_missing(monkeypatch):
    # chat() 不发 tools，本不该出现只有 tool_calls 没有文本的消息；出现时应抛干净的 AiError，
    # 而非向期望 str 的调用方返回 None。
    monkeypatch.setattr(
        ai_client.requests, "post", lambda *a, **k: FakeResponse(200, {"choices": [{"message": {"content": None}}]})
    )
    with pytest.raises(AiError) as exc_info:
        ai_client.chat(FAKE_CONFIG, [{"role": "user", "content": "hi"}])
    assert exc_info.value.code == "ai.malformed_response"


# 取舍：拿不到模型列表不算失败。部分兼容端点（自建、中转）没实现 GET /models，界面应退回
# 手动填模型名；只有密钥错误和连不上才报错，因为那时聊天也用不了。


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def test_list_models_returns_sorted_unique_ids(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return _FakeResponse(payload={"data": [
            {"id": "deepseek-reasoner"},
            {"id": "deepseek-v4-pro"},
            {"id": "deepseek-v4-pro"},  # 重复的一份
            {"id": "  "},                # 空白的要丢掉
            {"no_id": True},             # 结构不对的要丢掉
        ]})

    monkeypatch.setattr(ai_client.requests, "get", fake_get)
    config = ai_client.AiConfig(api_key="k", base_url="https://api.deepseek.com")
    assert ai_client.list_models(config) == ["deepseek-reasoner", "deepseek-v4-pro"]
    assert captured["url"] == "https://api.deepseek.com/models"
    # 跟聊天请求同样显式禁代理——本机的 VPN 客户端会让这个域名连不上
    assert captured["kwargs"]["proxies"] == {"http": None, "https": None}


def test_list_models_returns_empty_when_endpoint_has_no_such_api(monkeypatch):
    monkeypatch.setattr(ai_client.requests, "get", lambda url, **kw: _FakeResponse(status_code=404, text="nope"))
    config = ai_client.AiConfig(api_key="k")
    assert ai_client.list_models(config) == []


def test_list_models_returns_empty_on_unrecognised_payload(monkeypatch):
    monkeypatch.setattr(ai_client.requests, "get", lambda url, **kw: _FakeResponse(payload={"models": ["a"]}))
    assert ai_client.list_models(ai_client.AiConfig(api_key="k")) == []
    monkeypatch.setattr(ai_client.requests, "get", lambda url, **kw: _FakeResponse(payload=None))
    assert ai_client.list_models(ai_client.AiConfig(api_key="k")) == []


def test_list_models_still_reports_a_bad_key(monkeypatch):
    """密钥不对必须报出来——那种情况聊天也一样用不了，不能悄悄当成"没有列表"。"""
    monkeypatch.setattr(ai_client.requests, "get", lambda url, **kw: _FakeResponse(status_code=401))
    with pytest.raises(ai_client.AiError) as exc:
        ai_client.list_models(ai_client.AiConfig(api_key="wrong"))
    assert exc.value.code == "ai.invalid_api_key"


def test_list_models_requires_a_key_at_all(monkeypatch):
    with pytest.raises(ai_client.AiError) as exc:
        ai_client.list_models(ai_client.AiConfig(api_key=""))
    assert exc.value.code == "ai.not_configured"
