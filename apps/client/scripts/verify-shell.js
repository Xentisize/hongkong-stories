// Shell check — run via `bun run verify` (scripts/verify.sh drives the server and browser).
//
// What the splash, title and credits look like comes from `settings/game.json`, so this asserts the
// pack actually drove them: the subtitle deliberately differs from the markup's fallback, which makes
// "the document was read" observable rather than a coincidence of identical strings.
async page => {
  // Boot: the scene builds asynchronously, so poll rather than guess.
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ready = await page.evaluate(() => Boolean(window.__hks));
    if (ready) break;
    await page.waitForTimeout(100);
  }
  if (!ready) throw new Error("the client never booted");

  const checks = [];
  const shell = () => page.evaluate(() => window.__hks.shell());
  const titleHidden = () =>
    page.evaluate(() => document.querySelector("#title")?.hasAttribute("hidden") ?? true);
  const splashHidden = () =>
    page.evaluate(() => document.querySelector("#splash")?.hasAttribute("hidden") ?? true);

  // The splash is either still up or already finished its own time — both are correct. What must not
  // happen is neither surface showing.
  const boot = await shell();
  const splashUp = !(await splashHidden());
  const titleUp = !(await titleHidden());
  if (!splashUp && !titleUp) throw new Error("neither the splash nor the title is showing at boot");
  checks.push(splashUp ? "splash-at-boot" : "title-at-boot");

  // Skipping must be possible, and must land on the title.
  if (splashUp) {
    await page.evaluate(() => document.querySelector("#splash")?.click());
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await splashHidden()) break;
    await page.waitForTimeout(100);
  }
  if (!(await splashHidden())) throw new Error("the splash did not go away");
  checks.push("splash-skipped");

  let titled = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    titled = !(await titleHidden());
    if (titled) break;
    await page.waitForTimeout(100);
  }
  if (!titled) throw new Error("the title never appeared");

  // The subtitle is the tell: the markup falls back to "Hong Kong Stories", and every authored
  // subtitle differs from that in all three locales — so whichever locale the browser reports, a
  // match here proves the document was read.
  const AUTHORED_SUBTITLES = ["我哋條街", "我们这条街", "Our Street"];
  const shown = await shell();
  if (!AUTHORED_SUBTITLES.includes(shown.subtitle)) {
    throw new Error(`title subtitle did not come from settings (got "${shown.subtitle}")`);
  }
  checks.push(`subtitle(${shown.subtitle})`);

  if (shown.credits < 1) throw new Error("the settings document produced no credits");
  checks.push(`credits(${shown.credits})`);

  // The credits panel is populated from those rows and toggles.
  const creditRows = await page.evaluate(() => {
    document.querySelector("#title-credits")?.click();
    const panel = document.querySelector("#credits");
    return panel === null ? -1 : panel.querySelectorAll(".credit-names").length;
  });
  if (creditRows !== shown.credits) {
    throw new Error(`credits panel shows ${creditRows} rows, settings has ${shown.credits}`);
  }
  checks.push("credits-rendered");

  // Starting play clears both surfaces.
  await page.evaluate(() => window.__hks.start());
  const after = await shell();
  if (after.splashVisible) throw new Error("the splash stayed up after starting");
  if (!(await titleHidden())) throw new Error("the title stayed up after starting");
  checks.push("started");

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
