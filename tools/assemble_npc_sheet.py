#!/usr/bin/env python3
"""Assemble NPC walk sheets from generated frames (the player's pipeline, generalized).

Layout: 4 columns (down, right, left, up) x 2 rows (stand, step); each cell 26x34 (the
sprite kind's 24x32 subject + its 1px outline). Frames are <npc_id>_walk_<dir>_<pose>.png
in content/art/npcs/; the sheet is <npc_id>_walk.png. npc_body reads cells by (facing,
walk phase) exactly like the player.

Usage: python3 tools/assemble_npc_sheet.py npc_ch01_tai npc_ch01_ken ...
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "client", "content", "art", "npcs")
CELL_W, CELL_H = 26, 34
COLUMNS = ["down", "right", "left", "up"]
ROWS = ["stand", "step"]


def assemble(npc_id: str) -> None:
    sheet = Image.new("RGBA", (CELL_W * len(COLUMNS), CELL_H * len(ROWS)), (0, 0, 0, 0))
    for col, direction in enumerate(COLUMNS):
        for row, pose in enumerate(ROWS):
            path = os.path.join(ART, f"{npc_id}_walk_{direction}_{pose}.png")
            frame = Image.open(path).convert("RGBA")
            if frame.size != (CELL_W, CELL_H):
                frame = frame.resize((CELL_W, CELL_H), Image.NEAREST)
            sheet.paste(frame, (col * CELL_W, row * CELL_H))
    out = os.path.join(ART, f"{npc_id}_walk.png")
    sheet.save(out)
    print(f"wrote {out} ({sheet.width}x{sheet.height})")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for npc_id in sys.argv[1:]:
        assemble(npc_id)


if __name__ == "__main__":
    main()