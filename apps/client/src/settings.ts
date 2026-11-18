import type { Locale } from "@hkstories/core";

/**
 * The game settings a creator edits (PLAN §6.1), resolved into what the shell needs.
 *
 * The document is authored in the admin and validated by the publish gate, but the client still
 * treats it as untrusted input: a pack can arrive from a hot-pack, and a wrong number there must not
 * silence the game or trap a player on a splash screen forever. So everything is clamped and
 * defaulted here, once, instead of at each use site.
 */

export interface CreditEntry {
  role?: Record<string, string>;
  names?: string[];
}

export interface GameSettingsDoc {
  title?: Record<string, string>;
  subtitle?: Record<string, string>;
  splash?: { art?: string; duration_ms?: number; skippable?: boolean };
  credits?: CreditEntry[];
  defaults?: { locale?: string; music_db?: number; sfx_db?: number };
  start?: { location?: string; spawn?: string };
}

export interface ResolvedSettings {
  title: Record<string, string>;
  subtitle: Record<string, string>;
  /** `null` when nothing is configured: no splash, straight to the title. */
  splash: { art: string; durationMs: number; skippable: boolean } | null;
  credits: CreditEntry[];
  defaults: { locale: Locale | "auto"; musicDb: number; sfxDb: number };
  /** `null` when unset, so the caller keeps its own default rather than being handed "". */
  start: { location: string; spawn: string } | null;
}

/** `audio.gd`'s music bus, used when the document says nothing. */
export const DEFAULT_MUSIC_DB = -12;
export const DEFAULT_SFX_DB = -6;
export const DEFAULT_SPLASH_MS = 2400;
export const MAX_SPLASH_MS = 10_000;

const LOCALES: readonly Locale[] = ["zh_HK", "zh_CN", "en"];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function localized(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(record(value))) {
    if (typeof text === "string" && text.trim() !== "") out[key] = text;
  }
  return out;
}

function decibels(value: unknown, fallback: number): number {
  // Only a real number counts. `Number(null)` and `Number("")` are 0 — unity gain — so coercing a
  // cleared field would mean "play at full volume" rather than falling back.
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  // Silence to unity; anything outside is a typo, and a positive gain would clip.
  return Math.min(0, Math.max(-60, value));
}

/** A splash duration a player can outwait, or the default when the field is not a number. */
function boundedDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPLASH_MS;
  return Math.min(MAX_SPLASH_MS, Math.max(0, value));
}

export function resolveSettings(raw: unknown): ResolvedSettings {
  const doc = record(raw) as GameSettingsDoc;

  const splashDoc = record(doc.splash);
  const art = typeof splashDoc["art"] === "string" ? splashDoc["art"].trim() : "";
  const splash =
    art === ""
      ? null
      : {
          art,
          // A splash that never ends is a bug, not a mood: clamp to something a player can outwait.
          durationMs: boundedDuration(splashDoc["duration_ms"]),
          skippable: splashDoc["skippable"] !== false,
        };

  const credits: CreditEntry[] = [];
  if (Array.isArray(doc.credits)) {
    for (const entry of doc.credits) {
      const row = record(entry);
      const names = Array.isArray(row["names"])
        ? row["names"].map((name) => (typeof name === "string" ? name.trim() : "")).filter((name) => name !== "")
        : [];
      if (names.length === 0) continue;
      credits.push({ role: localized(row["role"]), names });
    }
  }

  const defaultsDoc = record(doc.defaults);
  const localeRaw = typeof defaultsDoc["locale"] === "string" ? defaultsDoc["locale"] : "auto";
  const locale: Locale | "auto" =
    localeRaw === "auto" ? "auto" : LOCALES.includes(localeRaw as Locale) ? (localeRaw as Locale) : "auto";

  const startDoc = record(doc.start);
  const startLocation = typeof startDoc["location"] === "string" ? startDoc["location"].trim() : "";
  const spawn = typeof startDoc["spawn"] === "string" && startDoc["spawn"].trim() !== "" ? startDoc["spawn"].trim() : "default";

  return {
    title: localized(doc.title),
    subtitle: localized(doc.subtitle),
    splash,
    credits,
    defaults: {
      locale,
      musicDb: decibels(defaultsDoc["music_db"], DEFAULT_MUSIC_DB),
      sfxDb: decibels(defaultsDoc["sfx_db"], DEFAULT_SFX_DB),
    },
    start: startLocation === "" ? null : { location: startLocation, spawn },
  };
}

/** The locale to run in, honouring the document unless the player's own language was requested. */
export function localeFrom(settings: ResolvedSettings, detected: Locale): Locale {
  return settings.defaults.locale === "auto" ? detected : settings.defaults.locale;
}
