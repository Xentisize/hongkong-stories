// NPC gating check — run via `bun run verify` (scripts/verify.sh drives the server and browser).
//
// This asserts the one thing compile-time checking cannot: that the `requires` objects in the
// location content actually decide which NPCs exist on screen, evaluated by @hkstories/core.
// It throws on the first mismatch so a failure is loud.
async page => {
  // The scene starts asynchronously after the bundle loads; poll rather than guess.
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ready = await page.evaluate(
      () =>
        Boolean(window.__hks) &&
        window.__hks.game.scene.isActive("world") &&
        window.__hks.visibleNpcIds().length > 0,
    );
    if (ready) break;
    await page.waitForTimeout(100);
  }
  if (!ready) throw new Error("world scene never became active with NPCs placed");

  const visible = () => page.evaluate(() => window.__hks.visibleNpcIds());
  const setState = (state) =>
    page.evaluate((next) => window.__hks.setGameState(next), state);

  // NPC art textures are registered as `npc:<file>`; a placeholder is a Rectangle with no
  // texture, so counting these distinguishes "has art" from "fell back".
  const artCount = () =>
    page.evaluate(() => {
      const scene = window.__hks.game.scene.getScene("world");
      return scene.children.list.filter(
        (child) =>
          child.texture &&
          typeof child.texture.key === "string" &&
          child.texture.key.startsWith("npc:"),
      ).length;
    });

  const expectArt = (actual, expected, label) => {
    if (actual !== expected) {
      throw new Error(
        `${label}: expected ${expected} NPC sprite(s) drawn from art, found ${actual}` +
          " (placeholders mean artwork is missing or a sheet path is wrong)",
      );
    }
    return `${label}(art=${actual})`;
  };

  const expectIds = (actual, expected, label) => {
    const got = [...actual].sort().join(",");
    const want = [...expected].sort().join(",");
    if (got !== want) {
      throw new Error(`${label}: expected [${want}] but the scene shows [${got}]`);
    }
    return `${label}( ${got} )`;
  };

  // From the location content:
  //   npc_ch01_ken, npc_ch01_ming -> { "not": { "quest_state": "ch06" } }
  //   npc_ch01_wai               -> no requires
  //   npc_ch06_tai/ken/ming      -> { "quest_state": "ch06" }
  const CHAPTER1 = ["npc_ch01_ken", "npc_ch01_ming", "npc_ch01_wai"];
  const CHAPTER6 = ["npc_ch01_wai", "npc_ch06_tai", "npc_ch06_ken", "npc_ch06_ming"];

  const checks = [];
  checks.push(expectIds(await visible(), CHAPTER1, "empty-state"));
  checks.push(expectArt(await artCount(), CHAPTER1.length, "empty-state-art"));

  checks.push(
    expectIds(
      await setState({ quests: { ch06: { node: "n1", done: false } } }),
      CHAPTER6,
      "ch06-active",
    ),
  );
  checks.push(expectArt(await artCount(), CHAPTER6.length, "ch06-art"));

  // A finished quest must flip them back: `quest_state` is false once `done`.
  checks.push(
    expectIds(
      await setState({ quests: { ch06: { node: "n5", done: true } } }),
      CHAPTER1,
      "ch06-done",
    ),
  );

  checks.push(expectIds(await setState({}), CHAPTER1, "reset"));

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
