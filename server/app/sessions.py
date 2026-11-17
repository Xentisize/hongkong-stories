"""Anonymous sessions and token budgets (PLAN 7.5).

A session is the only thing the client can hold: a random token with a token budget. No
identity, no PII, no key. In-memory on purpose — a restart invalidates sessions, which is the
correct behaviour for a game whose client can simply ask for a new one.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field

MAX_SESSIONS = 4096


@dataclass
class Session:
    token: str
    budget: int
    ip: str = ""
    used_tokens: int = 0
    turns: int = 0
    created_at: float = field(default_factory=time.time)

    @property
    def remaining(self) -> int:
        return max(0, self.budget - self.used_tokens)

    @property
    def exhausted(self) -> bool:
        return self.remaining <= 0

    def charge(self, tokens: int) -> None:
        self.used_tokens += max(0, int(tokens))
        self.turns += 1

    def as_public_dict(self) -> dict:
        return {
            "session_token": self.token,
            "budget": self.budget,
            "remaining": self.remaining,
        }


class SessionStore:
    def __init__(self, token_budget: int, max_sessions: int = MAX_SESSIONS) -> None:
        self._token_budget = token_budget
        self._max_sessions = max_sessions
        self._sessions: dict[str, Session] = {}

    def create(self, ip: str = "") -> Session:
        if len(self._sessions) >= self._max_sessions:
            # Drop the oldest third rather than refusing: this is a public, anonymous game.
            for token in sorted(self._sessions, key=lambda t: self._sessions[t].created_at)[: self._max_sessions // 3]:
                self._sessions.pop(token, None)
        session = Session(token=secrets.token_urlsafe(24), budget=self._token_budget, ip=ip)
        self._sessions[session.token] = session
        return session

    def get(self, token: str) -> Session | None:
        return self._sessions.get(token)

    def __len__(self) -> int:
        return len(self._sessions)
