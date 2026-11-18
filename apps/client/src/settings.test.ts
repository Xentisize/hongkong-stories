import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MUSIC_DB,
  DEFAULT_SFX_DB,
  localeFrom,
  resolveSettings,
  resolveSplash,
} from "./settings";

/**
 * Settings resolution.
 *
 * The document is authored elsewhere and can arrive from a hot-pack, so the client treats it as
 * untrusted: these cases pin what happens when a creator writes a number that would silence the game
 * or a splash that never ends.
 */

describe("defaults", () => {
  test("an empty document yields playable defaults", () => {
    const settings = resolveSettings({});

    expect(settings.title).toEqual({});
    expect(settings.splash).toBeNull();
    expect(settings.credits).toEqual([]);
    expect(settings.defaults).toEqual({ locale: "auto", musicDb: DEFAULT_MUSIC_DB, sfxDb: DEFAULT_SFX_DB });
    expect(settings.start).toBeNull();
  });

  test("garbage in, playable out", () => {
    for (const raw of [null, undefined, 7, "nope", []]) {
      const settings = resolveSettings(raw);
      expect(settings.splash).toBeNull();
      expect(settings.defaults.musicDb).toBe(DEFAULT_MUSIC_DB);
    }
  });
});

describe("the splash", () => {
  test("needs art; a duration alone is not a splash", () => {
    expect(resolveSettings({ splash: { duration_ms: 2000 } }).splash).toBeNull();
    expect(resolveSettings({ splash: { art: "   " } }).splash).toBeNull();
  });

  test("clamps a duration a player can outwait", () => {
    const tooLong = resolveSettings({ splash: { art: "art/backdrops/x.png", duration_ms: 999_999 } });
    expect(tooLong.splash?.durationMs).toBe(10_000);

    const negative = resolveSettings({ splash: { art: "art/backdrops/x.png", duration_ms: -5 } });
    expect(negative.splash?.durationMs).toBe(0);

    const junk = resolveSettings({ splash: { art: "art/backdrops/x.png", duration_ms: "soon" } });
    expect(junk.splash?.durationMs).toBe(2400);
  });

  test("is skippable unless the document says otherwise", () => {
    expect(resolveSettings({ splash: { art: "a.png" } }).splash?.skippable).toBe(true);
    expect(resolveSettings({ splash: { art: "a.png", skippable: false } }).splash?.skippable).toBe(false);
  });
});

describe("credits", () => {
  test("drops rows with nothing to show", () => {
    const settings = resolveSettings({
      credits: [
        { role: { en: "Story" }, names: ["Studio"] },
        { role: { en: "Nobody" }, names: [] },
        { names: ["  "] },
        "garbage",
      ],
    });

    expect(settings.credits).toHaveLength(1);
    expect(settings.credits[0]?.names).toEqual(["Studio"]);
  });

  test("keeps a role that is only partly translated", () => {
    const settings = resolveSettings({ credits: [{ role: { en: "Art" }, names: ["A"] }] });
    expect(settings.credits[0]?.role).toEqual({ en: "Art" });
  });
});

describe("the audio defaults", () => {
  test("a bus gain stays between silence and unity", () => {
    expect(resolveSettings({ defaults: { music_db: 6 } }).defaults.musicDb).toBe(0);
    expect(resolveSettings({ defaults: { music_db: -500 } }).defaults.musicDb).toBe(-60);
    expect(resolveSettings({ defaults: { music_db: -24 } }).defaults.musicDb).toBe(-24);
    expect(resolveSettings({ defaults: { sfx_db: "loud" } }).defaults.sfxDb).toBe(DEFAULT_SFX_DB);
  });
});

describe("the locale", () => {
  test("an unset or unknown default means follow the player", () => {
    expect(resolveSettings({}).defaults.locale).toBe("auto");
    expect(resolveSettings({ defaults: { locale: "fr" } }).defaults.locale).toBe("auto");
  });

  test("an explicit locale overrides detection", () => {
    const settings = resolveSettings({ defaults: { locale: "zh_CN" } });
    expect(localeFrom(settings, "en")).toBe("zh_CN");
    expect(localeFrom(resolveSettings({}), "en")).toBe("en");
  });
});

describe("the start point", () => {
  test("is null when no location is named", () => {
    expect(resolveSettings({ start: { spawn: "roof" } }).start).toBeNull();
  });

  test("defaults the spawn name", () => {
    expect(resolveSettings({ start: { location: "loc_a" } }).start).toEqual({
      location: "loc_a",
      spawn: "default",
    });
  });
});

describe("localized text", () => {
  test("blank strings are not translations", () => {
    const settings = resolveSettings({
      title: { zh_HK: "香港故事", zh_CN: "  ", en: "Hong Kong Stories" },
    });
    expect(settings.title).toEqual({ zh_HK: "香港故事", en: "Hong Kong Stories" });
  });
});

describe("resolveSplash", () => {
  test("a chapter and the game resolve an image the same way", () => {
    // The game's splash and a chapter's own image go through one function, so neither can be the
    // one that traps a player behind a black screen.
    expect(resolveSplash({ art: "art/backdrops/x.png", duration_ms: 1200, skippable: false })).toEqual({
      art: "art/backdrops/x.png",
      durationMs: 1200,
      skippable: false,
    });
  });

  test("an omitted duration is a default, not zero", () => {
    expect(resolveSplash({ art: "art/backdrops/x.png" })?.durationMs).toBe(2400);
  });

  test("a duration that is not a number falls back instead of coercing", () => {
    for (const value of [null, "", true, "soon", Number.NaN]) {
      expect(resolveSplash({ art: "art/backdrops/x.png", duration_ms: value })?.durationMs).toBe(2400);
    }
  });

  test("a duration is clamped to something outliveable", () => {
    expect(resolveSplash({ art: "a.png", duration_ms: 999_999 })?.durationMs).toBe(10_000);
    expect(resolveSplash({ art: "a.png", duration_ms: -5 })?.durationMs).toBe(0);
  });

  test("no art means no splash", () => {
    expect(resolveSplash(undefined)).toBeNull();
    expect(resolveSplash({})).toBeNull();
    expect(resolveSplash({ art: "   " })).toBeNull();
  });
});
