"""Content validator (PLAN 9.2, 11) — schema and referential rules over synthetic packs."""

from __future__ import annotations

from pathlib import Path

from app.content import ContentStore
from app.content_validate import validate_store

LOCAL = {"zh_HK": "x", "zh_CN": "x", "en": "x"}


def store(**tables) -> ContentStore:
    return ContentStore(content_dir=Path("/unused"), tables=tables)


def npc(npc_id: str = "npc_a", **over) -> dict:
    base = {
        "schema_version": 1,
        "id": npc_id,
        "display_name": dict(LOCAL),
        "persona": {"role": "r"},
        "llm": {"actions_allowed": [], "items_may_give": [], "flags_may_set": []},
        "secrets": [],
        "scripted_fallback": {"greeting": dict(LOCAL), "lines": [], "exit": dict(LOCAL)},
        "trigger": {"location": None, "requires": None},
    }
    base.update(over)
    return base


def item(item_id: str = "item_a", **over) -> dict:
    base = {
        "schema_version": 1,
        "id": item_id,
        "name": dict(LOCAL),
        "desc": dict(LOCAL),
        "stack_max": 1,
        "category": "keepsake",
        "usable": False,
        "on_use": [],
        "on_acquire": [],
    }
    base.update(over)
    return base


def errors(issues: list[dict]) -> list[str]:
    return [f"{i['path']}: {i['message']}" for i in issues if i["level"] == "error"]


def test_clean_pack_passes() -> None:
    issues = validate_store(store(npcs={"npc_a": npc()}, items={"item_a": item()}))
    assert errors(issues) == []


def test_missing_locale_is_an_error() -> None:
    broken = npc()
    broken["display_name"] = {"zh_HK": "x", "en": "x"}
    issues = validate_store(store(npcs={"npc_a": broken}))
    assert any("display_name" in e and "missing" in e for e in errors(issues))


def test_todo_declared_gap_is_not_an_error() -> None:
    thin = npc()
    thin["display_name"] = {"zh_HK": "x", "en": "x", "_todo": ["zh_CN"]}
    assert errors(validate_store(store(npcs={"npc_a": thin}))) == []


def test_unknown_item_reference_is_an_error() -> None:
    broken = npc(llm={"actions_allowed": ["give"], "items_may_give": ["item_nope"],
                      "flags_may_set": []})
    issues = validate_store(store(npcs={"npc_a": broken}))
    assert any("item_nope" in e for e in errors(issues))


def test_unknown_effect_type_is_an_error() -> None:
    broken = item(on_use=[{"type": "explode"}])
    issues = validate_store(store(items={"item_a": broken}))
    assert any("explode" in e for e in errors(issues))


def test_unknown_condition_verb_is_an_error() -> None:
    broken = npc(secrets=[{"id": "s", "text": "t", "reveal_if": {"flying": 1}}])
    issues = validate_store(store(npcs={"npc_a": broken}))
    assert any("flying" in e for e in errors(issues))


def test_unreachable_quest_node_is_an_error() -> None:
    broken = {
        "schema_version": 1,
        "id": "q",
        "title": dict(LOCAL),
        "nodes": [
            {"id": "n1", "type": "objective", "complete_when": {"flag": "f"}, "next": None},
            {"id": "nX", "type": "objective", "next": None},
        ],
    }
    issues = validate_store(store(quests={"q": broken}))
    assert any("unreachable" in e and "nX" in e for e in errors(issues))


def test_unknown_exit_target_is_an_error() -> None:
    broken = {
        "schema_version": 1,
        "id": "loc",
        "display_name": dict(LOCAL),
        "exits": [{"id": "e", "rect": [0, 0, 1, 1], "to": "loc_nope", "spawn": "default"}],
    }
    issues = validate_store(store(locations={"loc": broken}))
    assert any("loc_nope" in e for e in errors(issues))


def test_flag_read_but_never_set_is_a_warning() -> None:
    reader = npc(secrets=[{"id": "s", "text": "t", "reveal_if": {"flag": "never_set"}}])
    issues = validate_store(store(npcs={"npc_a": reader}))
    assert errors(issues) == []  # warn level only
    assert any(i["level"] == "warn" and "never_set" in i["message"] for i in issues)