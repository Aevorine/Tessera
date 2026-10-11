"""Email one-time-code unlock: send a numeric code via SMTP, verify it within an expiry window, once only.

The code is never persisted (memory only, see PendingOtp); `sender` is injectable so the
issue/expire/single-use logic is testable without real email.
"""

import secrets
import smtplib
import ssl
import time
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Callable, Optional

from core.logging import get_logger

logger = get_logger(__name__)

CODE_LENGTH = 6
EXPIRY_SECONDS = 10 * 60  # 10 minutes

SenderFunc = Callable[["SmtpConfig", str, str, str], None]


@dataclass
class SmtpConfig:
    host: str
    port: int
    username: str
    password: str
    use_ssl: bool = False  # True for port 465; False uses STARTTLS (typical for 587)


@dataclass
class PendingOtp:
    code: str
    expires_at: float
    used: bool = False

    def is_expired(self) -> bool:
        return time.time() > self.expires_at


def _generate_code() -> str:
    return "".join(secrets.choice("0123456789") for _ in range(CODE_LENGTH))


CONNECT_TIMEOUT_S = 15

# 某 (端口, 隐式TLS) 组合连不上时的备选。实测：本机网络上 smtp.163.com / gmail / office365
# 的 587 在 EHLO 后永远等不到应答（15 秒 SMTPServerDisconnected），TCP 握手成功，
# 疑似明文提交端口被中间设备吞掉；而 465 隐式 TLS 约 2 秒即通。反方向（只放行 587）也保留。
_FALLBACK_ENDPOINT = {
    (587, False): (465, True),
    (25, False): (465, True),
    (465, True): (587, False),
}


def _deliver(config: SmtpConfig, msg: EmailMessage, port: int, use_ssl: bool) -> None:
    tls_context = ssl.create_default_context()
    if use_ssl:
        with smtplib.SMTP_SSL(config.host, port, timeout=CONNECT_TIMEOUT_S, context=tls_context) as server:
            server.login(config.username, config.password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(config.host, port, timeout=CONNECT_TIMEOUT_S) as server:
            server.ehlo()
            server.starttls(context=tls_context)
            server.ehlo()
            server.login(config.username, config.password)
            server.send_message(msg)


def _is_reachability_failure(exc: Exception) -> bool:
    """失败是「连不上/被掐断」还是「服务器明确拒绝」？只有前者值得换端口重试。
    认证失败和收件人被拒绝不能重试：换端口只会再错，还会累计对方风控导致临时封禁。"""
    if isinstance(exc, (smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused)):
        return False
    return isinstance(exc, (OSError, smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, ssl.SSLError))


def default_sender(config: SmtpConfig, to_addr: str, subject: str, body: str) -> None:
    """Real SMTP send via smtplib; raises on connection/auth failure.

    连不上会换一次端口/加密方式重试（见 _FALLBACK_ENDPOINT），两次都失败才抛，
    消息里带两次的原因，否则用户只会看到自己从没配过的端口。
    """
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = config.username
    msg["To"] = to_addr
    msg.set_content(body)

    primary = (config.port, config.use_ssl)
    try:
        _deliver(config, msg, *primary)
        return
    except Exception as first:
        fallback = _FALLBACK_ENDPOINT.get(primary)
        if fallback is None or not _is_reachability_failure(first):
            raise
        logger.warning(
            "SMTP %s:%s (ssl=%s) unreachable (%s); retrying on :%s (ssl=%s)",
            config.host, primary[0], primary[1], first, fallback[0], fallback[1],
        )
        try:
            _deliver(config, msg, *fallback)
        except Exception as second:
            raise smtplib.SMTPException(
                f"{config.host}:{primary[0]} ({'SSL' if primary[1] else 'STARTTLS'}) -> {first}; "
                f"{config.host}:{fallback[0]} ({'SSL' if fallback[1] else 'STARTTLS'}) -> {second}"
            ) from first
        logger.info("SMTP delivered via fallback endpoint :%s (ssl=%s)", fallback[0], fallback[1])


def send_otp(
    config: SmtpConfig,
    to_addr: str,
    sender: Optional[SenderFunc] = None,
) -> PendingOtp:
    """Generate a fresh code, send it, and return the pending state; `sender` defaults to real SMTP, tests inject a fake."""
    sender = sender or default_sender
    code = _generate_code()
    subject = "Tessera - 解锁验证码"
    body = f"你的文件解锁验证码是：{code}\n\n{EXPIRY_SECONDS // 60} 分钟内有效，仅可使用一次。"

    sender(config, to_addr, subject, body)
    logger.info("Sent email OTP to %s", to_addr)
    return PendingOtp(code=code, expires_at=time.time() + EXPIRY_SECONDS)


def verify_otp(pending: PendingOtp, submitted_code: str) -> bool:
    """Check the code against a pending OTP; marks it used on success (no replay), not on failure (retry until expiry)."""
    if pending.used or pending.is_expired():
        return False
    if not secrets.compare_digest(pending.code, (submitted_code or "").strip()):
        return False
    pending.used = True
    return True
