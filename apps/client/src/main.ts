import { localize, resolveLocale, type ConditionState } from "@hkstories/core";
import Phaser from "phaser";

import tilesUrl from "../../../client/assets/tiles/p1_tiles_2027.png";
import playerUrl from "../../../client/content/art/npcs/player_walk.png";
import locationJson from "../../../client/content/locations/loc_ssp_market_street.json";
import "./style.css";

import { artFileName, type LocationFile, type NpcFile } from "./content";
import { VIEW_HEIGHT, VIEW_WIDTH, WorldScene } from "./world";

/**
 * Spike entry point.
 *
 * The point of this file is to prove three things at once, because all three were the open
 * questions in the migration assessment:
 *
 *  1. the existing content JSON drives a Phaser renderer without conversion — including NPC
 *     placement gated by `requires`;
 *  2. the shared rules in `@hkstories/core` run in this client too: the locale chain names the
 *     place and `evaluate` decides which NPCs exist;
 *  3. the bundle is a plain web build — no wasm, no engine runtime.
 *
 * Art and content are imported from the sibling Godot project during the spike. A shipped
 * client fetches a content hot-pack from the API instead, so these imports are replaced rather
 * than moved.
 */

const location = locationJson as unknown as LocationFile;

/** Every NPC definition, so the scene can read `sprite.sheet_walk`. */
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
const place = document.querySelector<HTMLElement>("#place");
if (place) place.textContent = localize(location.display_name, locale);

const coords = document.querySelector<HTMLElement>("#coords");

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
      },
    }),
  ],
});

/**
 * Spike-only test hook.
 *
 * The browser check asserts on scene state — tile indices, collider count, player position, and
 * which NPCs a given save-state admits — instead of trying to judge a 384x216 pixel canvas by
 * eye. `setGameState` exists because NPC gating is only meaningful if a test can change the
 * state the way a real save would.
 */
export interface TestHook {
  game: Phaser.Game;
  setGameState: (state: ConditionState) => string[];
  visibleNpcIds: () => string[];
}

const scene = () => game.scene.getScene("world") as WorldScene;

const hook: TestHook = {
  game,
  setGameState: (state) => scene().setGameState(state),
  visibleNpcIds: () => (game.scene.isActive("world") ? scene().visibleNpcIds() : []),
};

(window as unknown as { __hks?: TestHook }).__hks = hook;
