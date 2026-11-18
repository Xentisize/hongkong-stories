// World interaction check — run via `bun run verify` (scripts/verify.sh drives the server and browser).
//
// Compile-time checking cannot tell whether a door's `requires` actually gates it, whether a locked
// exit refuses with the content's own wording, or whether an open exit really moves the player to
// another map. This walks the player with the test hook and asserts on scene state.
async page => {
  const ready = await page.evaluate(
    () => Boolean(window.__hks) && window.__hks.game.scene.isActive("world"),
  );
  if (!ready) throw new Error("world scene never became active");

  await page.evaluate(() => window.__hks.start());

  const checks = [];
  const id = () => page.evaluate(() => window.__hks.locationId());
  const target = () => page.evaluate(() => window.__hks.worldTarget());

  if ((await id()) !== "loc_ssp_market_street") throw new Error(`started on ${await id()}`);
  checks.push(`start(${await id()})`);

  // The ambience bed: starting play has to have selected this street's music, which is the port of
  // `current_music_stream()` — the same thing the Godot selftest asserted.
  const track = await page.evaluate(() => window.__hks.audioTrack());
  if (!track.startsWith("audio/")) throw new Error(`no ambience bed selected (got "${track}")`);
  checks.push(`audio:${track.replace("audio/", "").replace(".wav", "")}`);

  // --- a prop is a target --------------------------------------------------------------
  // The signboard sits on tile (16, 12) of the market street.
  await page.evaluate(() => window.__hks.movePlayer(16 * 24 + 12, 12 * 24 + 12));
  const prop = await target();
  if (!prop || prop.kind !== "interactable") {
    throw new Error(`expected an interactable beside the signboard, saw ${JSON.stringify(prop)}`);
  }
  checks.push(`target(${prop.kind}:${prop.id})`);

  // --- a locked exit refuses, in the content's words ------------------------------------
  await page.evaluate(() => window.__hks.movePlayer(12, 180));
  await page.waitForTimeout(150);

  const message = await page.evaluate(() => {
    const element = document.querySelector("#message");
    return element !== null && !element.hasAttribute("hidden") ? element.textContent : null;
  });
  if (message === null || message.trim() === "") throw new Error("a locked exit produced no message");
  if ((await id()) !== "loc_ssp_market_street") throw new Error("a locked exit let the player through");
  checks.push("locked-exit-refused");

  // --- an open exit moves the player ----------------------------------------------------
  await page.evaluate(() => window.__hks.movePlayer(27 * 24 + 12, 6 * 24 + 36));

  let moved = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await id();
    if (current !== "loc_ssp_market_street") {
      moved = current;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (moved !== "loc_ssp_cha_chaan_teng") throw new Error(`the open exit went to ${moved}`);
  checks.push(`exit->${moved}`);

  // --- a door is a target until its flag is set -----------------------------------------
  await page.evaluate(() => window.__hks.loadLocation("loc_p1_shop"));

  let swapped = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    swapped = await page.evaluate(
      () => window.__hks.game.scene.isActive("world") && window.__hks.locationId() === "loc_p1_shop",
    );
    if (swapped) break;
    await page.waitForTimeout(100);
  }
  if (!swapped) throw new Error("loading a map did not rebuild the scene");
  checks.push("map-swap");

  // The shop door occupies tiles (9,11) and (10,11).
  await page.evaluate(() => window.__hks.movePlayer(10 * 24, 11 * 24 + 12));
  const door = await target();
  if (!door || door.kind !== "door") {
    throw new Error(`expected the shop door, saw ${JSON.stringify(door)}`);
  }
  checks.push(`target(${door.kind}:${door.id})`);

  // Its `requires` is any(flag door_open, has_item item_rusty_key). A door is used, not merely
  // conditioned: `door.gd` evaluates `requires` on interact and only re-opens silently for an
  // `open_flag` recorded by an earlier session.
  await page.evaluate(() =>
    window.__hks.setGameState({ flags: { door_open: true }, vars: {}, inventory: {}, talk_counts: {}, quests: {} }),
  );
  await page.waitForTimeout(150);

  // Sampled before the door is used, so the swap can be asserted rather than assumed.
  const doorBefore = await page.evaluate(() => window.__hks.tileAt(10, 11));

  const stillShut = await page.evaluate(() => {
    const seen = window.__hks.worldTarget();
    return seen !== null && seen.kind === "door" ? seen.id : null;
  });
  if (stillShut !== "shop_door") {
    throw new Error(`a passing requires opened the door by itself (saw ${stillShut})`);
  }
  checks.push("door-needs-interaction");

  await page.evaluate(() => window.__hks.activate({ kind: "door", id: "shop_door" }));
  await page.waitForTimeout(150);

  const afterUse = await page.evaluate(() => {
    const seen = window.__hks.worldTarget();
    return seen !== null && seen.kind === "door" ? seen.id : null;
  });
  if (afterUse !== null) throw new Error(`the door stayed shut after being used (${afterUse})`);
  checks.push("door-opened-on-use");

  const doorTile = await page.evaluate(() => window.__hks.tileAt(10, 11));

  // The visible effect: the door's cells are floor now. No flag is recorded because this door
  // declares no `open_flag` — `door.gd` only persists through that field, and inventing one here
  // would make the save disagree with the content.
  if (doorBefore === ".") throw new Error("the door tiles were already floor before opening");
  if (doorTile !== ".") throw new Error(`the door tiles did not become floor (${doorBefore} -> ${doorTile})`);
  checks.push(`door-tiles(${doorBefore}->${doorTile})`);

  // --- a gated prop appears only once its condition passes ------------------------------
  // `the_box` in the flat requires chapters 2-5 done, which is the port of the selftest's
  // "prop hidden while its condition fails / appears when it passes" pair.
  await page.evaluate(() => window.__hks.loadLocation("loc_ssp_flat"));

  let inFlat = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    inFlat = await page.evaluate(
      () => window.__hks.game.scene.isActive("world") && window.__hks.locationId() === "loc_ssp_flat",
    );
    if (inFlat) break;
    await page.waitForTimeout(100);
  }
  if (!inFlat) throw new Error("the flat did not load");

  const atBox = async () => {
    await page.evaluate(() => window.__hks.movePlayer(6 * 24 + 12, 2 * 24 + 12));
    await page.waitForTimeout(120);
    const seen = await target();
    return seen !== null && seen.kind === "interactable" ? seen.id : null;
  };

  if ((await atBox()) === "the_box") throw new Error("the box was available before its quests");
  checks.push("gated-prop-hidden");

  for (const quest of ["ch02", "ch03", "ch04", "ch05"]) {
    await page.evaluate((id) => window.__hks.finishQuest(id), quest);
  }
  if ((await atBox()) !== "the_box") throw new Error("the box stayed hidden with every quest done");
  checks.push("gated-prop-shown");

  // Touch controls belong to a coarse pointer: on this desktop run the pad must stay hidden.
  const touch = await page.evaluate(() => {
    const element = document.querySelector("#touch");
    return element === null ? "missing" : element.hasAttribute("hidden") ? "hidden" : "shown";
  });
  if (touch !== "hidden") throw new Error(`touch controls should stay hidden on a fine pointer (${touch})`);
  checks.push("touch-hidden");

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
