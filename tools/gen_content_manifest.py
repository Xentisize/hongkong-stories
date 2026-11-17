#!/usr/bin/env python3
"""Write client/content/manifest.json (docs/PLAN.md §5.7).

Discovery has to be manifest-driven rather than a directory scan: an exported Godot build may
store `.json` as an imported resource (`item.json.remap`), which a naive scan lists under a
different name and then fails to read. The manifest is also what the P4 hot-pack endpoint will
serve, so this is not a workaround — it is the interface.

Usage: python3 tools/gen_content_manifest.py [--bump] [content_dir]

`--bump` increments the existing manifest version (the admin publish path, PLAN 9.2); the
bare form keeps the version at 1 for a fresh checkout. An optional content_dir overrides the
default client/content (used by tests that publish into an isolated copy).
"""
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "client", "content")
KINDS = ["npcs", "items", "locations", "quests", "lore"]


def main():
    args = sys.argv[1:]
    bump = "--bump" in args
    positional = [a for a in args if not a.startswith("--")]
    content_root = os.path.abspath(positional[0]) if positional else CONTENT

    files = []
    digest = hashlib.sha256()
    for kind in KINDS:
        directory = os.path.join(content_root, kind)
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

    version = 1
    manifest_path = os.path.join(content_root, "manifest.json")
    if bump and os.path.isfile(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as handle:
            version = int(json.load(handle).get("version", 0)) + 1

    manifest = {
        "manifest_schema": 1,
        "version": version,
        "content_hash": digest.hexdigest()[:12],
        "files": files,
    }
    out_path = manifest_path
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print("wrote %s (v%d, %d files, hash %s)" % (
        out_path, version, len(files), manifest["content_hash"]))
    for entry in files:
        print("  " + entry)


if __name__ == "__main__":
    main()
