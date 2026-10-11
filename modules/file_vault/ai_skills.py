"""Importable "skill" files for the AI chat screen: a named block of user-authored instructions
sent as the system message when selected. Non-secret plaintext (like ui_settings.py), so it
needn't sit behind the IMK, but kept separate since it is user content, not a display preference.

Uses the SKILL.md format (YAML-ish `name`/`description` frontmatter + markdown body); a plain
.txt/.md without frontmatter is treated as body only.
"""

import json
import re
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import List, Tuple

SKILLS_FILENAME = "ai_skills.json"
SKILL_ENTRY_FILENAME = "SKILL.md"

_FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)


@dataclass
class Skill:
    id: str
    name: str
    content: str
    description: str = ""


def skills_path(data_dir: Path) -> Path:
    return Path(data_dir) / SKILLS_FILENAME


def load_skills(data_dir: Path) -> List[Skill]:
    """A corrupt/missing file just means no skills yet - never blocks the
    chat screen from opening, same fallback stance as ui_settings.py."""
    path = skills_path(data_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    skills = []
    for item in data:
        if isinstance(item, dict) and {"id", "name", "content"} <= item.keys():
            skills.append(Skill(
                id=item["id"],
                name=item["name"],
                content=item["content"],
                description=item.get("description") or "",
            ))
    return skills


def save_skills(data_dir: Path, skills: List[Skill]) -> None:
    path = skills_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    tmp_path.write_text(json.dumps([asdict(s) for s in skills], ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(path)


def add_skill(data_dir: Path, name: str, content: str, description: str = "") -> Skill:
    skills = load_skills(data_dir)
    skill = Skill(id=uuid.uuid4().hex, name=name, content=content, description=description)
    skills.append(skill)
    save_skills(data_dir, skills)
    return skill


def delete_skills(data_dir: Path, skill_ids: List[str]) -> None:
    ids = set(skill_ids)
    skills = load_skills(data_dir)
    save_skills(data_dir, [s for s in skills if s.id not in ids])


def delete_skill(data_dir: Path, skill_id: str) -> None:
    delete_skills(data_dir, [skill_id])


def parse_skill_markdown(raw_text: str) -> Tuple[str, str, str]:
    """Parse a SKILL.md-style document into (name, description, content).

    name/description are "" without frontmatter; content is the body (raw text if no frontmatter).
    Deliberately not a full YAML parser (no PyYAML dependency): reads just the two fields,
    including `description: |` block scalars, and silently ignores anything else.
    """
    match = _FRONTMATTER_RE.match(raw_text)
    if not match:
        return "", "", raw_text

    body = raw_text[match.end():].strip()
    lines = match.group(1).splitlines()
    name = ""
    description = ""
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith("name:"):
            name = stripped[len("name:"):].strip().strip('"').strip("'")
            i += 1
            continue
        if stripped.startswith("description:"):
            value = stripped[len("description:"):].strip()
            if value in ("|", ">", "|-", ">-", "|+", ">+"):
                collected = []
                base_indent = None
                i += 1
                while i < len(lines):
                    block_line = lines[i]
                    if block_line.strip() == "":
                        collected.append("")
                        i += 1
                        continue
                    indent = len(block_line) - len(block_line.lstrip())
                    if base_indent is None:
                        base_indent = indent
                    if indent < base_indent:
                        break
                    collected.append(block_line[base_indent:])
                    i += 1
                description = "\n".join(collected).strip()
                continue
            description = value.strip('"').strip("'")
            i += 1
            continue
        i += 1
    return name, description, body
