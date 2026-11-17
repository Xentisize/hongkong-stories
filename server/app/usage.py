"""Usage accounting (PLAN 9.2 usage dashboard) — append-only JSONL, aggregated on read.

`server/data/usage.jsonl` (git-ignored, like everything under server/data/): one line per
billable event — in-game chat turns, playground turns, fact-check calls, image generations.
JSONL instead of sqlite for now: the dashboard reads a few hundred lines this phase, and a
store migration (PLAN 4, `app/store/`) can import the file when history grows. Logging is
best-effort and never fatal — a broken dashboard must not break a chat turn.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# PLAN 7.5 measured prices — applied where the provider did not report a cost (the streaming
# in-game path has no usage in the response; the playground does, via usage.include).
PRICE_PER_M_IN = 0.15
PRICE_PER_M_OUT = 0.60
PRICE_PER_M_CACHED = 0.003


def estimate_cost(prompt_tokens: int, cached_tokens: int, completion_tokens: int) -> float:
    fresh = max(prompt_tokens - cached_tokens, 0)
    return (
        fresh * PRICE_PER_M_IN
        + cached_tokens * PRICE_PER_M_CACHED
        + completion_tokens * PRICE_PER_M_OUT
    ) / 1_000_000


def _path(settings) -> Path:
    return settings.admin_data_dir / "usage.jsonl"


def log_event(settings, type: str, **fields) -> None:
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "type": type, **fields}
    try:
        path = _path(settings)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass  # accounting must never break a turn


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(len(ordered) * 0.95))
    return ordered[index]


def aggregate(settings) -> dict:
    """Month-to-date rollup for the dashboard: spend, top rejections, p95 latency, sessions."""
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    chat_cost = image_cost = factcheck_cost = 0.0
    turns = tokens = 0
    latencies: list[float] = []
    rejected: Counter[str] = Counter()
    sessions: dict[str, dict] = {}

    path = _path(settings)
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not str(entry.get("ts", "")).startswith(month):
                continue
            kind = str(entry.get("type", ""))
            cost = float(entry.get("cost_usd", 0.0) or 0.0)
            if kind in ("chat", "playground"):
                chat_cost += cost
                turns += 1
                tokens += int(entry.get("tokens", 0) or 0)
                if entry.get("latency_ms") is not None:
                    latencies.append(float(entry["latency_ms"]))
                session = entry.get("session")
                if session:
                    slot = sessions.setdefault(str(session), {"turns": 0, "cost_usd": 0.0})
                    slot["turns"] += 1
                    slot["cost_usd"] += cost
            elif kind == "image":
                image_cost += cost
            elif kind == "fact_check":
                factcheck_cost += cost
            reasons = entry.get("rejected")
            if isinstance(reasons, list):
                for reason in reasons:
                    rejected[str(reason)] += 1

    return {
        "month": month,
        "chat_cost_usd": round(chat_cost, 6),
        "image_cost_usd": round(image_cost, 6),
        "factcheck_cost_usd": round(factcheck_cost, 6),
        "turns": turns,
        "tokens": tokens,
        "p95_latency_ms": round(_p95(latencies), 1),
        "top_rejected": [
            {"reason": reason, "count": count} for reason, count in rejected.most_common(5)
        ],
        "sessions": sorted(
            ({"session": key, **slot} for key, slot in sessions.items()),
            key=lambda s: -s["cost_usd"],
        )[:10],
    }