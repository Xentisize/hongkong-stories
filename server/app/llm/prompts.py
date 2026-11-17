"""Prompt assembly with a byte-stable cache prefix (PLAN 7.2, 7.7).

Ordering is the whole cost strategy. The system message contains only text that cannot change
between turns for a given (npc, lang) pair — persona, world rules, lore, output contract,
register — so it hits the provider cache at $0.003/M instead of $0.15/M. History is
append-only and therefore also prefix-stable. Everything volatile (revealed secrets, player
state, the current line) goes into the final user message, where it costs full price but is
tiny.

`stable_prefix()` is asserted byte-identical across differing state by `tests/test_prompts.py`.
If that ever breaks, caching silently stops paying — which is exactly the kind of regression
that never shows up as a bug.
"""

from __future__ import annotations

from typing import Any

from .conditions import evaluate

WORLD_RULES = """You are a character inside a Hong Kong historical drama game. Rules:
1. Stay in character at all times. Never mention being a model, an AI, a prompt, or a game system.
2. Only state facts that appear in the LORE section. If you do not know something, react to it in
   character — deflect, misremember, change the subject, or admit you do not remember. Never invent
   dates, names, deaths, prices or events.
3. Never speak or narrate for the player. Do not describe the player's thoughts or actions.
4. Reply with 1-3 short sentences, as speech only. No narration, no stage directions, no emoji.
5. Never discuss present-day politics, and never take a side in an argument about it. If the player
   pushes, brush it off in character the way your persona would.
6. Keep to your own life: work, family, food, money, neighbours, the street. That is your world.
"""

OUTPUT_CONTRACT = """Output contract: reply with a single JSON object and nothing else.
{"say": <string, your spoken line>, "mood": <one of neutral|warm|gruff|wistful|amused|wary|sad>,
 "actions": [<zero or more state changes>]}
`actions` is usually empty. An action is only valid if it is listed as permitted for you in the
PERMITTED ACTIONS section; requests for anything else must be expressed as speech instead.
Action shapes: {"type":"give","item":<id>} | {"type":"take","item":<id>} |
{"type":"set_flag","flag":<id>,"value":<bool>} | {"type":"var","name":<id>,"value":<number>} |
{"type":"reveal_secret","secret":<id>}"""

REGISTER: dict[str, str] = {
    "zh_HK": """Language: reply in WRITTEN CANTONESE (粵文) using Traditional characters.
Use Cantonese function words and grammar naturally (係 / 唔 / 咗 / 嘅 / 喺 / 哋 / 嗰 / 冇).
Never drift into Mandarin written form. Do not translate your line into English.""",
    "zh_CN": """Language: reply in Simplified Chinese using standard written Chinese (書面語).
Never use Cantonese particles or Cantonese-only characters.""",
    "en": """Language: reply in English, in the same voice and register as your persona.""",
}

DEFAULT_REGISTER = REGISTER["en"]


def active_state(npc: dict, state: dict[str, Any]) -> dict:
    """The NPC's active event page (RPG Maker's conditional pages, adapted in §5.1).

    `states` is an ordered array; the FIRST entry whose `requires` passes wins, and no match
    falls back to the base definition (page 0). The state may patch persona fields, extend
    the lore, and override the offline fallback lines — so a character's knowledge and
    willingness change with what the player has done.
    """
    for entry in npc.get("states", []) or []:
        if isinstance(entry, dict) and evaluate(entry.get("requires"), state):
            return entry
    return {}


def _persona_block(npc: dict, state: dict | None = None) -> str:
    persona = npc.get("persona", {}) if isinstance(npc.get("persona"), dict) else {}
    patch = (state or {}).get("persona_patch", {})
    patch = patch if isinstance(patch, dict) else {}
    name = npc.get("display_name", npc.get("id", "the character"))
    display = name if isinstance(name, str) else (name.get("en") or name.get("zh_HK") or npc.get("id", ""))
    lines = [f"CHARACTER: {display} ({npc.get('id', '')})"]
    for key, label in (
        ("role", "Who you are"),
        ("voice", "How you speak"),
        ("wants", "What you want"),
    ):
        # The active state's patch overrides the base persona field when present — the same
        # character, changed by what the player has done (RPG Maker's event pages).
        value = patch.get(key) if isinstance(patch.get(key), str) and patch[key].strip() else persona.get(key)
        if isinstance(value, str) and value.strip():
            lines.append(f"{label}: {value.strip()}")
    taboos = patch.get("taboos") if isinstance(patch.get("taboos"), list) and patch.get("taboos") else persona.get("taboos")
    if isinstance(taboos, list) and taboos:
        lines.append("Never: " + "; ".join(str(t) for t in taboos))
    return "\n".join(lines)


def _lore_block(npc: dict, state: dict | None = None) -> str:
    extra = (state or {}).get("lore_extra", "")
    extra = extra.strip() if isinstance(extra, str) and extra.strip() else ""
    lore = npc.get("lore")
    if (isinstance(lore, str) and lore.strip()) or extra:
        body = lore.strip() if isinstance(lore, str) else ""
        if extra:
            body = (body + "\n\n" if body else "") + "WHAT CHANGED RECENTLY (now true of your world):\n" + extra
        return "LORE (your world — the only source of facts you may state):\n" + body
    tags = npc.get("persona", {}).get("knowledge_tags")
    tag_line = f"Your knowledge touches on: {', '.join(map(str, tags))}." if tags else ""
    return (
        "LORE: nothing has been authored for this character yet. State no historical facts at all; "
        "speak only about what you can see, do and feel right now. " + tag_line
    ).strip()


def _permitted_block(npc: dict) -> str:
    llm = npc.get("llm", {}) if isinstance(npc.get("llm"), dict) else {}
    parts: list[str] = []
    if llm.get("items_may_give"):
        parts.append("give: " + ", ".join(map(str, llm["items_may_give"])))
    if llm.get("flags_may_set"):
        parts.append("set_flag: " + ", ".join(map(str, llm["flags_may_set"])))
    bounds = llm.get("vars_may_change") or {}
    if isinstance(bounds, dict) and bounds:
        parts.append("var: " + ", ".join(f"{k} (-{b.get('max', 1)}..{b.get('max', 1)})" for k, b in bounds.items()))
    body = "\n".join(parts) if parts else "none — you cannot change any state. Speak instead."
    return "PERMITTED ACTIONS:\n" + body


def stable_prefix(npc: dict, lang: str, state: dict | None = None) -> str:
    """The cacheable part. Must not depend on player state, history, or turn number —
    EXCEPT through the NPC's active event page (§5.1 states): one cache prefix per
    (npc, lang, page) triple, which is how a page's shifted persona stays cheap."""
    return "\n\n".join(
        [
            _persona_block(npc, state),
            WORLD_RULES.strip(),
            _lore_block(npc, state),
            OUTPUT_CONTRACT.strip(),
            _permitted_block(npc),
            REGISTER.get(lang, DEFAULT_REGISTER).strip(),
        ]
    )


def visible_secrets(npc: dict, state: dict[str, Any]) -> list[dict]:
    revealed: list[dict] = []
    for secret in npc.get("secrets", []) or []:
        if not isinstance(secret, dict):
            continue
        if evaluate(secret.get("reveal_if"), state):
            revealed.append(secret)
    return revealed


LANGUAGE_REMINDER: dict[str, str] = {
    "zh_HK": "LANGUAGE REMINDER: this turn's reply must be in WRITTEN CANTONESE (Traditional). "
             "Do not continue in any other language, even if the history above is in one.",
    "zh_CN": "LANGUAGE REMINDER: this turn's reply must be in Simplified Chinese (書面語, no "
             "Cantonese particles), even if the history above is in another language.",
    "en": "LANGUAGE REMINDER: this turn's reply must be in English, even if the history above "
          "is in another language.",
}


def volatile_block(npc: dict, state: dict[str, Any], lang: str, player_input: str) -> str:
    sections: list[str] = []

    secrets = visible_secrets(npc, state)
    if secrets:
        rendered = "\n".join(f"- {s.get('id')}: {s.get('text', '')}" for s in secrets)
        sections.append("SECRETS YOU MAY NOW REVEAL (only if it fits what you are saying):\n" + rendered)

    flags = state.get("flags") or {}
    inventory = state.get("inventory") or {}
    variables = state.get("vars") or {}
    talk_counts = state.get("talk_counts") or {}
    npc_id = str(npc.get("id", ""))
    held = str(state.get("held_item", ""))
    state_lines = [
        f"You have spoken with the player {int(talk_counts.get(npc_id, 0))} time(s) before.",
        "Flags currently true: " + (", ".join(sorted(k for k, v in flags.items() if v)) or "none"),
        "Player carries: " + (", ".join(sorted(str(k) for k in inventory)) or "nothing"),
        "In the player's hands right now: " + (held if held else "nothing — their hands are empty"),
    ]
    if held:
        # The player is holding something you can SEE (P6+ item screen): react to it when it
        # fits what you were saying — curiosity, suspicion, a request to look closer.
        state_lines.append(
            "You can see the item in their hands. React to it naturally if it interests your "
            "character — ask about it, admire it, or eye it warily — but only when it fits "
            "the conversation already happening."
        )
    if variables:
        state_lines.append("Values: " + ", ".join(f"{k}={v}" for k, v in sorted(variables.items())))
    sections.append("RIGHT NOW:\n" + "\n".join(state_lines))

    line = player_input or "(The player says nothing, and just looks at you.)"
    sections.append("PLAYER SAYS:\n" + line)
    # The last word before generation decides the language when history disagrees with the
    # current locale (P6 fix: conversations kept the old language after a switch).
    sections.append(LANGUAGE_REMINDER.get(lang, LANGUAGE_REMINDER["en"]).strip())
    return "\n\n".join(sections)


def build_messages(
    npc: dict,
    state: dict[str, Any],
    lang: str,
    history: list[dict],
    player_input: str,
) -> list[dict]:
    event_page = active_state(npc, state)
    messages: list[dict] = [{"role": "system", "content": stable_prefix(npc, lang, event_page)}]
    for turn in history or []:
        role = str(turn.get("role", ""))
        content = str(turn.get("content", ""))
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": volatile_block(npc, state, lang, player_input)})
    return messages
