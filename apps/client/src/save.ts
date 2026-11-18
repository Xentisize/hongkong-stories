import type { ConditionState } from "@hkstories/core";

/**
 * Save codes, compatible with the Godot client's (§6.4).
 *
 * The format is a fixed contract, not an implementation detail: a playtester's code written down
 * yesterday has to import tomorrow, in whatever client is shipping. `save.gd` defines it as
 *
 *     base64( uint32_le(uncompressedLength) || zlib( utf8( JSON(payload) ) ) )
 *
 * — the length prefix exists only because a raw zlib stream does not carry it, and Godot's
 * `decompress(size, …)` needs the expected output size up front.
 *
 * Compression uses the platform's `CompressionStream("deflate")`, which is the zlib wrapper
 * (RFC 1950) that `FileAccess.COMPRESSION_DEFLATE` writes — so this needs no dependency, and the
 * bytes interoperate in both directions. The *compressed* bytes need not be identical: zlib
 * implementations may compress differently, and both sides only ever decompress.
 */

/** `Game.SCHEMA_VERSION`. A newer payload is refused rather than partially applied. */
export const SAVE_SCHEMA_VERSION = 1;

/** `save.gd`'s ceiling in `import_code`; a real save is a few KiB. */
export const MAX_SAVE_BYTES = 8_000_000;

/** The payload `Game.to_dict()` produces, field for field. */
export interface SavePayload {
  schema_version: number;
  content_version: number;
  flags: Record<string, unknown>;
  vars: Record<string, unknown>;
  inventory: Record<string, unknown>;
  held_item: string;
  quests: Record<string, unknown>;
  talk_counts: Record<string, unknown>;
  visited: Record<string, unknown>;
  npc_memory: Record<string, unknown>;
  time_of_day: string;
  current_location: string;
  player_position: [number, number];
  playtime_sec: number;
}

export function emptySave(overrides: Partial<SavePayload> = {}): SavePayload {
  return {
    schema_version: SAVE_SCHEMA_VERSION,
    content_version: 0,
    flags: {},
    vars: {},
    inventory: {},
    held_item: "",
    quests: {},
    talk_counts: {},
    visited: {},
    npc_memory: {},
    time_of_day: "day",
    current_location: "",
    player_position: [0, 0],
    playtime_sec: 0,
    ...overrides,
  };
}

/** The projection conditions read, which is a subset of what a save carries. */
export function toConditionState(save: SavePayload): ConditionState {
  return {
    flags: save.flags,
    vars: save.vars,
    inventory: save.inventory,
    visited: save.visited,
    talk_counts: save.talk_counts,
    quests: save.quests,
    held_item: save.held_item,
    time_of_day: save.time_of_day,
  };
}

export type DecodeResult =
  | { ok: true; save: SavePayload }
  | { ok: false; reason: string };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Run bytes through a compression stream.
 *
 * The cast is for TypeScript's `ArrayBufferLike` generic only: a `Uint8Array` is a `BufferSource`
 * at runtime, which is all the writer requires.
 */
async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  // A corrupt body fails both sides, and the writer's copy of that failure is unhandled if nobody
  // takes it — which surfaces as a stray rejection attributed to whatever ran next. The reader's
  // error is the one worth propagating, so these two are absorbed deliberately.
  void writer.write(bytes as unknown as BufferSource).catch(() => undefined);
  void writer.close().catch(() => undefined);

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.length;
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The shareable code a player copies out. */
export async function encodeSave(save: SavePayload): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(save));
  const packed = await transform(raw, new CompressionStream("deflate"));

  const sized = new Uint8Array(4 + packed.length);
  new DataView(sized.buffer).setUint32(0, raw.length, true); // little-endian, as `encode_u32` writes
  sized.set(packed, 4);

  return toBase64(sized);
}

/** A code the players' hands have been through: quoted, spaced, or line-wrapped by a chat app. */
export async function decodeSave(code: string): Promise<DecodeResult> {
  const sized = fromBase64(code.replace(/\s+/g, ""));
  if (sized === null) return { ok: false, reason: "not base64" };
  if (sized.length < 4) return { ok: false, reason: "too short to carry a length prefix" };

  const size = new DataView(sized.buffer, sized.byteOffset, sized.byteLength).getUint32(0, true);
  // The same guards `import_code` applies, so a mangled code cannot allocate its way to a crash.
  if (size === 0) return { ok: false, reason: "declared length is zero" };
  if (size > MAX_SAVE_BYTES) return { ok: false, reason: "declared length is implausible" };

  let raw: Uint8Array;
  try {
    raw = await transform(sized.subarray(4), new DecompressionStream("deflate"));
  } catch {
    return { ok: false, reason: "the body is not a zlib stream" };
  }

  // Godot hands `size` to decompress as the expected output length; checking it here catches a
  // truncated body with the same force.
  if (raw.length !== size) {
    return { ok: false, reason: `decompressed ${raw.length} bytes, the prefix declared ${size}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: "the payload is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "the payload is not an object" };
  }

  return normalise(parsed as Record<string, unknown>);
}

/** `Game.from_dict`, including its defaults and its held-item rule. */
function normalise(data: Record<string, unknown>): DecodeResult {
  const version = Number(data["schema_version"] ?? 0);
  if (Number.isFinite(version) && version > SAVE_SCHEMA_VERSION) {
    return { ok: false, reason: `save schema ${version} is newer than this build` };
  }

  const bag = (key: string): Record<string, unknown> => {
    const value = data[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };

  const inventory = bag("inventory");
  const claimed = String(data["held_item"] ?? "");
  // A save that lost the held item (or predates the field) starts with empty hands.
  const held = claimed !== "" && Object.prototype.hasOwnProperty.call(inventory, claimed) ? claimed : "";

  const position = Array.isArray(data["player_position"]) ? data["player_position"] : [0, 0];
  const x = Number(position[0] ?? 0);
  const y = Number(position[1] ?? 0);

  return {
    ok: true,
    save: {
      schema_version: Number.isFinite(version) ? version : 0,
      content_version: Number(data["content_version"] ?? 0),
      flags: bag("flags"),
      vars: bag("vars"),
      inventory,
      held_item: held,
      quests: bag("quests"),
      talk_counts: bag("talk_counts"),
      visited: bag("visited"),
      npc_memory: bag("npc_memory"),
      time_of_day: String(data["time_of_day"] ?? "day"),
      current_location: String(data["current_location"] ?? ""),
      player_position: [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0],
      playtime_sec: Number(data["playtime_sec"] ?? 0),
    },
  };
}
