// Dialogue panel check — run via `bun run verify` (scripts/verify.sh drives the server and browser).
//
// What this covers: the panel opens for a placed NPC, a submitted line produces a coherent turn,
// and closing it puts the player back in control. It deliberately accepts either outcome of a turn —
// a model reply or the authored fallback — because the preview server has no `/v1` proxy, so the
// offline ladder is the path a built bundle actually takes. The live model path is asserted from
// the transport side instead (`scripts/turn.ts`), against a running API.
async page => {
  const ready = await page.evaluate(() => Boolean(window.__hks) && window.__hks.game.scene.isActive("world"));
  if (!ready) throw new Error("world scene never became active");

  await page.evaluate(() => window.__hks.start());

  // The bundled pixel font has to load: a CJK panel rendered in a fallback face is a visible
  // regression that no compile step catches.
  const faces = await page.evaluate(async () => (await document.fonts.load('12px "Fusion Pixel HK"')).length);

  // And the pack check has to settle one way or another — "checking" forever means the boot path
  // threw before it finished.
  const pack = await page.evaluate(() => window.__hks.packStatus());

  const checks = [];

  // An NPC that the empty state places: npc_ch01_ken has `{ not: { quest_state: "ch06" } }`.
  await page.evaluate(() => window.__hks.openDialogue("npc_ch01_ken"));

  const panelOpen = await page.evaluate(() => {
    const panel = document.querySelector("#dialogue");
    return panel !== null && !panel.hasAttribute("hidden");
  });
  if (!panelOpen) throw new Error("dialogue panel did not open");
  checks.push("panel-open");

  if (faces < 1) throw new Error("the bundled HK pixel font did not load");
  if (pack === "checking") throw new Error("the content pack check never settled");
  checks.push("font-loaded");
  checks.push(`pack:${pack}`);

  const name = await page.evaluate(() => document.querySelector("#dialogue-name")?.textContent ?? "");
  if (name.trim() === "") throw new Error("dialogue panel opened without a character name");
  checks.push(`name(${name.trim()})`);

  await page.fill("#dialogue-input", "根叔，你間舖幾時開㗎？");

  const talkCount = () => page.evaluate(() => window.__hks.state().talk_counts["npc_ch01_ken"] ?? 0);
  const before = await talkCount();

  await page.press("#dialogue-input", "Enter");

  // Poll: a turn is finished when it is no longer busy, the player's line has landed, and an NPC
  // line answers it. Waiting only for an NPC line would be satisfied by the offline greeting that
  // an unreachable backend shows before anything is typed.
  const view = async () => page.evaluate(() => window.__hks.dialogueView());
  let finished = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await view();
    const hasPlayerLine = current !== null && current.turns.some((turn) => turn.role === "user");
    const hasNpcLine = current !== null && current.turns.some((turn) => turn.role === "npc");
    if (hasPlayerLine && hasNpcLine && current.busy === false) {
      finished = current;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!finished) throw new Error("no NPC line arrived for the submitted turn");

  const userLines = finished.turns.filter((turn) => turn.role === "user");
  if (userLines.length !== 1) throw new Error(`expected exactly one player line, saw ${userLines.length}`);

  const reply = finished.turns.filter((turn) => turn.role === "npc").at(-1);
  if (!reply || reply.text.trim() === "") throw new Error("the NPC line was empty");
  checks.push(reply.fallback ? "authored-fallback" : "model-reply");

  if (reply.fallback && !finished.error) {
    throw new Error("an authored line arrived without an error code explaining why");
  }
  checks.push(`error=${finished.error ?? "none"}`);

  const typingCleared = finished.typing === "";
  if (!typingCleared) throw new Error("the streamed preview was left on screen after the turn finished");
  checks.push("stream-cleared");

  // `dialogue.gd` counts the turns the character actually had. An authored line shown because the
  // model could not answer is not one, so the two outcomes must move the counter differently.
  const after = await talkCount();
  const delta = after - before;
  const expected = reply.fallback ? 0 : 1;
  if (delta !== expected) {
    throw new Error(
      `talk count moved by ${delta}, expected ${expected} for ${reply.fallback ? "an authored line" : "a model reply"}`,
    );
  }
  checks.push(`talk-count(+${delta})`);

  const visited = await page.evaluate(
    () => Object.values(window.__hks.state().visited).filter(Boolean).length,
  );
  if (visited < 1) throw new Error("arriving in a location did not mark it visited");
  checks.push(`visited(${visited})`);

  const code = await page.evaluate(() => window.__hks.saveCode());
  if (typeof code !== "string" || code.length < 40) {
    throw new Error(`save code looks empty (${typeof code}, ${code?.length ?? 0} chars)`);
  }
  checks.push(`save-code(${code.length}ch)`);

  await page.evaluate(() => window.__hks.closeDialogue());

  const panelClosed = await page.evaluate(() => {
    const panel = document.querySelector("#dialogue");
    return panel !== null && panel.hasAttribute("hidden");
  });
  if (!panelClosed) throw new Error("dialogue panel did not close");
  checks.push("panel-closed");

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
