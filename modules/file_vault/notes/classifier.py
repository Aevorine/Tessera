"""Rule-based auto-classification for imported notes: scores each candidate category (name, optional keyword synonyms)
by whether it appears in the title/content, picks the highest, and returns None (uncategorized) rather than guess when nothing matches.
Offline, no AI or dependency. Candidates come from notes/service.py's create_note_from_file (categories table plus categories in use),
so any category the user creates later becomes a target with no code change."""

from typing import Optional, TypedDict


class Candidate(TypedDict, total=False):
    name: str
    keywords: list[str]


# Enough to catch a document's topic without scanning a huge note. Callers slice to this before classify()
# (see notes/service.py _CLASSIFY_EXCERPT_CHARS); enforced here so an oversized input can't change behavior.
CLASSIFY_EXCERPT_CHARS = 20_000

# A title hit outweighs a content hit (a file named "旅行计划.txt" is a stronger signal than one "旅行" in the body);
# a bare keyword hit counts less than the category name, since keywords are looser user-typed synonyms.
_TITLE_NAME_SCORE = 3
_CONTENT_NAME_SCORE = 1
_TITLE_KEYWORD_SCORE = 2
_CONTENT_KEYWORD_SCORE = 1

# 递归分类下候选名是整条路径（`工作/项目A`），整串匹配永远 0 分（没人把文件命名成「工作/项目A周报.txt」），
# 多级分类一建自动分类就失效，故按 `/` 拆段打分：叶子段（`项目A`）满分，它最具体、最能区分兄弟分类；
# 父段（`工作`）乘 0.25，对同级所有兄弟一视同仁，权重高会压过叶子精确命中而塞错分类
# （叶子命中标题 3 分，父段仅 0.75，两个父段也才 1.5，仍压不过一次叶子命中）。
_ANCESTOR_SCORE_FACTOR = 0.25


def split_keywords(raw: str) -> list[str]:
    """Turns a user-typed comma-separated keyword string into a clean list without blanks; shared by service.py and backend_server.py."""
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def classify(title: str, content: str, candidates: list[Candidate]) -> Optional[str]:
    """Returns the best-matching candidate's name, or None if all scored 0 (note stays uncategorized).
    `content` should already be excerpt-sized (CLASSIFY_EXCERPT_CHARS); it is still defensively sliced.
    Ties keep the first-scored candidate (expects a stable order, e.g. alphabetical from notes/storage.py::list_categories), so results are deterministic."""
    if not candidates:
        return None
    title_l = title.lower()
    content_l = content[:CLASSIFY_EXCERPT_CHARS].lower()

    best_name: Optional[str] = None
    best_score = 0.0
    for candidate in candidates:
        name = (candidate.get("name") or "").strip()
        if not name:
            continue
        score = _score_candidate(name, candidate.get("keywords") or [], title_l, content_l)
        if score > best_score:
            best_score = score
            best_name = name
    return best_name


def _score_candidate(name: str, raw_keywords: list[str], title_l: str, content_l: str) -> float:
    """给候选分类打分：分类名按 `/` 拆段分别计分，关键词整体计一次。关键词是用户为整个分类填的同义词，不带层级语义，不拆段。"""
    segments = [segment.strip().lower() for segment in name.split("/") if segment.strip()]
    if not segments:
        return 0.0

    score = 0.0
    # 最后一段是叶子（满权重），前面的都是祖先（打折）
    for index, segment in enumerate(segments):
        factor = 1.0 if index == len(segments) - 1 else _ANCESTOR_SCORE_FACTOR
        if segment in title_l:
            score += _TITLE_NAME_SCORE * factor
        if segment in content_l:
            score += _CONTENT_NAME_SCORE * factor

    keywords = [kw.lower() for kw in raw_keywords if kw]
    if any(kw in title_l for kw in keywords):
        score += _TITLE_KEYWORD_SCORE
    if any(kw in content_l for kw in keywords):
        score += _CONTENT_KEYWORD_SCORE
    return score
