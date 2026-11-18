/**
 * Content validation for the publish pipeline (§9.2, §11).
 *
 * Publishing refuses anything with an `error`-level issue: a missing locale, an unknown
 * referenced id, an unreachable quest node, or a flag no effect can set are all ways to ship a
 * broken build silently. `warn`-level issues are reported but do not block.
 *
 * Hand-rolled rather than a JSON Schema for the same reason as the original: the §5 shapes are
 * small, and the referential rules (every id resolves, every flag is settable, every quest node
 * is reachable) are what actually catch authoring mistakes.
 *
 * ## Why this lives in the shared core
 *
 * It used to run in exactly one place — the Python backend — with `tools/check_content.py` as a
 * CLI wrapper for CI. Now one implementation serves all three consumers: CI, the admin's inline
 * "jump to error" UI, and (optionally) the client at boot. The admin can finally answer "would
 * this publish?" without a round trip.
 *
 * `validatePack` is pure: it takes an in-memory pack and returns issues. Loading from disk or
 * over the network is the caller's business, which is what lets it run in a browser.
 */

import { isRecord, pyBool, toInt, toKey } from "./state";

export const LOCALES = ["zh_HK", "zh_CN", "en"] as const;

/** Every verb the condition mini-language understands (§5.5). */
export const KNOWN_CONDITION_VERBS: ReadonlySet<string> = new Set([
  "all",
  "any",
  "not",
  "flag",
  "has_item",
  "held",
  "var",
  "visited",
  "talked",
  "quest_state",
  "quest_done",
  "time_of_day",
]);

/** Every effect type the interpreter understands (§5.6). */
export const KNOWN_EFFECT_TYPES: ReadonlySet<string> = new Set([
  "set_flag",
  "give",
  "take",
  "var",
  "say",
  "quest",
  "goto",
  "reveal_secret",
  "open_shop",
  "play_sfx",
  "shake",
  "fade",
]);

/** Action types a model may be permitted to request (§5.1, schema.py). */
export const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  "give",
  "take",
  "set_flag",
  "var",
  "reveal_secret",
  "open_shop",
]);

export type IssueLevel = "error" | "warn";

export interface Issue {
  level: IssueLevel;
  path: string;
  message: string;
}

export type ContentEntity = Record<string, unknown>;

/**
 * A loaded content pack: `tables[kind][id] = entity`.
 *
 * This is the same shape `ContentStore.tables` has on the backend, so the two agree by
 * construction rather than by convention.
 */
export interface ContentPack {
  tables: Record<string, Record<string, ContentEntity>>;
  version?: number;
  contentHash?: string;
  /**
   * Manifest paths whose entity carried no usable `id`, so it never reached a table.
   *
   * Without this, such a file simply does not exist as far as every rule below is concerned: the
   * settings document vanished this way on its first run. Validation has to be able to say so,
   * because the publish refusal uses this function and never sees the manifest.
   */
  dropped?: string[];
}

/** Build a pack from `path → parsed JSON` entries, as read from `manifest.json`'s file list. */
export function packFromEntries(
  entries: Record<string, ContentEntity>,
  manifest: Record<string, unknown> = {},
): ContentPack {
  const tables: Record<string, Record<string, ContentEntity>> = {};
  const dropped: string[] = [];

  for (const [path, entity] of Object.entries(entries)) {
    const kind = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
    const id = toKey(entity["id"] ?? "");
    if (id === "") {
      dropped.push(path);
      continue;
    }
    (tables[kind] ??= {})[id] = entity;
  }

  return {
    tables,
    version: toInt(manifest["version"]),
    contentHash: toKey(manifest["content_hash"] ?? ""),
    dropped,
  };
}

export function validatePack(pack: ContentPack): Issue[] {
  const issues: Issue[] = [];

  const issue = (level: IssueLevel, path: string, message: string) =>
    issues.push({ level, path, message });
  const err = (path: string, message: string) => issue("error", path, message);
  const warn = (path: string, message: string) => issue("warn", path, message);

  const npcs = pack.tables["npcs"] ?? {};
  const items = pack.tables["items"] ?? {};
  const locations = pack.tables["locations"] ?? {};
  const quests = pack.tables["quests"] ?? {};
  const settings = pack.tables["settings"] ?? {};
  const chapters = pack.tables["chapters"] ?? {};

  // Every rule below iterates a table, so an entity that never reached one would be checked by
  // nothing at all. This is the only place that can report it.
  for (const path of pack.dropped ?? []) {
    err(path, "entity has no 'id' — it is dropped from the pack, so no rule validates it");
  }

  const flagsSettable = new Set<string>();

  // ---- shared walkers -----------------------------------------------------

  const walkEffects = (effects: unknown, path: string): void => {
    if (effects === null || effects === undefined) return;
    if (!Array.isArray(effects)) {
      err(path, "effects must be a list");
      return;
    }
    effects.forEach((effect, index) => {
      const at = `${path}[${index}]`;
      if (!isRecord(effect)) {
        err(at, "effect must be an object");
        return;
      }
      const kind = toKey(effect["type"] ?? "");
      if (!KNOWN_EFFECT_TYPES.has(kind)) {
        err(at, `unknown effect type '${kind}'`);
        return;
      }
      if (kind === "give" || kind === "take") {
        const item = toKey(effect["item"] ?? "");
        if (item !== "" && !(item in items)) err(at, `unknown item '${item}'`);
      } else if (kind === "quest") {
        const quest = toKey(effect["quest"] ?? "");
        if (quest !== "" && !(quest in quests)) err(at, `unknown quest '${quest}'`);
      } else if (kind === "reveal_secret") {
        const npc = toKey(effect["npc"] ?? "");
        if (npc !== "" && !(npc in npcs)) err(at, `unknown npc '${npc}'`);
      } else if (kind === "goto") {
        const location = toKey(effect["location"] ?? "");
        if (location !== "" && !(location in locations)) {
          err(at, `unknown location '${location}'`);
        }
      } else if (kind === "set_flag") {
        const flag = toKey(effect["flag"] ?? "");
        if (flag !== "") flagsSettable.add(flag);
      }
    });
  };

  const walkConditions = (condition: unknown, path: string): void => {
    if (condition === null || condition === undefined) return;
    if (!isRecord(condition)) {
      err(path, "condition must be an object");
      return;
    }
    if (Object.keys(condition).length === 0) return;

    if ("all" in condition || "any" in condition) {
      const verb = "all" in condition ? "all" : "any";
      const branches = condition[verb];
      if (!Array.isArray(branches)) {
        err(path, `'${verb}' must be a list`);
        return;
      }
      branches.forEach((sub, index) => walkConditions(sub, `${path}.${verb}[${index}]`));
      return;
    }

    if ("not" in condition) {
      walkConditions(condition["not"], `${path}.not`);
      return;
    }

    const verb = Object.keys(condition)[0] ?? "";
    if (!KNOWN_CONDITION_VERBS.has(verb)) {
      err(path, `unknown condition verb '${verb}'`);
      return;
    }
    if (verb === "held") {
      const held = toKey(condition[verb] ?? "");
      if (held !== "" && !(held in items)) err(path, `unknown item '${held}'`);
    }
  };

  const checkLocalized = (field: unknown, path: string, required = true): void => {
    if (typeof field === "string") {
      if (required && field.trim() === "") err(path, "required string is empty");
      return;
    }
    if (!isRecord(field)) {
      if (required) err(path, "expected a localized object or string");
      return;
    }
    const keys = new Set(Object.keys(field));
    const missing = LOCALES.filter((locale) => !keys.has(locale));
    if (missing.length > 0 && !keys.has("_todo")) {
      err(path, `missing locales ${JSON.stringify(missing)} (declare them in _todo to acknowledge)`);
    }
    for (const locale of LOCALES) {
      const value = field[locale];
      if (typeof value === "string" && value.trim() === "" && keys.has(locale)) {
        err(`${path}.${locale}`, "locale key present but empty");
      }
    }
  };

  // ---- npcs ---------------------------------------------------------------

  for (const npcId of sortedKeys(npcs)) {
    const npc = npcs[npcId]!;
    const at = `npcs/${npcId}`;
    checkLocalized(npc["display_name"], `${at}.display_name`);

    const persona = npc["persona"];
    if (!isRecord(persona) || toKey(persona["role"] ?? "").trim() === "") {
      err(`${at}.persona.role`, "persona.role is required");
    }

    let llm: ContentEntity;
    const rawLlm = npc["llm"];
    if (isRecord(rawLlm)) {
      llm = rawLlm;
    } else {
      err(`${at}.llm`, "llm block is required");
      llm = {};
    }

    for (const action of asArray(llm["actions_allowed"])) {
      if (!KNOWN_ACTION_TYPES.has(toKey(action))) {
        err(`${at}.llm.actions_allowed`, `unknown action type '${toKey(action)}'`);
      }
    }
    for (const item of asArray(llm["items_may_give"])) {
      if (!(toKey(item) in items)) err(`${at}.llm.items_may_give`, `unknown item '${toKey(item)}'`);
    }
    for (const flag of asArray(llm["flags_may_set"])) flagsSettable.add(toKey(flag));

    for (const secret of asArray(npc["secrets"])) {
      if (!isRecord(secret)) {
        err(`${at}.secrets`, "secret must be an object");
        continue;
      }
      const secretId = toKey(secret["id"] ?? "");
      if (secretId === "") {
        err(`${at}.secrets`, "secret missing id");
        continue;
      }
      checkLocalized(secret["text"], `${at}.secrets/${secretId}.text`, false);
      walkConditions(secret["reveal_if"], `${at}.secrets/${secretId}.reveal_if`);
    }

    // Event pages (RPG Maker lessons, §5.1): ordered states with conditions; each may patch
    // persona fields, extend lore, and override the offline ladder.
    asArray(npc["states"]).forEach((page, index) => {
      const pageAt = `${at}.states[${index}]`;
      if (!isRecord(page)) {
        err(pageAt, "state must be an object");
        return;
      }
      walkConditions(page["requires"], `${pageAt}.requires`);
      const patch = page["persona_patch"];
      if (patch !== undefined && patch !== null && !isRecord(patch)) {
        err(`${pageAt}.persona_patch`, "persona_patch must be an object");
      }
      if ("lore_extra" in page && toKey(page["lore_extra"] ?? "").trim() === "") {
        err(`${pageAt}.lore_extra`, "lore_extra must be a non-empty string when present");
      }
      asArray(page["fallback_lines"]).forEach((line, lineIndex) => {
        const lineAt = `${pageAt}.fallback_lines[${lineIndex}]`;
        if (isRecord(line) && "text" in line) {
          checkLocalized(line["text"], `${lineAt}.text`);
          walkConditions(line["requires"], `${lineAt}.requires`);
          walkEffects(line["actions"], `${lineAt}.actions`);
        } else {
          checkLocalized(line, lineAt);
        }
      });
    });

    let fallback: ContentEntity;
    const rawFallback = npc["scripted_fallback"];
    if (isRecord(rawFallback)) {
      fallback = rawFallback;
    } else {
      err(`${at}.scripted_fallback`, "scripted_fallback is required (§7.4)");
      fallback = {};
    }
    checkLocalized(fallback["greeting"], `${at}.scripted_fallback.greeting`);
    asArray(fallback["lines"]).forEach((line, index) => {
      const lineAt = `${at}.scripted_fallback.lines[${index}]`;
      if (isRecord(line) && "text" in line) {
        checkLocalized(line["text"], `${lineAt}.text`);
        walkConditions(line["requires"], `${lineAt}.requires`);
        walkEffects(line["actions"], `${lineAt}.actions`);
      } else {
        checkLocalized(line, lineAt);
      }
    });
    checkLocalized(fallback["exit"], `${at}.scripted_fallback.exit`, false);

    const trigger = npc["trigger"];
    if (isRecord(trigger)) {
      const location = trigger["location"];
      if (location !== undefined && location !== null && location !== "" && !(toKey(location) in locations)) {
        err(`${at}.trigger.location`, `unknown location '${toKey(location)}'`);
      }
      walkConditions(trigger["requires"], `${at}.trigger.requires`);
    }
  }

  // ---- items --------------------------------------------------------------

  for (const itemId of sortedKeys(items)) {
    const item = items[itemId]!;
    const at = `items/${itemId}`;
    checkLocalized(item["name"], `${at}.name`);
    checkLocalized(item["desc"], `${at}.desc`, false);
    if (pyBool(item["usable"])) {
      checkLocalized(item["use_locked"], `${at}.use_locked`, false);
      walkConditions(item["use_requires"], `${at}.use_requires`);
    }
    walkEffects(item["on_use"], `${at}.on_use`);
    walkEffects(item["on_acquire"], `${at}.on_acquire`);
  }

  // ---- locations ----------------------------------------------------------

  for (const locationId of sortedKeys(locations)) {
    const location = locations[locationId]!;
    const at = `locations/${locationId}`;
    checkLocalized(location["display_name"], `${at}.display_name`);

    // The per-map context sheet (RPG Maker lessons, #3): prompt-facing texture for the
    // location's NPCs. Optional, but present means non-empty.
    if ("context" in location && toKey(location["context"] ?? "").trim() === "") {
      err(`${at}.context`, "context must be a non-empty string when present");
    }

    const rows = asArray(location["tilemap"]);
    const widths = new Set(rows.map((row) => String(row).length));
    if (widths.size > 1) warn(`${at}.tilemap`, "rows have differing lengths");

    // Collision rects are what the client actually walks into. They were hand-authored JSON that
    // nothing checked, and the map editor can write them now — so the gate has to refuse a rect that
    // sits outside its map (a wall nobody can reach, or a cell the author thought was solid) or one
    // that covers nothing at all.
    const collision = location["collision"];
    if (collision !== undefined) {
      if (!Array.isArray(collision)) {
        err(`${at}.collision`, "collision must be an array of [x, y, w, h] rects");
      } else {
        let mapWidth = 0;
        for (const row of rows) mapWidth = Math.max(mapWidth, String(row).length);
        const mapHeight = rows.length;

        for (const entry of collision) {
          if (!Array.isArray(entry) || entry.length !== 4) {
            err(`${at}.collision`, "each rect must be [x, y, w, h]");
            continue;
          }

          const x = Number(entry[0]);
          const y = Number(entry[1]);
          const w = Number(entry[2]);
          const h = Number(entry[3]);

          if (![x, y, w, h].every(Number.isInteger)) {
            err(`${at}.collision`, `rect [${entry.join(", ")}] must use whole tile coordinates`);
            continue;
          }
          if (w <= 0 || h <= 0) {
            err(`${at}.collision`, `rect [${x}, ${y}, ${w}, ${h}] covers no tiles`);
            continue;
          }
          if (x < 0 || y < 0 || x + w > mapWidth || y + h > mapHeight) {
            err(
              `${at}.collision`,
              `rect [${x}, ${y}, ${w}, ${h}] is outside the ${mapWidth}x${mapHeight} map`,
            );
          }
        }
      }
    }

    for (const placement of asArray(location["npcs"])) {
      if (!isRecord(placement)) {
        err(`${at}.npcs`, "placement must be an object");
        continue;
      }
      const npcRef = toKey(placement["npc"] ?? "");
      if (npcRef !== "" && !(npcRef in npcs)) err(`${at}.npcs`, `unknown npc '${npcRef}'`);
      walkConditions(placement["requires"], `${at}.npcs/${npcRef}.requires`);
    }

    for (const door of asArray(location["doors"])) {
      if (!isRecord(door)) {
        err(`${at}.doors`, "door must be an object");
        continue;
      }
      const doorId = toKey(door["id"] ?? "?");
      walkConditions(door["requires"], `${at}.doors/${doorId}.requires`);
      const flag = toKey(door["open_flag"] ?? "");
      if (flag !== "") flagsSettable.add(flag);
      for (const key of ["prompt", "blocked", "opened"]) {
        checkLocalized(door[key], `${at}.doors/${doorId}.${key}`, false);
      }
    }

    for (const interactable of asArray(location["interactables"])) {
      if (!isRecord(interactable)) {
        err(`${at}.interactables`, "interactable must be an object");
        continue;
      }
      const propId = toKey(interactable["id"] ?? "?");
      checkLocalized(interactable["prompt"], `${at}.interactables/${propId}.prompt`, false);
      walkConditions(interactable["requires"], `${at}.interactables/${propId}.requires`);
      walkEffects(interactable["on_interact"], `${at}.interactables/${propId}.on_interact`);
    }

    const ownSpawns = isRecord(location["spawn_points"]) ? location["spawn_points"] : {};
    for (const exitDef of asArray(location["exits"])) {
      if (!isRecord(exitDef)) {
        err(`${at}.exits`, "exit must be an object");
        continue;
      }
      const exitId = toKey(exitDef["id"] ?? "?");
      const target = toKey(exitDef["to"] ?? "");
      if (target !== "" && !(target in locations)) {
        err(`${at}.exits/${exitId}`, `unknown location '${target}'`);
        continue;
      }
      const spawn = toKey(exitDef["spawn"] ?? "default");
      const targetLocation = locations[target] ?? {};
      const targetSpawns = isRecord(targetLocation["spawn_points"])
        ? targetLocation["spawn_points"]
        : {};
      if (spawn !== "default" && !(spawn in targetSpawns) && !(spawn in ownSpawns)) {
        err(`${at}.exits/${exitId}`, `spawn '${spawn}' not defined in '${target}'`);
      }
      walkConditions(exitDef["requires"], `${at}.exits/${exitId}.requires`);
      checkLocalized(exitDef["blocked"], `${at}.exits/${exitId}.blocked`, false);
    }
  }

  /** One splash block, shared by the game settings and by a chapter's own opening image. */
  const checkSplash = (value: unknown, path: string): void => {
    if (!isRecord(value)) {
      err(path, "splash must be an object");
      return;
    }

    const art = toKey(value["art"] ?? "");
    // Content-relative, like every other art path: absolute or traversing paths are how a pack reads
    // files it has no business reading.
    if (art === "" || art.startsWith("/") || art.includes("..")) {
      err(`${path}.art`, "splash.art must be a content-relative path");
    }

    // A number, not something `Number()` can turn into one: `null` and `""` both coerce to 0.
    const duration = value["duration_ms"];
    if (
      typeof duration !== "number" ||
      !Number.isInteger(duration) ||
      duration < 0 ||
      duration > 10_000
    ) {
      err(`${path}.duration_ms`, "duration_ms must be a whole number between 0 and 10000");
    }

    if (value["skippable"] !== undefined && typeof value["skippable"] !== "boolean") {
      err(`${path}.skippable`, "skippable must be a boolean");
    }
  };

  // ---- settings -----------------------------------------------------------

  // One document per pack, and the client reads exactly one id. Accepting others would let an author
  // edit a file nothing loads, which is worse than a loud failure here.
  for (const settingsId of sortedKeys(settings)) {
    const document = settings[settingsId]!;
    const at = `settings/${settingsId}`;

    if (settingsId !== "game") {
      err(at, "the settings document must be named 'game'");
      continue;
    }

    checkLocalized(document["title"], `${at}.title`);
    checkLocalized(document["subtitle"], `${at}.subtitle`, false);

    if (document["splash"] !== undefined) checkSplash(document["splash"], `${at}.splash`);

    // Every other block errors when it is the wrong shape; credits folding into an empty list
    // would ship a game with a blank credits screen and nothing in the log.
    if (document["credits"] !== undefined && !Array.isArray(document["credits"])) {
      err(`${at}.credits`, "credits must be a list");
    }

    for (const credit of asArray(document["credits"])) {
      if (!isRecord(credit)) {
        err(`${at}.credits`, "each credit must be an object");
        continue;
      }

      checkLocalized(credit["role"], `${at}.credits.role`, false);

      const names = asArray(credit["names"]);
      if (names.length === 0 || names.some((name) => toKey(name).trim() === "")) {
        err(`${at}.credits.names`, "each credit needs at least one non-empty name");
      }
    }

    const defaults = document["defaults"];
    if (defaults !== undefined) {
      if (!isRecord(defaults)) {
        err(`${at}.defaults`, "defaults must be an object");
      } else {
        const locale = toKey(defaults["locale"] ?? "auto");
        // `auto` plus the shared list: a second copy of the locale codes would go stale the moment
        // a locale is added, and then a valid pack would be refused here.
        if (!["auto", ...LOCALES].includes(locale)) {
          err(`${at}.defaults.locale`, `unknown locale '${locale}'`);
        }

        for (const key of ["music_db", "sfx_db"]) {
          const raw = defaults[key];
          if (raw === undefined) continue;

          // A bus gain runs from silence to unity, and `null`/`""` coerce to 0 — unity gain, the
          // loudest legal value. A cleared field must not mean "play at full volume".
          if (typeof raw !== "number" || !Number.isFinite(raw) || raw > 0 || raw < -60) {
            err(`${at}.defaults.${key}`, `${key} must be a number between -60 and 0`);
          }
        }
      }
    }

    const start = document["start"];
    if (start !== undefined) {
      if (!isRecord(start)) {
        err(`${at}.start`, "start must be an object");
      } else {
        // `in` walks the prototype chain, so "constructor" would pass as a location id and the
        // client would then index a function. Own properties only.
        const location = toKey(start["location"] ?? "");
        if (!Object.hasOwn(locations, location)) {
          err(`${at}.start.location`, `unknown location '${location}'`);
        } else {
          const spawn = toKey(start["spawn"] ?? "default");
          const spawnPoints = locations[location]!["spawn_points"];
          const spawns = isRecord(spawnPoints) ? spawnPoints : {};
          if (spawn !== "default" && !Object.hasOwn(spawns, spawn)) {
            err(`${at}.start.spawn`, `spawn '${spawn}' not defined in '${location}'`);
          }
        }
      }
    }
  }

  // ---- chapters -----------------------------------------------------------

  // A chapter is the aggregation document: references only, so every entity keeps one home. What
  // matters is that the references resolve and that its entry is *inside* it — a chapter that starts
  // on a map it does not contain is a map nothing can reach from it.

  for (const chapterId of sortedKeys(chapters)) {
    const chapter = chapters[chapterId]!;
    const at = `chapters/${chapterId}`;

    checkLocalized(chapter["title"], `${at}.title`);
    if (chapter["splash"] !== undefined) checkSplash(chapter["splash"], `${at}.splash`);

    const chapterLocations = new Set<string>();
    for (const raw of asArray(chapter["locations"])) {
      const locationId = toKey(raw);
      if (locationId === "") continue;

      if (!Object.hasOwn(locations, locationId)) {
        err(`${at}.locations`, `unknown location '${locationId}'`);
        continue;
      }
      if (chapterLocations.has(locationId)) {
        err(`${at}.locations`, `location '${locationId}' is listed twice`);
      }
      chapterLocations.add(locationId);
    }
    if (chapterLocations.size === 0) {
      err(`${at}.locations`, "a chapter needs at least one location");
    }

    const chapterQuests: string[] = [];
    for (const raw of asArray(chapter["quests"])) {
      const questId = toKey(raw);
      if (questId === "") continue;

      if (!Object.hasOwn(quests, questId)) err(`${at}.quests`, `unknown quest '${questId}'`);
      chapterQuests.push(questId);
    }
    if (chapterQuests.length === 0) err(`${at}.quests`, "a chapter needs at least one quest");

    const entry = chapter["entry"];
    if (!isRecord(entry)) {
      err(`${at}.entry`, "entry must be an object");
    } else {
      const entryLocation = toKey(entry["location"] ?? "");
      if (!chapterLocations.has(entryLocation)) {
        err(
          `${at}.entry.location`,
          `entry location '${entryLocation}' is not one of this chapter's locations`,
        );
      } else {
        const spawn = toKey(entry["spawn"] ?? "default");
        const spawnPoints = locations[entryLocation]!["spawn_points"];
        const spawns = isRecord(spawnPoints) ? spawnPoints : {};
        if (spawn !== "default" && !Object.hasOwn(spawns, spawn)) {
          err(`${at}.entry.spawn`, `spawn '${spawn}' not defined in '${entryLocation}'`);
        }
      }
      walkConditions(entry["requires"], `${at}.entry.requires`);
    }

    const targets = new Set<string>();
    for (const raw of asArray(chapter["transitions"])) {
      if (!isRecord(raw)) {
        err(`${at}.transitions`, "each transition must be an object");
        continue;
      }

      const to = toKey(raw["to"] ?? "");
      if (to === chapterId) {
        err(`${at}.transitions`, "a chapter cannot transition to itself");
      } else if (!Object.hasOwn(chapters, to)) {
        err(`${at}.transitions`, `unknown chapter '${to}'`);
      } else if (targets.has(to)) {
        err(`${at}.transitions`, `chapter '${to}' is targeted twice`);
      } else {
        targets.add(to);
      }

      walkConditions(raw["requires"], `${at}.transitions/${to}.requires`);
      checkLocalized(raw["text"], `${at}.transitions/${to}.text`, false);
    }
  }

  // A location's own `era` already claims a chapter. If that chapter does not list the location, the
  // two disagree about which maps a chapter spans — and the engine reads the chapter, not the era.
  for (const locationId of sortedKeys(locations)) {
    const era = toKey(locations[locationId]!["era"] ?? "");
    if (era === "") continue;

    const chapterId = era.split("_")[0] ?? "";
    const chapter = chapters[chapterId];
    if (!isRecord(chapter)) continue; // an era whose chapter document does not exist yet

    const listed = asArray(chapter["locations"]).map((entry) => toKey(entry));
    if (!listed.includes(locationId)) {
      err(
        `chapters/${chapterId}.locations`,
        `location '${locationId}' declares era '${era}' but is not listed in this chapter`,
      );
    }
  }

  // A chapter quest that no chapter claims means the aggregation is incomplete.
  for (const questId of sortedKeys(quests)) {
    if (!questId.startsWith("ch")) continue;

    const claimed = sortedKeys(chapters).some((chapterId) =>
      asArray(chapters[chapterId]!["quests"])
        .map((entry) => toKey(entry))
        .includes(questId),
    );
    if (!claimed) {
      warn(`quests/${questId}`, "belongs to no chapter — the chapter aggregate is incomplete");
    }
  }

  // ---- quests -------------------------------------------------------------

  for (const questId of sortedKeys(quests)) {
    const quest = quests[questId]!;
    const at = `quests/${questId}`;
    checkLocalized(quest["title"], `${at}.title`, false);
    walkConditions(quest["entry_requires"], `${at}.entry_requires`);

    const nodes = asArray(quest["nodes"]);
    if (nodes.length === 0) {
      err(`${at}.nodes`, "quest has no nodes");
      continue;
    }

    const nodeIds = nodes.filter(isRecord).map((node) => toKey(node["id"] ?? ""));
    if (nodeIds.length !== new Set(nodeIds).size) err(`${at}.nodes`, "duplicate node ids");

    const byId = new Map<string, ContentEntity>();
    for (const node of nodes) {
      if (isRecord(node)) byId.set(toKey(node["id"] ?? ""), node);
    }

    const first = nodeIds[0] ?? "";
    const reachable = new Set<string>();
    const stack = [first];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      const node = byId.get(current);
      const next = node?.["next"];
      if (typeof next === "string" && next !== "") {
        if (!byId.has(next)) err(`${at}.nodes/${current}.next`, `unknown node '${next}'`);
        else stack.push(next);
      }
    }

    for (const node of nodes) {
      if (!isRecord(node)) continue;
      const nodeId = toKey(node["id"] ?? "?");
      const nodeAt = `${at}.nodes/${nodeId}`;
      if (!reachable.has(nodeId)) {
        err(nodeAt, "unreachable node (not on the next chain from the first node)");
      }
      checkLocalized(node["text"], `${nodeAt}.text`, false);
      walkConditions(node["complete_when"], `${nodeAt}.complete_when`);
      walkEffects(node["on_complete"], `${nodeAt}.on_complete`);
    }
  }

  // ---- §11: every flag a condition reads must be settable by something ----

  const referenced = new Set<string>();
  const collectFlags = (value: unknown): void => {
    if (isRecord(value)) {
      if ("flag" in value) referenced.add(toKey(value["flag"]));
      for (const nested of Object.values(value)) collectFlags(nested);
    } else if (Array.isArray(value)) {
      for (const nested of value) collectFlags(nested);
    }
  };

  for (const npc of Object.values(npcs)) {
    for (const secret of asArray(npc["secrets"])) {
      if (isRecord(secret)) collectFlags(secret["reveal_if"]);
    }
    const trigger = npc["trigger"];
    if (isRecord(trigger)) collectFlags(trigger["requires"]);
  }
  for (const item of Object.values(items)) collectFlags(item["use_requires"]);
  for (const location of Object.values(locations)) {
    for (const door of asArray(location["doors"])) {
      if (isRecord(door)) collectFlags(door["requires"]);
    }
    for (const exitDef of asArray(location["exits"])) {
      if (isRecord(exitDef)) collectFlags(exitDef["requires"]);
    }
  }
  for (const quest of Object.values(quests)) {
    collectFlags(quest["entry_requires"]);
    for (const node of asArray(quest["nodes"])) {
      if (isRecord(node)) collectFlags(node["complete_when"]);
    }
  }
  for (const flag of [...referenced].sort()) {
    if (!flagsSettable.has(flag)) {
      warn("flags", `'${flag}' is read by a condition but nothing can set it`);
    }
  }

  return issues;
}

/** Errors only — what the publish gate actually refuses. */
export function errorsOnly(issues: Issue[]): Issue[] {
  return issues.filter((issue) => issue.level === "error");
}

/** True when the pack may be published. */
export function isPublishable(issues: Issue[]): boolean {
  return errorsOnly(issues).length === 0;
}

function sortedKeys(table: Record<string, unknown>): string[] {
  return Object.keys(table).sort();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
