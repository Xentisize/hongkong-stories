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


@router.get("/content/manifest")
async def content_manifest(request: Request) -> dict:
    """The shape the P4 hot-pack endpoint will serve; P2 exposes it read-only."""
    content = request.app.state.content
    return {
        "version": content.version,
        "content_hash": content.content_hash,
        "counts": content.counts(),
    }
