"""Error telemetry (PLAN P6): counts only, no PII.

Every error frame, upstream failure and malformed turn bumps a code counter in memory. The
dashboard reads the top codes; nothing about a request — no IP, no session token, no message
text — ever leaves this module. A restart resets the counts, which is fine for a counts-only
feed.
"""

from __future__ import annotations

import threading
from collections import Counter


class ErrorCounts:
    def __init__(self, max_codes: int = 64) -> None:
        self._lock = threading.Lock()
        self._counter: Counter[str] = Counter()
        self._max_codes = max_codes

    def record(self, code: str) -> None:
        code = str(code or "unknown")[:64]
        with self._lock:
            self._counter[code] += 1

    def summary(self, top: int = 8) -> dict:
        """Top codes + the grand total — counts only, no messages, no addresses."""
        with self._lock:
            items = self._counter.most_common(top)
            total = sum(self._counter.values())
        return {
            "total": total,
            "top": [{"code": code, "count": count} for code, count in items],
        }