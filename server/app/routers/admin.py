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
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from .. import factcheck, usage
from ..assets import pixelate, seedream
from ..assets import templates as art_templates
from ..assets.palette import PALETTE_NAME
from ..content import ContentStore
from ..content_validate import validate_store
from ..llm import openrouter, prompts
from ..llm.actions import validate_actions
from ..llm.conditions import evaluate as condition_true

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


@router.post("/evaluate_condition")
async def evaluate_condition(request: Request) -> dict:
    """Live condition evaluation (§9.2): the builder asks "would this pass?" against a state
    the author assembles. Evaluated server-side so the Python evaluator stays the single
    truth — the SPA never grows a second, drifting copy of the mini-language."""
    _require_admin(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="expected a JSON object")
    state = body.get("state") if isinstance(body.get("state"), dict) else {}
    try:
        passed = condition_true(body.get("condition"), state)
    except Exception as exc:  # noqa: BLE001 - a malformed condition must not 500 the SPA
        raise HTTPException(status_code=422, detail=f"unusable condition: {exc}")
    return {"pass": bool(passed)}


@router.get("/publish_preview")
async def publish_preview(request: Request) -> dict:
    """The diff publish would apply (§9.2: validate → preview diff → bump → serve)."""
    _require_admin(request)
    settings = request.app.state.settings
    baseline = request.app.state.content
    added: list[dict] = []
    changed: list[dict] = []
    for path in _draft_files(settings):
        entry = {"kind": path.parent.name, "id": path.stem}
        current = baseline.tables.get(entry["kind"], {}).get(entry["id"])
        if current is None:
            added.append(entry)
            continue
        draft = json.loads(path.read_text(encoding="utf-8"))
        if (json.dumps(draft, sort_keys=True, ensure_ascii=False)
                != json.dumps(current, sort_keys=True, ensure_ascii=False)):
            changed.append(entry)
    return {"added": added, "changed": changed}


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
    aspect, target, background = art_templates.TARGETS[kind]
    outlined = kind in art_templates.OUTLINED
    prompt = art_templates.build_prompt(kind, desc)

    # §8.2 consistency levers: the style bible rides along as input_references[0] on every
    # generation when it exists and the caller didn't opt out; extra references must be
    # pack-relative files. References go on the wire as data URLs built from pack bytes.
    reference_paths: list[str] = []
    style_bible = settings.content_dir / "art" / "stylebible.png"
    if body.get("use_style_bible", True) and style_bible.is_file():
        reference_paths.append("art/stylebible.png")
    for ref in body.get("input_references", []) or []:
        ref_rel = str(ref)
        ref_file = (settings.content_dir / ref_rel).resolve()
        if not ref_file.is_relative_to(settings.content_dir.resolve()) or not ref_file.is_file():
            raise HTTPException(status_code=400,
                                detail=f"reference not found in pack: {ref_rel}")
        if ref_rel not in reference_paths:
            reference_paths.append(ref_rel)
    # Live-verified wire format (2026-11-17): each entry is a chat-style image part object,
    # {"type": "image_url", "image_url": {"url": <data or https URL>}} — bare strings are
    # rejected with a ZodError.
    references = [
        {
            "type": "image_url",
            "image_url": {
                "url": "data:image/png;base64,"
                       + base64.b64encode((settings.content_dir / path).read_bytes()).decode("ascii"),
            },
        }
        for path in reference_paths
    ]

    # Reference-less transparent subjects need the newer model (live-verified constraint in
    # config.py); reference-based and opaque generations run the default image model.
    model = settings.image_model
    if not references and background == "transparent":
        model = settings.image_model_transparent
    try:
        generated = await seedream.generate_image(
            settings,
            prompt=prompt,
            aspect_ratio=aspect,
            seed=int(raw_seed) if raw_seed is not None else None,
            input_references=references,
            background=background,
            model=model,
        )
    except seedream.SeedreamError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "message": str(exc)})
    # The style bible needs a transparent fringe: Seed requires the reference PNG to carry
    # at least one transparent pixel before it will honor a transparent output (live-verified).
    pad = 2 if kind == "stylebible" else 0
    try:
        processed = pixelate.process(generated.png, target, outline=outlined, pad=pad)
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
        "model": model,
        "seed": generated.seed,
        "resolution": "1K",
        "aspect_ratio": aspect,
        "background": background,
        "input_references": reference_paths,
        "post": {"palette": PALETTE_NAME, "target_px": list(target), "outline": outlined,
                 "pad": pad},
        "cost_usd": generated.cost_usd,
        "accepted_by": "admin",
        "ts": now.isoformat(),
        "prompt": prompt,
    }
    target_file.with_suffix(".gen.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    usage.log_event(settings, "image", path=pack_rel, cost_usd=generated.cost_usd)

    return {
        "path": pack_rel,
        "png_base64": base64.b64encode(processed).decode("ascii"),
        "seed": generated.seed,
        "cost_usd": generated.cost_usd,
        "prompt_id": prompt_id,
    }


@router.post("/playground")
async def playground(request: Request) -> dict:
    """Chat with a DRAFT npc through the real pipeline (PLAN 9.2 persona playground).

    The SPA posts the unsaved draft itself, so this works for authors mid-edit. Per-turn the
    response carries the assembled stats: real prompt/completion/cached tokens (usage.include
    — the cache-hit telemetry PLAN 7.5 wanted), cost, latency, and the actions the model
    TRIED that the allowlist rejected — surfaced explicitly, never hidden.
    """
    _require_admin(request)
    settings = request.app.state.settings
    if not settings.has_key:
        raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY is not configured")
    body = await request.json()
    npc = body.get("npc") if isinstance(body, dict) else None
    if not isinstance(npc, dict) or not str(npc.get("id", "")):
        raise HTTPException(status_code=422, detail="npc draft is required")
    state = body.get("state") if isinstance(body.get("state"), dict) else {}
    lang = str(body.get("lang", "zh_HK"))
    history = body.get("history") if isinstance(body.get("history"), list) else []
    player_input = str(body.get("input", "")).strip()

    messages = prompts.build_messages(npc, state, lang, history, player_input)
    started = time.monotonic()
    try:
        result = await openrouter.complete_chat(settings=settings, messages=messages)
    except openrouter.UpstreamError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "message": str(exc)})
    latency_ms = (time.monotonic() - started) * 1000.0

    accepted, rejected = validate_actions(result.actions, npc, state)
    usage.log_event(
        settings, "playground",
        npc=str(npc.get("id", "")),
        tokens=result.prompt_tokens + result.completion_tokens,
        cost_usd=result.cost_usd,
        latency_ms=round(latency_ms, 1),
        cached_tokens=result.cached_tokens,
        rejected=[r["reason"] for r in rejected],
    )
    return {
        "say": result.say,
        "mood": result.mood,
        "actions": accepted,
        "rejected": rejected,
        "truncated": result.truncated,
        "usage": {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "cached_tokens": result.cached_tokens,
            "cache_ratio": (result.cached_tokens / result.prompt_tokens) if result.prompt_tokens else 0.0,
            "cost_usd": result.cost_usd,
        },
        "latency_ms": round(latency_ms, 1),
        "model": settings.chat_model,
    }


@router.post("/factcheck/check")
async def factcheck_check(request: Request) -> dict:
    """Score one line against the draft npc's lore and queue it for review (PLAN 7.6)."""
    _require_admin(request)
    settings = request.app.state.settings
    if not settings.has_key:
        raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY is not configured")
    body = await request.json()
    npc = body.get("npc") if isinstance(body, dict) else None
    if not isinstance(npc, dict):
        raise HTTPException(status_code=422, detail="npc draft is required")
    player_input = str(body.get("player_input", ""))
    reply = str(body.get("reply", "")).strip()
    if not reply:
        raise HTTPException(status_code=422, detail="reply is required")
    try:
        entry = await factcheck.check(settings, npc, player_input, reply)
    except openrouter.UpstreamError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "message": str(exc)})
    usage.log_event(settings, "fact_check", npc=entry["npc_id"], cost_usd=entry["cost_usd"])
    return entry


@router.get("/factcheck")
async def factcheck_list(request: Request) -> list[dict]:
    _require_admin(request)
    return factcheck.list_entries(request.app.state.settings)


@router.post("/factcheck/{entry_id}/resolve")
async def factcheck_resolve(entry_id: str, request: Request) -> dict:
    _require_admin(request)
    body = await request.json()
    try:
        entry = factcheck.resolve(request.app.state.settings, entry_id, str(body.get("status", "")))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if entry is None:
        raise HTTPException(status_code=404, detail="no such fact-check entry")
    return entry


@router.get("/usage")
async def usage_dashboard(request: Request) -> dict:
    _require_admin(request)
    return usage.aggregate(request.app.state.settings)