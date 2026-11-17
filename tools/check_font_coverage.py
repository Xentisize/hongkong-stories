#!/usr/bin/env python3
"""Font glyph-coverage gate (docs/PLAN.md §6.5, §11).

Chinese text rendered with a Latin-only font is a wall of boxes. The project's rule is that the
bundled CJK fonts must cover every character the game can actually display — including ones a
language model invents at runtime. This checks the fonts' real cmaps (not their marketing claims)
against:

  1. a probe string of Cantonese-only characters, and
  2. every string in client/content/**/*.json.

Several fonts may be passed; coverage is the UNION, because Godot renders them as a fallback
chain (zh_hk default, zh_hans fallback) — which is also how the game is wired.

Run: python3 tools/check_font_coverage.py [font.ttf ...]
Exit code 1 if anything is missing, so CI can gate on it.
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "client/assets/fonts"
DEFAULT_FONTS = [FONT_DIR / "fusion-pixel-12px-monospaced-zh_hk.ttf",
                 FONT_DIR / "fusion-pixel-12px-monospaced-zh_hans.ttf"]
CONTENT = ROOT / "client/content"

# Cantonese particles and characters that Mandarin-oriented fonts routinely omit.
CANTONESE_PROBE = "嘅咗喺哋嗰冇嘢嚟咁佢哋唔係喎啱哂咪呢"


def _tables(data: bytes) -> dict[str, int]:
    num = struct.unpack_from(">H", data, 4)[0]
    out: dict[str, int] = {}
    for i in range(num):
        base = 12 + i * 16
        tag = data[base : base + 4].decode("latin-1")
        offset = struct.unpack_from(">I", data, base + 8)[0]
        out[tag] = offset
    return out


def cmap_codepoints(path: Path) -> set[int]:
    """Codepoints that map to a real (non-.notdef) glyph, across all cmap subtables."""
    data = path.read_bytes()
    tables = _tables(data)
    cmap = tables.get("cmap")
    if cmap is None:
        raise SystemExit(f"{path}: no cmap table — not a usable font")

    count = struct.unpack_from(">H", data, cmap + 2)[0]
    subtables = []
    for i in range(count):
        rec = cmap + 4 + i * 8
        _platform, _encoding, offset = struct.unpack_from(">HHI", data, rec)
        subtables.append(cmap + offset)

    covered: set[int] = set()
    for offset in subtables:
        fmt = struct.unpack_from(">H", data, offset)[0]
        if fmt == 4:
            seg_x2 = struct.unpack_from(">H", data, offset + 6)[0]
            segments = seg_x2 // 2
            ends_at = offset + 14
            starts_at = ends_at + seg_x2 + 2
            deltas_at = starts_at + seg_x2
            ranges_at = deltas_at + seg_x2
            ends = struct.unpack_from(f">{segments}H", data, ends_at)
            starts = struct.unpack_from(f">{segments}H", data, starts_at)
            deltas = struct.unpack_from(f">{segments}h", data, deltas_at)
            ranges = struct.unpack_from(f">{segments}H", data, ranges_at)
            for i in range(segments):
                start, end, delta, range_offset = starts[i], ends[i], deltas[i], ranges[i]
                if start == 0xFFFF:
                    continue
                for code in range(start, end + 1):
                    if range_offset == 0:
                        glyph = (code + delta) & 0xFFFF
                    else:
                        index = ranges_at + i * 2 + range_offset + (code - start) * 2
                        if index + 2 > len(data):
                            continue
                        glyph = struct.unpack_from(">H", data, index)[0]
                        if glyph:
                            glyph = (glyph + delta) & 0xFFFF
                    if glyph:
                        covered.add(code)
        elif fmt == 12:
            groups = struct.unpack_from(">I", data, offset + 12)[0]
            for g in range(groups):
                base = offset + 16 + g * 12
                start, end, glyph = struct.unpack_from(">III", data, base)
                if glyph == 0:
                    continue
                for code in range(start, end + 1):
                    covered.add(code)
    return covered


def content_strings() -> list[tuple[str, str]]:
    """Every string value in the content tree, tagged with its file for reporting."""
    found: list[tuple[str, str]] = []
    for path in sorted(CONTENT.rglob("*.json")):
        if path.name == "manifest.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue

        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, str):
                found.append((path.name, node))
    return found


def main() -> int:
    paths = [Path(p) for p in sys.argv[1:]] or DEFAULT_FONTS
    covered: set[int] = set()
    missing_fonts = [p for p in paths if not p.is_file()]
    for path in paths:
        if not path.is_file():
            print(f"MISSING FONT: {path.name}")
            continue
        font_covered = cmap_codepoints(path)
        covered |= font_covered
        print(f"font: {path.name} — {len(font_covered)} codepoints mapped")
    if missing_fonts:
        return 1
    print(f"union coverage: {len(covered)} codepoints")

    failures = 0
    missing_probe = sorted({ch for ch in CANTONESE_PROBE if ord(ch) not in covered})
    if missing_probe:
        failures += 1
        print(f"  FAIL cantonese probe: missing {len(missing_probe)} -> {''.join(missing_probe)}")
    else:
        print(f"  ok   cantonese probe ({len(CANTONESE_PROBE)} chars) fully covered")

    missing_content: dict[str, set[str]] = {}
    for filename, text in content_strings():
        gaps = {ch for ch in text if ord(ch) > 0x7F and ord(ch) not in covered}
        if gaps:
            missing_content.setdefault(filename, set()).update(gaps)

    if missing_content:
        failures += 1
        for filename, gaps in missing_content.items():
            print(f"  FAIL {filename}: missing {len(gaps)} -> {''.join(sorted(gaps))}")
    else:
        print("  ok   every non-ASCII character in content is covered")

    print("RESULT:", "PASS" if failures == 0 else "FAIL")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
