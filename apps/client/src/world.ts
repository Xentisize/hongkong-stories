import { evaluate, type ConditionState } from "@hkstories/core";
import Phaser from "phaser";

import {
  artFileName,
  mapPixelSize,
  rectToPixels,
  spawnPixel,
  tileCentre,
  tileIndexGrid,
  type LocationFile,
  type NpcFile,
} from "./content";

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
  onPlayerMoved?: (x: number, y: number) => void;
}

interface PlacedNpc {
  id: string;
  object: Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle;
}

export class WorldScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private facing = "down";
  private npcs: PlacedNpc[] = [];

  /** The save projection conditions read. Empty until a test or a save supplies one. */
  private gameState: ConditionState = {};

  constructor(private readonly assets: WorldAssets) {
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
    const { location } = this.assets;
    const size = location.tile_size;

    // --- terrain -----------------------------------------------------------------
    const grid = tileIndexGrid(location);
    const map = this.make.tilemap({ data: grid, tileWidth: size, tileHeight: size });
    const tileset = map.addTilesetImage("tiles", "tiles", size, size);
    if (!tileset) throw new Error("tileset failed to attach — check the atlas image key");
    map.createLayer(0, tileset, 0, 0);

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
    for (const item of location.decor ?? []) {
      const fileName = artFileName(item.art);
      if (!this.assets.propUrls[fileName]) continue;
      const point = tileCentre(location, item.tile);
      this.add.image(point.x, point.y, `prop:${fileName}`).setDepth(point.y);
    }

    // --- player ------------------------------------------------------------------
    const spawn = spawnPixel(location);
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
      this.npcs.push({ id: placement.npc, object });
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
    return this.placeNpcs();
  }

  update(): void {
    const left = this.cursors.left.isDown || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;
    const up = this.cursors.up.isDown || this.wasd.up.isDown;
    const down = this.cursors.down.isDown || this.wasd.down.isDown;

    const dx = (right ? 1 : 0) - (left ? 1 : 0);
    const dy = (down ? 1 : 0) - (up ? 1 : 0);
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

    // Y-sorting: the player is in front of everything above them and behind everything below.
    this.player.setDepth(this.player.y);
    this.assets.onPlayerMoved?.(this.player.x, this.player.y);
  }
}
