"""敏感内容轻量正则检测（密码 / API Key / 信用卡号 / 身份证号）。
纯正则零依赖（同 classifier.py）；只标记 is_sensitive，不改原文、不额外存储（库已由 SQLCipher 加
密），
仅供前端展示 🔑/🔒。"""

import re

# --- 整段即为敏感内容（Standalone）---

_KEY_STANDALONE_LINE_RE = re.compile(
    r"^(?:"
    r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,251}"               # GitHub Personal Access Token
    r"|xox[abposr]-[A-Za-z0-9-]{10,}"                               # Slack token（xoxb/xoxp/xoxa/…）
    r"|sk-[A-Za-z0-9]{20,}"                                         # OpenAI API Key
    r"|AKIA[0-9A-Z]{16}"                                            # AWS Access Key ID
    r"|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"           # Private key header
    r"|-----BEGIN PGP (?:PRIVATE KEY BLOCK|MESSAGE)-----"           # PGP key / message
    r"|[A-Za-z0-9+/]{40,}={0,2}"                                     # Generic Base64 blob (40+ chars)
    r")$"
)

# --- 文本中出现的敏感模式（Inline）---

_INLINE_API_KEY_RE = re.compile(
    r"(?i)(?:"
    r"(?:api[_-]?key|apikey|api[._]secret|secret[._]?key)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}"
    r"|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,251}"
    r"|sk-[A-Za-z0-9]{20,}"
    r"|AKIA[0-9A-Z]{16}"
    r")"
)

_PASSWORD_LIKE_RE = re.compile(
    r"(?i)(?:"
    r"password\s*[:=]\s*['\"]?[^\s'\"&<>]{4,}"
    r"|passwd\s*[:=]\s*['\"]?[^\s'\"&<>]{4,}"
    r"|pwd\s*[:=]\s*['\"]?[^\s'\"&<>]{4,}"
    r")"
)

# 用 (?<!\d)/(?!\d) 而非 \b：Python 的 \w 把中文也算单词字符，"卡号是4111111111111111的"
# 这类中文紧贴数字的写法 \b 不成边界会漏掉。只需保证不是从更长数字串中间截取。
_CREDIT_CARD_RE = re.compile(
    r"(?<!\d)(?:\d{4}[-\s]?){3}\d{4}(?!\d)"
)

_CHINA_ID_RE = re.compile(
    r"(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)"
)


def _luhn_check(digits: str) -> bool:
    n_digits = [int(c) for c in digits if c.isdigit()]
    if len(n_digits) != 16:
        return False
    checksum = 0
    for i, d in enumerate(reversed(n_digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def check_standalone(text: str) -> bool:
    """检测整段文本是否为密钥/令牌。"""
    stripped = text.strip()
    if not stripped:
        return False
    if _KEY_STANDALONE_LINE_RE.match(stripped):
        return True
    if len(stripped) >= 32 and _looks_high_entropy(stripped):
        return True
    return False


def _looks_high_entropy(text: str) -> bool:
    if len(text) < 32:
        return False
    has_lower = any(c.islower() for c in text)
    has_upper = any(c.isupper() for c in text)
    has_digit = any(c.isdigit() for c in text)
    has_special = any(c in "+/=?$#@!%^&*" for c in text)
    categories = sum([has_lower, has_upper, has_digit, has_special])
    if categories >= 3:
        words = text.split()
        if len(words) <= 2 and len(text) / max(len(set(text.lower())), 1) > 2.0:
            return True
    return False


def check_inline(text: str) -> bool:
    if not text:
        return False
    if _INLINE_API_KEY_RE.search(text):
        return True
    if _PASSWORD_LIKE_RE.search(text):
        return True
    return False


def check_credit_card(text: str) -> bool:
    if not text:
        return False
    match = _CREDIT_CARD_RE.search(text)
    if not match:
        return False
    return _luhn_check(match.group())


def check_china_id(text: str) -> bool:
    if not text:
        return False
    return bool(_CHINA_ID_RE.search(text))


def classify(text: str) -> str:
    """判断文本是否含敏感内容，返回 'sensitive' 或 'text'（与 classifier.classify() 兼容）；只分类，
    不改存储内容。"""
    if not text:
        return "text"
    if check_standalone(text):
        return "sensitive"
    if check_inline(text):
        return "sensitive"
    if check_credit_card(text):
        return "sensitive"
    if check_china_id(text):
        return "sensitive"
    return "text"
