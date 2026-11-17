# Hong Kong Stories

A pixel-art 2D RPG that begins in Hong Kong in 2027 and travels backward into the moments
that made it. You walk, you talk to people who remember, you collect what they leave behind.
Godot 4.7 · browser-deployed · LLM-driven NPCs.

Ships in three locales: **written Cantonese (Traditional)**, **Simplified Chinese**, and
**English** — three real versions of every string, not glyph conversion (PLAN §5.8).

**Status: P2 complete — you can hold a conversation with an NPC.** Walk to the shopkeeper, press
E, and talk: replies stream token by token in the player's language, respect a per-NPC action
allowlist, and fall back to authored scripted lines when the backend is unreachable.

## Quick start

Two processes. The backend owns the OpenRouter key; the game never sees it (PLAN §3).

```bash
# terminal 1 — backend (reads OPENROUTER_API_KEY from .env)
cd server && uv sync && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# terminal 2 — game
python3 tools/gen_content_manifest.py                # after ANY content JSON change
tools/export_web.sh                                  # → build/web/
python3 tools/serve_web.py 8099                      # → http://127.0.0.1:8099/ (no-store)
```

Use `tools/serve_web.py`, not `python3 -m http.server`: the latter sends no `Cache-Control`, so
Chrome will keep serving a stale `index.pck` after a re-export — which looks exactly like a
broken build. That cost a debugging detour once already. The HUD also prints a small build stamp
(`p2-font-2`) in the bottom-right corner, so "which build am I looking at?" is answerable on sight.

Or open `client/project.godot` in Godot 4.7.2 and press F5 (it talks to `127.0.0.1:8000` by
default; `HK_STORIES_API` overrides it for a desktop run).

**Controls:** WASD / arrows to walk · **E** interact or talk · type in the box and **Enter** to
speak · **Esc** leave the conversation · **I** inventory · **F1** dev console.

## Tests

```bash
cd server && uv run pytest                                  # backend tests
godot --headless --path client -- --selftest                # client checks (offline)
godot --headless --path client -- --live-chat               # checks (needs the backend)
python3 tools/check_font_coverage.py                        # CJK glyph coverage gate
python3 tools/check_content.py                              # content validator (publish/CI gate)
node tools/web_smoke.mjs http://127.0.0.1:8099/ /tmp/s.png 12000 talk   # browser E2E
```

`web_smoke` in `talk` mode injects real key events over CDP, walks to the NPC, presses E, and
reports the game's `[Dialogue]` line — so it distinguishes *the model answered* from *the
fallback answered*, and exits non-zero on any unexpected console error. Run it once with the
backend up and once with it stopped.

### On a real phone (the open P0 criterion)

The HUD's top-left readout prints live FPS, so the check is a measurement, not an eyeball:

1. `tools/export_web.sh` (`.br` sidecars appear when the `brotli` CLI is on PATH) then
   `python3 tools/serve_web.py 8099 build/web 0.0.0.0` — the third argument binds the LAN;
   omit it to stay on 127.0.0.1.
2. Phone on the same Wi-Fi: open `http://<machine-LAN-IP>:8099/`. Android over USB instead:
   keep 127.0.0.1 and run `adb reverse tcp:8099 tcp:8099`, then open `http://127.0.0.1:8099/`.
3. Walk, open a dialogue, open the inventory — read the HUD FPS in each state. Target: ≥60
   throughout (§10.4 budgets 16.6 ms per frame on a mid-tier phone).
4. If a reading dips: Android `chrome://inspect` over USB shows exact frame timings; iOS via
   Safari → Develop → the phone.
5. Finish with Wi-Fi off — the session must keep running on baseline content + scripted
   fallback (§11's "the one test that will actually save the project").

## Verified in P2

| Check | Result |
|-------|--------|
| `pytest` | **44 passed** — prefix stability, extractors, allowlist, budget, every error frame |
| `--selftest` | **65 checks, 0 failures** — includes the shared conditions table and font coverage |
| Live backend turn (zh_HK) | first token **3.11 s**, reply `幾耐？我都冇認真數過喇。淨係知貨架越賣越空…` |
| Live backend turn (en) | first token **1.30 s**, proper English voice |
| In-engine `--live-chat` | 6/6 — session, streaming, budget charged, no fallback |
| Browser, backend **up** | walked + talked → `咁靜嘅？淨係望住我，係咪想買嘢又唔知點開口呀？`, 0 errors |
| Browser, backend **down** | same run → `後生仔，隨便睇。 (fallback)`, 0 unexpected errors |
| Build | `index.wasm` 38 MB · `index.pck` 4.8 MB (fonts included) |

## Status: P3 — story engine built, suite runs pending

Chapter 1 plays end to end on the engine side: the quest node machine (`Quests` autoload,
signal-driven, no polling), a minimal cutscene overlay, NPC presence gating, walk-in exits
(§5.3), three new condition verbs (`quest_state` / `quest_done` / `time_of_day`), seven new
effect verbs (`quest` / `goto` / `reveal_secret` / `open_shop` / `play_sfx` / `shake` /
`fade`), and offline-safe fallback lines that can drive the quest (`scripted_fallback` lines
may now be `{text, requires, actions}` — the offline path can hand over the flat key and
identify the album, so the chapter never dead-ends with the backend down).

Verified on this machine: all 36 content entities parse, carry three locales, and contain
no Cantonese particles in `zh_CN` (§11 spot-check); the shared condition fixtures pass
through the Python evaluator (30/30); the font-coverage gate passes — every authored
character is renderable. The Godot `--selftest` suite now RUNS on this machine (a Windows
4.7.2 build driven through WSL interop): **111 checks, 0 failures**. The full backend
`pytest` still runs in the ephemeral 3.14 env (the pinned 3.15.2 is not downloadable here).
The §12 exit criterion — a cold player finishing chapter 1 without a dead end — still needs
a human playtest, backend up and down.

## Status: P4 — admin + art pipeline, first form

The authoring loop exists end to end: **Admin SPA at `/admin`** (bun + Vite, dev via
`cd admin && bun run dev`, production `bun run build` → served same-origin by FastAPI) on top
of an **admin API** — `HKS_ADMIN_TOKEN` bearer auth (unset = disabled, never open), drafts
CRUD under `server/data/drafts/`, validate, publish. Publish runs the **content validator**
(`server/app/content_validate.py`, CLI `tools/check_content.py`) over the merged pack, refuses
on any error, copies drafts into `client/content/`, bumps the manifest version, reloads the
store — and every booted client **hot-packs** it (§5.7): newer entities and art bytes
override the bundled baseline in memory, saves record the content version.

The **Seedream pipeline** (§8) turns renders into game art: `/v1/images` client, NEAREST
downscale to pixel targets, snap onto the fixed `hk_palette_v1`, 1px outline, PNG written
into the pack with a `.gen.json` provenance sidecar (model/seed/palette/cost — "regenerate
this sprite exactly" stays possible). Pillow lives in the optional `art` dependency group
(`uv sync --group art`) so chat still runs where fresh-interpreter wheels lag (§10.6).

The §9.2 authoring tools are in too, as the SPA's four views (Editor / Playground / Builder /
Review): a **condition builder** — rule rows that emit §5.5 JSON, with a live "would this
pass?" evaluated by the server's Python evaluator (never a drifting TS copy) against an
editable state mock; a **persona playground** — chat with the unsaved draft through the real
pipeline, per-turn REAL tokens/cost/latency via OpenRouter's `usage.include` (the cache-hit
telemetry §7.5 wanted), rejected actions surfaced in red, one-click fact-check; a
**fact-check review queue** (§7.6: flag for review, never rewrite the player's words,
resolve per entry); a **usage dashboard** — month-to-date chat/image/fact-check spend,
turns, tokens, p95 latency, top rejected reasons, costliest sessions (append-only
`server/data/usage.jsonl`, in-game turns logged too); and **publish preview** — the
added/changed diff before the confirm dialog.

Live-verified against the real OpenRouter (2026-11-17, ~$0.04 of spend): a playground turn
reads REAL numbers — prompt 729 tok, $0.00016, 2.6 s (§7.5's 1900-token assumption was
pessimistic); the cache-hit telemetry measures reality — hits vary with OpenRouter routing
(60% / 0% / 76% across three same-prefix turns). The style bible (§8.2) was generated into
`art/stylebible.png` ($0.018) and a cast sprite was generated FROM it ($0.018): the wire
format is object entries (`{"type":"image_url","image_url":{"url":…}}`), and the live
constraints are recorded in `server/app/config.py` — seedream-5-0-flash only makes
transparent images from a reference whose PNG carries a transparent pixel (the bible
carries a 2px clear fringe; reference-less transparent subjects route to
seedream-5-5). The sprite was wired into 根叔's definition through the real
draft → validate → preview → publish loop — **content v2** (f50b1ae38348) is served and
every booted client hot-packs it. Verified: 74 backend tests in the ephemeral 3.14 env.
The browser half is verified (2026-11-17): the 4.7.2 templates were installed on the Windows
side, the export produced `build/web` (`index.wasm` 38 MB · `index.pck` 5.0 MB), and the
smoke ran three ways — boot, talk with the backend up (real model reply from Ken), talk with
it stopped (scripted fallback, offline noise classified as expected) — all PASS with zero
unexpected console errors. Headless WebGL2 needs software rendering: `web_smoke.mjs` now
passes `--enable-unsafe-swiftshader`/`--use-angle=swiftshader` and takes `CHROME` (set it to
Playwright's Chromium in WSL — the Windows-Chrome CDP path proved flaky over NAT). A
pinned-3.15.2 pytest run remains the last unchecked box.

## Status: P5 — complete

Chapters 2–5 are authored end to end, each carrying `lore/*.md` + 2 locations + 3 NPCs + a
quest arc whose every flag beat has a deterministic offline fallback line:

- **1955 Kowloon market & hut settlement** — 阿彩 the tea stall (the grandmother before she
  was anyone's 嫲嫲), 華叔 opening the shop, 阿好's fire night.
- **1963 the mill floor & the standpipe lane** — the rationing is real history per the lore
  file; 阿榮 is the player's father as a child and never learns who the player is.
- **1979 the family shop & the rooftop** — Kai Tak's approach overhead, the generation that
  moved up, 光叔's runway stories.
- **1996 the same street & the flat** — the emigration wave, and the unsent letter finally
  carried by 阿雪 to the address her mother left.

The memento doors chain the whole game: album→ch02, cassette→ch03, tram ticket→ch04,
letter→ch05 — each opening its era, each closing cutscene returning the player to 2027.
(The 2027 finale, chapter 6, is the remaining content.)

Systems shipped: **save-code export/import** (§6.4 — length-prefixed deflate, `savecode` /
`code` dev commands, a selftest round-trip that also refuses mangled codes), the **Audio
autoload** with five synthesized ambience beds (4.0 MB of WAV, content `music` fields wired,
seamless looping), **touch controls** (a virtual d-pad plus E/I, touchscreen-only), and the
**NPC-placement editor plugin** (§9.1 — `addons/npc_placement`: a JSON write-back core the
selftest exercises plus an `@tool` dock for the editor).

Verified on this machine: 49 entities validate with 0 errors, the font-coverage gate passes
over every new era string, three-locale parity holds with zero Cantonese particles in
`zh_CN`, and `--selftest` runs via the Windows Godot through WSL interop: **119 checks,
0 failures** — now covering the placement writer and the real audio assets. Earlier runs
verified the web export (`index.wasm` 38 MB · `index.pck` 5.0 MB) and the browser smokes
(backend up: real model reply; backend down: scripted fallback). Remaining: the 30-minute
phone play, chapter 6 (the 2027 finale), and real recordings to replace the synthesized
beds.

## Fonts and licensing (read before swapping fonts)

Godot ships **no CJK glyphs**, so Chinese renders as a wall of boxes with the default theme font.
The game bundles **Fusion Pixel 12px monospaced** (`zh_hk` default, `zh_hans` fallback) —
**OFL 1.1**, licence files in `client/assets/fonts/`, installed at runtime in
`Settings._install_theme()` with antialiasing and subpixel positioning disabled so 12 px stays
crisp at 5× scale.

**Zpix was evaluated and rejected**: it covers Cantonese in a single 4.5 MB file, but its licence
is **USD $1000 per commercial product** (free for education only). Do not reintroduce it without
paying. Any replacement font must pass `tools/check_font_coverage.py`, which reads the real cmap
against the Cantonese particle set and every string in `client/content/`.

## Known gaps

- **Admin + art + §9.2 authoring tools shipped** (see "Status: P4"); the remaining admin
  depth is the 2027-chapter fact-check classifier hook-up (§7.6 optional hardening).
  Chapters 1–5 content exists (see "Status: P3" / "Status: P5"); the 2027 finale
  (chapter 6) remains.
- **Cache-hit telemetry is only partially wired.** The admin playground reads real
  prompt/cached/cost numbers (OpenRouter `usage.include`) — live-measured 2026-11-17:
  same-prefix turns hit 60% / 0% / 76% depending on which upstream serves the request —
  but the in-game streaming path still estimates tokens (PLAN §7.5).
- **Token counts are estimated** (CJK ≈ 1 token/char), not read from the provider, so budgets are
  conservative rather than exact.
- **Content changes need a re-export** until P4's hot-pack endpoint exists.
- **Chapter 1 content is authored, zh_HK-canonical** (both §14 decisions settled): 3 locations,
  5 NPCs, 8 mementos, the ch01 arc, and `lore/ch01_hk_2027.md`. The P1/P2 fixtures
  (`loc_p1_shop`, `npc_p2_shopkeeper`) remain as engine test content. Art is still the P1
  placeholder atlas until the P4 pipeline.
- **The build stamp** (`p2-font-2` in the HUD corner) is a development aid — remove it before
  shipping, along with the dev console's unconditional dialogue logging.
- **Brotli pre-compression is wired but unmeasured**: `tools/export_web.sh` writes `.br`
  sidecars when the `brotli` CLI is installed, and `tools/serve_web.py` serves them with
  `Content-Encoding: br` — sizes stay unmeasured until the next real export (the machine that
  runs the export needs godot + brotli; the script prints the artifact list).
- **60 fps on a physical phone is still unmeasured.** The HUD already prints live FPS; follow
  the checklist under "Tests".

## Read this first

| Section | What it settles |
|---------|-----------------|
| [§3](docs/PLAN.md#3-architecture-and-trust-boundary) | Architecture, and why the API key can never be in the client |
| [§5](docs/PLAN.md#5-content-data-model) | NPC/item/location/quest schemas, condition & effect languages, three locales |
| [§6](docs/PLAN.md#65-localization-and-fonts-the-part-that-can-break-the-web-build) | Godot settings, autoloads, fonts and the CJK trap |
| [§7](docs/PLAN.md#7-llm-conversation-design) | Chat protocol, prompt-cache strategy, action allowlists, cost model |
| [§9](docs/PLAN.md#9-admin-mode) | Admin mode design and why it's a browser SPA |
| [§12](docs/PLAN.md#12-milestones) | Phases P0–P6 with observable exit criteria |
| [§14](docs/PLAN.md#14-open-decisions-before-scaffolding) | The decisions still open |

## Prerequisites

- Godot **4.7.2** with web export templates for `4.7.2.stable` (PLAN §10.1).
- **Python 3.15.2**, locked exactly — `uv` manages it (`uv python pin 3.15.2`). The system
  `python3` is 3.9.6 and is used only for the stdlib tools in `tools/`.
- **bun 1.4.4** for the admin SPA (`admin/`) — the only package manager; `bun run dev`
  proxies to the local backend, `bun run build` produces what `/admin` serves.

## Secrets

`OPENROUTER_API_KEY` lives in `.env` (git-ignored) and is read by the backend only. It must never
appear in `client/`, in `export_presets.cfg`, or in any file that ships to a browser.
