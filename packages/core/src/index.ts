/**
 * `@hkstories/core` — the engine-agnostic rules of the game.
 *
 * Three consumers, one implementation:
 *   - the Phaser client, which gates doors, quests and interactables;
 *   - the TanStack Start server, which filters model output before a turn reaches the player;
 *   - the admin, which answers "would this publish?" and "would this pass right now?".
 *
 * Nothing here touches the filesystem, the DOM, an engine, or the network. That is what makes
 * the same module usable in a browser, in a test, and on a server — and it is why loading a
 * content pack is the caller's job.
 */

export {
  approxEqual,
  evaluate,
  type Condition,
  type EvaluateOptions,
} from "./conditions";

export {
  LOCALES,
  FALLBACK_LOCALE,
  isRecord,
  pyBool,
  toFloat,
  toInt,
  toKey,
  bucket,
  type ConditionState,
  type Locale,
  type QuestRecord,
} from "./state";

export {
  addItem,
  applyEffects,
  emptyGameState,
  getVar,
  itemCount,
  maxStack,
  removeItem,
  setFlag,
  setVar,
  type ContentLookup,
  type EffectContext,
  type EffectOutcome,
  type GameEvent,
  type GameState,
} from "./effects";

export {
  MAX_ACTIONS_PER_TURN,
  validateActions,
  type ActionRejection,
  type ActionState,
  type ActionVerdict,
  type NpcLike,
  type RejectedAction,
} from "./actions";

export {
  asLocale,
  localize,
  missingLocales,
  resolveLocale,
  type LocalizeOptions,
} from "./locale";

export {
  KNOWN_ACTION_TYPES,
  KNOWN_CONDITION_VERBS,
  KNOWN_EFFECT_TYPES,
  errorsOnly,
  isPublishable,
  packFromEntries,
  validatePack,
  type ContentEntity,
  type ContentPack,
  type Issue,
  type IssueLevel,
} from "./validate";

export {
  DEFAULT_MAX_CHAIN,
  canonicalJson,
  mergeDocuments,
  resolveInheritance,
  type ResolveOptions,
  type ResolvedContent,
} from "./inheritance";

export {
  collectAssetRefs,
  isAssetReference,
  locateAsset,
  type AssetLocation,
  type AssetRoot,
  type CollectedAsset,
} from "./assets";

export {
  BASE_LAYER_ID,
  TRANSPARENT_TILE,
  layerTileAt,
  tileLayers,
  type TileLayer,
} from "./tiles";

export {
  ACTION_TYPES,
  MOODS,
  NpcActionSchema,
  NpcReplySchema,
  npcReplyResponseFormat,
  parseNpcReply,
  parseNpcReplyJSON,
  type Mood,
  type NpcAction,
  type NpcReply,
} from "./schema";
