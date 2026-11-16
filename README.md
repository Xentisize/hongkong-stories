# Hong Kong Stories

A pixel-art 2D RPG that begins in Hong Kong in 2027 and travels backward into the moments
that made it. You walk, you talk to people who remember, you collect what they leave behind.
Godot 4.7 · browser-deployed · LLM-driven NPCs.

Ships in three locales: **written Cantonese (Traditional)**, **Simplified Chinese**, and
**English** — three real versions of every string, not glyph conversion (PLAN §5.8).

**Status: P1 complete — the core loop runs.** Walk a tiled location, search a crate, take an
item, use it on a locked door, quit, reload, and your inventory is still there. There are no
NPCs and no dialogue yet: that is P2. Architecture and plan: [`docs/PLAN.md`](docs/PLAN.md).

## Quick start

```bash
python3 tools/gen_content_manifest.py                 # after ANY content JSON change
tools/export_web.sh                                   # → build/web/
python3 -m http.server 8099 --directory build/web     # → http://127.0.0.1:8099/
```

Or open `client/project.godot` in Godot 4.7.2 and press F5.

**Controls:** WASD / arrows to walk · **E** interact · **I** inventory · **F1** dev console.

## Dev console (F1)

```
flag <name> [0|1]     give <item> [n]      take <item> [n]    var <name> <value>
tp <x> <y>            loc <location_id>    save [slot]        load [slot]
newgame               locale <zh_HK|zh_CN|en>                 dump
```

`flag door_open 1` then walking to the door and pressing **E** opens it — the same code path a
key item uses, so there is no special-case debug door.

## Tests

```bash
godot --headless --path client -- --selftest     # 36 assertions, exit code = failures
```

Covers content loading, three-locale resolution, effects (including `stack_max` clamping),
every condition verb, the save round-trip, and door gating across a location rebuild.

```bash
python3 -m http.server 8099 --directory build/web &
node tools/web_smoke.mjs http://127.0.0.1:8099/ /tmp/shot.png 12000
```

Drives real Chrome over CDP, waits for the wasm to compile (a `--virtual-time-budget`
screenshot only ever catches Godot's loading screen), and reports canvas size, page logs,
console errors, and a screenshot.

## Verified in P1

| Check | Result |
|-------|--------|
| `--selftest` | **36 checks, 0 failures**, exit 0 |
| `tools/export_web.sh` | exit 0 → `index.wasm` 38 MB · `index.pck` 59 KB · `index.js` 273 KB |
| Real browser boot | canvas live, loader finished, **0 console errors** |
| Content in wasm | page log `[ContentDB] loaded 2 entities \| locale=zh_HK` — manifest-driven loading works in the exported build |
| Rendering | 152 distinct colours; floor 30%, wall 6%, door + player present (generated atlas, not drawn primitives) |

**Content iteration loop:** edit JSON → `python3 tools/gen_content_manifest.py` →
`tools/export_web.sh`. Until P4's hot-pack endpoint exists, content changes require a re-export.

## Known gaps (deliberate)

- **Placeholder art.** Tiles and the item icon come from `tools/gen_placeholder_art.py`;
  the player is still drawn in code. Seedream generation is P4.
- **Maps are JSON, not editor scenes.** `LocationRoot` builds the `TileMapLayer` + `TileSet` at
  runtime from `tilemap`/`legend` rows (PLAN §5.3 explains why and the migration path).
- **No brotli pre-compression** — `brew install brotli` and the export script picks it up;
  38 MB raw wasm is what PLAN §10.4 budgets against.
- **One location, so exits are coded but unexercised.** No NPCs, dialogue, or backend (P2).
- **60 fps on a physical phone** is still an eyeball test.
- **gdUnit4 not adopted yet** — `client/tests/selftest.gd` carries the assertions until P2.

## Read this first

| Section | What it settles |
|---------|-----------------|
| [§2](docs/PLAN.md#2-verified-environment-checked-not-assumed) | Verified environment + model prices/capabilities |
| [§3](docs/PLAN.md#3-architecture-and-trust-boundary) | Architecture, and why the API key can never be in the client |
| [§5](docs/PLAN.md#5-content-data-model) | NPC/item/location/quest schemas, condition & effect languages, three locales |
| [§6](docs/PLAN.md#6-runtime-client-design-godot-47) | Godot settings, autoloads, scenes, saves, fonts |
| [§7](docs/PLAN.md#7-llm-conversation-design) | Chat protocol, prompt-cache strategy, action allowlists, cost model |
| [§8](docs/PLAN.md#8-pixel-art-asset-pipeline-seedream--game-ready-sprites) | Seedream → game-ready pixel art pipeline |
| [§9](docs/PLAN.md#9-admin-mode) | Admin mode design and why it's a browser SPA |
| [§10](docs/PLAN.md#10-web-deployment) | Web export, hosting split, budgets, CI, toolchain pins |
| [§12](docs/PLAN.md#12-milestones) | Phases P0–P6 with observable exit criteria |
| [§14](docs/PLAN.md#14-open-decisions-before-scaffolding) | The four decisions still open |

## Prerequisites

- Godot **4.7.2** — installed at `/Applications/Godot.app`; web export templates installed for
  `4.7.2.stable` (see [§10.1](docs/PLAN.md#101-export-templates-installed-in-p0)).
- **Python 3.15.2**, locked exactly — managed by `uv` (`uv python pin 3.15.2`, then `uv sync`).
  The system `python3` is 3.9.6 and is only used for the stdlib tooling scripts under `tools/`.
  See [§10.6](docs/PLAN.md#106-toolchains-python-3152-and-bun-144).
- **bun 1.4.4** for the admin SPA (`~/.bun/bin/bun`) — the only package manager; no npm, pnpm
  or yarn lockfiles in the repo. See [§10.6](docs/PLAN.md#106-toolchains-python-3152-and-bun-144).

## Secrets

`OPENROUTER_API_KEY` lives in the backend environment only. It must never appear in
`client/`, in `export_presets.cfg`, or in any file that ships to a browser.
