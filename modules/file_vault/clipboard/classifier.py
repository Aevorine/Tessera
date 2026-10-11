"""文本剪贴板条目的正则/启发式分类：URL / 邮箱 / 电话 / 代码 / 人名，其余为纯文本。
按整段复制内容分类，不识别夹在文章里的子串。"""

import re

_URL_RE = re.compile(r"^(https?://|www\.)\S+$", re.IGNORECASE)
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
# 中国大陆手机号（11位1开头）或带国际区号/分隔符的通用号码，宽松匹配，
# 允许空格/短横线/括号，数字部分 7~15 位。
_PHONE_RE = re.compile(r"^\+?[\d\s\-()]{7,20}$")
_PHONE_DIGIT_COUNT_RE = re.compile(r"\d")

_CODE_KEYWORDS = (
    "def ", "function ", "class ", "import ", "from ", "return ", "const ", "let ", "var ",
    "public ", "private ", "#include", "package ", "func ", "SELECT ", "console.log",
)

# 人名只是近似判断（纯正则/启发式，无 NLP 或姓名库）：会漏判生僻姓氏，
# 也会把 "New York" 这类短语误判为姓名，与 _looks_like_phone / _looks_like_code 同样取舍。

# 常见中文单字姓氏（取《百家姓》常见部分，不求穷尽）：仅开头命中且整段是 2~4 个纯汉字
# 才算中文姓名，以区分随手复制的词语/地名。
_CHINESE_SURNAMES = frozenset(
    "李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓"
    "许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊"
    "金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段钱汤尹黎易常武乔贺赖龚文"
)
# 常见二字复姓——同上，只有开头匹配才算，且复姓后至少还要有一个名字用字。
_CHINESE_COMPOUND_SURNAMES = frozenset(
    {
        "欧阳", "司马", "上官", "诸葛", "东方", "皇甫", "尉迟", "公孙", "长孙",
        "慕容", "宇文", "夏侯", "轩辕", "令狐", "钟离", "闾丘", "澹台", "拓跋",
    }
)
_CJK_NAME_RE = re.compile(r"^[一-鿿]{2,4}$")

# 常见韩语姓氏（谚文单字）——同中文姓氏表的道理，把姓名跟任意 2~4 个谚文
# 音节的短语区分开。
_KOREAN_SURNAMES = frozenset("김이박최정강조윤장임한오서신권황안송전홍")
_HANGUL_NAME_RE = re.compile(r"^[가-힣]{2,4}$")

# 允许夹在姓名中间、可不大写的连接词（van、de 等），首尾词仍须符合 _is_cased_name_word。
_NAME_PARTICLES = frozenset(
    {"de", "del", "della", "der", "van", "von", "bin", "binti", "ibn", "al", "da", "di", "du", "la", "le", "dos", "das", "y", "e"}
)
# 姓名词内部允许连字符/撇号（"Anne-Marie" "O'Brien"），可选结尾句点表示
# 缩写名（"J."）。
_LATIN_NAME_WORD_RE = re.compile(r"^[^\W\d_]+((?:['\-][^\W\d_]+)*)\.?$")


def _looks_like_phone(text: str) -> bool:
    if not _PHONE_RE.match(text):
        return False
    digit_count = len(_PHONE_DIGIT_COUNT_RE.findall(text))
    return 7 <= digit_count <= 15


def _looks_like_code(text: str) -> bool:
    lines = text.splitlines()
    if len(lines) < 2:
        # 单行也可能是代码（比如一行 import），但为了不把"写了个 return 的
        # 句子"误判，单行只在包含明显语法符号时才算代码。
        symbol_density = sum(text.count(c) for c in "{}();=<>") / max(len(text), 1)
        return symbol_density > 0.08 and any(kw in text for kw in _CODE_KEYWORDS)

    indented_lines = sum(1 for l in lines if l.startswith(("    ", "\t")))
    keyword_hit = any(kw in text for kw in _CODE_KEYWORDS)
    symbol_density = sum(text.count(c) for c in "{}();") / max(len(text), 1)
    return keyword_hit or indented_lines >= 2 or symbol_density > 0.03


def _looks_like_chinese_name(text: str) -> bool:
    if not _CJK_NAME_RE.match(text):
        return False
    if text[:2] in _CHINESE_COMPOUND_SURNAMES:
        return len(text) >= 3
    return text[0] in _CHINESE_SURNAMES


def _looks_like_korean_name(text: str) -> bool:
    return bool(_HANGUL_NAME_RE.match(text)) and text[0] in _KOREAN_SURNAMES


def _is_cased_name_word(word: str) -> bool:
    """单个拉丁/西里尔/希腊文姓名词：首字母大写词（可含连字符/撇号，如 Anne-Marie、O'Brien）
    或带句点的单字母缩写（J.）。靠 str.isupper()/islower() 只对有大小写文字成立，自然排除 CJK/韩文/
    阿拉伯文。"""
    match = _LATIN_NAME_WORD_RE.match(word)
    if not match:
        return False
    parts = re.split(r"['\-]", match.group(0).rstrip("."))
    return all(part and part[0].isupper() and (len(part) == 1 or part[1:].islower()) for part in parts)


def _looks_like_cased_name(text: str) -> bool:
    words = text.split()
    if not 2 <= len(words) <= 4:
        return False
    if not _is_cased_name_word(words[0]) or not _is_cased_name_word(words[-1]):
        return False
    return all(w.lower() in _NAME_PARTICLES or _is_cased_name_word(w) for w in words[1:-1])


def _looks_like_name(text: str) -> bool:
    return _looks_like_chinese_name(text) or _looks_like_korean_name(text) or _looks_like_cased_name(text)


# 公式（数学/物理）判据，命中任一即可：
# ① 明确的 LaTeX 标记（`\frac`、`$...$`、`\begin{equation}`），几乎不会出现在别处。
# ② 数学/物理符号的密度，而非"出现过就算"，免得把「今天 25°C，比昨天高 ±2 度」判成公式。

# 结尾用 `(?![A-Za-z])` 而非 `\b`：命令后常跟 `_`/`^`（`\sum_{i=1}`），`_` 是单词字符，
# `\b` 在 `\sum` 和 `_` 之间不成立，会静默漏掉最典型的求和/积分式（分类成纯文本，不报错）。
_LATEX_COMMAND_RE = re.compile(
    r"\\(?:frac|sqrt|sum|prod|int|oint|lim|infty|partial|nabla|cdot|times|div|pm|mp"
    r"|leq|geq|neq|approx|equiv|propto|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma"
    r"|omega|Delta|Omega|Sigma|hbar|vec|hat|bar|dot|ddot|left|right|begin|end|text|mathrm)"
    r"(?![A-Za-z])"
)
# `$...$` / `$$...$$` / `\( ... \)` / `\[ ... \]` 这四种行内或行间公式定界符。
_LATEX_DELIMITED_RE = re.compile(r"\$\$?[^$]+\$\$?|\\\([^)]*\\\)|\\\[[^\]]*\\\]", re.DOTALL)

# 数学与物理里常见的 Unicode 符号：运算与关系、希腊字母、上下标数字、
# 常用单位与量纲记号。
_MATH_SYMBOLS = frozenset(
    "∫∮∬∭∑∏√∛∜∞∂∇≈≠≡≤≥≪≫±∓×÷⋅∝∈∉⊂⊃⊆⊇∪∩∅∀∃∴∵⇒⇔→←↔↦⊥∠°′″"
    "αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"
    "ℏℓℝℂℕℤℚ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎"
)
# 密度门槛 = 符号数 ÷ 非空白字符数；0.08 由真实样本试出：`E = mc²` 密度 0.17，
# 整段中文说明里夹两个 ° 远低于此。
_FORMULA_SYMBOL_DENSITY = 0.08
# 取 1 而非 2：`E = mc²` 只有一个数学符号（²）。真正防误判的是下面"还得像个式子"
# （等号/箭头/大运算符）的条件。
_FORMULA_MIN_SYMBOLS = 1
# 太长的整段文字即使符号不少也更可能是"讲公式的文章"而不是公式本身。
_FORMULA_MAX_LEN = 500


def _looks_like_formula(text: str) -> bool:
    if len(text) > _FORMULA_MAX_LEN:
        return False
    if _LATEX_COMMAND_RE.search(text) or _LATEX_DELIMITED_RE.search(text):
        return True
    symbols = sum(1 for ch in text if ch in _MATH_SYMBOLS)
    if symbols < _FORMULA_MIN_SYMBOLS:
        return False
    dense = len([ch for ch in text if not ch.isspace()])
    if dense == 0:
        return False
    if symbols / dense < _FORMULA_SYMBOL_DENSITY:
        return False
    # 到这里符号够密了，但还要有点"式子"的样子：等号/不等号/箭头，或者
    # 积分求和这类明确的运算符。否则「αβγ 三个希腊字母」也会被判成公式。
    return any(ch in text for ch in "=≈≠≡≤≥→⇒⇔∝∫∑∏√∂∇")


def classify(text: str) -> str:
    """Returns one of: url / email / phone / formula / code / name / text."""
    stripped = text.strip()
    if not stripped:
        return "text"
    if _URL_RE.match(stripped):
        return "url"
    if _EMAIL_RE.match(stripped):
        return "email"
    if _looks_like_phone(stripped):
        return "phone"
    # 必须排在 code 前面：LaTeX 的大括号和反斜杠会被 _looks_like_code 的括号密度启发式当成代码；
    # 反过来真代码几乎不会命中数学符号密度或 LaTeX 命令。
    if _looks_like_formula(stripped):
        return "formula"
    if _looks_like_code(text):
        return "code"
    if _looks_like_name(stripped):
        return "name"
    return "text"
