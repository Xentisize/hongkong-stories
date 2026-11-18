import { evaluate, type ConditionState } from "@hkstories/core";
import Phaser from "phaser";

import {
  artFileName,
  legendColumns,
  mapPixelSize,
  rectToPixels,
  spawnPixel,
  tileCentre,
  tileIndexGrids,
  type LocalizedText,
  type LocationFile,
  type NpcFile,
} from "./content";
import {
  decorPlacements,
  doorPlacements,
  exitAt,
  exitZones,
  facingBetween,
  interactablePlacements,
  openDoorTiles,
  pickWanderTarget,
  type DoorPlacement,
  type ExitZone,
  type InteractablePlacement,
} from "./entities";

/** The Godot project's viewport: 384x216 at 24 px tiles (§6.1). */
export const VIEW_WIDTH = 384;
export const VIEW_HEIGHT = 216;

/** `player.gd`: `@export var speed: float = 72.0`. */
const PLAYER_SPEED = 72;

/** `player.tscn`: a 12x12 body sitting 6 px above the sprite origin. */
const BODY_SIZE = 12;

/** Walk sheets are 4 direction columns x 2 pose rows of 26x34 (§6.3). */
const FRAME_WIDTH = 26;
const FRAME_HEIGHT = 34;

const DIRECTIONS: Array<[string, number]> = [
  ["down", 0],
  ["right", 1],
  ["left", 2],
  ["up", 3],
];

/** Stand frame per facing, i.e. row 0 of the walk sheet. */
const FACING_FRAME: Record<string, number> = { down: 0, right: 1, left: 2, up: 3 };

/** What the player is standing next to, which is what E acts on. */
export type WorldTarget =
  | { kind: "npc"; id: string }
  | { kind: "door"; id: string }
  | { kind: "interactable"; id: string };

export interface WorldAssets {
  location: LocationFile;
  tilesUrl: string;
  playerUrl: string;
  /** Bare file name → bundled URL, for props referenced by content-relative paths. */
  propUrls: Record<string, string>;
  /** NPC definitions by id — supplies `sprite.sheet_walk` and the display name. */
  npcDefs: Record<string, NpcFile>;
  /** Walk sheet bare file name → bundled URL. */
  npcSheetUrls: Record<string, string>;
  /** Spawn point to place the player at; `default` when absent. */
  spawn?: string;
  onPlayerMoved?: (x: number, y: number) => void;
  /** The player pressed the interact key beside something interactive. */
  onActivate?: (target: WorldTarget) => void;
  /** The player walked into an exit its `requires` allowed. */
  onExit?: (to: string, spawn: string) => void;
  /** A gated thing refused: show the content's `blocked` line. */
  onMessage?: (text: LocalizedText) => void;
  /** Effects an interactable handed over — the shell owns the state. */
  onEffects?: (effects: unknown[]) => void;
  /** Fired once, after the scene is built — the point a restored save can be applied. */
  onReady?: () => void;
}

interface PlacedNpc {
  id: string;
  object: Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle;
  /** Where the placement put it: wander is measured from here, not from the current position. */
  home: { x: number; y: number };
  /** Tile radius from the placement. 0 means a fixture that never moves. */
  wander: number;
  target: { x: number; y: number } | null;
  /** Seconds until the next wander attempt. */
  wait: number;
}

interface DoorRuntime {
  placement: DoorPlacement;
  blocker: Phaser.GameObjects.Zone | null;
  open: boolean;
}

interface InteractableRuntime {
  placement: InteractablePlacement;
  object: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle | null;
  used: boolean;
}

export class WorldScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private facing = "down";
  private npcs: PlacedNpc[] = [];
  private doors: DoorRuntime[] = [];
  private interactables: InteractableRuntime[] = [];
  private exits: ExitZone[] = [];
  /** The tile layer, so an opened door can swap its cells for floor. */
  private layer: Phaser.Tilemaps.TilemapLayer | null = null;
  /** A per-scene copy of the char grid, so opening a door never mutates imported content. */
  private tiles: string[] = [];
  /** Atlas index of the floor tile a door opens onto. */
  private floorIndex = 0;
  /** The exit zone the player was last inside, so entering a different one fires. */
  private currentExit: string | null = null;
  /** Direction from the touch d-pad, summed with the keys. */
  private touch = { x: 0, y: 0 };
  private interactKey!: Phaser.Input.Keyboard.Key;
  /** False while a conversation is open, so the player stops taking orders behind the panel. */
  private inputEnabled = true;
  private ready = false;

  /** The save projection conditions read. Empty until a test or a save supplies one. */
  private gameState: ConditionState = {};

  constructor(private assets: WorldAssets) {
    super("world");
  }

  preload(): void {
    this.load.spritesheet("player", this.assets.playerUrl, {
      frameWidth: FRAME_WIDTH,
      frameHeight: FRAME_HEIGHT,
    });
    this.load.image("tiles", this.assets.tilesUrl);

    for (const [fileName, url] of Object.entries(this.assets.propUrls)) {
      this.load.image(`prop:${fileName}`, url);
    }

    // One walk sheet per NPC that actually has one. Four of the six NPCs placed in this
    // location have no art yet, so a missing sheet is normal and must not be requested.
    for (const def of Object.values(this.assets.npcDefs)) {
      const sheetPath = def.sprite?.sheet_walk;
      if (!sheetPath) continue;
      const fileName = artFileName(sheetPath);
      const url = this.assets.npcSheetUrls[fileName];
      if (!url) continue;
      this.load.spritesheet(`npc:${fileName}`, url, {
        frameWidth: FRAME_WIDTH,
        frameHeight: FRAME_HEIGHT,
      });
    }
  }

  create(): void {
    // `loadLocation` rebuilds through a scene restart, and Phaser reuses the instance — so every
    // per-map collection is emptied here rather than relying on construction.
    this.npcs = [];
    this.doors = [];
    this.interactables = [];
    this.exits = [];
    this.currentExit = null;
    this.ready = false;

    const { location } = this.assets;
    const size = location.tile_size;

    // Set before anything else: every hook below asserts on the map that is actually built.
    this.loadedLocationId = location.id;

    // --- terrain -----------------------------------------------------------------
    // Layer 0 is the base grid and defines the map; every later grid is an overlay drawn above it.
    const grids = tileIndexGrids(location);
    const map = this.make.tilemap({ data: grids[0] ?? [], tileWidth: size, tileHeight: size });
    const tileset = map.addTilesetImage("tiles", "tiles", size, size);
    if (!tileset) throw new Error("tileset failed to attach — check the atlas image key");
    // Phaser 4 returns a union here; the canvas renderer hands back the standard layer.
    this.layer = (map.createLayer(0, tileset, 0, 0) ?? null) as Phaser.Tilemaps.TilemapLayer | null;
    this.tiles = [...location.tilemap];

    // Overlays get their own tilemap because Phaser builds a layer from the data it was made with.
    // Depth 1..n keeps them above the floor and below the actors, whose depth is their y position
    // in pixels — so a roof overlay never hides a character standing on it.
    grids.slice(1).forEach((grid, index) => {
      const overlay = this.make.tilemap({ data: grid, tileWidth: size, tileHeight: size });
      const overlayTileset = overlay.addTilesetImage("tiles", "tiles", size, size);
      if (!overlayTileset) return;
      const layer = overlay.createLayer(0, overlayTileset, 0, 0);
      layer?.setDepth(index + 1);
    });

    // A door opens onto whatever the legend paints `.`, so a rethemed atlas keeps doors consistent
    // instead of hard-coding atlas column 0.
    const floor = location.legend["."];
    this.floorIndex = floor ? floor[1] * legendColumns(location) + floor[0] : 0;

    // --- collision ---------------------------------------------------------------
    // Content carries explicit rect lists rather than per-tile collision flags, so these become
    // static physics zones. Zones have no texture, which is what we want for invisible geometry.
    const solids: Phaser.GameObjects.GameObject[] = [];
    for (const raw of location.collision) {
      const rect = rectToPixels(location, raw);
      const zone = this.add.zone(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width,
        rect.height,
      );
      this.physics.add.existing(zone, true);
      solids.push(zone);
    }

    // --- decor -------------------------------------------------------------------
    for (const item of decorPlacements(location)) {
      if (!this.assets.propUrls[item.file]) continue;
      this.add.image(item.point.x, item.point.y, `prop:${item.file}`).setDepth(item.point.y);
    }

    // --- doors -------------------------------------------------------------------
    // A door is a blocker plus a tile swap; it does not decide how it opens. `requires` goes
    // through the shared evaluator, so a key and a flag open it by exactly the same rule.
    for (const placement of doorPlacements(location)) {
      const { bounds } = placement;
      const zone = this.add.zone(
        (bounds.x + bounds.width / 2) * size,
        (bounds.y + bounds.height / 2) * size,
        bounds.width * size,
        bounds.height * size,
      );
      this.physics.add.existing(zone, true);
      solids.push(zone);

      const door: DoorRuntime = { placement, blocker: zone, open: false };
      this.doors.push(door);

      // A door opened in a previous session comes back open, silently.
      const flag = placement.openFlag;
      if (flag !== "" && (this.gameState.flags ?? {})[flag] === true) this.openDoor(door);
    }

    // --- interactables -----------------------------------------------------------
    for (const placement of interactablePlacements(location)) {
      const textureKey = `prop:${placement.file}`;

      let object: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
      if (placement.file !== "" && this.textures.exists(textureKey)) {
        object = this.add.image(placement.point.x, placement.point.y, textureKey);
        // Drawn up from the feet, the way `interactable.gd` places generated art.
        object.setOrigin(0.5, 1);
        object.setScale(placement.scale);
      } else {
        object = this.add.rectangle(placement.point.x, placement.point.y, size - 6, size - 6, 0xb9a06a, 0.7);
      }

      object.setDepth(placement.point.y);
      object.setVisible(evaluate(placement.requires, this.gameState));
      this.interactables.push({ placement, object, used: false });
    }

    // --- exits -------------------------------------------------------------------
    this.exits = exitZones(location);

    // --- player ------------------------------------------------------------------
    const spawn = spawnPixel(location, this.assets.spawn);
    this.player = this.physics.add.sprite(spawn.x, spawn.y, "player", 0);
    this.player.setOrigin(0.5, 0.5);
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setSize(BODY_SIZE, BODY_SIZE);
    // Godot's shape sits 6 px above the sprite origin; centre the 12x12 box there.
    body.setOffset((FRAME_WIDTH - BODY_SIZE) / 2, (FRAME_HEIGHT - BODY_SIZE) / 2 - 6);
    this.player.setDepth(spawn.y);

    this.physics.add.collider(this.player, solids);

    // --- camera ------------------------------------------------------------------
    const bounds = mapPixelSize(location);
    this.cameras.main.setBounds(0, 0, bounds.width, bounds.height);
    this.physics.world.setBounds(0, 0, bounds.width, bounds.height);
    this.cameras.main.startFollow(this.player, true, 0.15, 0.15);
    this.cameras.main.setRoundPixels(true);

    // --- input -------------------------------------------------------------------
    // Explicit per-key registration. `addKeys("W,A,S,D")` returns keys named "W","A","S","D";
    // casting that to {up,down,left,right} satisfied the compiler while every property was
    // undefined at runtime, and the update loop threw on the first frame. `addKey` returns a
    // Key directly, so the shape is checked instead of asserted.
    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.wasd = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.interactKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);

    // --- animation ---------------------------------------------------------------
    for (const [direction, column] of DIRECTIONS) {
      const stand = column;
      const step = column + DIRECTIONS.length;
      if (!this.anims.exists(`idle-${direction}`)) {
        this.anims.create({
          key: `idle-${direction}`,
          frames: [{ key: "player", frame: stand }],
          frameRate: 1,
        });
        this.anims.create({
          key: `walk-${direction}`,
          frames: [
            { key: "player", frame: stand },
            { key: "player", frame: step },
          ],
          frameRate: 6,
          repeat: -1,
          yoyo: true,
        });
      }
    }

    // --- npcs --------------------------------------------------------------------
    this.placeNpcs();
  }

  /**
   * Place the NPCs whose `requires` pass, and remove the rest.
   *
   * This is the first place the shared rules module does real work in the client: the very same
   * `requires` objects the admin's builder evaluates and the server will filter with are
   * evaluated here with `evaluate` from `@hkstories/core`, so all three cannot disagree.
   */
  private placeNpcs(): string[] {
    for (const npc of this.npcs) npc.object.destroy();
    this.npcs = [];

    const { location, npcDefs, npcSheetUrls } = this.assets;

    for (const placement of location.npcs ?? []) {
      if (!evaluate(placement.requires, this.gameState)) continue;

      const point = tileCentre(location, placement.tile);
      const frame = FACING_FRAME[placement.facing ?? "down"] ?? 0;
      const sheetPath = npcDefs[placement.npc]?.sprite?.sheet_walk;
      const textureKey = sheetPath ? `npc:${artFileName(sheetPath)}` : "";

      let object: Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle;
      if (textureKey && this.textures.exists(textureKey) && npcSheetUrls[artFileName(sheetPath!)]) {
        object = this.add.sprite(point.x, point.y, textureKey, frame);
      } else {
        // Content has NPCs whose art has not been generated yet. `npc_body.gd` falls back to a
        // drawn rectangle for exactly this case, so this is the port of that behaviour rather
        // than a shortcut — and it keeps the gating observable instead of silently absent.
        object = this.add.rectangle(point.x, point.y, FRAME_WIDTH - 4, FRAME_HEIGHT - 6, 0x8b8578, 0.8);
      }

      object.setDepth(point.y);
      this.npcs.push({
        id: placement.npc,
        object,
        home: { x: point.x, y: point.y },
        wander: Number(placement.wander ?? 0) || 0,
        target: null,
        // `npc_body.gd` opens with a random 1-3 s wait, so a street does not step in unison.
        wait: 1 + Math.random() * 2,
      });
    }

    return this.visibleNpcIds();
  }

  visibleNpcIds(): string[] {
    return this.npcs.map((npc) => npc.id);
  }

  /**
   * Replace the state projection and re-evaluate placement.
   *
   * A save, a test, or (later) the server telling us what changed all come through here, so
   * there is one path from "state changed" to "what is on screen".
   */
  setGameState(state: ConditionState): string[] {
    this.gameState = state;
    this.refreshGates();
    return this.placeNpcs();
  }

  /** Everything whose appearance depends on state, re-evaluated from one place. */
  private refreshGates(): void {
    const flags = this.gameState.flags ?? {};

    for (const door of this.doors) {
      const flag = door.placement.openFlag;
      if (!door.open && flag !== "" && flags[flag] === true) this.openDoor(door);
    }

    for (const entry of this.interactables) {
      const usable = evaluate(entry.placement.requires, this.gameState) && !entry.used;
      entry.object?.setVisible(usable);
    }
  }

  /** Which NPC, door or prop the player is standing next to — what the prompt and E act on. */
  nearestTarget(range = 30): WorldTarget | null {
    const candidates: Array<{ target: WorldTarget; x: number; y: number }> = [
      ...this.npcs.map((npc) => ({
        target: { kind: "npc", id: npc.id } as WorldTarget,
        x: npc.object.x,
        y: npc.object.y,
      })),
      ...this.doors
        .filter((door) => !door.open)
        .map((door) => ({
          target: { kind: "door", id: door.placement.id } as WorldTarget,
          x: door.placement.centre.x,
          y: door.placement.centre.y,
        })),
      ...this.interactables
        .filter((entry) => entry.object?.visible === true)
        .map((entry) => ({
          target: { kind: "interactable", id: entry.placement.id } as WorldTarget,
          x: entry.placement.point.x,
          y: entry.placement.point.y,
        })),
    ];

    let closest: WorldTarget | null = null;
    let closestDistance = range;

    for (const candidate of candidates) {
      const distance = Phaser.Math.Distance.Between(
        this.player.x,
        this.player.y,
        candidate.x,
        candidate.y,
      );
      if (distance <= closestDistance) {
        closest = candidate.target;
        closestDistance = distance;
      }
    }

    return closest;
  }

  /** Try a door: `requires` decides, and the content decides what to say when it refuses. */
  activateDoor(id: string): void {
    const door = this.doors.find((entry) => entry.placement.id === id);
    if (!door || door.open) return;

    if (!evaluate(door.placement.requires, this.gameState)) {
      const blocked = door.placement.blocked;
      if (blocked !== null) this.assets.onMessage?.(blocked);
      return;
    }

    const opened = door.placement.opened;
    if (opened !== null) this.assets.onMessage?.(opened);

    // Setting the flag is the shell's job — it owns the save. This opens the door either way.
    if (door.placement.openFlag !== "") {
      this.assets.onEffects?.([{ type: "set_flag", flag: door.placement.openFlag, value: true }]);
    }
    this.openDoor(door);
  }

  /** Use an interactable: hand its effects over and retire it if it is a one-shot. */
  activateInteractable(id: string): void {
    const entry = this.interactables.find((item) => item.placement.id === id);
    if (!entry || entry.object?.visible !== true) return;

    this.assets.onEffects?.(entry.placement.effects);

    if (entry.placement.once) {
      entry.used = true;
      entry.object.setVisible(false);
    }
  }

  /** Swap a door's tiles for floor and drop its blocker. Idempotent, like `_open_silently`. */
  private openDoor(door: DoorRuntime): void {
    if (door.open) return;
    door.open = true;

    door.blocker?.destroy();
    door.blocker = null;

    this.tiles = openDoorTiles(this.tiles, door.placement.tiles, ".");
    for (const [x, y] of door.placement.tiles) {
      this.layer?.putTileAt(this.floorIndex, x, y);
    }
  }

  /**
   * Move the wanderers.
   *
   * `npc_body.gd` shuffles every few seconds to a random walkable tile inside the placement's
   * radius, gliding at 20 px/s and snapping on arrival. Radius 0 is a fixture, and a conversation
   * holds the whole street still — an NPC that drifts away mid-sentence is a target you cannot talk
   * to.
   */
  private updateNpcs(deltaMs: number): void {
    const seconds = deltaMs / 1000;
    const size = this.assets.location.tile_size;

    for (const npc of this.npcs) {
      if (!this.inputEnabled || npc.wander <= 0) continue;

      if (npc.target === null) {
        npc.wait -= seconds;
        if (npc.wait > 0) continue;

        const home: [number, number] = [
          Math.floor(npc.home.x / size),
          Math.floor(npc.home.y / size),
        ];
        const tile = pickWanderTarget(home, npc.wander, (x, y) => this.isWalkable(x, y));

        if (tile === null) {
          // Nothing walkable within reach: idle, then try again. A cornered NPC stays put rather
          // than sliding through a wall.
          npc.wait = 2 + Math.random() * 2;
          continue;
        }

        npc.target = { x: (tile[0] + 0.5) * size, y: (tile[1] + 0.5) * size };
        this.faceNpc(npc, npc.target);
      }

      const step = 20 * seconds;
      const dx = npc.target.x - npc.object.x;
      const dy = npc.target.y - npc.object.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= step || distance < 1.5) {
        npc.object.setPosition(npc.target.x, npc.target.y);
        npc.target = null;
        npc.wait = 2 + Math.random() * 3;
      } else {
        npc.object.setPosition(
          npc.object.x + (dx / distance) * step,
          npc.object.y + (dy / distance) * step,
        );
      }

      npc.object.setDepth(npc.object.y);
    }
  }

  private faceNpc(npc: PlacedNpc, target: { x: number; y: number }): void {
    const facing = facingBetween(npc.object, target);
    if (npc.object instanceof Phaser.GameObjects.Sprite) {
      npc.object.setFrame(FACING_FRAME[facing] ?? 0);
    }
  }

  /** Wander only steps onto tiles inside the map that no collision rect covers. */
  private isWalkable(tileX: number, tileY: number): boolean {
    const { location } = this.assets;
    const row = location.tilemap[tileY];
    if (row === undefined || tileX < 0 || tileX >= row.length) return false;

    for (const [x, y, width, height] of location.collision) {
      if (tileX >= x && tileX < x + width && tileY >= y && tileY < y + height) return false;
    }
    return true;
  }

  /** Exits fire on entry, once per visit, and only where `requires` allows. */
  private updateExits(): void {
    const zone = exitAt(this.exits, this.player.x, this.player.y);
    const entered = zone?.id ?? null;

    // `body_entered` semantics: the trigger is the zone under the player *changing*. A boolean
    // "in no zone" latch would miss walking straight from one zone into the next, which is exactly
    // how adjacent exits on a street meet.
    if (entered === this.currentExit) return;
    this.currentExit = entered;
    if (zone === null) return;

    if (evaluate(zone.requires, this.gameState)) {
      this.assets.onExit?.(zone.to, zone.spawn);
      return;
    }
    if (zone.blocked !== null) this.assets.onMessage?.(zone.blocked);
  }

  /** Stops the player taking input while a conversation panel is open. */
  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  /** A touch d-pad sets a direction; releasing it clears the vector. */
  setTouchDirection(x: number, y: number): void {
    this.touch = { x, y };
  }

  /** Swap the map and rebuild. Textures are already loaded, so a restart is all it takes. */
  loadLocation(location: LocationFile, spawn?: string): void {
    this.assets.location = location;
    this.assets.spawn = spawn;
    this.scene.restart();
  }

  /** Which map is built right now — not the one requested, which matters across a restart. */
  private loadedLocationId = "";

  /** The map that has finished building, so a caller can wait for a swap to complete. */
  locationId(): string {
    return this.loadedLocationId;
  }

  /** Teleport the player. A test hook, in the same spirit as `setGameState`: walking is agenda. */
  movePlayer(x: number, y: number): void {
    this.player.setPosition(x, y);
    this.player.setVelocity(0, 0);
  }

  /** The character painted at a tile, which is how a door swap becomes observable. */
  tileAt(x: number, y: number): string {
    return this.tiles[y]?.[x] ?? "";
  }

  /** The content's own prompt for a target, so the HUD never invents wording. */
  labelFor(target: WorldTarget): LocalizedText | null {
    if (target.kind === "door") {
      return this.doors.find((door) => door.placement.id === target.id)?.placement.prompt ?? null;
    }
    if (target.kind === "interactable") {
      return (
        this.interactables.find((entry) => entry.placement.id === target.id)?.placement.prompt ?? null
      );
    }
    return null;
  }

  update(_time: number, deltaMs: number): void {
    // The scene is fully built by the first update, which is the earliest a restored save can be
    // applied without racing `create()`.
    if (!this.ready) {
      this.ready = true;
      this.assets.onReady?.();
    }

    if (this.inputEnabled) {
      const left = this.cursors.left.isDown || this.wasd.left.isDown;
      const right = this.cursors.right.isDown || this.wasd.right.isDown;
      const up = this.cursors.up.isDown || this.wasd.up.isDown;
      const down = this.cursors.down.isDown || this.wasd.down.isDown;

      const dx = (right ? 1 : 0) - (left ? 1 : 0) + this.touch.x;
      const dy = (down ? 1 : 0) - (up ? 1 : 0) + this.touch.y;
      const moving = dx !== 0 || dy !== 0;

      const direction = new Phaser.Math.Vector2(dx, dy);
      if (moving) direction.normalize().scale(PLAYER_SPEED);
      this.player.setVelocity(direction.x, direction.y);

      if (moving) {
        // Horizontal wins when both axes are held, so diagonals keep the sideways sprite.
        this.facing = dx !== 0 ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
        this.player.play(`walk-${this.facing}`, true);
      } else {
        this.player.play(`idle-${this.facing}`, true);
      }

      if (Phaser.Input.Keyboard.JustDown(this.interactKey)) {
        const target = this.nearestTarget();
        if (target) this.assets.onActivate?.(target);
      }
    } else {
      // Held keys would otherwise keep queuing movement behind the dialogue panel.
      this.player.setVelocity(0, 0);
      this.player.play(`idle-${this.facing}`, true);
    }

    this.updateNpcs(deltaMs);
    this.updateExits();

    // Y-sorting: the player is in front of everything above them and behind everything below.
    this.player.setDepth(this.player.y);
    this.assets.onPlayerMoved?.(this.player.x, this.player.y);
  }
}
