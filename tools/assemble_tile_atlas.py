#!/usr/bin/env python3
"""Assemble the tile atlas from generated tiles (client/content/art/tiles/).

Every location's `legend` reads four atlas coordinates: '.' [0,0] floor, ',' [1,0] alt,
'#' [2,0] wall, 'D' [3,0] door — so the atlas is four 24px tiles in one 96px row. The tiles
come from the admin art pipeline (palette-snapped, no outline); this composites them over
the placeholder atlas, backing the original up once so a rollback stays possible.

Usage: python3 tools/assemble_tile_atlas.py [--prefix _2027] [--out NAME.png]
"""
import argparse
import os
import shutil

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, "client", "content", "art", "tiles")
ASSETS = os.path.join(ROOT, "client", "assets", "tiles")
ORDER = ["floor", "alt", "wall", "door"]
TILE = 24


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default="", help="subject suffix, e.g. _2027")
    parser.add_argument("--out", default="p1_tiles.png", help="atlas file name")
    args = parser.parse_args()

    atlas_path = os.path.join(ASSETS, args.out)
    backup = atlas_path.replace(".png", "_placeholder.png")
    if args.prefix == "" and not os.path.exists(backup):
        shutil.copy(atlas_path, backup)
        print("backed up the placeholder atlas -> %s" % backup)

    atlas = Image.new("RGBA", (TILE * len(ORDER), TILE), (0, 0, 0, 0))
    for index, name in enumerate(ORDER):
        path = os.path.join(TILES, name + args.prefix + ".png")
        tile = Image.open(path).convert("RGBA")
        if tile.size != (TILE, TILE):
            tile = tile.resize((TILE, TILE), Image.NEAREST)
        atlas.paste(tile, (index * TILE, 0))
        print("  [%d,0] %s" % (index, os.path.basename(path)))
    atlas.save(atlas_path)
    print("wrote %s (%dx%d)" % (atlas_path, atlas.width, atlas.height))


if __name__ == "__main__":
    main()