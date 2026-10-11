import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto
from modules.file_vault.ai_history import storage


def _connect(tmp_path):
    return storage.connect(tmp_path / "ai_history.db", crypto.generate_key())


def _messages(*pairs):
    """pairs like [("hi", "hello")] -> alternating user/assistant messages."""
    out = []
    for user_text, assistant_text in pairs:
        out.append({"role": "user", "content": user_text})
        out.append({"role": "assistant", "content": assistant_text})
    return out


def test_save_conversation_inserts_new_row_when_no_id_given(tmp_path):
    conn = _connect(tmp_path)
    messages = _messages(("What is 2+2?", "4"))

    conversation_id = storage.save_conversation(conn, messages)

    row = storage.fetch_one(conn, conversation_id)
    assert row["first_question"] == "What is 2+2?"
    assert row["messages"] == messages
    assert row["message_count"] == 2


def test_save_conversation_updates_existing_row_in_place(tmp_path):
    conn = _connect(tmp_path)
    first_id = storage.save_conversation(conn, _messages(("hi", "hello")))

    updated_messages = _messages(("hi", "hello"), ("how are you?", "good"))
    second_id = storage.save_conversation(conn, updated_messages, conversation_id=first_id)

    assert second_id == first_id
    assert len(storage.fetch_list(conn)) == 1
    row = storage.fetch_one(conn, first_id)
    assert row["message_count"] == 4
    assert row["messages"] == updated_messages


def test_save_conversation_falls_back_to_insert_for_unknown_id(tmp_path):
    conn = _connect(tmp_path)
    messages = _messages(("hi", "hello"))

    conversation_id = storage.save_conversation(conn, messages, conversation_id=999999)

    assert storage.fetch_one(conn, conversation_id) is not None
    assert len(storage.fetch_list(conn)) == 1


def test_first_question_ignores_assistant_messages_that_come_first(tmp_path):
    conn = _connect(tmp_path)
    messages = [{"role": "assistant", "content": "greeting"}, {"role": "user", "content": "real question"}]

    conversation_id = storage.save_conversation(conn, messages)

    assert storage.fetch_one(conn, conversation_id)["first_question"] == "real question"


def test_fetch_list_never_includes_full_messages(tmp_path):
    conn = _connect(tmp_path)
    storage.save_conversation(conn, _messages(("hi", "hello")))

    [row] = storage.fetch_list(conn)

    assert "messages" not in row
    assert row["first_question"] == "hi"


def test_fetch_list_orders_newest_first(tmp_path):
    conn = _connect(tmp_path)
    a = storage.save_conversation(conn, _messages(("a", "a-reply")))
    b = storage.save_conversation(conn, _messages(("b", "b-reply")))

    ids = [row["id"] for row in storage.fetch_list(conn)]

    assert ids == [b, a]


def test_fetch_one_missing_id_returns_none(tmp_path):
    conn = _connect(tmp_path)
    assert storage.fetch_one(conn, 999999) is None


def test_delete_bulk_removes_only_given_ids(tmp_path):
    conn = _connect(tmp_path)
    a = storage.save_conversation(conn, _messages(("a", "a-reply")))
    b = storage.save_conversation(conn, _messages(("b", "b-reply")))
    c = storage.save_conversation(conn, _messages(("c", "c-reply")))

    deleted = storage.delete_bulk(conn, [a, c])

    assert deleted == 2
    assert [row["id"] for row in storage.fetch_list(conn)] == [b]


def test_delete_all_removes_every_conversation(tmp_path):
    conn = _connect(tmp_path)
    storage.save_conversation(conn, _messages(("a", "a-reply")))
    storage.save_conversation(conn, _messages(("b", "b-reply")))

    deleted = storage.delete_all(conn)

    assert deleted == 2
    assert storage.fetch_list(conn) == []
