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
cd server && uv run pytest                                  # 44 backend tests
godot --headless --path client -- --selftest                # 65 client checks (offline)
godot --headless --path client -- --live-chat               # 6 checks (needs the backend)
python3 tools/check_font_coverage.py                        # CJK glyph coverage gate
node tools/web_smoke.mjs http://127.0.0.1:8099/ /tmp/s.png 12000 talk   # browser E2E
```

`web_smoke` in `talk` mode injects real key events over CDP, walks to the NPC, presses E, and
reports the game's `[Dialogue]` line — so it distinguishes *the model answered* from *the
fallback answered*, and exits non-zero on any unexpected console error. Run it once with the
backend up and once with it stopped.

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

- **No admin mode yet** (P4), no quests or secret reveals (P3), no art pipeline (P4).
- **Cache-hit telemetry is not wired.** Prefix stability is *asserted* by test, but the actual hit
  rate is unmeasured — PLAN §7.5's cost model assumes it works.
- **Token counts are estimated** (CJK ≈ 1 token/char), not read from the provider, so budgets are
  conservative rather than exact.
- **Content changes need a re-export** until P4's hot-pack endpoint exists.
- **Placeholder content only**: the shop, the shopkeeper and the item are `"placeholder": true`,
  because chapter-1 framing and the canonical authoring locale are still open (PLAN §14).
- **The build stamp** (`p2-font-2` in the HUD corner) is a development aid — remove it before
  shipping, along with the dev console's unconditional dialogue logging.
- No brotli pre-compression (`brew install brotli` enables it); 60 fps on a physical phone is
  still an eyeball test.

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
- **bun 1.4.4** for the admin SPA when it lands — the only package manager.

## Secrets

`OPENROUTER_API_KEY` lives in `.env` (git-ignored) and is read by the backend only. It must never
appear in `client/`, in `export_presets.cfg`, or in any file that ships to a browser.
