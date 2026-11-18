// Chapter flow check — run via `bun run verify` (scripts/verify.sh drives the browser).
//
// Chapters are derived from quest records, so this asserts the thing the format exists for: finishing
// a chapter's quest makes the next chapter active, and that is what carries the player into its maps.
// Nothing in the content used to do this — the era maps were only reachable from each other.
async page => {
  const ready = await page.evaluate(
    () => Boolean(window.__hks) && window.__hks.game.scene.isActive("world"),
  );
  if (!ready) throw new Error("world scene never became active");

  const checks = [];
  const chapter = () => page.evaluate(() => window.__hks.chapterId());
  const where = () => page.evaluate(() => window.__hks.locationId());

  // A clean game, so the check does not depend on what earlier checks left in the save.
  await page.evaluate(() => window.__hks.newGame());
  await page.waitForTimeout(500);

  if ((await chapter()) !== "ch01") throw new Error(`a new game should be in ch01, not ${await chapter()}`);
  if ((await where()) !== "loc_ssp_market_street") {
    throw new Error(`a new game should start at ch01's entry, not ${await where()}`);
  }
  checks.push(`start(ch01@${await where()})`);

  // Finishing chapter 1 makes chapter 2 active — and moves the player to its entry map.
  await page.evaluate(() => window.__hks.finishQuest("ch01"));

  let moved = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    moved = await where();
    if (moved === "loc_kln_market_1955") break;
    await page.waitForTimeout(100);
  }
  if (moved !== "loc_kln_market_1955") throw new Error(`chapter 2's entry was not entered (at ${moved})`);
  if ((await chapter()) !== "ch02") throw new Error(`chapter id is ${await chapter()} after finishing ch01`);
  checks.push(`ch02@${moved}`);

  // The same transition, one chapter on.
  await page.evaluate(() => window.__hks.finishQuest("ch02"));

  for (let attempt = 0; attempt < 80; attempt += 1) {
    moved = await where();
    if (moved === "loc_kln_lane_1963") break;
    await page.waitForTimeout(100);
  }
  if (moved !== "loc_kln_lane_1963") throw new Error(`chapter 3's entry was not entered (at ${moved})`);
  checks.push(`ch03@${moved}`);

  // Leave a clean save behind for whatever runs next.
  await page.evaluate(() => window.__hks.newGame());

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
