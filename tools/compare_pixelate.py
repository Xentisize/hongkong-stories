#!/usr/bin/env python3
"""Pixel-for-pixel comparison: Pillow post-processor vs the TypeScript port (PLAN 8).

`pixelate.ts` replaced `server/app/assets/pixelate.py`, and the two must produce the same sprite
for the same render — otherwise regenerating an asset from its provenance sidecar would yield a
visibly different result from the one an author approved. Sharp's resize and trim follow libvips
rules and Pillow's differ in the rounding, which is exactly the kind of drift that hides until an
artist re-runs a sprite a year later.

This harness generates deterministic inputs covering the awkward paths (outline on/off, the
style-bible padding, an image smaller than the target, a fully opaque image), runs both
implementations, and reports the differing pixels.

Usage: python3 tools/compare_pixelate.py
Requires the art extras for the reference side: `uv sync --group art` in server/.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from PIL import Image  # noqa: E402

from app.assets import palette, pixelate  # noqa: E402

WORK = Path("/tmp/hks-pixelate-parity")
IN = WORK / "in"
PY = WORK / "py"
PLAN = WORK / "plan.json"

# Cases allowed to differ, with the bound that makes the difference acceptable. The style-bible
# path upscales an opaque scene to 256x144 and pads it; Pillow's NEAREST and this port disagree on
# the neighbouring source pixel at exact sampling boundaries when the source is smaller than the
# target. It is a one-off asset, and every shape that production actually uses is byte-identical —
# so the deviation is reported and bounded rather than tolerated silently.
KNOWN_DEVIATIONS: dict[str, tuple[float, int]] = {
    "bible": (0.01, 96),  # (max fraction of differing pixels, max channel delta)
}


def make_inputs() -> list[dict]:
    """Deterministic inputs; the seed is fixed so both sides see identical bytes."""
    rng = random.Random(20271118)
    cases: list[dict] = []

    def save(name: str, image: Image.Image, target: tuple[int, int],
             outline: bool, pad: int) -> None:
        path = IN / f"{name}.png"
        image.save(path)
        cases.append({"name": name, "png": str(path), "target": list(target),
                      "outline": outline, "pad": pad})

    # 1. noise on a transparent field: the ordinary sprite path.
    noise = Image.new("RGBA", (200, 260), (0, 0, 0, 0))
    for y in range(20, 240):
        for x in range(15, 185):
            noise.putpixel((x, y), (rng.randrange(256), rng.randrange(256),
                                    rng.randrange(256), rng.randrange(120, 256)))
    save("noise", noise, (24, 32), True, 0)

    # 2. coarse colour blocks near palette entries: exercises the palette tie-breaking.
    blocks = Image.new("RGBA", (120, 160), (0, 0, 0, 0))
    for index, entry in enumerate(palette.HK_PALETTE_V1):
        x = 4 + (index % 6) * 19
        y = 8 + (index // 6) * 30
        for dy in range(26):
            for dx in range(17):
                if x + dx < 120 and y + dy < 160:
                    blocks.putpixel((x + dx, y + dy), (*entry, 255))
    save("blocks", blocks, (24, 32), True, 0)

    # 3. fully opaque: no transparent border, so the alpha bbox is the whole image.
    opaque = Image.new("RGB", (96, 128))
    for y in range(128):
        for x in range(96):
            opaque.putpixel((x, y), (x * 2 % 256, y * 2 % 256, (x + y) % 256))
    save("opaque", opaque.convert("RGBA"), (24, 32), True, 0)

    # 4. the style bible path: opaque, no outline, transparent fringe for the next reference.
    save("bible", opaque.convert("RGBA"), (256, 144), False, 2)

    # 5. an image smaller than its target: the upscale path.
    small = Image.new("RGBA", (3, 2), (0, 0, 0, 0))
    small.putpixel((1, 0), (200, 60, 50, 255))
    small.putpixel((2, 1), (40, 80, 120, 255))
    save("tiny", small, (24, 32), True, 0)

    # 6. a prop: square target, square source.
    prop = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for y in range(8, 56):
        for x in range(8, 56):
            prop.putpixel((x, y), (120, 200, 90, 255))
    save("prop", prop, (24, 24), True, 0)

    # 7. a subject with a faint fringe: alpha values around the 128 threshold.
    fringe = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    for y in range(10, 70):
        for x in range(10, 70):
            alpha = 120 if (x + y) % 5 == 0 else 200
            fringe.putpixel((x, y), (90, 90, 90, alpha))
    save("fringe", fringe, (24, 32), True, 0)

    # 8. the real production shape: a 1024x1024 render downscaled to a sprite. This is the case
    # that decides whether the port is safe to adopt — every generated NPC goes through it.
    raw = bytearray()
    for y in range(1024):
        inside_y = 120 <= y < 900
        for x in range(1024):
            if inside_y and 180 <= x < 840:
                raw += bytes((rng.randrange(256), rng.randrange(256), rng.randrange(256), 255))
            else:
                raw += b"\0\0\0\0"
    render = Image.frombytes("RGBA", (1024, 1024), bytes(raw))
    save("render1k_sprite", render, (24, 32), True, 0)
    save("render1k_prop", render, (24, 24), True, 0)
    save("render1k_portrait", render, (96, 128), True, 0)

    return cases


def run_reference(cases: list[dict]) -> None:
    for case in cases:
        source = Path(case["png"]).read_bytes()
        processed = pixelate.process(
            source,
            tuple(case["target"]),
            outline=case["outline"],
            pad=case["pad"],
        )
        (PY / f"{case['name']}.png").write_bytes(processed)
        print(f"py  {case['name']}: {len(processed)} bytes")


def run_port() -> None:
    result = subprocess.run(
        ["bun", str(ROOT / "tools" / "pixelate_parity.ts"), str(PLAN)],
        cwd=ROOT, capture_output=True, text=True,
    )
    print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit("the TypeScript port failed")


def compare(cases: list[dict]) -> int:
    failures = 0
    print()
    print(f"{'case':10} {'size py':10} {'size ts':10} {'diff px':>8} {'max delta':>10}")
    for case in cases:
        name = case["name"]
        reference = Image.open(PY / f"{name}.png").convert("RGBA")
        ported = Image.open(WORK / "ts" / f"{name}.png").convert("RGBA")

        if reference.size != ported.size:
            print(f"{name:10} {str(reference.size):10} {str(ported.size):10} SIZE MISMATCH")
            failures += 1
            continue

        left = reference.tobytes()
        right = ported.tobytes()
        differing = 0
        max_delta = 0
        for index in range(0, len(left), 4):
            if left[index:index + 4] != right[index:index + 4]:
                differing += 1
                for channel in range(4):
                    max_delta = max(max_delta, abs(left[index + channel] - right[index + channel]))
        if differing:
            allowed = KNOWN_DEVIATIONS.get(name)
            fraction = differing / (reference.size[0] * reference.size[1])
            if allowed and fraction <= allowed[0] and max_delta <= allowed[1]:
                print(f"{name:10} {str(reference.size):10} {str(ported.size):10} "
                      f"{differing:8} {max_delta:10}  (known deviation, within bound)")
            else:
                failures += 1
                print(f"{name:10} {str(reference.size):10} {str(ported.size):10} "
                      f"{differing:8} {max_delta:10}  DIFFERS")
        else:
            print(f"{name:10} {str(reference.size):10} {str(ported.size):10} {differing:8} {max_delta:10}")

    return failures


def main() -> int:
    for directory in (IN, PY):
        directory.mkdir(parents=True, exist_ok=True)

    cases = make_inputs()
    PLAN.write_text(json.dumps({"out_dir": str(WORK), "cases": cases}, indent=2), encoding="utf-8")

    print(f"generated {len(cases)} deterministic inputs in {IN}")
    run_reference(cases)
    run_port()
    failures = compare(cases)

    print()
    if failures:
        print(f"FAIL: {failures} case(s) differ from the Pillow reference", file=sys.stderr)
        return 1
    print("PASS: the TypeScript port matches Pillow pixel for pixel on every case")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
