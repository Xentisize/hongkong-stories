import { describe, expect, test } from "bun:test";

import { contentAssetUrl, hasArtwork } from "./art";

/**
 * Pack paths → URLs.
 *
 * The cases that matter are the ones the server would refuse: an absolute path, another resource
 * root, or a traversal. Returning `null` there is what lets the UI draw a fallback instead of a
 * broken image, so they are pinned rather than left to chance.
 */

describe("contentAssetUrl", () => {
  test("content art maps to the content route", () => {
    expect(contentAssetUrl("res://content/art/items/item_flat_key.png")).toBe(
      "/v1/content/file/art/items/item_flat_key.png",
    );
    expect(contentAssetUrl("art/backdrops/splash_cute.png")).toBe(
      "/v1/content/file/art/backdrops/splash_cute.png",
    );
  });

  test("client assets map to the assets route", () => {
    expect(contentAssetUrl("res://assets/tiles/p1_tiles_2027.png")).toBe(
      "/v1/assets/file/tiles/p1_tiles_2027.png",
    );
  });

  test("paths outside the pack are not served", () => {
    expect(contentAssetUrl("/etc/passwd")).toBeNull();
    expect(contentAssetUrl("res://scenes/main.tscn")).toBeNull();
    expect(contentAssetUrl("art/../../secrets.png")).toBeNull();
    expect(contentAssetUrl("res://content/../game.json")).toBeNull();
  });

  test("nothing useful reads as null rather than an empty URL", () => {
    expect(contentAssetUrl("")).toBeNull();
    expect(contentAssetUrl("   ")).toBeNull();
    expect(contentAssetUrl(undefined)).toBeNull();
    expect(contentAssetUrl(42)).toBeNull();
  });
});

describe("hasArtwork", () => {
  test("agrees with the URL helper", () => {
    expect(hasArtwork("res://content/art/items/x.png")).toBe(true);
    expect(hasArtwork("res://scenes/main.tscn")).toBe(false);
    expect(hasArtwork("")).toBe(false);
  });
});
