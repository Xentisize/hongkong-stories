"""Fact-check queue (PLAN 7.6, 9.2) — a second cheap call scores NPC lines against lore.

The rule from §7.6: flag for review; NEVER rewrite the player's words back at them. Entries
live in `server/data/factcheck.jsonl`, status `open` until a human resolves them
`dismissed`/`confirmed` in the admin UI. The checker runs prose-mode (no response_format —
the NPC reply schema would shape its output wrong) and parses the verdict defensively: an
unparsable checker reply becomes `questionable`, which is exactly what a review queue is for.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from pathlib import Path

from .llm.openrouter import complete_chat
from .llm.prompts import WORLD_RULES

VERDICTS = ("ok", "questionable", "contradiction")


def _path(settings) -> Path:
    return settings.admin_data_dir / "factcheck.jsonl"


def _load(settings) -> list[dict]:
    path = _path(settings)
    if not path.is_file():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def list_entries(settings) -> list[dict]:
    """Open entries first, then resolved ones; chronological within each group."""
    return sorted(_load(settings), key=lambda e: (e.get("status") != "open", str(e.get("ts", ""))))


def _parse_verdict(raw: str) -> tuple[str, str]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    try:
        parsed = json.loads(text)
        verdict = str(parsed.get("verdict", "questionable"))
        reason = str(parsed.get("reason", ""))[:500]
        if verdict not in VERDICTS:
            verdict = "questionable"
        return verdict, reason
    except json.JSONDecodeError:
        return "questionable", "checker returned unparsable output"


async def check(settings, npc: dict, player_input: str, reply: str) -> dict:
    """Score one NPC line against the character's authored lore; append to the queue."""
    persona = npc.get("persona", {}) if isinstance(npc.get("persona"), dict) else {}
    now = datetime.now(timezone.utc)
    prompt = (
        "You are the fact-check pass for a historical drama game. Judge ONLY whether the "
        "character's reply asserts anything the authored LORE does not support, or "
        "contradicts it. Do not judge style, grammar, or tone.\n\n"
        f"CHARACTER: {persona.get('role', '')}\n"
        f"LORE:\n{str(npc.get('lore', '') or '') or '(none authored)'}\n\n"
        f"PLAYER SAID: {player_input or '(nothing)'}\n"
        f"CHARACTER REPLIED: {reply}\n\n"
        'Reply with {"verdict": "ok" | "questionable" | "contradiction", "reason": "..."} '
        "and nothing else."
    )
    messages = [
        {"role": "system", "content": WORLD_RULES.strip()},
        {"role": "user", "content": prompt},
    ]
    result = await complete_chat(
        settings=settings, messages=messages, mode="prose", temperature=0.2, max_tokens=200,
    )
    verdict, reason = _parse_verdict(result.raw)
    entry = {
        "id": "fc_%s_%s" % (now.strftime("%Y%m%d%H%M%S"), secrets.token_hex(3)),
        "ts": now.isoformat(),
        "npc_id": str(npc.get("id", "")),
        "player_input": player_input,
        "reply": reply,
        "verdict": verdict,
        "reason": reason,
        "status": "open",
        "cost_usd": result.cost_usd,
    }
    path = _path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def resolve(settings, entry_id: str, status: str) -> dict | None:
    """Resolve one entry; returns the updated entry or None when the id is unknown."""
    if status not in ("dismissed", "confirmed"):
        raise ValueError(f"bad status {status!r}")
    entries = _load(settings)
    for entry in entries:
        if entry.get("id") == entry_id:
            entry["status"] = status
            break
    else:
        return None
    path = _path(settings)
    with path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry