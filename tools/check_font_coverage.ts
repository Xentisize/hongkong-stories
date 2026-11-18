#!/usr/bin/env bun
/**
 * Font glyph-coverage gate (docs/PLAN.md §6.5, §11).
 *
 * Chinese text rendered with a Latin-only font is a wall of boxes. The project's rule is that the
 * bundled CJK fonts must cover every character the game can actually display — including ones a
 * language model invents at runtime. This checks the fonts' real cmaps (not their marketing
 * claims) against a probe string of Cantonese-only characters and every string in
 * client/content.
 *
 * Several fonts may be passed; coverage is the UNION, because Godot renders them as a fallback
 * chain (zh_hk default, zh_hans fallback) — which is also how the game is wired.
 *
 * Run: bun tools/check_font_coverage.ts [font.ttf ...]
 * Exit code 1 if anything is missing, so CI can gate on it.
 *
 * The cmap parsing is hand-rolled over a Buffer for the same reason the Python version used
 * `struct`: the question is what the file actually maps, and a font library would answer a
 * slightly different question with a large dependency attached.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FONT_DIR = join(ROOT, "client", "assets", "fonts");
const DEFAULT_FONTS = [
  join(FONT_DIR, "fusion-pixel-12px-monospaced-zh_hk.ttf"),
  join(FONT_DIR, "fusion-pixel-12px-monospaced-zh_hans.ttf"),
];
const CONTENT = join(ROOT, "client", "content");

/** Cantonese particles and characters that Mandarin-oriented fonts routinely omit. */
const CANTONESE_PROBE = "嘅咗喺哋嗰冇嘢嚟咁佢哋唔係喎啱哂咪呢";

/** Table tag -> offset, from the font's table directory. */
function tables(data: Buffer): Map<string, number> {
  const count = data.readUInt16BE(4);
  const out = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const base = 12 + index * 16;
    const tag = data.subarray(base, base + 4).toString("latin1");
    out.set(tag, data.readUInt32BE(base + 8));
  }
  return out;
}

/** Codepoints that map to a real (non-.notdef) glyph, across all cmap subtables. */
function cmapCodepoints(data: Buffer, name: string): Set<number> {
  const directory = tables(data);
  const cmap = directory.get("cmap");
  if (cmap === undefined) throw new Error(`${name}: no cmap table — not a usable font`);

  const count = data.readUInt16BE(cmap + 2);
  const subtables: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = cmap + 4 + index * 8;
    subtables.push(cmap + data.readUInt32BE(record + 4));
  }

  const covered = new Set<number>();

  for (const offset of subtables) {
    const format = data.readUInt16BE(offset);

    if (format === 4) {
      const segX2 = data.readUInt16BE(offset + 6);
      const segments = segX2 / 2;
      const endsAt = offset + 14;
      const startsAt = endsAt + segX2 + 2;
      const deltasAt = startsAt + segX2;
      const rangesAt = deltasAt + segX2;

      for (let index = 0; index < segments; index += 1) {
        const start = data.readUInt16BE(startsAt + index * 2);
        const end = data.readUInt16BE(endsAt + index * 2);
        const delta = data.readInt16BE(deltasAt + index * 2);
        const rangeOffset = data.readUInt16BE(rangesAt + index * 2);
        if (start === 0xffff) continue;

        for (let code = start; code <= end; code += 1) {
          let glyph: number;
          if (rangeOffset === 0) {
            glyph = (code + delta) & 0xffff;
          } else {
            const at = rangesAt + index * 2 + rangeOffset + (code - start) * 2;
            if (at + 2 > data.length) continue;
            glyph = data.readUInt16BE(at);
            if (glyph) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph) covered.add(code);
        }
      }
    } else if (format === 12) {
      const groups = data.readUInt32BE(offset + 12);
      for (let group = 0; group < groups; group += 1) {
        const base = offset + 16 + group * 12;
        const start = data.readUInt32BE(base);
        const end = data.readUInt32BE(base + 4);
        const glyph = data.readUInt32BE(base + 8);
        if (glyph === 0) continue;
        for (let code = start; code <= end; code += 1) covered.add(code);
      }
    }
  }

  return covered;
}

/** Every string value in the content tree, tagged with its file for reporting. */
async function contentStrings(): Promise<Array<{ file: string; text: string }>> {
  const found: Array<{ file: string; text: string }> = [];
  let entries: string[];
  try {
    entries = (await readdir(CONTENT, { recursive: true })) as string[];
  } catch {
    return found;
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json") && basename(entry) !== "manifest.json").sort();

  for (const relative of jsonFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(CONTENT, relative), "utf8"));
    } catch {
      continue;
    }

    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node !== null && typeof node === "object") stack.push(...Object.values(node));
      else if (typeof node === "string") found.push({ file: basename(relative), text: node });
    }
  }

  return found;
}

async function main(): Promise<number> {
  const candidates = process.argv.slice(2);
  const paths = candidates.length > 0 ? candidates : DEFAULT_FONTS;

  const covered = new Set<number>();
  let missingFonts = false;

  for (const path of paths) {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      console.log(`MISSING FONT: ${basename(path)}`);
      missingFonts = true;
      continue;
    }
    const fontCovered = cmapCodepoints(data, basename(path));
    for (const code of fontCovered) covered.add(code);
    console.log(`font: ${basename(path)} — ${fontCovered.size} codepoints mapped`);
  }

  if (missingFonts) return 1;
  console.log(`union coverage: ${covered.size} codepoints`);

  let failures = 0;

  const missingProbe = [...new Set([...CANTONESE_PROBE].filter((char) => !covered.has(char.codePointAt(0)!)))].sort();
  if (missingProbe.length > 0) {
    failures += 1;
    console.log(`  FAIL cantonese probe: missing ${missingProbe.length} -> ${missingProbe.join("")}`);
  } else {
    console.log(`  ok   cantonese probe (${[...CANTONESE_PROBE].length} chars) fully covered`);
  }

  const missingContent = new Map<string, Set<string>>();
  for (const { file, text } of await contentStrings()) {
    const gaps = [...text].filter((char) => {
      const code = char.codePointAt(0)!;
      return code > 0x7f && !covered.has(code);
    });
    if (gaps.length === 0) continue;
    const slot = missingContent.get(file) ?? new Set<string>();
    for (const gap of gaps) slot.add(gap);
    missingContent.set(file, slot);
  }

  if (missingContent.size > 0) {
    failures += 1;
    for (const [file, gaps] of missingContent) {
      console.log(`  FAIL ${file}: missing ${gaps.size} -> ${[...gaps].sort().join("")}`);
    }
  } else {
    console.log("  ok   every non-ASCII character in content is covered");
  }

  console.log("RESULT:", failures === 0 ? "PASS" : "FAIL");
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
