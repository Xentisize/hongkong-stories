"""POST /v1/session — hand the client a session token and its budget (PLAN 7.1, 7.5).

P6 adds the per-IP daily guards: creation is refused with 429 `daily_cap` once an address
has burned through its day's sessions or spend, and the address is attached to the session
so the chat endpoint can aggregate its cost. In-memory, counts only — no PII leaves the
caps module.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import caps

router = APIRouter(prefix="/v1", tags=["session"])


@router.post("/session")
async def create_session(request: Request) -> dict:
    settings = request.app.state.settings
    ip = caps.best_client_ip(request.headers, request.client.host if request.client else "")
    if not request.app.state.caps.session_allowed(ip):
        raise HTTPException(status_code=429, detail={"code": "daily_cap"})
    session = request.app.state.sessions.create(ip)
    request.app.state.caps.add_session(ip)
    return {
        **session.as_public_dict(),
        "model": settings.chat_model,
        "output_mode": settings.chat_output_mode,
    }
