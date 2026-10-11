import base64
import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, passwords

IMK = crypto.generate_key()


# strict-persistence 测试夹具：直接调加密原语手写明文建 vault，独立于被测序列化器。

NAN = float("nan")
POS_INF = float("inf")
NEG_INF = float("-inf")


def _v1_entry() -> dict:
    return {
        "id": "e1",
        "name": "GitHub",
        "url": "https://github.com",
        "username": "me",
        "password": "current-pw",
        "notes": "current notes",
        "created_at": 1.0,
        "updated_at": 2.0,
    }


def _snapshot() -> dict:
    return {
        "name": "GitHub old",
        "url": "https://github.com",
        "username": "me-old",
        "password": "old-pw",
        "notes": "old notes",
        "updated_at": 1.5,
    }


def _v2_entry() -> dict:
    entry = _v1_entry()
    entry["history"] = [_snapshot()]
    return entry


def _envelope_text(imk: bytes, plaintext: bytes, format_version) -> str:
    """独立于序列化器加密明文并返回外层信封 JSON；
    format_version 原样写入（可为任意值，供篡改测试）。"""
    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(imk, fk)
    content_nonce = crypto.random_nonce()
    ciphertext = crypto.aead_encrypt(fk, content_nonce, plaintext)
    blob = {
        "format_version": format_version,
        "fk_wrap": {
            "nonce": base64.b64encode(fk_nonce).decode(),
            "wrapped_fk": base64.b64encode(wrapped_fk).decode(),
        },
        "nonce": base64.b64encode(content_nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
    return json.dumps(blob)


def _write_vault(tmp_path, text: str) -> Path:
    path = passwords.vault_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _write_obj_vault(tmp_path, imk, obj, format_version) -> Path:
    plaintext = json.dumps(obj).encode("utf-8")
    return _write_vault(tmp_path, _envelope_text(imk, plaintext, format_version))


def _write_text_vault(tmp_path, imk, plaintext_text: str, format_version) -> Path:
    return _write_vault(
        tmp_path, _envelope_text(imk, plaintext_text.encode("utf-8"), format_version)
    )


def _assert_rejected_unchanged(tmp_path, imk, expected_code):
    path = passwords.vault_path(tmp_path)
    before = path.read_bytes()
    with pytest.raises(passwords.PasswordVaultError) as exc:
        passwords.load_password_vault(tmp_path, imk)
    assert exc.value.code == expected_code
    assert path.read_bytes() == before


def _inject_dup(obj_text: str, key: str, value_text: str) -> str:
    """Prepend a duplicate key to a JSON object's text (default json.loads
    keeps the LAST duplicate; a strict parser must reject it)."""
    assert obj_text.startswith("{")
    return "{" + json.dumps(key) + ": " + value_text + ", " + obj_text[1:]


WRONG_TEXT_VALUES = [None, True, 5, [1], {"a": 1}]
WRONG_TIME_VALUES = [None, True, "x", [1], {"a": 1}, NAN, POS_INF, NEG_INF]
WRONG_TOP_LEVEL = [None, True, 5, "s", {"a": 1}]
WRONG_ARRAY_ITEM = [None, True, 5, "s", [1]]


def test_new_entry_generates_unique_id_and_timestamps(monkeypatch):
    monkeypatch.setattr(passwords.time, "time", lambda: 123.0)
    e1 = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")
    e2 = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")
    assert e1.id != e2.id
    assert e1.created_at == e1.updated_at == 123.0
    assert e2.created_at == e2.updated_at == 123.0


def test_new_entry_reads_clock_once(monkeypatch):
    calls = []

    def fake_time():
        calls.append(None)
        return 123.0

    monkeypatch.setattr(passwords.time, "time", fake_time)
    entry = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")

    assert entry.created_at == entry.updated_at == 123.0
    assert len(calls) == 1


def test_save_and_load_vault_round_trip(tmp_path):
    entries = [
        passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2"),
        passwords.new_entry(name="Email", url="https://mail.example.com", username="me@example.com", password="p@ss"),
    ]
    passwords.save_password_vault(tmp_path, entries, IMK)

    loaded = passwords.load_password_vault(tmp_path, IMK)
    assert len(loaded) == 2
    assert loaded[0].name == "GitHub"
    assert loaded[1].password == "p@ss"


def test_save_and_load_vault_preserves_ordered_history_snapshots(tmp_path):
    entry = passwords.PasswordEntry(
        id="entry-id",
        name="Current",
        url="https://current.example",
        username="current-user",
        password="current-password",
        notes="current notes",
        created_at=10.0,
        updated_at=30.0,
        history=[
            passwords.PasswordHistorySnapshot(
                name="Newest prior",
                url="https://newest.example",
                username="newest-user",
                password="newest-password",
                notes="newest notes",
                updated_at=20.0,
            ),
            passwords.PasswordHistorySnapshot(
                name="Oldest prior",
                url="https://oldest.example",
                username="oldest-user",
                password="oldest-password",
                notes="oldest notes",
                updated_at=10.0,
            ),
        ],
    )
    passwords.save_password_vault(tmp_path, [entry], IMK)

    loaded = passwords.load_password_vault(tmp_path, IMK)

    assert [
        (snapshot.name, snapshot.url, snapshot.username, snapshot.password, snapshot.notes, snapshot.updated_at)
        for snapshot in loaded[0].history
    ] == [
        ("Newest prior", "https://newest.example", "newest-user", "newest-password", "newest notes", 20.0),
        ("Oldest prior", "https://oldest.example", "oldest-user", "oldest-password", "oldest notes", 10.0),
    ]


def test_load_password_vault_returns_empty_list_when_file_missing(tmp_path):
    assert passwords.load_password_vault(tmp_path, IMK) == []


def test_load_password_vault_wrong_imk_raises(tmp_path):
    entries = [passwords.new_entry(name="X", url="https://x.example", username="u", password="p")]
    passwords.save_password_vault(tmp_path, entries, IMK)

    wrong_imk = crypto.generate_key()
    with pytest.raises(passwords.PasswordVaultError):
        passwords.load_password_vault(tmp_path, wrong_imk)


def test_entry_updated_keeps_id_and_created_at_but_bumps_updated_at(monkeypatch):
    timestamps = iter((100.0, 200.0))
    monkeypatch.setattr(passwords.time, "time", lambda: next(timestamps))
    original = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="old")
    changed = original.updated(name="GitHub", url="https://github.com", username="me", password="new")
    assert changed.id == original.id
    assert changed.created_at == original.created_at
    assert changed.password == "new"
    assert changed.updated_at == 200.0


def test_entry_updated_uses_one_snapshot_and_preserves_original_state(monkeypatch):
    timestamps = iter((100.0, 200.0))
    monkeypatch.setattr(passwords.time, "time", lambda: next(timestamps))
    original = passwords.new_entry(
        name="GitHub", url="https://github.com", username="me", password="old", notes="original"
    )

    changed = original.updated(
        name="GitHub Enterprise", url="https://github.com", username="me2", password="new", notes="changed"
    )

    assert changed.updated_at == 200.0
    assert len(changed.history) == 1
    snapshot = changed.history[0]
    assert (snapshot.name, snapshot.url, snapshot.username, snapshot.password, snapshot.notes, snapshot.updated_at) == (
        "GitHub", "https://github.com", "me", "old", "original", 100.0,
    )
    assert original.password == "old"
    assert original.notes == "original"
    assert original.history == []


def test_entry_updated_returns_self_for_exact_noop(monkeypatch):
    monkeypatch.setattr(passwords.time, "time", lambda: 100.0)
    original = passwords.new_entry(
        name="GitHub", url="https://github.com", username="me", password="old", notes="original"
    )
    def forbidden_time():
        raise AssertionError("clock read")

    monkeypatch.setattr(passwords.time, "time", forbidden_time)

    unchanged = original.updated(
        name="GitHub", url="https://github.com", username="me", password="old", notes="original"
    )

    assert unchanged is original


def test_entry_history_is_newest_first_even_when_clock_moves_backward(monkeypatch):
    timestamps = iter((100.0, 200.0, 50.0))
    monkeypatch.setattr(passwords.time, "time", lambda: next(timestamps))
    entry = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="v1")
    entry = entry.updated(name="GitHub", url="https://github.com", username="me", password="v2")
    entry = entry.updated(name="GitHub", url="https://github.com", username="me", password="v3")

    assert [snapshot.password for snapshot in entry.history] == ["v2", "v1"]
    assert [snapshot.updated_at for snapshot in entry.history] == [200.0, 100.0]


def test_entry_history_keeps_at_most_five_snapshots(monkeypatch):
    timestamps = iter(range(10))
    monkeypatch.setattr(passwords.time, "time", lambda: float(next(timestamps)))
    entry = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="v0")
    for version in range(1, 7):
        entry = entry.updated(
            name="GitHub", url="https://github.com", username="me", password=f"v{version}"
        )

    assert len(entry.history) == 5
    assert [snapshot.password for snapshot in entry.history] == ["v5", "v4", "v3", "v2", "v1"]


def test_find_duplicate_ids_returns_empty_when_no_duplicates():
    entries = [
        passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2"),
        passwords.new_entry(name="Email", url="https://mail.example.com", username="me", password="p@ss"),
    ]
    assert passwords.find_duplicate_ids(entries) == []


def test_find_duplicate_ids_requires_all_five_fields_to_match():
    # 只有密码相同、其余不同不算重复 - 必须五项（名称/网址/用户名/密码/
    # 备注）全部一致才算。
    entries = [
        passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2"),
        passwords.new_entry(name="GitLab", url="https://gitlab.com", username="me", password="hunter2"),
    ]
    assert passwords.find_duplicate_ids(entries) == []


def test_find_duplicate_ids_detects_exact_five_field_matches():
    original = passwords.new_entry(
        name="GitHub", url="https://github.com", username="me", password="hunter2", notes="work account"
    )
    exact_duplicate = passwords.new_entry(
        name="GitHub", url="https://github.com", username="me", password="hunter2", notes="work account"
    )
    unrelated = passwords.new_entry(name="Email", url="https://mail.example.com", username="me", password="p@ss")
    entries = [original, exact_duplicate, unrelated]

    duplicate_ids = passwords.find_duplicate_ids(entries)
    assert duplicate_ids == [exact_duplicate.id]  # keeps the first-seen (original), flags the later one


def test_find_duplicate_ids_handles_groups_of_three_or_more():
    e1 = passwords.new_entry(name="X", url="https://x.example", username="u", password="p")
    e2 = passwords.new_entry(name="X", url="https://x.example", username="u", password="p")
    e3 = passwords.new_entry(name="X", url="https://x.example", username="u", password="p")
    duplicate_ids = passwords.find_duplicate_ids([e1, e2, e3])
    assert set(duplicate_ids) == {e2.id, e3.id}
    assert e1.id not in duplicate_ids


# --- history-aware destructive dedupe (Task 3) -----------------------------


def test_find_duplicate_ids_preserves_entries_with_distinct_history():
    # 当前五项一致但历史快照不同：破坏性"去重"会丢掉独有的历史密码，不能当重复。
    current = dict(name="GitHub", url="https://github.com", username="me", password="current", notes="n")
    e1 = passwords.PasswordEntry(
        id="a", created_at=1.0, updated_at=9.0,
        history=[passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me", password="old-A", notes="n", updated_at=2.0)],
        **current,
    )
    e2 = passwords.PasswordEntry(
        id="b", created_at=1.0, updated_at=9.0,
        history=[passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me", password="old-B", notes="n", updated_at=2.0)],
        **current,
    )
    assert passwords.find_duplicate_ids([e1, e2]) == []


def test_find_duplicate_ids_flags_entries_with_identical_current_and_history():
    # 当前五项一致，并且完整历史（顺序与内容都等价）也一致时，才算真正的
    # 重复，保留第一条、标记其余。
    def snap():
        return passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me", password="old", notes="n", updated_at=2.0)

    current = dict(name="GitHub", url="https://github.com", username="me", password="current", notes="n",
                   created_at=1.0, updated_at=9.0)
    e1 = passwords.PasswordEntry(id="a", history=[snap()], **current)
    e2 = passwords.PasswordEntry(id="b", history=[snap()], **current)
    unrelated = passwords.new_entry(name="Email", url="https://mail.example.com", username="me", password="p@ss")

    assert passwords.find_duplicate_ids([e1, e2, unrelated]) == ["b"]


def test_find_exact_match_stays_current_field_only_ignoring_history():
    # 精确重复判定只看当前五项，与历史无关；重新导入 CSV 不能因历史不同而重复插入。
    existing = passwords.PasswordEntry(
        id="a", name="GitHub", url="https://github.com", username="me", password="current", notes="n",
        created_at=1.0, updated_at=9.0,
        history=[passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me", password="old", notes="n", updated_at=2.0)],
    )
    match = passwords.find_exact_match(
        [existing], name="GitHub", url="https://github.com", username="me", password="current", notes="n")
    assert match is existing


# --- account_key / find_account_match (M2: URL+username account identity) -


def test_account_key_ignores_scheme_path_query_and_case():
    assert passwords.account_key("https://GitHub.com/login?x=1", "me") == passwords.account_key(
        "http://github.com", "me"
    )


def test_account_key_ignores_trailing_slash_and_www_free_host():
    assert passwords.account_key("https://github.com/", "me") == passwords.account_key("github.com", "me")


def test_account_key_treats_different_hostnames_as_different_accounts():
    assert passwords.account_key("https://github.com", "me") != passwords.account_key("https://gitlab.com", "me")


def test_account_key_strips_username_whitespace_but_preserves_case():
    assert passwords.account_key("https://github.com", "  me  ") == passwords.account_key("https://github.com", "me")
    # Case is NOT folded - "me" and "Me" are treated as different accounts to
    # avoid a false-positive cross-account match.
    assert passwords.account_key("https://github.com", "me") != passwords.account_key("https://github.com", "Me")


def test_find_account_match_ignores_password_name_and_notes():
    existing = passwords.new_entry(
        name="GitHub", url="https://github.com", username="me", password="old-pw", notes="old note"
    )
    match = passwords.find_account_match([existing], url="https://github.com/settings", username="me")
    assert match is existing


def test_find_account_match_returns_none_for_different_username():
    existing = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="pw")
    assert passwords.find_account_match([existing], url="https://github.com", username="someone-else") is None


def test_find_account_match_returns_none_for_different_host():
    existing = passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="pw")
    assert passwords.find_account_match([existing], url="https://gitlab.com", username="me") is None


def test_find_account_match_returns_none_when_entries_empty():
    assert passwords.find_account_match([], url="https://github.com", username="me") is None


# --- plan_csv_import / apply_csv_import_plan (M3: import preview/confirm) -


def _candidate(name="X", url="https://x.example", username="u", password="p", notes=""):
    return passwords.new_entry(name=name, url=url, username=username, password=password, notes=notes)


def test_plan_csv_import_classifies_new_account_as_add():
    plan = passwords.plan_csv_import([], [_candidate()])
    assert len(plan) == 1
    assert plan[0].action == "add"
    assert plan[0].match_id is None


def test_plan_csv_import_classifies_identical_existing_account_as_unchanged():
    existing = passwords.new_entry(name="X", url="https://x.example", username="u", password="p", notes="")
    plan = passwords.plan_csv_import([existing], [_candidate()])
    assert plan[0].action == "unchanged"
    assert plan[0].match_id == existing.id


def test_plan_csv_import_classifies_same_account_different_password_as_update():
    existing = passwords.new_entry(name="X", url="https://x.example", username="u", password="old-pw", notes="")
    plan = passwords.plan_csv_import([existing], [_candidate(password="new-pw")])
    assert plan[0].action == "update"
    assert plan[0].match_id == existing.id


def test_plan_csv_import_matches_account_ignoring_url_scheme_and_case():
    existing = passwords.new_entry(name="X", url="https://X.example/", username="u", password="old-pw")
    plan = passwords.plan_csv_import([existing], [_candidate(url="x.example", password="new-pw")])
    assert plan[0].action == "update"


def test_plan_csv_import_collapses_duplicate_accounts_within_same_csv():
    # 同一份 CSV 里两行同账号 - 只有最后一行参与新增/更新判定，前面的行标记
    # 为 superseded_in_batch 并指向最后一行。
    candidates = [
        _candidate(password="v1"),
        _candidate(password="v2"),
        _candidate(password="v3"),
    ]
    plan = passwords.plan_csv_import([], candidates)
    assert plan[0].action == "superseded_in_batch"
    assert plan[0].superseded_by == 2
    assert plan[1].action == "superseded_in_batch"
    assert plan[1].superseded_by == 2
    assert plan[2].action == "add"


def test_plan_csv_import_100_rows_with_10_repeated_accounts_are_updates():
    # 验收标准：100条含10条同网址同用户名数据，系统能准确识别为更新。
    existing = [
        passwords.new_entry(name=f"Site{i}", url=f"https://site{i}.example", username="u", password="old")
        for i in range(10)
    ]
    candidates = [
        _candidate(name=f"Site{i}", url=f"https://site{i}.example", username="u", password="new")
        for i in range(10)
    ] + [
        _candidate(name=f"New{i}", url=f"https://new{i}.example", username="u", password="p")
        for i in range(90)
    ]
    plan = passwords.plan_csv_import(existing, candidates)
    assert sum(1 for r in plan if r.action == "update") == 10
    assert sum(1 for r in plan if r.action == "add") == 90
    assert {r.match_id for r in plan if r.action == "update"} == {e.id for e in existing}


def test_apply_csv_import_plan_creates_new_entry_for_selected_add_row():
    plan = passwords.plan_csv_import([], [_candidate()])
    entries = []
    added, updated = passwords.apply_csv_import_plan(entries, plan, [0])
    assert (added, updated) == (1, 0)
    assert len(entries) == 1
    assert entries[0].password == "p"


def test_apply_csv_import_plan_updates_matched_entry_and_records_history():
    existing = passwords.new_entry(name="X", url="https://x.example", username="u", password="old-pw")
    entries = [existing]
    plan = passwords.plan_csv_import(entries, [_candidate(password="new-pw")])
    added, updated = passwords.apply_csv_import_plan(entries, plan, [0])
    assert (added, updated) == (0, 1)
    assert len(entries) == 1
    assert entries[0].id == existing.id  # same account, not a new row
    assert entries[0].password == "new-pw"
    assert entries[0].history[0].password == "old-pw"


def test_apply_csv_import_plan_skips_unselected_rows():
    plan = passwords.plan_csv_import([], [_candidate()])
    entries = []
    added, updated = passwords.apply_csv_import_plan(entries, plan, [])
    assert (added, updated) == (0, 0)
    assert entries == []


def test_apply_csv_import_plan_skips_unchanged_and_superseded_rows_even_if_selected():
    existing = passwords.new_entry(name="X", url="https://x.example", username="u", password="p")
    entries = [existing]
    candidates = [_candidate(password="v1"), _candidate(password="p")]  # row0 superseded, row1 unchanged
    plan = passwords.plan_csv_import(entries, candidates)
    added, updated = passwords.apply_csv_import_plan(entries, plan, [0, 1])
    assert (added, updated) == (0, 0)
    assert entries == [existing]


def test_export_csv_emits_only_current_fields_for_entry_with_history(tmp_path):
    # 导出永远只写每条主记录的当前值，一条一行，绝不导出历史旧密码。
    entry = passwords.PasswordEntry(
        id="a", name="GitHub", url="https://github.com", username="me", password="current-pw", notes="n",
        created_at=1.0, updated_at=9.0,
        history=[passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me", password="old-secret", notes="n", updated_at=2.0)],
    )
    out_path = tmp_path / "export.csv"
    passwords.export_csv(out_path, [entry])

    # utf-8-sig strips the BOM on read, same as Excel/Chrome do - the BOM
    # itself is covered separately by test_export_csv_writes_utf8_bom.
    content = out_path.read_text(encoding="utf-8-sig")
    lines = content.strip().splitlines()
    assert lines[0] == "name,url,username,password"
    assert lines[1] == "GitHub,https://github.com,me,current-pw"
    assert len(lines) == 2  # header + one current row, no history rows
    assert "old-secret" not in content


def test_load_password_vault_rejects_unsupported_format_version(tmp_path):
    entries = [passwords.new_entry(name="X", url="https://x.example", username="u", password="p")]
    passwords.save_password_vault(tmp_path, entries, IMK)

    path = passwords.vault_path(tmp_path)
    blob = json.loads(path.read_text(encoding="utf-8"))
    blob["format_version"] = 999
    path.write_text(json.dumps(blob), encoding="utf-8")

    with pytest.raises(passwords.PasswordVaultError):
        passwords.load_password_vault(tmp_path, IMK)


def test_parse_csv_chrome_format(tmp_path):
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com/login,me,hunter2\n",
        encoding="utf-8",
    )
    entries = passwords.parse_csv(csv_path)
    assert len(entries) == 1
    assert entries[0].name == "GitHub"
    assert entries[0].url == "https://github.com/login"
    assert entries[0].username == "me"
    assert entries[0].password == "hunter2"


def test_parse_csv_firefox_format_without_name_column_falls_back_to_hostname(tmp_path):
    csv_path = tmp_path / "firefox_logins.csv"
    csv_path.write_text(
        "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\n"
        "https://example.com/login,me,hunter2,,https://example.com,{abc},0,0,0\n",
        encoding="utf-8",
    )
    entries = passwords.parse_csv(csv_path)
    assert len(entries) == 1
    assert entries[0].name == "example.com"
    assert entries[0].username == "me"


def test_parse_csv_missing_required_column_raises(tmp_path):
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("name,url\nGitHub,https://github.com\n", encoding="utf-8")
    with pytest.raises(passwords.PasswordVaultError):
        passwords.parse_csv(csv_path)


def test_parse_csv_gb18030_encoded_file_falls_back_and_decodes(tmp_path):
    # Excel"另存为 CSV"在中文 Windows 默认写 GBK，utf-8-sig 解码会报错，必须兜底到 gb18030。
    csv_path = tmp_path / "gbk_passwords.csv"
    csv_path.write_bytes(
        "name,url,username,password\n网站,https://example.com,用户,密码123\n".encode("gb18030")
    )
    entries = passwords.parse_csv(csv_path)
    assert len(entries) == 1
    assert entries[0].name == "网站"
    assert entries[0].username == "用户"
    assert entries[0].password == "密码123"


def test_parse_csv_undecodable_under_any_fallback_raises_bad_encoding(tmp_path):
    csv_path = tmp_path / "undecodable.csv"
    # \xff\xfe is not valid under utf-8-sig OR gb18030 (verified directly
    # against Python's codecs before writing this test).
    csv_path.write_bytes(b"name,url,username,password\n\xff\xfe,https://x.example,u,p\n")
    with pytest.raises(passwords.PasswordVaultError) as exc:
        passwords.parse_csv(csv_path)
    assert exc.value.code == "password.csv_bad_encoding"


def test_export_csv_writes_chrome_compatible_format(tmp_path):
    entries = [passwords.new_entry(name="GitHub", url="https://github.com", username="me", password="hunter2")]
    out_path = tmp_path / "export.csv"
    passwords.export_csv(out_path, entries)

    content = out_path.read_text(encoding="utf-8-sig")
    lines = content.strip().splitlines()
    assert lines[0] == "name,url,username,password"
    assert lines[1] == "GitHub,https://github.com,me,hunter2"


def test_export_csv_writes_utf8_bom_for_excel_compat(tmp_path):
    # 无 BOM 的 UTF-8 CSV 在中文 Windows 的 Excel 里会乱码，BOM 明确标识 UTF-8；
    # Chrome/Edge 导入会透明去掉 BOM，不影响本模块 parse_csv 的往返。
    entries = [passwords.new_entry(name="邮箱账号", url="https://example.com", username="用户", password="hunter2")]
    out_path = tmp_path / "export.csv"
    passwords.export_csv(out_path, entries)

    raw = out_path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")

    reparsed = passwords.parse_csv(out_path)
    assert reparsed[0].name == "邮箱账号"
    assert reparsed[0].username == "用户"


# Task 2：严格持久化、迁移与降级保护

# --- Behaviour & migration -------------------------------------------------


def test_load_literal_v1_vault_fixture_defaults_history_empty(tmp_path):
    _write_obj_vault(tmp_path, IMK, [_v1_entry()], 1)

    loaded = passwords.load_password_vault(tmp_path, IMK)

    assert len(loaded) == 1
    entry = loaded[0]
    assert entry.id == "e1"
    assert entry.name == "GitHub"
    assert entry.password == "current-pw"
    assert entry.created_at == 1.0
    assert entry.updated_at == 2.0
    assert entry.history == []


def test_load_literal_v1_vault_is_byte_identical_read_only(tmp_path):
    path = _write_obj_vault(tmp_path, IMK, [_v1_entry()], 1)
    before = path.read_bytes()

    passwords.load_password_vault(tmp_path, IMK)

    assert path.read_bytes() == before


def test_v1_vault_load_update_save_migrates_to_format_version_2(tmp_path):
    path = _write_obj_vault(tmp_path, IMK, [_v1_entry()], 1)
    before = path.read_bytes()

    loaded = passwords.load_password_vault(tmp_path, IMK)
    # Load alone must not migrate/rewrite the file.
    assert path.read_bytes() == before

    updated = loaded[0].updated(
        name="GitHub", url="https://github.com", username="me", password="new-pw", notes="current notes"
    )
    passwords.save_password_vault(tmp_path, [updated], IMK)

    # Outer envelope is now version 2.
    envelope = json.loads(path.read_text(encoding="utf-8"))
    assert envelope["format_version"] == 2

    reloaded = passwords.load_password_vault(tmp_path, IMK)
    assert reloaded[0].password == "new-pw"
    assert len(reloaded[0].history) == 1
    snap = reloaded[0].history[0]
    # The pre-update v1 current state is preserved as the newest history snapshot.
    assert (snap.name, snap.url, snap.username, snap.password, snap.notes, snap.updated_at) == (
        "GitHub", "https://github.com", "me", "current-pw", "current notes", 2.0,
    )


def test_v2_vault_round_trip_restores_snapshot_objects(tmp_path):
    _write_obj_vault(tmp_path, IMK, [_v2_entry()], 2)

    loaded = passwords.load_password_vault(tmp_path, IMK)

    assert len(loaded[0].history) == 1
    snap = loaded[0].history[0]
    assert isinstance(snap, passwords.PasswordHistorySnapshot)
    assert (snap.name, snap.password, snap.updated_at) == ("GitHub old", "old-pw", 1.5)


def test_v2_vault_missing_history_defaults_to_empty_list(tmp_path):
    _write_obj_vault(tmp_path, IMK, [_v1_entry()], 2)  # v1 field set under version 2 = no history key

    loaded = passwords.load_password_vault(tmp_path, IMK)

    assert loaded[0].history == []


def test_downgrade_tampering_rejected_and_file_unchanged(tmp_path):
    # 保存带历史的 v2 vault 后只把外层（未认证）format_version 改成 1：
    # 按 v1 加载必须被拒绝且不改写文件。
    entry = passwords.PasswordEntry(
        id="e1", name="GitHub", url="https://github.com", username="me",
        password="current-pw", notes="n", created_at=1.0, updated_at=2.0,
        history=[passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me",
            password="old-pw", notes="n", updated_at=1.5)],
    )
    passwords.save_password_vault(tmp_path, [entry], IMK)
    path = passwords.vault_path(tmp_path)
    blob = json.loads(path.read_text(encoding="utf-8"))
    blob["format_version"] = 1
    path.write_text(json.dumps(blob), encoding="utf-8")

    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_wrong_imk_still_reports_key_mismatch_on_v2_vault(tmp_path):
    _write_obj_vault(tmp_path, IMK, [_v2_entry()], 2)
    wrong = crypto.generate_key()
    with pytest.raises(passwords.PasswordVaultError) as exc:
        passwords.load_password_vault(tmp_path, wrong)
    assert exc.value.code == "password.key_mismatch"


# --- Envelope / version validation (password.invalid_format) ---------------


@pytest.mark.parametrize(
    "version_value",
    [None, True, False, 1.0, 2.0, NAN, POS_INF, NEG_INF, "1", "2", [1], {"a": 1}],
)
def test_envelope_format_version_invalid_type_rejected(tmp_path, version_value):
    _write_obj_vault(tmp_path, IMK, [_v1_entry()], version_value)
    _assert_rejected_unchanged(tmp_path, IMK, "password.invalid_format")


@pytest.mark.parametrize("version_value", [0, 3, 999, -1])
def test_envelope_format_version_unsupported_integer_rejected(tmp_path, version_value):
    _write_obj_vault(tmp_path, IMK, [_v1_entry()], version_value)
    _assert_rejected_unchanged(tmp_path, IMK, "password.unsupported_format_version")


def test_envelope_format_version_unsupported_does_not_attempt_decrypt(tmp_path):
    # Ciphertext is garbage; an unsupported version must be rejected before
    # any decryption is attempted (so we get unsupported, not key_mismatch).
    blob = {
        "format_version": 3,
        "fk_wrap": {"nonce": base64.b64encode(b"x" * 12).decode(),
                    "wrapped_fk": base64.b64encode(b"y" * 48).decode()},
        "nonce": base64.b64encode(b"z" * 12).decode(),
        "ciphertext": base64.b64encode(b"garbage").decode(),
    }
    _write_vault(tmp_path, json.dumps(blob))
    _assert_rejected_unchanged(tmp_path, IMK, "password.unsupported_format_version")


def test_envelope_format_version_missing_rejected(tmp_path):
    plaintext = json.dumps([_v1_entry()]).encode("utf-8")
    fk = crypto.generate_key()
    fk_nonce, wrapped_fk = crypto.wrap_key(IMK, fk)
    content_nonce = crypto.random_nonce()
    ciphertext = crypto.aead_encrypt(fk, content_nonce, plaintext)
    blob = {
        "fk_wrap": {"nonce": base64.b64encode(fk_nonce).decode(),
                    "wrapped_fk": base64.b64encode(wrapped_fk).decode()},
        "nonce": base64.b64encode(content_nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }
    _write_vault(tmp_path, json.dumps(blob))
    _assert_rejected_unchanged(tmp_path, IMK, "password.invalid_format")


def test_envelope_format_duplicate_format_version_key_rejected(tmp_path):
    text = _envelope_text(IMK, json.dumps([_v1_entry()]).encode("utf-8"), 2)
    dup = _inject_dup(text, "format_version", "2")
    _write_vault(tmp_path, dup)
    _assert_rejected_unchanged(tmp_path, IMK, "password.invalid_format")


def test_envelope_format_duplicate_other_key_rejected(tmp_path):
    text = _envelope_text(IMK, json.dumps([_v1_entry()]).encode("utf-8"), 2)
    dup = _inject_dup(text, "nonce", '"AAAA"')
    _write_vault(tmp_path, dup)
    _assert_rejected_unchanged(tmp_path, IMK, "password.invalid_format")


def test_envelope_format_not_json_object_rejected(tmp_path):
    _write_vault(tmp_path, json.dumps([1, 2, 3]))
    _assert_rejected_unchanged(tmp_path, IMK, "password.invalid_format")


# --- v1 entry schema (password.content_corrupted) --------------------------


@pytest.mark.parametrize("field", list(_v1_entry().keys()))
def test_load_v1_schema_missing_required_field_rejected(tmp_path, field):
    entry = _v1_entry()
    del entry[field]
    _write_obj_vault(tmp_path, IMK, [entry], 1)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_load_v1_schema_unexpected_field_rejected(tmp_path):
    entry = _v1_entry()
    entry["unexpected"] = "x"
    _write_obj_vault(tmp_path, IMK, [entry], 1)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_load_v1_schema_rejects_history_field(tmp_path):
    entry = _v1_entry()
    entry["history"] = []
    _write_obj_vault(tmp_path, IMK, [entry], 1)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- v2 entry schema -------------------------------------------------------


@pytest.mark.parametrize("field", list(_v1_entry().keys()))
def test_load_v2_schema_missing_required_field_rejected(tmp_path, field):
    entry = _v2_entry()
    del entry[field]
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_load_v2_schema_unexpected_field_rejected(tmp_path):
    entry = _v2_entry()
    entry["unexpected"] = "x"
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- snapshot schema -------------------------------------------------------


@pytest.mark.parametrize("field", list(_snapshot().keys()))
def test_load_snapshot_schema_missing_required_field_rejected(tmp_path, field):
    entry = _v2_entry()
    del entry["history"][0][field]
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_load_snapshot_schema_unexpected_field_rejected(tmp_path):
    entry = _v2_entry()
    entry["history"][0]["unexpected"] = "x"
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_load_snapshot_schema_rejects_nested_history(tmp_path):
    entry = _v2_entry()
    entry["history"][0]["history"] = []
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- text field wrong types ------------------------------------------------


@pytest.mark.parametrize("field", ["id", "name", "url", "username", "password", "notes"])
@pytest.mark.parametrize("value", WRONG_TEXT_VALUES)
def test_load_schema_entry_text_field_wrong_type_rejected(tmp_path, field, value):
    entry = _v2_entry()
    entry[field] = value
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


@pytest.mark.parametrize("field", ["name", "url", "username", "password", "notes"])
@pytest.mark.parametrize("value", WRONG_TEXT_VALUES)
def test_load_schema_snapshot_text_field_wrong_type_rejected(tmp_path, field, value):
    entry = _v2_entry()
    entry["history"][0][field] = value
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- time field wrong types ------------------------------------------------


@pytest.mark.parametrize("field", ["created_at", "updated_at"])
@pytest.mark.parametrize("value", WRONG_TIME_VALUES)
def test_load_schema_entry_time_field_wrong_type_rejected(tmp_path, field, value):
    entry = _v2_entry()
    entry[field] = value
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


@pytest.mark.parametrize("value", WRONG_TIME_VALUES)
def test_load_schema_snapshot_time_field_wrong_type_rejected(tmp_path, value):
    entry = _v2_entry()
    entry["history"][0]["updated_at"] = value
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- top-level & array item shapes -----------------------------------------


@pytest.mark.parametrize("value", WRONG_TOP_LEVEL)
def test_load_schema_top_level_wrong_shape_rejected(tmp_path, value):
    _write_obj_vault(tmp_path, IMK, value, 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


@pytest.mark.parametrize("value", WRONG_ARRAY_ITEM)
def test_load_schema_array_item_wrong_shape_rejected(tmp_path, value):
    _write_obj_vault(tmp_path, IMK, [value], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


@pytest.mark.parametrize("value", WRONG_ARRAY_ITEM)
def test_load_schema_history_item_wrong_shape_rejected(tmp_path, value):
    entry = _v2_entry()
    entry["history"] = [value]
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- history shape/length --------------------------------------------------


@pytest.mark.parametrize("length", [0, 1, 5])
def test_load_schema_v2_history_valid_lengths_accepted(tmp_path, length):
    entry = _v1_entry()
    entry["history"] = [_snapshot() for _ in range(length)]
    _write_obj_vault(tmp_path, IMK, [entry], 2)

    loaded = passwords.load_password_vault(tmp_path, IMK)
    assert len(loaded[0].history) == length


@pytest.mark.parametrize("value", [None, True, 5, "x", {"a": 1}])
def test_load_schema_v2_history_wrong_type_rejected(tmp_path, value):
    entry = _v1_entry()
    entry["history"] = value
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


def test_load_schema_v2_history_too_long_rejected(tmp_path):
    entry = _v1_entry()
    entry["history"] = [_snapshot() for _ in range(6)]
    _write_obj_vault(tmp_path, IMK, [entry], 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- duplicate keys in decrypted content -----------------------------------


@pytest.mark.parametrize(
    "key,value_text",
    [("password", '"dup"'), ("updated_at", "9"), ("history", "[]"), ("name", '"dup"')],
)
def test_load_schema_duplicate_entry_keys_rejected(tmp_path, key, value_text):
    entry_text = json.dumps(_v2_entry())
    dup_entry = _inject_dup(entry_text, key, value_text)
    _write_text_vault(tmp_path, IMK, "[" + dup_entry + "]", 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


@pytest.mark.parametrize(
    "key,value_text",
    [("password", '"dup"'), ("updated_at", "9"), ("name", '"dup"')],
)
def test_load_schema_duplicate_snapshot_keys_rejected(tmp_path, key, value_text):
    snap_text = json.dumps(_snapshot())
    dup_snap = _inject_dup(snap_text, key, value_text)
    entry_text = json.dumps(_v1_entry())
    entry_with_hist = entry_text[:-1] + ', "history": [' + dup_snap + "]}"
    _write_text_vault(tmp_path, IMK, "[" + entry_with_hist + "]", 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# --- invalid decrypted JSON / duplicate at envelope handled above ----------


def test_load_schema_corrupt_plaintext_not_json_rejected(tmp_path):
    _write_text_vault(tmp_path, IMK, "this is not json", 2)
    _assert_rejected_unchanged(tmp_path, IMK, "password.content_corrupted")


# 保存侧校验矩阵：非法内存对象写盘前必须被拒绝


def _good_entry() -> passwords.PasswordEntry:
    return passwords.PasswordEntry(
        id="e1", name="GitHub", url="https://github.com", username="me",
        password="pw", notes="n", created_at=1.0, updated_at=2.0,
        history=[passwords.PasswordHistorySnapshot(
            name="GitHub", url="https://github.com", username="me",
            password="old", notes="n", updated_at=1.5)],
    )


@pytest.mark.parametrize("field", ["id", "name", "url", "username", "password", "notes"])
@pytest.mark.parametrize("value", WRONG_TEXT_VALUES)
def test_save_schema_entry_text_field_wrong_type_rejected(field, value):
    entry = _good_entry()
    setattr(entry, field, value)
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


@pytest.mark.parametrize("field", ["created_at", "updated_at"])
@pytest.mark.parametrize("value", WRONG_TIME_VALUES)
def test_save_schema_entry_time_field_wrong_type_rejected(field, value):
    entry = _good_entry()
    setattr(entry, field, value)
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


@pytest.mark.parametrize("field", ["name", "url", "username", "password", "notes"])
@pytest.mark.parametrize("value", WRONG_TEXT_VALUES)
def test_save_schema_snapshot_text_field_wrong_type_rejected(field, value):
    entry = _good_entry()
    entry.history = [passwords.PasswordHistorySnapshot(
        name="GitHub", url="https://github.com", username="me",
        password="old", notes="n", updated_at=1.5)]
    object.__setattr__(entry.history[0], field, value)
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


@pytest.mark.parametrize("value", WRONG_TIME_VALUES)
def test_save_schema_snapshot_time_field_wrong_type_rejected(value):
    entry = _good_entry()
    entry.history = [passwords.PasswordHistorySnapshot(
        name="GitHub", url="https://github.com", username="me",
        password="old", notes="n", updated_at=1.5)]
    object.__setattr__(entry.history[0], "updated_at", value)
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


@pytest.mark.parametrize("value", [None, True, 5, "x", {"a": 1}])
def test_save_schema_history_wrong_type_rejected(value):
    entry = _good_entry()
    entry.history = value
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


def test_save_schema_history_too_long_rejected():
    entry = _good_entry()
    entry.history = [passwords.PasswordHistorySnapshot(
        name="G", url="u", username="me", password="p", notes="n", updated_at=1.0)
        for _ in range(6)]
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


def test_save_schema_history_item_wrong_shape_rejected():
    entry = _good_entry()
    entry.history = [{"not": "a snapshot"}]
    with pytest.raises(passwords.PasswordVaultError) as exc:
        entry.to_storage_json()
    assert exc.value.code == "password.content_corrupted"


def test_save_schema_invalid_entry_leaves_existing_vault_unchanged(tmp_path):
    passwords.save_password_vault(tmp_path, [_good_entry()], IMK)
    path = passwords.vault_path(tmp_path)
    before = path.read_bytes()

    bad = _good_entry()
    bad.created_at = "not a number"
    with pytest.raises(passwords.PasswordVaultError) as exc:
        passwords.save_password_vault(tmp_path, [bad], IMK)
    assert exc.value.code == "password.content_corrupted"
    assert path.read_bytes() == before
