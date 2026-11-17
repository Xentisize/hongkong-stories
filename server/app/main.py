"""FastAPI application (PLAN 3, 7.1).

Trust boundary in one sentence: the OpenRouter key lives in this process only, and every model
call is mediated here so prompts, budgets and action allowlists cannot be bypassed by the
client. A wasm bundle is fully inspectable, so no key can ever be shipped to it.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import caps
from .config import Settings, get_settings
from .content import ContentStore
from .errors import ErrorCounts
from .sessions import SessionStore

LOGGER = logging.getLogger("hkstories")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(title="Hong Kong Stories API", version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.sessions = SessionStore(settings.session_token_budget)
    app.state.caps = caps.DailyCaps(settings.per_ip_daily_sessions, settings.per_ip_daily_cost_usd)
    app.state.error_counts = ErrorCounts()
    app.state.content = ContentStore.load(settings.content_dir)

    from .routers import admin, chat, content, session  # imported lazily so tests can build an app cheaply

    app.include_router(session.router)
    app.include_router(chat.router)
    app.include_router(content.router)
    app.include_router(admin.router)

    # Admin SPA (PLAN 9.1): built with bun/vite into server/admin/dist, served same-origin
    # at /admin so the API needs no extra CORS surface. Dev mode is `bun run dev` (proxied).
    admin_dist = Path(__file__).resolve().parents[1] / "admin" / "dist"
    if admin_dist.is_dir():
        from fastapi.staticfiles import StaticFiles

        app.mount("/admin", StaticFiles(directory=admin_dist, html=True), name="admin")

    if not settings.has_key:
        LOGGER.warning("OPENROUTER_API_KEY is not set — /v1/chat will return no_api_key")
    LOGGER.info(
        "content loaded: %s (hash %s), model=%s, mode=%s",
        app.state.content.counts(),
        app.state.content.content_hash,
        settings.chat_model,
        settings.chat_output_mode,
    )

    @app.get("/healthz")
    async def healthz() -> dict:
        """Liveness plus the facts a client or a human needs. Never includes the key itself."""
        return {
            "status": "ok",
            "model": settings.chat_model,
            "output_mode": settings.chat_output_mode,
            "key_present": settings.has_key,
            "content": app.state.content.counts(),
            "content_hash": app.state.content.content_hash,
            "sessions": len(app.state.sessions),
            "caps": app.state.caps.summary(),
            "errors": app.state.error_counts.summary(),
        }

    return app


app = create_app()
