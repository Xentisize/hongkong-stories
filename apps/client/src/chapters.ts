import type { ConditionState } from "@hkstories/core";

/**
 * Chapter resolution in the client (PLAN §5.4/§12).
 *
 * A chapter is an aggregation document: which maps it spans, which quest carries it, where a player
 * arrives, and what unlocks the next one. The engine only needs three answers from it, and they are
 * here rather than in the shell so they can be tested without a scene:
 *
 * - **which chapter is active** — the first whose quest is unfinished, so progress is derived from
 *   the save rather than stored a second time;
 * - **which transition fires** — the first whose `requires` passes, evaluated by the shared rules;
 * - **where a chapter begins** — its entry, resolved to a concrete spawn.
 *
 * This is also the mechanism chapters were missing: nothing in the content ever transported the
 * player into the era maps, because the transition between chapters did not exist as data. It does
 * now.
 */

export interface ChapterTransition {
  to?: string;
  requires?: unknown;
  /** An optional departure line the shell shows when this transition fires. */
  text?: Record<string, string>;
}

export interface ChapterEntry {
  location?: string;
  spawn?: string;
  requires?: unknown;
}

export interface ChapterDoc {
  id?: string;
  title?: Record<string, string>;
  quests?: string[];
  locations?: string[];
  entry?: ChapterEntry;
  transitions?: ChapterTransition[];
  /** An opening image for this chapter alone; the game's own splash lives in settings. */
  splash?: unknown;
}

export interface ResolvedEntry {
  location: string;
  spawn: string;
}

/** Chapters in a stable order: ids sort, so "the first unfinished chapter" is not manifest order. */
export function orderChapters(chapters: ChapterDoc[]): ChapterDoc[] {
  return [...chapters]
    .filter((chapter) => typeof chapter.id === "string" && chapter.id !== "")
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

/** Whether a quest record is finished. A quest with no record has not started. */
export function questDone(state: ConditionState, questId: string): boolean {
  const record = state.quests?.[questId];
  return typeof record === "object" && record !== null && (record as { done?: unknown }).done === true;
}

/** Whether every quest a chapter names is finished. A chapter with no quests is never done. */
export function chapterDone(chapter: ChapterDoc, state: ConditionState): boolean {
  const quests = chapter.quests ?? [];
  if (quests.length === 0) return false;
  return quests.every((questId) => questDone(state, questId));
}

/**
 * The chapter the player is in.
 *
 * The first one whose quest is unfinished; once every chapter is finished, the last one — the finale
 * is where you end up, not nowhere.
 */
export function activeChapter(chapters: ChapterDoc[], state: ConditionState): ChapterDoc | null {
  const ordered = orderChapters(chapters);
  if (ordered.length === 0) return null;

  for (const chapter of ordered) {
    if (!chapterDone(chapter, state)) return chapter;
  }

  return ordered[ordered.length - 1] ?? null;
}

/** The transition out of a chapter whose condition passes, or null while none does. */
export function chapterTransition(
  chapter: ChapterDoc | null,
  evaluate: (condition: unknown) => boolean,
): ChapterTransition | null {
  for (const transition of chapter?.transitions ?? []) {
    const target = typeof transition.to === "string" ? transition.to : "";
    if (target === "") continue;

    // No condition, no gate: an unconditional transition is the author's explicit choice.
    if (transition.requires === undefined || transition.requires === null) return transition;
    if (evaluate(transition.requires)) return transition;
  }

  return null;
}

/** Where a chapter begins, or null when the document does not say. */
export function chapterEntry(chapter: ChapterDoc | null): ResolvedEntry | null {
  const location = typeof chapter?.entry?.location === "string" ? chapter.entry.location : "";
  if (location === "") return null;

  const spawn =
    typeof chapter?.entry?.spawn === "string" && chapter.entry.spawn !== ""
      ? chapter.entry.spawn
      : "default";

  return { location, spawn };
}

export interface ChapterAdvance {
  target: ChapterDoc;
  /** The transition that fired, or null when the move came from the save being further along. */
  transition: ChapterTransition | null;
  /** An authored departure line, when the transition carries one. */
  text?: Record<string, string>;
}

/**
 * Whether the player should move on, and where to.
 *
 * **The declared transition is what moves them.** A chapter's exit is data — `{to, requires}` — so
 * finishing a quest only counts insofar as a transition names that condition; content without a
 * transition is content the player stays in. That is why the field existed and why it was wrong to
 * advance on quest records alone.
 *
 * The one exception is recovery: a save that is *already* further along than the recorded chapter
 * (a loaded slot, an imported code) adopts the chapter its quests imply, so a resumed game does not
 * start out one chapter behind itself.
 */
export function planAdvance(
  chapters: ChapterDoc[],
  currentId: string,
  state: ConditionState,
  evaluate: (condition: unknown) => boolean,
): ChapterAdvance | null {
  const ordered = orderChapters(chapters);
  const indexOf = (id: string) => ordered.findIndex((chapter) => chapter.id === id);

  const current = ordered.find((chapter) => chapter.id === currentId) ?? null;
  const transition = current === null ? null : chapterTransition(current, evaluate);
  const derived = activeChapter(ordered, state);

  let targetId = typeof transition?.to === "string" ? transition.to : "";

  if (targetId === "" && derived !== null) {
    const derivedId = String(derived.id);
    // Only ever forwards: a chapter the player is recorded as being in is not taken away from them.
    if (currentId === "" || indexOf(derivedId) > indexOf(currentId)) targetId = derivedId;
  }

  if (targetId === "" || targetId === currentId) return null;

  const target = ordered.find((chapter) => chapter.id === targetId) ?? null;
  if (target === null) return null;

  return { target, transition, text: transition?.text };
}

/** Which chapter comes after this one, if any — by id order, matching `orderChapters`. */
export function nextChapter(chapters: ChapterDoc[], chapterId: string): ChapterDoc | null {
  const ordered = orderChapters(chapters);
  const at = ordered.findIndex((chapter) => chapter.id === chapterId);
  if (at === -1) return null;
  return ordered[at + 1] ?? null;
}
