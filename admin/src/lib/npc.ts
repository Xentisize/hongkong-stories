/* NPC draft helpers shared by the form and the editor view (PLAN 5.1, 9.2). */

export type Entity = Record<string, unknown>;

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Make sure every sub-object the form touches exists, so a blank draft or a thin clone does not
 * throw on the first edit. Mutating the draft in place is intentional: the entity IS the form
 * model, exactly as before — React only decides when to re-render.
 */
export function ensureNpcShape(entity: Entity): Entity {
  entity["display_name"] ??= { zh_HK: "", zh_CN: "", en: "" };
  const persona = (entity["persona"] = asObject(entity["persona"]));
  persona["role"] ??= "";
  persona["voice"] ??= "";
  persona["wants"] ??= "";
  persona["taboos"] ??= [];
  persona["knowledge_tags"] ??= [];
  const llm = (entity["llm"] = asObject(entity["llm"]));
  llm["actions_allowed"] ??= [];
  llm["items_may_give"] ??= [];
  llm["flags_may_set"] ??= [];
  entity["secrets"] ??= [];
  const fallback = (entity["scripted_fallback"] = asObject(entity["scripted_fallback"]));
  fallback["greeting"] ??= { zh_HK: "", zh_CN: "", en: "" };
  fallback["lines"] ??= [];
  fallback["exit"] ??= { zh_HK: "", zh_CN: "", en: "" };
  entity["trigger"] = asObject(entity["trigger"]);
  return entity;
}

/** Write a generated asset path into the draft's sprite block, per art kind. */
export function applyArtPath(entity: Entity, kind: string, path: string): void {
  const sprite = asObject(entity["sprite"]);
  if (kind === "sprite") {
    sprite["sheet"] = path;
    sprite["frames"] = { idle: [0] };
  } else if (kind === "portrait") {
    sprite["portrait"] = path;
  } else {
    const props: string[] = Array.isArray(sprite["props"]) ? (sprite["props"] as string[]) : [];
    if (!props.includes(path)) props.push(path);
    sprite["props"] = props;
  }
  entity["sprite"] = sprite;
}

export function blankNpc(): Entity {
  return {
    schema_version: 1,
    id: "npc_ch01_new",
    era: "ch01_hk_2027",
    sprite: null,
    display_name: { zh_HK: "", zh_CN: "", en: "" },
    persona: { role: "", voice: "", wants: "", taboos: [], knowledge_tags: [] },
    lore: "",
    llm: {
      model: null,
      temperature: 0.85,
      max_tokens: 320,
      language_follow_player: true,
      actions_allowed: [],
      items_may_give: [],
      flags_may_set: [],
      vars_may_change: {},
    },
    secrets: [],
    scripted_fallback: {
      greeting: { zh_HK: "", zh_CN: "", en: "" },
      lines: [],
      exit: { zh_HK: "", zh_CN: "", en: "" },
    },
    trigger: { location: "loc_ssp_market_street", requires: null },
  };
}
