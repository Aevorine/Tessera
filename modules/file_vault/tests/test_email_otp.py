import ssl
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import email_otp
from modules.file_vault.email_otp import PendingOtp, SmtpConfig, send_otp, verify_otp

FAKE_CONFIG = SmtpConfig(host="smtp.example.com", port=587, username="me@example.com", password="app-password")


def fake_sender_factory(sent_messages):
    def _sender(config, to_addr, subject, body):
        sent_messages.append((config, to_addr, subject, body))

    return _sender


def test_send_otp_calls_sender_and_returns_pending():
    sent = []
    pending = send_otp(FAKE_CONFIG, "user@example.com", sender=fake_sender_factory(sent))
    assert len(sent) == 1
    assert sent[0][1] == "user@example.com"
    assert len(pending.code) == 6
    assert pending.code.isdigit()
    assert not pending.used


def test_verify_otp_correct_code_succeeds_once():
    sent = []
    pending = send_otp(FAKE_CONFIG, "user@example.com", sender=fake_sender_factory(sent))
    assert verify_otp(pending, pending.code) is True
    assert pending.used is True


def test_verify_otp_cannot_be_replayed():
    sent = []
    pending = send_otp(FAKE_CONFIG, "user@example.com", sender=fake_sender_factory(sent))
    assert verify_otp(pending, pending.code) is True
    assert verify_otp(pending, pending.code) is False


def test_verify_otp_wrong_code_fails():
    sent = []
    pending = send_otp(FAKE_CONFIG, "user@example.com", sender=fake_sender_factory(sent))
    assert verify_otp(pending, "000000") is False
    assert pending.used is False  # a failed attempt doesn't burn the real code


def test_verify_otp_expired_fails():
    pending = PendingOtp(code="123456", expires_at=time.time() - 1)
    assert verify_otp(pending, "123456") is False


def test_sender_failure_propagates():
    def failing_sender(config, to_addr, subject, body):
        raise ConnectionError("SMTP unreachable")

    try:
        send_otp(FAKE_CONFIG, "user@example.com", sender=failing_sender)
        assert False, "should have raised"
    except ConnectionError:
        pass


def test_default_sender_verifies_smtp_certificates_for_starttls(monkeypatch):
    captured = {}

    class FakeSmtp:
        def __init__(self, *args, **kwargs):
            captured["init"] = (args, kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def ehlo(self):
            captured["ehlo_calls"] = captured.get("ehlo_calls", 0) + 1

        def starttls(self, *, context):
            captured["context"] = context

        def login(self, *_args):
            pass

        def send_message(self, *_args):
            pass

    monkeypatch.setattr(email_otp.smtplib, "SMTP", FakeSmtp)
    email_otp.default_sender(FAKE_CONFIG, "user@example.com", "subject", "body")

    assert captured["context"].check_hostname is True
    assert captured["context"].verify_mode == ssl.CERT_REQUIRED
    assert captured["ehlo_calls"] == 2


def test_default_sender_verifies_smtp_certificates_for_implicit_tls(monkeypatch):
    captured = {}

    class FakeSmtpSsl:
        def __init__(self, *args, **kwargs):
            captured["context"] = kwargs.get("context")

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def login(self, *_args):
            pass

        def send_message(self, *_args):
            pass

    monkeypatch.setattr(email_otp.smtplib, "SMTP_SSL", FakeSmtpSsl)
    email_otp.default_sender(
        SmtpConfig(host="smtp.example.com", port=465, username="me@example.com", password="app-password", use_ssl=True),
        "user@example.com", "subject", "body",
    )

    assert captured["context"].check_hostname is True
    assert captured["context"].verify_mode == ssl.CERT_REQUIRED


# 端点自动回退：587 STARTTLS 被吞时改走 465 隐式 TLS。这是实测的：本机网络上 smtp.163.com /
# smtp.gmail.com / smtp.office365.com 的 587 能 TCP 连上，但 EHLO 永远无应答，15 秒后抛
# SMTPServerDisconnected（timed out）；同样几家的 465 在 1.6~2.2 秒内通过，界面上没有任何线索。


def _record_attempts(fail_on, exc_factory):
    """造一个假的投递函数：记录每次用了什么端点，并在指定端点上抛指定异常。"""
    attempts = []

    def _deliver(config, msg, port, use_ssl):
        attempts.append((port, use_ssl))
        if (port, use_ssl) in fail_on:
            raise exc_factory()

    return attempts, _deliver


def test_starttls_timeout_falls_back_to_implicit_tls(monkeypatch):
    import smtplib

    attempts, deliver = _record_attempts(
        {(587, False)},
        lambda: smtplib.SMTPServerDisconnected("Connection unexpectedly closed: timed out"),
    )
    monkeypatch.setattr(email_otp, "_deliver", deliver)

    email_otp.default_sender(FAKE_CONFIG, "user@example.com", "s", "b")

    assert attempts == [(587, False), (465, True)]


def test_implicit_tls_blocked_falls_back_to_starttls(monkeypatch):
    attempts, deliver = _record_attempts({(465, True)}, lambda: OSError("connection refused"))
    monkeypatch.setattr(email_otp, "_deliver", deliver)

    email_otp.default_sender(
        SmtpConfig(host="smtp.example.com", port=465, username="me@example.com", password="p", use_ssl=True),
        "user@example.com",
        "s",
        "b",
    )

    assert attempts == [(465, True), (587, False)]


def test_auth_failure_is_never_retried_on_another_port(monkeypatch):
    """密码错了就是错了，换端口只会再错一次——而且连着几次登录失败可能触发对方的
    临时封禁，那是帮倒忙。"""
    import smtplib

    attempts, deliver = _record_attempts(
        {(587, False), (465, True)},
        lambda: smtplib.SMTPAuthenticationError(535, b"auth failed"),
    )
    monkeypatch.setattr(email_otp, "_deliver", deliver)

    try:
        email_otp.default_sender(FAKE_CONFIG, "user@example.com", "s", "b")
    except smtplib.SMTPAuthenticationError:
        pass
    else:
        raise AssertionError("认证失败必须原样抛出去")

    assert attempts == [(587, False)]


def test_both_endpoints_failing_reports_both_reasons(monkeypatch):
    """只报第二次的原因，用户看到的会是一个自己从来没配过的端口号。"""
    import smtplib

    calls = []

    def _deliver(config, msg, port, use_ssl):
        calls.append(port)
        raise smtplib.SMTPServerDisconnected(f"dead on {port}")

    monkeypatch.setattr(email_otp, "_deliver", _deliver)

    try:
        email_otp.default_sender(FAKE_CONFIG, "user@example.com", "s", "b")
    except smtplib.SMTPException as exc:
        message = str(exc)
    else:
        raise AssertionError("两个端点都不通时必须抛出来")

    assert calls == [587, 465]
    assert "587" in message and "465" in message
    assert "STARTTLS" in message and "SSL" in message
