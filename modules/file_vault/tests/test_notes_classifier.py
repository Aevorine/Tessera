import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault.notes import classifier


def test_classify_matches_category_name_in_title():
    result = classifier.classify(
        title="旅行计划",
        content="随便写点什么",
        candidates=[{"name": "工作", "keywords": []}, {"name": "旅行", "keywords": []}],
    )
    assert result == "旅行"


def test_classify_matches_category_name_in_content_when_title_does_not_match():
    result = classifier.classify(
        title="untitled",
        content="这次去日本旅行拍了很多照片",
        candidates=[{"name": "旅行", "keywords": []}],
    )
    assert result == "旅行"


def test_classify_prefers_title_match_over_content_only_match():
    result = classifier.classify(
        title="工作汇报",
        content="这篇其实是关于旅行的游记",
        candidates=[{"name": "工作", "keywords": []}, {"name": "旅行", "keywords": []}],
    )
    assert result == "工作"


def test_classify_matches_via_keyword_when_name_itself_is_absent():
    result = classifier.classify(
        title="q3_expenses.txt",
        content="附上本季度的发票和报销单据",
        candidates=[{"name": "财务", "keywords": ["发票", "报销"]}],
    )
    assert result == "财务"


def test_classify_returns_none_when_nothing_matches():
    result = classifier.classify(
        title="untitled",
        content="今天天气不错",
        candidates=[{"name": "工作", "keywords": ["会议", "项目"]}, {"name": "旅行", "keywords": []}],
    )
    assert result is None


def test_classify_returns_none_for_empty_candidates():
    assert classifier.classify(title="旅行日记", content="去了日本", candidates=[]) is None


def test_classify_is_case_insensitive_for_latin_text():
    result = classifier.classify(
        title="Travel Diary",
        content="had a great time",
        candidates=[{"name": "travel", "keywords": []}],
    )
    assert result == "travel"


def test_classify_ignores_candidates_with_blank_name():
    result = classifier.classify(
        title="旅行计划",
        content="",
        candidates=[{"name": "  ", "keywords": []}, {"name": "旅行", "keywords": []}],
    )
    assert result == "旅行"


def test_classify_deterministic_tie_break_prefers_earlier_candidate():
    # Both "工作" and "生活" appear nowhere - both score 0 from name/keyword
    # matches except a shared keyword that hits both equally.
    result = classifier.classify(
        title="daily.txt",
        content="今天记录一些日常",
        candidates=[
            {"name": "工作", "keywords": ["日常"]},
            {"name": "生活", "keywords": ["日常"]},
        ],
    )
    assert result == "工作"


def test_classify_only_scans_a_bounded_content_excerpt():
    padding = "x" * classifier.CLASSIFY_EXCERPT_CHARS
    content = padding + "旅行"  # the match sits just past the excerpt cutoff
    result = classifier.classify(
        title="untitled",
        content=content,
        candidates=[{"name": "旅行", "keywords": []}],
    )
    assert result is None


def test_split_keywords_splits_trims_and_drops_blanks():
    assert classifier.split_keywords("发票, 报销 ,, invoice ") == ["发票", "报销", "invoice"]


def test_split_keywords_handles_empty_string():
    assert classifier.split_keywords("") == []
