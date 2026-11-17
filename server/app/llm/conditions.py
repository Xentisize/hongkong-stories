"""Condition mini-language, Python twin of client/autoload/conditions.gd (PLAN 5.5).

Two evaluators exist because two runtimes need it: GDScript gates doors and quests, Python
filters which NPC secrets may be revealed. They must agree, so both are checked against the
same fixture table (client/content/tests/conditions_fixtures.json) by `pytest` and by the
Godot `--selftest` harness.
"""

from __future__ import annotations

import warnings
from typing import Any

State = dict[str, Any]


def _state_bucket(state: State, key: str) -> dict:
    value = state.get(key, {})
    return value if isinstance(value, dict) else {}


def evaluate(condition: Any, state: State) -> bool:
    if condition is None:
        return True
    if not isinstance(condition, dict):
        warnings.warn(f"condition is not an object: {condition!r}", stacklevel=2)
        return False
    if not condition:
        return True

    if "all" in condition:
        return all(evaluate(sub, state) for sub in condition["all"])

    if "any" in condition:
        return any(evaluate(sub, state) for sub in condition["any"])

    if "not" in condition:
        return not evaluate(condition["not"], state)

    if "flag" in condition:
        flags = _state_bucket(state, "flags")
        expected = bool(condition.get("value", True))
        return bool(flags.get(str(condition["flag"]), False)) == expected

    if "has_item" in condition:
        inventory = _state_bucket(state, "inventory")
        return int(inventory.get(str(condition["has_item"]), 0)) >= int(condition.get("count", 1))

    if "var" in condition:
        variables = _state_bucket(state, "vars")
        return _compare(
            float(variables.get(str(condition["var"]), 0.0)),
            str(condition.get("op", ">=")),
            float(condition.get("value", 0.0)),
        )

    if "visited" in condition:
        return bool(_state_bucket(state, "visited").get(str(condition["visited"]), False))

    if "talked" in condition:
        counts = _state_bucket(state, "talk_counts")
        return int(counts.get(str(condition["talked"]), 0)) >= int(condition.get("min", 1))

    if {"quest_state", "quest_done", "time_of_day"} & set(condition):
        warnings.warn(f"condition verb not implemented until P3: {condition!r}", stacklevel=2)
        return False

    warnings.warn(f"unknown condition: {condition!r}", stacklevel=2)
    return False


def _compare(left: float, op: str, right: float) -> bool:
    if op == "==":
        return left == right
    if op == "!=":
        return left != right
    if op == ">":
        return left > right
    if op == ">=":
        return left >= right
    if op == "<":
        return left < right
    if op == "<=":
        return left <= right
    warnings.warn(f"unknown comparison {op!r}", stacklevel=2)
    return False
