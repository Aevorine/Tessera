"""把 backend_server.py 作为真实子进程启动（指向临时 --data-dir），用 NDJSON 请求验证协议
契约（请求/响应/进度分帧、错误透出），不依赖 Electron。"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import keyring
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import backend_server, identity, passwords  # noqa: E402

BACKEND_SCRIPT = PROJECT_ROOT / "modules" / "file_vault" / "backend_server.py"


def _vault_snapshot(tmp_path):
    """返回本测试 data-dir 下加密金库文件的原始字节，没有则 None。

    后端是独立子进程，在测试进程里 monkeypatch 观察不到；比较 RPC 前后的字节才能证明
    无操作时金库逐字节不变。"""
    path = passwords.vault_path(tmp_path / "data")
    return path.read_bytes() if path.exists() else None


class BackendClient:
    def __init__(self, data_dir: Path):
        # 后端是真实子进程，会用真实系统 keyring，看不到本测试的进程内 mock；曾导致每次测试静默覆盖
        # 开发者真实的 TOTP 种子/邮件密钥。所以每个 client 用一次性命名空间。
        self.keyring_service = f"ideal1-file-vault-test-{uuid.uuid4()}"
        env = dict(os.environ, IDEAL1_FILE_VAULT_KEYRING_SERVICE=self.keyring_service)
        self.proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", str(BACKEND_SCRIPT), "--data-dir", str(data_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=str(PROJECT_ROOT),
            env=env,
        )
        self._next_id = 0

        # stderr 必须有人持续读，否则整套测试随机死锁：管道缓冲区只有几十 KB，后端写满 stderr 就阻塞，
        # 不再往 stdout 写响应，read_one() 的 readline() 永远等不到，双方互等、CPU 0%。
        # 是否发作取决于后端恰好写了多少 stderr，所以每次卡在不同用例上。后台线程抽干即可，
        # 也能在报错时附上 stderr 原文（`self.proc.stderr.read()` 要等子进程退出才返回）。
        self._stderr_chunks = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self):
        try:
            for line in self.proc.stderr:
                self._stderr_chunks.append(line)
        except (ValueError, OSError):
            pass  # 管道在关闭过程中被合上，正常收尾

    def stderr_text(self) -> str:
        return "".join(self._stderr_chunks)

    def send(self, method: str, params: dict) -> int:
        """只发送请求，返回分配的 request id，不等待响应。"""
        self._next_id += 1
        req_id = self._next_id
        self.proc.stdin.write(json.dumps({"id": req_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        return req_id

    def read_one(self) -> dict:
        """读取一行原始 NDJSON 消息（可能属于任意在途请求）。

        跳过主动推送的事件：剪贴板监听线程会往同一 stdout 写没有 `id` 的
        `{"event": "clipboard_new_entry", ...}`，系统剪贴板恰好变化时任一用例会以 `KeyError: 'id'`
        偶发挂掉（单独重跑必过）。没有用例需要这些推送，在这一层滤掉。
        """
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"backend_server.py closed stdout unexpectedly (stderr: {self.stderr_text()})")
            msg = json.loads(line)
            if "id" in msg:
                return msg

    def call(self, method: str, params: dict):
        """Send one request, return (final_result_or_none, progress_events, error_or_none)."""
        req_id = self.send(method, params)
        progress_events = []
        while True:
            msg = self.read_one()
            assert msg["id"] == req_id
            if "progress" in msg:
                progress_events.append(msg["progress"])
                continue
            if "error" in msg:
                return None, progress_events, msg["error"]["message"]
            return msg["result"], progress_events, None

    def close(self):
        self.proc.stdin.close()
        # 关闭是清理不是断言，要给足时间且不能因超时让用例失败：原先 `wait(timeout=5)` 在机器忙时
        # （后端收尾 SQLCipher，测试又在反复跑 N=2¹⁷ 的 scrypt）会抛 TimeoutExpired，被记成随机的
        # teardown ERROR。现在等久一点，等不到就 kill；子进程用各自的临时目录和一次性 keyring 命名空间，
        # 强杀不会污染别的用例。
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        for key in (
            identity.KEYRING_TOTP_SEED,
            identity.KEYRING_EMAIL_SECRET,
            identity.KEYRING_SMTP_CONFIG,
            identity.KEYRING_BIO_SECRET,
            identity.KEYRING_AI_CONFIG,
        ):
            try:
                keyring.delete_password(self.keyring_service, key)
            except keyring.errors.PasswordDeleteError:
                pass  # never set by this test - nothing to clean up


@pytest.fixture
def client(tmp_path):
    c = BackendClient(tmp_path / "data")
    yield c
    c.close()


def test_async_deferred_rpc_returns_result_later_without_blocking_dispatch_return(client):
    req_id = client.send("__test_async_echo", {"value": 123})
    msg = client.read_one()
    assert msg["id"] == req_id
    assert msg["result"] == {"ok": True, "value": 123}


def test_backend_client_send_and_read_one_low_level_roundtrip(client):
    req_id = client.send("identity_exists", {})
    msg = client.read_one()
    assert msg["id"] == req_id
    assert "result" in msg


def test_identity_exists_false_before_setup(client):
    result, _, error = client.call("identity_exists", {})
    assert error is None
    assert result == {"exists": False}


def test_full_setup_and_password_unlock(client):
    result, _, error = client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    assert error is None
    assert result == {"ok": True}

    result, _, _ = client.call("identity_exists", {})
    assert result == {"exists": True}

    result, _, _ = client.call("unlock_password", {"password": "wrong"})
    assert result["ok"] is False
    assert result["error"] == "auth.wrong_password"

    result, _, _ = client.call("unlock_password", {"password": "test-password-" + "123"})
    assert result == {"ok": True}


def test_unlock_password_locks_out_after_repeated_failures(client):
    from modules.file_vault import identity

    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS + 1):
        client.call("unlock_password", {"password": "wrong"})

    # 即使这次用的是正确密码，锁定期间也应该被直接拒绝，而不是解锁成功。
    result, _, _ = client.call("unlock_password", {"password": "test-password-" + "123"})
    assert result["ok"] is False
    assert result["error"] == "auth.locked_out"
    assert result["error_params"]["seconds_remaining"] > 0


def test_unlock_lockout_is_shared_across_factors(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    from modules.file_vault import identity

    for _ in range(identity.FREE_UNLOCK_ATTEMPTS + 1):
        client.call("unlock_password", {"password": "wrong"})

    # 换一个因素（TOTP）尝试，锁定状态照样生效，不能靠换因素绕开。
    result, _, _ = client.call("unlock_totp", {"code": "000000"})
    assert result["ok"] is False
    assert result["error"] == "auth.locked_out"


def test_unlock_password_succeeds_within_free_attempts_budget(client):
    from modules.file_vault import identity

    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    for _ in range(identity.FREE_UNLOCK_ATTEMPTS):
        client.call("unlock_password", {"password": "wrong"})

    result, _, _ = client.call("unlock_password", {"password": "test-password-" + "123"})
    assert result == {"ok": True}


def test_setup_check_fingerprint_available_returns_a_bool(client):
    result, _, error = client.call("setup_check_fingerprint_available", {})
    assert error is None
    assert isinstance(result["available"], bool)


def test_unlock_fingerprint_reports_not_bound_when_no_fingerprint_slot(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    # setup_complete 没传 enable_fingerprint，此身份没有指纹槽位，unlock_fingerprint 必须在不碰真实
    # Windows Hello API 的情况下报告这一点。
    result, _, error = client.call("unlock_fingerprint", {})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "auth.fingerprint_not_bound"


def test_unlock_fingerprint_cancel_works_before_setup_and_without_an_active_prompt(client):
    """取消入口不能要求已建库或已解锁：它服务登录页和首次运行向导（_store/_imk 可能为 None）；
    没有在途验证时必须干净地回 canceled:false，因为取消按钮在验证刚结束时被点到很正常。"""
    result, _, error = client.call("unlock_fingerprint_cancel", {})
    assert error is None
    assert result == {"ok": True, "canceled": False}


def test_unlock_fingerprint_cancel_releases_the_single_flight_slot(monkeypatch):
    """取消之后下一次"重新用 Windows Hello 解锁"必须立刻能发起，否则只是把
    fingerprint.verification_timeout 换成 auth.fingerprint_verification_in_progress 这个死胡同。

    直接调处理函数而不走 `client`：该 fixture 是独立后端子进程，monkeypatch 和槽位状态跨不过去。"""
    from modules.file_vault import backend_server, fingerprint

    monkeypatch.setattr(fingerprint, "cancel_active_verification", lambda: True)
    assert fingerprint.acquire_verification_slot() is True
    try:
        assert backend_server.rpc_unlock_fingerprint_cancel({}) == {"ok": True, "canceled": True}
        assert fingerprint.acquire_verification_slot() is True
    finally:
        fingerprint.release_verification_slot()


def test_rebind_fingerprint_requires_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("rebind_fingerprint", {})
    assert result is None
    assert error == "auth.not_unlocked"


def test_encrypt_decrypt_round_trip_with_progress(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})

    original = tmp_path / "note.txt"
    original.write_text("hello from the NDJSON protocol test", encoding="utf-8")
    encrypted = tmp_path / "note.ivault"
    decrypted = tmp_path / "note.out.txt"

    result, progress, error = client.call(
        "encrypt_file", {"input_path": str(original), "output_path": str(encrypted)}
    )
    assert error is None
    assert result["ok"] is True
    assert progress == [{"done": 1, "total": 1}]  # single-chunk file

    result, _, error = client.call("read_header", {"input_path": str(encrypted)})
    assert error is None
    assert result["ok"] is True
    assert result["header"]["original_filename"] == "note.txt"
    # Not part of the encrypted container - the .ivault file's own
    # filesystem mtime, added for the FilesPane.tsx decrypt-preview list.
    assert isinstance(result["header"]["container_mtime"], float)

    result, progress, error = client.call(
        "decrypt_file", {"input_path": str(encrypted), "output_path": str(decrypted)}
    )
    assert error is None
    assert result["ok"] is True
    assert progress == [{"done": 1, "total": 1}]

    assert decrypted.read_text(encoding="utf-8") == original.read_text(encoding="utf-8")


def test_scan_and_secure_delete_remnants_round_trip(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})

    # A leftover editor backup sitting next to the (already deleted) source.
    source = tmp_path / "report.docx"
    bak = tmp_path / "report.docx.bak"
    bak.write_bytes(b"plaintext backup copy")

    result, _, error = client.call("scan_remnants", {"source_paths": [str(source)]})
    assert error is None
    assert result["ok"] is True
    found_paths = [it["path"] for it in result["items"]]
    assert str(bak) in found_paths
    matched_item = next(it for it in result["items"] if it["path"] == str(bak))
    assert matched_item["matched"] is True
    assert matched_item["category"] == "same_dir"

    result, _, error = client.call("secure_delete_paths", {"paths": [str(bak)]})
    assert error is None
    assert result["ok"] is True
    assert result["results"] == [{"path": str(bak), "ok": True}]
    assert not bak.exists()


def test_scan_remnants_requires_unlock(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("scan_remnants", {"source_paths": [str(tmp_path / "x.docx")]})
    assert result is None
    assert error == "auth.not_unlocked"

    result, _, error = client.call("secure_delete_paths", {"paths": [str(tmp_path / "x.docx")]})
    assert result is None
    assert error == "auth.not_unlocked"


def test_operations_before_unlock_report_error_not_crash(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    # No unlock call made - change_password requires an unlocked IMK.
    result, _, error = client.call("change_password", {"new_password": "irrelevant-but-long-enough"})
    assert result is None
    assert error == "auth.not_unlocked"


def test_unknown_method_reports_error_not_crash(client):
    result, _, error = client.call("no_such_method", {})
    assert result is None
    assert "Unknown method" in error


def test_dispatch_hides_unexpected_exception_details(monkeypatch):
    def boom(_params):
        raise RuntimeError("secret internal path C:/sensitive/vault.json")

    monkeypatch.setitem(backend_server._METHODS, "explode", boom)

    response = backend_server.dispatch({"id": 7, "method": "explode", "params": {}})

    assert response == {"id": 7, "error": {"message": "internal.unexpected"}}


def test_encrypt_with_delete_source_removes_the_plaintext(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})

    original = tmp_path / "note.txt"
    original.write_text("delete me after encrypting", encoding="utf-8")
    encrypted = tmp_path / "note.ivault"

    result, _, error = client.call(
        "encrypt_file",
        {"input_path": str(original), "output_path": str(encrypted), "delete_source": True},
    )
    assert error is None
    assert result["ok"] is True
    assert result["source_deleted"] is True
    assert not original.exists()  # the whole point: no plaintext left behind
    assert encrypted.exists()


def test_encrypt_without_delete_source_leaves_plaintext_untouched(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})

    original = tmp_path / "note.txt"
    original.write_text("keep me around", encoding="utf-8")
    encrypted = tmp_path / "note.ivault"

    result, _, error = client.call(
        "encrypt_file", {"input_path": str(original), "output_path": str(encrypted)}
    )
    assert error is None
    assert result["ok"] is True
    assert "source_deleted" not in result  # delete_source defaults to False - opt-in only
    assert original.exists()


def test_decrypt_with_delete_source_removes_the_ivault_file(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})

    original = tmp_path / "note.txt"
    original.write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "note.ivault"
    client.call("encrypt_file", {"input_path": str(original), "output_path": str(encrypted)})

    decrypted = tmp_path / "note.out.txt"
    result, _, error = client.call(
        "decrypt_file", {"input_path": str(encrypted), "output_path": str(decrypted), "delete_source": True}
    )
    assert error is None
    assert result["ok"] is True
    assert result["source_deleted"] is True
    assert not encrypted.exists()  # the whole point: no encrypted copy left behind
    assert decrypted.read_text(encoding="utf-8") == "hello"


def test_decrypt_without_delete_source_leaves_ivault_file_untouched(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})

    original = tmp_path / "note.txt"
    original.write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "note.ivault"
    client.call("encrypt_file", {"input_path": str(original), "output_path": str(encrypted)})

    decrypted = tmp_path / "note.out.txt"
    result, _, error = client.call(
        "decrypt_file", {"input_path": str(encrypted), "output_path": str(decrypted)}
    )
    assert error is None
    assert result["ok"] is True
    assert "source_deleted" not in result  # delete_source defaults to False - opt-in only
    assert encrypted.exists()


def test_decrypt_of_non_container_file_reports_friendly_error(client, tmp_path):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    not_a_vault = tmp_path / "random.bin"
    not_a_vault.write_bytes(b"not a valid container")

    result, _, error = client.call("read_header", {"input_path": str(not_a_vault)})
    assert error is None  # read_header itself succeeds as an RPC call...
    assert result["ok"] is False  # ...but reports the container error in its own result
    assert result["error"] == "container.header_incomplete"


def _setup_and_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    client.call("unlock_password", {"password": "test-password-" + "123"})


def test_password_list_empty_before_any_entries(client):
    _setup_and_unlock(client)
    result, _, error = client.call("password_list", {})
    assert error is None
    assert result == {"entries": []}


def test_password_add_and_list_round_trip(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert error is None
    assert result["ok"] is True
    assert "history" not in result["entry"]
    entry_id = result["entry"]["id"]

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 1
    assert result["entries"][0]["id"] == entry_id
    assert result["entries"][0]["password"] == "hunter2"
    assert "history" not in result["entries"][0]


def test_password_add_skips_exact_duplicate_of_existing_entry(client):
    # 名称/网址/用户名/密码/备注五项全部一致才算重复，与 CSV 导入自动去重、手动"去重"按钮同一套判定
    # （见 rpc_password_import_csv_preview/_confirm 旁的测试）。
    _setup_and_unlock(client)
    first, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert first["deduped"] is False

    second, _, error = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert error is None
    assert second["ok"] is True
    assert second["deduped"] is True
    assert second["entry"]["id"] == first["entry"]["id"]  # 返回的是已有那条，不是新建的

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 1


def test_password_add_does_not_dedupe_when_only_some_fields_match(client):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    result, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "different-password"},
    )
    assert result["deduped"] is False

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 2


def test_password_update_changes_fields_but_keeps_id(client):
    _setup_and_unlock(client)
    result, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = result["entry"]["id"]

    result, _, error = client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "new-pass"},
    )
    assert error is None
    assert result["ok"] is True
    assert result["entry"]["id"] == entry_id
    assert result["entry"]["password"] == "new-pass"
    assert "history" not in result["entry"]

    listed, _, _ = client.call("password_list", {})
    assert "history" not in listed["entries"][0]


def test_password_update_unknown_id_reports_error_not_crash(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_update",
        {"id": "does-not-exist", "name": "X", "url": "https://x.example", "username": "u", "password": "p"},
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.entry_not_found"


def test_password_delete_removes_entry(client):
    _setup_and_unlock(client)
    result, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    entry_id = result["entry"]["id"]

    result, _, error = client.call("password_delete", {"id": entry_id})
    assert error is None
    assert result == {"ok": True}

    result, _, _ = client.call("password_list", {})
    assert result["entries"] == []


def test_password_delete_save_failure_keeps_in_memory_cache(monkeypatch, tmp_path):
    original_data_dir = getattr(backend_server, "_data_dir", None)
    original_imk = getattr(backend_server, "_imk", None)
    original_entries = getattr(backend_server, "_password_entries", None)
    entry = passwords.new_entry(
        name="GitHub",
        url="https://github.com",
        username="me",
        password="hunter2",
    )

    def raise_disk_full(*_args):
        raise OSError("disk full")

    backend_server._data_dir = tmp_path
    backend_server._imk = b"x" * 32
    backend_server._password_entries = [entry]
    monkeypatch.setattr(backend_server.passwords, "save_password_vault", raise_disk_full)

    try:
        with pytest.raises(OSError, match="disk full"):
            backend_server.rpc_password_delete({"id": entry.id})
        assert backend_server._password_entries == [entry]
    finally:
        backend_server._data_dir = original_data_dir
        backend_server._imk = original_imk
        backend_server._password_entries = original_entries


def test_password_delete_bulk_removes_only_selected_entries(client):
    _setup_and_unlock(client)
    ids = []
    for name in ("GitHub", "GitLab", "Email"):
        result, _, _ = client.call(
            "password_add",
            {"name": name, "url": f"https://{name.lower()}.example", "username": "me", "password": "hunter2"},
        )
        ids.append(result["entry"]["id"])

    result, _, error = client.call("password_delete_bulk", {"ids": [ids[0], ids[2]]})
    assert error is None
    assert result == {"ok": True, "deleted_count": 2}

    result, _, _ = client.call("password_list", {})
    remaining_names = {e["name"] for e in result["entries"]}
    assert remaining_names == {"GitLab"}


def test_password_delete_bulk_ignores_unknown_ids(client):
    _setup_and_unlock(client)
    result, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    entry_id = result["entry"]["id"]

    result, _, error = client.call("password_delete_bulk", {"ids": [entry_id, "not-a-real-id"]})
    assert error is None
    assert result == {"ok": True, "deleted_count": 1}


def test_password_dedupe_preserves_entries_with_distinct_history(client):
    # 三条 GitHub 当前值一致，但各自历史快照里记着不同的 url，历史互不相同；破坏性去重会真删记录，
    # 删任何一条都会丢失它独有的历史密码，所以应一条都不删。
    _setup_and_unlock(client)
    added = []
    for i in range(3):
        result, _, _ = client.call(
            "password_add",
            {"name": "GitHub", "url": f"https://github.com/{i}", "username": "me", "password": "hunter2", "notes": "x"},
        )
        added.append(result["entry"]["id"])
    for entry_id in added:
        client.call(
            "password_update",
            {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2", "notes": "x"},
        )
    client.call(
        "password_add",
        {"name": "Email", "url": "https://mail.example.com", "username": "me", "password": "p@ss"},
    )

    result, _, error = client.call("password_dedupe", {})
    assert error is None
    assert result == {"ok": True, "deleted_count": 0}

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 4  # 3 条历史各异的 GitHub + Email，全部保留
    names = sorted(e["name"] for e in result["entries"])
    assert names == ["Email", "GitHub", "GitHub", "GitHub"]


def test_password_dedupe_deletes_and_persists_true_content_duplicates(client, tmp_path):
    # 造出"当前值 + 历史内容"完全一致的两条记录：password_add 的精确重复保护会挡掉两条相同的初始记录，
    # 所以先把 A 改到第二状态，再添加初始值相同的 B，最后把 B 也改到同样状态（快照时间戳是偶发元数据，
    # 不参与去重判定）。
    _setup_and_unlock(client)
    s1 = {"name": "Bank", "url": "https://bank.example", "username": "me", "password": "p1", "notes": "n"}
    s2 = {"name": "Bank", "url": "https://bank.example", "username": "me", "password": "p2", "notes": "n"}

    a, _, _ = client.call("password_add", s1)
    assert a["deduped"] is False
    client.call("password_update", {"id": a["entry"]["id"], **s2})

    b, _, _ = client.call("password_add", s1)  # A 现在是 s2，所以这条不被判为重复
    assert b["deduped"] is False
    client.call("password_update", {"id": b["entry"]["id"], **s2})

    client.call(
        "password_add",
        {"name": "Email", "url": "https://mail.example.com", "username": "me", "password": "e"},
    )

    result, _, error = client.call("password_dedupe", {})
    assert error is None
    assert result == {"ok": True, "deleted_count": 1}

    # 用一个全新的后端进程重新打开同一个 data-dir，证明去重结果确实写到了磁盘
    # 上：只剩去重后的一条 Bank（当前值 p2）+ Email。
    fresh = BackendClient(tmp_path / "data")
    try:
        unlocked, _, _ = fresh.call("unlock_password", {"password": "test-password-" + "123"})
        assert unlocked == {"ok": True}
        listed, _, _ = fresh.call("password_list", {})
    finally:
        fresh.close()

    names = sorted(e["name"] for e in listed["entries"])
    assert names == ["Bank", "Email"]
    bank = next(e for e in listed["entries"] if e["name"] == "Bank")
    assert bank["password"] == "p2"


def test_password_dedupe_reports_zero_when_nothing_duplicated(client):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    result, _, error = client.call("password_dedupe", {})
    assert error is None
    assert result == {"ok": True, "deleted_count": 0}


def test_password_operations_before_unlock_report_error_not_crash(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("password_list", {})
    assert result is None
    assert error == "auth.not_unlocked"


def test_password_import_csv_preview_classifies_add_and_update_rows(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com,me,new-pass\n"  # same account, different password -> update
        "Email,https://mail.example.com,me@example.com,p@ss\n",  # unseen account -> add
        encoding="utf-8",
    )

    result, _, error = client.call("password_import_csv_preview", {"input_path": str(csv_path)})
    assert error is None
    assert result["ok"] is True
    assert result["total_rows"] == 2
    assert result["add_count"] == 1
    assert result["update_count"] == 1
    rows = {r["name"]: r for r in result["rows"]}
    assert rows["GitHub"]["action"] == "update"
    assert rows["Email"]["action"] == "add"
    # Preview must not write anything or touch the source file.
    assert csv_path.exists()
    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 1


def test_password_import_csv_confirm_adds_selected_rows_and_deletes_source_by_default(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com,me,hunter2\n"
        "Email,https://mail.example.com,me@example.com,p@ss\n",
        encoding="utf-8",
    )

    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [0, 1]}
    )
    assert error is None
    assert result["ok"] is True
    assert result["added_count"] == 2
    assert result["updated_count"] == 0
    assert result["skipped_count"] == 0
    assert result["source_deleted"] is True
    assert not csv_path.exists()

    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 2


def test_password_import_csv_confirm_writes_survive_backend_restart(client, tmp_path):
    # 其他 confirm 测试在同进程用 password_list 复查，而 _password_entries 是内存缓存，即使
    # save_password_vault 被误丢也会通过；只有新进程才能证明确实落盘。
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]

    csv_path = tmp_path / "reimport.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com,me,new-pass\n"  # update to existing account
        "Email,https://mail.example.com,me@example.com,p@ss\n",  # brand new account
        encoding="utf-8",
    )
    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [0, 1]}
    )
    assert error is None
    assert result["added_count"] == 1
    assert result["updated_count"] == 1

    fresh = BackendClient(tmp_path / "data")
    try:
        unlocked, _, _ = fresh.call("unlock_password", {"password": "test-password-" + "123"})
        assert unlocked == {"ok": True}
        listed, _, _ = fresh.call("password_list", {})
    finally:
        fresh.close()

    entries_by_name = {e["name"]: e for e in listed["entries"]}
    assert sorted(entries_by_name) == ["Email", "GitHub"]
    assert entries_by_name["GitHub"]["id"] == entry_id  # updated in place, not a new row
    assert entries_by_name["GitHub"]["password"] == "new-pass"


def test_password_import_csv_confirm_can_keep_source_file(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text("name,url,username,password\nGitHub,https://github.com,me,hunter2\n", encoding="utf-8")

    result, _, error = client.call(
        "password_import_csv_confirm",
        {"input_path": str(csv_path), "selected_row_indices": [0], "delete_source_csv": False},
    )
    assert error is None
    assert "source_deleted" not in result
    assert csv_path.exists()


def test_password_import_csv_confirm_can_deselect_rows(client, tmp_path):
    # 验收标准：用户可在预览阶段勾选/取消部分导入项 - 未被选中的行不写入。
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com,me,hunter2\n"
        "Email,https://mail.example.com,me@example.com,p@ss\n",
        encoding="utf-8",
    )

    result, _, error = client.call(
        "password_import_csv_confirm",
        {"input_path": str(csv_path), "selected_row_indices": [0], "delete_source_csv": False},
    )
    assert error is None
    assert result["added_count"] == 1
    assert result["skipped_count"] == 1

    result, _, _ = client.call("password_list", {})
    assert [e["name"] for e in result["entries"]] == ["GitHub"]


def test_password_import_csv_confirm_updates_matched_account_and_preserves_history(client, tmp_path):
    # 更新检测（v4 需求文档一）：同网址+同用户名再次导入被识别为"更新"，且
    # 更新走 PasswordEntry.updated()，旧密码进入历史，而不是新增第二条记录。
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]

    csv_path = tmp_path / "reimport.csv"
    csv_path.write_text(
        "name,url,username,password\nGitHub,https://github.com,me,new-pass\n", encoding="utf-8"
    )
    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [0]}
    )
    assert error is None
    assert result["added_count"] == 0
    assert result["updated_count"] == 1

    listed, _, _ = client.call("password_list", {})
    assert len(listed["entries"]) == 1  # updated in place, not a second row
    assert listed["entries"][0]["id"] == entry_id
    assert listed["entries"][0]["password"] == "new-pass"


def test_password_import_csv_preview_collapses_duplicate_accounts_within_same_csv(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text(
        "name,url,username,password\n"
        "GitHub,https://github.com,me,v1\n"
        "GitHub,https://github.com,me,v2\n",
        encoding="utf-8",
    )

    result, _, error = client.call("password_import_csv_preview", {"input_path": str(csv_path)})
    assert error is None
    assert result["rows"][0]["action"] == "superseded_in_batch"
    assert result["rows"][0]["superseded_by"] == 1
    assert result["rows"][1]["action"] == "add"

    # Confirming only the winning row is the correct/expected UI flow.
    result, _, _ = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [1]}
    )
    assert result["added_count"] == 1
    result, _, _ = client.call("password_list", {})
    assert len(result["entries"]) == 1
    assert result["entries"][0]["password"] == "v2"


def test_password_import_csv_preview_bad_format_reports_error(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("name,url\nGitHub,https://github.com\n", encoding="utf-8")

    result, _, error = client.call("password_import_csv_preview", {"input_path": str(csv_path)})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.csv_missing_columns"


def test_password_import_csv_confirm_bad_format_reports_error(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("name,url\nGitHub,https://github.com\n", encoding="utf-8")

    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [0]}
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.csv_missing_columns"


def test_password_import_csv_preview_gb18030_encoded_file_is_read(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "gbk_passwords.csv"
    csv_path.write_bytes(
        "name,url,username,password\n网站,https://example.com,用户,密码123\n".encode("gb18030")
    )

    result, _, error = client.call("password_import_csv_preview", {"input_path": str(csv_path)})
    assert error is None
    assert result["ok"] is True
    assert result["rows"][0]["name"] == "网站"
    assert result["rows"][0]["username"] == "用户"


def test_password_import_csv_preview_bad_encoding_reports_error(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "undecodable.csv"
    csv_path.write_bytes(b"name,url,username,password\n\xff\xfe,https://x.example,u,p\n")

    result, _, error = client.call("password_import_csv_preview", {"input_path": str(csv_path)})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.csv_bad_encoding"


def test_password_import_csv_confirm_bad_encoding_reports_error(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "undecodable.csv"
    csv_path.write_bytes(b"name,url,username,password\n\xff\xfe,https://x.example,u,p\n")

    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [0]}
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.csv_bad_encoding"


def test_password_import_csv_confirm_rejects_non_integer_selected_row_indices(client, tmp_path):
    _setup_and_unlock(client)
    csv_path = tmp_path / "chrome_passwords.csv"
    csv_path.write_text("name,url,username,password\nGitHub,https://github.com,me,hunter2\n", encoding="utf-8")

    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": ["0"]}
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.invalid_request"
    assert csv_path.exists()  # rejected before doing anything, including source deletion


def test_password_export_csv_writes_all_entries(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )

    out_path = tmp_path / "export.csv"
    result, _, error = client.call("password_export_csv", {"output_path": str(out_path)})
    assert error is None
    assert result["ok"] is True
    content = out_path.read_text(encoding="utf-8-sig")
    assert "GitHub,https://github.com,me,hunter2" in content


def test_password_get_history_returns_empty_list_for_never_updated_entry(client):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    result, _, error = client.call("password_get_history", {"id": added["entry"]["id"]})
    assert error is None
    assert result == {"ok": True, "history": []}


def test_password_get_history_returns_snapshots_newest_first(client):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "v1"},
    )
    entry_id = added["entry"]["id"]
    client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "v2"},
    )
    client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "v3"},
    )

    result, _, error = client.call("password_get_history", {"id": entry_id})
    assert error is None
    assert result["ok"] is True
    assert [h["password"] for h in result["history"]] == ["v2", "v1"]


def test_password_get_history_caps_at_five_snapshots(client):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "v0"},
    )
    entry_id = added["entry"]["id"]
    for i in range(1, 7):
        client.call(
            "password_update",
            {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": f"v{i}"},
        )

    result, _, _ = client.call("password_get_history", {"id": entry_id})
    assert len(result["history"]) == 5
    assert [h["password"] for h in result["history"]] == ["v5", "v4", "v3", "v2", "v1"]


def test_password_get_history_unknown_id_reports_error_not_crash(client):
    _setup_and_unlock(client)
    result, _, error = client.call("password_get_history", {"id": "does-not-exist"})
    assert error is None
    assert result == {"ok": False, "error": "password.entry_not_found"}


def test_password_list_still_omits_history_when_entry_has_some(client):
    # M1's redaction guarantee must survive M6's new dedicated history RPC -
    # password_list must still never carry history alongside it.
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "v1"},
    )
    client.call(
        "password_update",
        {"id": added["entry"]["id"], "name": "GitHub", "url": "https://github.com", "username": "me", "password": "v2"},
    )
    result, _, _ = client.call("password_list", {})
    assert "history" not in result["entries"][0]


def test_password_sort_mode_get_defaults_to_recent(client):
    _setup_and_unlock(client)
    result, _, error = client.call("password_sort_mode_get", {})
    assert error is None
    assert result == {"ok": True, "sort_mode": "recent"}


def test_password_sort_mode_set_then_get_round_trips(client):
    _setup_and_unlock(client)
    result, _, error = client.call("password_sort_mode_set", {"sort_mode": "alphabetical"})
    assert error is None
    assert result == {"ok": True, "sort_mode": "alphabetical"}

    result, _, _ = client.call("password_sort_mode_get", {})
    assert result == {"ok": True, "sort_mode": "alphabetical"}


def test_password_sort_mode_persists_across_backend_restart(client, tmp_path):
    _setup_and_unlock(client)
    client.call("password_sort_mode_set", {"sort_mode": "host"})

    fresh = BackendClient(tmp_path / "data")
    try:
        unlocked, _, _ = fresh.call("unlock_password", {"password": "test-password-" + "123"})
        assert unlocked == {"ok": True}
        result, _, _ = fresh.call("password_sort_mode_get", {})
    finally:
        fresh.close()
    assert result == {"ok": True, "sort_mode": "host"}


def test_password_sort_mode_set_rejects_unknown_mode(client):
    _setup_and_unlock(client)
    result, _, error = client.call("password_sort_mode_set", {"sort_mode": "not-a-real-mode"})
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_sort_mode_requires_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("password_sort_mode_get", {})
    assert result is None
    assert error == "auth.not_unlocked"


def _all_unlocked(**overrides):
    """模块锁的期望字典，从 ui_settings.LOCKABLE_MODULES 派生；写死表每加一个可锁模块就要改三处断言。"""
    from modules.file_vault import ui_settings
    expected = {module: False for module in ui_settings.LOCKABLE_MODULES}
    expected.update(overrides)
    return expected


def test_module_lock_settings_get_defaults_to_all_unlocked(client):
    _setup_and_unlock(client)
    result, _, error = client.call("module_lock_settings_get", {})
    assert error is None
    assert result == {
        "ok": True,
        "settings": _all_unlocked(),
    }


def test_module_lock_settings_set_then_get_round_trips(client):
    _setup_and_unlock(client)
    result, _, error = client.call("module_lock_settings_set", {"module": "passwords", "enabled": True})
    assert error is None
    assert result == {"ok": True, "module": "passwords", "enabled": True}

    result, _, _ = client.call("module_lock_settings_get", {})
    assert result == {
        "ok": True,
        "settings": _all_unlocked(passwords=True),
    }


def test_module_lock_settings_persists_across_backend_restart(client, tmp_path):
    _setup_and_unlock(client)
    client.call("module_lock_settings_set", {"module": "clipboard", "enabled": True})

    fresh = BackendClient(tmp_path / "data")
    try:
        unlocked, _, _ = fresh.call("unlock_password", {"password": "test-password-" + "123"})
        assert unlocked == {"ok": True}
        result, _, _ = fresh.call("module_lock_settings_get", {})
    finally:
        fresh.close()
    assert result == {
        "ok": True,
        "settings": _all_unlocked(clipboard=True),
    }


def test_module_lock_settings_set_rejects_unknown_module(client):
    _setup_and_unlock(client)
    result, _, error = client.call("module_lock_settings_set", {"module": "not-a-real-module", "enabled": True})
    assert error is None
    assert result == {"ok": False, "error": "settings.invalid_request"}


def test_module_lock_settings_set_rejects_non_boolean_enabled(client):
    _setup_and_unlock(client)
    result, _, error = client.call("module_lock_settings_set", {"module": "files", "enabled": "true"})
    assert error is None
    assert result == {"ok": False, "error": "settings.invalid_request"}


def test_module_lock_settings_requires_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("module_lock_settings_get", {})
    assert result is None
    assert error == "auth.not_unlocked"



def test_password_add_rejects_request_missing_a_required_field(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_add",
        {"url": "https://github.com", "username": "me", "password": "hunter2"},  # missing name
    )
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_add_rejects_request_with_unknown_field(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_add",
        {
            "name": "GitHub",
            "url": "https://github.com",
            "username": "me",
            "password": "hunter2",
            "unexpected": "nope",
        },
    )
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_add_rejects_request_with_client_supplied_history(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "password_add",
        {
            "name": "GitHub",
            "url": "https://github.com",
            "username": "me",
            "password": "hunter2",
            "history": [],
        },
    )
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_add_invalid_request_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    before = _vault_snapshot(tmp_path)
    client.call("password_add", {"name": "GitHub", "url": "https://github.com", "history": []})
    assert _vault_snapshot(tmp_path) == before


def test_password_update_rejects_request_missing_a_required_field(client):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]

    result, _, error = client.call(
        "password_update",
        {"id": entry_id, "url": "https://github.com", "username": "me", "password": "new-pass"},  # missing name
    )
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_update_rejects_request_with_unknown_field(client):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]

    result, _, error = client.call(
        "password_update",
        {
            "id": entry_id,
            "name": "GitHub",
            "url": "https://github.com",
            "username": "me",
            "password": "new-pass",
            "unexpected": "nope",
        },
    )
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_update_rejects_request_with_client_supplied_history(client):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]

    result, _, error = client.call(
        "password_update",
        {
            "id": entry_id,
            "name": "GitHub",
            "url": "https://github.com",
            "username": "me",
            "password": "new-pass",
            "history": [],
        },
    )
    assert error is None
    assert result == {"ok": False, "error": "password.invalid_request"}


def test_password_update_invalid_request_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]
    before = _vault_snapshot(tmp_path)

    client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "history": []},
    )
    assert _vault_snapshot(tmp_path) == before


def test_password_add_malformed_value_does_not_poison_shared_cache(client, tmp_path):
    # `notes` 为 int 能通过 _has_exact_request_keys（只查键名），但在 save_password_vault 的
    # to_storage_json() -> from_storage_json() 里被 passwords.py 深度类型校验拦下，抛
    # PasswordVaultError('password.content_corrupted')，穿过 dispatch() 的通用 except，
    # 走 `error` 通道（同 auth.not_unlocked），而不是 {"ok": False, ...} 结果。
    _setup_and_unlock(client)
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call(
        "password_add",
        {"name": "Evil", "url": "https://evil.example", "username": "u", "password": "p", "notes": 12345},
    )
    assert result is None
    assert error == "password.content_corrupted"
    assert _vault_snapshot(tmp_path) == before  # 校验先于写盘，半成品从未落盘

    # 回归要点：失败的请求不能在共享内存缓存 _password_entries 里留下畸形条目，否则下面完全合法的
    # 请求也会因 save_password_vault 深度校验整个列表而失败。
    result, _, error = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert error is None
    assert result["ok"] is True

    listed, _, _ = client.call("password_list", {})
    assert len(listed["entries"]) == 1
    assert listed["entries"][0]["name"] == "GitHub"  # 畸形的 "Evil" 条目从未被真正持久化或暴露


def test_password_update_malformed_value_does_not_poison_shared_cache(client, tmp_path):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call(
        "password_update",
        {
            "id": entry_id,
            "name": "GitHub",
            "url": "https://github.com",
            "username": "me",
            "password": "new-pass",
            "notes": 12345,
        },
    )
    assert result is None
    assert error == "password.content_corrupted"
    assert _vault_snapshot(tmp_path) == before

    # 同样的回归断言：紧随其后的一次完全合法的更新必须成功，而不是被第一次
    # 失败的请求残留在 entries[i] 里的畸形条目连累。
    result, _, error = client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "second-pass"},
    )
    assert error is None
    assert result["ok"] is True
    assert result["entry"]["password"] == "second-pass"

    listed, _, _ = client.call("password_list", {})
    assert len(listed["entries"]) == 1
    assert listed["entries"][0]["password"] == "second-pass"


def test_password_add_exact_duplicate_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert error is None
    assert result["deduped"] is True
    assert _vault_snapshot(tmp_path) == before


def test_password_update_unchanged_fields_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    entry_id = added["entry"]["id"]
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    assert error is None
    assert result["ok"] is True
    assert result["entry"]["id"] == entry_id
    assert _vault_snapshot(tmp_path) == before


def test_password_update_unknown_id_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call(
        "password_update",
        {"id": "does-not-exist", "name": "X", "url": "https://x.example", "username": "u", "password": "p"},
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.entry_not_found"
    assert _vault_snapshot(tmp_path) == before


def test_password_delete_unknown_id_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call("password_delete", {"id": "does-not-exist"})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "password.entry_not_found"
    assert _vault_snapshot(tmp_path) == before


def test_password_delete_bulk_empty_ids_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call("password_delete_bulk", {"ids": []})
    assert error is None
    assert result == {"ok": True, "deleted_count": 0}
    assert _vault_snapshot(tmp_path) == before


def test_password_dedupe_no_duplicates_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    result, _, error = client.call("password_dedupe", {})
    assert error is None
    assert result == {"ok": True, "deleted_count": 0}
    assert _vault_snapshot(tmp_path) == before


def test_password_import_csv_confirm_empty_selection_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    csv_path = tmp_path / "empty.csv"
    csv_path.write_text("name,url,username,password\n", encoding="utf-8")
    result, _, error = client.call(
        "password_import_csv_confirm",
        {"input_path": str(csv_path), "selected_row_indices": [], "delete_source_csv": False},
    )
    assert error is None
    assert result["ok"] is True
    assert result["added_count"] == 0
    assert result["updated_count"] == 0
    assert _vault_snapshot(tmp_path) == before


def test_password_import_csv_confirm_all_unchanged_rows_does_not_write_vault(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    before = _vault_snapshot(tmp_path)

    csv_path = tmp_path / "dup.csv"
    csv_path.write_text(
        "name,url,username,password\nGitHub,https://github.com,me,hunter2\n", encoding="utf-8"
    )
    result, _, error = client.call(
        "password_import_csv_confirm",
        {"input_path": str(csv_path), "selected_row_indices": [0], "delete_source_csv": False},
    )
    assert error is None
    assert result["ok"] is True
    assert result["added_count"] == 0
    assert result["updated_count"] == 0
    assert result["skipped_count"] == 1
    assert _vault_snapshot(tmp_path) == before


def test_password_import_csv_confirm_deletes_source_even_when_nothing_written(client, tmp_path):
    # Skipping the (zero-change) vault save must not skip the requested
    # source-file deletion - those are two independent outcomes.
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )

    csv_path = tmp_path / "dup.csv"
    csv_path.write_text(
        "name,url,username,password\nGitHub,https://github.com,me,hunter2\n", encoding="utf-8"
    )
    result, _, error = client.call(
        "password_import_csv_confirm", {"input_path": str(csv_path), "selected_row_indices": [0]}
    )
    assert error is None
    assert result["added_count"] == 0
    assert result["source_deleted"] is True
    assert not csv_path.exists()


def test_password_import_csv_preview_recognizes_unchanged_even_when_existing_entry_has_history(client, tmp_path):
    # 回归：已积累历史的条目，必须按账号（url+username）而非历史感知的全等判定，匹配新解析的 CSV 行
    # （history 恒为 []），否则重复导入同一 CSV 会误判为"add"并给同一账号建第二行。
    _setup_and_unlock(client)
    added, _, _ = client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "old-pass"},
    )
    entry_id = added["entry"]["id"]
    # Effective update: gives the entry one snapshot of history and moves its
    # current password from old-pass to new-pass.
    client.call(
        "password_update",
        {"id": entry_id, "name": "GitHub", "url": "https://github.com", "username": "me", "password": "new-pass"},
    )

    csv_path = tmp_path / "reimport.csv"
    csv_path.write_text(
        "name,url,username,password\nGitHub,https://github.com,me,new-pass\n", encoding="utf-8"
    )
    preview, _, error = client.call("password_import_csv_preview", {"input_path": str(csv_path)})
    assert error is None
    assert preview["rows"][0]["action"] == "unchanged"  # matches the existing entry's current state
    assert preview["rows"][0]["match_id"] == entry_id

    result, _, _ = client.call(
        "password_import_csv_confirm",
        {"input_path": str(csv_path), "selected_row_indices": [0], "delete_source_csv": False},
    )
    assert result["added_count"] == 0
    assert result["updated_count"] == 0

    listed, _, _ = client.call("password_list", {})
    assert len(listed["entries"]) == 1
    assert listed["entries"][0]["id"] == entry_id


def test_update_email_does_not_clobber_smtp_password_when_left_blank(client):
    # get_smtp_config 刻意不回显真实密码，设置对话框的密码框总是空的；只改 host/port 而不重输密码
    # 再保存，不能用空值覆盖原密码（曾静默清零真实 Gmail 应用密码，之后表现为难懂的 SMTP 认证失败）。
    _setup_and_unlock(client)
    client.call(
        "update_email",
        {
            "new_email": "user@example.com",
            "smtp_config": {
                "host": "smtp.example.com",
                "port": 587,
                "username": "user@example.com",
                "password": "real-app-password",
                "use_ssl": False,
            },
        },
    )

    result, _, error = client.call(
        "update_email",
        {
            "new_email": "user@example.com",
            "smtp_config": {
                "host": "smtp.example.com",
                "port": 465,
                "username": "user@example.com",
                "password": "",
                "use_ssl": True,
            },
        },
    )
    assert error is None
    assert result["ok"] is True

    saved_blob = json.loads(keyring.get_password(client.keyring_service, identity.KEYRING_SMTP_CONFIG))
    assert saved_blob["password"] == "real-app-password"  # preserved, not wiped
    assert saved_blob["port"] == 465  # other fields still update normally


# --- notes ---


def test_note_operations_before_unlock_report_error_not_crash(client):
    result, _, error = client.call("note_list", {})
    assert result is None
    assert error == "auth.not_unlocked"


def test_note_create_then_list_omits_full_content(client):
    _setup_and_unlock(client)
    create_result, _, error = client.call(
        "note_create", {"title": "Todo", "category": "work", "content": "line1\nline2"}
    )
    assert error is None
    assert create_result["ok"] is True
    assert create_result["note"]["content"] == "line1\nline2"

    list_result, _, error = client.call("note_list", {})
    assert error is None
    [note] = list_result["notes"]
    assert note["title"] == "Todo"
    assert note["category"] == "work"
    assert "content" not in note


def test_note_get_returns_full_content(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "Todo", "category": "", "content": "full body"})
    note_id = create_result["note"]["id"]

    result, _, error = client.call("note_get", {"id": note_id})
    assert error is None
    assert result["note"]["content"] == "full body"


def test_note_get_unknown_id_reports_not_found(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_get", {"id": 999999})
    assert result == {"ok": False, "error": "notes.note_not_found"}
    assert error is None


def test_note_find_title_mentions_rpc_round_trip(client):
    _setup_and_unlock(client)
    target_result, _, _ = client.call("note_create", {"title": "项目会议纪要", "category": "", "content": ""})
    target_id = target_result["note"]["id"]
    mentioning_result, _, _ = client.call(
        "note_create", {"title": "周报", "category": "", "content": "详见项目会议纪要的结论"}
    )
    mentioning_id = mentioning_result["note"]["id"]
    client.call("note_create", {"title": "购物清单", "category": "", "content": "牛奶、鸡蛋"})

    result, _, error = client.call("note_find_title_mentions", {"id": target_id, "title": "项目会议纪要"})
    assert error is None
    assert result["ok"] is True
    assert [n["id"] for n in result["notes"]] == [mentioning_id]


def test_note_update_changes_title_and_content(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "old", "category": "", "content": "old body"})
    note_id = create_result["note"]["id"]

    result, _, error = client.call("note_update", {"id": note_id, "title": "new", "content": "new body"})
    assert error is None
    assert result["ok"] is True
    assert result["note"]["title"] == "new"
    assert result["note"]["content"] == "new body"


def test_note_set_pinned_then_bulk(client):
    _setup_and_unlock(client)
    ids = []
    for i in range(3):
        r, _, _ = client.call("note_create", {"title": f"n{i}", "category": "", "content": ""})
        ids.append(r["note"]["id"])

    result, _, error = client.call("note_set_pinned", {"id": ids[0], "pinned": True})
    assert error is None and result == {"ok": True}

    result, _, error = client.call("note_set_pinned_bulk", {"ids": ids[1:], "pinned": True})
    assert error is None
    assert result == {"ok": True, "updated_count": 2}

    list_result, _, _ = client.call("note_list", {})
    assert all(n["is_pinned"] for n in list_result["notes"])


def test_note_set_hidden_then_bulk(client):
    _setup_and_unlock(client)
    ids = []
    for i in range(2):
        r, _, _ = client.call("note_create", {"title": f"n{i}", "category": "", "content": ""})
        ids.append(r["note"]["id"])

    result, _, error = client.call("note_set_hidden_bulk", {"ids": ids, "hidden": True})
    assert error is None
    assert result == {"ok": True, "updated_count": 2}


def test_note_delete_moves_to_trash_and_restore_brings_it_back(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]

    result, _, error = client.call("note_delete", {"id": note_id})
    assert error is None and result == {"ok": True}

    list_result, _, _ = client.call("note_list", {})
    assert list_result["notes"] == []
    trash_result, _, _ = client.call("note_list_trash", {})
    assert [n["id"] for n in trash_result["notes"]] == [note_id]

    result, _, error = client.call("note_restore", {"id": note_id})
    assert error is None and result == {"ok": True}
    list_result, _, _ = client.call("note_list", {})
    assert [n["id"] for n in list_result["notes"]] == [note_id]


def test_note_delete_bulk_moves_all_given_ids_to_trash(client):
    _setup_and_unlock(client)
    ids = []
    for i in range(3):
        r, _, _ = client.call("note_create", {"title": f"n{i}", "category": "", "content": ""})
        ids.append(r["note"]["id"])

    result, _, error = client.call("note_delete_bulk", {"ids": ids})
    assert error is None
    assert result == {"ok": True, "deleted_count": 3}


def test_note_hard_delete_removes_it_permanently(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    client.call("note_delete", {"id": note_id})

    result, _, error = client.call("note_hard_delete", {"id": note_id})
    assert error is None and result == {"ok": True}

    trash_result, _, _ = client.call("note_list_trash", {})
    assert trash_result["notes"] == []


def test_note_hard_delete_bulk_removes_all_given_ids(client):
    _setup_and_unlock(client)
    ids = []
    for i in range(2):
        r, _, _ = client.call("note_create", {"title": f"n{i}", "category": "", "content": ""})
        ids.append(r["note"]["id"])
        client.call("note_delete", {"id": r["note"]["id"]})

    result, _, error = client.call("note_hard_delete_bulk", {"ids": ids})
    assert error is None
    assert result == {"ok": True, "deleted_count": 2}


# test_note_create_content_over_byte_limit_reports_error 随 NOTE_BYTE_LIMIT 放宽到 2GiB 被移除：
# 经真实子进程管道传超限字符串要几十秒、数 GB 内存。_validate_size 抛 VaultError 已在
# test_notes_storage.py 用小上限测过，VaultError 到 RPC 错误的翻译是通用代码，别处已覆盖。


def test_note_import_files_creates_a_note_per_file_titled_by_filename(client, tmp_path):
    _setup_and_unlock(client)
    file_a = tmp_path / "shopping list.txt"
    file_a.write_text("milk\neggs", encoding="utf-8")
    file_b = tmp_path / "meeting notes.txt"
    file_b.write_text("agenda", encoding="utf-8")

    result, _, error = client.call("note_import_files", {"paths": [str(file_a), str(file_b)]})
    assert error is None
    assert result["ok"] is True
    assert len(result["imported"]) == 2
    assert result["failed"] == []
    imported_by_title = {n["title"]: n for n in result["imported"]}
    assert set(imported_by_title) == {"shopping list", "meeting notes"}
    # 导入结果本来就只是用来刷新列表，不应该把整份正文原样带回来（几百MB级
    # 导入场景下这会重新制造"一条消息塞整份正文"的老问题）
    assert all("content" not in n for n in result["imported"])

    contents = {}
    for note in result["imported"]:
        get_result, _, _ = client.call("note_get", {"id": note["id"]})
        contents[note["title"]] = get_result["note"]["content"]
    assert contents == {"shopping list": "milk\neggs", "meeting notes": "agenda"}

    list_result, _, _ = client.call("note_list", {})
    assert len(list_result["notes"]) == 2
    # 原文件保持不动，导入只是把内容复制进笔记库
    assert file_a.exists()
    assert file_b.exists()


def test_note_import_files_reports_progress_tagged_with_file_index_and_name(client, tmp_path):
    _setup_and_unlock(client)
    file_a = tmp_path / "a.txt"
    file_a.write_text("x" * 3_000_000, encoding="utf-8")  # big enough to span several stream chunks
    file_b = tmp_path / "b.txt"
    file_b.write_text("y" * 3_000_000, encoding="utf-8")

    result, progress_events, error = client.call("note_import_files", {"paths": [str(file_a), str(file_b)]})
    assert error is None
    assert result["ok"] is True
    assert progress_events  # at least one progress message came through mid-call
    assert {e["file_index"] for e in progress_events} == {0, 1}
    assert {e["file_name"] for e in progress_events} == {"a.txt", "b.txt"}
    assert all(e["total_files"] == 2 for e in progress_events)
    last_for_a = [e for e in progress_events if e["file_index"] == 0][-1]
    assert last_for_a["done"] == last_for_a["total"] == 3_000_000


def test_note_import_files_partial_failure_does_not_abort_the_rest(client, tmp_path):
    _setup_and_unlock(client)
    good_file = tmp_path / "good.txt"
    good_file.write_text("hello", encoding="utf-8")
    missing_file = tmp_path / "does_not_exist.txt"
    binary_file = tmp_path / "binary.txt"
    binary_file.write_bytes(b"\xff\xfe\x00\xff\xd8\xff")

    result, _, error = client.call(
        "note_import_files", {"paths": [str(good_file), str(missing_file), str(binary_file)]}
    )
    assert error is None
    assert result["ok"] is True
    assert len(result["imported"]) == 1
    assert result["imported"][0]["title"] == "good"
    assert len(result["failed"]) == 2
    failed_paths = {f["path"] for f in result["failed"]}
    assert failed_paths == {str(missing_file), str(binary_file)}


def test_note_create_with_encrypt_false_stores_disk_plain_and_still_round_trips_content(client, tmp_path):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "note_create", {"title": "plain", "category": "", "content": "not encrypted", "encrypt": False}
    )
    assert error is None
    assert result["ok"] is True
    note = result["note"]
    assert note["content_storage_mode"] == "disk_plain"
    assert note["content"] == "not encrypted"

    # 明文文本真的落在磁盘上的一个独立文件里，不是塞在别的地方
    texts_dir = tmp_path / "data" / "notes_texts"
    plain_files = list(texts_dir.glob("*.txt"))
    assert len(plain_files) == 1
    assert plain_files[0].read_text(encoding="utf-8") == "not encrypted"

    get_result, _, _ = client.call("note_get", {"id": note["id"]})
    assert get_result["ok"] is True
    assert get_result["note"]["content"] == "not encrypted"
    assert get_result["note"]["content_storage_mode"] == "disk_plain"


def test_note_content_chunk_get_round_trips_for_both_storage_modes(client):
    _setup_and_unlock(client)
    for encrypt, mode in ((False, "disk_plain"), (True, "encrypted_db")):
        original = "chunked read test - " * 5000
        create_result, _, _ = client.call(
            "note_create", {"title": "t", "category": "", "content": original, "encrypt": encrypt}
        )
        note_id = create_result["note"]["id"]

        chunks = []
        cursor = None
        while True:
            chunk_result, _, error = client.call(
                "note_content_chunk_get", {"id": note_id, "cursor": cursor, "max_chars": 1000}
            )
            assert error is None
            assert chunk_result["ok"] is True
            chunks.append(chunk_result["chunk"])
            cursor = chunk_result["next_cursor"]
            if chunk_result["eof"]:
                break
        assert "".join(chunks) == original, f"mismatch for content_storage_mode={mode}"


def test_note_content_chunk_get_unknown_note_reports_not_found(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_content_chunk_get", {"id": 999, "cursor": None, "max_chars": 100})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "notes.note_not_found"


def test_note_content_write_chunk_round_trips_for_both_storage_modes(client):
    _setup_and_unlock(client)
    for encrypt, mode in ((False, "disk_plain"), (True, "encrypted_db")):
        create_result, _, _ = client.call(
            "note_create", {"title": "t", "category": "", "content": "old", "encrypt": encrypt}
        )
        note_id = create_result["note"]["id"]
        new_content = "new saved content - " * 3000

        pieces = [new_content[i : i + 4096] for i in range(0, len(new_content), 4096)]
        for i, piece in enumerate(pieces):
            result, _, error = client.call(
                "note_content_write_chunk",
                {"id": note_id, "chunk": piece, "is_first": i == 0, "is_last": i == len(pieces) - 1},
            )
            assert error is None
            assert result["ok"] is True

        get_result, _, _ = client.call("note_get", {"id": note_id})
        assert get_result["note"]["content"] == new_content, f"mismatch for content_storage_mode={mode}"


def test_note_create_default_encrypt_true_stores_encrypted_db(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_create", {"title": "enc", "category": "", "content": "secret"})
    assert error is None
    assert result["note"]["content_storage_mode"] == "encrypted_db"


def test_note_update_disk_plain_note_overwrites_the_plain_file(client, tmp_path):
    _setup_and_unlock(client)
    create_result, _, _ = client.call(
        "note_create", {"title": "plain", "category": "", "content": "v1", "encrypt": False}
    )
    note_id = create_result["note"]["id"]

    update_result, _, error = client.call("note_update", {"id": note_id, "content": "v2 updated"})
    assert error is None
    assert update_result["ok"] is True
    assert update_result["note"]["content"] == "v2 updated"

    texts_dir = tmp_path / "data" / "notes_texts"
    [plain_file] = list(texts_dir.glob("*.txt"))
    assert plain_file.read_text(encoding="utf-8") == "v2 updated"


def test_note_import_files_with_encrypt_false_applies_to_the_whole_batch(client, tmp_path):
    _setup_and_unlock(client)
    file_a = tmp_path / "a.txt"
    file_a.write_text("content a", encoding="utf-8")
    file_b = tmp_path / "b.txt"
    file_b.write_text("content b", encoding="utf-8")

    result, _, error = client.call("note_import_files", {"paths": [str(file_a), str(file_b)], "encrypt": False})
    assert error is None
    assert result["ok"] is True
    assert len(result["imported"]) == 2
    assert all(n["content_storage_mode"] == "disk_plain" for n in result["imported"])

    texts_dir = tmp_path / "data" / "notes_texts"
    assert len(list(texts_dir.glob("*.txt"))) == 2


# --- note_import_files 的 base_dir：用子文件夹路径当分类（见
# backend_server.py::_folder_category_for），复用于"从文件夹批量导入" ---


def test_note_import_files_with_base_dir_uses_relative_subfolder_as_category(client, tmp_path):
    scan_root = tmp_path / "to_scan"
    (scan_root / "简历").mkdir(parents=True)
    file_path = scan_root / "简历" / "简历AI指令.txt"
    file_path.write_text("无关内容", encoding="utf-8")
    _setup_and_unlock(client)

    result, _, error = client.call("note_import_files", {"paths": [str(file_path)], "base_dir": str(scan_root)})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == "简历"


def test_note_import_files_with_base_dir_joins_nested_subfolders_with_slash(client, tmp_path):
    scan_root = tmp_path / "to_scan"
    (scan_root / "Internet" / "Node").mkdir(parents=True)
    file_path = scan_root / "Internet" / "Node" / "S-UI设置.txt"
    file_path.write_text("无关内容", encoding="utf-8")
    _setup_and_unlock(client)

    result, _, error = client.call("note_import_files", {"paths": [str(file_path)], "base_dir": str(scan_root)})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == "Internet/Node"


def test_note_import_files_with_base_dir_registers_the_derived_category_in_the_catalog(client, tmp_path):
    scan_root = tmp_path / "to_scan"
    (scan_root / "自主设计").mkdir(parents=True)
    file_path = scan_root / "自主设计" / "note.txt"
    file_path.write_text("无关内容", encoding="utf-8")
    _setup_and_unlock(client)

    client.call("note_import_files", {"paths": [str(file_path)], "base_dir": str(scan_root)})

    list_result, _, _ = client.call("note_category_list", {"scope": "normal"})
    assert "自主设计" in [c["name"] for c in list_result["categories"]]


def test_note_import_files_with_base_dir_falls_back_to_keyword_classification_at_root_level(client, tmp_path):
    # 直接在 base_dir 下的文件没有文件夹信号，回退到现有关键词/名称分类器，同没有 base_dir 的导入。
    scan_root = tmp_path / "to_scan"
    scan_root.mkdir(parents=True)
    file_path = scan_root / "旅行计划.txt"
    file_path.write_text("无关内容", encoding="utf-8")
    _setup_and_unlock(client)
    client.call("note_category_create", {"name": "旅行", "scope": "normal"})

    result, _, error = client.call("note_import_files", {"paths": [str(file_path)], "base_dir": str(scan_root)})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == "旅行"


def test_note_import_files_without_base_dir_is_unaffected(client, tmp_path):
    file_path = tmp_path / "note.txt"
    file_path.write_text("无关内容", encoding="utf-8")
    _setup_and_unlock(client)

    result, _, error = client.call("note_import_files", {"paths": [str(file_path)]})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == ""


def test_note_scan_txt_dir_finds_txt_md_files_recursively_across_subfolders(client, tmp_path):
    # .md/.markdown 与 .txt 一并扫描（见 backend_server.py 的 _SCANNABLE_NOTE_EXTENSIONS），
    # 文件夹扫描导入须与 .md 文件关联同步，否则注册了 .md 却无法批量导入。
    _setup_and_unlock(client)
    scan_root = tmp_path / "to_scan"
    (scan_root / "sub1" / "sub2").mkdir(parents=True)
    (scan_root / "top.txt").write_text("top", encoding="utf-8")
    (scan_root / "sub1" / "mid.txt").write_text("mid", encoding="utf-8")
    (scan_root / "sub1" / "sub2" / "deep.TXT").write_text("deep", encoding="utf-8")
    (scan_root / "notes.md").write_text("# heading", encoding="utf-8")
    (scan_root / "sub1" / "readme.MARKDOWN").write_text("# heading", encoding="utf-8")
    (scan_root / "ignored.pdf").write_text("not a note", encoding="utf-8")

    result, _, error = client.call("note_scan_txt_dir", {"dir": str(scan_root)})
    assert error is None
    assert result["ok"] is True
    names = {f["name"] for f in result["files"]}
    assert names == {"top.txt", "mid.txt", "deep.TXT", "notes.md", "readme.MARKDOWN"}
    for f in result["files"]:
        assert f["size_bytes"] > 0
        assert "path" in f and "modified_at" in f


def test_note_scan_txt_dir_rejects_a_nonexistent_directory(client, tmp_path):
    _setup_and_unlock(client)
    result, _, error = client.call("note_scan_txt_dir", {"dir": str(tmp_path / "does_not_exist")})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "notes.scan_dir_not_found"


def test_note_export_files_writes_one_txt_per_note_named_by_title(client, tmp_path):
    _setup_and_unlock(client)
    r1, _, _ = client.call("note_create", {"title": "shopping list", "category": "", "content": "milk\neggs"})
    r2, _, _ = client.call("note_create", {"title": "meeting notes", "category": "", "content": "agenda"})
    out_dir = tmp_path / "export"
    out_dir.mkdir()

    result, _, error = client.call(
        "note_export_files", {"ids": [r1["note"]["id"], r2["note"]["id"]], "output_dir": str(out_dir)}
    )
    assert error is None
    assert result["ok"] is True
    assert len(result["exported"]) == 2
    assert result["failed"] == []
    assert (out_dir / "shopping list.txt").read_text(encoding="utf-8") == "milk\neggs"
    assert (out_dir / "meeting notes.txt").read_text(encoding="utf-8") == "agenda"


def test_note_export_files_dedupes_same_title_and_reports_unknown_id(client, tmp_path):
    _setup_and_unlock(client)
    r1, _, _ = client.call("note_create", {"title": "todo", "category": "", "content": "first"})
    r2, _, _ = client.call("note_create", {"title": "todo", "category": "", "content": "second"})
    out_dir = tmp_path / "export"
    out_dir.mkdir()

    result, _, error = client.call(
        "note_export_files", {"ids": [r1["note"]["id"], r2["note"]["id"], 999999], "output_dir": str(out_dir)}
    )
    assert error is None
    assert result["ok"] is True
    assert len(result["exported"]) == 2
    assert result["failed"] == [{"id": 999999, "error": "notes.note_not_found"}]
    assert (out_dir / "todo.txt").exists()
    assert (out_dir / "todo (2).txt").exists()


def test_note_category_create_then_list_then_delete(client):
    _setup_and_unlock(client)
    create_result, _, error = client.call("note_category_create", {"name": "旅行", "scope": "normal"})
    assert error is None
    assert create_result["ok"] is True
    category_id = create_result["category"]["id"]
    assert create_result["category"]["scope"] == "normal"

    list_result, _, _ = client.call("note_category_list", {"scope": "normal"})
    assert [c["name"] for c in list_result["categories"]] == ["旅行"]

    hidden_list_result, _, _ = client.call("note_category_list", {"scope": "hidden"})
    assert hidden_list_result["categories"] == []

    delete_result, _, error = client.call("note_category_delete", {"id": category_id})
    assert error is None
    assert delete_result["ok"] is True
    # 删除响应后来加了 impact（连带影响的子分类/笔记数）。这里断言它报告无连带损失，而非原来
    # `== {"ok": True}` 的全等：全等把"多了字段"和"删除行为错了"混为一谈。
    assert delete_result["impact"]["child_count"] == 0
    assert delete_result["impact"]["descendant_note_count"] == 0
    list_result, _, _ = client.call("note_category_list", {"scope": "normal"})
    assert list_result["categories"] == []


def test_note_category_create_is_idempotent_for_same_name_and_scope(client):
    _setup_and_unlock(client)
    first, _, _ = client.call("note_category_create", {"name": "证件信息", "scope": "hidden"})
    second, _, _ = client.call("note_category_create", {"name": "证件信息", "scope": "hidden"})
    assert first["category"]["id"] == second["category"]["id"]

    list_result, _, _ = client.call("note_category_list", {"scope": "hidden"})
    assert len(list_result["categories"]) == 1


def test_note_category_create_rejects_empty_name(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_category_create", {"name": "   ", "scope": "normal"})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "notes.category_name_required"


def test_note_category_delete_unknown_id_reports_not_found(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_category_delete", {"id": 999999})
    assert result == {"ok": False, "error": "notes.category_not_found"}
    assert error is None


def test_note_category_create_with_keywords_persists_them(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "note_category_create", {"name": "财务", "scope": "normal", "keywords": "发票, 报销"}
    )
    assert error is None
    assert result["ok"] is True
    assert result["category"]["keywords"] == "发票, 报销"


def test_note_category_set_keywords_updates_existing_category(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_category_create", {"name": "财务", "scope": "normal"})
    category_id = create_result["category"]["id"]

    result, _, error = client.call(
        "note_category_set_keywords", {"id": category_id, "keywords": "发票, 报销"}
    )
    assert error is None
    assert result["ok"] is True
    assert result["category"]["keywords"] == "发票, 报销"

    list_result, _, _ = client.call("note_category_list", {"scope": "normal"})
    assert list_result["categories"][0]["keywords"] == "发票, 报销"


def test_note_category_set_keywords_unknown_id_reports_not_found(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_category_set_keywords", {"id": 999999, "keywords": "x"})
    assert result == {"ok": False, "error": "notes.category_not_found"}
    assert error is None


# --- 导入文件自动分类（见 notes/classifier.py，接在 note_import_files 里）---


def test_note_import_files_auto_classifies_using_an_existing_category_matched_in_title(client, tmp_path):
    _setup_and_unlock(client)
    client.call("note_category_create", {"name": "旅行", "scope": "normal"})
    source = tmp_path / "旅行计划.txt"
    source.write_text("随便写点什么", encoding="utf-8")

    result, _, error = client.call("note_import_files", {"paths": [str(source)]})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == "旅行"


def test_note_import_files_auto_classifies_using_a_keyword_when_the_category_name_is_absent(client, tmp_path):
    _setup_and_unlock(client)
    client.call("note_category_create", {"name": "财务", "scope": "normal", "keywords": "发票, 报销"})
    source = tmp_path / "q3.txt"
    source.write_text("附上本季度的发票和报销单据", encoding="utf-8")

    result, _, error = client.call("note_import_files", {"paths": [str(source)]})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == "财务"


def test_note_import_files_leaves_category_empty_when_nothing_matches(client, tmp_path):
    _setup_and_unlock(client)
    client.call("note_category_create", {"name": "旅行", "scope": "normal"})
    source = tmp_path / "untitled.txt"
    source.write_text("今天天气不错", encoding="utf-8")

    result, _, error = client.call("note_import_files", {"paths": [str(source)]})
    assert error is None
    assert result["ok"] is True
    assert result["imported"][0]["category"] == ""


# --- 标签与全文检索（P1 M6/M7）---


def test_note_tags_and_search_rpc_round_trip(client):
    _setup_and_unlock(client)
    create_note_result, _, _ = client.call(
        "note_create", {"title": "发布计划", "category": "工作/项目A", "content": "完成 API 联调"}
    )
    note_id = create_note_result["note"]["id"]

    create_tag_result, _, error = client.call("note_tag_create", {"name": "紧急", "scope": "normal"})
    assert error is None
    tag_id = create_tag_result["tag"]["id"]

    set_result, _, error = client.call("note_tags_set", {"id": note_id, "tag_ids": [tag_id]})
    assert error is None
    assert set_result["note"]["tags"] == ["紧急"]

    search_result, _, error = client.call(
        "note_search", {"query": "API", "category": "工作/项目A", "tag": "紧急"}
    )
    assert error is None
    assert [note["id"] for note in search_result["notes"]] == [note_id]


def test_note_tag_create_rejects_blank_name(client):
    _setup_and_unlock(client)

    result, _, error = client.call("note_tag_create", {"name": "   ", "scope": "normal"})

    assert error is None
    assert result["ok"] is False
    assert result["error"] == "notes.tag_name_required"


def test_note_category_move_and_restore_bulk_rpc(client):
    _setup_and_unlock(client)
    first, _, _ = client.call("note_create", {"title": "one", "category": "old", "content": ""})
    second, _, _ = client.call("note_create", {"title": "two", "category": "old", "content": ""})
    ids = [first["note"]["id"], second["note"]["id"]]

    move_result, _, error = client.call("note_category_move_bulk", {"ids": ids, "category": "工作/项目A"})
    assert error is None
    assert move_result == {"ok": True, "updated_count": 2}

    client.call("note_delete_bulk", {"ids": ids})
    restore_result, _, error = client.call("note_restore_bulk", {"ids": ids})
    assert error is None
    assert restore_result == {"ok": True, "restored_count": 2}


def test_clipboard_set_hidden_rpc_round_trip(client, tmp_path):
    _setup_and_unlock(client)
    # 测试进程没有真实剪贴板事件；clipboard_import 从 JSON 备份种数据，是不 mock 监听器就能经 RPC
    # 层插入条目的唯一路径。
    import_path = tmp_path / "clip-seed.json"
    import_path.write_text(
        json.dumps({"format_version": 1, "entries": [{"content_type": "text", "content_text": "秘密备注"}]}),
        encoding="utf-8",
    )
    import_result, _, error = client.call("clipboard_import", {"input_path": str(import_path)})
    assert error is None
    assert import_result["ok"] is True and import_result["imported_count"] == 1

    list_result, _, _ = client.call("clipboard_list", {})
    entry_id = list_result["entries"][0]["id"]
    assert list_result["entries"][0]["is_hidden"] == 0

    hide_result, _, error = client.call("clipboard_set_hidden", {"id": entry_id, "hidden": True})
    assert error is None
    assert hide_result == {"ok": True}

    # 这四段本属于本用例，却在某次编辑中整段落到了下一个测试（test_global_search_...）里，
    # 于是本用例只验到"调用返回 ok"，没验隐藏状态是否写入，下一个用例则一直红（已在干净 HEAD 复现）。
    list_result, _, _ = client.call("clipboard_list", {})
    assert list_result["entries"][0]["is_hidden"] == 1

    unhide_result, _, error = client.call("clipboard_set_hidden", {"id": entry_id, "hidden": False})
    assert error is None
    assert unhide_result == {"ok": True}
    list_result, _, _ = client.call("clipboard_list", {})
    assert list_result["entries"][0]["is_hidden"] == 0

    unknown_result, _, error = client.call("clipboard_set_hidden", {"id": 999999, "hidden": True})
    assert error is None
    assert unknown_result == {"ok": False, "error": "clipboard.entry_not_found"}


def test_global_search_returns_every_match_not_just_five(client, tmp_path):
    """命令面板（Ctrl+K）的全局搜索不截断，三个模块各返回全部命中项。

    过去每模块只取前 5 条，界面看不出被截断，所以每模块种 7 条（>5）。查询词用中文，是为压住
    另一条路径：含汉字的查询在笔记和剪贴板里会再并一遍子串匹配并 `rows[:limit]`，"不限"若用 -1
    表达会悄悄少给最后一条。
    """
    _setup_and_unlock(client)
    seeded = 7
    assert seeded > 5, "种的条数必须超过原来的上限 5，否则这条用例是空的"

    for i in range(seeded):
        _, _, error = client.call(
            "note_create", {"title": f"预算复核 {i}", "category": "工作", "content": "季度预算超支了三千元"}
        )
        assert error is None
        _, _, error = client.call(
            "password_add",
            {"name": f"预算系统 {i}", "url": "https://budget.example.com", "username": "me", "password": "x"},
        )
        assert error is None

    import_path = tmp_path / "global-search-seed.json"
    import_path.write_text(
        json.dumps(
            {
                "format_version": 1,
                "entries": [{"content_type": "text", "content_text": f"预算 {i} 号复核"} for i in range(seeded)],
            }
        ),
        encoding="utf-8",
    )
    import_result, _, error = client.call("clipboard_import", {"input_path": str(import_path)})
    assert error is None
    assert import_result["ok"] is True and import_result["imported_count"] == seeded

    result, _, error = client.call("global_search", {"query": "预算"})
    assert error is None
    modules = [r["module"] for r in result["results"]]
    assert {m: modules.count(m) for m in ("clipboard", "notes", "passwords")} == {
        "clipboard": seeded,
        "notes": seeded,
        "passwords": seeded,
    }

    # limit 仍然收：给正数就是每个模块最多这么多条（界面不传，所以默认不限）。
    capped, _, error = client.call("global_search", {"query": "预算", "limit": 3})
    assert error is None
    capped_modules = [r["module"] for r in capped["results"]]
    assert {m: capped_modules.count(m) for m in ("clipboard", "notes", "passwords")} == {
        "clipboard": 3,
        "notes": 3,
        "passwords": 3,
    }


def test_clipboard_snippet_create_then_list_rpc(client):
    _setup_and_unlock(client)

    create_result, _, error = client.call("clipboard_snippet_create", {"content_text": "我的签名"})
    assert error is None
    assert create_result["ok"] is True
    assert create_result["entry"]["content_text"] == "我的签名"
    assert create_result["entry"]["is_snippet"] == 1

    list_result, _, error = client.call("clipboard_snippet_list", {})
    assert error is None
    assert [e["id"] for e in list_result["entries"]] == [create_result["entry"]["id"]]

    # 片段不应该混进普通历史记录列表。
    history_result, _, _ = client.call("clipboard_list", {})
    assert history_result["entries"] == []


def test_clipboard_snippet_create_rejects_empty_text(client):
    _setup_and_unlock(client)

    result, _, error = client.call("clipboard_snippet_create", {"content_text": "   "})
    assert error is None
    assert result == {"ok": False, "error": "clipboard.snippet_text_required"}


def test_clipboard_snippet_update_rpc_round_trip(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("clipboard_snippet_create", {"content_text": "v1"})
    snippet_id = create_result["entry"]["id"]

    update_result, _, error = client.call("clipboard_snippet_update", {"id": snippet_id, "content_text": "v2"})
    assert error is None
    assert update_result == {"ok": True}

    list_result, _, _ = client.call("clipboard_snippet_list", {})
    assert list_result["entries"][0]["content_text"] == "v2"


def test_clipboard_snippet_update_rejects_empty_text(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("clipboard_snippet_create", {"content_text": "v1"})
    snippet_id = create_result["entry"]["id"]

    result, _, error = client.call("clipboard_snippet_update", {"id": snippet_id, "content_text": "  "})
    assert error is None
    assert result == {"ok": False, "error": "clipboard.snippet_text_required"}


def test_clipboard_snippet_update_unknown_id_returns_not_found(client):
    _setup_and_unlock(client)

    result, _, error = client.call("clipboard_snippet_update", {"id": 999999, "content_text": "new text"})
    assert error is None
    assert result == {"ok": False, "error": "clipboard.entry_not_found"}


def _seed_clipboard_entries(client, tmp_path, texts):
    # 同 test_clipboard_set_hidden_rpc_round_trip：用 clipboard_import 种数据。返回值按 texts 顺序
    # 对应各自新 id（clipboard_list 按 id DESC 排序，取列表后要反转回插入序）。
    import_path = tmp_path / "clip-seed.json"
    import_path.write_text(
        json.dumps({"format_version": 1, "entries": [{"content_type": "text", "content_text": t} for t in texts]}),
        encoding="utf-8",
    )
    result, _, error = client.call("clipboard_import", {"input_path": str(import_path)})
    assert error is None
    # 断言字段而非整个字典：clipboard_import 的返回值会增长（failed / deleted_sources /
    # delete_failures），全等断言会让每次纯增量的契约扩展弄红五个无关用例。
    assert result["ok"] is True
    assert result["imported_count"] == len(texts)
    assert result["failed"] == []
    # 这个辅助函数没传 delete_source，原件必须原封不动地留着——种数据的 JSON
    # 后面还要被别的断言读。
    assert result["deleted_sources"] == []
    assert import_path.exists()
    list_result, _, _ = client.call("clipboard_list", {})
    by_text = {e["content_text"]: e["id"] for e in list_result["entries"]}
    return [by_text[t] for t in texts]


def test_clipboard_restore_bulk_rpc(client, tmp_path):
    _setup_and_unlock(client)
    ids = _seed_clipboard_entries(client, tmp_path, ["one", "two"])

    delete_result, _, error = client.call("clipboard_delete_bulk", {"ids": ids})
    assert error is None
    assert delete_result == {"ok": True, "deleted_count": 2}
    trash_result, _, _ = client.call("clipboard_list_trash", {})
    assert {e["id"] for e in trash_result["entries"]} == set(ids)

    restore_result, _, error = client.call("clipboard_restore_bulk", {"ids": ids})
    assert error is None
    assert restore_result == {"ok": True, "restored_count": 2}
    list_result, _, _ = client.call("clipboard_list", {})
    assert {e["id"] for e in list_result["entries"]} == set(ids)
    trash_result, _, _ = client.call("clipboard_list_trash", {})
    assert trash_result["entries"] == []


def test_clipboard_hard_delete_rpc(client, tmp_path):
    _setup_and_unlock(client)
    [entry_id] = _seed_clipboard_entries(client, tmp_path, ["gone for good"])
    client.call("clipboard_delete", {"id": entry_id})

    result, _, error = client.call("clipboard_hard_delete", {"id": entry_id})
    assert error is None and result == {"ok": True}

    trash_result, _, _ = client.call("clipboard_list_trash", {})
    assert trash_result["entries"] == []


def test_clipboard_hard_delete_rpc_reports_not_found_for_unknown_id(client):
    _setup_and_unlock(client)

    result, _, error = client.call("clipboard_hard_delete", {"id": 999999})
    assert error is None
    assert result == {"ok": False, "error": "clipboard.entry_not_found"}


def test_clipboard_hard_delete_bulk_rpc(client, tmp_path):
    _setup_and_unlock(client)
    ids = _seed_clipboard_entries(client, tmp_path, ["a", "b"])
    client.call("clipboard_delete_bulk", {"ids": ids})

    result, _, error = client.call("clipboard_hard_delete_bulk", {"ids": ids})
    assert error is None
    assert result == {"ok": True, "deleted_count": 2}

    trash_result, _, _ = client.call("clipboard_list_trash", {})
    assert trash_result["entries"] == []


def _png_bytes(color=(255, 0, 0)) -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color).save(buf, format="PNG")
    return buf.getvalue()


def test_note_image_import_files_then_list_then_get(client, tmp_path):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    image_path = tmp_path / "pic.png"
    image_path.write_bytes(_png_bytes())

    import_result, _, error = client.call(
        "note_image_import_files", {"note_id": note_id, "paths": [str(image_path)]}
    )
    assert error is None
    assert import_result["ok"] is True
    assert len(import_result["imported"]) == 1
    assert import_result["failed"] == []
    image_id = import_result["imported"][0]["id"]
    assert import_result["imported"][0]["mime_type"] == "image/png"

    list_result, _, _ = client.call("note_image_list", {"note_id": note_id})
    assert error is None
    assert [img["id"] for img in list_result["images"]] == [image_id]
    assert "image_base64" not in list_result["images"][0]

    get_result, _, error = client.call("note_image_get", {"id": image_id})
    assert error is None
    assert get_result["ok"] is True
    assert get_result["image"]["image_base64"]


def test_note_image_import_files_rejects_non_image_but_keeps_going(client, tmp_path):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    good_path = tmp_path / "good.png"
    good_path.write_bytes(_png_bytes())
    bad_path = tmp_path / "not_an_image.png"
    bad_path.write_bytes(b"this is not image data")

    result, _, error = client.call(
        "note_image_import_files", {"note_id": note_id, "paths": [str(good_path), str(bad_path)]}
    )
    assert error is None
    assert result["ok"] is True
    assert len(result["imported"]) == 1
    assert len(result["failed"]) == 1
    assert result["failed"][0]["error"] == "notes.image_invalid"


def test_note_image_paste_adds_an_image_from_base64(client):
    import base64

    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    image_base64 = base64.b64encode(_png_bytes()).decode("ascii")

    result, _, error = client.call("note_image_paste", {"note_id": note_id, "image_base64": image_base64})
    assert error is None
    assert result["ok"] is True
    assert result["image"]["mime_type"] == "image/png"

    list_result, _, _ = client.call("note_image_list", {"note_id": note_id})
    assert len(list_result["images"]) == 1


def test_note_image_paste_rejects_invalid_base64(client):
    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]

    result, _, error = client.call("note_image_paste", {"note_id": note_id, "image_base64": "not-valid-base64!!"})
    assert error is None
    assert result == {"ok": False, "error": "notes.image_invalid"}


def test_note_image_delete_removes_it(client):
    import base64

    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    image_base64 = base64.b64encode(_png_bytes()).decode("ascii")
    paste_result, _, _ = client.call("note_image_paste", {"note_id": note_id, "image_base64": image_base64})
    image_id = paste_result["image"]["id"]

    result, _, error = client.call("note_image_delete", {"id": image_id})
    assert error is None
    assert result == {"ok": True}

    list_result, _, _ = client.call("note_image_list", {"note_id": note_id})
    assert list_result["images"] == []


def test_note_image_delete_unknown_id_reports_not_found(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_image_delete", {"id": 999999})
    assert result == {"ok": False, "error": "notes.image_not_found"}
    assert error is None


def test_note_image_gone_after_note_hard_deleted(client):
    import base64

    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    image_base64 = base64.b64encode(_png_bytes()).decode("ascii")
    paste_result, _, _ = client.call("note_image_paste", {"note_id": note_id, "image_base64": image_base64})
    image_id = paste_result["image"]["id"]

    client.call("note_delete", {"id": note_id})
    client.call("note_hard_delete", {"id": note_id})

    result, _, error = client.call("note_image_get", {"id": image_id})
    assert result == {"ok": False, "error": "notes.image_not_found"}
    assert error is None


def test_note_image_storage_mode_defaults_to_encrypted_db(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_image_storage_mode_get", {})
    assert error is None
    assert result == {"ok": True, "mode": "encrypted_db"}


def test_note_image_storage_mode_set_then_get_round_trips(client):
    _setup_and_unlock(client)
    set_result, _, error = client.call("note_image_storage_mode_set", {"mode": "disk_plain"})
    assert error is None
    assert set_result == {"ok": True, "mode": "disk_plain"}

    get_result, _, _ = client.call("note_image_storage_mode_get", {})
    assert get_result == {"ok": True, "mode": "disk_plain"}


def test_note_image_storage_mode_set_rejects_invalid_mode(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_image_storage_mode_set", {"mode": "not_a_real_mode"})
    assert error is None
    assert result == {"ok": False, "error": "settings.invalid_request"}


def test_note_text_storage_mode_defaults_to_encrypted_db(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_text_storage_mode_get", {})
    assert error is None
    assert result == {"ok": True, "mode": "encrypted_db"}


def test_note_text_storage_mode_set_then_get_round_trips(client):
    _setup_and_unlock(client)
    set_result, _, error = client.call("note_text_storage_mode_set", {"mode": "disk_plain"})
    assert error is None
    assert set_result == {"ok": True, "mode": "disk_plain"}

    get_result, _, _ = client.call("note_text_storage_mode_get", {})
    assert get_result == {"ok": True, "mode": "disk_plain"}


def test_note_text_storage_mode_set_rejects_invalid_mode(client):
    _setup_and_unlock(client)
    result, _, error = client.call("note_text_storage_mode_set", {"mode": "not_a_real_mode"})
    assert error is None
    assert result == {"ok": False, "error": "settings.invalid_request"}


def test_note_text_storage_mode_setting_is_independent_of_note_image_storage_mode(client):
    # 两个设置各管各的 - 切图片的默认存储方式不应该连带改笔记正文的
    _setup_and_unlock(client)
    client.call("note_image_storage_mode_set", {"mode": "disk_plain"})
    result, _, _ = client.call("note_text_storage_mode_get", {})
    assert result == {"ok": True, "mode": "encrypted_db"}


def test_note_image_paste_under_disk_plain_mode_writes_a_real_file_and_round_trips(client, tmp_path):
    import base64

    _setup_and_unlock(client)
    client.call("note_image_storage_mode_set", {"mode": "disk_plain"})
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    original_bytes = _png_bytes()
    image_base64 = base64.b64encode(original_bytes).decode("ascii")

    paste_result, _, error = client.call("note_image_paste", {"note_id": note_id, "image_base64": image_base64})
    assert error is None
    assert paste_result["ok"] is True
    image_id = paste_result["image"]["id"]

    images_dir = tmp_path / "data" / "notes_images"
    thumbs_dir = tmp_path / "data" / "notes_thumbnails"
    assert list(images_dir.glob("*")), "expected a real image file on disk under disk_plain mode"
    assert list(thumbs_dir.glob("*")), "expected a real thumbnail file on disk under disk_plain mode"

    get_result, _, _ = client.call("note_image_get", {"id": image_id})
    assert base64.b64decode(get_result["image"]["image_base64"]) == original_bytes


def test_note_image_hard_delete_under_disk_plain_mode_removes_the_files(client, tmp_path):
    import base64

    _setup_and_unlock(client)
    client.call("note_image_storage_mode_set", {"mode": "disk_plain"})
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    image_base64 = base64.b64encode(_png_bytes()).decode("ascii")
    client.call("note_image_paste", {"note_id": note_id, "image_base64": image_base64})

    images_dir = tmp_path / "data" / "notes_images"
    thumbs_dir = tmp_path / "data" / "notes_thumbnails"
    assert list(images_dir.glob("*"))

    client.call("note_delete", {"id": note_id})
    client.call("note_hard_delete", {"id": note_id})

    assert list(images_dir.glob("*")) == []
    assert list(thumbs_dir.glob("*")) == []


def test_note_image_delete_single_under_disk_plain_mode_removes_the_files(client, tmp_path):
    import base64

    _setup_and_unlock(client)
    client.call("note_image_storage_mode_set", {"mode": "disk_plain"})
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]
    image_base64 = base64.b64encode(_png_bytes()).decode("ascii")
    paste_result, _, _ = client.call("note_image_paste", {"note_id": note_id, "image_base64": image_base64})
    image_id = paste_result["image"]["id"]

    images_dir = tmp_path / "data" / "notes_images"
    assert list(images_dir.glob("*"))

    client.call("note_image_delete", {"id": image_id})

    assert list(images_dir.glob("*")) == []


def test_note_images_mixed_storage_modes_both_stay_readable_after_switching(client):
    import base64

    _setup_and_unlock(client)
    create_result, _, _ = client.call("note_create", {"title": "t", "category": "", "content": ""})
    note_id = create_result["note"]["id"]

    red_base64 = base64.b64encode(_png_bytes(color=(255, 0, 0))).decode("ascii")
    client.call("note_image_paste", {"note_id": note_id, "image_base64": red_base64})

    client.call("note_image_storage_mode_set", {"mode": "disk_plain"})
    blue_base64 = base64.b64encode(_png_bytes(color=(0, 0, 255))).decode("ascii")
    client.call("note_image_paste", {"note_id": note_id, "image_base64": blue_base64})

    list_result, _, error = client.call("note_image_list", {"note_id": note_id})
    assert error is None
    assert len(list_result["images"]) == 2
    for meta in list_result["images"]:
        full, _, _ = client.call("note_image_get", {"id": meta["id"]})
        assert full["ok"] is True
        assert full["image"]["image_base64"]


# AI (DeepSeek) RPC：后端是真实子进程，无法 monkeypatch ai_client.chat/requests.post，请求构造与
# 错误映射由 test_ai_client.py 在进程内覆盖。这里只测到达网络之前的路径（keyring 持久化、未配置
# 密钥、空 messages），刻意不触发真正调用 DeepSeek 的路径。


def test_get_ai_config_returns_none_before_any_save(client):
    result, _, error = client.call("get_ai_config", {})
    assert error is None
    assert result == {"config": None}


def test_update_ai_config_requires_api_key_on_first_save(client):
    result, _, error = client.call("update_ai_config", {})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.api_key_required"


def test_update_and_get_ai_config_roundtrip_never_echoes_api_key(client):
    result, _, error = client.call(
        "update_ai_config", {"api_key": "sk-real-key", "model": "deepseek-chat", "base_url": "https://api.deepseek.com"}
    )
    assert error is None
    assert result["ok"] is True

    config, _, error = client.call("get_ai_config", {})
    assert error is None
    assert config["config"] == {
        "model": "deepseek-v4-pro",
        "base_url": "https://api.deepseek.com",
        "configured": True,
    }  # note: no api_key field at all, real key never echoed back to the UI

    saved_blob = json.loads(keyring.get_password(client.keyring_service, identity.KEYRING_AI_CONFIG))
    assert saved_blob["api_key"] == "sk-real-key"
    assert saved_blob["model"] == "deepseek-v4-pro"


def test_update_ai_config_does_not_clobber_api_key_when_left_blank(client):
    # 同 test_update_email_does_not_clobber_smtp_password_when_left_blank：get_ai_config 不回显真实
    # 密钥，设置框密钥栏为空；只改模型而再次保存不能清掉可用密钥。
    client.call("update_ai_config", {"api_key": "sk-real-key"})
    result, _, error = client.call("update_ai_config", {"model": "deepseek-reasoner"})
    assert error is None
    assert result["ok"] is True

    saved_blob = json.loads(keyring.get_password(client.keyring_service, identity.KEYRING_AI_CONFIG))
    assert saved_blob["api_key"] == "sk-real-key"  # preserved, not wiped
    assert saved_blob["model"] == "deepseek-reasoner"  # other fields still update normally


def test_test_ai_connection_without_configured_key_fails_before_any_request(client):
    result, _, error = client.call("test_ai_connection", {})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.api_key_required"


def test_ai_chat_without_configured_key_fails_before_any_request(client):
    result, _, error = client.call("ai_chat", {"messages": [{"role": "user", "content": "hi"}]})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.api_key_required"


def test_ai_chat_rejects_empty_messages_list(client):
    client.call("update_ai_config", {"api_key": "sk-real-key"})
    result, _, error = client.call("ai_chat", {"messages": []})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.invalid_request"


def test_ai_chat_auto_mode_with_skills_still_fails_before_any_request_when_unconfigured(client, tmp_path):
    # 自动模式（请求无 system 消息）在调用 DeepSeek 前会构建技能目录与工具 schema；证明这一步仍遵守
    # "先解析配置"的顺序，无密钥时不触网。
    skill_file = tmp_path / "translator.txt"
    skill_file.write_text("You are a translator.", encoding="utf-8")
    client.call("ai_skill_import", {"paths": [str(skill_file)]})

    result, _, error = client.call("ai_chat", {"messages": [{"role": "user", "content": "hi"}]})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.api_key_required"


def test_ai_chat_with_manual_skill_system_message_still_fails_before_any_request_when_unconfigured(client):
    # 手选技能会在对话前带自己的 system 消息，跳过自动检测，但仍须先解析 API 密钥。
    result, _, error = client.call(
        "ai_chat",
        {"messages": [{"role": "system", "content": "You are a translator."}, {"role": "user", "content": "hi"}]},
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.api_key_required"


def test_ai_summarize_text_file_without_configured_key_fails_before_reading_file(client, tmp_path):
    # 刻意指向不存在的路径：若越过配置检查会得到 OSError/internal.unexpected，所以拿到
    # ai.api_key_required 就证明配置检查先执行。
    missing_path = tmp_path / "does-not-exist.txt"
    result, _, error = client.call("ai_summarize_text_file", {"path": str(missing_path)})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.api_key_required"


# AI 技能（导入的角色/指令文件）与聊天附件：ai_read_text_file/ai_skill_import 只读本地文件、
# 不调 DeepSeek，可安全地经真实子进程端到端测试。


def test_ai_skill_list_empty_before_any_import(client):
    result, _, error = client.call("ai_skill_list", {})
    assert error is None
    assert result == {"skills": []}


def test_ai_skill_import_defaults_name_to_file_stem(client, tmp_path):
    skill_file = tmp_path / "translator-persona.txt"
    skill_file.write_text("You are a translator. Always reply in French.", encoding="utf-8")

    result, _, error = client.call("ai_skill_import", {"paths": [str(skill_file)]})
    assert error is None
    assert result["ok"] is True
    assert len(result["results"]) == 1
    entry = result["results"][0]
    assert entry["ok"] is True
    assert entry["skill"]["name"] == "translator-persona"
    assert entry["skill"]["content"] == "You are a translator. Always reply in French."
    assert entry["skill"]["description"] == ""
    assert entry["truncated"] is False

    listed, _, _ = client.call("ai_skill_list", {})
    assert len(listed["skills"]) == 1
    assert listed["skills"][0]["id"] == entry["skill"]["id"]


def test_ai_skill_import_uses_explicit_name_when_given(client, tmp_path):
    skill_file = tmp_path / "raw.txt"
    skill_file.write_text("persona body", encoding="utf-8")

    result, _, error = client.call("ai_skill_import", {"paths": [str(skill_file)], "name": "My Persona"})
    assert error is None
    assert result["results"][0]["skill"]["name"] == "My Persona"


def test_ai_skill_import_reads_name_and_description_from_skill_md_frontmatter(client, tmp_path):
    skill_file = tmp_path / "SKILL.md"
    skill_file.write_text(
        "---\n"
        "name: translator\n"
        "description: Translates text between languages.\n"
        "---\n"
        "You are a translator persona.\n",
        encoding="utf-8",
    )

    result, _, error = client.call("ai_skill_import", {"paths": [str(skill_file)]})
    assert error is None
    entry = result["results"][0]
    assert entry["ok"] is True
    assert entry["skill"]["name"] == "translator"
    assert entry["skill"]["description"] == "Translates text between languages."
    assert entry["skill"]["content"] == "You are a translator persona."


def test_ai_skill_import_accepts_a_folder_containing_skill_md(client, tmp_path):
    skill_dir = tmp_path / "my-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: folder-skill\n---\nBody from folder skill.\n", encoding="utf-8"
    )

    result, _, error = client.call("ai_skill_import", {"paths": [str(skill_dir)]})
    assert error is None
    entry = result["results"][0]
    assert entry["ok"] is True
    assert entry["skill"]["name"] == "folder-skill"
    assert entry["skill"]["content"] == "Body from folder skill."


def test_ai_skill_import_reports_error_for_folder_without_skill_md(client, tmp_path):
    empty_dir = tmp_path / "not-a-skill"
    empty_dir.mkdir()

    result, _, error = client.call("ai_skill_import", {"paths": [str(empty_dir)]})
    assert error is None
    entry = result["results"][0]
    assert entry["ok"] is False
    assert entry["error"] == "ai.skill_md_not_found"


def test_ai_skill_import_truncates_long_content(client, tmp_path):
    skill_file = tmp_path / "huge.txt"
    skill_file.write_text("x" * 9000, encoding="utf-8")

    result, _, error = client.call("ai_skill_import", {"paths": [str(skill_file)]})
    assert error is None
    entry = result["results"][0]
    assert entry["truncated"] is True
    assert len(entry["skill"]["content"]) == 8000  # ai_skills._AI_SKILL_MAX_CHARS


def test_ai_skill_import_rejects_non_text_file(client, tmp_path):
    binary_file = tmp_path / "image.bin"
    binary_file.write_bytes(bytes(range(256)))

    result, _, error = client.call("ai_skill_import", {"paths": [str(binary_file)]})
    assert error is None
    entry = result["results"][0]
    assert entry["ok"] is False
    assert entry["error"] == "ai.file_not_text"


def test_ai_skill_import_batch_partial_failure_keeps_the_good_ones(client, tmp_path):
    good_file = tmp_path / "good.txt"
    good_file.write_text("a good skill", encoding="utf-8")
    bad_file = tmp_path / "image.bin"
    bad_file.write_bytes(bytes(range(256)))

    result, _, error = client.call("ai_skill_import", {"paths": [str(good_file), str(bad_file)]})
    assert error is None
    results_by_ok = {r["ok"] for r in result["results"]}
    assert results_by_ok == {True, False}

    listed, _, _ = client.call("ai_skill_list", {})
    assert len(listed["skills"]) == 1
    assert listed["skills"][0]["name"] == "good"


def test_ai_skill_delete_removes_it_from_the_list(client, tmp_path):
    skill_file = tmp_path / "temp.txt"
    skill_file.write_text("temporary", encoding="utf-8")
    imported, _, _ = client.call("ai_skill_import", {"paths": [str(skill_file)]})
    skill_id = imported["results"][0]["skill"]["id"]

    result, _, error = client.call("ai_skill_delete", {"ids": [skill_id]})
    assert error is None
    assert result == {"ok": True, "deleted": [skill_id]}

    listed, _, _ = client.call("ai_skill_list", {})
    assert listed["skills"] == []


def test_ai_skill_delete_removes_multiple_at_once(client, tmp_path):
    file_a = tmp_path / "a.txt"
    file_a.write_text("a", encoding="utf-8")
    file_b = tmp_path / "b.txt"
    file_b.write_text("b", encoding="utf-8")
    imported, _, _ = client.call("ai_skill_import", {"paths": [str(file_a), str(file_b)]})
    ids = [r["skill"]["id"] for r in imported["results"]]

    result, _, error = client.call("ai_skill_delete", {"ids": ids})
    assert error is None
    assert result["ok"] is True

    listed, _, _ = client.call("ai_skill_list", {})
    assert listed["skills"] == []


def test_ai_read_text_file_returns_content_for_chat_attachments(client, tmp_path):
    attach_file = tmp_path / "notes.txt"
    attach_file.write_text("meeting notes: ship by Friday", encoding="utf-8")

    result, _, error = client.call("ai_read_text_file", {"path": str(attach_file)})
    assert error is None
    assert result == {"ok": True, "text": "meeting notes: ship by Friday", "truncated": False}


def test_ai_read_text_file_rejects_non_text_file(client, tmp_path):
    binary_file = tmp_path / "image.bin"
    binary_file.write_bytes(bytes(range(256)))

    result, _, error = client.call("ai_read_text_file", {"path": str(binary_file)})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.file_not_text"


# --- AI chat history (encrypted conversation log) ---


def test_ai_history_operations_before_unlock_report_error_not_crash(client):
    result, _, error = client.call("ai_history_list", {})
    assert result is None
    assert error == "auth.not_unlocked"


def test_ai_history_list_empty_before_any_save(client):
    _setup_and_unlock(client)
    result, _, error = client.call("ai_history_list", {})
    assert error is None
    assert result == {"ok": True, "conversations": []}


def test_ai_history_save_without_id_creates_a_new_conversation(client):
    _setup_and_unlock(client)
    messages = [{"role": "user", "content": "What is 2+2?"}, {"role": "assistant", "content": "4"}]

    result, _, error = client.call("ai_history_save", {"messages": messages})
    assert error is None
    assert result["ok"] is True
    assert result["conversation"]["first_question"] == "What is 2+2?"
    assert result["conversation"]["messages"] == messages

    listed, _, _ = client.call("ai_history_list", {})
    assert len(listed["conversations"]) == 1
    assert listed["conversations"][0]["id"] == result["conversation"]["id"]
    assert "messages" not in listed["conversations"][0]


def test_ai_history_save_with_id_updates_the_same_conversation(client):
    _setup_and_unlock(client)
    first, _, _ = client.call(
        "ai_history_save", {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]}
    )
    conversation_id = first["conversation"]["id"]

    extended_messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
        {"role": "user", "content": "how are you?"},
        {"role": "assistant", "content": "good"},
    ]
    result, _, error = client.call("ai_history_save", {"id": conversation_id, "messages": extended_messages})
    assert error is None
    assert result["conversation"]["id"] == conversation_id
    assert result["conversation"]["messages"] == extended_messages

    listed, _, _ = client.call("ai_history_list", {})
    assert len(listed["conversations"]) == 1


def test_ai_history_save_rejects_empty_messages_list(client):
    _setup_and_unlock(client)
    result, _, error = client.call("ai_history_save", {"messages": []})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.invalid_request"


def test_ai_history_save_rejects_a_system_role_message(client):
    # History only ever holds what the user actually saw exchanged - a
    # skill's system prompt is never part of the saved transcript.
    _setup_and_unlock(client)
    result, _, error = client.call(
        "ai_history_save", {"messages": [{"role": "system", "content": "you are a translator"}]}
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "ai.invalid_request"


def test_ai_history_get_returns_full_messages(client):
    _setup_and_unlock(client)
    messages = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    saved, _, _ = client.call("ai_history_save", {"messages": messages})

    result, _, error = client.call("ai_history_get", {"id": saved["conversation"]["id"]})
    assert error is None
    assert result["conversation"]["messages"] == messages


def test_ai_history_get_unknown_id_reports_not_found(client):
    _setup_and_unlock(client)
    result, _, error = client.call("ai_history_get", {"id": 999999})
    assert result == {"ok": False, "error": "ai.history_not_found"}
    assert error is None


def test_ai_history_delete_removes_multiple_at_once(client):
    _setup_and_unlock(client)
    a, _, _ = client.call("ai_history_save", {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "a-reply"}]})
    b, _, _ = client.call("ai_history_save", {"messages": [{"role": "user", "content": "b"}, {"role": "assistant", "content": "b-reply"}]})
    c, _, _ = client.call("ai_history_save", {"messages": [{"role": "user", "content": "c"}, {"role": "assistant", "content": "c-reply"}]})

    result, _, error = client.call(
        "ai_history_delete", {"ids": [a["conversation"]["id"], c["conversation"]["id"]]}
    )
    assert error is None
    assert result == {"ok": True, "deleted_count": 2}

    listed, _, _ = client.call("ai_history_list", {})
    assert [conv["id"] for conv in listed["conversations"]] == [b["conversation"]["id"]]


def test_ai_history_delete_all_clears_every_conversation(client):
    _setup_and_unlock(client)
    client.call("ai_history_save", {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "a-reply"}]})
    client.call("ai_history_save", {"messages": [{"role": "user", "content": "b"}, {"role": "assistant", "content": "b-reply"}]})

    result, _, error = client.call("ai_history_delete_all", {})
    assert error is None
    assert result == {"ok": True, "deleted_count": 2}

    listed, _, _ = client.call("ai_history_list", {})
    assert listed["conversations"] == []


# ---- Folder containers ----


def test_encrypt_file_rpc_routes_directory_input_to_folder_encryption(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    (src / "sub").mkdir()
    (src / "sub" / "b.txt").write_text("world", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"

    result, _, error = client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})
    assert error is None
    assert result["ok"] is True
    assert encrypted.exists()

    header_result, _, _ = client.call("read_header", {"input_path": str(encrypted)})
    assert header_result["header"]["kind"] == "folder"
    assert header_result["header"]["original_filename"] == "src_folder"


def test_encrypt_folder_with_delete_source_removes_the_source_tree(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"

    result, _, error = client.call(
        "encrypt_file", {"input_path": str(src), "output_path": str(encrypted), "delete_source": True}
    )
    assert error is None
    assert result["ok"] is True
    assert result["source_deleted"] is True
    assert not src.exists()


def test_decrypt_folder_preview_confirm_round_trip(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    (src / "sub").mkdir()
    (src / "sub" / "b.txt").write_text("world", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    preview_result, _, error = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})
    assert error is None
    assert preview_result["ok"] is True
    assert preview_result["original_name"] == "src_folder"
    names = {e["name"] for e in preview_result["entries"]}
    assert names == {"a.txt", "sub/b.txt"}
    # 预览不再落任何临时明文文件（见 container._ContainerPlaintextReader）
    assert "temp_zip_path" not in preview_result
    assert preview_result["input_path"] == str(encrypted)

    dest = tmp_path / "restored"
    confirm_result, _, error = client.call(
        "decrypt_folder_confirm", {"input_path": str(encrypted), "output_dir": str(dest)}
    )
    assert error is None
    assert confirm_result["ok"] is True
    assert (dest / "a.txt").read_text(encoding="utf-8") == "hello"
    assert (dest / "sub" / "b.txt").read_text(encoding="utf-8") == "world"


def test_decrypt_folder_confirm_rejects_existing_destination_without_merging(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("new content", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    preview_result, _, _ = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})
    destination = tmp_path / "restored"
    destination.mkdir()
    sentinel = destination / "must_survive.txt"
    sentinel.write_text("existing content", encoding="utf-8")
    result, _, error = client.call(
        "decrypt_folder_confirm", {"input_path": str(encrypted), "output_dir": str(destination)}
    )

    assert error is None
    assert result["ok"] is False
    assert result["error"] == "container.destination_exists"
    assert sentinel.read_text(encoding="utf-8") == "existing content"
    assert not (destination / "a.txt").exists()


def test_decrypt_folder_confirm_can_be_retried_after_a_failed_destination(client, tmp_path):
    """解压失败后，换目标目录再确认必须仍能成功。

    旧行为：`_take_folder_preview_temp` 一进函数就摘掉句柄，解压再失败也不放回，导致第二次报
    container.preview_not_found，而解好的临时文件其实还在盘上。
    """
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    preview_result, _, _ = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})

    occupied = tmp_path / "occupied"
    occupied.mkdir()
    first, _, _ = client.call(
        "decrypt_folder_confirm", {"input_path": str(encrypted), "output_dir": str(occupied)}
    )
    assert first["ok"] is False
    assert first["error"] == "container.destination_exists"

    # 同一份预览，换个空的目标目录——必须照常解出来，而不是"预览已失效"
    retry, _, error = client.call(
        "decrypt_folder_confirm", {"input_path": str(encrypted), "output_dir": str(tmp_path / "restored")}
    )
    assert error is None
    assert retry["ok"] is True, retry
    assert (tmp_path / "restored" / "a.txt").read_text(encoding="utf-8") == "hello"


def test_decrypt_folder_discard_cannot_be_used_to_delete_an_arbitrary_file(client, tmp_path):
    """discard 不再接受任何路径，"用它删别人的文件"结构上不存在。

    预览不再产生临时文件，discard 是空操作，不需要注册表也就无从绕过；此条钉住的是这个性质。
    """
    _setup_and_unlock(client)
    unrelated = tmp_path / "unrelated.zip"
    unrelated.write_bytes(b"must survive")

    result, _, error = client.call("decrypt_folder_discard", {})

    assert error is None
    assert result == {"ok": True}
    assert unrelated.read_bytes() == b"must survive"


def test_decrypt_folder_preview_leaves_no_plaintext_temp_file(client, tmp_path):
    """预览加密文件夹内容不许在磁盘上留下明文。

    旧实现会把整个容器解密成临时明文 ZIP，10 GB 文件夹在用户点确认前就有 10 GB 明文落盘。
    """
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    from modules.file_vault import container as _container

    temp_root = Path(tempfile.gettempdir())
    before = set(temp_root.glob(f"{_container._FOLDER_TEMP_PREFIX}*"))
    preview_result, _, error = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})
    after = set(temp_root.glob(f"{_container._FOLDER_TEMP_PREFIX}*"))

    assert error is None
    assert preview_result["ok"] is True
    assert after == before, f"预览留下了临时明文：{sorted(after - before)}"

    discard_result, _, error = client.call("decrypt_folder_discard", {})
    assert error is None
    assert discard_result == {"ok": True}
    assert not (tmp_path / "should_not_exist").exists()  # confirm 从没被调用过


def test_decrypt_folder_confirm_with_delete_source_removes_the_ivault(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    preview_result, _, _ = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})
    dest = tmp_path / "restored"
    result, _, error = client.call(
        "decrypt_folder_confirm",
        {
            "input_path": str(encrypted),
            "output_dir": str(dest),
            "delete_source": True,
            "input_path": str(encrypted),
        },
    )
    assert error is None
    assert result["ok"] is True
    assert result["source_deleted"] is True
    assert not encrypted.exists()
    assert (dest / "a.txt").exists()


def test_decrypt_file_rpc_on_folder_container_reports_friendly_error(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    result, _, error = client.call(
        "decrypt_file", {"input_path": str(encrypted), "output_path": str(tmp_path / "out.bin")}
    )
    assert error is None  # the RPC call itself succeeds...
    assert result["ok"] is False  # ...but reports the container error in its own result
    assert result["error"] == "container.is_folder_container"


def test_decrypt_folder_preview_rpc_on_file_container_reports_friendly_error(client, tmp_path):
    _setup_and_unlock(client)
    original = tmp_path / "note.txt"
    original.write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "note.ivault"
    client.call("encrypt_file", {"input_path": str(original), "output_path": str(encrypted)})

    result, _, error = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "container.not_a_folder_container"


def test_encrypt_does_not_block_other_rpcs_while_running(client, tmp_path):
    # 钉住 encrypt_file 改走 batch_engine.submit_batch_task 的意义：此前它同步跑在单线程 stdin 循环
    # （见 serve()）里，后面的请求连读都读不出来。同时发大加密和近乎瞬时的 identity_exists，
    # 确认后者先返回。
    _setup_and_unlock(client)
    big = tmp_path / "big.bin"
    big.write_bytes(os.urandom(80 * 1024 * 1024))
    encrypted = tmp_path / "big.ivault"

    encrypt_id = client.send("encrypt_file", {"input_path": str(big), "output_path": str(encrypted)})
    identity_id = client.send("identity_exists", {})

    t_identity = None
    t_encrypt = None
    while t_identity is None or t_encrypt is None:
        msg = client.read_one()
        if "progress" in msg:
            continue
        assert "error" not in msg, msg
        if msg["id"] == identity_id and t_identity is None:
            t_identity = time.monotonic()
        elif msg["id"] == encrypt_id and t_encrypt is None:
            t_encrypt = time.monotonic()
            assert msg["result"]["ok"] is True

    assert t_identity < t_encrypt, (
        "identity_exists (sent second, near-instant) should finish before "
        "encrypt_file (sent first, ~80MB) if the backend isn't blocked by it"
    )



def _default_shortcuts_payload():
    return {
        "copy": {"key": "c", "ctrl": True, "alt": False, "shift": False},
        "cut": {"key": "x", "ctrl": True, "alt": False, "shift": False},
        "paste": {"key": "v", "ctrl": True, "alt": False, "shift": False},
        "delete_recycle": {"key": "Delete", "ctrl": False, "alt": False, "shift": False},
        "delete_permanent": {"key": "Delete", "ctrl": False, "alt": False, "shift": True},
    }


def test_file_manager_shortcuts_get_returns_defaults(client):
    _setup_and_unlock(client)
    result, _, error = client.call("file_manager_shortcuts_get", {})
    assert error is None
    assert result == {"ok": True, "shortcuts": _default_shortcuts_payload()}


def test_file_manager_shortcuts_set_then_get_round_trips(client):
    _setup_and_unlock(client)
    shortcuts = _default_shortcuts_payload()
    shortcuts["paste"] = {"key": "b", "ctrl": True, "alt": False, "shift": False}
    result, _, error = client.call("file_manager_shortcuts_set", {"shortcuts": shortcuts})
    assert error is None
    assert result == {"ok": True, "shortcuts": shortcuts}

    result, _, _ = client.call("file_manager_shortcuts_get", {})
    assert result == {"ok": True, "shortcuts": shortcuts}


def test_file_manager_shortcuts_set_rejects_conflicting_pair(client):
    _setup_and_unlock(client)
    shortcuts = _default_shortcuts_payload()
    shortcuts["paste"] = {"key": "c", "ctrl": True, "alt": False, "shift": False}
    result, _, error = client.call("file_manager_shortcuts_set", {"shortcuts": shortcuts})
    assert error is None
    assert result == {"ok": False, "error": "settings.shortcut_conflict"}


def test_file_manager_shortcuts_set_rejects_default_reserved_combo(client):
    _setup_and_unlock(client)
    shortcuts = _default_shortcuts_payload()
    shortcuts["paste"] = {"key": "v", "ctrl": True, "alt": False, "shift": True}
    result, _, error = client.call("file_manager_shortcuts_set", {"shortcuts": shortcuts})
    assert error is None
    assert result == {"ok": False, "error": "settings.shortcut_reserved"}


def test_file_manager_shortcuts_set_honors_caller_reserved_list(client):
    _setup_and_unlock(client)
    reserved = [{"key": "g", "ctrl": True, "alt": True, "shift": False}]

    # With customized globals passed in, the old default combo is free again...
    shortcuts = _default_shortcuts_payload()
    shortcuts["paste"] = {"key": "v", "ctrl": True, "alt": False, "shift": True}
    result, _, error = client.call(
        "file_manager_shortcuts_set", {"shortcuts": shortcuts, "reserved": reserved}
    )
    assert error is None
    assert result["ok"] is True

    # ...while the caller-provided combo is now the blocked one.
    shortcuts = _default_shortcuts_payload()
    shortcuts["paste"] = {"key": "g", "ctrl": True, "alt": True, "shift": False}
    result, _, error = client.call(
        "file_manager_shortcuts_set", {"shortcuts": shortcuts, "reserved": reserved}
    )
    assert error is None
    assert result == {"ok": False, "error": "settings.shortcut_reserved"}


def test_file_manager_shortcuts_set_rejects_malformed_reserved(client):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "file_manager_shortcuts_set",
        {"shortcuts": _default_shortcuts_payload(), "reserved": "not-a-list"},
    )
    assert error is None
    assert result == {"ok": False, "error": "settings.invalid_request"}


def test_file_manager_shortcuts_rpcs_require_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("file_manager_shortcuts_get", {})
    assert result is None
    assert error == "auth.not_unlocked"
    result, _, error = client.call(
        "file_manager_shortcuts_set", {"shortcuts": _default_shortcuts_payload()}
    )
    assert result is None
    assert error == "auth.not_unlocked"



def test_folder_container_diff_rpc_reports_no_changes(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    result, _, error = client.call(
        "folder_container_diff", {"source_folder": str(src), "container_path": str(encrypted)}
    )
    assert error is None
    assert result["ok"] is True
    assert result["added"] == []
    assert result["removed"] == []
    assert result["modified"] == []
    assert result["unchanged_count"] == 1


def test_folder_container_diff_rpc_reports_changes(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    (src / "gone.txt").write_text("bye", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})

    (src / "a.txt").write_text("hello there", encoding="utf-8")
    (src / "gone.txt").unlink()
    (src / "new.txt").write_text("fresh", encoding="utf-8")

    result, _, error = client.call(
        "folder_container_diff", {"source_folder": str(src), "container_path": str(encrypted)}
    )
    assert error is None
    assert result["added"] == ["new.txt"]
    assert result["removed"] == ["gone.txt"]
    assert result["modified"] == ["a.txt"]


def test_folder_container_diff_rpc_requires_unlock(client):
    result, _, error = client.call(
        "folder_container_diff", {"source_folder": "does-not-matter", "container_path": "does-not-matter"}
    )
    assert result is None
    assert error == "auth.not_unlocked"


def test_folder_container_reencrypt_rpc_replaces_container(client, tmp_path):
    _setup_and_unlock(client)
    src = tmp_path / "src_folder"
    src.mkdir()
    (src / "a.txt").write_text("hello", encoding="utf-8")
    encrypted = tmp_path / "src.ivault"
    client.call("encrypt_file", {"input_path": str(src), "output_path": str(encrypted)})
    original_bytes = encrypted.read_bytes()

    (src / "a.txt").write_text("updated", encoding="utf-8")

    result, _, error = client.call(
        "folder_container_reencrypt", {"source_folder": str(src), "container_path": str(encrypted)}
    )
    assert error is None
    assert result["ok"] is True
    assert encrypted.exists()
    assert encrypted.read_bytes() != original_bytes

    preview_result, _, error = client.call("decrypt_folder_preview", {"input_path": str(encrypted)})
    assert error is None
    dest = tmp_path / "restored"
    client.call("decrypt_folder_confirm", {"input_path": str(encrypted), "output_dir": str(dest)})
    assert (dest / "a.txt").read_text(encoding="utf-8") == "updated"


def test_folder_container_reencrypt_rpc_requires_unlock(client):
    result, _, error = client.call(
        "folder_container_reencrypt", {"source_folder": "does-not-matter", "container_path": "does-not-matter"}
    )
    assert result is None
    assert error == "auth.not_unlocked"



def test_activity_log_starts_empty(client):
    _setup_and_unlock(client)
    result, _, error = client.call("activity_log_list", {})
    assert error is None
    assert result == {"ok": True, "entries": []}


def test_encrypt_file_records_activity(client, tmp_path):
    _setup_and_unlock(client)
    original = tmp_path / "report.docx"
    original.write_bytes(b"content")
    encrypted = tmp_path / "report.ivault"
    client.call("encrypt_file", {"input_path": str(original), "output_path": str(encrypted)})

    result, _, _ = client.call("activity_log_list", {})
    assert result["entries"][0]["module"] == "files"
    assert result["entries"][0]["action"] == "encrypt"
    assert result["entries"][0]["label"] == "report.docx"


def test_decrypt_file_records_activity(client, tmp_path):
    _setup_and_unlock(client)
    original = tmp_path / "note.txt"
    original.write_bytes(b"hello")
    encrypted = tmp_path / "note.ivault"
    client.call("encrypt_file", {"input_path": str(original), "output_path": str(encrypted)})
    restored = tmp_path / "restored.txt"
    client.call("decrypt_file", {"input_path": str(encrypted), "output_path": str(restored)})

    result, _, _ = client.call("activity_log_list", {})
    assert result["entries"][0]["module"] == "files"
    assert result["entries"][0]["action"] == "decrypt"
    assert result["entries"][0]["label"] == "note.ivault"


def test_note_create_and_update_record_activity(client):
    _setup_and_unlock(client)
    created, _, _ = client.call("note_create", {"title": "My Note", "content": "hi"})
    note_id = created["note"]["id"]
    client.call("note_update", {"id": note_id, "title": "Renamed Note"})

    result, _, _ = client.call("activity_log_list", {})
    labels = [e["label"] for e in result["entries"] if e["module"] == "notes"]
    assert labels[0] == "Renamed Note"
    assert labels[1] == "My Note"


def test_password_add_records_activity_but_dedup_does_not(client):
    _setup_and_unlock(client)
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    result, _, _ = client.call("activity_log_list", {})
    assert result["entries"][0] == {
        "id": result["entries"][0]["id"],
        "module": "passwords",
        "action": "add",
        "label": "GitHub",
        "created_at": result["entries"][0]["created_at"],
    }
    count_after_first = len(result["entries"])

    # Exact duplicate - deduped, nothing new actually added, so no new entry.
    client.call(
        "password_add",
        {"name": "GitHub", "url": "https://github.com", "username": "me", "password": "hunter2"},
    )
    result, _, _ = client.call("activity_log_list", {})
    assert len(result["entries"]) == count_after_first


def test_activity_log_list_respects_limit(client, tmp_path):
    _setup_and_unlock(client)
    for i in range(5):
        client.call("note_create", {"title": f"note-{i}", "content": ""})
    result, _, _ = client.call("activity_log_list", {"limit": 2})
    assert len(result["entries"]) == 2
    assert result["entries"][0]["label"] == "note-4"


def test_activity_log_clear_removes_all_entries(client):
    _setup_and_unlock(client)
    client.call("note_create", {"title": "temp", "content": ""})
    result, _, error = client.call("activity_log_clear", {})
    assert error is None
    assert result == {"ok": True}

    result, _, _ = client.call("activity_log_list", {})
    assert result["entries"] == []


def test_activity_log_requires_unlock(client):
    client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    result, _, error = client.call("activity_log_list", {})
    assert result is None
    assert error == "auth.not_unlocked"
    result, _, error = client.call("activity_log_clear", {})
    assert result is None
    assert error == "auth.not_unlocked"


def test_activity_log_persists_across_backend_restart(client, tmp_path):
    _setup_and_unlock(client)
    client.call("note_create", {"title": "durable note", "content": ""})

    fresh = BackendClient(tmp_path / "data")
    try:
        fresh.call("unlock_password", {"password": "test-password-" + "123"})
        result, _, _ = fresh.call("activity_log_list", {})
    finally:
        fresh.close()
    # 断言"这条在里面"而非"排第一"：解锁会启动真实剪贴板监听，测试期间用户在别处按 Ctrl+C 会插入
    # 一条 clipboard/capture 记录排在 note 前面（曾因此整轮失败）。按内容找即不受影响。
    assert "durable note" in [entry["label"] for entry in result["entries"]]


# recovery_codes RPC（"恢复码"指第三方 2FA 备份码，不是 identity.py 的主恢复密钥）。共用一次
# setup+unlock 跑完整往返，省掉每个断言的 Scrypt+子进程开销；少数守卫用例单独起 client。

GITHUB_CODES_TEXT = "\n".join([
    "05c93-3a58f", "c4842-3d0f3", "2dfc6-71fa3", "9bd37-bdade",
]) + "\n"


def _setup_and_unlock(client):
    result, _, error = client.call(
        "setup_complete",
        {
            "password": "test-password-" + "123",
            "totp_seed": "JBSWY3DPEHPK3PXP",
            "email_address": None,
            "recovery_key": "AAAA-BBBB-CCCC-DDDD",
        },
    )
    assert error is None and result == {"ok": True}
    result, _, error = client.call("unlock_password", {"password": "test-password-" + "123"})
    assert error is None and result == {"ok": True}


def test_recovery_codes_requires_unlock(client):
    result, _, error = client.call("recovery_codes_list", {})
    assert result is None
    assert error == "auth.not_unlocked"


def test_recovery_codes_full_round_trip(client):
    _setup_and_unlock(client)

    result, _, error = client.call("recovery_codes_list", {})
    assert error is None
    assert result == {"ok": True, "groups": [], "damaged": []}

    result, _, error = client.call("recovery_codes_detect_service", {"filename": "github-recovery-codes.txt"})
    assert error is None
    assert result["rule"] == {"key": "github", "displayName": "GitHub", "expectedCount": 16}

    result, _, error = client.call(
        "recovery_codes_import_preview",
        {"text": GITHUB_CODES_TEXT, "source_file_name": "github-recovery-codes.txt", "account_label": "工作账号"},
    )
    assert error is None
    assert len(result["groups"]) == 1
    preview_group = result["groups"][0]
    assert preview_group["action"] == "new"
    assert preview_group["service"] == "GitHub"
    assert len(preview_group["codes"]) == 4
    assert preview_group["invalidLines"] == []

    result, _, error = client.call(
        "recovery_codes_import_confirm",
        {
            "source_file_name": "github-recovery-codes.txt",
            "groups": [{"service": "GitHub", "account_label": "工作账号", "codes": preview_group["codes"]}],
        },
    )
    assert error is None
    group = result["groups"][0]
    group_id = group["id"]
    assert group["service"] == "GitHub"
    assert group["remainingCount"] == 4
    assert all("code" not in c for c in group["codes"])  # masked

    # Re-importing the exact same content is detected as unchanged.
    result, _, error = client.call(
        "recovery_codes_import_preview",
        {"text": GITHUB_CODES_TEXT, "source_file_name": "github-recovery-codes.txt", "account_label": "工作账号"},
    )
    assert error is None
    assert result["groups"][0]["action"] == "unchanged"
    assert result["groups"][0]["matchedGroupId"] == group_id

    # A malformed line is reported, not silently dropped.
    result, _, error = client.call(
        "recovery_codes_import_preview",
        {"text": "05c93-3a58f\nnot-a-real-code\n", "source_file_name": "github-recovery-codes.txt"},
    )
    assert error is None
    assert result["groups"][0]["invalidLines"] == [{"lineNumber": 2, "raw": "not-a-real-code"}]

    # reveal is the only RPC that returns plaintext.
    result, _, error = client.call("recovery_codes_reveal", {"id": group_id})
    assert error is None
    assert result["codes"][0]["code"] == "05c93-3a58f"

    # mark_used addresses by index, never by the plaintext code string.
    result, _, error = client.call("recovery_codes_mark_used", {"id": group_id, "code_index": 0, "used": True})
    assert error is None
    assert result["group"]["codes"][0]["used"] is True
    assert result["group"]["remainingCount"] == 3

    result, _, error = client.call(
        "recovery_codes_update_meta", {"id": group_id, "note": "测试备注", "low_stock_threshold": 5},
    )
    assert error is None
    assert result["group"]["note"] == "测试备注"
    assert result["group"]["isLowStock"] is True  # 3 remaining <= new threshold of 5

    result, _, error = client.call("recovery_codes_mark_checked", {"id": group_id})
    assert error is None
    assert result["group"]["needsReview"] is False

    result, _, error = client.call("recovery_codes_dashboard_summary", {})
    assert error is None
    assert result["serviceCount"] == 1
    assert result["codeCount"] == 4
    assert result["remainingCount"] == 3
    assert group_id in result["lowStockGroupIds"]

    result, _, error = client.call("recovery_codes_delete", {"id": group_id})
    assert error is None and result == {"ok": True}
    result, _, error = client.call("recovery_codes_list", {})
    assert result["groups"] == []

    # Within the 10-second window, the delete can be undone.
    result, _, error = client.call("recovery_codes_undo", {})
    assert error is None
    assert len(result["groups"]) == 1
    assert result["groups"][0]["id"] == group_id


def test_recovery_codes_reimport_own_multi_account_export_splits_back_apart(client, tmp_path):
    """已报告 bug 的端到端复现：导出两个账号的 GitHub 恢复码为 TXT/CSV/JSON 再导入，每种格式都应
    还原为两个独立分组且无无效行（不能压成一个账号，也不能把 '#' 头行当格式错误）。"""
    _setup_and_unlock(client)
    account_codes = {
        "work@example.com": ["05c93-3a58f", "c4842-3d0f3", "2dfc6-71fa3", "9bd37-bdade"],
        "personal@example.com": ["2d7ee-200dc", "6961c-f693a", "f8485-f7e6a", "d00d6-80225"],
    }
    for label, codes in account_codes.items():
        client.call(
            "recovery_codes_import_confirm",
            {"source_file_name": "x.txt", "groups": [{"service": "GitHub", "account_label": label, "codes": codes}]},
        )

    for fmt, ext in [("txt", "txt"), ("csv", "csv"), ("json", "json")]:
        export_path = tmp_path / f"export.{ext}"
        result, _, error = client.call("recovery_codes_export_text", {"format": fmt, "output_path": str(export_path)})
        assert error is None and result["ok"] is True

        result, _, error = client.call("recovery_codes_import_preview", {"input_path": str(export_path)})
        assert error is None, f"{fmt} import failed: {error}"
        groups = result["groups"]
        assert len(groups) == 2, f"{fmt}: expected 2 groups, got {len(groups)}"
        by_label = {g["accountLabel"]: g for g in groups}
        assert set(by_label) == set(account_codes), fmt
        for label, codes in account_codes.items():
            assert by_label[label]["codes"] == codes, fmt
        assert all(g["invalidLines"] == [] for g in groups), f"{fmt}: unexpected invalid lines {groups}"
        # Re-importing identical content is recognized per-group, not merged
        # into one "changed" blob covering both accounts.
        assert all(g["action"] == "unchanged" for g in groups), fmt


def test_recovery_codes_csv_export_writes_utf8_bom(client, tmp_path):
    # 无 BOM 时，中文 Windows 上双击用 Excel 打开导出的 CSV，非 ASCII 的 account_label（如"工作账号"）
    # 会乱码；txt/json 刻意保持普通 UTF-8，只有 csv 需要 BOM。
    _setup_and_unlock(client)
    result, _, error = client.call(
        "recovery_codes_import_preview",
        {"text": GITHUB_CODES_TEXT, "source_file_name": "github-recovery-codes.txt", "account_label": "工作账号"},
    )
    assert error is None
    result, _, error = client.call(
        "recovery_codes_import_confirm",
        {
            "source_file_name": "github-recovery-codes.txt",
            "groups": [{"service": "GitHub", "account_label": "工作账号", "codes": result["groups"][0]["codes"]}],
        },
    )
    assert error is None

    csv_path = tmp_path / "export.csv"
    result, _, error = client.call("recovery_codes_export_text", {"format": "csv", "output_path": str(csv_path)})
    assert error is None
    assert result["ok"] is True
    raw = csv_path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert "工作账号" in raw.decode("utf-8-sig")

    txt_path = tmp_path / "export.txt"
    result, _, error = client.call("recovery_codes_export_text", {"format": "txt", "output_path": str(txt_path)})
    assert error is None
    assert not txt_path.read_bytes().startswith(b"\xef\xbb\xbf")


def test_recovery_codes_import_file_too_large_is_rejected(client, tmp_path):
    _setup_and_unlock(client)
    big_file = tmp_path / "github-recovery-codes.txt"
    big_file.write_bytes(b"0" * (1024 * 1024 + 1))
    result, _, error = client.call(
        "recovery_codes_import_preview", {"input_path": str(big_file)},
    )
    assert result is None
    assert error == "recovery_codes.file_too_large"


def test_recovery_codes_import_path_traversal_filename_is_sanitized(client, tmp_path):
    _setup_and_unlock(client)
    source = tmp_path / "evil.txt"
    source.write_text("05c93-3a58f\n", encoding="utf-8")
    result, _, error = client.call(
        "recovery_codes_import_preview",
        {"input_path": str(source), "source_file_name": "../../../etc/passwd", "service": "Evil"},
    )
    assert error is None
    assert result["sourceFileName"] == "passwd"


def test_recovery_codes_full_backup_export_and_import_round_trip(client, tmp_path):
    _setup_and_unlock(client)
    client.call(
        "recovery_codes_import_preview",
        {"text": "aaaaa-11111\nbbbbb-22222\n", "source_file_name": "x.txt", "service": "GitHub"},
    )
    preview, _, _ = client.call(
        "recovery_codes_import_preview",
        {"text": "aaaaa-11111\nbbbbb-22222\n", "source_file_name": "x.txt", "service": "GitHub"},
    )
    client.call(
        "recovery_codes_import_confirm",
        {"source_file_name": "x.txt", "groups": [{"service": "GitHub", "account_label": "", "codes": preview["groups"][0]["codes"]}]},
    )

    backup_path = tmp_path / "backup.ideal1rc"
    result, _, error = client.call(
        "recovery_codes_backup_export", {"output_path": str(backup_path), "backup_password": "a-different-password-" + "123"},
    )
    assert error is None and result["ok"] is True
    assert backup_path.exists()

    # Wrong backup password is rejected.
    result, _, error = client.call(
        "recovery_codes_backup_import_preview", {"input_path": str(backup_path), "backup_password": "wrong-password"},
    )
    assert error is None
    assert result == {"ok": False, "error": "recovery_codes.backup_wrong_password"}

    # Correct password: since local already has the identical GitHub group, it's "identical".
    result, _, error = client.call(
        "recovery_codes_backup_import_preview",
        {"input_path": str(backup_path), "backup_password": "a-different-password-" + "123"},
    )
    assert error is None
    assert len(result["items"]) == 1
    assert result["items"][0]["status"] == "identical"


def test_recovery_codes_backup_export_rejects_short_password(client, tmp_path):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "recovery_codes_backup_export", {"output_path": str(tmp_path / "b.ideal1rc"), "backup_password": "short"},
    )
    assert error is None
    assert result == {"ok": False, "error": "recovery_codes.backup_password_too_short"}


def test_recovery_codes_backup_import_confirm_applies_use_backup_decision(client, tmp_path):
    _setup_and_unlock(client)
    # Nothing local yet - import a backup containing one brand-new service.
    other = BackendClient(tmp_path / "other-data")
    try:
        _setup_and_unlock(other)
        other.call(
            "recovery_codes_import_confirm",
            {"source_file_name": "x.txt", "groups": [{"service": "Steam", "account_label": "", "codes": ["zzzzz-99999"]}]},
        )
        backup_path = tmp_path / "steam-backup.ideal1rc"
        other.call("recovery_codes_backup_export", {"output_path": str(backup_path), "backup_password": "steam-backup-pw-" + "123"})
    finally:
        other.close()

    preview, _, _ = client.call(
        "recovery_codes_backup_import_preview",
        {"input_path": str(backup_path), "backup_password": "steam-backup-pw-" + "123"},
    )
    assert preview["items"][0]["status"] == "backup_only"
    key = preview["items"][0]["key"]

    result, _, error = client.call(
        "recovery_codes_backup_import_confirm",
        {"input_path": str(backup_path), "backup_password": "steam-backup-pw-" + "123", "decisions": {key: "use_backup"}},
    )
    assert error is None
    assert result["applied_count"] == 1
    assert any(g["service"] == "Steam" for g in result["groups"])

    result, _, _ = client.call("recovery_codes_list", {})
    assert any(g["service"] == "Steam" for g in result["groups"])


def test_recovery_codes_import_preview_empty_file_yields_no_codes(client, tmp_path):
    _setup_and_unlock(client)
    empty_file = tmp_path / "github-recovery-codes.txt"
    empty_file.write_bytes(b"")
    result, _, error = client.call("recovery_codes_import_preview", {"input_path": str(empty_file)})
    assert error is None
    assert result["ok"] is True
    assert result["groups"] == []


def test_recovery_codes_import_preview_non_utf8_file_does_not_crash(client, tmp_path):
    _setup_and_unlock(client)
    bad_file = tmp_path / "weird-encoding.txt"
    # Invalid UTF-8 byte sequences mixed with one otherwise-valid-looking line.
    bad_file.write_bytes(b"\xff\xfe\x00\x01garbage\naaaaa-11111\n")
    result, _, error = client.call("recovery_codes_import_preview", {"input_path": str(bad_file)})
    assert error is None
    assert result["ok"] is True
    # The valid-looking line still parses even though the file overall has
    # invalid byte sequences (read with errors="replace", not a hard failure).
    assert "aaaaa-11111" in result["groups"][0]["codes"]


def test_recovery_codes_changed_import_bumps_last_updated_keeps_first_imported(client):
    """spec 11：同一 service+label 导入真正不同的码要判为 "changed"，确认后更新 lastUpdatedAt
    并保留原 firstImportedAt。"""
    _setup_and_unlock(client)
    preview, _, _ = client.call(
        "recovery_codes_import_preview", {"text": "aaaaa-11111\nbbbbb-22222\n", "source_file_name": "x.txt", "service": "GitHub"},
    )
    confirmed, _, _ = client.call(
        "recovery_codes_import_confirm",
        {"source_file_name": "x.txt", "groups": [{"service": "GitHub", "account_label": "", "codes": preview["groups"][0]["codes"]}]},
    )
    group_id = confirmed["groups"][0]["id"]
    original_first_imported_at = confirmed["groups"][0]["firstImportedAt"]

    preview2, _, _ = client.call(
        "recovery_codes_import_preview", {"text": "ccccc-33333\nddddd-44444\n", "source_file_name": "x.txt", "service": "GitHub"},
    )
    assert preview2["groups"][0]["action"] == "changed"
    assert preview2["groups"][0]["matchedGroupId"] == group_id

    result, _, error = client.call(
        "recovery_codes_import_confirm",
        {
            "source_file_name": "x.txt",
            "groups": [{"service": "GitHub", "account_label": "", "codes": preview2["groups"][0]["codes"], "group_id": group_id}],
        },
    )
    assert error is None
    updated = result["groups"][0]
    assert updated["id"] == group_id
    assert updated["firstImportedAt"] == original_first_imported_at
    assert updated["lastUpdatedAt"] >= original_first_imported_at
    assert updated["remainingCount"] == 2  # replaced wholesale, not appended to the old 2


def test_recovery_codes_list_handles_large_number_of_services(client):
    """spec 11 "大量密钥/服务"场景的基本规模检查：后端不能卡死或出错（流畅度需真实应用验证）。"""
    _setup_and_unlock(client)
    for i in range(150):
        client.call(
            "recovery_codes_import_confirm",
            {"source_file_name": "x.txt", "groups": [{"service": f"Service{i}", "account_label": "", "codes": [f"code{i}-aaaaa"]}]},
        )
    result, _, error = client.call("recovery_codes_list", {})
    assert error is None
    assert len(result["groups"]) == 150
    assert result["damaged"] == []

    summary, _, error = client.call("recovery_codes_dashboard_summary", {})
    assert error is None
    assert summary["serviceCount"] == 150
    assert summary["codeCount"] == 150


# 登录页卡死：biometric_status 原本同步分派，底下是 check_availability_async() 加 WinBio 传感器
# 枚举（首次实测 422 ms，传感器状态差时更久甚至不返回）。派发循环单线程（见 backend_server 模块
# 顶部），期间后端对任何请求都不回应，整个窗口像卡死；而登录页一挂载就调它。


def test_biometric_status_does_not_block_the_dispatch_loop(client):
    """先发慢的 biometric_status，紧接着发一个很快的请求；快的必须先回，否则说明又变回同步分派
    （登录页卡死的成因），且功能上看不出来，只是中间几百毫秒应用是死的。

    必须带 refresh：0.1.30 起后端启动即后台预热，不带 refresh 只读缓存、有意在派发线程上直接答，
    结果取决于预热是否先完成（无生物识别硬件的 CI 稳定失败，本机有传感器稳定通过）。
    """
    slow_id = client.send("biometric_status", {"refresh": True})
    fast_id = client.send("identity_exists", {})

    order = []
    while len(order) < 2:
        msg = client.read_one()
        if "progress" in msg:
            continue
        if msg.get("id") in (slow_id, fast_id):
            order.append(msg["id"])

    assert order[0] == fast_id, (
        "identity_exists 排在 biometric_status 后面才回来，说明硬件探测又回到了"
        "同步派发线程上——登录页会重新出现「点什么都没反应」"
    )


def test_biometric_status_still_answers_the_questions_the_login_page_asks(client):
    """改后台执行后返回内容必须一字不差：登录页靠 available/bound 决定是否自动弹 Windows Hello，
    靠 preferred 决定画人脸还是指纹，少一个字段界面就退化。"""
    result, _, error = client.call("biometric_status", {})
    assert error is None
    for field in ("ok", "available", "modalities", "chain", "preferred", "bound"):
        assert field in result, f"biometric_status 少了 {field}，登录页会拿不到判断依据"
    assert isinstance(result["chain"], list)
    # 没建库时「没绑」是唯一正确的答案，绝不能因为读不到存储就抛错——
    # 解锁页在任何情况下都必须能渲染出来。
    assert result["bound"] is False


# AI 模型列表：本地说明表只补充描述（日期），绝不决定显示哪些。`/models` 只给 id，所以要有本地表；
# 若被当成过滤器，DeepSeek 新发的模型会在界面上无声消失（无报错、测试全绿）。下面几条钉住这条边界。


def test_describe_models_keeps_models_it_has_never_heard_of():
    from modules.file_vault import ai_client

    described = ai_client.describe_models(["deepseek-v4-pro", "some-brand-new-model", "my-local-llama"])
    ids = [m["id"] for m in described]
    assert ids.count("some-brand-new-model") == 1, "陌生模型被本地表吃掉了——新模型会在界面上消失"
    assert ids.count("my-local-llama") == 1, "自建端点的模型名必须能被选中"

    unknown = next(m for m in described if m["id"] == "my-local-llama")
    assert unknown["label"] == "my-local-llama", "不认识的模型退回用 id 当显示名"
    assert unknown["released"] is None, "不知道日期就是 None，不许编一个"


def test_describe_models_puts_the_newest_release_first():
    from modules.file_vault import ai_client

    described = ai_client.describe_models(["deepseek-chat", "zzz-unknown", "deepseek-v4-pro", "deepseek-v4-flash"])
    ids = [m["id"] for m in described]
    # 找"最新那个"是最常见的诉求，它必须在第一行——按字母序会把已停用的
    # deepseek-chat 顶到最前面，正好是最不该选的那个。
    assert ids[0] == "deepseek-v4-flash", f"最新发布的没排在第一位：{ids}"
    assert ids.index("deepseek-v4-pro") < ids.index("deepseek-chat")
    assert ids[-1] == "zzz-unknown", "没有日期的应该垫底，而不是混在中间"


def test_describe_models_flags_models_deepseek_has_retired():
    from modules.file_vault import ai_client

    described = {m["id"]: m for m in ai_client.describe_models(["deepseek-chat", "deepseek-v4-pro"])}
    # 停用的模型仍然要显示（用户配置里可能还存着它），但必须标出来——
    # 否则它看起来跟正常选项一模一样，选了之后每次调用都失败。
    assert described["deepseek-chat"]["deprecated"] == "2026-07-24"
    assert described["deepseek-v4-pro"]["deprecated"] is None


def test_list_ai_models_still_returns_the_plain_id_array():
    """`models` 这个纯 id 数组不能删：后端更新了而渲染端还是旧版时，
    下拉框要仍然能用（只是少了日期）。更新过程中这两半不保证同时到位。"""
    import inspect
    from modules.file_vault import backend_server

    src = inspect.getsource(backend_server.rpc_list_ai_models)
    assert '"models": models' in src
    assert '"model_details"' in src


# --- 笔记：批量移入隐藏分类 / 批量导入到隐藏分类（含递归子分类）---


def test_move_to_hidden_bulk_sets_hidden_and_category_together(client):
    """「隐藏」和「归类」必须一起落地：分两次 RPC（note_set_hidden_bulk 再 note_category_move_bulk）
    中途失败，会让笔记已隐藏却仍在原可见分类，用户在指定的隐藏分类里也找不到。"""
    _setup_and_unlock(client)
    ids = []
    for title in ("a", "b", "c"):
        r, _, _ = client.call("note_create", {"title": title, "category": "工作", "content": ""})
        ids.append(r["note"]["id"])

    result, _, error = client.call("note_move_to_hidden_bulk", {"ids": ids, "category": "私密/财务/2026"})
    assert error is None
    assert result["ok"] is True
    assert result["updated_count"] == 3

    listed, _, _ = client.call("note_list", {})
    moved = [n for n in listed["notes"] if n["id"] in ids]
    assert len(moved) == 3
    for note in moved:
        assert note["is_hidden"] == 1, "笔记没有真的被隐藏"
        assert note["category"] == "私密/财务/2026", "分类没有跟着一起改"


def test_move_to_hidden_bulk_rejects_a_malformed_category_path(client):
    """空段（`私密//财务`）是输入错误，要当面报而不能悄悄规整：否则用户以为自己输对了，之后按
    `私密//财务` 这个名字找不到。"""
    _setup_and_unlock(client)
    r, _, _ = client.call("note_create", {"title": "x", "category": "", "content": ""})

    result, _, error = client.call(
        "note_move_to_hidden_bulk", {"ids": [r["note"]["id"]], "category": "私密//财务"}
    )
    assert error is None
    assert result["ok"] is False
    assert result["error"] == "notes.category_empty_segment"

    listed, _, _ = client.call("note_list", {})
    note = next(n for n in listed["notes"] if n["id"] == r["note"]["id"])
    assert note["is_hidden"] == 0, "路径不合法时不该已经把笔记藏起来了"


def test_import_files_can_land_straight_in_a_hidden_category(client, tmp_path):
    """批量导入直接落进隐藏区，且分类目录必须建在 hidden scope：建在 normal 里会让隐藏区分类树为空，
    笔记在库里却在界面上找不到。"""
    _setup_and_unlock(client)
    src = tmp_path / "src"
    (src / "财务" / "2026").mkdir(parents=True)
    (src / "财务" / "2026" / "报销.txt").write_text("报销明细", encoding="utf-8")
    (src / "顶层.txt").write_text("顶层内容", encoding="utf-8")

    result, _, error = client.call(
        "note_import_files",
        {
            "paths": [str(src / "财务" / "2026" / "报销.txt"), str(src / "顶层.txt")],
            "base_dir": str(src),
            "hidden": True,
            "target_category": "私密",
        },
    )
    assert error is None
    assert result["ok"] is True
    assert result["failed"] == []
    assert len(result["imported"]) == 2

    by_title = {n["title"]: n for n in result["imported"]}
    # 前缀和子文件夹派生的路径是**拼接**关系，不是二选一。
    assert by_title["报销"]["category"] == "私密/财务/2026"
    assert by_title["报销"]["is_hidden"] == 1
    # 没有子文件夹的那个只拿到前缀本身。
    assert by_title["顶层"]["category"] == "私密"
    assert by_title["顶层"]["is_hidden"] == 1

    hidden_cats, _, _ = client.call("note_category_list", {"scope": "hidden"})
    names = {c["name"] for c in hidden_cats["categories"]}
    # 每一级祖先都要在目录里，否则侧边栏那条分支是断的：笔记查得到、点不进去。
    assert {"私密", "私密/财务", "私密/财务/2026"} <= names, f"隐藏分类目录缺层级：{sorted(names)}"

    normal_cats, _, _ = client.call("note_category_list", {"scope": "normal"})
    normal_names = {c["name"] for c in normal_cats["categories"]}
    assert "私密/财务/2026" not in normal_names, "分类建到普通区去了，隐藏区的树会是空的"


def test_import_files_without_hidden_keeps_the_old_behaviour(client, tmp_path):
    """新参数默认关闭：不传 hidden/target_category 时行为跟以前完全一样。"""
    _setup_and_unlock(client)
    src = tmp_path / "src2"
    (src / "Internet").mkdir(parents=True)
    (src / "Internet" / "node.txt").write_text("node notes", encoding="utf-8")

    result, _, error = client.call(
        "note_import_files", {"paths": [str(src / "Internet" / "node.txt")], "base_dir": str(src)}
    )
    assert error is None
    assert result["ok"] is True
    note = result["imported"][0]
    assert note["category"] == "Internet"
    assert note["is_hidden"] == 0


def test_recovery_codes_import_confirm_securely_deletes_the_source_file(client, tmp_path):
    """导入完成后按要求安全删除源文件，是覆写后删除而非简单 unlink。

    源文件里是明文恢复码（绕过两步验证的后门），留在原地等于没保护，所以界面该勾默认打上。
    """
    _setup_and_unlock(client)
    source = tmp_path / "codes.txt"
    source.write_text("# GitHub\nabcd-1234\nefgh-5678\n", encoding="utf-8")

    preview, _, error = client.call("recovery_codes_import_preview", {"input_path": str(source)})
    assert error is None and preview["ok"] is True

    groups = [
        {"service": g["service"] or "GitHub", "account_label": g.get("accountLabel", ""), "codes": g["codes"]}
        for g in preview["groups"]
    ]
    result, _, error = client.call(
        "recovery_codes_import_confirm",
        {
            "source_file_name": preview["sourceFileName"],
            "groups": groups,
            "input_path": str(source),
            "delete_source": True,
        },
    )
    assert error is None
    assert result["ok"] is True
    assert result["source_deleted"] is True
    assert not source.exists(), "源文件还在，明文恢复码没被清掉"


def test_recovery_codes_import_confirm_leaves_the_source_alone_when_not_asked(client, tmp_path):
    """不勾就一个字节都不动源文件——默认值不能变成"反正都删"。"""
    _setup_and_unlock(client)
    source = tmp_path / "codes2.txt"
    original = "# GitLab\nzzzz-9999\nyyyy-8888\n"
    source.write_text(original, encoding="utf-8")

    preview, _, _ = client.call("recovery_codes_import_preview", {"input_path": str(source)})
    groups = [
        {"service": g["service"] or "GitLab", "account_label": g.get("accountLabel", ""), "codes": g["codes"]}
        for g in preview["groups"]
    ]
    result, _, error = client.call(
        "recovery_codes_import_confirm",
        {"source_file_name": preview["sourceFileName"], "groups": groups},
    )
    assert error is None
    assert result["ok"] is True
    assert "source_deleted" not in result  # 没要求删，就不该出现这个字段
    assert source.read_text(encoding="utf-8") == original


JSON_EXPORT_PASSWORD = "correct horse battery"


def _seed_one_group(client, *, label="工作账号", codes=None):
    """建一组恢复码并返回它的 id。"""
    codes = codes or ["05c93-3a58f", "c4842-3d0f3", "2dfc6-71fa3", "9bd37-bdade"]
    result, _, error = client.call(
        "recovery_codes_import_confirm",
        {
            "source_file_name": "github-recovery-codes.txt",
            "groups": [{"service": "GitHub", "account_label": label, "codes": codes}],
        },
    )
    assert error is None and result["ok"] is True
    return result["groups"][0]["id"]


def test_json_export_import_round_trip_keeps_used_flags_through_the_rpcs(client, tmp_path):
    """v1 最严重 bug 在 RPC 层的回归：导出再导入，「已用」标记必须还在，否则用户拿到的是看似有余量
    其实全废的清单，发现时已被锁在账号外。"""
    _setup_and_unlock(client)
    group_id = _seed_one_group(client)
    result, _, error = client.call(
        "recovery_codes_mark_used", {"id": group_id, "code_index": 1, "used": True}
    )
    assert error is None and result["ok"] is True

    path = tmp_path / "codes.json"
    result, _, error = client.call("recovery_codes_export_json", {"output_path": str(path)})
    assert error is None and result["ok"] is True
    assert result["output_paths"] == [str(path)]
    assert result["group_count"] == 1 and result["code_count"] == 4

    # 本地删空，再从文件恢复回来
    result, _, error = client.call("recovery_codes_delete", {"id": group_id})
    assert error is None and result["ok"] is True

    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(path)})
    assert error is None and result["ok"] is True
    assert result["meta"]["formatVersion"] == 2
    assert result["meta"]["checksumOk"] is True
    assert result["summary"]["newCount"] == 1
    key = result["items"][0]["key"]

    result, _, error = client.call(
        "recovery_codes_json_import_confirm",
        {"input_path": str(path), "decisions": {key: "use_file"}},
    )
    assert error is None and result["applied_count"] == 1

    restored = result["groups"][0]
    assert [c["used"] for c in restored["codes"]] == [False, True, False, False]
    assert restored["remainingCount"] == 3


def test_json_import_preview_writes_nothing(client, tmp_path):
    """预览就是试运行。它要能在用户还没决定之前，把「会发生什么」讲清楚，
    而自己一个字节都不落盘。"""
    _setup_and_unlock(client)
    _seed_one_group(client, label="A")
    path = tmp_path / "codes.json"
    client.call("recovery_codes_export_json", {"output_path": str(path)})

    before, _, _ = client.call("recovery_codes_list", {})
    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(path)})
    assert error is None and result["ok"] is True
    after, _, _ = client.call("recovery_codes_list", {})
    assert after["groups"] == before["groups"]


def test_json_import_merge_treats_a_code_as_used_if_either_side_used_it(client, tmp_path):
    """合并时 used 取或。反方向（把已用的当成可用）会让人在真正需要的时候
    拿着一串废码被锁在门外——这是唯一安全的方向。"""
    _setup_and_unlock(client)
    codes = ["05c93-3a58f", "c4842-3d0f3", "2dfc6-71fa3", "9bd37-bdade"]
    group_id = _seed_one_group(client, label="合并测试", codes=codes)

    # 先导出一份「全都没用过」的快照
    path = tmp_path / "snapshot.json"
    client.call("recovery_codes_export_json", {"output_path": str(path)})

    # 之后在本地用掉一个
    client.call("recovery_codes_mark_used", {"id": group_id, "code_index": 0, "used": True})

    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(path)})
    assert error is None
    key = result["items"][0]["key"]
    assert result["items"][0]["status"] == "conflict"

    result, _, error = client.call(
        "recovery_codes_json_import_confirm",
        {"input_path": str(path), "decisions": {key: "merge"}},
    )
    assert error is None and result["applied_count"] == 1
    merged = result["groups"][0]
    # 文件里说它没用过，本地说用过 —— 结果必须是「用过」。
    assert merged["codes"][0]["used"] is True
    assert merged["remainingCount"] == 3


def test_json_import_keep_local_changes_nothing(client, tmp_path):
    _setup_and_unlock(client)
    group_id = _seed_one_group(client, label="保留本地")
    path = tmp_path / "codes.json"
    client.call("recovery_codes_export_json", {"output_path": str(path)})
    client.call("recovery_codes_mark_used", {"id": group_id, "code_index": 2, "used": True})

    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(path)})
    key = result["items"][0]["key"]
    result, _, error = client.call(
        "recovery_codes_json_import_confirm",
        {"input_path": str(path), "decisions": {key: "keep_local"}},
    )
    assert error is None and result["applied_count"] == 0
    assert result["groups"][0]["codes"][2]["used"] is True


def test_encrypted_json_export_needs_the_right_password_to_import(client, tmp_path):
    _setup_and_unlock(client)
    _seed_one_group(client, label="加密测试")
    path = tmp_path / "codes.enc.json"
    result, _, error = client.call(
        "recovery_codes_export_json",
        {"output_path": str(path), "password": JSON_EXPORT_PASSWORD},
    )
    assert error is None and result["encrypted"] is True
    # 明文的服务名不该出现在文件里
    assert "GitHub" not in path.read_text(encoding="utf-8")

    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(path)})
    assert result["ok"] is False and result["error"] == "recovery_codes.json_password_required"

    result, _, error = client.call(
        "recovery_codes_json_import_preview", {"input_path": str(path), "password": "nope nope nope"}
    )
    assert result["ok"] is False and result["error"] == "recovery_codes.json_wrong_password"

    result, _, error = client.call(
        "recovery_codes_json_import_preview",
        {"input_path": str(path), "password": JSON_EXPORT_PASSWORD},
    )
    assert error is None and result["ok"] is True
    assert result["meta"]["encrypted"] is True
    assert result["summary"]["fileGroupCount"] == 1


def test_encrypted_json_export_rejects_a_short_password(client, tmp_path):
    _setup_and_unlock(client)
    _seed_one_group(client)
    result, _, error = client.call(
        "recovery_codes_export_json",
        {"output_path": str(tmp_path / "x.json"), "password": "short"},
    )
    assert result["ok"] is False and result["error"] == "recovery_codes.backup_password_too_short"


def test_redacted_and_encrypted_are_mutually_exclusive(client, tmp_path):
    """脱敏是「给人看」，加密是「存起来」。同时要求两者说明调用方没想清楚
    要什么，与其猜一个不如直接说不行。"""
    _setup_and_unlock(client)
    _seed_one_group(client)
    result, _, error = client.call(
        "recovery_codes_export_json",
        {"output_path": str(tmp_path / "x.json"), "include_codes": False, "password": JSON_EXPORT_PASSWORD},
    )
    assert result["ok"] is False
    assert result["error"] == "recovery_codes.json_redacted_cannot_encrypt"


def test_redacted_export_has_no_codes_and_cannot_be_imported_back(client, tmp_path):
    _setup_and_unlock(client)
    _seed_one_group(client)
    path = tmp_path / "stats.json"
    result, _, error = client.call(
        "recovery_codes_export_json", {"output_path": str(path), "include_codes": False}
    )
    assert error is None and result["codes_redacted"] is True
    assert "05c93-3a58f" not in path.read_text(encoding="utf-8")

    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(path)})
    assert result["ok"] is False and result["error"] == "recovery_codes.json_codes_redacted"


def test_only_unused_export_leaves_the_live_vault_untouched(client, tmp_path):
    """「只导出还没用过的」绝不能把本地的已用记录一起抹掉——那会是一次
    由导出动作引发的静默数据丢失。"""
    _setup_and_unlock(client)
    group_id = _seed_one_group(client, label="只导未用")
    client.call("recovery_codes_mark_used", {"id": group_id, "code_index": 0, "used": True})

    path = tmp_path / "unused.json"
    result, _, error = client.call(
        "recovery_codes_export_json", {"output_path": str(path), "only_unused": True}
    )
    assert error is None and result["code_count"] == 3

    after, _, _ = client.call("recovery_codes_list", {})
    assert [c["used"] for c in after["groups"][0]["codes"]] == [True, False, False, False]


def test_split_export_writes_one_file_per_chunk(client, tmp_path):
    _setup_and_unlock(client)
    for label in ("A", "B", "C"):
        _seed_one_group(client, label=label)

    path = tmp_path / "codes.json"
    result, _, error = client.call(
        "recovery_codes_export_json", {"output_path": str(path), "split_size": 2}
    )
    assert error is None
    assert result["output_paths"] == [str(tmp_path / "codes.1.json"), str(tmp_path / "codes.2.json")]
    assert all(Path(p).exists() for p in result["output_paths"])
    # 单份时不改名——「导出一份」不该被平白加上序号。
    single = tmp_path / "single.json"
    result, _, error = client.call("recovery_codes_export_json", {"output_path": str(single)})
    assert result["output_paths"] == [str(single)]


def test_json_export_with_nothing_selected_says_so(client, tmp_path):
    _setup_and_unlock(client)
    result, _, error = client.call(
        "recovery_codes_export_json", {"output_path": str(tmp_path / "x.json")}
    )
    assert result["ok"] is False and result["error"] == "recovery_codes.nothing_to_export"


def test_json_import_requires_unlock(client, tmp_path):
    result, _, error = client.call(
        "recovery_codes_json_import_preview", {"input_path": str(tmp_path / "x.json")}
    )
    assert result is None and error == "auth.not_unlocked"


def test_oversized_json_import_is_refused_before_it_is_parsed(client, tmp_path):
    """导入文件是不可信输入：json.loads 会把整份文件建成内存里的对象图，
    没有闸门就等于允许一个文件把后端撑爆。"""
    _setup_and_unlock(client)
    fat = tmp_path / "fat.json"
    fat.write_bytes(b"[" + b'{"service":"x","codes":[]},' * 200_000 + b"]")
    assert fat.stat().st_size > 4 * 1024 * 1024

    result, _, error = client.call("recovery_codes_json_import_preview", {"input_path": str(fat)})
    assert result["ok"] is False and result["error"] == "recovery_codes.file_too_large"
