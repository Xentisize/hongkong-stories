"""Per-IP daily cost caps (PLAN 7.5 guards, P6).

In-memory on purpose: the caps guard today's spend, and a restart is a soft reset for a
public anonymous game whose client can simply ask for a new session. Keyed by the best
client IP (X-Forwarded-For → Fly-Client-IP → socket peer); counters and aggregates only —
an IP string is never logged or served anywhere.

Yesterday's slots are pruned lazily as new traffic arrives, so the dictionary cannot grow
with the calendar.
"""

from __future__ import annotations

import datetime
import threading


def _today() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def best_client_ip(headers, fallback: str = "") -> str:
    """Best-guess client IP from proxy headers, falling back to the socket peer.

    Behind Fly/Cloudflare the socket peer is the proxy; X-Forwarded-For's first entry (or
    Fly-Client-IP) is the actual client. Spoofing the header only hurts the spoofer — the
    cap then binds their fake address.
    """
    forwarded = headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    fly = headers.get("fly-client-ip")
    if fly:
        return fly.strip()
    return fallback


class DailyCaps:
    """Thread-safe per-IP, per-day counters with a sessions cap and a cost cap."""

    def __init__(self, max_sessions: int, max_cost_usd: float) -> None:
        self.max_sessions = max(1, int(max_sessions))
        self.max_cost_usd = max(0.0, float(max_cost_usd))
        self._lock = threading.Lock()
        self._days: dict[tuple[str, str], dict] = {}

    def _slot(self, ip: str) -> dict:
        """Caller MUST hold the lock — this helper never takes it itself (a non-reentrant
        threading.Lock double-acquired here deadlocked the whole suite once; P6 lesson)."""
        today = _today()
        if len(self._days) > 2048:  # lazy prune: yesterday's slots stop mattering
            self._days = {key: slot for key, slot in self._days.items() if key[1] == today}
        key = (ip, today)
        slot = self._days.get(key)
        if slot is None:
            slot = {"sessions": 0, "cost_usd": 0.0}
            self._days[key] = slot
        return slot

    def session_allowed(self, ip: str) -> bool:
        with self._lock:
            return self._slot(ip)["sessions"] < self.max_sessions

    def cost_cap_reached(self, ip: str) -> bool:
        with self._lock:
            return self._slot(ip)["cost_usd"] >= self.max_cost_usd

    def add_session(self, ip: str) -> None:
        with self._lock:
            self._slot(ip)["sessions"] += 1

    def add_cost(self, ip: str, cost_usd: float) -> None:
        with self._lock:
            self._slot(ip)["cost_usd"] += max(0.0, float(cost_usd))

    def summary(self) -> dict:
        """Counts only (PLAN P6 telemetry: no PII) — no IP ever leaves this module."""
        with self._lock:
            today = _today()
            slots = [slot for (ip, day), slot in self._days.items() if day == today]
        return {
            "date": today,
            "tracked_ips": len(slots),
            "sessions_today": sum(slot["sessions"] for slot in slots),
            "cost_cap_usd": self.max_cost_usd,
            "sessions_cap_per_ip": self.max_sessions,
        }