// Chapter flow check — run via `bun run verify` (scripts/verify.sh drives the browser).
//
// Chapters are derived from quest records, and a **declared transition** is what moves the player:
// this walks the whole chain, asserts the announcement each time, and then proves the last chapter
// refuses to move however finished its quest is.
async page => {
  const ready = await page.evaluate(
    () => Boolean(window.__hks) && window.__hks.game.scene.isActive("world"),
  );
  if (!ready) throw new Error("world scene never became active");

  const checks = [];
  const chapter = () => page.evaluate(() => window.__hks.chapterId());
  const where = () => page.evaluate(() => window.__hks.locationId());
  const announcement = () =>
    page.evaluate(() => document.querySelector("#message")?.textContent ?? "");
  const label = () => page.evaluate(() => window.__hks.chapterLabel());

  const until = async (predicate, label) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await predicate()) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  // A clean game, so the check does not depend on what earlier checks left in the save.
  await page.evaluate(() => window.__hks.newGame());
  await page.waitForTimeout(500);

  if ((await chapter()) !== "ch01") throw new Error(`a new game should be in ch01, not ${await chapter()}`);
  if ((await where()) !== "loc_ssp_market_street") {
    throw new Error(`a new game should start at ch01's entry, not ${await where()}`);
  }
  checks.push(`start(ch01@${await where()})`);

  // The whole chain, in order: each chapter's own transition is what carries the player on.
  const CHAIN = [
    { finish: "ch01", chapter: "ch02", location: "loc_kln_market_1955" },
    { finish: "ch02", chapter: "ch03", location: "loc_kln_lane_1963" },
    { finish: "ch03", chapter: "ch04", location: "loc_ssp_shopfront_1979" },
    { finish: "ch04", chapter: "ch05", location: "loc_ssp_street_1996" },
    { finish: "ch05", chapter: "ch06", location: "loc_ssp_flat" },
  ];

  for (const step of CHAIN) {
    await page.evaluate((quest) => window.__hks.finishQuest(quest), step.finish);
    await until(async () => (await where()) === step.location, `${step.finish} → ${step.location}`);

    if ((await chapter()) !== step.chapter) {
      throw new Error(`expected ${step.chapter} after ${step.finish}, at ${await chapter()}`);
    }

    // The announcement is the chapter's own title, localized. Comparing against the client's own
    // label keeps this honest across locales — the browser reports `en`, so a hardcoded 第二章 would
    // fail on a correct build.
    const shown = await announcement();
    const expected = await label();
    if (expected === "" || shown !== expected) {
      throw new Error(`${step.chapter} announced "${shown}", expected "${expected}"`);
    }
  }
  checks.push(`chain(${CHAIN.length} transitions)`);
  checks.push(`announced(${await announcement()})`);

  // The finale declares no transition: finishing its quest must not move the player anywhere.
  const before = await where();
  await page.evaluate(() => window.__hks.finishQuest("ch06"));
  await page.waitForTimeout(700);
  if ((await where()) !== before) {
    throw new Error(`finishing the terminal chapter moved the player to ${await where()}`);
  }
  checks.push(`terminal-stays(${before})`);

  // Leave a clean save behind for whatever runs next.
  await page.evaluate(() => window.__hks.newGame());

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
