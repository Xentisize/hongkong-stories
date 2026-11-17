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
        assert evaluate({"quest_state": "ch02"}, {}) is False
    assert any("not implemented" in str(w.message) for w in caught)


def test_non_object_condition_is_false() -> None:
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        assert evaluate("flag", {}) is False


def test_pending_verbs_do_not_leak_true() -> None:
    """A P3 verb must fail closed: a missing evaluator must never unlock content."""
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        for verb in ("quest_done", "time_of_day"):
            assert evaluate({verb: "x"}, {}) is False
