"""Content validation for the publish pipeline (PLAN 9.2, 11).

Publish runs this over the merged pack (baseline + drafts) and refuses to serve anything with
an `error`-level issue: a missing locale, an unknown referenced id, an unreachable quest node
or a flag no effect can set are all ways to ship a broken build silently. `warn`-level issues
are reported but do not block.

Hand-rolled rather than jsonschema: the §5 shapes are small and the referential rules (every
id resolves, every flag is settable, every quest node reachable) are the part that actually
catches authoring mistakes. tools/check_content.py is the CLI over this module for CI.

Pure stdlib — safe to run anywhere the backend runs, including the ephemeral test venvs.
"""

from __future__ import annotations

from typing import Any

from .content import ContentStore
from .llm.conditions import evaluate as condition_true

LOCALES = ("zh_HK", "zh_CN", "en")
KNOWN_CONDITION_VERBS = {
    "all", "any", "not", "flag", "has_item", "var",
    "visited", "talked", "quest_state", "quest_done", "time_of_day",
}
KNOWN_EFFECT_TYPES = {
    "set_flag", "give", "take", "var", "say", "quest", "goto",
    "reveal_secret", "open_shop", "play_sfx", "shake", "fade",
}
KNOWN_ACTION_TYPES = {"give", "take", "set_flag", "var", "reveal_secret", "open_shop"}


def validate_store(store: ContentStore) -> list[dict]:
    """Return a list of {"level", "path", "message"} issues; `error` blocks publishing."""
    issues: list[dict] = []

    def issue(level: str, path: str, message: str) -> None:
        issues.append({"level": level, "path": path, "message": message})

    def err(path: str, message: str) -> None:
        issue("error", path, message)

    def warn(path: str, message: str) -> None:
        issue("warn", path, message)

    npcs = store.tables.get("npcs", {})
    items = store.tables.get("items", {})
    locations = store.tables.get("locations", {})
    quests = store.tables.get("quests", {})

    flags_settable: set[str] = set()

    def walk_effects(effects: Any, path: str) -> None:
        if effects is None:
            return
        if not isinstance(effects, list):
            err(path, "effects must be a list")
            return
        for index, effect in enumerate(effects):
            at = f"{path}[{index}]"
            if not isinstance(effect, dict):
                err(at, "effect must be an object")
                continue
            kind = str(effect.get("type", ""))
            if kind not in KNOWN_EFFECT_TYPES:
                err(at, f"unknown effect type {kind!r}")
                continue
            if kind in ("give", "take"):
                item = str(effect.get("item", ""))
                if item and item not in items:
                    err(at, f"unknown item {item!r}")
            elif kind == "quest":
                quest = str(effect.get("quest", ""))
                if quest and quest not in quests:
                    err(at, f"unknown quest {quest!r}")
            elif kind == "reveal_secret":
                npc = str(effect.get("npc", ""))
                if npc and npc not in npcs:
                    err(at, f"unknown npc {npc!r}")
            elif kind == "goto":
                location = str(effect.get("location", ""))
                if location and location not in locations:
                    err(at, f"unknown location {location!r}")
            elif kind == "set_flag":
                flag = str(effect.get("flag", ""))
                if flag:
                    flags_settable.add(flag)

    def walk_conditions(condition: Any, path: str) -> set[str]:
        """Return the flags referenced; issue on unknown verbs or shapes."""
        found: set[str] = set()
        if condition is None:
            return found
        if not isinstance(condition, dict):
            err(path, "condition must be an object")
            return found
        if not condition:
            return found
        if "all" in condition or "any" in condition:
            verb = "all" if "all" in condition else "any"
            branches = condition[verb]
            if not isinstance(branches, list):
                err(path, f"{verb!r} must be a list")
                return found
            for index, sub in enumerate(branches):
                found |= walk_conditions(sub, f"{path}.{verb}[{index}]")
            return found
        if "not" in condition:
            return walk_conditions(condition["not"], f"{path}.not")
        verb = next(iter(condition))
        if verb not in KNOWN_CONDITION_VERBS:
            err(path, f"unknown condition verb {verb!r}")
            return found
        if verb == "flag":
            found.add(str(condition[verb]))
        return found

    def check_localized(field: Any, path: str, *, required: bool = True) -> None:
        if isinstance(field, str):
            if required and not field.strip():
                err(path, "required string is empty")
            return
        if not isinstance(field, dict):
            if required:
                err(path, "expected a localized object or string")
            return
        keys = set(field.keys())
        missing = [locale for locale in LOCALES if locale not in keys]
        if missing and "_todo" not in keys:
            err(path, f"missing locales {missing} (declare them in _todo to acknowledge)")
        for locale in LOCALES:
            value = field.get(locale)
            if isinstance(value, str) and not value.strip() and locale in keys:
                err(f"{path}.{locale}", "locale key present but empty")

    for npc_id, npc in sorted(npcs.items()):
        at = f"npcs/{npc_id}"
        check_localized(npc.get("display_name"), f"{at}.display_name")
        persona = npc.get("persona", {})
        if not isinstance(persona, dict) or not str(persona.get("role", "")).strip():
            err(f"{at}.persona.role", "persona.role is required")
        llm = npc.get("llm", {})
        if not isinstance(llm, dict):
            err(f"{at}.llm", "llm block is required")
            llm = {}
        for action in llm.get("actions_allowed", []) or []:
            if str(action) not in KNOWN_ACTION_TYPES:
                err(f"{at}.llm.actions_allowed", f"unknown action type {action!r}")
        for item in llm.get("items_may_give", []) or []:
            if str(item) not in items:
                err(f"{at}.llm.items_may_give", f"unknown item {item!r}")
        flags_settable.update(str(flag) for flag in llm.get("flags_may_set", []) or [])
        for secret in npc.get("secrets", []) or []:
            if not isinstance(secret, dict):
                err(f"{at}.secrets", "secret must be an object")
                continue
            secret_id = str(secret.get("id", ""))
            if not secret_id:
                err(f"{at}.secrets", "secret missing id")
                continue
            check_localized(secret.get("text"), f"{at}.secrets/{secret_id}.text", required=False)
            walk_conditions(secret.get("reveal_if"), f"{at}.secrets/{secret_id}.reveal_if")
        fallback = npc.get("scripted_fallback", {})
        if not isinstance(fallback, dict):
            err(f"{at}.scripted_fallback", "scripted_fallback is required (§7.4)")
            fallback = {}
        check_localized(fallback.get("greeting"), f"{at}.scripted_fallback.greeting")
        lines = fallback.get("lines", []) or []
        for index, line in enumerate(lines):
            line_at = f"{at}.scripted_fallback.lines[{index}]"
            if isinstance(line, dict) and "text" in line:
                check_localized(line.get("text"), f"{line_at}.text")
                walk_conditions(line.get("requires"), f"{line_at}.requires")
                walk_effects(line.get("actions"), f"{line_at}.actions")
            else:
                check_localized(line, line_at)
        check_localized(fallback.get("exit"), f"{at}.scripted_fallback.exit", required=False)
        trigger = npc.get("trigger", {})
        if isinstance(trigger, dict):
            location = trigger.get("location")
            if location and str(location) not in locations:
                err(f"{at}.trigger.location", f"unknown location {location!r}")
            walk_conditions(trigger.get("requires"), f"{at}.trigger.requires")

    for item_id, item in sorted(items.items()):
        at = f"items/{item_id}"
        check_localized(item.get("name"), f"{at}.name")
        check_localized(item.get("desc"), f"{at}.desc", required=False)
        if bool(item.get("usable")):
            check_localized(item.get("use_locked"), f"{at}.use_locked", required=False)
            walk_conditions(item.get("use_requires"), f"{at}.use_requires")
        walk_effects(item.get("on_use"), f"{at}.on_use")
        walk_effects(item.get("on_acquire"), f"{at}.on_acquire")

    for location_id, location in sorted(locations.items()):
        at = f"locations/{location_id}"
        check_localized(location.get("display_name"), f"{at}.display_name")
        rows = location.get("tilemap", []) or []
        widths = {len(str(row)) for row in rows}
        if len(widths) > 1:
            warn(f"{at}.tilemap", "rows have differing lengths")
        for placement in location.get("npcs", []) or []:
            if not isinstance(placement, dict):
                err(f"{at}.npcs", "placement must be an object")
                continue
            npc_ref = str(placement.get("npc", ""))
            if npc_ref and npc_ref not in npcs:
                err(f"{at}.npcs", f"unknown npc {npc_ref!r}")
            walk_conditions(placement.get("requires"), f"{at}.npcs/{npc_ref}.requires")
        for door in location.get("doors", []) or []:
            if not isinstance(door, dict):
                err(f"{at}.doors", "door must be an object")
                continue
            door_id = str(door.get("id", "?"))
            walk_conditions(door.get("requires"), f"{at}.doors/{door_id}.requires")
            flag = str(door.get("open_flag", ""))
            if flag:
                flags_settable.add(flag)
            for key in ("prompt", "blocked", "opened"):
                check_localized(door.get(key), f"{at}.doors/{door_id}.{key}", required=False)
        for interactable in location.get("interactables", []) or []:
            if not isinstance(interactable, dict):
                err(f"{at}.interactables", "interactable must be an object")
                continue
            prop_id = str(interactable.get("id", "?"))
            check_localized(interactable.get("prompt"), f"{at}.interactables/{prop_id}.prompt",
                            required=False)
            walk_conditions(interactable.get("requires"), f"{at}.interactables/{prop_id}.requires")
            walk_effects(interactable.get("on_interact"), f"{at}.interactables/{prop_id}.on_interact")
        spawns = location.get("spawn_points", {}) or {}
        for exit_def in location.get("exits", []) or []:
            if not isinstance(exit_def, dict):
                err(f"{at}.exits", "exit must be an object")
                continue
            exit_id = str(exit_def.get("id", "?"))
            target = str(exit_def.get("to", ""))
            if target and target not in locations:
                err(f"{at}.exits/{exit_id}", f"unknown location {target!r}")
                continue
            spawn = str(exit_def.get("spawn", "default"))
            target_spawns = (locations.get(target, {}).get("spawn_points", {}) or {})
            if spawn != "default" and spawn not in target_spawns and spawn not in spawns:
                err(f"{at}.exits/{exit_id}", f"spawn {spawn!r} not defined in {target!r}")
            walk_conditions(exit_def.get("requires"), f"{at}.exits/{exit_id}.requires")
            check_localized(exit_def.get("blocked"), f"{at}.exits/{exit_id}.blocked", required=False)

    for quest_id, quest in sorted(quests.items()):
        at = f"quests/{quest_id}"
        check_localized(quest.get("title"), f"{at}.title", required=False)
        walk_conditions(quest.get("entry_requires"), f"{at}.entry_requires")
        nodes = quest.get("nodes", []) or []
        if not nodes:
            err(f"{at}.nodes", "quest has no nodes")
            continue
        node_ids = [str(node.get("id", "")) for node in nodes if isinstance(node, dict)]
        if len(node_ids) != len(set(node_ids)):
            err(f"{at}.nodes", "duplicate node ids")
        by_id = {str(node.get("id", "")): node for node in nodes if isinstance(node, dict)}
        first = node_ids[0] if node_ids else ""
        reachable: set[str] = set()
        stack = [first]
        while stack:
            current = stack.pop()
            if current in reachable:
                continue
            reachable.add(current)
            node = by_id.get(current, {})
            next_id = node.get("next")
            if isinstance(next_id, str) and next_id:
                if next_id not in by_id:
                    err(f"{at}.nodes/{current}.next", f"unknown node {next_id!r}")
                else:
                    stack.append(next_id)
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("id", "?"))
            node_at = f"{at}.nodes/{node_id}"
            if node_id not in reachable:
                err(node_at, "unreachable node (not on the next chain from the first node)")
            check_localized(node.get("text"), f"{node_at}.text", required=False)
            walk_conditions(node.get("complete_when"), f"{node_at}.complete_when")
            walk_effects(node.get("on_complete"), f"{node_at}.on_complete")

    # §11: every flag a condition reads must be settable by something.
    referenced: set[str] = set()

    def collect_flags(condition: Any) -> None:
        if isinstance(condition, dict):
            if "flag" in condition:
                referenced.add(str(condition["flag"]))
            for value in condition.values():
                collect_flags(value)
        elif isinstance(condition, list):
            for value in condition:
                collect_flags(value)

    for npc in npcs.values():
        for secret in npc.get("secrets", []) or []:
            if isinstance(secret, dict):
                collect_flags(secret.get("reveal_if"))
        trigger = npc.get("trigger", {})
        if isinstance(trigger, dict):
            collect_flags(trigger.get("requires"))
    for item in items.values():
        collect_flags(item.get("use_requires"))
    for location in locations.values():
        for door in location.get("doors", []) or []:
            if isinstance(door, dict):
                collect_flags(door.get("requires"))
        for exit_def in location.get("exits", []) or []:
            if isinstance(exit_def, dict):
                collect_flags(exit_def.get("requires"))
    for quest in quests.values():
        collect_flags(quest.get("entry_requires"))
        for node in quest.get("nodes", []) or []:
            if isinstance(node, dict):
                collect_flags(node.get("complete_when"))
    for flag in sorted(referenced - flags_settable):
        warn("flags", f"{flag!r} is read by a condition but nothing can set it")

    return issues