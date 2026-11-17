#!/usr/bin/env python3
"""Assemble the player walk sheet from generated frames (client/content/art/npcs/).

Layout: 4 columns (down, right, left, up) x 2 rows (stand, step); each cell is 26x34 (the
sprite kind's 24x32 subject + its 1px outline). The frames land in art/npcs/ as
player_walk_<dir>_<pose>.png via the admin art pipeline; this composites them into
player_walk.png. The player's _draw reads cells by (facing, walk phase).

Usage: python3 tools/assemble_player_sheet.py
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "client", "content", "art", "npcs")
OUT = os.path.join(ART, "player_walk.png")
CELL_W, CELL_H = 26, 34
COLUMNS = ["down", "right", "left", "up"]
ROWS = ["stand", "step"]


def main():
    sheet = Image.new("RGBA", (CELL_W * len(COLUMNS), CELL_H * len(ROWS)), (0, 0, 0, 0))
    for col, direction in enumerate(COLUMNS):
        for row, pose in enumerate(ROWS):
            path = os.path.join(ART, "player_walk_%s_%s.png" % (direction, pose))
            frame = Image.open(path).convert("RGBA")
            if frame.size != (CELL_W, CELL_H):
                frame = frame.resize((CELL_W, CELL_H), Image.NEAREST)
            sheet.paste(frame, (col * CELL_W, row * CELL_H))
            print("  cell [%d,%d] %s/%s" % (col, row, direction, pose))
    sheet.save(OUT)
    print("wrote %s (%dx%d)" % (OUT, sheet.width, sheet.height))


if __name__ == "__main__":
    main()