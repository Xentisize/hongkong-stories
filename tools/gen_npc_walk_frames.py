#!/usr/bin/env python3
"""Generate NPC walk frames through the real art pipeline (PLAN 8).

This is the offline twin of `POST /v1/admin/art/generate`: same payload, same post-processor,
same provenance sidecar, no admin token needed. It exists because the art pipeline is the only
thing that produces game-ready 26x34 cells — downscaled to a 24x32 subject, palette-nearest
matched, outlined — and driving it by hand for 8 frames per character is how a cast ends up
inconsistent.

Frame naming matches `tools/assemble_npc_sheet.py`:

    <npc_id>_walk_<down|right|left|up>_<stand|step>.png

## Consistency: two mechanisms, because one was not enough

A first run generated every frame independently from text alone. A vision model's review and a
follow-up measurement both rejected it: clothing, proportions and apparent scale drifted between
frames, and one frame rendered so faintly that its silhouette collapsed. So:

1. **Identity anchor.** The first frame (down/stand) is generated with only the style bible, then
   that accepted frame is attached as an extra `input_references` entry for the other seven. The
   character design is pinned by an image, not by re-describing it seven times.
2. **Result gate + retry.** `pixelate.process` crops to the alpha bbox and force-resizes to the
   target, which means a faint render silently becomes a small figure instead of an error. Each
   frame is checked after processing — silhouette must fill most of the cell — and regenerated
   with a bumped seed if it does not.

Known limitation: `process` resizes to the target ignoring aspect ratio, so a subject whose
proportions differ from 3:4 is slightly stretched. Fixing that means changing shared server code;
this tool leaves it alone and documents it.

Usage:
    python3 tools/gen_npc_walk_frames.py npc_ch01_wai --desc "..." [--seed N] [--dry-run]

Requires the `art` dependency group (Pillow): `uv sync --group art` in server/.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import httpx  # noqa: E402

from app.assets import palette, pixelate, templates  # noqa: E402

CONTENT = ROOT / "client" / "content"
ART = CONTENT / "art" / "npcs"
IMAGE_URL = "https://openrouter.ai/api/v1/images"
RESOLUTION = "1K"

COLUMNS = ["down", "right", "left", "up"]
ROWS = ["stand", "step"]

# The anchor frame is generated first and then referenced by every other frame.
ANCHOR = ("down", "stand")

# A usable cell's silhouette should fill most of 26x34. A faint render survives `process` as a
# small blob (observed: 13x22 from one frame), which is a failure, not a style choice.
MIN_FILL = 0.75
MIN_COVERAGE = 0.10
MAX_COVERAGE = 0.95
MAX_ATTEMPTS = 3

VIEW = {
    "down": "facing the viewer",
    "right": "side view facing right",
    "left": "side view facing left",
    "up": "back view",
}


def pose_clause(direction: str, pose: str) -> str:
    if pose == "step":
        return "mid-step walking with one leg forward"
    if direction == "down":
        return "standing still, arms relaxed"
    return "standing still"


def read_env() -> dict[str, str]:
    """Minimal .env reader — no python-dotenv dependency for a build-time tool."""
    values: dict[str, str] = {}
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return values
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        values[key.strip()] = raw.strip().strip('"').strip("'")
    return values


def build_prompt(character: str, direction: str, pose: str, *, anchored: bool) -> str:
    same = "the same character as the reference image, " if anchored else ""
    desc = (
        "EXACTLY ONE cute chibi character, single figure centered: "
        f"{same}{character}, big head small body, {VIEW[direction]}, "
        f"{pose_clause(direction, pose)}, full body, no duplicates, no sheet layout, "
        "plain transparent background"
    )
    return templates.build_prompt("sprite", desc)


def data_url(png: bytes) -> dict:
    return {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode("ascii")},
    }


def style_bible_reference() -> tuple[dict | None, str]:
    path = CONTENT / "art" / "stylebible.png"
    if not path.is_file():
        return None, ""
    return data_url(path.read_bytes()), "art/stylebible.png"


def silhouette_ok(png: bytes, cell: tuple[int, int]) -> tuple[bool, str]:
    """Reject frames whose figure failed to render into a usable silhouette."""
    from PIL import Image

    image = Image.open(io.BytesIO(png)).convert("RGBA")
    alpha = image.getchannel("A")
    box = alpha.getbbox()
    if not box:
        return False, "empty alpha"
    width = box[2] - box[0]
    height = box[3] - box[1]
    fill_w = width / cell[0]
    fill_h = height / cell[1]
    opacity = sum(1 for v in alpha.get_flattened_data() if v >= 128) / (cell[0] * cell[1])
    detail = f"fill {fill_w:.2f}x{fill_h:.2f} ink {opacity:.0%}"
    if fill_w < MIN_FILL or fill_h < MIN_FILL:
        return False, f"silhouette too small ({detail})"
    if not (MIN_COVERAGE <= opacity <= MAX_COVERAGE):
        return False, f"ink coverage out of band ({detail})"
    return True, detail


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("npc_id")
    parser.add_argument("--desc", required=True, help="character description, no view/pose")
    parser.add_argument("--seed", type=int, default=None,
                        help="base seed; frames derive from it for reproducibility")
    parser.add_argument("--dry-run", action="store_true", help="print prompts, spend nothing")
    args = parser.parse_args()

    env = read_env()
    api_key = env.get("OPENROUTER_API_KEY", os.environ.get("OPENROUTER_API_KEY", ""))
    # The server reads HKS_IMAGE_MODEL; the operator's .env may use IMAGE_GENERATION_MODEL.
    model = (
        env.get("HKS_IMAGE_MODEL")
        or env.get("IMAGE_GENERATION_MODEL")
        or "bytedance-seed/seedream-5-0-flash"
    )

    frames = [(d, p) for d in COLUMNS for p in ROWS]

    if args.dry_run:
        print(f"model: {model}")
        print(f"frames: {len(frames)} (anchor {ANCHOR[0]}/{ANCHOR[1]} generated first)")
        for direction, pose in frames:
            anchored = (direction, pose) != ANCHOR
            print(f"\n--- {args.npc_id}_walk_{direction}_{pose} (anchor ref: {anchored})")
            print(build_prompt(args.desc, direction, pose, anchored=anchored))
        return 0

    if not api_key:
        print("OPENROUTER_API_KEY is not set in .env", file=sys.stderr)
        return 2

    bible, bible_path = style_bible_reference()
    target = templates.TARGETS["sprite"][1]
    cell = (target[0] + 2, target[1] + 2)  # the outline adds 1px per side
    ART.mkdir(parents=True, exist_ok=True)

    total_cost = 0.0
    failures: list[str] = []
    anchor_png: bytes | None = None
    anchor_path = ""

    with httpx.Client(timeout=120.0) as client:
        for direction, pose in frames:
            subject = f"{args.npc_id}_walk_{direction}_{pose}"
            anchored = (direction, pose) != ANCHOR
            prompt = build_prompt(args.desc, direction, pose, anchored=anchored and anchor_png is not None)

            references: list[dict] = []
            reference_paths: list[str] = []
            if bible:
                references.append(bible)
                reference_paths.append(bible_path)
            if anchored and anchor_png is not None:
                references.append(data_url(anchor_png))
                reference_paths.append(anchor_path)

            png: bytes | None = None
            processed: bytes | None = None
            seed_used: int | None = None
            seed_returned = 0
            cost = 0.0

            for attempt in range(1, MAX_ATTEMPTS + 1):
                attempt_seed = None if args.seed is None else args.seed + (attempt - 1)
                try:
                    png, seed_returned, cost = httpx_generate(
                        client, api_key=api_key, model=model, prompt=prompt,
                        references=references, seed=attempt_seed,
                    )
                    processed = pixelate.process(png, target, outline=True, pad=0)
                except Exception as exc:  # noqa: BLE001 - retry the frame, then report
                    print(f"  attempt {attempt} failed for {subject}: {exc}", file=sys.stderr)
                    total_cost += cost
                    cost = 0.0
                    continue

                total_cost += cost
                ok, detail = silhouette_ok(processed, cell)
                if ok:
                    seed_used = attempt_seed
                    print(f"wrote {subject.rsplit('/', 1)[-1]}  seed={attempt_seed}  {detail}  ${cost:.4f}")
                    break
                print(f"  attempt {attempt}: {subject} rejected — {detail}", file=sys.stderr)
                seed_used = attempt_seed
                processed = None

            if processed is None:
                failures.append(subject)
                continue

            out = ART / f"{subject}.png"
            out.write_bytes(processed)

            now = datetime.now(timezone.utc)
            provenance = {
                "prompt_id": "gen_%s_%s" % (now.strftime("%Y%m%d"), secrets.token_hex(3)),
                "model": model,
                # The images endpoint does not reliably echo the seed it was given — it reported
                # 0 for a request that set 4242. "Regenerate this sprite exactly" (§8.4) needs
                # what we ASKED for, so `seed` records the request and `seed_returned` keeps the
                # service's answer rather than silently losing one of the two.
                "seed": seed_used,
                "seed_returned": seed_returned,
                "resolution": RESOLUTION,
                "aspect_ratio": "3:4",
                "background": "transparent",
                "input_references": reference_paths,
                "post": {
                    "palette": palette.PALETTE_NAME,
                    "target_px": list(target),
                    "outline": True,
                    "pad": 0,
                },
                "cost_usd": cost,
                "accepted_by": "tools/gen_npc_walk_frames",
                "ts": now.isoformat(),
                "prompt": prompt,
            }
            out.with_suffix(".gen.json").write_text(
                json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )

            if (direction, pose) == ANCHOR:
                anchor_png = processed
                anchor_path = f"art/npcs/{subject}.png"

    print(f"\ntotal cost: ${total_cost:.4f}   failures: {len(failures)}")
    if failures:
        print("failed frames: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


def httpx_generate(client: httpx.Client, *, api_key: str, model: str, prompt: str,
                   references: list[dict], seed: int | None) -> tuple[bytes, int, float]:
    payload: dict = {
        "model": model,
        "prompt": prompt,
        "resolution": RESOLUTION,
        "aspect_ratio": "3:4",
        "background": "transparent",
    }
    if seed is not None:
        payload["seed"] = int(seed)
    if references:
        payload["input_references"] = references

    response = client.post(IMAGE_URL, json=payload, headers={"Authorization": f"Bearer {api_key}"})
    if response.status_code != 200:
        raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
    data = response.json()
    items = data.get("data") or []
    if not items or not items[0].get("b64_json"):
        raise RuntimeError("images endpoint returned no image")
    png = base64.b64decode(items[0]["b64_json"])
    usage = data.get("usage") or {}
    return png, int(items[0].get("seed", 0) or 0), float(usage.get("cost", 0.0) or 0.0)


if __name__ == "__main__":
    raise SystemExit(main())
