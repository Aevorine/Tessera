import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.clipboard import classifier


def test_classifies_known_types_unchanged():
    assert classifier.classify("https://example.com") == "url"
    assert classifier.classify("a@b.com") == "email"
    assert classifier.classify("+86 138 0013 8000") == "phone"
    assert classifier.classify("def foo():\n    return 1") == "code"
    assert classifier.classify("just a normal sentence.") == "text"
    assert classifier.classify("") == "text"


def test_classifies_chinese_names():
    assert classifier.classify("张伟") == "name"
    assert classifier.classify("欧阳锋") == "name"  # compound surname
    assert classifier.classify("你好") == "text"  # not a surname
    assert classifier.classify("北京市") == "text"  # not a surname


def test_classifies_korean_names():
    assert classifier.classify("김민준") == "name"
    assert classifier.classify("안녕하세요") == "text"  # not a surname


def test_classifies_western_names():
    assert classifier.classify("John Smith") == "name"
    assert classifier.classify("J. K. Rowling") == "name"
    assert classifier.classify("Vincent van Gogh") == "name"  # lowercase particle
    assert classifier.classify("Charles de Gaulle") == "name"
    assert classifier.classify("Anne-Marie Dubois") == "name"  # hyphenated
    assert classifier.classify("O'Brien Family") == "name"  # apostrophe
    assert classifier.classify("Иван Петров") == "name"  # Cyrillic


def test_does_not_misclassify_multiword_sentences_as_names():
    assert classifier.classify("hello world") == "text"  # not capitalized
    assert classifier.classify("This is not a name at all.") == "text"  # too many words + punctuation


# 公式（数学 / 物理）：从 Word、LaTeX、维基、PDF 复制的公式落到剪贴板常是满是数学符号的纯文本，
# 归进"纯文本"就再也筛不出来。


def test_classifies_latex_as_formula():
    assert classifier.classify(r"\frac{a}{b}") == "formula"
    assert classifier.classify(r"$E = mc^2$") == "formula"
    assert classifier.classify(r"$$\int_0^\infty e^{-x^2}\,dx$$") == "formula"
    assert classifier.classify(r"\begin{equation} F = ma \end{equation}") == "formula"
    assert classifier.classify(r"\(a^2 + b^2 = c^2\)") == "formula"


def test_classifies_unicode_math_and_physics_as_formula():
    assert classifier.classify("E = mc²") == "formula"
    assert classifier.classify("a² + b² = c²") == "formula"
    assert classifier.classify("λ = h/p") == "formula"
    assert classifier.classify("ΔG = ΔH - TΔS") == "formula"
    assert classifier.classify("∫₀^∞ e^(-x²) dx = √π/2") == "formula"
    assert classifier.classify("∇ × B = μ₀J + μ₀ε₀ ∂E/∂t") == "formula"
    assert classifier.classify("∑ᵢ₌₁ⁿ i = n(n+1)/2") == "formula"


def test_prose_that_merely_contains_a_symbol_is_not_a_formula():
    """光有符号不算数（句子里偶尔有 ° 或 ± 很常见），真正挡住误判的是还得有式子的样子
    （等号/箭头/大运算符）；下面几句符号密度不低，但没有任何关系运算符。"""
    assert classifier.classify("今天 25°C，比昨天高 ±2 度，出门记得带伞") == "text"
    assert classifier.classify("这个角度是 90°，转过去就行了") == "text"
    assert classifier.classify("The temperature rose by ±2 degrees today, which is unusual") == "text"
    assert classifier.classify("αβγ") == "text"  # 光是希腊字母，不是式子


def test_formula_check_runs_before_code_check():
    """顺序不能反。LaTeX 里有反斜杠和大括号，_looks_like_code 的括号密度启发式
    很容易把 `\frac{a}{b}` 当成代码；而真代码几乎不可能命中数学符号密度。"""
    assert classifier.classify(r"\sum_{i=1}^{n} x_i") == "formula"
    # 反方向：真代码仍然是代码，没被公式判据抢走
    assert classifier.classify("def foo():\n    return 1") == "code"
    assert classifier.classify("const x = require('y')") == "code"


def test_long_prose_about_formulas_is_not_itself_a_formula():
    """一整段讲公式的文章不是公式本身——超过长度上限直接排除。"""
    essay = (
        "爱因斯坦的质能方程 E = mc² 说明质量和能量是可以相互转换的，"
        "其中 c 是真空中的光速。这个关系式在核物理里有非常广泛的应用，"
        "比如核裂变和核聚变释放的能量都可以由它估算出来。"
    ) * 8
    assert len(essay) > 500
    assert classifier.classify(essay) == "text"
