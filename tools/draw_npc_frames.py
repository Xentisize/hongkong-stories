#!/usr/bin/env python3
"""Hand-authored NPC walk frames, drawn pixel by pixel from one body plan.

Why code instead of generation for this character: two rounds of Seedream could not hold a
design across eight facings. Drawing from one parametric body plan makes consistency a property
of the code — the head is the same width in every facing because a single table says so.

This is authored pixel art, not Aseprite. Every pixel is deliberately placed, flat-shaded with
two or three tones per material, using only `hk_palette_v1` — that is what a hand pass buys.

## Proportions are the spec

The cast is 3.5-4 heads tall. An earlier version of this sprite was 2.5 heads and read as a
toddler next to it, so the row budget below is explicit: head 9 rows, neck 1, torso 10, belt 2,
legs 8, boots 2 — 32 rows, 3.6 heads. Change `HEAD_FRONT` and the rest must move with it.

Silhouettes are written as per-row spans (y, x0, x1) rather than rectangles, because a rectangle
head reads as a box: the taper is the whole difference between "character" and "placeholder".

    python3 tools/draw_npc_frames.py --out /tmp/wai_hand
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from PIL import Image, ImageChops, ImageFilter  # noqa: E402

from app.assets.palette import HK_PALETTE_V1, OUTLINE_COLOR  # noqa: E402

INNER = (24, 32)
CELL = (26, 34)
NONE = "."

_LETTERS = {
    "A": (26, 28, 34),     # near-black: eyes (same value as the outline, deliberately)
    "C": (46, 49, 56),     # dark grey       — trousers, brows, hair shadow
    "D": (74, 79, 88),     # mid grey        — hair base, boot highlight
    "E": (92, 96, 88),     # shadow concrete — shirt shadow / seams / folds
    "F": (110, 82, 50),    # mid wood        — meter notebook
    "O": (139, 142, 133),  # concrete        — shirt base
    "Q": (201, 163, 124),  # skin shadow
    "V": (232, 192, 106),  # amber           — key ring
    "W": (232, 201, 160),  # skin
    "Z": (154, 160, 168),  # light grey      — hair highlight, chest highlight
}

# --- body plan: 32 rows, 3.6 heads -----------------------------------------------------
HEAD_FRONT = [
    (1, 9, 14), (2, 7, 16), (3, 6, 17), (4, 5, 18), (5, 5, 18),
    (6, 6, 17), (7, 7, 16), (8, 8, 15), (9, 9, 14),
]
# Profile keeps its width: losing pixels of head width is what made generated side views read
# as a different character.
HEAD_SIDE = [
    (1, 9, 14), (2, 8, 16), (3, 7, 17), (4, 6, 18), (5, 6, 18),
    (6, 7, 17), (7, 7, 17), (8, 8, 16), (9, 9, 15),
]

NECK = [(10, 10, 13)]

TORSO = [
    (11, 7, 16), (12, 6, 17), (13, 5, 18), (14, 5, 18), (15, 5, 18),
    (16, 5, 18), (17, 6, 17), (18, 6, 17), (19, 7, 16), (20, 7, 16),
]
BELT = [(21, 7, 16), (22, 7, 16)]

LEGS_STAND = [
    (23, 8, 11), (24, 8, 11), (25, 8, 11), (26, 8, 11), (27, 8, 11), (28, 8, 11),
    (29, 8, 10), (30, 8, 10),
    (23, 13, 16), (24, 13, 16), (25, 13, 16), (26, 13, 16), (27, 13, 16), (28, 13, 16),
    (29, 14, 16), (30, 14, 16),
]
BOOTS_STAND = [(31, 7, 11), (32, 7, 11), (31, 12, 16), (32, 12, 16)]

# Mid-stride: the forward leg reaches lower and wider, the trailing leg lifts.
LEGS_STEP = [
    (23, 7, 10), (24, 7, 10), (25, 7, 10), (26, 7, 10), (27, 7, 10), (28, 7, 10),
    (29, 7, 9), (30, 7, 9),
    (23, 13, 16), (24, 13, 16), (25, 13, 16), (26, 13, 16),
]
BOOTS_STEP = [(31, 6, 10), (32, 6, 10), (27, 12, 16), (28, 12, 16)]


def blank() -> list[list[str]]:
    return [[NONE for _ in range(INNER[0])] for _ in range(INNER[1])]


def paint(grid, spec, ch) -> None:
    """Fill (y, x0, x1) spans inclusively, clipped to the inner box."""
    for y, x0, x1 in spec:
        if not 0 <= y < INNER[1]:
            continue
        for x in range(max(0, x0), min(INNER[0], x1 + 1)):
            grid[y][x] = ch


def rect(grid, x0, y0, x1, y1, ch) -> None:
    for y in range(max(0, y0), min(INNER[1], y1 + 1)):
        for x in range(max(0, x0), min(INNER[0], x1 + 1)):
            grid[y][x] = ch


def pixel(grid, x, y, ch) -> None:
    if 0 <= x < INNER[0] and 0 <= y < INNER[1]:
        grid[y][x] = ch


def mirror(grid) -> list[list[str]]:
    return [list(reversed(row)) for row in grid]


# --- heads -----------------------------------------------------------------------------
def head_front(grid) -> None:
    paint(grid, HEAD_FRONT, "D")                      # hair mass
    rect(grid, 7, 5, 16, 9, "W")                      # face
    rect(grid, 7, 4, 16, 4, "D")                      # fringe over the brow
    pixel(grid, 11, 4, "W")
    pixel(grid, 12, 4, "W")                           # parting notch
    rect(grid, 8, 2, 11, 2, "Z")                      # grey highlight
    rect(grid, 14, 3, 16, 3, "Z")
    rect(grid, 5, 8, 6, 8, "C")                       # temple shadow
    rect(grid, 17, 8, 18, 8, "C")

    rect(grid, 7, 5, 16, 5, "Q")                      # forehead shadow under the fringe
    rect(grid, 9, 6, 10, 6, "C")                      # brows
    rect(grid, 13, 6, 14, 6, "C")
    pixel(grid, 9, 7, "A")                            # eyes
    pixel(grid, 14, 7, "A")
    pixel(grid, 8, 8, "Q")                            # cheeks
    pixel(grid, 15, 8, "Q")
    rect(grid, 11, 8, 12, 8, "Q")                     # nose
    rect(grid, 11, 9, 12, 9, "Q")                     # mouth
    pixel(grid, 4, 6, "Q")                            # ears
    pixel(grid, 19, 6, "Q")
    pixel(grid, 4, 7, "W")
    pixel(grid, 19, 7, "W")


def head_back(grid) -> None:
    paint(grid, HEAD_FRONT, "D")
    rect(grid, 8, 2, 11, 2, "Z")
    rect(grid, 14, 3, 16, 3, "Z")
    rect(grid, 7, 8, 16, 8, "E")                      # nape shadow
    rect(grid, 9, 9, 14, 9, "C")


def head_side(grid) -> None:
    paint(grid, HEAD_SIDE, "D")                       # hair mass (back of the head)
    rect(grid, 11, 5, 18, 9, "W")                     # face profile
    rect(grid, 6, 4, 11, 4, "D")                      # fringe sweeping forward
    rect(grid, 8, 2, 11, 2, "Z")
    rect(grid, 7, 3, 10, 3, "Z")
    pixel(grid, 16, 7, "A")                           # eye
    pixel(grid, 19, 7, "W")                           # nose step-out
    pixel(grid, 19, 8, "W")
    pixel(grid, 18, 9, "Q")                           # chin
    rect(grid, 12, 9, 17, 9, "Q")                     # jaw
    pixel(grid, 11, 8, "C")                           # sideburn
    pixel(grid, 11, 7, "Q")                           # ear
    pixel(grid, 12, 7, "Q")


# --- body ------------------------------------------------------------------------------
def torso(grid, *, facing: str) -> None:
    paint(grid, TORSO, "O")
    rect(grid, 5, 13, 5, 18, "E")                     # body shadow, left
    rect(grid, 18, 13, 18, 18, "E")                   # body shadow, right
    rect(grid, 7, 12, 11, 12, "Z")                    # chest highlight
    pixel(grid, 8, 16, "E")                           # fold shading
    pixel(grid, 8, 17, "E")
    pixel(grid, 15, 15, "E")
    pixel(grid, 15, 16, "E")
    rect(grid, 7, 20, 16, 20, "E")                    # hem shadow

    if facing == "right":
        rect(grid, 17, 11, 19, 13, "O")               # near sleeve
        rect(grid, 17, 14, 18, 18, "W")               # near forearm
        rect(grid, 17, 18, 18, 18, "Q")
        rect(grid, 5, 12, 6, 19, "E")                 # far arm in shadow
        return

    rect(grid, 4, 11, 5, 13, "O")                     # sleeves
    rect(grid, 18, 11, 19, 13, "O")
    rect(grid, 4, 14, 5, 18, "W")                     # forearms
    rect(grid, 18, 14, 19, 18, "W")
    rect(grid, 4, 18, 5, 18, "Q")                     # hands
    rect(grid, 18, 18, 19, 18, "Q")

    if facing == "down":
        rect(grid, 10, 11, 13, 11, "E")               # collar
        pixel(grid, 11, 11, "Q")
        pixel(grid, 12, 11, "Q")
        rect(grid, 11, 12, 12, 19, "E")               # placket
    else:
        rect(grid, 11, 12, 12, 20, "E")               # back seam


def belt(grid, *, facing: str) -> None:
    paint(grid, BELT, "C")
    rect(grid, 8, 21, 11, 21, "D")
    if facing == "down":
        rect(grid, 9, 21, 11, 23, "F")                # meter notebook
        pixel(grid, 14, 22, "V")                      # key ring
        pixel(grid, 14, 23, "V")
        pixel(grid, 15, 24, "V")
    elif facing == "right":
        rect(grid, 13, 21, 15, 23, "F")
        pixel(grid, 9, 22, "V")
        pixel(grid, 9, 23, "V")


def legs(grid, pose: str) -> None:
    if pose == "stand":
        paint(grid, LEGS_STAND, "C")
        rect(grid, 11, 23, 11, 30, "D")
        rect(grid, 16, 23, 16, 30, "D")
        paint(grid, BOOTS_STAND, "D")
    else:
        paint(grid, LEGS_STEP, "C")
        rect(grid, 10, 23, 10, 30, "D")
        rect(grid, 16, 23, 16, 26, "D")
        paint(grid, BOOTS_STEP, "D")


def build(facing: str, pose: str) -> list[list[str]]:
    grid = blank()
    if facing == "down":
        head_front(grid)
    elif facing == "up":
        head_back(grid)
    else:
        head_side(grid)

    paint(grid, NECK, "Q")
    torso(grid, facing=facing)
    belt(grid, facing=facing)
    legs(grid, pose)
    return mirror(grid) if facing == "left" else grid


def to_image(grid) -> Image.Image:
    inner = Image.new("RGBA", INNER, (0, 0, 0, 0))
    pixels = inner.load()
    for y in range(INNER[1]):
        for x in range(INNER[0]):
            ch = grid[y][x]
            if ch == NONE:
                continue
            r, g, b = _LETTERS[ch]
            pixels[x, y] = (r, g, b, 255)

    canvas = Image.new("RGBA", CELL, (0, 0, 0, 0))
    canvas.alpha_composite(inner, (1, 1))
    alpha = canvas.split()[3].point(lambda v: 255 if v >= 128 else 0)
    ring = ImageChops.subtract(alpha.filter(ImageFilter.MaxFilter(3)), alpha)
    canvas.paste(Image.new("RGBA", CELL, OUTLINE_COLOR), (0, 0), ring)
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--npc", default="npc_ch01_wai")
    parser.add_argument("--out", default="/tmp/hks_hand")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for facing in ("down", "right", "left", "up"):
        for pose in ("stand", "step"):
            path = out / f"{args.npc}_walk_{facing}_{pose}.png"
            to_image(build(facing, pose)).save(path)

    sheet = Image.new("RGBA", (CELL[0] * 4, CELL[1] * 2), (0, 0, 0, 0))
    for column, facing in enumerate(("down", "right", "left", "up")):
        for row, pose in enumerate(("stand", "step")):
            sheet.paste(
                Image.open(out / f"{args.npc}_walk_{facing}_{pose}.png"),
                (column * CELL[0], row * CELL[1]),
            )
    sheet_path = out / f"{args.npc}_walk.png"
    sheet.save(sheet_path)

    (out / "HAND_AUTHORED.txt").write_text(
        "Drawn pixel by pixel by tools/draw_npc_frames.py from one parametric body plan.\n"
        f"Palette: hk_palette_v1. Cell: {CELL[0]}x{CELL[1]} (24x32 subject + 1px outline).\n"
        "Proportions: 9-row head / 32 rows total = 3.6 heads, matching the cast.\n"
        "Not Aseprite: authored in code so the silhouette cannot drift between facings.\n",
        encoding="utf-8",
    )
    print(f"wrote {sheet_path} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
