/**
 * Incremental `say` extraction from a streaming JSON object (PLAN 7.3).
 *
 * The model is constrained to emit `{"say": "...", "mood": "...", "actions": [...]}` with
 * `response_format: json_schema`, but the player must not wait for the closing brace before the
 * typewriter starts. This pulls the `say` string out of the deltas as they arrive.
 *
 * This is the fiddly part of the old Python pipeline — partial escapes and split `\uXXXX`
 * sequences across chunk boundaries. It is ported rather than reinvented because every one of
 * those edge cases was a bug once; the tests below are the same cases the Python suite pinned.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/** Matches the key, its colon and the opening quote, tolerating whitespace. */
const SAY_KEY = /"say"\s*:\s*"/;

export class SayExtractor {
  private buffer = "";
  /** Index of the next raw character to decode (points at a backslash while an escape is held). */
  private cursor = 0;
  private opened = false;
  private closed = false;

  /** Feed one delta. Returns only the newly decoded text, never the whole line again. */
  feed(chunk: string): string {
    if (this.closed) return "";

    this.buffer += chunk;

    if (!this.opened) {
      const match = SAY_KEY.exec(this.buffer);
      if (!match) return "";
      this.cursor = match.index + match[0].length;
      this.opened = true;
    }

    return this.decode();
  }

  /** True once the closing quote of `say` has been consumed. */
  get done(): boolean {
    return this.closed;
  }

  private decode(): string {
    let out = "";
    const text = this.buffer;

    while (this.cursor < text.length) {
      const character = text[this.cursor]!;

      if (character === '"') {
        this.closed = true;
        break;
      }

      if (character !== "\\") {
        out += character;
        this.cursor += 1;
        continue;
      }

      // Escape: hold the cursor until the whole thing has arrived.
      if (this.cursor + 1 >= text.length) break;

      const escape = text[this.cursor + 1]!;

      if (escape === "u") {
        if (this.cursor + 6 > text.length) break; // need four hex digits
        const hex = text.slice(this.cursor + 2, this.cursor + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Malformed: skip the marker and continue as literal text rather than hanging.
          out += hex;
          this.cursor += 6;
          continue;
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.cursor += 6;
        continue;
      }

      const mapped = SIMPLE_ESCAPES[escape];
      if (mapped !== undefined) {
        out += mapped;
      } else {
        out += escape; // unknown escape: pass it through
      }
      this.cursor += 2;
    }

    return out;
  }
}
