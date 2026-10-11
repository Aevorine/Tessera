import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from modules.file_vault import ai_skills


def test_load_skills_returns_empty_list_before_any_save(tmp_path):
    assert ai_skills.load_skills(tmp_path) == []


def test_add_skill_persists_across_load(tmp_path):
    skill = ai_skills.add_skill(tmp_path, "Translator", "You are a translator.")
    loaded = ai_skills.load_skills(tmp_path)
    assert len(loaded) == 1
    assert loaded[0].id == skill.id
    assert loaded[0].name == "Translator"
    assert loaded[0].content == "You are a translator."


def test_add_skill_generates_unique_ids(tmp_path):
    a = ai_skills.add_skill(tmp_path, "A", "content a")
    b = ai_skills.add_skill(tmp_path, "B", "content b")
    assert a.id != b.id
    assert {s.id for s in ai_skills.load_skills(tmp_path)} == {a.id, b.id}


def test_delete_skill_removes_only_the_matching_one(tmp_path):
    a = ai_skills.add_skill(tmp_path, "A", "content a")
    b = ai_skills.add_skill(tmp_path, "B", "content b")
    ai_skills.delete_skill(tmp_path, a.id)
    remaining = ai_skills.load_skills(tmp_path)
    assert [s.id for s in remaining] == [b.id]


def test_delete_skill_missing_id_is_a_no_op(tmp_path):
    ai_skills.add_skill(tmp_path, "A", "content a")
    ai_skills.delete_skill(tmp_path, "does-not-exist")
    assert len(ai_skills.load_skills(tmp_path)) == 1


def test_load_skills_tolerates_corrupt_file(tmp_path):
    ai_skills.skills_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    ai_skills.skills_path(tmp_path).write_text("not valid json{{{", encoding="utf-8")
    assert ai_skills.load_skills(tmp_path) == []


def test_add_skill_defaults_description_to_empty_string(tmp_path):
    skill = ai_skills.add_skill(tmp_path, "A", "content a")
    assert skill.description == ""
    assert ai_skills.load_skills(tmp_path)[0].description == ""


def test_add_skill_persists_description(tmp_path):
    ai_skills.add_skill(tmp_path, "A", "content a", description="does translation")
    assert ai_skills.load_skills(tmp_path)[0].description == "does translation"


def test_delete_skills_removes_multiple_at_once(tmp_path):
    a = ai_skills.add_skill(tmp_path, "A", "content a")
    b = ai_skills.add_skill(tmp_path, "B", "content b")
    c = ai_skills.add_skill(tmp_path, "C", "content c")
    ai_skills.delete_skills(tmp_path, [a.id, c.id])
    remaining = ai_skills.load_skills(tmp_path)
    assert [s.id for s in remaining] == [b.id]


def test_delete_skills_ignores_unknown_ids(tmp_path):
    a = ai_skills.add_skill(tmp_path, "A", "content a")
    ai_skills.delete_skills(tmp_path, [a.id, "does-not-exist"])
    assert ai_skills.load_skills(tmp_path) == []


def test_parse_skill_markdown_with_no_frontmatter_returns_raw_text_as_content():
    name, description, content = ai_skills.parse_skill_markdown("You are a translator.")
    assert name == ""
    assert description == ""
    assert content == "You are a translator."


def test_parse_skill_markdown_reads_name_and_scalar_description():
    raw = (
        "---\n"
        "name: translator\n"
        "description: Translates text between languages.\n"
        "---\n"
        "You are a translator persona.\n"
    )
    name, description, content = ai_skills.parse_skill_markdown(raw)
    assert name == "translator"
    assert description == "Translates text between languages."
    assert content == "You are a translator persona."


def test_parse_skill_markdown_reads_block_scalar_description():
    raw = (
        "---\n"
        "name: humanizer\n"
        "description: |\n"
        "  Removes AI writing tells.\n"
        "  Works on any language.\n"
        "---\n"
        "Body content here.\n"
    )
    name, description, content = ai_skills.parse_skill_markdown(raw)
    assert name == "humanizer"
    assert description == "Removes AI writing tells.\nWorks on any language."
    assert content == "Body content here."
