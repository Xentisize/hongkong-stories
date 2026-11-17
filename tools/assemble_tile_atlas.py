#!/usr/bin/env python3
"""Assemble the tile atlas from generated tiles (client/content/art/tiles/).

Every location's `legend` reads four atlas coordinates: '.' [0,0] floor, ',' [1,0] alt,
'#' [2,0] wall, 'D' [3,0] door — so the atlas is four 24px tiles in one 96px row. The tiles
come from the admin art pipeline (palette-snapped, no outline); this composites them over
the placeholder atlas, backing the original up once so a rollback stays possible.

Usage: python3 tools/assemble_tile_atlas.py
"""
import os
import shutil

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, "client", "content", "art", "tiles")
ATLAS = os.path.join(ROOT, "client", "assets", "tiles", "p1_tiles.png")
BACKUP = ATLAS.replace(".png", "_placeholder.png")
ORDER = ["floor", "alt", "wall", "door"]
TILE = 24


def main():
    if not os.path.exists(BACKUP):
        shutil.copy(ATLAS, BACKUP)
        print("backed up the placeholder atlas -> %s" % BACKUP)

    atlas = Image.new("RGBA", (TILE * len(ORDER), TILE), (0, 0, 0, 0))
    for index, name in enumerate(ORDER):
        path = os.path.join(TILES, name + ".png")
        tile = Image.open(path).convert("RGBA")
        if tile.size != (TILE, TILE):
            tile = tile.resize((TILE, TILE), Image.NEAREST)
        atlas.paste(tile, (index * TILE, 0))
        print("  [%d,0] %s <- %s" % (index, name, os.path.basename(path)))
    atlas.save(ATLAS)
    print("wrote %s (%dx%d)" % (ATLAS, atlas.width, atlas.height))


if __name__ == "__main__":
    main()