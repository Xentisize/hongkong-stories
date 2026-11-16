#!/usr/bin/env python3
"""Write client/content/manifest.json (docs/PLAN.md §5.7).

Discovery has to be manifest-driven rather than a directory scan: an exported Godot build may
store `.json` as an imported resource (`item.json.remap`), which a naive scan lists under a
different name and then fails to read. The manifest is also what the P4 hot-pack endpoint will
serve, so this is not a workaround — it is the interface.

Usage: python3 tools/gen_content_manifest.py
"""
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "client", "content")
KINDS = ["npcs", "items", "locations", "quests", "lore"]


def main():
    files = []
    digest = hashlib.sha256()
    for kind in KINDS:
        directory = os.path.join(CONTENT, kind)
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".json"):
                continue
            relative = "%s/%s" % (kind, name)
            files.append(relative)
            digest.update(relative.encode("utf-8"))
            with open(os.path.join(directory, name), "rb") as handle:
                digest.update(handle.read())

    manifest = {
        "manifest_schema": 1,
        "version": 1,
        "content_hash": digest.hexdigest()[:12],
        "files": files,
    }
    out_path = os.path.join(CONTENT, "manifest.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print("wrote %s (%d files, hash %s)" % (out_path, len(files), manifest["content_hash"]))
    for entry in files:
        print("  " + entry)


if __name__ == "__main__":
    main()
