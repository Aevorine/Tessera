import base64
import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import crypto, recovery_codes

IMK = crypto.generate_key()

GITHUB_CODES = [
    "05c93-3a58f", "c4842-3d0f3", "2dfc6-71fa3", "9bd37-bdade",
    "2d7ee-200dc", "6961c-f693a", "f8485-f7e6a", "d00d6-80225",
    "7bb11-43558", "437c8-3e48d", "27168-380e8", "c94c9-98dd1",
    "bd4aa-cb7fd", "58139-f3b80", "e2102-8e82f", "4bbce-68b07",
]
GITHUB_TEXT = "\n".join(GITHUB_CODES) + "\n"


def test_detect_service_rule_matches_github_filename():
    rule = recovery_codes.detect_service_rule("github-recovery-codes.txt")
    assert rule is not None
    assert rule.key == "github"
    assert rule.expected_count == 16


def test_detect_service_rule_no_match_returns_none():
    assert recovery_codes.detect_service_rule("random-file.txt") is None


def test_parse_code_lines_github_sample_all_valid():
    rule = recovery_codes.detect_service_rule("github-recovery-codes.txt")
    parsed = recovery_codes.parse_code_lines(GITHUB_TEXT, rule.code_pattern)
    assert len(parsed) == 16
    assert all(p.valid for p in parsed)
    assert [p.code for p in parsed] == GITHUB_CODES


def test_parse_code_lines_reports_malformed_line_number():
    rule = recovery_codes.detect_service_rule("github-recovery-codes.txt")
    text = "05c93-3a58f\nnot-a-valid-code-at-all\nc4842-3d0f3\n"
    parsed = recovery_codes.parse_code_lines(text, rule.code_pattern)
    assert len(parsed) == 3
    assert parsed[0].valid and parsed[2].valid
    assert not parsed[1].valid
    assert parsed[1].line_number == 2


def test_parse_code_lines_skips_blank_lines():
    parsed = recovery_codes.parse_code_lines("\n\n  \n05c93-3a58f\n\n", recovery_codes._DEFAULT_CODE_PATTERN)
    assert len(parsed) == 1
    assert parsed[0].line_number == 4


def test_dedupe_codes_preserves_first_seen_order():
    assert recovery_codes.dedupe_codes(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]


def test_diff_import_new_when_no_existing_group():
    assert recovery_codes.diff_import(None, ["a", "b"]) == "new"


def test_diff_import_unchanged_when_same_set_different_order():
    g = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a", "b", "c"])
    assert recovery_codes.diff_import(g, ["c", "a", "b"]) == "unchanged"


def test_diff_import_changed_when_sets_differ():
    g = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a", "b"])
    assert recovery_codes.diff_import(g, ["a", "b", "c"]) == "changed"


def test_sanitize_source_filename_strips_path_traversal():
    assert recovery_codes.sanitize_source_filename("../../etc/passwd") == "passwd"
    assert recovery_codes.sanitize_source_filename("..\\..\\windows\\system32\\config") == "config"


def test_sanitize_source_filename_strips_unsafe_characters():
    result = recovery_codes.sanitize_source_filename('weird:name*?.txt')
    assert ":" not in result and "*" not in result and "?" not in result


def test_validate_import_file_size_rejects_over_limit(tmp_path):
    big = tmp_path / "big.txt"
    big.write_bytes(b"x" * (recovery_codes.MAX_IMPORT_FILE_SIZE + 1))
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.validate_import_file_size(big)
    assert exc_info.value.code == "recovery_codes.file_too_large"


def test_validate_import_file_size_accepts_under_limit(tmp_path):
    small = tmp_path / "small.txt"
    small.write_bytes(b"x" * 100)
    recovery_codes.validate_import_file_size(small)  # must not raise


def test_remaining_count_and_low_stock():
    g = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a", "b", "c", "d"])
    g.low_stock_threshold = 2
    assert recovery_codes.remaining_count(g) == 4
    assert not recovery_codes.is_low_stock(g)
    g.codes[0].used = True
    g.codes[1].used = True
    assert recovery_codes.remaining_count(g) == 2
    assert recovery_codes.is_low_stock(g)


def test_needs_review_respects_interval():
    g = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a"])
    g.review_interval_days = 1
    now = g.last_checked_at
    assert not recovery_codes.needs_review(g, now=now + 3600)  # 1 hour later, still fresh
    assert recovery_codes.needs_review(g, now=now + 2 * 86400)  # 2 days later, overdue


def test_save_and_load_vault_round_trip(tmp_path):
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="github-recovery-codes.txt", codes=GITHUB_CODES)
    recovery_codes.save_recovery_codes_vault(tmp_path, [g], IMK)

    loaded, damaged = recovery_codes.load_recovery_codes_vault(tmp_path, IMK)
    assert damaged == []
    assert len(loaded) == 1
    assert loaded[0].service == "GitHub"
    assert loaded[0].account_label == "工作账号"
    assert [c.code for c in loaded[0].codes] == GITHUB_CODES


def test_load_missing_vault_returns_empty():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        loaded, damaged = recovery_codes.load_recovery_codes_vault(Path(d), IMK)
        assert loaded == []
        assert damaged == []


def test_load_wrong_imk_raises_key_mismatch(tmp_path):
    g = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a"])
    recovery_codes.save_recovery_codes_vault(tmp_path, [g], IMK)
    wrong_imk = crypto.generate_key()
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.load_recovery_codes_vault(tmp_path, wrong_imk)
    assert exc_info.value.code == "recovery_codes.key_mismatch"


def test_one_damaged_record_does_not_block_the_rest(tmp_path):
    """A single record's checksum getting tampered with must not prevent the
    other, untouched records from loading (spec 3.2/9 graceful degradation)."""
    good = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a", "b"])
    bad = recovery_codes.new_group(service="Google", account_label="", source_file_name="y.txt", codes=["c", "d"])
    recovery_codes.save_recovery_codes_vault(tmp_path, [good, bad], IMK)

    # 经私有序列化器往返，直接篡改明文载荷里第二条记录的校验和，模拟事后发生的损坏。
    import base64
    import json
    path = recovery_codes.vault_path(tmp_path)
    blob = json.loads(path.read_text(encoding="utf-8"))
    fk_nonce = base64.b64decode(blob["fk_wrap"]["nonce"])
    wrapped_fk = base64.b64decode(blob["fk_wrap"]["wrapped_fk"])
    content_nonce = base64.b64decode(blob["nonce"])
    ciphertext = base64.b64decode(blob["ciphertext"])
    fk = crypto.unwrap_key(IMK, fk_nonce, wrapped_fk)
    plaintext = crypto.aead_decrypt(fk, content_nonce, ciphertext)
    records = json.loads(plaintext)
    records[1]["checksum"] = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    new_plaintext = json.dumps(records, ensure_ascii=False).encode("utf-8")
    new_nonce = crypto.random_nonce()
    new_ciphertext = crypto.aead_encrypt(fk, new_nonce, new_plaintext)
    blob["nonce"] = base64.b64encode(new_nonce).decode()
    blob["ciphertext"] = base64.b64encode(new_ciphertext).decode()
    path.write_text(json.dumps(blob), encoding="utf-8")

    loaded, damaged = recovery_codes.load_recovery_codes_vault(tmp_path, IMK)
    assert len(loaded) == 1
    assert loaded[0].service == "GitHub"
    assert len(damaged) == 1
    assert damaged[0].raw_service == "Google"
    assert damaged[0].reason == "recovery_codes.checksum_mismatch"


def test_restore_previous_snapshot(tmp_path):
    g1 = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a"])
    recovery_codes.save_recovery_codes_vault(tmp_path, [g1], IMK)

    g2 = recovery_codes.new_group(service="Google", account_label="", source_file_name="y.txt", codes=["b"])
    recovery_codes.save_recovery_codes_vault(tmp_path, [g1, g2], IMK)

    loaded, _ = recovery_codes.load_recovery_codes_vault(tmp_path, IMK)
    assert len(loaded) == 2

    assert recovery_codes.restore_previous_snapshot(tmp_path) is True
    restored, _ = recovery_codes.load_recovery_codes_vault(tmp_path, IMK)
    assert len(restored) == 1
    assert restored[0].service == "GitHub"


def test_restore_previous_snapshot_false_when_none_exists(tmp_path):
    assert recovery_codes.restore_previous_snapshot(tmp_path) is False


def test_export_text_round_trips_through_parser():
    """旧版测试只过滤 `if p.valid`，会悄悄丢掉 '# GitHub (工作账号)' 头行，
    导致真实重新导入把该行报为格式错误时它仍通过。
    真正的往返必须还原同一个单组，并报告 0 条无效行，而不只是恢复码列表。"""
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="x.txt", codes=GITHUB_CODES)
    text = recovery_codes.export_text([g])
    rule = recovery_codes.detect_service_rule("github-recovery-codes.txt")
    groups = recovery_codes.parse_grouped_text(text, rule.code_pattern)
    assert len(groups) == 1
    assert groups[0].service == "GitHub"
    assert groups[0].account_label == "工作账号"
    assert groups[0].codes == GITHUB_CODES
    assert groups[0].invalid_lines == []


def test_parse_code_lines_skips_group_header_lines():
    """The literal reported bug: a '#' header line must be skipped like a
    blank line, not reported as a format error."""
    text = "# GitHub (work@example.com)\n05c93-3a58f\nc4842-3d0f3\n"
    parsed = recovery_codes.parse_code_lines(text, recovery_codes._DEFAULT_CODE_PATTERN)
    assert len(parsed) == 2
    assert all(p.valid for p in parsed)


def test_parse_grouped_text_headerless_file_is_one_unlabeled_group():
    """完全没有 '#' 头的纯文件（如 GitHub 自带的 recovery-codes.txt）行为须与多组支持前一致：
    单组，service/account_label 留给调用方填。"""
    rule = recovery_codes.detect_service_rule("github-recovery-codes.txt")
    groups = recovery_codes.parse_grouped_text(GITHUB_TEXT, rule.code_pattern)
    assert len(groups) == 1
    assert groups[0].service == ""
    assert groups[0].account_label == ""
    assert groups[0].codes == GITHUB_CODES
    assert groups[0].invalid_lines == []


def test_parse_grouped_text_splits_multiple_accounts_back_apart():
    """更深层的 bug：即使忽略 '#' 行，多账号导出也必须还原为多组，
    不能被压平成调用方传入的单个 service/account。"""
    g1 = recovery_codes.new_group(service="GitHub", account_label="work@example.com", source_file_name="x.txt", codes=GITHUB_CODES[:4])
    g2 = recovery_codes.new_group(service="GitHub", account_label="personal@example.com", source_file_name="y.txt", codes=GITHUB_CODES[4:8])
    text = recovery_codes.export_text([g1, g2])
    groups = recovery_codes.parse_grouped_text(text, recovery_codes._DEFAULT_CODE_PATTERN)
    assert len(groups) == 2
    assert groups[0].account_label == "work@example.com"
    assert groups[0].codes == GITHUB_CODES[:4]
    assert groups[1].account_label == "personal@example.com"
    assert groups[1].codes == GITHUB_CODES[4:8]
    assert groups[0].invalid_lines == [] and groups[1].invalid_lines == []


def test_parse_grouped_text_reports_invalid_line_inside_the_right_group():
    text = "# GitHub (a)\n05c93-3a58f\nnot valid at all!!\n\n# GitHub (b)\nc4842-3d0f3\n"
    groups = recovery_codes.parse_grouped_text(text, recovery_codes._DEFAULT_CODE_PATTERN)
    assert len(groups) == 2
    assert groups[0].account_label == "a"
    assert groups[0].codes == ["05c93-3a58f"]
    assert len(groups[0].invalid_lines) == 1
    assert groups[1].account_label == "b"
    assert groups[1].invalid_lines == []


def test_parse_csv_groups_round_trips_multiple_accounts():
    g1 = recovery_codes.new_group(service="GitHub", account_label="a", source_file_name="x.txt", codes=GITHUB_CODES[:3])
    g2 = recovery_codes.new_group(service="Google", account_label="b", source_file_name="y.txt", codes=GITHUB_CODES[3:5])
    csv_text = recovery_codes.export_csv([g1, g2])
    groups = recovery_codes.parse_csv_groups(csv_text)
    assert len(groups) == 2
    assert (groups[0].service, groups[0].account_label, groups[0].codes) == ("GitHub", "a", GITHUB_CODES[:3])
    assert (groups[1].service, groups[1].account_label, groups[1].codes) == ("Google", "b", GITHUB_CODES[3:5])
    assert groups[0].invalid_lines == [] and groups[1].invalid_lines == []


def test_parse_csv_groups_rejects_file_missing_required_columns():
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_csv_groups("name,value\nfoo,bar\n")
    assert exc_info.value.code == "recovery_codes.invalid_csv_format"


def test_parse_json_groups_round_trips_multiple_accounts():
    g1 = recovery_codes.new_group(service="GitHub", account_label="a", source_file_name="x.txt", codes=GITHUB_CODES[:3])
    g2 = recovery_codes.new_group(service="Google", account_label="b", source_file_name="y.txt", codes=GITHUB_CODES[3:5])
    json_text = recovery_codes.export_json([g1, g2])
    groups = recovery_codes.parse_json_groups(json_text)
    assert len(groups) == 2
    assert (groups[0].service, groups[0].account_label, groups[0].codes) == ("GitHub", "a", GITHUB_CODES[:3])
    assert (groups[1].service, groups[1].account_label, groups[1].codes) == ("Google", "b", GITHUB_CODES[3:5])
    assert groups[0].invalid_lines == [] and groups[1].invalid_lines == []


def test_parse_json_groups_rejects_non_list_payload():
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_json_groups(json.dumps({"not": "a list"}))
    assert exc_info.value.code == "recovery_codes.invalid_json_format"


def test_parse_json_groups_rejects_malformed_json():
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_json_groups("{not json")
    assert exc_info.value.code == "recovery_codes.invalid_json_format"


def test_detect_import_format_by_extension():
    assert recovery_codes.detect_import_format("codes.csv") == "csv"
    assert recovery_codes.detect_import_format("codes.JSON") == "json"
    assert recovery_codes.detect_import_format("codes.txt") == "txt"
    assert recovery_codes.detect_import_format("github-recovery-codes.txt") == "txt"


def test_parse_import_text_dispatches_by_format():
    g = recovery_codes.new_group(service="GitHub", account_label="a", source_file_name="x.txt", codes=GITHUB_CODES[:2])
    assert len(recovery_codes.parse_import_text(recovery_codes.export_text([g]), "txt")) == 1
    assert len(recovery_codes.parse_import_text(recovery_codes.export_csv([g]), "csv")) == 1
    assert len(recovery_codes.parse_import_text(recovery_codes.export_json([g]), "json")) == 1


def test_to_rpc_json_shape():
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="github-recovery-codes.txt", codes=["a", "b", "c", "d", "e"])
    d = g.to_rpc_json()
    assert d["service"] == "GitHub"
    assert d["accountLabel"] == "工作账号"
    assert d["remainingCount"] == 5
    assert d["isLowStock"] is False
    assert len(d["codes"]) == 5
    # Masked: index/used/usedAt only, plaintext `code` is never in this shape.
    assert d["codes"][0] == {"index": 0, "used": False, "usedAt": None}
    assert "code" not in d["codes"][0]


# 全量备份 / 跨设备迁移（spec 3.5）

BACKUP_PASSWORD = "correct horse battery staple"


def test_export_and_parse_full_backup_round_trip():
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="x.txt", codes=GITHUB_CODES)
    backup_bytes = recovery_codes.export_full_backup([g], BACKUP_PASSWORD)
    groups, damaged = recovery_codes.parse_full_backup(backup_bytes, BACKUP_PASSWORD)
    assert damaged == []
    assert len(groups) == 1
    assert groups[0].service == "GitHub"
    assert [c.code for c in groups[0].codes] == GITHUB_CODES


def test_parse_full_backup_wrong_password_raises():
    g = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["a"])
    backup_bytes = recovery_codes.export_full_backup([g], BACKUP_PASSWORD)
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_full_backup(backup_bytes, "wrong password")
    assert exc_info.value.code == "recovery_codes.backup_wrong_password"


def test_parse_full_backup_rejects_unrecognized_file():
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_full_backup(b'{"not": "a backup"}', BACKUP_PASSWORD)
    assert exc_info.value.code == "recovery_codes.backup_invalid_format"


def test_parse_full_backup_rejects_garbage_bytes():
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_full_backup(b"\xff\xfe not json at all", BACKUP_PASSWORD)
    assert exc_info.value.code == "recovery_codes.backup_invalid_format"


def test_diff_full_backup_classifies_all_four_statuses():
    local_only = recovery_codes.new_group(service="Discord", account_label="", source_file_name="x.txt", codes=["a"])
    identical_local = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["b", "c"])
    conflict_local = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["d", "e"])

    identical_backup = recovery_codes.new_group(service="GitHub", account_label="", source_file_name="x.txt", codes=["c", "b"])  # same set, different order
    conflict_backup = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["d", "f"])
    backup_only = recovery_codes.new_group(service="Steam", account_label="", source_file_name="x.txt", codes=["g"])

    items = recovery_codes.diff_full_backup(
        [local_only, identical_local, conflict_local],
        [identical_backup, conflict_backup, backup_only],
    )
    by_service = {i.service: i.status for i in items}
    assert by_service == {
        "Discord": "local_only",
        "GitHub": "identical",
        "Google": "conflict",
        "Steam": "backup_only",
    }


def test_diff_full_backup_distinguishes_same_service_different_account_label():
    work = recovery_codes.new_group(service="GitHub", account_label="工作", source_file_name="x.txt", codes=["a"])
    personal_backup = recovery_codes.new_group(service="GitHub", account_label="个人", source_file_name="x.txt", codes=["b"])
    items = recovery_codes.diff_full_backup([work], [personal_backup])
    statuses = {(i.service, i.account_label): i.status for i in items}
    assert statuses == {("GitHub", "工作"): "local_only", ("GitHub", "个人"): "backup_only"}


def test_merge_group_unions_codes_and_prefers_used_true():
    now = 1000.0
    local = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["a", "b"])
    local.codes[0].used = True
    local.codes[0].used_at = now
    local.last_updated_at = now

    backup = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["b", "c"])
    backup.last_updated_at = now - 100  # older than local

    merged = recovery_codes.merge_group(local, backup)
    codes_by_value = {c.code: c for c in merged.codes}
    assert set(codes_by_value.keys()) == {"a", "b", "c"}
    assert codes_by_value["a"].used is True  # used on local side, preserved
    assert codes_by_value["b"].used is False
    assert codes_by_value["c"].used is False


def test_merge_group_takes_metadata_from_more_recently_updated_side():
    local = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["a"])
    local.note = "old note"
    local.last_updated_at = 1000.0

    backup = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["a"])
    backup.note = "newer note from backup"
    backup.last_updated_at = 2000.0

    merged = recovery_codes.merge_group(local, backup)
    assert merged.note == "newer note from backup"


def test_merge_group_keeps_earliest_first_imported_at():
    local = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["a"])
    local.first_imported_at = 500.0
    backup = recovery_codes.new_group(service="Google", account_label="", source_file_name="x.txt", codes=["a"])
    backup.first_imported_at = 100.0

    merged = recovery_codes.merge_group(local, backup)
    assert merged.first_imported_at == 100.0


# 边界：空输入、纯空白输入（spec 10）

def test_parse_code_lines_empty_text_returns_empty_list():
    assert recovery_codes.parse_code_lines("", recovery_codes._DEFAULT_CODE_PATTERN) == []


def test_parse_code_lines_whitespace_only_text_returns_empty_list():
    assert recovery_codes.parse_code_lines("   \n\t\n   ", recovery_codes._DEFAULT_CODE_PATTERN) == []


def test_export_text_empty_group_list_returns_empty_string():
    assert recovery_codes.export_text([]) == ""


def test_validate_import_file_size_accepts_zero_byte_file(tmp_path):
    empty = tmp_path / "empty.txt"
    empty.write_bytes(b"")
    recovery_codes.validate_import_file_size(empty)  # must not raise


# 备份文件的 Scrypt 成本迁移：备份是唯一无法就地重新封装的东西（可能在只读介质或再也见不到的机器上），
# 所以成本参数必须写进文件，这是提高成本后老导出仍能打开的唯一依靠。


def test_backup_records_the_current_scrypt_cost():
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="x.txt", codes=GITHUB_CODES)
    blob = json.loads(recovery_codes.export_full_backup([g], BACKUP_PASSWORD).decode("utf-8"))
    assert blob["scrypt_n"] == crypto.SCRYPT_N


def test_a_backup_exported_before_the_cost_bump_still_opens():
    """升级前导出的文件里没有 scrypt_n 字段，必须当成旧成本来解。"""
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="x.txt", codes=GITHUB_CODES)

    # 手工造一份"旧格式"备份：用旧成本加密，且不写 scrypt_n 字段
    salt = crypto.random_salt()
    kek = crypto.derive_key_scrypt(BACKUP_PASSWORD.encode("utf-8"), salt, crypto.SCRYPT_N_LEGACY)
    payload = json.dumps({"exported_at": 0.0, "groups": [recovery_codes._group_to_storage_json(g)]})
    nonce = crypto.random_nonce()
    legacy = json.dumps({
        "format": recovery_codes.BACKUP_FORMAT_MARKER,
        "format_version": recovery_codes.BACKUP_FORMAT_VERSION,
        "salt": base64.b64encode(salt).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(crypto.aead_encrypt(kek, nonce, payload.encode("utf-8"))).decode(),
    }).encode("utf-8")

    groups, damaged = recovery_codes.parse_full_backup(legacy, BACKUP_PASSWORD)
    assert damaged == []
    assert len(groups) == 1


def test_a_backup_claiming_an_absurd_cost_is_rejected_not_attempted():
    """备份文件是不可信输入：照文件里的数字跑 scrypt 会让一个字段点爆内存（n=2**40 需 1TB），
    只接受我们自己写过的那两个值。"""
    g = recovery_codes.new_group(service="GitHub", account_label="工作账号", source_file_name="x.txt", codes=GITHUB_CODES)
    blob = json.loads(recovery_codes.export_full_backup([g], BACKUP_PASSWORD).decode("utf-8"))
    blob["scrypt_n"] = 2**40

    with pytest.raises(recovery_codes.RecoveryCodeVaultError):
        recovery_codes.parse_full_backup(json.dumps(blob).encode("utf-8"), BACKUP_PASSWORD)


# JSON 导出 v2

JSON_PASSWORD = "correct horse battery"


def _sample_group(*, used_index=None, note="", history_summary=None):
    g = recovery_codes.new_group(
        service="GitHub", account_label="工作账号",
        source_file_name="github-recovery-codes.txt", codes=GITHUB_CODES[:4],
    )
    if used_index is not None:
        g.codes[used_index].used = True
        g.codes[used_index].used_at = 1785939042.016
    g.note = note
    g.low_stock_threshold = 7
    g.review_interval_days = 42
    if history_summary:
        g.import_history.append(
            recovery_codes.ImportHistoryEntry(action="update", timestamp=1785939042.0, change_summary=history_summary)
        )
    return g


def test_json_export_round_trip_keeps_the_used_flags():
    """v1 最要命的 bug：写出了 used/usedAt 却从不读回（parse_json_groups 只取 code），
    导出再导入会把所有"已用"码复活成未用，用户在账号被锁、急需可用码时才发现。"""
    g = _sample_group(used_index=1)
    groups, damaged, _meta = recovery_codes.parse_json_export(recovery_codes.export_json([g]))
    assert damaged == []
    assert [c.used for c in groups[0].codes] == [False, True, False, False]
    assert groups[0].codes[1].used_at == 1785939042.016


def test_json_export_round_trip_keeps_every_other_field_too():
    g = _sample_group(used_index=0, note="主账号，换手机前先看这里", history_summary="更新为4个密钥")
    groups, damaged, _meta = recovery_codes.parse_json_export(recovery_codes.export_json([g]))
    assert damaged == []
    back = groups[0]
    assert back.id == g.id
    assert (back.service, back.account_label) == (g.service, g.account_label)
    assert back.note == g.note
    assert back.source_file_name == g.source_file_name
    assert (back.low_stock_threshold, back.review_interval_days) == (7, 42)
    assert (back.first_imported_at, back.last_updated_at, back.last_checked_at) == (
        g.first_imported_at, g.last_updated_at, g.last_checked_at,
    )
    assert [(h.action, h.change_summary) for h in back.import_history] == \
           [(h.action, h.change_summary) for h in g.import_history]


def test_json_export_stamps_one_timestamp_for_the_whole_file():
    """v1 给每一组各盖一次 time.time()，同一次导出的不同组时间都不一样，
    两份文件之间没法直接比对。"""
    payload = json.loads(recovery_codes.export_json([_sample_group(), _sample_group()]))
    assert isinstance(payload["exportedAt"], float)
    assert all("exportedAt" not in g for g in payload["groups"])


def test_json_export_envelope_declares_what_it_is():
    payload = json.loads(recovery_codes.export_json([_sample_group(used_index=0)], app_version="0.1.5"))
    assert payload["format"] == recovery_codes.JSON_FORMAT_MARKER
    assert payload["formatVersion"] == recovery_codes.JSON_FORMAT_VERSION
    assert payload["appVersion"] == "0.1.5"
    assert payload["encrypted"] is False
    assert payload["stats"] == {"groupCount": 1, "codeCount": 4, "unusedCount": 3}


def test_a_single_edited_character_is_caught_by_both_checksums():
    """整体校验值提示「文件被动过」，逐组校验值隔离出坏掉的那组；
    对能绕过两步验证的清单，默默接受被改过的码不可接受。"""
    text = recovery_codes.export_json([_sample_group(), _sample_group()])
    # 只改**第一组**里的那一个字符（count=1）。两组的码是一样的，全局替换会把
    # 两组都改坏，那就测不出"坏的被隔离、好的照常导入"这件事了。
    tampered = text.replace(GITHUB_CODES[0], "00000-00000", 1)

    groups, damaged, meta = recovery_codes.parse_json_export(tampered)
    assert meta.checksum_ok is False
    assert [d.reason for d in damaged] == ["recovery_codes.checksum_mismatch"]
    # 另一组没被牵连——一条坏记录不能把整份文件拖垮（同金库加载时的降级策略）。
    assert len(groups) == 1


def test_json_export_checksum_survives_reformatting():
    """校验值算的是内容，不是字节。用户用编辑器重排过缩进/键序之后，
    文件仍然应该被认成完好的——否则这个校验只会制造假警报。"""
    payload = json.loads(recovery_codes.export_json([_sample_group(used_index=2)]))
    reformatted = json.dumps(payload, ensure_ascii=True, indent=8, sort_keys=True)
    _groups, damaged, meta = recovery_codes.parse_json_export(reformatted)
    assert meta.checksum_ok is True and damaged == []


def test_encrypted_json_round_trip_and_wrong_password():
    g = _sample_group(used_index=3, note="备注也要一起加密")
    text = recovery_codes.export_json_encrypted([g], JSON_PASSWORD, app_version="0.1.5")

    groups, damaged, meta = recovery_codes.parse_json_export(text, password=JSON_PASSWORD)
    assert damaged == [] and meta.encrypted is True
    assert [c.code for c in groups[0].codes] == [c.code for c in g.codes]
    assert groups[0].note == "备注也要一起加密"
    assert [c.used for c in groups[0].codes] == [False, False, False, True]

    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_json_export(text, password="wrong password")
    assert exc_info.value.code == "recovery_codes.json_wrong_password"

    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_json_export(text)
    assert exc_info.value.code == "recovery_codes.json_password_required"


def test_encrypted_json_envelope_leaks_no_service_names():
    """加密导出的外层是可读 JSON（需认出格式与加密参数），但「在哪些网站有账号」本身要保护，
    所以信封里不写服务名和 stats；代价是输密码前预览不出规模，值得。"""
    g = _sample_group()
    text = recovery_codes.export_json_encrypted([g], JSON_PASSWORD)
    assert "GitHub" not in text and "工作账号" not in text
    assert GITHUB_CODES[0] not in text
    blob = json.loads(text)
    assert "stats" not in blob and "groups" not in blob
    assert blob["kdf"]["algorithm"] == "scrypt" and blob["kdf"]["n"] == crypto.SCRYPT_N


def test_encrypted_json_claiming_an_absurd_kdf_cost_is_rejected_not_attempted():
    """同 test_a_backup_claiming_an_absurd_cost_is_rejected_not_attempted：
    导入文件是不可信输入，照着它写的数字跑 scrypt 等于一个字段点爆内存。"""
    blob = json.loads(recovery_codes.export_json_encrypted([_sample_group()], JSON_PASSWORD))
    blob["kdf"]["n"] = 2**40
    with pytest.raises(recovery_codes.RecoveryCodeVaultError):
        recovery_codes.parse_json_export(json.dumps(blob), password=JSON_PASSWORD)


def test_a_newer_format_version_is_refused_rather_than_guessed():
    """猜着解析一份更新的备份，最坏的结果是把它当成损坏数据丢掉，
    而用户以为自己已经恢复过了。"""
    blob = json.loads(recovery_codes.export_json([_sample_group()]))
    blob["formatVersion"] = recovery_codes.JSON_FORMAT_VERSION + 1
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_json_export(json.dumps(blob))
    assert exc_info.value.code == "recovery_codes.json_unsupported_version"


def test_v1_bare_array_still_opens_and_now_keeps_its_used_flags():
    """用户机器上就躺着这样的旧导出，让它们打不开毫无道理。而且既然 v1 当年
    确实把 used 写进了文件，现在读回来是白捡的——丢掉它才是 bug。"""
    v1 = json.dumps([{
        "service": "GitHub", "accountLabel": "旧账号", "sourceFileName": "old.txt",
        "codes": [
            {"code": GITHUB_CODES[0], "used": True, "usedAt": 5.0},
            {"code": GITHUB_CODES[1], "used": False, "usedAt": None},
        ],
    }])
    groups, damaged, meta = recovery_codes.parse_json_export(v1)
    assert damaged == []
    assert meta.format_version == 1
    # v1 里没有整体校验值。None 表示「这份文件没带」，不是「校验没过」——
    # 界面上这两件事必须分得清，否则每打开一份旧文件都会弹一次假警报。
    assert meta.checksum_ok is None
    assert [(c.code, c.used) for c in groups[0].codes] == [(GITHUB_CODES[0], True), (GITHUB_CODES[1], False)]


def test_redacted_export_carries_no_codes_and_refuses_to_be_imported():
    g = _sample_group(used_index=1)
    text = recovery_codes.export_json([g], include_codes=False)
    assert GITHUB_CODES[0] not in text
    payload = json.loads(text)
    assert payload["codesRedacted"] is True
    # 位置和「用过没有」仍然保留——脱敏是为了盘点，不是为了什么都看不见。
    assert payload["groups"][0]["codes"][1] == {"index": 1, "used": True, "usedAt": 1785939042.016}

    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_json_export(text)
    assert exc_info.value.code == "recovery_codes.json_codes_redacted"


def test_select_groups_only_unused_never_mutates_the_live_data():
    """这一条盯的是一次静默数据丢失：调用方手里那个列表是后端的**活数据**，
    「只导出未用的」如果就地过滤，等于一次导出把所有已用记录抹掉。"""
    g = _sample_group(used_index=1)
    picked = recovery_codes.select_groups([g], only_unused=True)
    assert len(picked[0].codes) == 3
    assert len(g.codes) == 4 and g.codes[1].used is True


def test_select_groups_drops_a_group_left_with_nothing():
    g = _sample_group()
    for c in g.codes:
        c.used = True
    assert recovery_codes.select_groups([g], only_unused=True) == []


def test_select_groups_by_ids():
    a, b = _sample_group(), _sample_group()
    assert [g.id for g in recovery_codes.select_groups([a, b], ids=[b.id])] == [b.id]


def test_chunk_groups_never_splits_a_group_across_files():
    groups = [_sample_group() for _ in range(5)]
    parts = recovery_codes.chunk_groups(groups, 2)
    assert [len(p) for p in parts] == [2, 2, 1]
    assert [g for p in parts for g in p] == groups
    assert recovery_codes.chunk_groups(groups, 0) == [groups]


def test_plain_text_import_path_still_accepts_a_v2_file():
    """旧的「导入文件」入口（parse_import_text）拿到 v2 文件时不能直接失败；
    有损（ParsedGroup 只装得下码）也好过一句「格式不对」。"""
    g = _sample_group(used_index=0)
    parsed = recovery_codes.parse_import_text(recovery_codes.export_json([g]), "json")
    assert len(parsed) == 1
    assert parsed[0].codes == [c.code for c in g.codes]


def test_plain_text_import_path_points_at_the_password_when_given_an_encrypted_file():
    text = recovery_codes.export_json_encrypted([_sample_group()], JSON_PASSWORD)
    with pytest.raises(recovery_codes.RecoveryCodeVaultError) as exc_info:
        recovery_codes.parse_import_text(text, "json")
    assert exc_info.value.code == "recovery_codes.json_password_required"


def test_diff_flags_a_conflict_when_only_the_used_state_differs():
    """码相同但一边「已用掉」一边「还能用」不是 identical；
    曾被判 identical，界面提示「无需处理」，用户继续相信已作废的码。这个方向上判错正是该功能要防的事。"""
    local = recovery_codes.new_group(service="GitHub", account_label="a", source_file_name="x.txt", codes=GITHUB_CODES[:3])
    other = recovery_codes.new_group(service="GitHub", account_label="a", source_file_name="x.txt", codes=GITHUB_CODES[:3])
    other.codes[0].used = True

    items = recovery_codes.diff_full_backup([local], [other])
    assert [i.status for i in items] == ["conflict"]

    # 两边完全一致时仍然是 identical——不能把这条改成"什么都算冲突"，
    # 那样每次导入都要用户逐条点一遍，等于没有预览。
    local.codes[0].used = True
    assert [i.status for i in recovery_codes.diff_full_backup([local], [other])] == ["identical"]
