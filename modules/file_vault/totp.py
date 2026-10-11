"""TOTP（验证器 App）支持：种子生成、QR 配置、实时码校验（RFC 6238，经 pyotp 兼容主流验证器）。
TOTP 种子是经 HKDF（见 identity.py）派生解锁 KEK 的稳定秘密；实时 6 位码只作持有证明的门槛，之后才读取种子。"""

import qrcode
import pyotp
from PIL import Image

ISSUER_NAME = "Tessera"


def generate_seed() -> str:
    return pyotp.random_base32()


def provisioning_uri(seed: str, account_label: str) -> str:
    return pyotp.TOTP(seed).provisioning_uri(name=account_label, issuer_name=ISSUER_NAME)


def make_qr_image(seed: str, account_label: str) -> Image.Image:
    """Return a PIL Image of the QR code to scan into an authenticator app."""
    uri = provisioning_uri(seed, account_label)
    qr_img = qrcode.make(uri)
    return qr_img.get_image() if hasattr(qr_img, "get_image") else qr_img


def verify_code(seed: str, code: str) -> bool:
    """校验实时 6 位码，允许 ±1 个时间步（约 30 秒）时钟漂移。"""
    code = (code or "").strip()
    if not code:
        return False
    return pyotp.TOTP(seed).verify(code, valid_window=1)


def current_code(seed: str) -> str:
    """仅供测试：无需真实验证器即可生成有效码。"""
    return pyotp.TOTP(seed).now()
