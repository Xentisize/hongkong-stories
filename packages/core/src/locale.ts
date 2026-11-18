/**
 * Locale resolution and field localisation (§5.8, §6.5).
 *
 * Two things were previously duplicated across three runtimes:
 *   - `Settings.resolve_locale` (GDScript) mapped a browser tag onto one of three locales;
 *   - `ContentDB.localize` / `ContentStore.localize` walked the fallback chain.
 *
 * The chain is `zh_HK → zh_CN → en` for a reason worth keeping in mind: falling from Cantonese
 * to the other written Chinese variant is readable, falling straight to English is not. The
 * chain exists for LLM output and freshly published content; validation is supposed to make it
 * unreachable for authored strings.
 */

import { isRecord, toKey, type Locale } from "./state";

export interface LocalizeOptions {
  /**
   * The player's current locale. Sits between the explicitly requested locale and the chain,
   * so an effect that does not name a locale still renders in the player's language.
   */
  currentLocale?: Locale;
}

/**
 * Map a browser/OS locale tag onto a shipping locale.
 *
 * Mirrors `Settings.resolve_locale`: exact known tags first, then a prefix walk along the
 * fallback chain, then English. Matching is case-insensitive because `navigator.language` is
 * not consistent across browsers about the region subtag's case.
 */
export function resolveLocale(raw: string | null | undefined): Locale {
  const tag = String(raw ?? "").replace(/-/g, "_").toLowerCase();

  const exact: Record<string, Locale> = {
    zh_hk: "zh_HK",
    zh_mo: "zh_HK",
    zh_tw: "zh_HK",
    zh_hant: "zh_HK",
    yue: "zh_HK",
    zh_cn: "zh_CN",
    zh_sg: "zh_CN",
    zh_hans: "zh_CN",
    zh: "zh_CN",
    en: "en",
    en_us: "en",
    en_gb: "en",
    en_au: "en",
    en_ca: "en",
    en_nz: "en",
  };

  const hit = exact[tag];
  if (hit !== undefined) return hit;

  // Anything unfamiliar falls back along the chain rather than guessing.
  if (tag.startsWith("zh")) return "zh_HK";
  if (tag.startsWith("en")) return "en";
  return "en";
}

/**
 * Localise a field that is either a plain string or a `{ zh_HK, zh_CN, en }` table.
 *
 * A plain string is returned as-is: that is how English-only props and debug labels are
 * authored. An empty table yields `""`, which callers treat as "nothing to show" rather than
 * rendering a blank panel.
 */
export function localize(
  field: unknown,
  requestedLocale: Locale = "zh_HK",
  options: LocalizeOptions = {},
): string {
  if (typeof field === "string") return field;
  if (!isRecord(field)) return "";

  const order: string[] = [];
  for (const candidate of [requestedLocale, options.currentLocale, "zh_HK", "zh_CN", "en"]) {
    if (candidate !== undefined && !order.includes(candidate)) order.push(candidate);
  }

  for (const candidate of order) {
    const value = field[candidate];
    if (typeof value === "string" && value !== "") return value;
  }

  // Last resort: whatever locale is present, so nothing renders blank.
  for (const value of Object.values(field)) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * Whether a localised field covers every shipping locale, or explicitly defers with `_todo`.
 *
 * This is the rule validation enforces (§9.2 "locale tabs ... completeness dot"), exposed here
 * so the admin can show the same verdict without reimplementing it.
 */
export function missingLocales(field: unknown): Locale[] {
  if (typeof field === "string") return field.trim() === "" ? ["zh_HK", "zh_CN", "en"] : [];
  if (!isRecord(field)) return ["zh_HK", "zh_CN", "en"];
  if ("_todo" in field) return [];
  const missing: Locale[] = [];
  for (const locale of ["zh_HK", "zh_CN", "en"] as const) {
    const value = field[locale];
    if (typeof value !== "string" || value.trim() === "") missing.push(locale);
  }
  return missing;
}

/** Coerce any raw locale-ish value into a supported locale, defaulting to the chain's head. */
export function asLocale(value: unknown): Locale {
  const tag = toKey(value ?? "");
  return tag === "zh_HK" || tag === "zh_CN" || tag === "en" ? tag : resolveLocale(tag);
}
