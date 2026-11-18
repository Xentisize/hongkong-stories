import { describe, expect, test } from "bun:test";

import { fetchManifest, parseManifest, planRefresh, type ContentManifest } from "./content-pack";

/**
 * The hot-pack check.
 *
 * The rule that matters: a client must not run stale content while a newer pack is published, and
 * must not refuse to boot when the API is unreachable. Both are decisions, and both are here.
 */

const BUNDLED: ContentManifest = {
  manifest_schema: 1,
  version: 1,
  content_hash: "30ae06ee1810",
  files: ["npcs/npc_ch01_ken.json", "locations/loc_ssp_market_street.json"],
};

describe("parsing a manifest", () => {
  test("keeps the hash, files and version", () => {
    expect(parseManifest({ content_hash: "abc", version: 2, files: ["a.json"] })).toEqual({
      content_hash: "abc",
      version: 2,
      files: ["a.json"],
    });
  });

  test("rejects anything that is not a comparable manifest", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest([])).toBeNull();
    expect(parseManifest("nope")).toBeNull();
    // No hash means nothing to compare: useless for this purpose.
    expect(parseManifest({ version: 3 })).toBeNull();
  });

  test("drops non-string file entries instead of carrying them", () => {
    expect(parseManifest({ content_hash: "abc", files: ["a.json", 7, null] })?.files).toEqual(["a.json"]);
  });
});

describe("deciding whether to refresh", () => {
  test("the same hash is a no-op", () => {
    expect(planRefresh(BUNDLED, { ...BUNDLED })).toBeNull();
  });

  test("a different hash asks for the served pack, and says why", () => {
    const plan = planRefresh(BUNDLED, { ...BUNDLED, content_hash: "ffff", files: ["a.json", "b.json"] });

    expect(plan?.files).toEqual(["a.json", "b.json"]);
    expect(plan?.reason).toContain("ffff");
    expect(plan?.reason).toContain("30ae06ee1810");
  });

  test("an absent manifest is not a refresh", () => {
    expect(planRefresh(BUNDLED, null)).toBeNull();
  });

  test("a hash with no file list cannot be fetched, so it is not a refresh either", () => {
    expect(planRefresh(BUNDLED, { content_hash: "ffff", files: [] })).toBeNull();
    expect(planRefresh(BUNDLED, { content_hash: "ffff" })).toBeNull();
  });
});

describe("asking the API", () => {
  const jsonFetch = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("reports current when the served hash matches", async () => {
    const result = await fetchManifest({ fetchImpl: jsonFetch(BUNDLED), bundled: BUNDLED });
    expect(result).toMatchObject({ ok: true, status: "current" });
  });

  test("reports pending when it differs", async () => {
    const result = await fetchManifest({
      fetchImpl: jsonFetch({ ...BUNDLED, content_hash: "ffff" }),
      bundled: BUNDLED,
    });
    expect(result).toMatchObject({ ok: true, status: "pending" });
  });

  test("an unreachable API is a status, not a thrown error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await fetchManifest({ fetchImpl: failing, bundled: BUNDLED });
    expect(result).toMatchObject({ ok: false, status: "unreachable" });
  });

  test("a non-200 is unreachable — offline play must still boot", async () => {
    const result = await fetchManifest({ fetchImpl: jsonFetch({}, 503), bundled: BUNDLED });
    expect(result).toMatchObject({ ok: false, status: "unreachable" });
  });

  test("a body that is not a manifest is unreachable", async () => {
    const result = await fetchManifest({ fetchImpl: jsonFetch({ hello: "world" }), bundled: BUNDLED });
    expect(result).toMatchObject({ ok: false, status: "unreachable" });
  });
});
