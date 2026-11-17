#!/usr/bin/env python3
"""Wire generated sprite sheets into NPC definitions (PLAN §8).

For every npc JSON whose id has a generated sprite at content/art/npcs/<id>.png, set
`sprite: {sheet, frames:{idle:[0]}}` unless one is already set. Run after the sprite
generation loop, then regenerate the manifest.

Usage: python3 tools/wire_npc_sprites.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "client", "content")
ART = os.path.join(CONTENT, "art", "npcs")


def main():
    wired = skipped = 0
    for name in sorted(os.listdir(os.path.join(CONTENT, "npcs"))):
        if not name.endswith(".json"):
            continue
        path = os.path.join(CONTENT, "npcs", name)
        npc = json.loads(open(path, encoding="utf-8").read())
        npc_id = str(npc.get("id", ""))
        sprite_path = os.path.join(ART, npc_id + ".png")
        if not os.path.isfile(sprite_path):
            continue
        existing = npc.get("sprite")
        if isinstance(existing, dict) and existing.get("sheet"):
            skipped += 1
            continue
        npc["sprite"] = {"sheet": "art/npcs/%s.png" % npc_id, "frames": {"idle": [0]}}
        open(path, "w", encoding="utf-8").write(
            json.dumps(npc, ensure_ascii=False, indent=2) + "\n")
        wired += 1
        print("wired %s" % npc_id)
    print("wired %d, already set %d" % (wired, skipped))


if __name__ == "__main__":
    main()