"""OpenRouter images endpoint client (PLAN 2, 8.1).

POST /v1/images with the dedicated image contract — `{model, prompt, resolution,
aspect_ratio, background, seed, input_references}` → `data[].b64_json` + `usage.cost` — not
the legacy chat/completions modalities route. The key never leaves this process; every
failure surfaces as a `SeedreamError` the admin route turns into a 502 with a code the SPA
can show, never a raised 500 with the payload attached.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import httpx

IMAGE_URL = "https://openrouter.ai/api/v1/images"
# Image renders are slower than chat turns; the chat upstream timeout does not apply here.
IMAGE_TIMEOUT_SEC = 90.0


class SeedreamError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class GeneratedImage:
    png: bytes
    seed: int
    cost_usd: float


async def generate_image(settings, *, prompt: str, aspect_ratio: str,
                         seed: int | None = None,
                         input_references: list[str] | None = None,
                         background: str = "transparent",
                         model: str | None = None) -> GeneratedImage:
    if not settings.has_key:
        raise SeedreamError("no_api_key", "OPENROUTER_API_KEY is not configured")

    payload: dict = {
        "model": model or settings.image_model,
        "prompt": prompt,
        "resolution": "1K",  # 2K costs more and buys nothing after downscaling (PLAN 8.1)
        "aspect_ratio": aspect_ratio,
        "background": background,
    }
    if seed is not None:
        payload["seed"] = int(seed)
    # Consistency mechanism (PLAN 8.2): reference images arrive as data URLs built by the
    # admin route from pack files.
    if input_references:
        payload["input_references"] = input_references

    try:
        async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT_SEC) as client:
            response = await client.post(
                IMAGE_URL,
                json=payload,
                headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
            )
    except httpx.HTTPError as exc:
        raise SeedreamError("upstream_unreachable", f"images request failed: {exc}") from exc

    if response.status_code != 200:
        # Surface the upstream body (truncated): "what did the images endpoint refuse" is the
        # first question every authoring failure asks, and the key is never in an error body.
        raise SeedreamError(
            f"upstream_http_{response.status_code}", response.text[:400],
        )

    data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    items = data.get("data") or []
    if not isinstance(items, list) or not items or not items[0].get("b64_json"):
        raise SeedreamError("empty_response", "images endpoint returned no image")

    try:
        png = base64.b64decode(str(items[0]["b64_json"]))
    except Exception as exc:  # noqa: BLE001 - malformed upstream payload
        raise SeedreamError("bad_payload", "images endpoint returned undecodable data") from exc

    usage = data.get("usage") or {}
    return GeneratedImage(
        png=png,
        seed=int(items[0].get("seed", payload.get("seed", 0)) or 0),
        cost_usd=float(usage.get("cost", 0.0) or 0.0),
    )