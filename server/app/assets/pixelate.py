"""Seedream → game-ready PNG (PLAN 8): the post-processor is the highest-leverage tooling.

Seedream renders illustration; raw, a 1K render downscaled to 32px becomes mud. This module
turns a render into a palette-pure, outlined, game-ready sprite:

1. crop to the subject bounding box (alpha trim),
2. NEAREST-downscale to the pixel target,
3. snap every pixel onto the fixed project palette (§8.2 — the consistency lever),
4. threshold alpha, then force a 1px dark outline around the silhouette,
5. encode PNG bytes.

The plan lists palette-snapping before the downscale; snapping the few hundred final pixels
instead gives the identical palette-pure result without a 30-second pure-Python pass over a
1K image. Pillow is an optional dependency group (`uv sync --group art`) because chat must
run even where fresh-interpreter wheels lag (PLAN 10.6).
"""

from __future__ import annotations

import io

from .palette import HK_PALETTE_V1, OUTLINE_COLOR

ALPHA_THRESHOLD = 128


def process(png_bytes: bytes, target: tuple[int, int], *, outline: bool = True) -> bytes:
    try:
        from PIL import Image, ImageChops, ImageFilter
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise RuntimeError(
            "Pillow is not installed — enable the art extras with `uv sync --group art`"
        ) from exc

    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")

    # 1. Crop to the subject: the alpha channel's bounding box.
    bbox = image.split()[3].getbbox()
    if bbox:
        image = image.crop(bbox)

    # 2. Downscale with NEAREST — never a smoothed blur at pixel-art sizes.
    image = image.resize(target, Image.NEAREST)

    # 3. Snap every surviving pixel to the fixed palette.
    palette = HK_PALETTE_V1
    pixels = image.load()
    for y in range(target[1]):
        for x in range(target[0]):
            r, g, b, a = pixels[x, y]
            if a < ALPHA_THRESHOLD:
                pixels[x, y] = (0, 0, 0, 0)
                continue
            pixels[x, y] = _nearest(r, g, b, a)

    # 4. Force a 1px dark outline. The crop leaves the subject flush with its bounding box,
    # so the ring needs room: pad the canvas by 1px on every side first — the subject keeps
    # its target size and the finished sheet is target + 2.
    if outline:
        padded = Image.new("RGBA", (target[0] + 2, target[1] + 2), (0, 0, 0, 0))
        padded.paste(image, (1, 1))
        image = padded
        alpha = image.split()[3].point(lambda v: 255 if v >= ALPHA_THRESHOLD else 0)
        dilated = alpha.filter(ImageFilter.MaxFilter(3))
        ring = ImageChops.subtract(dilated, alpha)
        dark = Image.new("RGBA", image.size, OUTLINE_COLOR)
        image.paste(dark, (0, 0), ring)

    # 5. Encode.
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _nearest(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    best = None
    best_distance = -1
    for pr, pg, pb in HK_PALETTE_V1:
        distance = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb)
        if best is None or distance < best_distance:
            best = (pr, pg, pb, 255)
            best_distance = distance
    return best if best is not None else (r, g, b, a)