import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.clipboard import sensitive_detector


def test_long_plain_word_is_not_a_slack_token():
    # 旧规则 ^s[A-Za-z0-9=]{30,}$ 把任何以 s 开头的长单词都当成 Slack 令牌。
    assert sensitive_detector.classify("supercalifragilisticexpialidocious") != "sensitive"
    assert sensitive_detector.classify("someVeryLongVariableNameWithoutSpacesX") != "sensitive"


def test_slack_token_is_sensitive():
    # 拼接构造的假令牌：整段字面量会被推送前的密钥扫描当成真凭据。
    fake = "xox" + "b-" + "1" * 12 + "-" + "A" * 24
    assert sensitive_detector.classify(fake) == "sensitive"
