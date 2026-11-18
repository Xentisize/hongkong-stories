import { describe, expect, test } from "bun:test";

import {
  BUNDLE_SCHEMA,
  buildAssetIndex,
  bundlePath,
  isGameManifest,
  verifyBundle,
  verifyContentAssets,
  type BundleReader,
  type GameManifest,
} from "./bundle";

/**
 * Bundle verification.
 *
 * The rules being asserted are the ones that make an imported bundle safe: an unknown format is
 * refused instead of guessed at, a document the manifest promises but the archive lacks is caught,
 * and any byte that differs from the exported hash is caught before it becomes a mystery in-game.
 */

/** A reader over an in-memory archive; the digest is a cheap stand-in for sha256. */
function reader(files: Record<string, string>): BundleReader {
  const digest = (bytes: Uint8Array) => {
    let hash = 0;
    for (const byte of bytes) hash = (hash * 31 + byte) >>> 0;
    return `d${hash.toString(16).padStart(8, "0")}`;
  };

  return {
    has: (path) => path in files,
    read: (path) => (path in files ? new TextEncoder().encode(files[path]) : null),
    digest,
  };
}

function manifestWith(overrides: Partial<GameManifest> = {}): GameManifest {
  return {
    bundle_schema: BUNDLE_SCHEMA,
    game: { id: "hongkong-stories", title: { zh_HK: "香港故事" } },
    created_at: "2026-11-18T00:00:00.000Z",
    content: {
      version: 1,
      content_hash: "e5cf0a91207b",
      resolved_hash: "37c484870634",
      files: ["content/items/item_tea_tin.json"],
    },
    assets: [{ path: "assets/tiles/p1_tiles.png", bytes: 4, sha256: "d0000004b1", refs: ["res://assets/tiles/p1_tiles.png"] }],
    ...overrides,
  };
}

const goodBundle = () => {
  const manifest = manifestWith();
  // Keep the digest consistent with the reader for the "good" case.
  const files = {
    "content/items/item_tea_tin.json": "{}",
    "assets/tiles/p1_tiles.png": "PNG!",
  };
  const digest = reader(files).digest;
  manifest.assets[0]!.sha256 = digest(new TextEncoder().encode("PNG!"));
  manifest.assets[0]!.bytes = 4;
  return { manifest, reader: reader(files) };
};

describe("buildAssetIndex", () => {
  test("sorts by path and merges the references that point at one file", () => {
    const index = buildAssetIndex([
      { path: "content/art/b.png", bytes: 1, sha256: "x", refs: ["art/b.png"] },
      { path: "content/art/a.png", bytes: 1, sha256: "y", refs: ["art/a.png", "res://content/art/a.png"] },
      { path: "content/art/b.png", bytes: 1, sha256: "x", refs: ["res://content/art/b.png"] },
    ]);

    expect(index.map((entry) => entry.path)).toEqual(["content/art/a.png", "content/art/b.png"]);
    expect(index[0]?.refs).toEqual(["art/a.png", "res://content/art/a.png"]);
    expect(index[1]?.refs).toEqual(["art/b.png", "res://content/art/b.png"]);
  });
});

describe("bundlePath", () => {
  test("keeps the two roots the clients already resolve against", () => {
    expect(bundlePath("content", "art/props/prop_tv.png")).toBe("content/art/props/prop_tv.png");
    expect(bundlePath("assets", "tiles/p1_tiles.png")).toBe("assets/tiles/p1_tiles.png");
  });
});

describe("verifyBundle", () => {
  test("a bundle that matches its manifest has no issues", () => {
    const { manifest, reader: files } = goodBundle();
    expect(verifyBundle(manifest, files)).toEqual([]);
  });

  test("an unknown bundle_schema is refused, not guessed at", () => {
    const { reader: files } = goodBundle();
    const issues = verifyBundle({ ...manifestWith(), bundle_schema: 99 }, files);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("not supported");
  });

  test("a document the manifest lists but the archive lacks is an error", () => {
    const { manifest } = goodBundle();
    const issues = verifyBundle(manifest, reader({ "assets/tiles/p1_tiles.png": "PNG!" }));
    expect(issues.map((issue) => issue.path)).toContain("content/items/item_tea_tin.json");
  });

  test("a missing asset names the content that needs it", () => {
    const { manifest } = goodBundle();
    const issues = verifyBundle(manifest, reader({ "content/items/item_tea_tin.json": "{}" }));
    expect(issues[0]?.path).toBe("assets/tiles/p1_tiles.png");
    expect(issues[0]?.message).toContain("needed by res://assets/tiles/p1_tiles.png");
  });

  test("bytes that differ from the exported hash are caught", () => {
    const { manifest } = goodBundle();
    const issues = verifyBundle(
      manifest,
      reader({ "content/items/item_tea_tin.json": "{}", "assets/tiles/p1_tiles.png": "JPG!" }),
    );
    expect(issues[0]?.message).toContain("sha256 mismatch");
  });

  test("a size that disagrees with the file is caught", () => {
    const { manifest } = goodBundle();
    const tampered = structuredClone(manifest);
    tampered.assets[0]!.bytes = 99;
    const issues = verifyBundle(tampered, goodBundle().reader);
    expect(issues[0]?.message).toContain("size mismatch");
  });

  test("a manifest with no game id is refused", () => {
    const { reader: files } = goodBundle();
    const issues = verifyBundle(manifestWith({ game: { id: "" } }), files);
    expect(issues.some((issue) => issue.message.includes("game.id"))).toBe(true);
  });

  test("content.files must not be empty — a bundle of nothing is not a game", () => {
    const { reader: files } = goodBundle();
    const manifest = manifestWith();
    manifest.content.files = [];
    expect(verifyBundle(manifest, files)[0]?.message).toContain("must list the documents");
  });

  test("garbage is refused with one clear message", () => {
    expect(verifyBundle(null, reader({}))).toEqual([
      { level: "error", path: "game.json", message: "not a JSON object" },
    ]);
  });
});

describe("verifyContentAssets", () => {
  test("a reference the bundle does not carry is an error, even when the index is consistent", () => {
    const entries = {
      "locations/loc_ssp_flat.json": {
        id: "loc_ssp_flat",
        interactables: [{ id: "the_box", art: "art/props/prop_cardboard_box.png" }],
      },
    };

    // The index would have been built from what existed, so this file is simply absent.
    expect(verifyContentAssets(entries, () => false)).toEqual([
      {
        level: "error",
        path: "content/art/props/prop_cardboard_box.png",
        message: "referenced by content ('art/props/prop_cardboard_box.png') but not in the bundle",
      },
    ]);
  });

  test("content whose references are all present passes", () => {
    const entries = {
      "items/item_tea_tin.json": { id: "item_tea_tin", icon: "res://content/art/items/item_tea_tin.png" },
      "locations/loc_a.json": { id: "loc_a", music: "audio/ssp_2027.wav" },
    };
    const carried = new Set(["content/art/items/item_tea_tin.png", "assets/audio/ssp_2027.wav"]);
    expect(verifyContentAssets(entries, (path) => carried.has(path))).toEqual([]);
  });

  test("templates and prose are not references", () => {
    const entries = {
      "items/item_a.json": { id: "item_a", name: { zh_HK: "鐵皮罐" }, desc: { en: "A tin of tea." } },
    };
    expect(verifyContentAssets(entries, () => false)).toEqual([]);
  });
});

describe("isGameManifest", () => {
  test("recognises a manifest by its schema field", () => {
    expect(isGameManifest(manifestWith())).toBe(true);
    expect(isGameManifest({ content: {} })).toBe(false);
    expect(isGameManifest("game")).toBe(false);
  });
});
