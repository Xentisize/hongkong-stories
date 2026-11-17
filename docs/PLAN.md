# Hong Kong Stories — Build Plan

A Godot 4.7 pixel-art 2D RPG. The player starts in Hong Kong in 2027 and travels backward
through the moments that made the city — talking to LLM-driven NPCs, collecting mementos, and
advancing story chapters. Browser-deployed. An admin mode authors NPCs/items/quests and
generates pixel art via Seedream.

---

## 1. Design pillars

| # | Pillar | Consequence for engineering |
|---|--------|-----------------------------|
| 1 | **Walk, look, talk** — no combat, no fail state | No battle system, no damage model, no enemy AI. Effort goes into dialogue, interaction, and pacing. |
| 2 | **NPCs are conversations, not dialogue trees** | LLM per NPC persona, but with a scripted fallback tree so the game never dead-ends when the network is down. |
| 3 | **Everything is data** | NPCs, items, triggers, quests live in JSON, editable without touching GDScript. Same schema powers admin mode and the runtime. |
| 4 | **History is authored, not invented** | LLM may *perform* a character but may not *assert facts* that are not in the authored lore block. Facts are content, not model output. |
| 5 | **Runs in a browser tab on a phone** | Single-threaded web export, integer-scaled pixel canvas, strict asset budget, no key ever in the client. |
| 6 | **Cantonese is the voice, not a translation** | `zh_HK` is authored, never derived by glyph conversion (§5.8). Simplified Chinese and English are equally real versions — three locales from day one, enforced by validation. |

---

## 2. Verified environment (checked, not assumed)

| Item | Status |
|------|--------|
| Godot | `4.7.2.stable.official` at `/Applications/Godot.app` |
| **Web export templates** | **Installed** for `4.7.2.stable` — web (no-threads) templates only; see §10.1 for how and why |
| Workspace | Git repo initialised; `client/` runs headless, passes `--selftest` 36/36, exports `build/web`, and boots in a browser (P0–P1 ✅) |
| Python / bun | `uv`-managed **CPython 3.15.2** (`~/.local/bin/python3.15`) / **bun 1.4.4** (`~/.bun/bin/bun`). The system `/usr/bin/python3` is **3.9.6** and an nvm Node 26.13.1 also exists — use neither for this project; see §10.6 |
| Languages | `zh_HK` (written Cantonese, Traditional) · `zh_CN` (Simplified) · `en` — three independent versions of every string, not glyph conversion; §5.8, fonts in §6.5 |
| Chat model | `deepseek/deepseek-v4.1-flash-1017` — 1,048,576 ctx, $0.15/M in, $0.60/M out, **$0.003/M cached read**; supports `response_format`, `structured_outputs`, `tools`, `seed`, `stop`, `max_tokens`, `reasoning_effort` |
| Image model | `bytedance-seed/seedream-5-0-flash` — **$0.018/image**; `resolution` 1K/1.5K/2K, `aspect_ratio` enum, `output_format` png/jpeg, `background` auto/transparent/opaque, `seed`, **`input_references` 0–14**. **2026-11-17 live re-check:** 5-0-flash refuses text-to-transparent — transparent output needs a reference PNG that itself carries a transparent pixel, or `bytedance-seed/seedream-5-5`; `input_references` entries are `{"type":"image_url","image_url":{"url":…}}` objects (≤16), data URLs or https |
| Image API | `POST https://openrouter.ai/api/v1/images` → `{model, prompt, resolution, aspect_ratio, background, seed, input_references}` → `data[].b64_json` + `usage.cost`. (Legacy route `chat/completions` + `modalities:["image","text"]` also works; the dedicated `/images` endpoint is the one to use.) |

Two consequences that shape the design:

1. **1M context is effectively free RAG.** For a single chapter we can ship the *whole*
   era lore digest in the prompt instead of building a vector store. Retrieval becomes
   "pick 1 chapter file", not embeddings.
2. **Cached reads are 50× cheaper than fresh prompt tokens.** Prompt assembly must put
   stable text (persona + lore + rules) first and volatile text (player state, recent
   turns) last, so the prefix hits the provider cache on every turn.

---

## 3. Architecture and trust boundary

```
┌──────────────────────────── Browser ────────────────────────────┐
│  Godot 4.7 WASM build (static, Cloudflare Pages)                │
│    Game state · content cache · save in IndexedDB               │
└────────────┬───────────────────────────────┬────────────────────┘
             │ HTTPS  (content pack, saves)  │ WSS (chat stream)
             ▼                               ▼
┌──────────────────────── Backend (FastAPI) ──────────────────────┐
│  PUBLIC        /v1/chat (WS)   /v1/content/*   /v1/save (opt)    │
│  ADMIN         /admin/*        /v1/admin/*     (bearer token)    │
│  SECRETS       OPENROUTER_API_KEY  ← only here, never in WASM    │
│  DUTY          prompt assembly · action validation · rate limits │
│                · asset post-processing · content publish         │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼  OpenRouter
     deepseek-v4.1-flash-1017   (chat, streaming)
     seedream-5-0-flash         (art generation, admin only)
```

**Hard rule: the OpenRouter key never appears in the Godot build.** A `.wasm`/`.pck` is
fully inspectable in devtools; any key in the client is a published key. Every model call
goes through the backend, which owns the key, the prompts, the per-session budget, and the
allowlist of state changes an NPC is permitted to cause.

**Why a backend at all (and not `HTTPRequest` straight to OpenRouter):** three things are
impossible or unsafe client-side — keeping the key secret, streaming tokens (Godot's
`HTTPRequest` cannot stream; `WebSocketPeer` can), and *authoritatively* validating what an
LLM is allowed to do to game state (a player can patch the client).

---

## 4. Repository layout

```
hongkong-stories/
├── docs/PLAN.md                  ← this file
├── client/                       ← Godot 4.7 project (project.godot lives here)
│   ├── project.godot
│   ├── export_presets.cfg
│   ├── autoload/                 Game ContentDB Conditions Effects Bus Net Save Settings
│   ├── scenes/                   main/ world/ npc/ ui/ fx/
│   ├── scripts/                  player/ npc/ interaction/ dialogue/
│   ├── content/                  JSON baseline bundled into the build (offline fallback)
│   │   ├── npcs/ items/ locations/ quests/ lore/ manifest.json
│   └── art/                      authored pixel art (tilesets, UI) — generated art is
│                                 served from the content pack, not from res://
├── server/
│   ├── app/main.py               FastAPI app + CORS + router wiring
│   ├── app/routers/              chat.py content.py admin.py assets.py save.py
│   ├── app/llm/                  openrouter.py prompts.py schema.py validate.py cache.py
│   ├── app/content/              loader.py publish.py validate.py (schema + referential)
│   ├── app/assets/               seedream.py pixelate.py palette.py provenance.py
│   ├── app/store/                sqlite (sessions, usage, drafts, asset provenance)
│   ├── admin/                    SPA source + build (Vite + TS, bun) → served at /admin
│   └── tests/
├── content-src/                  authoring source of truth (git-committed JSON + art refs)
├── tools/                        export_web.sh · check_content.py · gen_manifest.py
└── deploy/                       Dockerfile · fly.toml · pages headers · GH Actions
```

`content-src/` is the source of truth. `client/content/` is a *generated* snapshot copied
in at export time, so a stale copy can never silently diverge — `tools/check_content.py`
enforces it in CI.

---

## 5. Content data model

All content is JSON with a `schema_version`. Every entity has `id`, and localized string
fields are **three-locale objects** — `{"zh_HK": "...", "zh_CN": "...", "en": "..."}` — with
all three keys required by validation (§5.8). Examples below elide `zh_CN` in places for
brevity; the validator does not.

### 5.1 NPC

```json
{
  "schema_version": 1,
  "id": "npc_chan_kowloon_1955",
  "display_name": { "zh_HK": "陳伯", "zh_CN": "陈伯", "en": "Uncle Chan" },
  "era": "ch02_kowloon_1955",
  "sprite": { "sheet": "art/npc/chan.png", "frames": { "idle": [0], "walk": [1, 2, 3, 2] } },
  "persona": {
    "role": "A 58-year-old street stall hawker who has lived in Kowloon for 30 years.",
    "voice": "Gruff, economical with words, warm underneath. Uses 1950s Cantonese slang.",
    "wants": "Someone to remember his daughter by.",
    "taboos": ["Never discusses politics", "Will not admit he cannot read well"],
    "knowledge_tags": ["kowloon_1950s", "street_food", "squatter_huts"]
  },
  "llm": {
    "model": null,
    "temperature": 0.85,
    "max_tokens": 320,
    "language_follow_player": true,
    "actions_allowed": ["give_item", "set_flag", "inc_var", "reveal_secret", "open_shop"],
    "items_may_give": ["item_old_photo"],
    "flags_may_set": ["chan_told_past", "chan_trusts_player"],
    "vars_may_change": { "trust_chan": { "min": -2, "max": 3 } }
  },
  "secrets": [
    { "id": "s_photo", "text": "The photo is of his daughter, lost in the 1954 fire.",
      "reveal_if": { "all": [ { "talked": "npc_chan_kowloon_1955", "min": 3 },
                              { "has_item": "item_sugar_ration" } ] } }
  ],
  "scripted_fallback": {
    "greeting": { "zh_HK": "後生仔，買唔買嘢？", "zh_CN": "小伙子，要不要买点东西？",
                  "en": "Buying something, kid?" },
    "lines": [ "...", "..." ],
    "exit": { "zh_HK": "得閒再嚟。", "en": "Come back when you have time." }
  },
  "trigger": {
    "location": "loc_kowloon_street",
    "requires": { "flag": "ch02_started" },
    "once_per_session": false
  }
}
```

**The `llm` block is the security boundary.** An NPC may only give items listed in
`items_may_give`, only set flags listed in `flags_may_set`, and may only move variables
inside declared bounds. Anything else the model emits is dropped server-side and logged —
this is what keeps "collect items / trigger storylines" trustworthy when the producer is a
language model.

### 5.2 Item

```json
{
  "schema_version": 1,
  "id": "item_old_photo",
  "name": { "zh_HK": "舊相", "en": "Old Photograph" },
  "desc": { "zh_HK": "邊角捲起，黑白人像已經模糊。", "en": "Curled at the corners; the portrait is fading." },
  "icon": "art/item/old_photo.png",
  "stack_max": 1,
  "category": "keepsake",
  "usable": false,
  "on_use": [],
  "on_acquire": [ { "type": "set_flag", "flag": "has_photo" },
                  { "type": "quest", "quest": "ch02", "op": "advance", "node": "n3" } ],
  "lore_ref": "lore/ch02_kowloon_1955.md#the-1954-fire",
  "admin": { "generated": true, "prompt_id": "gen_2026-11-16_014", "reviewed": true }
}
```

### 5.3 Location

```json
{
  "schema_version": 1,
  "id": "loc_kowloon_street",
  "display_name": { "zh_HK": "九龍街市", "en": "Kowloon Market Street" },
  "scene": "res://scenes/world/kowloon_street.tscn",
  "era": "ch02_kowloon_1955",
  "music": "audio/kowloon_1955.ogg",
  "ambient": ["bird", "hawker"],
  "spawn_points": { "from_south": [320, 560], "from_alley": [96, 240] },
  "npcs": [ { "npc": "npc_chan_kowloon_1955", "pos": [420, 380], "facing": "down" } ],
  "exits": [
    { "id": "to_alley", "rect": [0, 200, 48, 120], "to": "loc_back_alley",
      "spawn": "from_market", "requires": { "flag": "ch02_started" } }
  ],
  "interactables": [
    { "id": "stall_lantern", "pos": [180, 300], "sprite": "art/props/lantern.png",
      "on_interact": [ { "type": "say", "text": { "zh_HK": "...", "en": "..." } } ] }
  ]
}
```

**As built in P1 (temporary deviation):** location JSON carries `tilemap` rows + a `legend`
of atlas coordinates, and `LocationRoot` builds the `TileMapLayer` and its `TileSet` at
runtime. Maps are therefore *not* yet editor-authored scenes — the editor is not in the loop
(no final art, headless CI), and this row/legend format is exactly what the P4 admin pipeline
will emit. Collision is a separate `collision` rect list rather than a TileSet physics layer,
so a mis-drawn tile cannot silently break movement. When art is final, swap in editor-authored
`TileMapLayer` scenes and keep the same JSON contract for doors, interactables and spawns.

### 5.4 Quest / chapter

```json
{
  "schema_version": 1,
  "id": "ch02",
  "title": { "zh_HK": "第二章：街市的人", "en": "Chapter 2: The Market People" },
  "entry_requires": { "quest_done": "ch01" },
  "nodes": [
    { "id": "n1", "type": "objective",
      "text": { "zh_HK": "同街市嘅人傾偈。", "en": "Talk to the people at the market." },
      "complete_when": { "talked": "npc_chan_kowloon_1955", "min": 1 },
      "next": "n2", "on_complete": [ { "type": "set_flag", "flag": "chan_met" } ] },
    { "id": "n2", "type": "objective",
      "complete_when": { "has_item": "item_old_photo" }, "next": "n3" },
    { "id": "n3", "type": "cutscene", "script": "res://scenes/cutscene/ch02_end.tscn",
      "next": null, "on_complete": [ { "type": "quest", "quest": "ch02", "op": "complete" } ] }
  ]
}
```

### 5.5 The condition mini-language (one evaluator, used everywhere)

Conditions gate NPC triggers, exits, quest objectives, secrets, and interactables. One
recursive evaluator in GDScript (`Conditions.gd`) mirrors one in Python for validation.

```json
{ "all": [ { "flag": "chan_met" },
           { "not": { "has_item": "item_old_photo" } },
           { "var": "trust_chan", "op": ">=", "value": 2 },
           { "any": [ { "visited": "loc_back_alley" },
                      { "talked": "npc_chan_kowloon_1955", "min": 3 } ] } ] }
```

Verbs: `all` `any` `not` `flag` `has_item` `var` (+`op` in `== != > >= < <=`) `visited`
`talked` (+`min`) `quest_state` `quest_done` `time_of_day`.

### 5.6 The effect mini-language (the only way state changes)

Used identically by: LLM validated actions, quest nodes, interactables, item hooks,
dialogue script nodes. One interpreter (`Effects.gd`), one allowlist check.

| effect | payload |
|--------|---------|
| `set_flag` | `flag`, `value?=true` |
| `give` / `take` | `item`, `count?=1` |
| `var` | `name`, `op:add\|set`, `value` |
| `quest` | `quest`, `op:start\|advance\|complete`, `node?` |
| `say` | `text` (localized) — scripted speech |
| `goto` | `location`, `spawn` |
| `reveal_secret` | `npc`, `secret` |
| `open_shop` | `npc` |
| `play_sfx` / `shake` / `fade` | presentation only |

Every applied effect emits a bus signal (`Bus.flag_set`, `Bus.item_gained`, …) so quests,
UI, and achievements re-evaluate without polling.

### 5.7 Content versioning & hot packs

- `manifest.json` → `{ "manifest_schema": 1, "version": 1, "content_hash": "…", "files": ["items/x.json", …] }`,
  generated by `tools/gen_content_manifest.py`. **Discovery is manifest-driven, not a directory
  scan** — an exported build may store `.json` as an imported resource (`x.json.remap`), which
  a scan lists under a different name and then cannot read. `ContentDB` reads dual-path
  (imported JSON resource first, raw file second) so editor, headless CI and wasm all work.
- Client keeps a **bundled baseline** (`res://content/…`) so the game is playable offline
  and on a cold CDN.
- On boot the client fetches `/v1/content/manifest.json`; if the server version is newer it
  fetches the changed entity files + changed art into memory and overrides the baseline.
  Art is fetched as bytes and decoded at runtime (`Image.load_png_from_buffer` →
  `ImageTexture`), so **adding an NPC with a brand-new sprite needs no re-export**.
- Saves record `content_version`; loaders run forward migrations only.
- Godot logic/maps imply a rebuild; data does not. That separation is the whole point of
  the admin mode: authors iterate on content in seconds, not minutes.

### 5.8 Localization: three locales, two of them Chinese

Locales are `zh_HK`, `zh_CN`, `en`, and they are **three real versions of every string** — not
one version plus glyph conversion.

| Locale | What it must be | Same line, three ways |
|--------|-----------------|-----------------------|
| `zh_HK` | Written Cantonese (粵文), Traditional glyphs | 後生仔，買唔買嘢？ |
| `zh_CN` | Standard written Chinese (書面語), Simplified glyphs | 小伙子，要不要买点东西？ |
| `en` | English | Buying something, kid? |

Converting `zh_HK` → `zh_CN` by swapping glyphs yields Traditional-glyph Mandarin, or worse, a
Mandarin sentence full of Cantonese particles (係 唔 咗 嘅 喺 哋 嗰 冇 嘢) — wrong to readers in
both places. Cantonese has its own characters *and its own grammar*, and it is the voice of this
game, so it cannot be derived from anything. The reverse is also true: drafting `zh_HK` from a
Mandarin sentence produces stiff, unidiomatic Cantonese.

What this locks in:

- **Every localized field carries all three keys**, enforced by `validate` in CI. A missing
  locale **fails the build**; an intentional gap must be declared as `"_todo": ["zh_CN"]` so it
  shows up in a report instead of silently rendering blank in-game.
- **Text authoring volume is ~3×.** That is why §9.2 gives every field a locale tab with
  one-click "draft the other two from this one" — *drafting* works here where machine
  *translation* would not, because the model can be told the register.
- **One canonical locale per entity** is the source of truth for meaning (open decision, §14);
  the other two are drafts a human approves. Never let three locales drift independently.
- **Proper nouns** (street, shop, building names) mostly do convert by glyphs — 深水埗 stays
  深水埗, 灣仔 becomes 湾仔 — but not reliably enough to automate. They follow the same three-key
  rule as everything else.
- Cross-locale parity is a **test**, not a discipline (§11).

---

## 6. Runtime client design (Godot 4.7)

### 6.1 Project settings that matter

| Setting | Value | Why |
|---------|-------|-----|
| `rendering/renderer/rendering_method` | **`gl_compatibility`** | Web must be WebGL2; Forward+ needs WebGPU/native. |
| base viewport | **384 × 216** | 16:9, and exactly 16 × 9 tiles at **24 px** tiles → integer scale ×5 = 1080p. |
| `display/window/stretch/mode` | `canvas_items` | UI and world scale together. |
| `display/window/stretch/scale_mode` | `integer` | No half-pixels at odd window sizes. |
| `textures/canvas_textures/default_texture_filter` | `Nearest` | Crisp pixels. |
| `anti_aliasing/quality/msaa_2d` | `Off` | Guaranteed hard pixel edges. |
| Physics tick | `60`, `physics/2d/default_gravity_y = 0` | Top-down; no gravity. |
| Texture import preset | lossless, no mipmaps, filter off | Avoids VRAM compression artefacts on pixel art. |
| Web threads | **Off** (default) | Threads require COOP/COEP headers and break many hosts; a 2D RPG does not need them. |

24 px tiles (rather than 16) is the deliberate call: characters read clearly on a phone
screen at 384×216 while backgrounds stay authorable — roughly 2–3 hours per location in
Aseprite/Tiled.

### 6.2 Autoloads (the spine)

| Autoload | Responsibility |
|----------|----------------|
| `Bus` | Signal-only event bus (`flag_set`, `item_gained`, `npc_spoke`, `location_entered`, `quest_updated`, `request_dialogue`). Zero logic; prevents autoload spaghetti. |
| `Game` | Serializable state: flags, vars, inventory, quests, talk counters, visited set, current location, npc memory handles. **Everything saveable lives here and nowhere else.** |
| `ContentDB` | Loads/validates baseline JSON, applies hot-pack overrides, indexes by id, resolves loader-relative paths. |
| `Conditions` | Evaluates §5.5 against `Game`. |
| `Effects` | Applies §5.6 (with allowlist context) and emits bus signals. |
| `Net` | `HTTPRequest` wrapper + `WebSocketPeer` chat channel; retry/backoff, session token, auth none (anonymous) for players. |
| `Dialogue` | Owns the active conversation: history window, streaming display, scripted fallback, effect handoff. |
| `Save` | Slots, `content_version` migrations, IndexedDB persistence check, save-code export/import. |
| `Settings` | Language (zh_HK/en), text speed, volume, held in `user://settings.cfg`. |
| `Dev` | F1 command console (debug builds): `flag` / `give` / `take` / `var` / `tp` / `loc` / `save` / `load` / `newgame` / `locale` / `dump`, plus the `--selftest` harness entry point. **This saves more dev time than any other 200 lines.** |

### 6.3 Scenes

`Main.tscn` — `WorldHost` (current location) + `UILayer` (CanvasLayer: dialogue, inventory,
journal, pause, toast) + `FadeLayer`. Scene swapping is `WorldHost` child replacement, so UI
and autoloads survive.

`Player.tscn` — `CharacterBody2D` + `AnimatedSprite2D` + `InteractionProbe` (`Area2D`).
4-directional 8-frame walk, `move_and_slide`, no analog speed curve in MVP.

`Npc.tscn` — `StaticBody2D` + sprite + `Area2D` + `NpcController` (script): holds
`scripted_fallback`, watches proximity, and on interact hands the conversation to
`Dialogue` with `persona`, `secrets` (filtered by `reveal_if`), and the `llm` allowlist.

`YSort`: NPCs and player share a `YSort` parent so overlap draws correctly.

`DialogueUI.tscn` — RichTextLabel typewriter that renders whatever arrives on the stream
(it appends partial tokens; no fake per-character animation while waiting), portrait slot,
choice buttons (scripted nodes only), "…thinking" indicator if first token > 400 ms. It must
use the CJK-capable 12 px font with CJK line height (§6.5) — a Latin pixel font cannot render
a single Chinese character, and this is the panel where every one of them appears.

### 6.4 Save system

`user://saves/slot_N.json` — in a web build this is IndexedDB (IDBFS).

- Call `OS.is_userfs_persisted()` at boot; if false, show a one-time "your progress is
  stored in this browser only" notice (IDBFS is not durable across site-data clearing).
- Save payload: `schema_version`, `content_version`, flags, vars, inventory, quest node
  positions, visited set, talk counts, per-NPC trimmed chat history (last ~12 turns + a
  one-line summary), location + player position, playtime.
- Autosave on location change, quest node completion, and item gain (debounced 2 s).
- **Save code**: base64+zlib of the payload, copyable from the pause menu — free cloud-less
  backup, and the cheapest possible way to let a playtester send you a broken state.

### 6.5 Localization and fonts (the part that can break the web build)

**Runtime.** `TranslationServer` for UI strings — one `ui.csv` with a column per locale
(`key, zh_HK, zh_CN, en`) imported as translations — and `ContentDB` for entity strings
(§5.8). The locale lives in `Settings` and is offered on first launch *in its own script*
(粵語 / 简体中文 / English) plus "follow browser". Web builds get `navigator.language` (`zh-HK`,
`zh-CN`); normalize `-`→`_`, map `zh_TW`/`zh_MO` → `zh_HK`, anything unrecognised → `en`.

Fallback chain: **`zh_HK` → `zh_CN` → `en`**. Falling from Cantonese to the other Chinese
variant is readable; falling to English is not. Validation should make the chain unreachable for
authored content — it exists for LLM output and for freshly published content.

**Fonts are the real risk, for one reason: LLM dialogue is open-vocabulary.** You cannot subset
a CJK font down to the glyphs in your authored content, because the model can emit any character
the player provokes. So:

| Need | Choice | Budget |
|------|--------|--------|
| Latin UI + English body | covered by the CJK faces themselves (they include ASCII) | — |
| **CJK body + all dialogue** | **Fusion Pixel 12px monospaced**, `zh_hk` + `zh_hans` as a fallback chain | **~13.8 MB raw → 4.8 MB pck** (see deviation below) |

**As built (P2):** `fusion-pixel-12px-monospaced-zh_hk.ttf` is the default font and
`-zh_hans.ttf` is its fallback, installed at runtime in `Settings._install_theme()` with
antialiasing/hinting/subpixel positioning disabled so 12 px stays crisp at 5× scale.

**Licensing is a real trap here.** Zpix (最像素) was the obvious candidate — 4.5 MB, one file, and
it covers Cantonese — but its licence is **USD $1000 per commercial product** (free for
education only), so shipping it would have been unlicensed use. It was removed. Fusion Pixel is
**OFL 1.1** with licence files bundled in `client/assets/fonts/`. Check the licence before
swapping in any pixel CJK face.

**Deviation from the 4 MB line above:** two faces were needed (Traditional/HKSCS for `zh_HK`,
Simplified for `zh_CN`) and the union is 13.8 MB raw. The budget was optimistic because this row
assumed one all-CJK file; the real options were a single-face font with incomplete coverage or
two faces with complete coverage. Two faces won, `index.pck` is 4.8 MB, and the pck is compressed
over the wire anyway (§10.2). Verify coverage with `python3 tools/check_font_coverage.py`.

Evaluate in P1, on coverage first and legibility at 12 px second: Zpix, Fusion Pixel 12px,
Cubic 11. **Gate the choice on a test string of Cantonese-specific characters** — 嘅 咗 喺 哋 嗰
冇 嘢 嚟 咁 佢 — rendered at final size before anything else is built on top of it.

Three details that otherwise cost a day each:

- **Lay out for CJK metrics, not Latin.** CJK needs ≥12 px to be legible, with ~14–16 px
  leading, while English at 8 px needs less. Set line spacing per font and test the *longest*
  string in every UI element: each Chinese glyph is a full square, so a 7-character English
  button label becomes a 7-glyph Chinese one at roughly **2× the width**. Buttons, quest-log
  rows and inventory labels break here first.
- **Missing-glyph detector, dev builds only.** Probe `Font.has_char()` on every rendered string
  and every LLM reply, and log the codepoint of anything missing. Then extend a supplementary
  subset. Without this, a rare character ships as a blank box and nobody notices until a player
  screenshots it.
- **Never bundle full Noto Sans CJK** (~15–20 MB per weight). It alone would consume the entire
  §10.4 download budget — a pixel font is both smaller and stylistically correct.

The font budget is a **hard line** in §10.4: if the CJK font exceeds 4 MB, the answer is a
smaller font, not a bigger budget.

---

## 7. LLM conversation design

### 7.1 Protocol

`POST /v1/session` → `{session_token, budget, model}` (anonymous, rate-limited per IP).
`WSS /v1/chat?token=…` → JSON frames:

```
C→S {"type":"start","npc_id":"npc_chan_kowloon_1955","location":"loc_kowloon_street",
     "state":{...sanitized flags/vars/items...},"lang":"zh_HK"}
S→C {"type":"token","t":"後生仔…"}          ← append to the typewriter
S→C {"type":"done","actions":[…],"usage":{…},"cost_usd":0.00021,"truncated":false}
S→C {"type":"error","code":"upstream_timeout"}   ← client falls back to scripted lines
```

The client sends a **sanitized projection** of state (flags relevant to that NPC's
knowledge, current quest node title, inventory names) — never the whole save.

**Gotcha worth knowing (found in P2 testing):** the server sends the `done` frame and closes the
socket in the same tick, so a client that inspects `WebSocketPeer.get_ready_state()` *before*
draining buffered packets discards a perfectly good reply and falls back. Drain first, then judge
the state (`Net._process`). This turned every successful turn into a fallback until it was fixed,
and it fails silently — the player just sees scripted lines.

### 7.2 Prompt assembly (order = cache strategy)

```
[1] ROLE          persona.role + voice + wants + taboos            ─┐
[2] WORLD RULES   "You are a character in a game. You may only    │ STABLE PREFIX
                  state facts present in LORE. If unknown, deflect  │ (cached;
                  in character. Never mention being an AI/model."   │ 50× cheaper)
[3] LORE          lore/<era>.md digest + the NPC's knowledge_tags ─┘
[4] OUTPUT SPEC   JSON schema for {say, mood, actions[]}
[5] SECRETS       only those whose reveal_if currently passes
[6] STATE         flags/vars/items/quest objective, available items, lang
[7] HISTORY       last N turns (rolling; older turns → 1-line summary)
[8] INPUT         player line
```

Stable blocks are byte-identical between turns, so the provider cache-read price
($0.003/M) applies to everything except [5]–[8]. Volatile content is deliberately tiny.

### 7.3 Structured output, and why actions are safe

The model must return (enforced with `response_format: json_schema` +
`structured_outputs`, which this model advertises):

```json
{ "say": "後生仔，你手上嗰張相…",
  "mood": "wistful",
  "actions": [ { "type": "give", "item": "item_old_photo" } ] }
```

Pipeline per turn: **stream** → extract the partial `say` string for display (partial-JSON
scan; no need to wait for the full object to start typing) → on completion **validate**
every action against the NPC's `llm` allowlist → apply survivors through `Effects` on the
client (the client is authoritative for its own state; the server only *advises*) → drop
and log rejects with a counter so you can see model drift without exposing it to players.

If streaming JSON proves flaky, the documented fallback is: stream plain prose, then a
fenced ```` ```actions ```` block appended at the end which the client parses and strips
before display. Decide this with a spike in phase 2, not up front.

### 7.4 Memory, greeting prefetch, fallback

- **Per-NPC memory**: last 12 turns verbatim + 1-line rolling summary, stored in the save.
  Cross-NPC memory is **not** automatic — it is a *lore flag* ("the player helped Chan"), so
  information sharing is authored, not emergent.
- **Greeting prefetch**: when the player enters an NPC's interact radius, fire a
  `start` with `prefetch: true` so the first line is already streaming by the time the
  dialogue box opens. Removes the single worst perceived-latency moment.
- **Fallback ladder (as built)**: connect deadline 4 s → first-token deadline 9 s → turn
  deadline 30 s → `scripted_fallback.lines`. The 2.5 s figure this plan originally assumed was
  wrong: a real cold turn measured **3.11 s to first token** (zh_HK), so a 2.5 s budget would
  have fired the fallback on a healthy start. Warm turns measured 1.30 s. The game is always
  playable offline; the LLM is an amplifier, not a dependency.
- **`stop`-token discipline**: `max_tokens: 320`, `stop: ["\n\n\n"]`, temperature 0.85, and
  a hard server-side cap; long-winded NPCs are the main cost/latency risk.

### 7.5 Cost model (measured prices)

Per turn ≈ 1,900 prompt tokens (≈1,700 cached) + 200 completion
≈ 0.0003 + 0.00003 + 0.00012 ≈ **$0.00045**. A 60-turn play session ≈ **$0.03**.
A full 6-chapter playthrough with heavy talking lands around **$0.15–0.25 per player**.
Guards: per-session token budget (server enforced, default 60k), per-IP daily cap, and a
`BUDGET_EXCEEDED` frame that silently switches NPCs to scripted mode.

Art: an NPC sprite sheet + portrait + 3 props ≈ 6 images ≈ **$0.11**. A whole chapter's
art (≈60 images) ≈ **$1.10**, and reruns are only paid on demand.

### 7.6 Content guardrails: the past and the present

A chapter set in 1955 and a chapter set in 2027 need different rules, because the second one
can be *checked* against today's world and touches living people and live disputes.

**Both kinds of chapter:**

- NPCs speak from **authored lore**; the prompt forbids inventing dates, names, deaths, or
  events not in `LORE`. Unverifiable claims are answered evasively in character.
- Admin runs an optional **fact-check pass**: a second cheap call that scores each NPC line
  against the lore block and flags contradictions for human review.
- Every chapter gets a one-page `lore/*.md` with sources listed; that file is the single
  point where accuracy is reviewed by a human.

**Historical chapters (2–5):** only assert what `LORE` contains. The scope is
**daily life, work, migration, food, industry, family, language** — lived experience rather
than contemporary political dispute. That is a craft choice as much as a safety one: it is
what makes the story durable, and it is what a grandmother's story can actually support.

**The 2027 chapter — "real streets, fictional people":**

- **Geography is real and verifiable** (Pei Ho Street, Apliu Street, MTR exit letters, building
  types). **Every character is invented.** NPCs never claim to be, or to know, a real living
  person, and never state facts about named real businesses, institutions, or officials beyond
  what `lore/ch01_hk_2027.md` records.
- **Every conflict in the game is personal, not institutional**: a family deciding what to
  keep, an owner retiring, a letter that was never sent. This keeps the modern chapter's
  stakes legible to any player and keeps the LLM away from terrain where it would be both
  factually unreliable and inappropriate.
- Modern NPCs carry explicit `taboos` in their persona (§5.1) plus one shared instruction:
  *if the player steers toward current affairs or asks you to take a side, deflect in
  character and return to your own life.* The deflection is a **persona gambit** — 根叔
  changes the subject to his bird, 陳太 to the price of milk tea — so it reads as character
  rather than as a refusal.
- Optional hardening for this chapter only: a cheap classifier call flagging a session for
  human review in admin. Flag for review; **never** rewrite the player's words back at them.

### 7.7 Multilingual generation

The session carries `lang` ∈ {`zh_HK`, `zh_CN`, `en`} — the language of the **reply and the
UI**, independent of what the player types. A player whose UI is Cantonese may type English;
the NPC keeps speaking Cantonese. The mode changes only when the player asks for it, and the
choice persists in `Settings`.

Register is a prompt instruction, not a hope:

| `lang` | Instruction |
|--------|-------------|
| `zh_HK` | Written Cantonese (粵文), Traditional glyphs. Use 係/唔/咗/嘅/喺/哋 naturally. **Never** drift into Mandarin written form. |
| `zh_CN` | Simplified glyphs, standard written Chinese (書面語). **Never** use Cantonese particles. |
| `en` | English, same voice. |

Written Cantonese is far under-represented in training data relative to Mandarin, so **`zh_HK`
gets 3–4 few-shot exemplar lines inside the cached prefix** (§7.2 [1]), quoted from that
character's own approved scripted lines. This is the highest-leverage quality lever for the
Cantonese voice, and it is free at runtime because it sits in the stable block.

Two smaller consequences: Chinese is **denser per token** (~1–2 chars/token vs ~4 for English),
so a 320-token cap reads as noticeably shorter in English than in Chinese — set `max_tokens` per
locale. And `mood`/action types stay **English enum values** in every locale; only `say` is
localized, which keeps the action validator locale-independent.

---

## 8. Pixel-art asset pipeline (Seedream → game-ready sprites)

Seedream renders *illustration*, not *pixel art*. Left raw, a 1K render downscaled to 32 px
becomes mud. The pipeline below is what turns model output into usable game art; it is
roughly 250 lines of Pillow and is the highest-leverage piece of tooling in this project.

```
admin prompt ──► POST /v1/images (seedream-5-0-flash, 1K, background:transparent, seed)
                        │  b64_json + usage.cost + seed
                        ▼
              ┌──────── post-process (server/app/assets) ────────┐
              │ 1 crop to subject bounding box (alpha trim)      │
              │ 2 land on a **fixed palette** (project palette,  │
              │   24–32 colours, ordered dithering optional)     │
              │ 3 downscale with NEAREST to target size          │
              │ 4 clean: 1px alpha threshold, kill stray pixels, │
              │   force 1px dark outline for readability at 24px │
              │ 5 dedupe/align into a sheet OR brick on a grid   │
              └──────────────────────────────────────────────────┘
                        │  PNG + provenance JSON
                        ▼
         content-src/art/…  ← review in admin diff view → accept → publish pack
```

### 8.1 Parameter choices (from the verified capability list)

| Field | Value | Reason |
|-------|-------|--------|
| `model` | `bytedance-seed/seedream-5-0-flash` | $0.018/image; fast enough for interactive authoring |
| `resolution` | `1K` | 2K costs more and buys nothing after downscaling to 32 px |
| `background` | `transparent` | Removes the most fragile post-process step (matting) |
| `aspect_ratio` | `1:1` sprites/props, `16:9` backdrops, `3:4` portraits | Matches target frames |
| `seed` | recorded and reused | Reproducibility: same prompt+seed+palette = same asset |
| `input_references` | 1–14 | **The consistency mechanism** — see below |

### 8.2 Consistency across a cast (the actual hard problem)

Pixel-art NPCs must look like they inhabit one world. Three levers, in order of impact:

1. **Style bible reference**: one approved "master style" image — authored as a **2027 Sham
   Shui Po street scene** with 3 characters at final palette, since that is chapter 1 (§12) —
   is passed as `input_references[0]` for *every* generation, historical chapters included.
   It is what makes a 1955 hawker and a 2027 delivery rider look like they were drawn by the
   same hand.
2. **Character turnarounds**: generate a character once, approve it, then pass that image
   as a reference when generating its walk frames / other emotions / portrait — this keeps
   the same face, clothing, and palette without retraining anything.
3. **Fixed palette + seed**: post-processing onto the project palette is what visually
   binds images made minutes apart.

The style bible is authored once (a few paid generations + human curation) and then
versioned — treat it as a content asset with an id, and record it in every provenance file.

### 8.3 Prompt templates (stored as data, editable in admin)

```
sprite:  "pixel art sprite of {desc}, {palette_name} palette, 24px tile scale,
          side/front view, T-pose-adjacent stance, flat cel shading, no outline glow,
          no text, plain transparent background, posterized 4 shades per hue"
prop:    "pixel art {desc}, isometric-free flat top-down-RPG style, {palette_name} palette,
          24px scale, single object, transparent background, no shadow baked in"
backdrop:"pixel art top-down street scene of {desc}, {era}, 16:9, muted {palette_name}
          palette, walkable ground plane, no characters, no text, no UI"
portrait:"pixel art bust portrait of {desc}, {emotion}, facing viewer, transparent
          background, {palette_name} palette, 96x128 framing"
```

Negative-style instructions go in the prompt text (the image endpoint takes no
`negative_prompt` param here) and the post-processor enforces the rest mechanically.

### 8.4 Provenance and reproducibility

Every accepted asset writes a sibling `*.gen.json`:

```json
{ "prompt_id": "gen_2026-11-16_014", "model": "bytedance-seed/seedream-5-0-flash",
  "seed": 884213, "resolution": "1K", "aspect_ratio": "1:1", "background": "transparent",
  "input_references": ["stylebible_v2.png"], "post": { "palette": "hk_palette_v1",
  "target_px": [24, 32], "outline": true, "colors": 28 }, "cost_usd": 0.018,
  "accepted_by": "human", "ts": "2026-11-16T09:12:44Z" }
```

This makes "regenerate this sprite exactly" possible months later, and it is the only
sane way to audit spend.

---

## 9. Admin mode

### 9.1 Recommendation: a browser SPA at `/admin`, not an in-game scene

| | Browser admin (recommended) | In-game admin |
|---|---|---|
| Text/persona authoring | Real textareas, keyboard shortcuts, spellcheck | Miserable on a gamepad/on-screen keyboard |
| Image review | Side-by-side before/after, diff, zoom, accept/reject | Possible but cramped |
| Validation UX | Inline schema errors, jump-to-error, dependency graph | Hard |
| Publishing | One click → pack version bump | Needs re-export |
| Cost | ~1–2 days of SPA work | Higher |
| Placement work | Weak — needs a Godot-side helper | Strong |

The SPA wins because **content authoring is text and images**, while the one thing the game
client is good at — placing NPCs on a map — is handled by a small Godot **editor plugin**
(`@tool` `EditorPlugin`, phase 5+) that writes `npcs[].pos` back into the location JSON. The
admin SPA then just reads those positions. Best of both, no duplicated effort.

### 9.2 Admin features

- **CRUD** for NPCs, items, locations (metadata), quests, lore files — form-driven with a
  raw-JSON tab; every form field maps to §5 schemas.
- **Locale tabs** on every string field — one tab per §5.8 locale, each with a completeness
  dot, and a "draft the other two from this one" button (register-aware LLM draft, explicitly
  marked *draft* until a human approves it). A per-entity parity report lists what is missing,
  `_todo`-declared, or stale relative to the canonical locale.
- **Condition builder**: clickable rule rows that emit §5.5 JSON; a live evaluator shows
  "would this pass right now, given this save?" so authors stop guessing.
- **Persona playground**: chat with the NPC draft, with the *assembled prompt*, token
  counts, cache-hit flag, latency, and cost shown per turn; "actions the model tried to
  take that were rejected" surfaced explicitly (this is how you debug allowlists).
- **Art studio**: prompt template + references + seed → generate (n) → post-process sliders
  (palette, target px, outline, dither) → live preview at 1× on a sample scene → accept.
- **Fact-check queue**: lines flagged by §7.6 for human review.
- **Publish**: run `validate` (JSON Schema + referential integrity: every referenced item /
  location / flag / scene path exists; every dialogue fallback non-empty; no orphan ids) →
  preview diff → bump `manifest.version` → serve new pack. Nothing reaches players unless it
  validates.
- **Usage dashboard**: this month's image spend, per-session chat spend, top rejected
  actions, p95 latency.

### 9.3 Auth

Single-operator model (it is a game, not a SaaS): `ADMIN_TOKEN` in the backend env, sent as
`Authorization: Bearer`, compared with `secrets.compare_digest`, admin routes rate-limited
and additionally bound to an allowlisted IP in production if desired. No user accounts, no
password database, no session store to leak. Admin routes are the only place that can read
the OpenRouter key's effects, so they never accept a model id or URL from the client —
**model slugs are server-side constants.**

---

## 10. Web deployment

### 10.1 Export templates (installed in P0)

Done, with one deliberate deviation from the editor flow. The official artifact is
`Godot_v4.7.2-stable_export_templates.tpz` — **1.28 GB**, containing ~90 platform binaries for
every target Godot supports. Extracting all of it and then moving it costs minutes and fills
the disk for platforms this project will never ship. So P0 installed only what the web export
needs:

```
TPZ=~/Downloads/Godot_v4.7.2-stable_export_templates.tpz
DEST="$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable"
mkdir -p "$DEST"
unzip -o -j -q "$TPZ" \
  "templates/version.txt" \
  "templates/web_nothreads_release.zip" \
  "templates/web_nothreads_debug.zip" -d "$DEST"
```

The directory name must match the version string exactly (`4.7.2.stable`), and `version.txt`
must read `4.7.2.stable` — Godot validates both. If you later want another platform, extract
its zips from the same tpz; the editor's *Manage Export Templates* dialog is equivalent if you
prefer clicking.

Verify with `tools/export_web.sh`; if templates are missing it fails immediately with a clear
message rather than a confusing export error.

### 10.2 Export configuration

`client/export_presets.cfg` — preset **Web**, `variant/thread_support=false` (so no
`crossOriginIsolated` headers are needed), `vram_texture_compression` off for pixel art,
`html/canvas_resize_policy=2` (adaptive), custom HTML shell with a loading bar, a
"click/tap to start" gate (required for audio autoplay policy), and a `head.html` that sets
`<meta viewport>` for mobile.

```
godot --headless --path client --export-release "Web" ../build/web/index.html
```

Brotli/gzip pre-compress the `.wasm`/`.pck` in the build script; that is usually a 3–4×
transfer reduction.

### 10.3 Hosting split

| Piece | Host | Notes |
|-------|------|-------|
| Client (static) | Cloudflare Pages (or Netlify/GH Pages) | `_headers`: `Cache-Control: immutable` on hashed assets, `no-cache` on `index.html`; brotli; long CDN cache on art. |
| Backend (FastAPI) | Fly.io / Render / Cloud Run / single VPS+Caddy | Needs WebSocket support and a persistent process. Cloudflare Workers is *not* an option for a Python backend. |
| Secrets | backend env only | `OPENROUTER_API_KEY`, `ADMIN_TOKEN`, `ALLOWED_ORIGINS`. Never in `client/`, never in `export_presets.cfg`. |
| Content pack | served by backend (or R2/S3 + signed URLs later) | Cache-busted by `manifest.version`. |

Cross-origin specifics: CORS allowlist for `https://<client-origin>`; the page is `https`
so the socket must be `wss`; WebSocket connections are not CORS-checked, so the backend must
verify `Origin` itself on upgrade.

### 10.4 Build size & performance budget

| Metric | Budget |
|--------|--------|
| Initial download (br) | < 25 MB (Godot web baseline is ~10–15 MB; be disciplined about audio) |
| Time to interactive (4G) | < 8 s |
| Frame time, mid-tier phone | 16.6 ms — one `TileMapLayer` per map, no per-tile nodes, ≤120 draw calls |
| Memory | < 300 MB (iOS Safari is the constraint, not desktop) |
| Audio | OGG loops, streamed where possible; total < 8 MB |
| CJK pixel font | ≤ 4 MB compressed (§6.5) — the one asset that cannot be subset, because LLM dialogue is open-vocabulary |
| Atlas strategy | NPC sheets + props in one or two atlases per chapter; hot-pack art as small individual PNGs |

### 10.5 CI/CD

GitHub Actions, two workflows:

- `client.yml` — on push to `main`: install templates cache → `check_content.py` → headless
  export → brotli → deploy Pages. (Cache the templates directory between runs.)
- `server.yml` — pytest + Docker build → deploy to Fly/Render. Admin SPA built with
  `bun install --frozen-lockfile && bun run build` (Vite) into `server/admin/` in the same job.

Content-only publishes bypass both: they go through the admin's publish endpoint and reach
players on next boot.

### 10.6 Toolchains: Python 3.15.2 and bun 1.4.4

The backend targets **exactly CPython 3.15.2** — not `>=3.15`, and not the free-threaded
build. Six layers pin it, so nothing in the toolchain can drift:

| Layer | File / command | Value |
|-------|----------------|-------|
| Interpreter selector | `.python-version` (repo root) | `3.15.2` |
| Package metadata | `server/pyproject.toml` | `requires-python = "==3.15.2"` |
| Lockfile | `server/uv.lock` (committed) | `uv sync --frozen` everywhere it matters |
| Local dev | `uv python pin 3.15.2` → `uv sync` | resolves to `~/.local/share/uv/python/cpython-3.15.2-…` |
| Container | `deploy/Dockerfile` | `FROM python:3.15.2-slim` (tag verified to exist) |
| CI | `.github/workflows/server.yml` | `astral-sh/setup-uv` + `uv sync --frozen`, then assert `python -VV` starts with `3.15.2` |

Four things that will bite otherwise:

- **This machine's system `python3` is 3.9.6** — six minor versions behind the lock. Anything
  that reaches for `python3` out of habit (a bare `pytest`, an IDE default interpreter, a
  hand-written Makefile) silently runs the wrong interpreter and produces confusing
  `SyntaxError`/`ImportError` noise instead of a clear version failure. Run everything through
  `uv run …`, and keep the CI `python -VV` assertion so a mismatch fails loudly.
- **Use the GIL build, not `3.15.2+freethreaded`.** The free-threaded ABI has distinct wheel
  tags and is where native dependencies lag first — Pillow and `pydantic-core` are the likely
  casualties, and both are load-bearing here. Nothing in this design needs no-GIL: the
  workload is IO-bound (streaming tokens, HTTP, disk) and asyncio already covers the
  concurrency. Revisit only if profiling asks for it.
- **An exact patch pin means security bumps are manual.** 3.15.3+ will appear; adopting it is
  a reviewed PR touching `.python-version`, the image tag and `requires-python` — not an
  automatic nightly. That reproducibility is what you are buying, but put a calendar reminder
  near 3.15's EOL (**2031-10**) so the lock does not quietly become a liability.
- **Wheels are the real risk with a fresh interpreter.** `uv sync` must succeed for the whole
  dependency set on 3.15.2 *before* P2 starts — a missing 3.15 wheel then is a build error on
  day one rather than a runtime surprise in production. If one package blocks, pin that
  package lower or replace it; do **not** relax the interpreter pin.

**Frontend: bun, pinned the same way.** The admin SPA uses **bun 1.4.4** as its only package
manager — no npm, no pnpm, no yarn, and no lockfile from any of them in the repo.

| Layer | File / command | Value |
|-------|----------------|-------|
| Declared selector | `admin/package.json` → `"packageManager": "bun@1.4.4"` | documents intent; bun does **not** auto-switch on it, so the CI assertion and image tag do the enforcing |
| Lockfile | `admin/bun.lock` (text, committed) | `bun install --frozen-lockfile` everywhere it matters |
| Local dev | `bun install` · `bun run build` · `bun test` | resolves to `~/.bun/bin/bun` (1.4.4 present) |
| Container | build stage `FROM oven/bun:1.4.4-slim` | tag verified to exist |
| CI | `oven-sh/setup-bun` → `bun install --frozen-lockfile` → `bun run build` | assert `bun --version` is `1.4.4` |

Two gotchas: an **nvm-managed Node 26.13.1 is also on this machine**, so a stray `npm install`
or `npx` will cheerfully build a second dependency tree and drop a `package-lock.json` beside the
bun lockfile — add a CI check that fails if `package-lock.json`, `yarn.lock`, or
`pnpm-lock.yaml` exists in `admin/`. And use the text `bun.lock`, not the legacy binary
`bun.lockb`, so lockfile changes are reviewable in a PR.

---

## 11. Testing & QA

| Layer | Tool | What it must cover |
|-------|------|--------------------|
| Content | `jsonschema` + a referential-integrity pass | Every id resolves; every flag referenced by a condition is settable by something; no unreachable quest node; every NPC has non-empty scripted fallback |
| Conditions/Effects | GDScript unit tests (GUT or gdUnit4) + mirrored Python tests | The two evaluators must agree on a shared fixture table — divergence here is a silent save-corrupting bug |
| Prompt assembly | pytest golden files | Cache prefix is byte-stable across turns (assert this, or caching silently stops paying) |
| Locale parity | `validate` + CI | Every localized field has all three locales or an explicit `_todo`; no blank cells in `ui.csv`; **no Cantonese particles in `zh_CN`** (regex spot-check for 嘅 咗 喺 哋 嗰 冇 嘢) — that catches a `zh_HK` string pasted into the wrong tab |
| Font coverage | pytest + GDScript | Every authored character **and** every character in a captured corpus of real LLM replies resolves via `Font.has_char()`; fails on anything that would ship as a blank box |
| Admin SPA | `bun test` | The condition builder emits exactly the §5.5 JSON the GDScript and Python evaluators both accept; locale tabs refuse a field missing a locale |
| Chat protocol | pytest + `respx` mock of OpenRouter | Timeout → fallback; malformed JSON → scripted; action outside allowlist → rejected and logged; budget exhaustion → scripted |
| Client loop | `client/tests/selftest.gd` (`godot --headless --path client -- --selftest`, exit code = failures) | 36 assertions: content loading, three-locale resolution, effects + stack_max, every condition verb, save round-trip, and door gating across a location rebuild. **gdUnit4 deferred to P2** — these assertions port over directly. |
| E2E smoke | `tools/web_smoke.mjs` (Chrome + CDP, no dependencies) | `talk` mode injects real key events, walks to an NPC and presses E, then reports the game's `[Dialogue]` log line plus a screenshot — so it distinguishes "the model answered" from "the fallback answered". Exits non-zero on any unexpected console error. Verified both online and with the backend killed. |
| Backend | `pytest` (44 tests) | Prompt-prefix stability, streaming extractors (split escapes, `\uXXXX`, partial fence), allowlist rejections, budget refusal **before** spend, every WS error frame, health payload never containing the key. |
| Conditions parity | `client/tests/fixtures/conditions.json` read by **both** suites | The GDScript and Python evaluators are checked against one table, which is the contract that keeps them from diverging. |
| Manual | checklist per chapter | 60 fps on a real phone, readable text at 384×216, offline mode (kill wifi → game still plays) |

The one test that will actually save the project: **kill the backend and play a full
chapter**. If that is not fun, the LLM is carrying a game that has no skeleton.

---

## 12. Milestones

Sized for one developer. Each phase has an exit criterion that is *observable*, not
"feels done".

| Phase | Deliverable | Exit criterion |
|-------|-------------|----------------|
| **P0 — Skeleton** ✅ *(done)* | git repo, `client/` project with the §6.1 settings, 10 autoloads, asset-free test room + walkable player, `tools/export_web.sh`, `tools/web_smoke.mjs`, web templates installed, `build/web` produced | ✅ boots in a real browser (headless Chrome + CDP): canvas live, **0 console errors**, scene colours rendered. ⏳ 60 fps on a physical phone still unmeasured — the HUD prints live FPS and the procedure is in README "Tests"; ✅ brotli pre-compression active: `tools/export_web.sh` writes `.br` sidecars and `tools/serve_web.py` serves them with `Content-Encoding: br` (sizes unmeasured until the next real export) |
| **P1 — Core loop** ✅ *(done)* | Walkable player with animation state, JSON-built `TileMapLayer` location + collision, interactables, condition-gated door, inventory UI with three-locale item names, flag/item/variable effects, autosaved slots with boot restore, F1 command console, `--selftest` harness | ✅ `--selftest` 36/36, exit 0. ✅ In-browser: 0 console errors, `[ContentDB] loaded 2 entities` in the wasm logs, tiled room renders from the generated atlas. ⏳ Only one location exists, so exits/location-switching is coded but unexercised; ⏳ no NPCs or dialogue until P2 |
| **P2 — Conversation** ✅ *(done)* | FastAPI backend on CPython 3.15.2, `/v1/session` + `/v1/chat` WS streaming with json_schema mode, prompt assembly with a byte-stable cache prefix, per-NPC action allowlist, per-session budget, three-locale NPC content, client `Net`/`Dialogue`/DialogueUI/NPC node, greeting prefetch, scripted fallback ladder | ✅ 44 pytest + 65 client checks pass. ✅ Live: two real turns (zh_HK and en) through the backend. ✅ In-engine: `--live-chat` 6/6. ✅ In-browser (CDP key injection): walked to the NPC, pressed E, got a model reply; with the backend killed, the same run used scripted lines — **0 unexpected console errors in both**. ⏳ Cache-hit *telemetry* is not wired (prefix stability is asserted by test instead); ⏳ first token measured 3.11 s cold vs the 1.5 s this row hoped for |
| **P3 — Story engine** ✅ *(built; suite run + playtest pending)* | ✅ Condition/Effect interpreters (both languages, shared fixtures), quest node machine + cutscene overlay, NPC presence triggers, chapter 1 content: 5 NPCs, 8 items, 3 locations, 1 complete arc | ⏳ a player who has never seen the game can finish chapter 1 and cannot break it: content is authored so every objective is reachable and no single NPC dead-ends the arc (offline fallback lines carry the key handover and the album identification); still needs the `--selftest`/`pytest` run on a toolchain machine and a human playtest |
| **P4 — Admin + art** ✅ *(built; live-verified server-side)* | ✅ Admin API (bearer auth, drafts, validate, publish preview) + content validator (CLI: `tools/check_content.py`), hot-pack serving + client hot-load (§5.7), Seedream → palette/outline post-processor → provenance (§8), admin SPA at `/admin` (bun + Vite, four views: editor / persona playground with real usage + cache telemetry / condition builder with live evaluation / fact-check queue + usage dashboard — §9.2) | ⏳ author a new NPC end-to-end **without opening Godot** — generate sprite, set persona, wire a trigger, publish — and it appears in the running web build after a reload: server-side chain live-verified 2026-11-17 (style bible + a cast sprite generated from it via `input_references`, wired through the real draft→publish loop → content v2 served; real playground turn 729 tok / $0.00016 / 2.6 s; cache hits vary with routing — 60%/0%/76%; 74 pytest in an ephemeral 3.14 env). Remaining: a pinned-3.15.2 pytest run — the browser half is verified (2026-11-17: templates installed on the Windows side, export produced, smoke passed boot / backend-up / backend-down with Playwright Chromium + SwiftShader) |
| **P5 — Chapters & polish** ✅ *(complete; phone play + gdUnit4 remain)* | ✅ Chapters 2–5 content (1955 Kowloon, 1963 mill/rationing, 1979 Kai Tak, 1996 the unsent letter — lore + 2 locations + 3 NPCs each; memento doors chained album→ch02→cassette→ch03→tram→ch04→letter→ch05→return), save-code export (§6.4), Audio autoload + five synthesized ambience beds, touch controls, the NPC-placement editor plugin (§9.1); fact-check queue shipped with §9.2; zh_HK/en parity enforced by the validator; `--selftest` 119/0 on a Windows 4.7.2 build via WSL interop | ⏳ 30 minutes of play on a real phone without a crash; both languages complete for shipped chapters (validator-enforced); remaining: the gdUnit4 port, chapter 6 (the 2027 finale — P5+ content), real recordings for the ambience |
| **P6 — Ship** *(2–3 d)* | Cost caps, error telemetry (counts only, no PII), privacy note, credits/licensing page, "session budget exhausted" UX, soft launch | Public URL; per-player cost within budget; a broken upstream degrades to offline mode instead of a white screen |

Rough total to a *playable, shareable vertical slice*: **~2 weeks**. To a 3-chapter game:
**~4–5 weeks**.

### 12.1 Chapter arc: 2027 is the hub, history is the journey

**Decision: Chapter 1 is present-day Hong Kong, 2027.** The player starts in a world they
recognise and travels *backward* into the historical chapters. This is better than opening
in the past for four reasons:

1. **No tutorial for the setting.** The player already knows what an MTR exit, a wet market,
   and a cha chaan teng are, so all the teaching budget goes to *mechanics* — walk, interact,
   talk, collect.
2. **Contrast is the payload.** A street in 2027 makes a 1950s street mean something. Opened
   chronologically, the reverse never happens.
3. **Cheapest art to keep consistent.** Modern urban tiles are the most forgiving to generate
   and the most reusable (footbridges, air-con boxes, signboards, trams). §8.2's style bible
   is authored for this chapter first.
4. **It supplies a diegetic device for every later era** — one that needs *zero* engine work.

**The device: a memento is a chapter door.** In 2027 the player is clearing the flat above a
family shop that is shutting down. A box of objects is the spine of the game. Talking to
people tells you *what* an object is; holding a recognised object opens the era it came from.
This reuses the item system, the quest engine, and the condition DSL exactly as specced in
§5 — a memento is just an item whose `on_use` is `{"type":"quest","op":"start"}` plus one
transition scene. **No new subsystem, no timeline system, no save format change.**

| Ch. | Era / place | Texture | Player goal |
|-----|-------------|---------|-------------|
| **1** | **2027, Sham Shui Po** | Wet market, Apliu Street, tong lau, MTR exit, cha chaan teng | Learn the loop; get into the flat; assemble the box (6 mementos) |
| 2 | 1950s Kowloon market & squatter huts | Hawkers, rationing, fire memory | How the shop was founded — and who was lost |
| 3 | 1960s factory floor & water rationing | Textile machines, queues at standpipes | Who the family worked for, and what it cost |
| 4 | 1970s–80s Kai Tak & industry | Planes over rooftops, piecework at home | The generation that moved up |
| 5 | 1990s handover-era neighbourhood | Shops closing, letters unsent | The letter that never arrived |
| 6 | 2027, the same street | Your chapter-1 assets, changed | Deliver the last story; decide what the box is for |

Chapter 6 **reuses chapter 1's tilesets and props**, so the finale of the whole game costs
almost nothing in art — and the player walks the same street with different eyes. That
bookend is the single best return on content spend in this plan.

**On "2027":** one year out, so no science fiction. Plausible only — cashless everywhere,
delivery riders everywhere, a phone assistant in the background — against the same trams,
markets, and stairwells. Speculative technology would be both an art-cost problem and an
unnecessary content risk; the game's friction is *memory*, not futurism.

### 12.2 Chapter 1 content spec (2027, Sham Shui Po)

**Locations (3).** `loc_ssp_market_street` (Pei Ho Street market — the hub, 4 NPCs, the shop
front), `loc_ssp_flat` (the flat above the shop — small interior, object interactions, where
the box is found), `loc_ssp_cha_chaan_teng` (2 NPCs, the information-exchange hub — where you
learn what a given object even *is*).

**Cast (5), all fictional:**

| NPC | Who | Function |
|-----|-----|----------|
| 陳太 | cha chaan teng owner, 60s; knew the player's family | Quest giver; holds the flat key behind a small favour |
| 根叔 | retiree with a bird cage, 70s; the street's memory | Gates chapter 2: he is the last person who remembers the shop's founding |
| 阿明 | delivery rider, 20s; knows everything that changed | Comic relief + the "what's different now" lens on the street |
| 阿珊 | architecture student, 20s | Diegetic lore delivery — explains the tong lau, the signboards, what redevelopment means for a building |
| 偉哥 | building caretaker, 50s | Opens the flat; one secret about the family |

**Items (8):** octopus card, flat key, tea-stained receipt, **photo album** (chapter-2 door),
cassette tape, shop sign plate, tram ticket stub, **the unsent letter** (chapter-5 door).

**Quest flow:** arrive → the shop is being emptied → convince 陳太 (a small fetch favour) →
get the key → enter the flat → find the album → bring it to 根叔 → he identifies the 1955
photograph → the album becomes usable → chapter 2 opens.

That flow deliberately exercises **one of everything**: an NPC-gated item, a condition-gated
exit, an LLM-driven `give`, a secret with a `reveal_if`, and one item whose `on_use` starts a
quest. If chapter 1 is feature-complete against §5's schemas, the engine is done.

**Art spend:** 1 modern urban tileset, 5 NPC sheets, 3 backdrops, ~10 props, 8 icons,
5 portraits ≈ **40 images ≈ $0.72**.

**Lore file:** `lore/ch01_hk_2027.md` — documents the real street (geometry, business types,
what the buildings actually are), so the fiction sits on a true map. It is a *reference
document*, not a claim about the present: see §7.6 for the rule that governs a chapter set
in the now.

Each later chapter is one `lore/*.md` + a location set + 3–5 NPCs; the engine is done by P3,
so P5+ is almost pure content — which is exactly why the admin mode deserves P4's budget.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **API key leak** | Financial, unrecoverable | Key exists only in backend env. Client calls only your proxy. Add a pre-commit/CI grep for `sk-or-` in `client/` and fail the build. |
| Upstream latency / outage | Game unplayable | Scripted fallback for every NPC (§7.4); deadlines measured rather than guessed (4 s connect / 9 s first token / 30 s turn); the browser E2E is run both online **and** with the backend killed |
| LLM invents facts (past or present) | Credibility damage on a story about real streets | Facts live in authored lore; prompt forbids invention; "real streets, fictional people" for 2027 (§7.6); fact-check queue |
| LLM drift in actions | Broken quest state | Server-side allowlist validation + reject logging + content-schema reachability tests |
| Cost surprise | Real money | Per-session token budget, per-IP daily cap, usage dashboard, `cost_usd` logged per call, alerts at thresholds |
| Save loss in browser | Player rage | `is_userfs_persisted()` notice, autosave debounce, **save-code export**, optional cloud save later |
| Web export size / iOS memory | Fails on phones | Budgets in §10.4, no long music tracks in memory, texture atlas discipline, real-device test each phase |
| Seedream art inconsistency | The "asset flip" look | Style bible reference + turnaround references + fixed palette + recorded seeds (§8.2) |
| Generated art licensing | Legal exposure | Record provenance for every asset; do not feed copyrighted historical photographs as `input_references`; keep a credits/licensing page |
| Scope creep into combat/crafting | Never ships | Pillar #1: no combat. Any new mechanic must pay for itself in *conversation* |
| Condition evaluator divergence (GDScript vs Python) | Silent corruption | Shared fixture table run by both test suites (§11) |

### 13.1 Explicitly out of scope for v1

Combat, multiplayer, voice/TTS, player-authored content, mobile app stores, cloud saves,
additional locales beyond the three in §5.8 (Japanese, Korean, Taishanese…), animated
day/night cycles, and a runtime map editor. Each is a real feature; none of them is on the
critical path to "walk, talk, collect, remember".

---

## 14. Open decisions before scaffolding

**Settled:** chapter 1 is present-day Hong Kong in 2027 — Sham Shui Po (§12.1–§12.2); the game
ships in three locales, `zh_HK` / `zh_CN` / `en` (§5.8, §6.5); backend on CPython 3.15.2 and the
SPA on bun 1.4.4 (§10.6).

Four decisions remain:

1. **Admin host** — browser SPA at `/admin` (recommended, §9.1) vs. in-game scene.
2. **Backend language/host** — FastAPI on Fly.io/Render (recommended: async WS + the Pillow
   post-processor live in one place) vs. a Node/Workers stack.
3. **Framing** — 2027 as the hub chapter with memento-opened historical chapters
   (recommended, §12.1) vs. *all* gameplay staying in 2027 with the past arriving only
   through conversation. The second is materially cheaper in art — one era of tilesets, no
   transition scenes — but gives up the thing that makes the premise distinctive.
4. **Canonical authoring locale** — which locale is the source of truth the other two are
   drafted from: **`zh_HK`** (recommended — the Cantonese voice is the game's identity and it
   is the register a model infers least reliably, so it must be written by a human first) or
   **`en`** (faster if you write English most fluently; Cantonese then becomes a draft you
   rewrite by hand, which is the bulk of the work either way).

Everything downstream of these is already decided in this document.
