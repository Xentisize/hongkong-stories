// Drives the *built* bundle through the demo server: no dev proxy, no dev server.
async page => {
  const checks = [];
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    ready = await page.evaluate(() => Boolean(window.__hks));
    if (ready) break;
    await page.waitForTimeout(100);
  }
  if (!ready) throw new Error("the built bundle never booted");

  const shell = await page.evaluate(() => window.__hks.shell());
  if (shell.credits < 1) throw new Error("the pack's settings did not reach the shell");
  checks.push(`shell(splash=${shell.splashVisible},credits=${shell.credits})`);

  await page.evaluate(() => {
    const splash = document.querySelector("#splash");
    if (splash && !splash.hasAttribute("hidden")) splash.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__hks.start());

  const scene = await page.evaluate(() => ({
    active: window.__hks.game.scene.isActive("world"),
    id: window.__hks.locationId(),
  }));
  if (!scene.active) throw new Error("the world scene never started");
  checks.push(`scene(${scene.id})`);

  // The manifest request goes through the proxy, so this also proves /v1 is wired.
  const pack = await page.evaluate(() => window.__hks.packStatus());
  if (pack === "checking") throw new Error("the pack check never settled through the proxy");
  checks.push(`pack:${pack}`);

  await page.evaluate(() => window.__hks.openDialogue("npc_ch01_ken"));
  await page.fill("#dialogue-input", "根叔，你間舖幾時開㗎？");
  await page.press("#dialogue-input", "Enter");

  let view = null;
  for (let i = 0; i < 150; i += 1) {
    view = await page.evaluate(() => window.__hks.dialogueView());
    const hasUser = view !== null && view.turns.some((turn) => turn.role === "user");
    const hasNpc = view !== null && view.turns.some((turn) => turn.role === "npc");
    if (hasUser && hasNpc && view.busy === false) break;
    await page.waitForTimeout(100);
  }
  if (view === null) throw new Error("no dialogue view");

  const reply = view.turns.filter((turn) => turn.role === "npc").at(-1);
  if (reply === undefined || reply.text.trim() === "") throw new Error("the reply was empty");
  if (reply.fallback === true) throw new Error(`the demo fell back to the authored line (${view.error})`);
  checks.push(`turn(model-reply,${reply.text.length}ch)`);

  await page.evaluate(() => window.__hks.closeDialogue());
  return `VERDICT:PASS ${checks.join(" | ")}`;
}
