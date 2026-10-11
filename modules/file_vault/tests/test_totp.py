import sys
from pathlib import Path

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.totp import (
    ISSUER_NAME,
    current_code,
    generate_seed,
    make_qr_image,
    provisioning_uri,
    verify_code,
)


def test_generate_seed_is_base32_nonempty():
    seed = generate_seed()
    assert isinstance(seed, str)
    assert len(seed) >= 16


def test_current_code_is_verified_by_verify_code():
    seed = generate_seed()
    code = current_code(seed)
    assert len(code) == 6
    assert verify_code(seed, code) is True


def test_wrong_code_fails():
    seed = generate_seed()
    assert verify_code(seed, "000000") is False


def test_empty_code_fails():
    seed = generate_seed()
    assert verify_code(seed, "") is False


def test_different_seeds_reject_each_others_codes():
    seed_a = generate_seed()
    seed_b = generate_seed()
    code_a = current_code(seed_a)
    assert verify_code(seed_b, code_a) is False


def test_provisioning_uri_contains_secret_and_issuer():
    seed = generate_seed()
    uri = provisioning_uri(seed, "user@example.com")
    assert uri.startswith("otpauth://totp/")
    assert seed in uri
    # 断言 issuer 与模块常量一致而非写死字符串：应用改名时写死的会因无关原因红，
    # 而真正该守的（provisioning URI 带 issuer，否则验证器里显示无名条目）反而没表达出来。
    assert f"issuer={ISSUER_NAME}" in uri


def test_make_qr_image_returns_pil_image():
    seed = generate_seed()
    img = make_qr_image(seed, "user@example.com")
    assert isinstance(img, Image.Image)
    assert img.size[0] > 0 and img.size[1] > 0
