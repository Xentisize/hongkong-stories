/* Authoring-time inheritance: `extends`, resolved into flat documents.
 *
 * PROTOTYPE — nothing in the publish path calls this yet. The point is to make the decision
 * testable: what the merge rules are, what gets refused, and what the resolved pack costs.
 *
 * The rule that matters is *when* the chain is walked. Resolution happens once, here, and every
 * consumer downstream (validator, clients, hot-pack hash, prompt building) only ever sees the flat
 * document. A chain that is walked at access time would put a string-keyed lookup in the frame loop
 * and would let two different paths resolve to the same text with different cache keys.
 *
 * Merge rules, chosen to be explainable in one line each:
 *   - objects merge, recursively;
 *   - arrays and scalars replace (a child that renames two quest nodes should not inherit a third);
 *   - `null` deletes the inherited key, which is how a child says "this parent field does not
 *     apply to me" without inventing a sentinel;
 *   - `id` is never inherited — identity is the file, not the parent;
 *   - `_`-prefixed keys (`extends`, `_comment`, `_todo`) are authoring notes, not data, so they are
 *     never inherited. A parent's `_todo: ["en"]` must not silence a child's missing `en`.
 */

import { isRecord, toKey } from "./state";
import type { ContentEntity, Issue } from "./validate";

/** How many links a chain may have. Deeper is refused rather than silently truncated. */
export const DEFAULT_MAX_CHAIN = 5;

export interface ResolveOptions {
  maxChain?: number;
}

export interface ResolvedContent {
  /** Path → flat document, under the same keys as the input so `packFromEntries` takes it as-is. */
  entries: Record<string, ContentEntity>;
  issues: Issue[];
  /** No errors: the pack may be validated and shipped. Warnings do not block. */
  ok: boolean;
}

/** Where one document lives: its pack path, its kind (first segment) and its id. */
interface Slot {
  path: string;
  kind: string;
  id: string;
  doc: ContentEntity;
}

/**
 * Resolve every document's `extends` chain.
 *
 * Unresolved documents are still returned — stripped of `extends`, without the parent applied — so
 * a caller can show the author what it *would* have been. `ok` is false in that case, and that is
 * the gate: the pack is not publishable until the chain resolves.
 */
export function resolveInheritance(
  entries: Record<string, ContentEntity>,
  options: ResolveOptions = {},
): ResolvedContent {
  const maxChain = options.maxChain ?? DEFAULT_MAX_CHAIN;
  const issues: Issue[] = [];
  const err = (path: string, message: string) =>
    issues.push({ level: "error", path: stripExtension(path), message });

  // Index first: a parent is found by kind + id, not by guessing a file name.
  const index = new Map<string, Slot>();
  const slots: Slot[] = [];
  for (const path of Object.keys(entries).sort()) {
    const doc = entries[path];
    if (!isRecord(doc)) continue;
    const kind = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
    const id = toKey(doc["id"] ?? "");
    if (id === "") {
      err(path, "document has no id, so nothing can extend it");
      continue;
    }

    const key = `${kind}/${id}`;
    const existing = index.get(key);
    if (existing) {
      err(path, `duplicate id '${id}' in ${kind} (also ${existing.path})`);
      continue;
    }

    const slot: Slot = { path, kind, id, doc };
    index.set(key, slot);
    slots.push(slot);
  }

  const resolved = new Map<string, ContentEntity>();
  /** `kind/id` → how many links its chain has, counted from the root document. */
  const depths = new Map<string, number>();
  const resolving: string[] = [];

  function resolve(slot: Slot): ContentEntity {
    const key = `${slot.kind}/${slot.id}`;
    const done = resolved.get(key);
    if (done) return done;

    const cycleAt = resolving.indexOf(key);
    if (cycleAt !== -1) {
      const chain = [...resolving.slice(cycleAt), key].join(" → ");
      err(slot.path, `inheritance cycle: ${chain}`);
      return flatOwn(slot.doc);
    }

    const ref = slot.doc["extends"];
    if (ref === undefined || ref === null || ref === "") {
      const own = flatOwn(slot.doc);
      resolved.set(key, own);
      depths.set(key, 1);
      return own;
    }

    if (typeof ref !== "string") {
      err(slot.path, "extends must be a parent id");
      const own = flatOwn(slot.doc);
      resolved.set(key, own);
      depths.set(key, 1);
      return own;
    }

    // Same-kind only, deliberately: an item extending an npc would pass a schema check that means
    // nothing, and per-kind rules are what makes the validator useful.
    if (ref.includes("/")) {
      err(slot.path, `cross-kind inheritance is not supported ('${ref}')`);
      const own = flatOwn(slot.doc);
      resolved.set(key, own);
      depths.set(key, 1);
      return own;
    }

    // Recursion guard, not the depth rule: a chain nobody has resolved yet unwinds one frame per
    // link, so this stops a pathological file set from exhausting the stack before the exact check
    // below gets a chance to refuse it.
    if (resolving.length >= maxChain) {
      err(slot.path, `inheritance chain longer than ${maxChain} links`);
      const own = flatOwn(slot.doc);
      resolved.set(key, own);
      depths.set(key, 1);
      return own;
    }

    const parent = index.get(`${slot.kind}/${ref}`);
    if (!parent) {
      err(slot.path, `unknown parent '${ref}' in ${slot.kind}`);
      const own = flatOwn(slot.doc);
      resolved.set(key, own);
      depths.set(key, 1);
      return own;
    }

    resolving.push(key);
    const inherited = resolve(parent);
    resolving.pop();

    // The exact rule. A parent already resolved from an earlier document is memoised, so the
    // recursion depth at this point says nothing about how long the chain actually is — the
    // recorded parent depth does.
    const myDepth = (depths.get(`${parent.kind}/${parent.id}`) ?? 1) + 1;
    if (myDepth > maxChain) {
      err(slot.path, `inheritance chain longer than ${maxChain} links`);
      const own = flatOwn(slot.doc);
      resolved.set(key, own);
      depths.set(key, 1);
      return own;
    }

    const merged = mergeDocuments(inherited, slot.doc);
    resolved.set(key, merged);
    depths.set(key, myDepth);
    return merged;
  }

  const out: Record<string, ContentEntity> = {};
  for (const slot of slots) {
    // Every document is resolved, so a broken chain is reported even when nothing extends it yet —
    // an unused template with a cycle is a trap waiting for the first child, not dead code.
    const doc = resolve(slot);

    // A document whose id starts with `_` is a **template**: it is resolved into whatever extends
    // it and is itself left out of the pack, so a base never ships as a playable item or a map a
    // player can walk into. It is still validated — through everything it produces.
    if (slot.id.startsWith("_")) continue;
    out[slot.path] = doc;
  }

  return { entries: out, issues, ok: issues.every((issue) => issue.level !== "error") };
}

/**
 * A document with no inheritance applied: its own fields, minus `extends` and authoring notes.
 *
 * `_comment` is kept — it documents *this* file — while `extends` is dropped because a flat
 * document has no parent.
 */
function flatOwn(doc: ContentEntity): ContentEntity {
  const own: ContentEntity = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "extends") continue;
    own[key] = value;
  }
  return own;
}

/** Deep merge `child` over `parent`, following the rules in the module comment. */
export function mergeDocuments(parent: ContentEntity, child: ContentEntity): ContentEntity {
  const merged: ContentEntity = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key === "id") continue;
    // Authoring notes belong to the file that wrote them: a parent's `_todo: ["en"]` must not
    // silence a child's missing `en`, and a parent's `_comment` explains the parent, not the child.
    if (key.startsWith("_")) continue;
    merged[key] = clone(value);
  }

  for (const [key, value] of Object.entries(child)) {
    if (key === "extends") continue;
    if (key.startsWith("_")) {
      merged[key] = clone(value);
      continue;
    }
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeDocuments(merged[key] as ContentEntity, value);
      continue;
    }
    merged[key] = clone(value);
  }

  // Identity is the file's, never the parent's.
  if (child["id"] !== undefined) merged["id"] = child["id"];
  return merged;
}

/** `items/item_tea_tin.json` → `items/item_tea_tin`, matching the validator's paths. */
function stripExtension(path: string): string {
  return path.endsWith(".json") ? path.slice(0, -".json".length) : path;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as unknown as T;
  if (isRecord(value)) {
    const copy: ContentEntity = {};
    for (const [key, inner] of Object.entries(value)) copy[key] = clone(inner);
    return copy as unknown as T;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted, array order preserved.
 *
 * A resolved pack exists only in memory, so the manifest's byte hash cannot describe it. Hashing
 * this instead gives a stable identity for "what the clients would load", which is what a hot-pack
 * version has to compare.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}
