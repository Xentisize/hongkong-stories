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
import "./style.css";

import { AudioDirector, WebAudioSink } from "./audio";
import { artFileName, type LocalizedText, type LocationFile, type NpcFile } from "./content";
import { fetchManifest, planRefresh, type PackStatus } from "./content-pack";
import { Dialogue, type DialogueView } from "./dialogue";
import { apiBase, openSession, type Session } from "./net";
import { QuestMachine, cutsceneLines, type QuestNode } from "./quests";
import { emptySave, encodeSave, type SavePayload } from "./save";
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

const START_LOCATION = "loc_ssp_market_street";
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
const locale = resolveLocale(navigator.language);

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

const audio = new AudioDirector(
  new WebAudioSink((track) => audioUrls[track.split("/").pop() ?? track] ?? track),
);

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
      onPlayerMoved: (x, y) => {
        if (coords) coords.textContent = `${x.toFixed(0)}, ${y.toFixed(0)}`;
        updatePrompt();
      },
      onActivate: (target) => activate(target),
      onExit: (to) => loadLocation(to),
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
  quest: () => undefined,
  item: () => undefined,
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
function loadLocation(id: string): void {
  const next = locationsById[id];
  if (!next) {
    showMessage({ en: `No map is loaded for ${id}.`, zh_HK: `未載入 ${id}。`, zh_CN: `未载入 ${id}。` });
    return;
  }

  closeDialogue();
  currentLocationId = id;
  if (place) place.textContent = localize(next.display_name, locale);
  scene().loadLocation(next);
  audio.enterLocation(next);
}

let messageTimer: number | null = null;

/** A content-authored line in the HUD: a blocked door, a locked exit, a picked-up prop. */
function showMessage(text: LocalizedText): void {
  if (!messageEl) return;

  const line = localize(text, locale);
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

const machine = new QuestMachine(state.save.quests, {
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

/** Begin play: either the restored slot or a clean one. */
function startGame(continueSave: boolean): void {
  if (!continueSave) state.replace(emptySave());

  started = true;
  if (titleEl) titleEl.hidden = true;
  scene().setInputEnabled(true);
  scene().setGameState(state.conditionState());
  // Started from a click, which is the gesture an AudioContext needs to leave "suspended".
  audio.enterLocation(locationsById[currentLocationId]);
  updateHud();
  machine.schedule();
}

function showTitle(): void {
  if (titleEl === null) return;

  titleEl.hidden = false;
  started = false;
  // Continue is only meaningful when a slot exists.
  if (continueButton) continueButton.disabled = restore() === null;
  if (game.scene.isActive("world")) scene().setInputEnabled(false);
}

/** The HUD line: how much is carried, and which build this is (§6.1). */
function updateHud(): void {
  let carried = 0;
  for (const count of Object.values(state.save.inventory)) carried += Number(count) || 0;

  if (bagEl) bagEl.textContent = carried > 0 ? `🎒 ${carried}` : "";
  if (buildEl) buildEl.textContent = packNote === "" ? "p6-phaser" : `p6-phaser · ${packNote}`;
}

document.querySelector("#title-new")?.addEventListener("click", () => startGame(false));
continueButton?.addEventListener("click", () => startGame(true));

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
};

(window as unknown as { __hks?: TestHook }).__hks = hook;

// Boot to the title: a player clicks, and the browser checks call `start()`.
showTitle();
