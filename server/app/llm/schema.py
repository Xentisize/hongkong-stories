"""NPC reply contract (PLAN 7.3).

`strict` + `additionalProperties: false` is what makes streaming JSON worth the trouble: the
model cannot wander into a shape the validator does not expect, so a malformed turn is a
transport failure we can fall back from rather than a silent state mutation.

`mood` and action types are English enums in every locale — only `say` is localized, which
keeps the action validator locale-independent (PLAN 7.7).
"""

from __future__ import annotations

ACTION_TYPES = (
    "give",
    "take",
    "set_flag",
    "var",
    "reveal_secret",
    "open_shop",
)

NPC_REPLY_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "say": {
            "type": "string",
            "description": "What the character says. 1-3 short sentences. Spoken only.",
        },
        "mood": {
            "type": "string",
            "enum": ["neutral", "warm", "gruff", "wistful", "amused", "wary", "sad"],
            "description": "Delivery tone, not content.",
        },
        "actions": {
            "type": "array",
            "description": "State changes the character performs this turn. Usually empty.",
            "maxItems": 2,
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": list(ACTION_TYPES)},
                    "item": {"type": "string"},
                    "flag": {"type": "string"},
                    "name": {"type": "string"},
                    "value": {"type": "number"},
                    "count": {"type": "integer"},
                    "secret": {"type": "string"},
                },
                "required": ["type"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["say", "mood", "actions"],
    "additionalProperties": False,
}

NPC_REPLY_RESPONSE_FORMAT: dict = {
    "type": "json_schema",
    "json_schema": {"name": "npc_reply", "strict": True, "schema": NPC_REPLY_SCHEMA},
}
