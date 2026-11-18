# TODO

What is left, and why it is left. The studio shipped its structure (four places, the draft preview,
the co-pilot, the connection graph); what remains is mostly *depth inside* that structure. Items marked
**(unverified)** are implemented but have never been exercised in the condition they need.

Everything below assumes `bun run --filter '*' check` and `bun test` stay green — currently 863 tests,
0 failures, 14 pre-existing skips.

## The studio: replace the forms, not just the shell

Re-homing kept every capability, but the editors inside Pack and Ship are still the ones written for
someone who knows the schema. This is the body of work that makes the product match its promise.

- [ ] **NPC editor → a character sheet.** Name and portrait at the top, then three plain fields
      (who they are, what they want, what they hide), with `llm` / `secrets` behind an "advanced"
      disclosure. The `llm` block is the reason the form is unreadable today.
- [ ] **Item editor → two questions.** "What is it?" (name, picture, one line) and "what does it do?"
      (a sentence → the co-pilot fills `on_use`/`use_requires`, shown as text back, not JSON).
- [ ] **Settings → four cards.** Title & splash, starting point, music volumes, credits. The art look
      is already there; the rest is a form that reads like a settings screen.
- [ ] **Lore → a markdown page with a live preview**, and a "write the first draft from the chapter"
      button (the co-pilot already writes into drafts).
- [ ] **Conditions builder → natural language first.** "The player has the key and has talked to Tai"
      compiles to §5.5 JSON via the co-pilot, with the rule rows kept as the advanced view.
- [ ] **Review queue → a task list.** "3 lines need a look", each with the draft, the reason and two
      buttons (keep / fix). Today it is a table.

## Connections

- [ ] **Inline chips in the editors.** The graph exists (`lib/connections`); render its edges next to
      `complete_when`, `use_requires` and exit `requires`, so the relationship is visible where it is
      written instead of only in a separate tab.
- [ ] **A local mini-graph** for the selected entity (the two lists already are the data; the drawing
      is presentation). Keep derived edges visually distinct from any declared ones.
- [ ] **Declared *narrative* links** — "this photo is about grandmother", "foreshadows the fire".
      Separate field, validated (dangling target = warning), labelled *作者聲明 / declared* so it can
      never be mistaken for a mechanic. **Do not** store mechanical links: they must stay derived
      (`has_item`, `talked`, `give`, `set_flag`), or the graph can claim what the engine won't do.
- [ ] **Gap coverage** beyond the three that exist today: an item nothing uses, a quest step nobody
      can reach, a door to a scene that does not exist.

## Build (WYSIWYG)

- [ ] **Drag, not just pick.** Placement currently arms one click inside the iframe; a real drag
      across a cross-origin frame needs a pointer-capture protocol (`dragstart` in the palette →
      `hovered` stream from the game → drop). The coordinate mapping already works.
- [ ] **Tile painting in the studio.** The paintable canvas + legend/collision forms still live only
      inside the map editor tab; Build should paint the scene it is showing.
- [ ] **Selection → inspector.** Clicking an NPC currently reports it; editing it in place (the
      character sheet above) is the missing half.

## AI

- [ ] **(unverified) A live proposal.** No `OPENROUTER_API_KEY` on this machine, so `/ai/propose`
      returns 503 by design and the dock reports it. Parsing, the approval card and the diff are
      tested; one real generation should be run and its cost checked.
- [ ] **Apply per change, not all-or-nothing.** The card lists changes; approving currently applies
      every one. Add a checkbox per change and an "apply N of M".
- [ ] **Keep a proposal across navigation.** An unsaved proposal lives in the dock and is lost on a
      place switch. Persisting it costs nothing and loses no reasoning.
- [ ] **Show the estimate before spending.** `usage`/`estimateCost` already exist; put a number on the
      button, and a per-session budget line in the dock.

## Art

- [ ] **Differentiate the two atlases.** `p1_tiles.png` (nine locations) and `p1_tiles_2027.png`
      (three) are currently the same art; the 1955 rooms could read warmer, the 2027 ones cooler.
- [ ] **Reference the extras series.** `p1_tiles_*_extra.png` (weeds, water, roof, window) is
      generated but no legend points at it; using one needs an atlas whose columns match the legend.
- [ ] **(known divergence) Godot ignores tile transforms.** The Phaser client honours `[col, row,
      "rot90"]`; the legacy Godot client does not, so a transformed tile renders rotated in the web
      build and unrotated there.

## Repo hygiene

- [ ] **Commit the studio work.** Everything since the last commit (studio shell and places, draft
      preview, bridge, co-pilot, connections, atlas, docs) is uncommitted.
- [ ] **Decide `.mcp.json`.** It predates this work and is local MCP server config; either commit it
      or add it to `.gitignore`.
- [ ] **Keep `docs/PLAN.md` §15 in step.** It is the design record for the studio; update it as the
      forms above are replaced, not after.

## How to check the studio by hand

```bash
cd apps/server && HKS_ADMIN_TOKEN=dev bun run dev          # API + preview pack route
cd apps/client && bun run dev                              # the game (port 5173)
cd admin && VITE_GAME_URL=http://localhost:5173/ bun run dev  # studio, game embedded in Build
```

Then: Build opens on a scene and the game reports `已連線 live`; clicking the game selects; picking a
character then clicking places it (and writes a draft); Story shows scenes/doors and a quest flow;
Pack › 接駁 shows a real item's giver, needers and doors; Ship shows the validator's warnings in plain
language with a fix button for each.
