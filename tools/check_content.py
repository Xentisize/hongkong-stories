#!/usr/bin/env python3
"""Validate client/content (PLAN 9.2, 11) — the CI gate over the publish pipeline.

Usage: python3 tools/check_content.py [content_dir]

Exit code 0 when no error-level issues (warnings are reported but do not fail).
"""
import os
import sys
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

from app.content import ContentStore  # noqa: E402
from app.content_validate import validate_store  # noqa: E402


def main() -> int:
    raw = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "client", "content")
    store = ContentStore.load(Path(raw) if not isinstance(raw, Path) else raw)
    issues = validate_store(store)
    errors = [i for i in issues if i["level"] == "error"]
    warnings = [i for i in issues if i["level"] == "warn"]
    print(f"validated {sum(len(t) for t in store.tables.values())} entities "
          f"({len(errors)} errors, {len(warnings)} warnings)")
    for item in issues:
        marker = "E" if item["level"] == "error" else "W"
        print(f"  [{marker}] {item['path']}: {item['message']}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
