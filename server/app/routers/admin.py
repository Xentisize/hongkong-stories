"""Admin API (PLAN 9.2, 9.3) — drafts, validation and publish.

Single-operator auth: `Authorization: Bearer <ADMIN_TOKEN>` compared with
`secrets.compare_digest`. An unset `HKS_ADMIN_TOKEN` disables the whole admin API — it never
falls open. Admin routes are the only writers of the shipped content pack, and they never
accept a model id or URL from the client (model slugs are server-side constants, §9.3).

Drafts live under `settings.admin_data_dir/drafts/<kind>/<id>.json`, separate from the
shipped baseline in `client/content/`. Validate and publish judge the *merged* pack
(baseline + drafts): publish refuses on any error-level issue, copies accepted drafts over
the baseline, regenerates the manifest with a version bump, reloads the store, and clears
the drafts. Nothing reaches players unless it validates (§9.2). Removing shipped content
remains a deliberate edit to `client/content/` by the operator — drafts only add or update.
"""

from __future__ import annotations

import base64
import json
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..assets import pixelate, seedream
from ..assets import templates as art_templates
from ..assets.palette import PALETTE_NAME
from ..content import ContentStore
from ..content_validate import validate_store

router = APIRouter(prefix="/v1/admin", tags=["admin"])

REPO_ROOT = Path(__file__).resolve().parents[3]
DRAFT_KINDS = ("npcs", "items", "locations", "quests")


def _require_admin(request: Request) -> None:
    settings = request.app.state.settings
    if not settings.has_admin:
        raise HTTPException(status_code=503, detail="admin API is not configured")
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if not secrets.compare_digest(token, settings.admin_token):
        raise HTTPException(status_code=401, detail="invalid admin token")


def _draft_path(settings, kind: str, draft_id: str) -> Path:
    if kind not in DRAFT_KINDS:
        raise HTTPException(status_code=400, detail=f"unknown kind {kind!r}")
    if not draft_id or "/" in draft_id or draft_id.startswith("."):
        raise HTTPException(status_code=400, detail="bad id")
    return settings.admin_data_dir / "drafts" / kind / f"{draft_id}.json"


def _draft_files(settings) -> list[Path]:
    drafts_dir = settings.admin_data_dir / "drafts"
    if not drafts_dir.is_dir():
        return []
    return sorted(path for kind_dir in drafts_dir.iterdir() if kind_dir.is_dir()
                  for path in kind_dir.glob("*.json"))


def _merged_store(request: Request) -> ContentStore:
    """The pack as it would ship: baseline overlaid with drafts."""
    settings = request.app.state.settings
    baseline: ContentStore = request.app.state.content
    merged = {kind: dict(rows) for kind, rows in baseline.tables.items()}
    for path in _draft_files(settings):
        entity = json.loads(path.read_text(encoding="utf-8"))
        entity_id = str(entity.get("id", ""))
        kind = path.parent.name
        if entity_id:
            merged.setdefault(kind, {})[entity_id] = entity
    return ContentStore(
        content_dir=settings.content_dir,
        tables=merged,
        content_hash=baseline.content_hash,
        version=baseline.version,
        manifest=baseline.manifest,
    )


@router.get("/meta")
async def meta(request: Request) -> dict:
    _require_admin(request)
    content = request.app.state.content
    return {
        "content_version": content.version,
        "content_hash": content.content_hash,
        "counts": content.counts(),
    }


@router.get("/drafts")
async def list_drafts(request: Request) -> list[dict]:
    _require_admin(request)
    settings = request.app.state.settings
    return [
        {"kind": path.parent.name, "id": path.stem, "updated": int(path.stat().st_mtime)}
        for path in _draft_files(settings)
    ]


@router.get("/drafts/{kind}/{draft_id}")
async def get_draft(kind: str, draft_id: str, request: Request) -> dict:
    _require_admin(request)
    path = _draft_path(request.app.state.settings, kind, draft_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such draft")
    return json.loads(path.read_text(encoding="utf-8"))


@router.put("/drafts/{kind}/{draft_id}")
async def put_draft(kind: str, draft_id: str, request: Request) -> dict:
    _require_admin(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="draft body must be a JSON object")
    if str(body.get("id", "")) != draft_id:
        raise HTTPException(status_code=422, detail="body id must match the URL id")
    path = _draft_path(request.app.state.settings, kind, draft_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"saved": True, "kind": kind, "id": draft_id}


@router.delete("/drafts/{kind}/{draft_id}")
async def delete_draft(kind: str, draft_id: str, request: Request) -> dict:
    _require_admin(request)
    path = _draft_path(request.app.state.settings, kind, draft_id)
    if path.is_file():
        path.unlink()
    return {"deleted": True, "kind": kind, "id": draft_id}


@router.get("/content/{kind}")
async def list_entities(kind: str, request: Request) -> dict:
    _require_admin(request)
    content = request.app.state.content
    if kind not in content.tables:
        raise HTTPException(status_code=400, detail=f"unknown kind {kind!r}")
    return {"kind": kind, "entities": sorted(content.tables[kind].keys())}


@router.get("/content/{kind}/{entity_id}")
async def get_entity(kind: str, entity_id: str, request: Request) -> dict:
    _require_admin(request)
    entity = request.app.state.content.tables.get(kind, {}).get(entity_id)
    if entity is None:
        raise HTTPException(status_code=404, detail="no such entity")
    return entity


@router.post("/validate")
async def validate(request: Request) -> dict:
    _require_admin(request)
    issues = validate_store(_merged_store(request))
    errors = [i for i in issues if i["level"] == "error"]
    return {"ok": not errors, "issues": issues}


@router.post("/publish")
async def publish(request: Request) -> dict:
    _require_admin(request)
    settings = request.app.state.settings
    drafts = _draft_files(settings)
    if not drafts:
        raise HTTPException(status_code=400, detail="nothing to publish — no drafts")
    issues = validate_store(_merged_store(request))
    errors = [i for i in issues if i["level"] == "error"]
    if errors:
        raise HTTPException(status_code=422, detail={
            "message": "validation failed — nothing was published", "issues": issues,
        })

    # Accepted drafts become the shipped baseline; the manifest regenerates with a bump so
    # every booted client hot-packs the new pack (§5.7).
    copied = 0
    for path in drafts:
        target_dir = settings.content_dir / path.parent.name
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        copied += 1
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "gen_content_manifest.py"),
         "--bump", str(settings.content_dir)],
        capture_output=True, text=True, check=True,
    )
    request.app.state.content = ContentStore.load(settings.content_dir)

    for path in drafts:  # shipped: clear the drafting area for the next pass
        path.unlink()
    content = request.app.state.content
    return {
        "published": copied,
        "version": content.version,
        "content_hash": content.content_hash,
        "counts": content.counts(),
    }


@router.post("/art/generate")
async def generate_art(request: Request) -> dict:
    """Generate → post-process → persist one asset (PLAN 8).

    The PNG and its provenance sidecar (§8.4: model, seed, palette, cost — "regenerate this
    sprite exactly" must stay possible) land directly in the content pack; the admin UI then
    references the returned pack-relative path from the draft it is authoring.
    """
    _require_admin(request)
    settings = request.app.state.settings
    if not settings.has_key:
        raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY is not configured")
    body = await request.json()
    kind = str(body.get("kind", ""))
    if kind not in art_templates.TARGETS:
        raise HTTPException(status_code=400, detail=f"unknown art kind {kind!r}")
    subject_id = str(body.get("subject_id", ""))
    if not subject_id or "/" in subject_id or subject_id.startswith("."):
        raise HTTPException(status_code=400, detail="bad subject_id")
    desc = str(body.get("desc", "")).strip()
    if not desc:
        raise HTTPException(status_code=422, detail="desc is required")
    raw_seed = body.get("seed")
    aspect, target = art_templates.TARGETS[kind]
    prompt = art_templates.build_prompt(kind, desc)

    try:
        generated = await seedream.generate_image(
            settings,
            prompt=prompt,
            aspect_ratio=aspect,
            seed=int(raw_seed) if raw_seed is not None else None,
        )
    except seedream.SeedreamError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "message": str(exc)})
    try:
        processed = pixelate.process(generated.png, target, outline=True)
    except RuntimeError as exc:  # Pillow missing — the art extras are optional (PLAN 10.6)
        raise HTTPException(status_code=503, detail=str(exc))

    pack_rel = art_templates.pack_path(kind, subject_id)
    target_file = settings.content_dir / pack_rel
    target_file.parent.mkdir(parents=True, exist_ok=True)
    target_file.write_bytes(processed)

    now = datetime.now(timezone.utc)
    prompt_id = "gen_%s_%s" % (now.strftime("%Y%m%d"), secrets.token_hex(3))
    provenance = {
        "prompt_id": prompt_id,
        "model": settings.image_model,
        "seed": generated.seed,
        "resolution": "1K",
        "aspect_ratio": aspect,
        "background": "transparent",
        "input_references": [],
        "post": {"palette": PALETTE_NAME, "target_px": list(target), "outline": True},
        "cost_usd": generated.cost_usd,
        "accepted_by": "admin",
        "ts": now.isoformat(),
        "prompt": prompt,
    }
    target_file.with_suffix(".gen.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return {
        "path": pack_rel,
        "png_base64": base64.b64encode(processed).decode("ascii"),
        "seed": generated.seed,
        "cost_usd": generated.cost_usd,
        "prompt_id": prompt_id,
    }