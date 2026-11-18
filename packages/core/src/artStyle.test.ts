import { describe, expect, test } from "bun:test";

import {
  ART_MEDIA,
  ART_STYLES,
  DEFAULT_ART_MEDIUM,
  DEFAULT_ART_STYLE,
  composeArtPrompt,
  isArtMediumId,
  isArtStyleId,
  resolveArtMedium,
  resolveArtStyle,
} from "./artStyle";

/**
 * Two independent axes, and the rules that keep them honest.
 *
 * The point of splitting them is that they compose: "16-bit classic" and "chibi" are not
 * alternatives, they are answers to different questions. So beyond catalog completeness, the tests
 * here pin the composition order, that the `natural` medium adds nothing rather than an empty
 * fragment, and that an unknown id on either axis falls back without breaking generation.
 */

describe("the two catalogs", () => {
  test("every pixel style is complete", () => {
    expect(ART_STYLES.length).toBeGreaterThanOrEqual(5);
    for (const style of ART_STYLES) {
      expect(style.master.trim().length).toBeGreaterThan(40);
      expect(style.name.zh_HK.trim()).not.toBe("");
      expect(style.name.en.trim()).not.toBe("");
      for (const axis of ["resolution", "palette", "outline", "shading", "timing", "proportions"] as const) {
        expect(style.rules[axis].trim()).not.toBe("");
      }
    }
  });

  test("every medium is described, and only `natural` is allowed to constrain nothing", () => {
    expect(ART_MEDIA.length).toBeGreaterThanOrEqual(6);
    for (const medium of ART_MEDIA) {
      expect(medium.name.zh_HK.trim()).not.toBe("");
      expect(medium.summary.en.trim()).not.toBe("");
      if (medium.id === "natural") expect(medium.master).toBe("");
      else expect(medium.master.trim().length).toBeGreaterThan(30);
    }
  });

  test("the media the creator asked for are all offered", () => {
    for (const id of ["chibi", "handdrawn", "flat", "anime", "papercraft"]) {
      expect(isArtMediumId(id)).toBe(true);
    }
    expect(isArtMediumId("natural")).toBe(true);
  });

  test("ids are unique within each axis", () => {
    expect(new Set(ART_STYLES.map((style) => style.id)).size).toBe(ART_STYLES.length);
    expect(new Set(ART_MEDIA.map((medium) => medium.id)).size).toBe(ART_MEDIA.length);
  });

  test("a style id is not a medium id, so the two axes cannot be confused", () => {
    expect(isArtMediumId(DEFAULT_ART_STYLE)).toBe(false);
    expect(isArtStyleId(DEFAULT_ART_MEDIUM)).toBe(false);
  });
});

describe("resolution", () => {
  test("known ids resolve to themselves on both axes", () => {
    expect(resolveArtStyle("hibit").id).toBe("hibit");
    expect(resolveArtMedium("papercraft").id).toBe("papercraft");
  });

  test("an unknown id falls back per axis, without breaking the other", () => {
    expect(resolveArtStyle("vaporwave").id).toBe(DEFAULT_ART_STYLE);
    expect(resolveArtMedium("vaporwave").id).toBe(DEFAULT_ART_MEDIUM);
    expect(resolveArtStyle(undefined).id).toBe(DEFAULT_ART_STYLE);
    expect(resolveArtMedium(42).id).toBe(DEFAULT_ART_MEDIUM);
  });
});

describe("composeArtPrompt", () => {
  const template = "sprite of {desc}, hk_palette_v1 palette, no text";

  test("style, then medium, then the subject", () => {
    const prompt = composeArtPrompt(
      resolveArtStyle("hk16"),
      resolveArtMedium("chibi"),
      template,
      "a hawker",
    );
    expect(prompt.indexOf("16-bit classic")).toBeLessThan(prompt.indexOf("chibi character design"));
    expect(prompt.indexOf("chibi character design")).toBeLessThan(prompt.indexOf("sprite of a hawker"));
  });

  test("the natural medium adds nothing at all", () => {
    const withNatural = composeArtPrompt(resolveArtStyle("hk16"), resolveArtMedium("natural"), template, "a hawker");
    const styleOnly = composeArtPrompt(resolveArtStyle("hk16"), resolveArtMedium(undefined), template, "a hawker");
    expect(withNatural).toBe(styleOnly);
    expect(withNatural).not.toContain(", ,");
  });

  test("a medium composes with a style that would be odd alone — chibi pixel art is the point", () => {
    const prompt = composeArtPrompt(resolveArtStyle("lofi"), resolveArtMedium("chibi"), template, "a hawker");
    expect(prompt).toContain("8-bit lo-fi style");
    expect(prompt).toContain("chibi character design");
  });

  test("the description is substituted and trimmed, and the palette survives every combination", () => {
    expect(composeArtPrompt(resolveArtStyle("pixel"), resolveArtMedium("flat"), template, "  a hawker  ")).toContain(
      "sprite of a hawker",
    );
    for (const style of ART_STYLES) {
      for (const medium of ART_MEDIA) {
        expect(composeArtPrompt(style, medium, template, "a hawker")).toContain("hk_palette_v1");
      }
    }
  });
});
