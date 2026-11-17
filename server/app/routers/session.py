"""POST /v1/session — hand the client a session token and its budget (PLAN 7.1)."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix="/v1", tags=["session"])


@router.post("/session")
async def create_session(request: Request) -> dict:
    settings = request.app.state.settings
    session = request.app.state.sessions.create()
    return {
        **session.as_public_dict(),
        "model": settings.chat_model,
        "output_mode": settings.chat_output_mode,
    }
