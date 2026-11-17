"""Condition evaluator, checked against the table the Godot client also reads (PLAN 5.5, 11)."""

from __future__ import annotations

import warnings

import pytest

from app.llm.conditions import evaluate


def test_all_shared_cases(condition_cases) -> None:
    failures = []
    for entry in condition_cases:
        got = evaluate(entry["condition"], entry["state"])
        if got != entry["expected"]:
            failures.append(f"{entry['label']}: expected {entry['expected']}, got {got}")
    assert not failures, "\n".join(failures)


def test_unknown_verb_warns_and_is_false() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert evaluate({"telepathy": "x"}, {}) is False
    assert any("unknown condition" in str(w.message) for w in caught)


def test_non_object_condition_is_false() -> None:
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        assert evaluate("flag", {}) is False


def test_quest_verbs_fail_closed_without_state() -> None:
    """P3 verbs are implemented, but an empty state must never unlock quest-gated content."""
    assert evaluate({"quest_state": "ch01", "node": "n2"}, {}) is False
    assert evaluate({"quest_state": "ch01"}, {}) is False
    assert evaluate({"quest_done": "ch01"}, {}) is False


def test_time_of_day_defaults_to_day() -> None:
    assert evaluate({"time_of_day": "day"}, {}) is True
    assert evaluate({"time_of_day": "night"}, {}) is False
