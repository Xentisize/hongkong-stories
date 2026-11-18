// Quest and cutscene check — run via `bun run verify` (scripts/verify.sh drives the browser).
//
// The machine has unit tests; what they cannot show is that the *overlay* appears, that a cutscene
// really stops the chain, and that dismissing it reports back. `q_test_chain` is the shipped fixture
// for exactly this: flag -> item -> cutscene -> terminal.
async page => {
  const ready = await page.evaluate(
    () => Boolean(window.__hks) && window.__hks.game.scene.isActive("world"),
  );
  if (!ready) throw new Error("world scene never became active");

  await page.evaluate(() => window.__hks.start());

  const checks = [];
  const record = () => page.evaluate(() => window.__hks.questRecord("q_test_chain"));
  const node = async () => (await record())?.node ?? null;

  const until = async (predicate, label) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await predicate()) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  // Seeded at its first node; the machine takes it from there.
  await page.evaluate(() => window.__hks.startQuest("q_test_chain", "n1"));
  if ((await node()) !== "n1") throw new Error(`expected n1, at ${await node()}`);
  checks.push("seeded(n1)");

  // n1 completes on a flag.
  await page.evaluate(() => window.__hks.setFlag("test_gate", true));
  await until(async () => (await node()) === "n2", "n1 -> n2");
  checks.push("flag->n2");

  // n2 completes on an item, and n3 is a cutscene: the chain must stop there with the overlay up.
  await page.evaluate(() => window.__hks.addItem("item_rusty_key", 1));
  await until(async () => (await node()) === "n3", "n2 -> n3");
  await until(() => page.evaluate(() => window.__hks.cutsceneOpen()), "the cutscene overlay");

  // Give the machine a chance to do the wrong thing: it must not advance past a cutscene alone.
  await page.waitForTimeout(300);
  if ((await node()) !== "n3") throw new Error("the quest advanced past a cutscene without the player");
  checks.push("cutscene-holds");

  // A tap dismisses it, which completes n3 and moves the chain.
  await page.evaluate(() => document.querySelector("#cutscene")?.click());
  await until(async () => (await node()) === "n4", "n3 -> n4");
  const closed = await page.evaluate(() => window.__hks.cutsceneOpen());
  if (closed) throw new Error("the overlay stayed open after being dismissed");
  checks.push("dismiss->n4");

  // The terminal node finishes the quest.
  await page.evaluate(() => window.__hks.setFlag("test_final", true));
  await until(async () => (await record())?.done === true, "the quest to finish");
  checks.push("terminal-done");

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
