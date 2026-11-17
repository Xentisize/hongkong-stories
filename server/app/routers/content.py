"""Public content-pack endpoints (PLAN 5.7, 10.3) — the hot-pack interface.

The client boots on its bundled baseline, then fetches `/v1/content/manifest.json`; a newer
version sends it back for the changed entity files and art bytes. Both endpoints are
`no-cache` on purpose: a stale pack looks exactly like a broken build (the stale
`index.pck` lesson in the README).

Files are served by allowlist, not by trust: the requested path must resolve inside
`settings.content_dir`, or the answer is a 404 — no directory listing, no traversal.
"""

from __future__ import annotations

import json
import mimetypes

from fastapi import APIRouter, HTTPException, Request, Response

router = APIRouter(prefix="/v1/content", tags=["content"])


@router.get("/manifest.json")
async def manifest(request: Request) -> Response:
    content = request.app.state.content
    if not content.manifest:
        raise HTTPException(status_code=503, detail="content not loaded")
    body = json.dumps(content.manifest, ensure_ascii=False, indent=2) + "\n"
    return Response(content=body, media_type="application/json",
                    headers={"Cache-Control": "no-cache"})


@router.get("/file/{file_path:path}")
async def content_file(file_path: str, request: Request) -> Response:
    settings = request.app.state.settings
    root = settings.content_dir.resolve()
    candidate = (root / file_path).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise HTTPException(status_code=404, detail="no such content file")
    media = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    return Response(content=candidate.read_bytes(), media_type=media,
                    headers={"Cache-Control": "no-cache"})