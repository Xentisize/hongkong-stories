import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeManifest, manifestDrift, regenerateManifest } from "./manifest";

/**
 * The manifest's `content_hash` is a wire contract: a booted client compares it with its own copy to
 * decide whether to hot-pack. Nothing tested it before, which is how the committed hash drifted away
 * from the committed bytes without a single failure — so both the hashing and the gate's rule are
 * pinned here.
 */

async function makePack(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hks-manifest-"));
  await mkdir(join(dir, "items"), { recursive: true });
  await mkdir(join(dir, "locations"), { recursive: true });
  await mkdir(join(dir, "art"), { recursive: true });

  await writeFile(join(dir, "items", "item_key.json"), '{ "id": "item_key" }\n');
  await writeFile(join(dir, "items", "item_album.json"), '{ "id": "item_album" }\n');
  await writeFile(join(dir, "locations", "loc_a.json"), '{ "id": "loc_a" }\n');

  // Not part of the pack: the kinds are an allow-list, and art is not one of them.
  await writeFile(join(dir, "art", "note.txt"), "not content\n");
  await writeFile(join(dir, "items", "README.md"), "# notes\n");

  return dir;
}

describe("computeManifest", () => {
  test("hashes the pack deterministically, files sorted", async () => {
    const dir = await makePack();

    const first = await computeManifest(dir);
    const second = await computeManifest(dir);

    expect(first.content_hash).toBe(second.content_hash);
    expect(first.files).toEqual([
      "items/item_album.json",
      "items/item_key.json",
      "locations/loc_a.json",
    ]);
    expect(first.content_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test("one byte of content changes the hash", async () => {
    const dir = await makePack();
    const before = await computeManifest(dir);

    await writeFile(join(dir, "items", "item_key.json"), '{ "id": "item_key", "n": 1 }\n');
    const after = await computeManifest(dir);

    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after.files).toEqual(before.files); // the same files, different bytes
  });

  test("a file appearing changes both the list and the hash", async () => {
    const dir = await makePack();
    const before = await computeManifest(dir);

    await writeFile(join(dir, "items", "item_new.json"), '{ "id": "item_new" }\n');
    const after = await computeManifest(dir);

    expect(after.files).toContain("items/item_new.json");
    expect(after.content_hash).not.toBe(before.content_hash);
  });

  test("non-JSON files and unknown kinds are not part of the pack", async () => {
    const dir = await makePack();
    const manifest = await computeManifest(dir);

    expect(manifest.files.some((file) => file.startsWith("art/"))).toBe(false);
    expect(manifest.files.some((file) => file.endsWith(".md"))).toBe(false);
  });

  test("a directory with no kinds is an empty pack, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hks-empty-"));
    const manifest = await computeManifest(dir);

    expect(manifest.files).toEqual([]);
    expect(manifest.content_hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("regenerateManifest", () => {
  test("writes what computeManifest reported", async () => {
    const dir = await makePack();
    const computed = await computeManifest(dir);
    const written = await regenerateManifest(dir);

    expect(written.content_hash).toBe(computed.content_hash);
    expect(written.files).toEqual(computed.files);
    expect(written.version).toBe(1);
  });

  test("--bump increments the version and leaves the hash alone", async () => {
    const dir = await makePack();
    const first = await regenerateManifest(dir);
    const bumped = await regenerateManifest(dir, { bump: true });

    expect(bumped.version).toBe(first.version + 1);
    expect(bumped.content_hash).toBe(first.content_hash);
  });
});

describe("manifestDrift", () => {
  const fresh = { manifest_schema: 1, version: 1, content_hash: "abc123abc123", files: ["a.json"] };

  test("an up-to-date manifest has no drift", () => {
    expect(manifestDrift({ content_hash: fresh.content_hash, files: fresh.files }, fresh)).toEqual([]);
  });

  test("a stale hash is drift, and the message names both", () => {
    const drift = manifestDrift({ content_hash: "old", files: fresh.files }, fresh);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("old");
    expect(drift[0]).toContain("abc123abc123");
  });

  test("a differing file list is drift even when the hash happens to match", () => {
    const drift = manifestDrift({ content_hash: fresh.content_hash, files: ["b.json"] }, fresh);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("file list");
  });

  test("a missing manifest is total drift", () => {
    expect(manifestDrift({}, fresh)).toHaveLength(2);
  });
});
