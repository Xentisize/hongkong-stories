/* Selectable look for 2D art — **two independent settings**, not one exclusive list.
 *
 * The sprite-ai guide (https://www.sprite-ai.art/blog/2d-pixel-art-style-guide) describes a style as
 * six decisions — resolution, palette, outline, shading, animation timing, proportions — and names
 * four pixel-art tiers. That is one axis: *how is a pixel image drawn*.
 *
 * The other question is *what is the picture made of*: plain, chibi, hand-drawn, flat vector, anime,
 * paper craft. It is not an alternative to a pixel tier — "chibi pixel art" and "hand-drawn anime"
 * are real, common combinations, and forcing a creator to choose one would throw away half the
 * vocabulary. So the pack carries `art.style` **and** `art.medium`, and both master fragments are
 * embedded into every generation, in that order.
 *
 * The project palette (`hk_palette_v1`) is deliberately not in these fragments — the per-kind
 * templates require it and the post-processor snaps to it mechanically. These describe what the
 * palette cannot: edges, line work, materials and proportions.
 */

export type ArtStyleId = "pixel" | "lofi" | "hk16" | "hibit" | "hybrid";

export type ArtMediumId = "natural" | "chibi" | "handdrawn" | "flat" | "anime" | "papercraft";

export interface ArtStyleRules {
  resolution: string;
  palette: string;
  outline: string;
  shading: string;
  timing: string;
  proportions: string;
}

export interface ArtLook<TId extends string> {
  id: TId;
  name: { zh_HK: string; en: string };
  summary: { zh_HK: string; en: string };
  /** The six axes, shown next to the choice so the trade-off is visible before generating. */
  rules: ArtStyleRules;
  /**
   * Prefixed to every prompt. English: image models follow constraint-dense English best.
   * Empty for the `natural` medium, which is "no extra constraints" rather than a look.
   */
  master: string;
}

/* ---------- axis 1: the pixel-art style (the guide's own tiers) ---------- */

export const ART_STYLES: readonly ArtLook<ArtStyleId>[] = [
  {
    id: "pixel",
    name: { zh_HK: "像素（通用）", en: "Pixel art (general)" },
    summary: {
      zh_HK: "只要像素手感，唔綁死某一級",
      en: "Plain pixel look, without committing to a tier",
    },
    rules: {
      resolution: "any sprite size",
      palette: "16–32 colours",
      outline: "1px dark outline on subjects",
      shading: "2–3 tone cel shading",
      timing: "as the game's cadence",
      proportions: "2.5 heads tall",
    },
    master:
      "2D pixel art: crisp pixel grid, no anti-aliasing, hard pixel edges, limited palette, " +
      "readable silhouette, consistent pixel density across the whole image",
  },
  {
    id: "lofi",
    name: { zh_HK: "8-bit 低傳真", en: "8-bit lo-fi" },
    summary: {
      zh_HK: "最細最快：硬邊、極少顏色，一眼睇得出剪影",
      en: "Tiniest and fastest: hard edges, few colours, silhouette-first",
    },
    rules: {
      resolution: "8–16px sprites",
      palette: "4–16 colours",
      outline: "1px black outline, always",
      shading: "1–2 tones, no anti-aliasing, dithering allowed",
      timing: "80ms base frame, 4-frame walk",
      proportions: "2 heads tall (chibi)",
    },
    master:
      "2D pixel art, 8-bit lo-fi style: 16x16 sprite scale, 8-16 colour palette, hard pixel edges, " +
      "no anti-aliasing, 1px black outline, 1-2 tone flat shading, 2-head chibi proportions, " +
      "silhouette readable at a glance",
  },
  {
    id: "hk16",
    name: { zh_HK: "16-bit 經典", en: "16-bit classic" },
    summary: {
      zh_HK: "本作預設：面孔睇得清，成本可控",
      en: "The project default: readable faces, manageable cost",
    },
    rules: {
      resolution: "24–32px sprites",
      palette: "16–32 colours",
      outline: "1px dark outline on subjects",
      shading: "2–3 tone cel shading, shadows hue-shifted cool",
      timing: "120ms base frame, 6-frame walk",
      proportions: "2.5 heads tall",
    },
    master:
      "2D pixel art, 16-bit classic style: 24-32px sprite scale, 16-32 colour palette, " +
      "1px dark outline on subjects, 2-3 tone cel shading with hue-shifted shadows, sparse " +
      "dithering, 2.5-head proportions, no blur",
  },
  {
    id: "hibit",
    name: { zh_HK: "Hi-bit 現代", en: "Hi-bit modern" },
    summary: {
      zh_HK: "細節最多、最慢：多層次光影，適合特寫",
      en: "Richest and slowest: layered light, good for close-ups",
    },
    rules: {
      resolution: "32–64px sprites",
      palette: "32–64 colours",
      outline: "no outline, or a coloured one",
      shading: "graded shading, subtle highlights, sub-pixel detail",
      timing: "100ms base frame, 8-frame walk",
      proportions: "3 heads tall",
    },
    master:
      "2D pixel art, hi-bit modern style: 32-64px sprite scale, 32-64 colour palette, " +
      "graded shading with subtle gradients and hue-shifted highlights, no hard outline, " +
      "sub-pixel detail, 3-head proportions",
  },
  {
    id: "hybrid",
    name: { zh_HK: "混合", en: "Hybrid" },
    summary: {
      zh_HK: "像素角色放在較細緻的背景上，界線要講明",
      en: "Pixel characters over a richer backdrop — only with a stated blend",
    },
    rules: {
      resolution: "24–32px sprites, 128–256px backdrops",
      palette: "16–32 for sprites, wider for backdrops",
      outline: "1px dark outline on sprites only",
      shading: "cel shading on sprites, soft shading on backdrops",
      timing: "120ms base frame, 6-frame walk",
      proportions: "2.5 heads tall",
    },
    master:
      "2D pixel art hybrid: crisp pixel-art subject at a 16-32 colour palette with a 1px dark " +
      "outline, placed against a higher-resolution backdrop that is soft-shaded without pixel " +
      "noise; the blend between the two is defined and deliberate",
  },
];

/* ---------- axis 2: what the art is made of ---------- */

export const ART_MEDIA: readonly ArtLook<ArtMediumId>[] = [
  {
    id: "natural",
    name: { zh_HK: "自然（不加修飾）", en: "Natural" },
    summary: {
      zh_HK: "照像素風格本身，唔加額外媒材規矩",
      en: "No extra media rules; the pixel style stands alone",
    },
    rules: {
      resolution: "as the style says",
      palette: "as the style says",
      outline: "as the style says",
      shading: "as the style says",
      timing: "as the style says",
      proportions: "as the style says",
    },
    master: "",
  },
  {
    id: "chibi",
    name: { zh_HK: "Q 版 Chibi", en: "Chibi" },
    summary: {
      zh_HK: "大頭短手腳，親切、一眼認得出",
      en: "Big head, stubby limbs, instantly readable",
    },
    rules: {
      resolution: "any (proportions carry the style)",
      palette: "12–24 colours",
      outline: "thick 2px rounded outline",
      shading: "soft 2-tone cel",
      timing: "150ms base frame, 4-frame walk",
      proportions: "2 heads tall, oversized head and eyes",
    },
    master:
      "chibi character design: super-deformed proportions with an oversized head and large eyes, " +
      "stubby limbs, bold simple shapes, thick rounded outline, soft cel shading, cheerful expression",
  },
  {
    id: "handdrawn",
    name: { zh_HK: "手繪 Hand-drawn", en: "Hand-drawn" },
    summary: {
      zh_HK: "墨水線條、水彩上色、紙張紋理",
      en: "Ink lines, watercolour fills, paper grain",
    },
    rules: {
      resolution: "illustration scale (vector, or ~2× sprite)",
      palette: "watercolour, 12–24 with paper grain",
      outline: "ink line of varying weight",
      shading: "wash gradients, visible pigment",
      timing: "hand-drawn cadence, 100ms",
      proportions: "3 heads, loose and expressive",
    },
    master:
      "hand-drawn media: ink line work of varying weight with slight organic wobble, watercolour " +
      "or marker fills, visible paper grain, soft pigment edges",
  },
  {
    id: "flat",
    name: { zh_HK: "扁平向量 Flat vector", en: "Flat vector" },
    summary: {
      zh_HK: "幾何色塊、無漸變無材質、極簡",
      en: "Geometric fills, no gradients, minimalist",
    },
    rules: {
      resolution: "vector, any scale",
      palette: "2–4 solid colours per element",
      outline: "none, or one uniform 2px stroke",
      shading: "no gradients, no texture",
      timing: "crisp snaps, 80ms",
      proportions: "simplified geometric, 3 heads",
    },
    master:
      "flat vector media: geometric shapes, solid fills, no gradients and no textures, 2-4 colours " +
      "per element, uniform strokes or none, generous negative space, minimalist",
  },
  {
    id: "anime",
    name: { zh_HK: "動漫／漫畫 Anime & comic", en: "Anime & comic" },
    summary: {
      zh_HK: "乾淨線稿、硬邊賽璐璐陰影、網點",
      en: "Clean line art, hard-edged cel shadows, screentone",
    },
    rules: {
      resolution: "illustration scale",
      palette: "rich, 24–48 colours",
      outline: "clean 1–2px line art",
      shading: "hard-edged cel shadow, screentone accents",
      timing: "anime cadence, 80ms",
      proportions: "6–7 heads (adults), chibi for children",
    },
    master:
      "anime and comic media: clean line art, expressive eyes, hard-edged cel shading, dynamic " +
      "posing, screentone or halftone accents, consistent line weight",
  },
  {
    id: "papercraft",
    name: { zh_HK: "紙藝 Paper craft", en: "Paper craft" },
    summary: {
      zh_HK: "剪紙層疊、啞面卡紙、每層微影",
      en: "Layered cut paper, matte cardstock, per-layer shadows",
    },
    rules: {
      resolution: "photo-scale, cut-paper detail",
      palette: "muted recycled stock, 8–16 colours",
      outline: "crisp cut edges with a soft shadow",
      shading: "matte, tiny drop shadow per layer",
      timing: "stop-motion, 2s-on-2s",
      proportions: "chunky simplified shapes",
    },
    master:
      "paper-craft media: layered cut-paper shapes, visible cardstock edges, a subtle drop shadow " +
      "under each layer, matte paper texture, folded creases, muted recycled-paper palette",
  },
];

/** What the project already looked like before either choice existed. */
export const DEFAULT_ART_STYLE: ArtStyleId = "hk16";
export const DEFAULT_ART_MEDIUM: ArtMediumId = "natural";

export function isArtStyleId(value: unknown): value is ArtStyleId {
  return typeof value === "string" && ART_STYLES.some((style) => style.id === value);
}

export function isArtMediumId(value: unknown): value is ArtMediumId {
  return typeof value === "string" && ART_MEDIA.some((medium) => medium.id === value);
}

/** A style by id, falling back to the default — an unknown id must never break generation. */
export function resolveArtStyle(id: unknown): ArtLook<ArtStyleId> {
  return ART_STYLES.find((style) => style.id === id) ?? ART_STYLES.find((style) => style.id === DEFAULT_ART_STYLE)!;
}

export function resolveArtMedium(id: unknown): ArtLook<ArtMediumId> {
  return ART_MEDIA.find((medium) => medium.id === id) ?? ART_MEDIA.find((medium) => medium.id === DEFAULT_ART_MEDIUM)!;
}

/**
 * The prompt actually sent: style, then medium, then the per-kind template.
 *
 * Order is the guide's prompt-anchoring advice — the constraints that must hold across every asset
 * come first and the subject's own description last. The `natural` medium contributes an empty
 * fragment, so "no extra medium" costs nothing in the prompt.
 */
export function composeArtPrompt(
  style: ArtLook<string>,
  medium: ArtLook<string>,
  template: string,
  desc: string,
): string {
  const subject = template.replace("{desc}", desc.trim());
  return [style.master.trim(), medium.master.trim(), subject]
    .filter((part) => part !== "")
    .join(", ");
}
