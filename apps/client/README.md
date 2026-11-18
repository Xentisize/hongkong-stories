# Phaser client

The browser client: a Phaser 4 scene over the same content pack the Godot client reads, with the
shared rules in `@hkstories/core` doing the decisions.

```bash
bun run dev        # vite, proxying /v1 to the API on :3000
bun run check      # tsc --noEmit
bun test           # unit suites (no browser, no network)
bun run build      # static bundle in dist/
bun run verify     # builds, serves, drives chromium, asserts on scene state
```

`verify` needs `playwright-cli` plus a chromium build
(`playwright-cli install-browser chrome-for-testing`). It is a verification tool, not a dependency
the game ships.

### The demo

```bash
bun run build                      # in apps/client
bun tools/serve_demo.ts            # repo root: the bundle + /v1, one origin, :8100
playwright-cli --raw run-code --filename=apps/client/scripts/verify-demo.js http://127.0.0.1:8100/
```

`tools/serve_demo.ts` serves `dist/` and proxies `/v1` to the API (default `:3000`), so what opens is
the artifact a deploy publishes rather than a dev server. It streams `/v1/chat` through unbuffered —
the dialogue would stall for the whole turn otherwise — and sends `no-store`, because a demo that
serves a cached bundle shows the wrong build.

## The content contract

Authoring (the admin SPA) and the engines exchange one thing: the pack in `client/content/`, described
by `manifest.json`. The manifest carries `version`, `content_hash` and the `files` list; the API serves
it at `/v1/content/manifest.json`, and the client compares the hash with the one it was built from.

| Kind | File | Carries | Read by |
|---|---|---|---|
| `locations/` | `loc_*.json` | `tilemap` + `legend` + `atlas` + `tile_size`, `collision` rects, `decor`, `doors`, `exits`, `interactables`, `npcs` placements, `spawn_points`, `music`, `context` | renderer (`world.ts`), `entities.ts` |
| `npcs/` | `npc_*.json` | `display_name`, `persona`, `lore`, `secrets`, `llm` overrides, `scripted_fallback`, `sprite`, `states` (event pages with `requires` + `persona_patch`), `trigger` | scene (sprite), dialogue (persona/fallback), API (prompt) |
| `items/` | `item_*.json` | `name`, `desc`, `category`, `stack_max`, `usable`, `use_requires`, `on_use`, `on_acquire` | `state.ts` (inventory), core (`applyEffects`) |
| `quests/` | `ch*.json`, `q_*.json` | `title`, `entry_requires`, `nodes[]` with `type` (`objective` \| `cutscene`), `complete_when`, `on_complete`, `next`, `text` | `quests.ts` |
| `lore/` | `*.json` | long-form reference text | content gate, API prompts |
| `art/` | PNGs | sprites, props, portraits | scene |

Conditions and effects are **not** a content format of their own: they are the JSON vocabulary
implemented once in `packages/core` (`evaluate`, `applyEffects`), and every consumer — this client,
the API, the admin's builder, the gates — calls that one implementation. That is why a `requires`
object authored in the admin evaluates the same here.

### Where the gaps are, if a chapter is the unit you want to author

A **chapter today is a quest** (`quests/ch01..ch06.json`: a `title`, `entry_requires` and a node
graph) plus the locations whose `era` names it. Nothing joins them: no document says "chapter 3 is
these maps, these quests, this entry point". Transitions are physical and per-map
(`locations[].exits`: a rect, a target, a spawn, a `requires`, a `blocked` line), not narrative
chapter-to-chapter links.

So the aggregation layer is the piece that does not exist yet. The cheapest shape that fits what is
already there:

```jsonc
// chapters/ch03.json — references only, so the pack keeps one source per entity
{
  "schema_version": 1,
  "id": "ch03",
  "title": { "zh_HK": "第三章：磁帶" },
  "entry": { "location": "loc_kln_lane_1963", "spawn": "default", "requires": { "quest_done": "ch02" } },
  "quests": ["ch03"],
  "locations": ["loc_kln_lane_1963", "loc_kln_market_1955"],
  "transitions": [
    { "to": "ch04", "requires": { "quest_done": "ch03" }, "text": { "en": "…" } }
  ]
}
```

The validator would check that every referenced id exists — which it already does for the references
content has today.

Two smaller gaps worth naming:

- **No published schema.** `packages/core/src/validate.ts` is a hand-written validator, so the admin
  forms, the gate and the engines agree by convention rather than by a shared document. `zod` is
  already a dependency (`NpcReplySchema`), and `z.toJSONSchema` is already used, so emitting a JSON
  Schema per content kind is mechanical — and would let the admin generate forms from it.
- **No behaviour vocabulary beyond placement.** An NPC wanders by `placement.wander` (tile radius) and
  faces `placement.facing`; its `states` gate persona and dialogue, not movement. Patrols, scripted
  walks or schedules would be new content fields, not existing ones.

## Selftest parity

The Godot client's `--selftest` is 123 checks. Porting it literally would mean porting engine-specific
assertions (stream types, glyph rasterisation); what matters is that every *category* of behaviour is
asserted somewhere here. The mapping:

| Godot selftest group | Where it is asserted now |
|---|---|
| `cond` (11), `effects` (10) | `packages/core` suites, over the shared fixtures |
| `quest` (12) | `src/quests.test.ts` (advance, cutscene hold, re-entrancy, cycle bound) + `verify-quest.js` |
| `save` (6), `save code` (9) | `src/state.test.ts`, `src/save.test.ts`, and an engine round-trip in as both directions (`save.ts` docs) |
| `door` (8) | `src/entities.test.ts` (bounds, grouping, floor swap) + `verify-world.js` (needs-interaction, opens-on-use, tile swap) |
| `audio` (7) | `src/audio.test.ts` (policy) + `verify-world.js` (`audio:ssp_2027`) |
| `font` (6) | `tools/check_font_coverage.ts` + `verify-dialogue.js` (`font-loaded`) |
| `fallback` (4) | `src/dialogue.test.ts` (offline ladder, budget, stream truncation) |
| `locale` (3) | `packages/core` locale chain + the content gate's particle check |
| `gating` (3) | `verify-npc-gating.js` (NPC `requires`), `verify-world.js` (gated prop hidden → shown) |
| `content` (3) | `tools/check_content.ts` |
| `budget` (2) | `src/dialogue.test.ts` (a spent budget refuses without calling) |
| `fixtures` (2) | the shared condition fixture table |
| `touch` (2) | `verify-world.js` (`touch-hidden` on a fine pointer); the pad itself is wired in `main.ts` |
| `states` (2) | **not ported** — NPC event pages gate the server's prompt, and the client renders what it is sent |
| `live` (6) | **not in CI** — a live turn costs money and needs a key; `verify-dialogue.js` exercises the real stream whenever the API is up, and reports `authored-fallback` when it is not |

Two of those are deliberate omissions rather than oversights, and both are called out above: the
event-page *rendering* has nothing to render (the persona drives the reply), and a paid live turn
belongs in a manual run, not every push.
