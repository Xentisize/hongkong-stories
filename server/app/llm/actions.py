"""Action allowlist enforcement (PLAN 5.1, 7.3).

The model performs; the game decides. Every action an NPC asks for is checked against that
NPC's declared `llm` block before it reaches the client, and rejects are returned to the
client for logging rather than silently dropped — that is how model drift becomes visible
without ever corrupting a save.
"""

from __future__ import annotations

from typing import Any

MAX_ACTIONS_PER_TURN = 2


def validate_actions(
    raw_actions: Any,
    npc: dict,
    state: dict,
) -> tuple[list[dict], list[dict]]:
    """Return (accepted, rejected). Rejected entries carry a machine-readable reason."""
    llm = npc.get("llm", {}) if isinstance(npc.get("llm"), dict) else {}
    allowed_types = set(llm.get("actions_allowed", []))
    may_give = set(llm.get("items_may_give", []))
    may_take = set(llm.get("items_may_take", may_give))
    may_flag = set(llm.get("flags_may_set", []))
    var_bounds = llm.get("vars_may_change", {}) or {}
    inventory = state.get("inventory", {}) if isinstance(state.get("inventory"), dict) else {}
    variables = state.get("vars", {}) if isinstance(state.get("vars"), dict) else {}

    accepted: list[dict] = []
    rejected: list[dict] = []

    if not isinstance(raw_actions, list):
        return accepted, rejected

    for action in raw_actions:
        if len(accepted) >= MAX_ACTIONS_PER_TURN:
            rejected.append({"action": action, "reason": "too_many_actions"})
            continue
        if not isinstance(action, dict):
            rejected.append({"action": action, "reason": "not_an_object"})
            continue

        kind = str(action.get("type", ""))
        if kind not in allowed_types:
            rejected.append({"action": action, "reason": "type_not_allowed"})
            continue

        if kind == "give":
            item = str(action.get("item", ""))
            if item not in may_give:
                rejected.append({"action": action, "reason": "item_not_allowed"})
                continue
            action = {**action, "item": item, "count": _clamp_int(action.get("count", 1), 1, 1)}
        elif kind == "take":
            item = str(action.get("item", ""))
            if item not in may_take:
                rejected.append({"action": action, "reason": "item_not_allowed"})
                continue
            if int(inventory.get(item, 0)) <= 0:
                rejected.append({"action": action, "reason": "not_held"})
                continue
            action = {**action, "item": item, "count": _clamp_int(action.get("count", 1), 1, 1)}
        elif kind == "set_flag":
            flag = str(action.get("flag", ""))
            if flag not in may_flag:
                rejected.append({"action": action, "reason": "flag_not_allowed"})
                continue
            action = {**action, "flag": flag, "value": bool(action.get("value", True))}
        elif kind == "var":
            name = str(action.get("name", ""))
            bounds = var_bounds.get(name)
            if not isinstance(bounds, dict):
                rejected.append({"action": action, "reason": "var_not_allowed"})
                continue
            current = float(variables.get(name, 0.0))
            delta = float(action.get("value", 0.0))
            if not (float(bounds.get("min", -1e9)) <= current + delta <= float(bounds.get("max", 1e9))):
                rejected.append({"action": action, "reason": "var_out_of_bounds"})
                continue
            action = {**action, "name": name, "value": delta}
        elif kind == "reveal_secret":
            secret = str(action.get("secret", ""))
            known = {str(s.get("id")) for s in npc.get("secrets", []) if isinstance(s, dict)}
            if secret not in known:
                rejected.append({"action": action, "reason": "unknown_secret"})
                continue
            action = {**action, "secret": secret}

        accepted.append(action)

    return accepted, rejected


def _clamp_int(value: Any, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = low
    return max(low, min(high, number))
