/* A chapter as a document (§5.4/§12), and the skeleton a new one starts from.
 *
 * A chapter is an aggregation, not a container: it names the quests that carry it, the maps it
 * spans, where a player arrives, and what unlocks the next one. Nothing is duplicated — every
 * referenced entity keeps a single home — which is why a blank chapter is a document full of empty
 * lists rather than a copy of anything.
 *
 * The type lives here so the view and the constructor agree; before this the view kept its own copy
 * and the shape existed only inside it.
 */

export type LocalizedText = Record<string, string>;

export interface ChapterTransition {
  to?: string;
  requires?: unknown;
  text?: LocalizedText;
}

export interface ChapterDoc {
  schema_version?: number;
  id?: string;
  title?: LocalizedText;
  quests?: string[];
  locations?: string[];
  entry?: { location?: string; spawn?: string; requires?: unknown };
  /** An opening image for this chapter alone; absent means the game's own splash. */
  splash?: { art?: string; duration_ms?: number; skippable?: boolean };
  transitions?: ChapterTransition[];
  [field: string]: unknown;
}

/**
 * A new chapter: nothing aggregated yet.
 *
 * The empty lists are deliberate. A chapter with a guessed quest or location would validate just
 * enough to look finished and then send players somewhere that does not exist; empty ones make the
 * validator say "a chapter needs at least one quest", which is exactly the next thing to do.
 */
export function blankChapterDoc(id: string): ChapterDoc {
  return {
    schema_version: 1,
    id,
    title: {},
    quests: [],
    locations: [],
    entry: { location: "", spawn: "default" },
    transitions: [],
  };
}
