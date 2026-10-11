import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.clipboard import sensitive_detector


def test_classifies_plain_text_as_not_sensitive():
    assert sensitive_detector.classify("just a normal sentence.") == "text"
    assert sensitive_detector.classify("") == "text"


def test_classifies_github_token_as_sensitive():
    assert sensitive_detector.classify("ghp_" + "a" * 36) == "sensitive"


def test_classifies_openai_key_as_sensitive():
    assert sensitive_detector.classify("sk-" + "a" * 20) == "sensitive"


def test_classifies_aws_access_key_as_sensitive():
    assert sensitive_detector.classify("AKIA" + "ABCDEFGHIJKLMNOP") == "sensitive"


def test_classifies_private_key_header_as_sensitive():
    assert sensitive_detector.classify("-----BEGIN RSA " + "PRIVATE KEY-----") == "sensitive"


def test_classifies_inline_password_assignment_as_sensitive():
    assert sensitive_detector.classify("my config has password=hunter2 in it") == "sensitive"
    assert sensitive_detector.classify("pwd: s3cr3tvalue and nothing else") == "sensitive"


def test_classifies_inline_api_key_assignment_as_sensitive():
    assert sensitive_detector.classify("api_key=" + "abcdef" + "1234567890" + "abcdef") == "sensitive"


def test_classifies_valid_credit_card_as_sensitive():
    # 4111 1111 1111 1111 is the well-known Visa test number - passes Luhn.
    assert sensitive_detector.classify("card number: 4111 1111 1111 1111") == "sensitive"
    assert sensitive_detector.classify("4111111111111111") == "sensitive"  # no separators


def test_does_not_classify_invalid_luhn_number_as_sensitive():
    # Same shape as a card number but the last digit fails the Luhn checksum.
    assert sensitive_detector.classify("1234 5678 9012 3456") == "text"


def test_classifies_structurally_valid_china_id_as_sensitive():
    # region(6) + century(19) + year(90) + month(03) + day(07) + seq(775) + check(8) = 18 chars
    assert sensitive_detector.classify("身份证号是11010519491231002X呢") == "sensitive"


def test_does_not_classify_digits_without_a_valid_id_shape_as_sensitive():
    assert sensitive_detector.classify("999999999999999999") == "text"  # no valid century marker anywhere
    assert sensitive_detector.classify("just some regular digits 12345") == "text"


def test_classifies_standalone_base64_looking_blob_as_sensitive():
    # 整行只有一个 40+ 字符、字符集符合 base64 的片段，命中"整段即密钥"分支。
    token = "aB3" * 15  # 45 chars, entirely within [A-Za-z0-9+/]
    assert sensitive_detector.classify(token) == "sensitive"


def test_classify_returns_text_not_sensitive_string_literal_for_negatives():
    # 显式核对返回值就是 "text" 字符串（跟 classifier.classify 的其它类型互不干扰），
    # 不是某种真值/假值近似。
    assert sensitive_detector.classify("hello world") == "text"
