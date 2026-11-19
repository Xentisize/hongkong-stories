import {
  applyEffects,
  evaluate,
  localize,
  resolveLocale,
  type ConditionState,
  type ContentLookup,
  type Locale,
} from "@hkstories/core";
import Phaser from "phaser";

import tilesUrl from "../../../client/assets/tiles/p1_tiles_2027.png";
import playerUrl from "../../../client/content/art/npcs/player_walk.png";
import bundledManifest from "../../../client/content/manifest.json";
import gameSettings from "../../../client/content/settings/game.json";
import "./style.css";

import { AudioDirector, WebAudioSink, gainFor } from "./audio";
import { artFileName, type LocalizedText, type LocationFile, type NpcFile } from "./content";
import { fetchManifest, planRefresh, type PackStatus } from "./content-pack";
import { attachPreviewBridge } from "./preview-bridge";
import { previewEnabled, previewPack } from "./preview-boot";
import { Dialogue, type DialogueView } from "./dialogue";
import { apiBase, openSession, type Session } from "./net";
import { QuestMachine, cutsceneLines, type QuestNode } from "./quests";
import { emptySave, encodeSave, type SavePayload } from "./save";
import { activeChapter, chapterEntry, orderChapters, planAdvance, type ChapterDoc } from "./chapters";
import { heldLabel, inventoryRows, planUse, type ItemDef } from "./inventory";
import { localeFrom, resolveSettings, resolveSplash, type ResolvedSplash } from "./settings";
import { GameState, persist, restore } from "./state";
import { VIEW_HEIGHT, VIEW_WIDTH, WorldScene, type WorldTarget } from "./world";

/**
 * Client entry point.
 *
 * The spike proved three things — content JSON drives the renderer without conversion, the shared
 * rules in `@hkstories/core` run here too, and the bundle is a plain web build. This adds the fourth:
 * the conversation loop. Walking up to an NPC and pressing E opens a panel, and a turn streams from
 * the API through `net.ts` into `dialogue.ts`.
 *
 * Art and content are still imported from the sibling Godot project. A shipped client fetches a
 * content hot-pack from the API instead, so these imports are replaced rather than moved.
 */

/** Game settings from the pack: splash, title, credits, defaults and where a new game starts. */
const settings = resolveSettings(gameSettings);

/**
 * Preview: the studio embeds this client with `?preview=1&token=…`, and `preview-boot` has already
 * fetched the pack the author is *editing*. The bundled lookups below are replaced in place, before
 * anything derives a start location from them, so the running game is the draft rather than the
 * published pack — which is the whole point of the WYSIWYG view.
 */
function adoptPreviewTable<T>(target: Record<string, T>, kind: string): void {
  const table = previewPack?.tables[kind];
  if (table === null || table === undefined || typeof table !== "object") return;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, table as Record<string, T>);
}

const previewSettings = previewPack?.tables["settings"]?.["game"];
if (previewSettings !== undefined && previewSettings !== null && typeof previewSettings === "object") {
  Object.assign(settings, resolveSettings(previewSettings as Parameters<typeof resolveSettings>[0]));
}

/**
 * Chapters: the aggregation documents (§5.4/§12), one per chapter of the game.
 *
 * They are what makes "which maps belong to a chapter, and what unlocks the next one" data rather
 * than a convention — and they are the only thing that ever carries the player into an era map,
 * which the content previously never did.
 */
const chapterModules = import.meta.glob("../../../client/content/chapters/*.json", {
  eager: true,
  import: "default",
}) as Record<string, ChapterDoc>;

const chapters = orderChapters(Object.values(chapterModules));
const firstChapterEntry = chapterEntry(chapters[0] ?? null);

/**
 * Item definitions.
 *
 * The bag needs them for names and descriptions, and `applyEffects` needs them for `stack_max` — which
 * is why `contentLookup.item` below is no longer a stub returning nothing: an `add_item` effect was
 * silently falling back to the default cap.
 */
const itemModules = import.meta.glob("../../../client/content/items/*.json", {
  eager: true,
  import: "default",
}) as Record<string, ItemDef>;

const itemsById: Record<string, ItemDef> = {};
for (const [path, def] of Object.entries(itemModules)) {
  const id = def?.id ?? (path.split("/").pop() ?? "").replace(/\.json$/, "");
  if (id !== "") itemsById[id] = def;
}

/**
 * Every location, so an exit has a destination.
 *
 * A shipped client fetches these from the API hot-pack instead; bundled imports are what makes the
 * spike runnable without one, and the switch is a loader change rather than a scene change.
 */
const locationModules = import.meta.glob("../../../client/content/locations/*.json", {
  eager: true,
  import: "default",
}) as Record<string, LocationFile>;

const locationsById: Record<string, LocationFile> = {};
for (const file of Object.values(locationModules)) {
  if (file?.id) locationsById[file.id] = file;
}

// Before the start location is derived: the draft decides where a new game begins.
adoptPreviewTable(itemsById, "items");
adoptPreviewTable(locationsById, "locations");

// A new game starts where the pack says: the settings document is an explicit override, the first
// chapter's own entry is the default, and the street below is only the last resort.
const START_LOCATION =
  settings.start?.location ?? firstChapterEntry?.location ?? "loc_ssp_market_street";
const START_SPAWN = settings.start?.spawn ?? firstChapterEntry?.spawn;
const location = locationsById[START_LOCATION] ?? Object.values(locationsById)[0]!;
let currentLocationId = location.id;

/** Quest definitions, keyed by id — the node graphs the machine walks. */
const questModules = import.meta.glob("../../../client/content/quests/*.json", {
  eager: true,
  import: "default",
}) as Record<string, { id?: string; display_name?: LocalizedText; nodes?: QuestNode[] }>;

const questsById: Record<string, { display_name?: LocalizedText; nodes?: QuestNode[] }> = {};
for (const file of Object.values(questModules)) {
  if (file?.id) questsById[file.id] = file;
}

/** Every NPC definition, so the scene can read `sprite.sheet_walk` and the panel a name. */
const npcModules = import.meta.glob("../../../client/content/npcs/*.json", {
  eager: true,
  import: "default",
}) as Record<string, NpcFile>;

const npcDefs: Record<string, NpcFile> = {};
for (const def of Object.values(npcModules)) {
  if (def?.id) npcDefs[def.id] = def;
}

adoptPreviewTable(questsById, "quests");
adoptPreviewTable(npcDefs, "npcs");

/** Walk sheets keyed by bare file name; NPCs without art are simply absent. */
const walkSheetModules = import.meta.glob("../../../client/content/art/npcs/*_walk.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const npcSheetUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(walkSheetModules)) {
  npcSheetUrls[artFileName(path)] = url;
}

/** Every prop PNG under content, keyed by bare file name for `art` lookups. */
const propModules = import.meta.glob("../../../client/content/art/props/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const propUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(propModules)) {
  propUrls[artFileName(path)] = url;
}

// The same locale chain the Godot client uses: zh_HK -> zh_CN -> en (§5.8, §6.5).
const locale = localeFrom(settings, resolveLocale(navigator.language));

// The bundled pixel font: HK and Hans are separate faces, so the shell picks by locale rather than
// letting the browser fall back to whatever monospace it has.
document.documentElement.style.setProperty(
  "--game-font",
  locale === "zh_HK"
    ? '"Fusion Pixel HK", ui-monospace, monospace'
    : '"Fusion Pixel Hans", ui-monospace, monospace',
);

/**
 * The game state conditions read.
 *
 * Restored from the slot on boot so a reload keeps progress. NPC gating, the conversation and the
 * save code all read this one object, which is the whole reason it is not a bag of module-level
 * variables: three subsystems disagreeing about what the player has done is the bug this prevents.
 */
const state = new GameState(restore() ?? emptySave(), {
  onChange: () => {
    persist(state.save);
    // Any state change can finish a quest node, and a finished quest can unlock content — so the
    // pass runs before the world is redrawn, not after.
    machine.schedule();
    if (game.scene.isActive("world")) scene().setGameState(state.conditionState());
    // A finished chapter is a move: the pass above is what makes the next one active.
    followChapters();
    // An open bag is a view of this state; it must not show a count the save no longer has.
    if (inventoryOpen) renderInventory();
    updateHud();
  },
});

// --- DOM -----------------------------------------------------------------------------------

const place = document.querySelector<HTMLElement>("#place");
const coords = document.querySelector<HTMLElement>("#coords");
const promptEl = document.querySelector<HTMLElement>("#prompt");
const panel = document.querySelector<HTMLElement>("#dialogue");
const nameEl = document.querySelector<HTMLElement>("#dialogue-name");
const budgetEl = document.querySelector<HTMLElement>("#dialogue-budget");
const logEl = document.querySelector<HTMLElement>("#dialogue-log");
const formEl = document.querySelector<HTMLFormElement>("#dialogue-form");
const inputEl = document.querySelector<HTMLInputElement>("#dialogue-input");
const messageEl = document.querySelector<HTMLElement>("#message");
const inventoryEl = document.querySelector<HTMLElement>("#inventory");
const inventoryListEl = document.querySelector<HTMLElement>("#inventory-list");
const inventoryDetailEl = document.querySelector<HTMLElement>("#inventory-detail");
const inventoryHeldEl = document.querySelector<HTMLElement>("#inventory-held");
const inventoryCloseEl = document.querySelector<HTMLButtonElement>("#inventory-close");

/** The ambience beds, keyed by bare file name — content writes `audio/kln_1963.wav`. */
const audioModules = import.meta.glob("../../../client/assets/audio/*.wav", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const audioUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(audioModules)) {
  audioUrls[path.split("/").pop() ?? path] = url;
}

const audioSink = new WebAudioSink((track) => audioUrls[track.split("/").pop() ?? track] ?? track);
// A creator's -24 dB is a decision, not a suggestion: the bus starts where the pack says.
audioSink.setVolume(gainFor(settings.defaults.musicDb));
const audio = new AudioDirector(audioSink);

if (place) place.textContent = localize(location.display_name, locale);

// --- session -------------------------------------------------------------------------------

let session: Session | null = null;
let sessionError: string | null = null;

/** Open (or re-open) a session. A spent or expired one is replaced rather than reused. */
async function ensureSession(force = false): Promise<Session | null> {
  if (session && !force) return session;

  session = null;
  const result = await openSession();
  if (result.ok) {
    session = result.session;
    sessionError = null;
    return session;
  }

  sessionError = result.code;
  return null;
}

void ensureSession();

// --- scene ---------------------------------------------------------------------------------

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "stage",
  width: VIEW_WIDTH,
  height: VIEW_HEIGHT,
  backgroundColor: "#101217",
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: "arcade",
    arcade: { gravity: { x: 0, y: 0 }, debug: false },
  },
  scene: [
    new WorldScene({
      location,
      tilesUrl,
      playerUrl,
      propUrls,
      npcDefs,
      npcSheetUrls,
      // A new game starts where the pack says, not wherever the map's default point happens to be.
      spawn: START_SPAWN,
      onPlayerMoved: (x, y) => {
        if (coords) coords.textContent = `${x.toFixed(0)}, ${y.toFixed(0)}`;
        updatePrompt();
      },
      onActivate: (target) => activate(target),
      onExit: (to, spawn) => loadLocation(to, spawn),
      onMessage: (text) => showMessage(text),
      onEffects: (effects) => applyWorldEffects(effects),
      onReady: () => {
        // A restored save decides who is on the street before the player moves, and arriving here
        // is the moment `visited` changes in the Godot client too.
        scene().setGameState(state.conditionState());
        // The title is drawn over a world that exists but is not yet playable.
        scene().setInputEnabled(started);
        state.markVisited(currentLocationId);
      },
    }),
  ],
});

const scene = () => game.scene.getScene("world") as WorldScene;

// --- preview bridge ------------------------------------------------------------------------
//
// Only in the studio's embed. Clicks become selections carrying the tile and whoever stands there,
// which is what lets the author edit by pointing at the game instead of scanning a list.

if (previewEnabled) {
  attachPreviewBridge({
    canvas: () => game.canvas,
    toTile: (clientX, clientY) => {
      const current = locationsById[currentLocationId];
      const canvas = game.canvas;
      if (!current || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      const x = (clientX - rect.left) * (canvas.width / rect.width);
      const y = (clientY - rect.top) * (canvas.height / rect.height);
      const point = scene()?.cameras?.main?.getWorldPoint(x, y);
      if (!point) return null;

      const size = typeof current.tile_size === "number" ? current.tile_size : 24;
      return [Math.floor(point.x / size), Math.floor(point.y / size)];
    },
    // The frame's own pixels, for a drag forwarded from the studio: the pointer is captured there,
    // so the coordinates arrive relative to this document rather than to a window it never saw.
    toLocalTile: (localX: number, localY: number) => {
      const current = locationsById[currentLocationId];
      const canvas = game.canvas;
      if (!current || !canvas || canvas.clientWidth === 0) return null;

      const x = localX * (canvas.width / canvas.clientWidth);
      const y = localY * (canvas.height / canvas.clientHeight);
      const point = scene()?.cameras?.main?.getWorldPoint(x, y);
      if (!point) return null;

      const size = typeof current.tile_size === "number" ? current.tile_size : 24;
      return [Math.floor(point.x / size), Math.floor(point.y / size)];
    },
    entityAt: (tile) => {
      const current = locationsById[currentLocationId];
      const placed = Array.isArray(current?.npcs) ? current.npcs : [];
      const hit = placed.find(
        (entry) =>
          Array.isArray(entry.tile) && entry.tile[0] === tile[0] && entry.tile[1] === tile[1],
      );
      return hit ? { type: "npc", id: String(hit.npc ?? "") } : null;
    },
    location: () => currentLocationId,
    post: (message) => globalThis.parent.postMessage(message, "*"),
    onGoto: (id, spawn) => loadLocation(id, spawn),
    onPause: () => game.scene.pause("world"),
    onResume: () => game.scene.resume("world"),
  });
}

// --- dialogue ------------------------------------------------------------------------------

let dialogue: Dialogue | null = null;
let activeNpcId: string | null = null;

/** What an error code means to a player. Codes stay in the state; wording lives here. */
function errorText(code: string): string {
  switch (code) {
    case "budget_exhausted":
      return "這段對話的額度用完了。 / out of budget for this session";
    case "session_expired":
      return "連線過期，再按 E 開新對話。 / session expired — reopen";
    case "stream_closed":
      return "回應中斷。 / the reply was cut off";
    default:
      return "AI 暫時連唔上，顯示作者寫嘅對白。 / model unreachable — showing the authored line";
  }
}

function renderDialogue(view: DialogueView): void {
  if (!panel || !logEl) return;

  logEl.replaceChildren();
  for (const turn of view.turns) {
    const line = document.createElement("p");
    line.className = turn.fallback ? "fallback" : turn.role === "user" ? "user" : "npc";
    // A leading mark keeps the player's own lines distinguishable without a second column.
    line.textContent = turn.role === "user" ? `▸ ${turn.text}` : turn.text;
    logEl.append(line);
  }

  if (view.typing !== "") {
    const line = document.createElement("p");
    line.className = "typing";
    line.textContent = view.typing;
    logEl.append(line);
  }

  if (view.error !== null) {
    const line = document.createElement("p");
    line.className = "hint";
    line.textContent = errorText(view.error);
    logEl.append(line);
  }

  logEl.scrollTop = logEl.scrollHeight;
  if (budgetEl) budgetEl.textContent = view.remaining > 0 ? `budget ${view.remaining}` : "budget spent";
  if (formEl) formEl.hidden = view.busy;
}

async function openDialogue(npcId: string): Promise<void> {
  const npc = npcDefs[npcId];
  if (!panel || !npc || dialogue) return;

  const current = await ensureSession();
  activeNpcId = npcId;
  const session = current;
  void session;
  if (nameEl) nameEl.textContent = localize(npc.display_name, locale);

  dialogue = new Dialogue({
    npc,
    lang: locale,
    getState: () => state.conditionState(),
    sessionToken: current?.session_token ?? "",
    remaining: current?.remaining ?? 0,
    onChange: renderDialogue,
  });

  if (current) {
    renderDialogue(dialogue.view);
  } else {
    // No session at all: show the authored line rather than firing a request that cannot succeed.
    dialogue.offline(sessionError ?? "unreachable");
  }

  panel.hidden = false;
  if (formEl) formEl.hidden = false;
  if (inputEl) {
    inputEl.value = "";
    inputEl.focus();
  }
  scene().setInputEnabled(false);
  updatePrompt();
}

function closeDialogue(): void {
  dialogue?.close();
  dialogue = null;
  activeNpcId = null;
  if (panel) panel.hidden = true;
  if (!game.scene.isActive("world")) return;
  scene().setInputEnabled(true);
  updatePrompt();
}

async function submit(input: string): Promise<void> {
  if (!dialogue) return;

  // A session that expired mid-conversation is worth one silent replacement before spending a turn.
  if (session === null || dialogue.view.error === "session_expired") {
    const renewed = await ensureSession(true);
    if (renewed) dialogue.setSession(renewed.session_token, renewed.remaining);
  }

  if (session === null) {
    dialogue.offlineTurn(input, sessionError ?? "unreachable");
    return;
  }

  const completed = () =>
    dialogue?.view.turns.filter((turn) => turn.role === "npc" && turn.fallback !== true).length ?? 0;
  const before = completed();

  await dialogue.say(input);

  // `dialogue.gd` counts the turns the character actually had; an authored fallback line is not a
  // conversation, so it must not move a `talked` condition.
  if (completed() > before && activeNpcId !== null) {
    state.bumpTalk(activeNpcId);
    // Talk counts gate content, so the street may change the moment a threshold is crossed.
    scene().setGameState(state.conditionState());
  }
}

/**
 * What `applyEffects` may look up.
 *
 * The client ships no quest or item tables yet — the hot-pack port adds them — so an unknown item
 * falls back to the shared default stack cap instead of inventing one here.
 */
const contentLookup: ContentLookup = {
  npc: (id) => npcDefs[id] as unknown as Record<string, unknown> | undefined,
  quest: (id) => questsById[id] as unknown as Record<string, unknown> | undefined,
  // A real table, not a stub: `add_item` effects read `stack_max` through here.
  item: (id) => itemsById[id] as unknown as Record<string, unknown> | undefined,
  localize: (field, requested: Locale) => localize(field, requested),
};

/** Where an interaction goes: a conversation, a door, or a prop. */
function activate(target: WorldTarget): void {
  if (target.kind === "npc") {
    void openDialogue(target.id);
    return;
  }
  if (target.kind === "door") {
    scene().activateDoor(target.id);
    return;
  }
  scene().activateInteractable(target.id);
}

/** Swap maps in place: the panel, the save and the session all survive. */
function loadLocation(id: string, spawn?: string): void {
  const next = locationsById[id];
  if (!next) {
    showMessage({ en: `No map is loaded for ${id}.`, zh_HK: `未載入 ${id}。`, zh_CN: `未载入 ${id}。` });
    return;
  }

  closeDialogue();
  currentLocationId = id;
  if (place) place.textContent = localize(next.display_name, locale);
  // An exit names where it arrives; without this every transition lands on the default point.
  scene().loadLocation(next, spawn);
  audio.enterLocation(next);
}

/**
 * The chapter the save says the player is in, and the move that follows from it.
 *
 * `activeChapter` is derived from quest records, so finishing a chapter's quest advances it — and
 * that is the moment to carry the player to the next chapter's entry. The first call only records
 * where the player already is: a resumed save must not be teleported because its chapter happens to
 * sort later.
 */
let activeChapterId = "";

function followChapters(): void {
  if (!game.scene.isActive("world")) return;

  // First call records where the player already is: a resumed save must not be moved because its
  // chapter happens to sort later.
  if (activeChapterId === "") {
    activeChapterId = String(activeChapter(chapters, state.conditionState())?.id ?? "");
    return;
  }

  // **The declared transition is what moves them.** A chapter's exit is data — `{to, requires}` —
  // so a finished quest counts only insofar as a transition names it.
  const advance = planAdvance(chapters, activeChapterId, state.conditionState(), (condition) =>
    evaluate(condition, state.conditionState()),
  );
  if (advance === null) return;

  activeChapterId = String(advance.target.id ?? "");

  // The announcement: an authored departure line wins, otherwise the chapter's own title.
  const line = advance.text ?? advance.target.title;
  if (line) showMessage(line);

  const enter = () => {
    const entry = chapterEntry(advance.target);
    if (entry === null) return;
    // Already there (an exit may have carried them in): do not reload the map under them.
    if (scene().locationId() === entry.location) return;

    loadLocation(entry.location, entry.spawn);
  };

  // A chapter may carry its own opening image; the game's splash is a boot-time thing.
  const splash = resolveSplash(advance.target.splash);
  if (splash !== null) playSplash(splash, enter);
  else enter();
}

let messageTimer: number | null = null;

/** A content-authored line in the HUD: a blocked door, a locked exit, a picked-up prop. */
function showMessage(text: LocalizedText | string): void {
  if (!messageEl) return;

  // A refusal line from the inventory is already localized; authored lines are not.
  const line = typeof text === "string" ? text : localize(text, locale);
  if (line === "") return;

  messageEl.textContent = line;
  messageEl.hidden = false;
  if (messageTimer !== null) clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => {
    if (messageEl) messageEl.hidden = true;
  }, 3200);
}

/**
 * Run an interactable's effects against the save.
 *
 * `applyEffects` mutates the state it is given and reports what it could not do, so a bad effect
 * warns instead of throwing mid-interaction. The projection is refreshed afterwards: an effect that
 * opens a path has to change what is on screen before the next frame.
 */
function applyWorldEffects(effects: unknown[]): void {
  if (effects.length === 0) return;

  const outcome = applyEffects(effects, state.save, { content: contentLookup, locale });
  if (outcome.warnings.length > 0) {
    console.warn("[hks] effect warnings:", outcome.warnings.join("; "));
  }

  scene().setGameState(state.conditionState());
  persist(state.save);
}

/** The prompt tells the player what E would do — the port of the Godot HUD's hint. */
function updatePrompt(): void {
  if (!promptEl) return;
  if (dialogue !== null || !game.scene.isActive("world")) {
    promptEl.hidden = true;
    return;
  }

  const target = scene().nearestTarget();
  promptEl.hidden = target === null;
  if (target === null) return;

  promptEl.textContent = promptFor(target);
}

function promptFor(target: WorldTarget): string {
  if (target.kind === "npc") {
    const npc = npcDefs[target.id];
    return `按 E 交談 · ${npc ? localize(npc.display_name, locale) : target.id}`;
  }

  // A door or prop supplies its own wording; the verb belongs to the shell.
  const label = scene().labelFor(target);
  const verb = target.kind === "door" ? "開門" : "使用";
  return label ? `按 E ${verb} · ${localize(label, locale)}` : `按 E ${verb}`;
}

formEl?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl?.value ?? "";
  if (text.trim() === "") return;
  if (inputEl) inputEl.value = "";
  void submit(text);
});

window.addEventListener("keydown", (event) => {
  // The splash sits above everything until its time is up.
  if (splashEl !== null && !splashEl.hidden) {
    if (splashSkippable) {
      event.preventDefault();
      finishSplash();
    }
    return;
  }

  // The bag: I opens and closes it, Esc only closes. Refused while talking or mid-cutscene, so a
  // panel never opens underneath another one.
  if (event.key === "i" || event.key === "I") {
    if (dialogue === null && !cutsceneOpen) {
      event.preventDefault();
      toggleInventory();
    }
    return;
  }
  if (event.key === "Escape" && inventoryOpen) {
    event.preventDefault();
    toggleInventory(false);
    return;
  }

  // A cutscene is the topmost layer: it takes the interact keys before anything beneath it.
  if (cutsceneOpen) {
    if (event.key === "e" || event.key === "E" || event.key === " " || event.key === "Enter") {
      event.preventDefault();
      dismissCutscene();
    }
    return;
  }

  if (event.key === "Escape" && dialogue !== null) {
    event.preventDefault();
    closeDialogue();
  }
});

// --- quests, cutscene, title, touch ---------------------------------------------------------

const machine = new QuestMachine(() => state.save.quests, {
  nodes: (questId) => questsById[questId]?.nodes ?? [],
  evaluate: (condition) => evaluate(condition, state.conditionState()),
  applyEffects: (effects) => {
    const outcome = applyEffects(effects, state.save, { content: contentLookup, locale });
    if (outcome.warnings.length > 0) {
      console.warn("[hks] quest effect:", outcome.warnings.join("; "));
    }
  },
  onCutscene: (questId, nodeId) => showCutscene(questId, nodeId),
  onCompleted: (questId) => {
    const name = questsById[questId]?.display_name;
    if (name === undefined) return;
    showMessage({
      zh_HK: `任務完成：${localize(name, "zh_HK")}`,
      zh_CN: `任务完成：${localize(name, "zh_CN")}`,
      en: `Quest complete: ${localize(name, "en")}`,
    });
  },
  onWarning: (message) => console.warn("[hks] quests:", message),
});

const cutsceneEl = document.querySelector<HTMLElement>("#cutscene");
const cutsceneText = document.querySelector<HTMLElement>("#cutscene-text");
const titleEl = document.querySelector<HTMLElement>("#title");
const continueButton = document.querySelector<HTMLButtonElement>("#title-continue");
const titleName = document.querySelector<HTMLElement>("#title-name");
const titleSub = document.querySelector<HTMLElement>("#title-sub");
const creditsEl = document.querySelector<HTMLElement>("#credits");
const creditsButton = document.querySelector<HTMLButtonElement>("#title-credits");
const splashEl = document.querySelector<HTMLElement>("#splash");
const splashArt = document.querySelector<HTMLImageElement>("#splash-art");
const buildEl = document.querySelector<HTMLElement>("#build");
const bagEl = document.querySelector<HTMLElement>("#bag");
const touchEl = document.querySelector<HTMLElement>("#touch");

let cutsceneOpen = false;
let started = false;
let packStatus: PackStatus = "checking";
let packNote = "";

/**
 * Ask the API whether a newer content pack is published (§5.7).
 *
 * Never blocks play. Content is bundled, so an unreachable API is a normal offline boot, and a
 * differing hash is information the HUD surfaces rather than a silent stale run — fetching the pack
 * itself needs a content-files route the API does not serve yet.
 */
async function checkPack(): Promise<void> {
  const result = await fetchManifest({ bundled: bundledManifest, baseUrl: apiBase() });
  packStatus = result.status;

  if (result.ok && result.status === "pending") {
    const plan = planRefresh(bundledManifest, result.manifest);
    packNote = "pack pending";
    console.warn(
      `[hks] content ${plan?.reason ?? "differs"}; ${plan?.files.length ?? 0} file(s) would be pulled`,
    );
  } else if (!result.ok) {
    console.info("[hks] content pack check skipped:", result.reason);
  }

  updateHud();
}

void checkPack();

/** A cutscene node's text, shown until the player dismisses it. */
function showCutscene(questId: string, nodeId: string): void {
  const node = (questsById[questId]?.nodes ?? []).find((entry) => entry.id === nodeId);
  if (node === undefined || cutsceneEl === null || cutsceneText === null) return;

  const lines = cutsceneLines(node)
    .map((line) => localize(line, locale))
    .filter((line) => line !== "");

  if (lines.length === 0) {
    // Nothing to show means nothing to wait for: dismissing immediately keeps the quest moving.
    machine.dismissCutscene();
    return;
  }

  cutsceneText.textContent = lines.join("\n\n");
  cutsceneEl.hidden = false;
  cutsceneOpen = true;
  scene().setInputEnabled(false);
}

function dismissCutscene(): void {
  if (!cutsceneOpen) return;

  cutsceneOpen = false;
  if (cutsceneEl) cutsceneEl.hidden = true;
  if (started) scene().setInputEnabled(true);
  machine.dismissCutscene();
}

// A tap is the only way a touch player can dismiss a cutscene.
cutsceneEl?.addEventListener("click", () => dismissCutscene());

// --- inventory ------------------------------------------------------------------------------

let inventoryOpen = false;
let inventorySelection: string | null = null;

/** One panel owns the input: the bag refuses to open over a conversation or a cutscene. */
function toggleInventory(open = !inventoryOpen): void {
  if (open && (dialogue !== null || cutsceneOpen)) return;

  inventoryOpen = open;
  if (inventoryEl) inventoryEl.hidden = !open;
  if (open) renderInventory();

  if (game.scene.isActive("world")) {
    scene().setInputEnabled(!open && dialogue === null && !cutsceneOpen);
  }
}

function inventoryCondition(condition: unknown): boolean {
  return evaluate(condition, state.conditionState());
}

/** Draw the bag from the state. Nothing here decides what is usable; `inventoryRows` does. */
function renderInventory(): void {
  if (inventoryListEl === null || inventoryDetailEl === null) return;

  const conditions = state.conditionState();
  const held = heldLabel(itemsById, conditions, locale);
  if (inventoryHeldEl) inventoryHeldEl.textContent = held === "" ? "" : `手中 / holding: ${held}`;

  const rows = inventoryRows(itemsById, conditions, locale, inventoryCondition);

  // A selection that is no longer carried is not a selection.
  if (inventorySelection !== null && !rows.some((row) => row.id === inventorySelection)) {
    inventorySelection = null;
  }
  if (inventorySelection === null && rows.length > 0) inventorySelection = rows[0]!.id;

  inventoryListEl.replaceChildren();
  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-selected", row.id === inventorySelection ? "true" : "false");
    button.addEventListener("click", () => {
      inventorySelection = row.id;
      renderInventory();
    });

    const name = document.createElement("span");
    name.textContent = row.name;

    const tail = document.createElement("span");
    tail.className = row.held ? "held" : "count";
    tail.textContent = row.held ? "手持" : row.count > 1 ? `×${row.count}` : "";

    button.append(name, tail);
    inventoryListEl.append(button);
  }

  inventoryDetailEl.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "（袋裡面冇嘢 · nothing yet）";
    inventoryDetailEl.append(empty);
    return;
  }

  const row = rows.find((entry) => entry.id === inventorySelection) ?? rows[0]!;

  const heading = document.createElement("h3");
  heading.textContent = row.name;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [row.category, row.count > 1 ? `×${row.count}` : ""].filter(Boolean).join("  ");
  inventoryDetailEl.append(heading, meta);

  if (row.description !== "") {
    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent = row.description;
    inventoryDetailEl.append(desc);
  }

  if (row.locked !== "") {
    // The content's own line, not ours: it says why, in the voice of the game.
    const locked = document.createElement("p");
    locked.className = "locked";
    locked.textContent = row.locked;
    inventoryDetailEl.append(locked);
  }

  const actions = document.createElement("div");
  actions.className = "actions";

  const use = document.createElement("button");
  use.type = "button";
  use.textContent = "用 Use";
  use.disabled = !row.usable;
  use.addEventListener("click", () => useSelectedItem());
  actions.append(use);

  const hold = document.createElement("button");
  hold.type = "button";
  hold.textContent = row.held ? "放低 Put away" : "手持 Hold";
  hold.addEventListener("click", () => {
    state.setHeld(row.held ? "" : row.id);
    renderInventory();
    updateHud();
  });
  actions.append(hold);

  inventoryDetailEl.append(actions);
}

/**
 * Apply an item's own effects.
 *
 * The state's change handler does the rest — persisting, re-running the quest pass, moving chapters
 * — so this only has to redraw what the bag now contains (a consumable may be gone).
 */
function useSelectedItem(): void {
  if (inventorySelection === null) return;

  const outcome = planUse(itemsById, inventorySelection, locale, inventoryCondition);
  if (!outcome.ok) {
    // A refused item explains itself; "not usable" items have nothing to explain.
    if (outcome.reason === "locked" && typeof outcome.locked === "string" && outcome.locked !== "") {
      showMessage(outcome.locked);
    }
    return;
  }

  const result = applyEffects(outcome.effects, state.save, { content: contentLookup, locale });
  if (result.warnings.length > 0) {
    console.warn("[hks] item effect:", result.warnings.join("; "));
  }

  renderInventory();
  updateHud();
}

/** Begin play: either the restored slot or a clean one. */
function startGame(continueSave: boolean): void {
  if (!continueSave) state.replace(emptySave());

  started = true;
  if (titleEl) titleEl.hidden = true;
  // Reached from the splash (a check, or a player who skipped) it must not stay on top.
  if (splashEl) splashEl.hidden = true;
  if (splashTimer !== null) {
    clearTimeout(splashTimer);
    splashTimer = null;
  }
  scene().setInputEnabled(true);

  // A new game begins at the start point — not wherever the previous session left the player.
  if (!continueSave && START_LOCATION !== currentLocationId) {
    loadLocation(START_LOCATION, START_SPAWN);
  }

  scene().setGameState(state.conditionState());
  // Started from a click, which is the gesture an AudioContext needs to leave "suspended".
  audio.enterLocation(locationsById[currentLocationId]);
  updateHud();
  machine.schedule();
  followChapters();
}

/**
 * Every content-relative art path, keyed the way settings name one (`art/backdrops/x.png`).
 *
 * The glob covers the whole art tree rather than one folder: the validator accepts any
 * content-relative path, and a bundle narrowed to `art/backdrops/` would make validation and the
 * client disagree about which paths actually work.
 */
const artModules = import.meta.glob("../../../client/content/art/**/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function contentArtUrl(path: string): string | undefined {
  return artModules[`../../../client/content/${path.replace(/^\/+/, "")}`];
}

let splashTimer: number | null = null;
/** What to do when the current splash ends: open the title at boot, move a chapter along after. */
let splashDone: (() => void) | null = null;
let splashSkippable = true;

/** The splash's time is up, or the player skipped it. */
function finishSplash(): void {
  if (splashTimer !== null) clearTimeout(splashTimer);
  splashTimer = null;
  if (splashEl) splashEl.hidden = true;

  const done = splashDone;
  splashDone = null;
  done?.();
}

/**
 * Show the pack's opening image, then the title.
 *
 * Art that is not in the bundle would be a black screen waiting to happen, so the console says so
 * and the title opens instead: a missing picture must not cost the player their game.
 */
function playSplash(splash: ResolvedSplash | null, onDone: () => void): void {
  if (splash === null || splashEl === null || splashArt === null) {
    onDone();
    return;
  }

  const url = contentArtUrl(splash.art);
  if (url === undefined) {
    console.warn(`[hks] splash art is not in the bundle: ${splash.art}`);
    onDone();
    return;
  }

  // A bundled path can still fail at runtime — a stale deploy, a dropped connection — and without
  // this the player waits out the whole duration on a black screen.
  splashArt.onerror = () => {
    console.warn(`[hks] splash art failed to load: ${splash.art}`);
    finishSplash();
  };
  splashArt.src = url;
  splashEl.hidden = false;
  splashDone = onDone;
  splashSkippable = splash.skippable;
  if (splash.skippable) splashEl.addEventListener("click", finishSplash, { once: true });
  splashTimer = window.setTimeout(finishSplash, splash.durationMs);
}

/** Credits, straight from the document: roles and names are a creator's, not this file's. */
function renderCredits(): void {
  if (creditsEl === null) return;

  creditsEl.replaceChildren();
  for (const credit of settings.credits) {
    const role = document.createElement("p");
    role.className = "credit-role";
    role.textContent = localize(credit.role ?? {}, locale);

    const names = document.createElement("p");
    names.className = "credit-names";
    names.textContent = (credit.names ?? []).join("  ");

    creditsEl.append(role, names);
  }
}

function showTitle(): void {
  if (titleEl === null) return;

  titleEl.hidden = false;
  started = false;

  // The pack names the game; the markup only carries a fallback for a pack that says nothing.
  const title = localize(settings.title, locale);
  if (titleName !== null && title !== "") titleName.textContent = title;

  // The same non-empty guard as the title: a pack with no subtitle must keep the markup fallback,
  // not blank the line under the name.
  const subtitle = localize(settings.subtitle, locale);
  if (titleSub !== null && subtitle !== "") titleSub.textContent = subtitle;

  renderCredits();
  if (creditsButton) creditsButton.hidden = settings.credits.length === 0;

  // Continue is only meaningful when a slot exists.
  if (continueButton) continueButton.disabled = restore() === null;
  if (game.scene.isActive("world")) scene().setInputEnabled(false);
}

/** The HUD line: how much is carried, and which build this is (§6.1). */
function updateHud(): void {
  let carried = 0;
  for (const count of Object.values(state.save.inventory)) carried += Number(count) || 0;

  if (bagEl) {
    bagEl.textContent = carried > 0 ? `🎒 ${carried}` : "🎒";
    const held = heldLabel(itemsById, state.conditionState(), locale);
    bagEl.title = held === "" ? "物品 / Inventory" : `手中 / holding: ${held}`;
  }
  if (buildEl) buildEl.textContent = packNote === "" ? "p6-phaser" : `p6-phaser · ${packNote}`;
}

document.querySelector("#title-new")?.addEventListener("click", () => startGame(false));
continueButton?.addEventListener("click", () => startGame(true));
creditsButton?.addEventListener("click", () => {
  if (creditsEl) creditsEl.hidden = !creditsEl.hidden;
});

bagEl?.addEventListener("click", () => toggleInventory());
inventoryCloseEl?.addEventListener("click", () => toggleInventory(false));

if (touchEl !== null && window.matchMedia?.("(pointer: coarse)").matches === true) {
  touchEl.hidden = false;

  const release = () => scene().setTouchDirection(0, 0);
  const vectors: Record<string, [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };

  touchEl.addEventListener("pointerdown", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    if (button === null) return;
    event.preventDefault();

    const direction = button.dataset["dir"];
    if (direction !== undefined) {
      const vector = vectors[direction];
      if (vector) scene().setTouchDirection(vector[0], vector[1]);
      return;
    }

    // The same dispatch the E key uses, so touch cannot drift from keyboard.
    if (button.dataset["action"] === "interact") {
      const target = scene().nearestTarget();
      if (target !== null) activate(target);
    }
  });

  touchEl.addEventListener("pointerup", release);
  touchEl.addEventListener("pointercancel", release);
  touchEl.addEventListener("pointerleave", release);
}

// --- test hook -----------------------------------------------------------------------------

/**
 * Browser-check surface.
 *
 * The checks assert on scene and dialogue state rather than judging a 384x216 pixel canvas by eye.
 * `openDialogue` exists because walking to an NPC is keyboard choreography a test should not have to
 * perform — the logic under test is the turn, not the walk.
 */
export interface TestHook {
  game: Phaser.Game;
  setGameState: (next: ConditionState) => string[];
  visibleNpcIds: () => string[];
  openDialogue: (npcId: string) => Promise<void>;
  closeDialogue: () => void;
  dialogueView: () => DialogueView | null;
  /** The live save payload, so a check can assert bookkeeping rather than pixels. */
  state: () => SavePayload;
  /** A real shareable code, produced by the same path a player would use. */
  saveCode: () => Promise<string>;
  /** Which map is loaded, so a check can assert an exit actually moved the player. */
  locationId: () => string;
  /** What E would act on right now. */
  worldTarget: () => WorldTarget | null;
  /** Place the player somewhere; walking to a coordinate is agenda, not behaviour under test. */
  movePlayer: (x: number, y: number) => void;
  loadLocation: (id: string) => void;
  /** What E does, without needing to stand beside the thing. */
  activate: (target: WorldTarget) => void;
  /** The character painted at a tile — how an opened door becomes observable. */
  tileAt: (x: number, y: number) => string;
  /** Leave the title and begin play, as a player would. */
  start: () => void;
  /** State mutators a check drives the quest machine with. */
  setFlag: (flag: string, value: boolean) => void;
  addItem: (itemId: string, count?: number) => void;
  startQuest: (questId: string, node: string) => void;
  finishQuest: (questId: string) => void;
  questRecord: (questId: string) => unknown;
  /** Whether a cutscene is waiting for the player. */
  cutsceneOpen: () => boolean;
  /** How the content pack check settled. */
  packStatus: () => PackStatus;
  /** The ambience bed currently playing, or "" — the port of `current_music_stream()`. */
  audioTrack: () => string;
  /** What the shell is showing, so a check can assert the pack drove it. */
  shell: () => { title: string; subtitle: string; splashVisible: boolean; credits: number };
  /** The chapter the save currently puts the player in. */
  chapterId: () => string;
  /** That chapter's title, localized the way the shell localizes it. */
  chapterLabel: () => string;
  /** Start a clean game — the title screen's own "new game". */
  newGame: () => void;
  /** Open the bag (the I key's other path, for a check that should not depend on key handling). */
  openInventory: () => void;
  inventoryVisible: () => boolean;
}

const hook: TestHook = {
  game,
  setGameState: (next) => scene().setGameState(next),
  visibleNpcIds: () => (game.scene.isActive("world") ? scene().visibleNpcIds() : []),
  openDialogue,
  closeDialogue,
  dialogueView: () => dialogue?.view ?? null,
  state: () => state.save,
  saveCode: () => encodeSave(state.save),
  locationId: () => (game.scene.isActive("world") ? scene().locationId() : currentLocationId),
  worldTarget: () => (game.scene.isActive("world") ? scene().nearestTarget() : null),
  movePlayer: (x, y) => scene().movePlayer(x, y),
  loadLocation,
  activate,
  tileAt: (x, y) => (game.scene.isActive("world") ? scene().tileAt(x, y) : ""),
  start: () => startGame(true),
  setFlag: (flag, value) => state.setFlag(flag, value),
  addItem: (itemId, count = 1) => void state.addItem(itemId, count),
  startQuest: (questId, node) => state.setQuest(questId, { node }),
  finishQuest: (questId) => state.setQuest(questId, { done: true }),
  questRecord: (questId) => state.save.quests[questId] ?? null,
  cutsceneOpen: () => cutsceneOpen,
  packStatus: () => packStatus,
  audioTrack: () => audio.currentTrack,
  shell: () => ({
    title: titleName?.textContent ?? "",
    subtitle: titleSub?.textContent ?? "",
    splashVisible: splashEl !== null && !splashEl.hidden,
    credits: settings.credits.length,
  }),
  chapterId: () => activeChapterId,
  chapterLabel: () => {
    const chapter = chapters.find((entry) => entry.id === activeChapterId) ?? null;
    return chapter?.title ? localize(chapter.title, locale) : "";
  },
  newGame: () => startGame(false),
  openInventory: () => toggleInventory(true),
  inventoryVisible: () => inventoryOpen,
};

(window as unknown as { __hks?: TestHook }).__hks = hook;

// Boot through the splash to the title: a player clicks, and the checks call `start()`.
playSplash(settings.splash, showTitle);
