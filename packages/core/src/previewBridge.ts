/* The preview bridge protocol, shared by the studio and the game.
 *
 * The studio embeds the real Phaser client in an iframe and talks to it: the game reports what is
 * under the pointer, the studio asks it to go somewhere or pause. Both sides must agree on the
 * message shape, so it lives in core rather than in either app — and it is deliberately tiny and
 * pure, so a stray `postMessage` on the page cannot drive the game: every message carries the
 * channel, and anything without it is ignored.
 */

export const PREVIEW_CHANNEL = "hkstories-preview";

/** What the studio may ask the running game to do. */
export type PreviewCommand =
  | { type: "select"; tile?: [number, number] | null; entity?: string | null }
  /**
   * Where a dragged palette item is right now, in **iframe-local pixels**.
   *
   * A pointer that starts in the studio cannot be seen by a cross-origin frame, so a real drag has to
   * be forwarded: the studio captures the pointer, converts to the frame's own coordinates, and the
   * game answers with the tile under them.
   */
  | { type: "hover"; x: number; y: number }
  /** The drag was released at that point: place it. */
  | { type: "place"; x: number; y: number }
  /** Arm placement: the next click in the game reports the tile instead of selecting. */
  | { type: "pick"; entity?: string }
  /**
   * Hand the admin token over after load.
   *
   * Never in the URL: a bearer token in `location.search` lands in history, the referrer and the
   * iframe's own address. The game waits for this message before fetching the draft pack.
   */
  | { type: "auth"; token: string }
  | { type: "goto"; location: string; spawn?: string }
  | { type: "playFrom"; location: string; spawn?: string }
  | { type: "pause" }
  | { type: "resume" };

/** What the game reports back. `selected` is how the inspector learns what was clicked. */
export type PreviewEvent =
  | { type: "ready"; location: string }
  | { type: "selected"; tile: [number, number] | null; entityType: string | null; entityId: string | null }
  | { type: "hovered"; tile: [number, number] | null }
  | { type: "picked"; tile: [number, number] }
  | { type: "error"; message: string };

const COMMANDS = new Set(["select", "hover", "pick", "place", "auth", "goto", "playFrom", "pause", "resume"]);
const EVENTS = new Set(["ready", "selected", "hovered", "picked", "error"]);

function tagged(value: unknown, verbs: Set<string>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { channel?: unknown; type?: unknown };
  return record.channel === PREVIEW_CHANNEL && typeof record.type === "string" && verbs.has(record.type);
}

export function isPreviewCommand(value: unknown): value is PreviewCommand {
  return tagged(value, COMMANDS);
}

export function isPreviewEvent(value: unknown): value is PreviewEvent {
  return tagged(value, EVENTS);
}

/** Wrap a command for `postMessage`, stamping the channel the game filters on. */
export function commandMessage(command: PreviewCommand): PreviewCommand & { channel: string } {
  return { ...command, channel: PREVIEW_CHANNEL };
}

/** Wrap an event for `postMessage`, same stamp. */
export function eventMessage(event: PreviewEvent): PreviewEvent & { channel: string } {
  return { ...event, channel: PREVIEW_CHANNEL };
}
