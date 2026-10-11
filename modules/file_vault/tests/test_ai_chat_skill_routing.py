"""backend_server.py AI 对话路径中自动技能检测辅助函数（技能目录、工具调用解析）的纯逻辑测试，
进程内直接调用，不走子进程 BackendClient。

这些用例调用 `_run_ai_chat` 而不是 `rpc_ai_chat`，不要改回去：AI 对话异步化后
`rpc_ai_chat(params, request_id)` 只校验入参并 `submit_batch_task`，返回"已受理"占位；
对话逻辑和结果字典都在 `_run_ai_chat(params)` 里。
"""

import datetime as datetime_module
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import backend_server
from modules.file_vault.ai_skills import Skill


def test_skill_catalog_system_message_is_none_when_no_skills():
    assert backend_server._skill_catalog_system_message([]) is None


def test_skill_catalog_system_message_lists_name_and_description():
    skills = [
        Skill(id="1", name="translator", content="...", description="Translates text."),
        Skill(id="2", name="no-desc", content="...", description=""),
    ]
    message = backend_server._skill_catalog_system_message(skills)

    assert message["role"] == "system"
    assert "- translator: Translates text." in message["content"]
    assert "- no-desc: (no description)" in message["content"]
    assert backend_server._SKILL_TOOL_NAME in message["content"]


def test_skill_tool_schema_declares_the_read_skill_function():
    schema = backend_server._skill_tool_schema()
    assert schema["type"] == "function"
    assert schema["function"]["name"] == backend_server._SKILL_TOOL_NAME
    assert schema["function"]["parameters"]["required"] == ["name"]


def test_skill_tool_call_name_parses_valid_arguments():
    call = {"function": {"arguments": '{"name": "translator"}'}}
    assert backend_server._skill_tool_call_name(call) == "translator"


def test_skill_tool_call_name_tolerates_malformed_arguments():
    assert backend_server._skill_tool_call_name({"function": {"arguments": "not json"}}) == ""


def test_skill_tool_call_name_tolerates_missing_keys():
    assert backend_server._skill_tool_call_name({}) == ""
    assert backend_server._skill_tool_call_name({"function": {}}) == ""


def test_desktop_tool_schemas_expose_only_the_restricted_control_surface():
    tools = backend_server._desktop_tool_schemas()
    names = {tool["function"]["name"] for tool in tools}

    assert {
        "desktop_find_apps",
        "desktop_list_windows",
        "desktop_get_window_state",
        "desktop_launch_app",
        "desktop_click",
        "desktop_type_text",
        "desktop_scroll",
        "desktop_press_key",
    } <= names
    assert "desktop_set_value" in names
    assert "desktop_kill_app" not in names
    assert "desktop_execute_command" not in names
    assert "delivery_mode" not in next(tool for tool in tools if tool["function"]["name"] == "desktop_click")["function"]["parameters"]["properties"]
    assert "delivery_mode" not in next(tool for tool in tools if tool["function"]["name"] == "desktop_set_value")["function"]["parameters"]["properties"]


def test_web_fetch_tool_schema_declares_a_url_only_function():
    schema = backend_server._web_fetch_tool_schema()
    assert schema["type"] == "function"
    assert schema["function"]["name"] == "web_fetch"
    assert schema["function"]["parameters"]["required"] == ["url"]
    assert set(schema["function"]["parameters"]["properties"]) == {"url"}


def test_current_datetime_system_message_grounds_todays_date(monkeypatch):
    class _FixedNow:
        def astimezone(self):
            return datetime_module.datetime(2026, 7, 19, 14, 30, tzinfo=datetime_module.timezone.utc)

    class _FixedDatetime:
        @staticmethod
        def now():
            return _FixedNow()

    monkeypatch.setattr(backend_server, "datetime", _FixedDatetime)

    message = backend_server._current_datetime_system_message()

    assert message["role"] == "system"
    assert "2026-07-19" in message["content"]
    assert "Sunday" in message["content"]


def test_rpc_ai_chat_includes_the_current_datetime_so_it_never_needs_a_tool_for_it(monkeypatch):
    # "今天几号"没有专用工具，不给这个背景模型只能瞎猜或空耗工具调用轮次去找时钟。
    captured = {}

    def fake_chat_with_tools(config, messages, tools):
        captured["messages"] = messages
        return {"content": "no lookup needed", "tool_calls": []}

    monkeypatch.setattr(backend_server, "_resolve_ai_config", lambda _: object())
    monkeypatch.setattr(backend_server.ai_client, "chat_with_tools", fake_chat_with_tools)

    backend_server._run_ai_chat(
        {"messages": [{"role": "system", "content": "Answer in short sentences."}, {"role": "user", "content": "What day is today?"}]}
    )

    system_contents = [m["content"] for m in captured["messages"] if m.get("role") == "system"]
    assert any("Current date and time" in content for content in system_contents)


def test_rpc_ai_chat_always_offers_web_fetch_alongside_desktop_tools(monkeypatch):
    captured_tools = []

    def fake_chat_with_tools(config, messages, tools):
        captured_tools.extend(tools)
        return {"content": "no lookup needed", "tool_calls": []}

    monkeypatch.setattr(backend_server, "_resolve_ai_config", lambda _: object())
    monkeypatch.setattr(backend_server.ai_client, "chat_with_tools", fake_chat_with_tools)

    backend_server._run_ai_chat(
        {"messages": [{"role": "system", "content": "Answer in short sentences."}, {"role": "user", "content": "hi"}]}
    )

    assert "web_fetch" in {tool["function"]["name"] for tool in captured_tools}


def test_rpc_ai_chat_routes_web_fetch_calls_to_web_fetch_and_records_it_as_used(monkeypatch):
    responses = iter(
        [
            {
                "content": None,
                "tool_calls": [
                    {
                        "id": "fetch_1",
                        "type": "function",
                        "function": {"name": "web_fetch", "arguments": '{"url":"http://example.com/quote"}'},
                    }
                ],
            },
            {"content": "The price is 1234.56.", "tool_calls": []},
        ]
    )

    monkeypatch.setattr(backend_server, "_resolve_ai_config", lambda _: object())
    monkeypatch.setattr(backend_server.ai_client, "chat_with_tools", lambda *args: next(responses))
    monkeypatch.setattr(
        backend_server.web_fetch, "fetch", lambda arguments: {"ok": True, "status": 200, "text": "1234.56"}
    )

    result = backend_server._run_ai_chat(
        {
            "messages": [
                {"role": "system", "content": "Answer in short sentences."},
                {"role": "user", "content": "What's the price?"},
            ]
        }
    )

    assert result == {
        "ok": True,
        "reply": "The price is 1234.56.",
        "skills_used": [],
        "tools_used": [],
        "web_fetches": ["http://example.com/quote"],
        "stopped": False,
    }


def test_manual_skill_mode_keeps_desktop_control_available(monkeypatch):
    calls = []
    responses = iter(
        [
            {
                "content": None,
                "tool_calls": [
                    {
                        "id": "desktop_1",
                        "type": "function",
                        "function": {"name": "desktop_find_apps", "arguments": '{"query":"calculator"}'},
                    }
                ],
            },
            {"content": "Calculator is ready.", "tool_calls": []},
        ]
    )

    monkeypatch.setattr(backend_server, "_resolve_ai_config", lambda _: object())
    monkeypatch.setattr(backend_server.ai_client, "chat_with_tools", lambda *args: next(responses))
    monkeypatch.setattr(
        backend_server.desktop_control,
        "execute",
        lambda name, arguments: calls.append((name, arguments)) or {"apps": [{"name": "Calculator", "pid": 1}]},
    )

    result = backend_server._run_ai_chat(
        {"messages": [{"role": "system", "content": "Answer in short sentences."}, {"role": "user", "content": "Open Calculator."}]}
    )

    assert result == {
        "ok": True,
        "reply": "Calculator is ready.",
        "skills_used": [],
        "tools_used": ["desktop_find_apps"],
        "web_fetches": [],
        "stopped": False,
    }
    assert calls == [("desktop_find_apps", {"query": "calculator"})]


def test_ai_chat_marks_stopped_true_only_when_the_tool_round_cap_is_exceeded(monkeypatch):
    # 每轮都返回工具调用，循环必须耗尽 _MAX_SKILL_TOOL_ROUNDS 并回退到强制的最终 chat() 回复；
    # 这是界面"AI 任务已停止"标签唯一名副其实的情形。
    def always_tool_call(*args):
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "desktop_1",
                    "type": "function",
                    "function": {"name": "desktop_find_apps", "arguments": '{"query":"calculator"}'},
                }
            ],
        }

    monkeypatch.setattr(backend_server, "_resolve_ai_config", lambda _: object())
    monkeypatch.setattr(backend_server.ai_client, "chat_with_tools", always_tool_call)
    monkeypatch.setattr(backend_server.ai_client, "chat", lambda *args: "Ran out of rounds.")
    monkeypatch.setattr(
        backend_server.desktop_control,
        "execute",
        lambda name, arguments: {"apps": [{"name": "Calculator", "pid": 1}]},
    )

    result = backend_server._run_ai_chat(
        {"messages": [{"role": "system", "content": "Answer in short sentences."}, {"role": "user", "content": "Open Calculator."}]}
    )

    assert result["ok"] is True
    assert result["stopped"] is True
    assert result["reply"] == "Ran out of rounds."


def test_ai_chat_nudges_the_model_to_conclude_when_the_tool_round_cap_is_exceeded(monkeypatch):
    # 回归：没有这条提示，强制的最终回复会不停叙述一个永远不会执行的下一步（"换个方法试试"），
    # 因为对话里没人告诉模型工具已没了。断言强制回复调用带有说明这一点的 system 消息。
    def always_tool_call(*args):
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "desktop_1",
                    "type": "function",
                    "function": {"name": "desktop_find_apps", "arguments": '{"query":"calculator"}'},
                }
            ],
        }

    captured_final_messages = []

    def fake_chat(config, messages, *args, **kwargs):
        captured_final_messages.extend(messages)
        return "Final answer."

    monkeypatch.setattr(backend_server, "_resolve_ai_config", lambda _: object())
    monkeypatch.setattr(backend_server.ai_client, "chat_with_tools", always_tool_call)
    monkeypatch.setattr(backend_server.ai_client, "chat", fake_chat)
    monkeypatch.setattr(
        backend_server.desktop_control,
        "execute",
        lambda name, arguments: {"apps": [{"name": "Calculator", "pid": 1}]},
    )

    backend_server._run_ai_chat(
        {"messages": [{"role": "system", "content": "Answer in short sentences."}, {"role": "user", "content": "Open Calculator."}]}
    )

    assert captured_final_messages[-1]["role"] == "system"
    assert "no more" in captured_final_messages[-1]["content"].lower()
