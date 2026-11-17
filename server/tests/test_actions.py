"""Action allowlist (PLAN 5.1, 7.3). The model performs; the game decides."""

from __future__ import annotations

from app.llm.actions import MAX_ACTIONS_PER_TURN, validate_actions

STATE = {"inventory": {"item_rusty_key": 2, "item_other": 1}, "vars": {"trust_keeper": 0}}


def test_permitted_give_is_accepted(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "give", "item": "item_rusty_key"}], npc, STATE)
    assert len(accepted) == 1 and not rejected
    assert accepted[0]["item"] == "item_rusty_key"
    # The model may not hand out quantities; give is always exactly one.
    assert accepted[0]["count"] == 1


def test_unlisted_item_is_rejected(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "give", "item": "item_treasure"}], npc, STATE)
    assert not accepted
    assert rejected[0]["reason"] == "item_not_allowed"


def test_unlisted_flag_is_rejected(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "set_flag", "flag": "door_open"}], npc, STATE)
    assert not accepted
    assert rejected[0]["reason"] == "flag_not_allowed"


def test_permitted_flag_is_accepted(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "set_flag", "flag": "keeper_helped_player"}], npc, STATE)
    assert len(accepted) == 1 and not rejected


def test_unlisted_action_type_is_rejected(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "open_shop"}], npc, STATE)
    assert not accepted
    assert rejected[0]["reason"] == "type_not_allowed"


def test_variable_bounds_are_enforced(npc: dict) -> None:
    # trust_keeper is declared -1..2 and currently 0.
    accepted, rejected = validate_actions([{"type": "var", "name": "trust_keeper", "value": 2}], npc, STATE)
    assert len(accepted) == 1 and not rejected

    accepted, rejected = validate_actions([{"type": "var", "name": "trust_keeper", "value": 5}], npc, STATE)
    assert not accepted
    assert rejected[0]["reason"] == "var_out_of_bounds"


def test_undeclared_variable_is_rejected(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "var", "name": "money", "value": 100}], npc, STATE)
    assert not accepted
    assert rejected[0]["reason"] == "var_not_allowed"


def test_take_requires_holding_the_item(npc: dict) -> None:
    empty = {"inventory": {}, "vars": {}}
    accepted, rejected = validate_actions([{"type": "take", "item": "item_rusty_key"}], npc, empty)
    assert not accepted
    assert rejected[0]["reason"] in {"type_not_allowed", "not_held", "item_not_allowed"}


def test_action_count_is_capped(npc: dict) -> None:
    many = [{"type": "set_flag", "flag": "keeper_helped_player"}] * (MAX_ACTIONS_PER_TURN + 2)
    accepted, rejected = validate_actions(many, npc, STATE)
    assert len(accepted) == MAX_ACTIONS_PER_TURN
    assert any(r["reason"] == "too_many_actions" for r in rejected)


def test_garbage_input_is_rejected_without_raising(npc: dict) -> None:
    assert validate_actions(None, npc, STATE) == ([], [])
    accepted, rejected = validate_actions(["not an object", 42], npc, STATE)
    assert not accepted
    assert {r["reason"] for r in rejected} == {"not_an_object"}


def test_unknown_secret_is_rejected(npc: dict) -> None:
    accepted, rejected = validate_actions([{"type": "reveal_secret", "secret": "s_nope"}], npc, STATE)
    assert not accepted
    assert rejected[0]["reason"] == "unknown_secret"

    accepted, _ = validate_actions([{"type": "reveal_secret", "secret": "s_crate"}], npc, STATE)
    assert len(accepted) == 1
