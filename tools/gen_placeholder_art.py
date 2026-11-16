#!/usr/bin/env python3
"""Generate the P1 placeholder pixel art (docs/PLAN.md §8 groundwork).

Why a generator instead of PNGs checked in from an editor: the Seedream pipeline in P4 also
emits assets programmatically, and this proves the same loop — deterministic input, committed
tool, reproducible output, reviewable diff. These tiles are placeholders for the real
generated art, and they are honest about it: no fake texture noise, just clean readable shapes
at the project's 24px tile scale.

Usage:  python3 tools/gen_placeholder_art.py
Output: client/assets/tiles/p1_tiles.png   (96x24 atlas: floor_a, floor_b, wall, door)
        client/assets/sprites/item_rusty_key.png (16x16)

Stdlib only — no Pillow, because the repo does not depend on it yet.
"""
import os
import struct
import zlib

TILE = 24
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Warm interior palette, 4 shades per material. Kept tiny on purpose (§8.2 fixed palette).
FLOOR = (122, 92, 66)
FLOOR_DARK = (92, 68, 48)
FLOOR_LIGHT = (138, 106, 78)
WALL = (74, 66, 62)
WALL_MORTAR = (56, 50, 47)
WALL_LIGHT = (92, 83, 77)
DOOR_FRAME = (96, 60, 38)
DOOR_DARK = (44, 32, 26)
DOOR_HANDLE = (214, 176, 84)
BRASS = (196, 164, 92)
BRASS_DARK = (110, 88, 44)
TRANSPARENT = (0, 0, 0, 0)


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [[TRANSPARENT for _ in range(w)] for _ in range(h)]

    def rect(self, x, y, w, h, color):
        c = tuple(color) + ((255,) if len(color) == 3 else ())
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if 0 <= xx < self.w and 0 <= yy < self.h:
                    self.px[yy][xx] = c

    def dot(self, x, y, color):
        self.rect(x, y, 1, 1, color)

    def hline(self, x, y, w, color):
        self.rect(x, y, w, 1, color)

    def vline(self, x, y, h, color):
        self.rect(x, y, 1, h, color)

    def blit(self, other, ox, oy):
        for yy in range(other.h):
            for xx in range(other.w):
                pixel = other.px[yy][xx]
                if pixel[3] == 0:
                    continue
                tx, ty = ox + xx, oy + yy
                if 0 <= tx < self.w and 0 <= ty < self.h:
                    self.px[ty][tx] = pixel


def write_png(path, canvas):
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in canvas.px)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", canvas.w, canvas.h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)
    print("wrote %s (%dx%d, %d bytes)" % (path, canvas.w, canvas.h, len(png)))


def floor_tile(scuffed=False):
    t = Canvas(TILE, TILE)
    t.rect(0, 0, TILE, TILE, FLOOR)
    # Three planks with a dark seam and a light upper edge on each.
    for seam_y in (7, 15, 23):
        t.hline(0, seam_y, TILE, FLOOR_DARK)
        t.hline(0, seam_y - 7, TILE, FLOOR_LIGHT)
    # Staggered board ends, which is what stops a tile grid reading as a grid.
    t.vline(11, 0, 7, FLOOR_DARK)
    t.vline(19, 8, 7, FLOOR_DARK)
    t.vline(5, 16, 7, FLOOR_DARK)
    if scuffed:
        for (x, y) in ((15, 4), (16, 5), (17, 4), (16, 3), (3, 12), (4, 13), (2, 13)):
            t.dot(x, y, FLOOR_DARK)
    return t


def wall_tile():
    t = Canvas(TILE, TILE)
    t.rect(0, 0, TILE, TILE, WALL)
    # Two brick courses with offset vertical mortar, plus a 1px lit top edge per brick.
    for course in range(2):
        top = course * 12
        t.hline(0, top + 11, TILE, WALL_MORTAR)
        t.hline(0, top, TILE, WALL_LIGHT)
        offset = 0 if course % 2 == 0 else 12
        t.vline((offset + 11) % TILE, top, 11, WALL_MORTAR)
        t.vline((offset + 23) % TILE, top, 11, WALL_MORTAR)
    return t


def door_tile():
    t = Canvas(TILE, TILE)
    t.rect(0, 0, TILE, TILE, DOOR_FRAME)
    t.rect(3, 2, 18, 22, DOOR_DARK)
    # Two inset panels and a brass handle — readable at 1x and at 5x.
    t.rect(6, 5, 12, 7, DOOR_FRAME)
    t.rect(7, 6, 10, 5, (58, 42, 33))
    t.rect(6, 15, 12, 7, DOOR_FRAME)
    t.rect(7, 16, 10, 5, (58, 42, 33))
    t.rect(17, 12, 2, 2, DOOR_HANDLE)
    return t


def key_icon():
    t = Canvas(16, 16)
    # Ring (8x8 hollow square, cheap approximation of a bow).
    t.rect(1, 4, 8, 8, BRASS_DARK)
    t.rect(2, 5, 6, 6, TRANSPARENT)
    t.rect(2, 5, 6, 2, BRASS)
    t.rect(2, 9, 6, 2, BRASS)
    # Shaft + two teeth.
    t.rect(8, 6, 7, 4, BRASS)
    t.rect(8, 6, 7, 1, BRASS_DARK)
    t.rect(12, 9, 1, 3, BRASS)
    t.rect(14, 9, 1, 2, BRASS)
    t.rect(13, 9, 1, 2, BRASS_DARK)
    return t


def main():
    atlas = Canvas(TILE * 4, TILE)
    atlas.blit(floor_tile(False), 0, 0)
    atlas.blit(floor_tile(True), TILE, 0)
    atlas.blit(wall_tile(), TILE * 2, 0)
    atlas.blit(door_tile(), TILE * 3, 0)
    write_png(os.path.join(ROOT, "client/assets/tiles/p1_tiles.png"), atlas)
    write_png(os.path.join(ROOT, "client/assets/sprites/item_rusty_key.png"), key_icon())


if __name__ == "__main__":
    main()
