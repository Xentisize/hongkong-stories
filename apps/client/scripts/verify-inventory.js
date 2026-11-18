// Inventory check — run via `bun run verify` (scripts/verify.sh drives the browser).
//
// The bag is the last client UI that was missing, so this walks the whole of it: the empty state, an
// item appearing, the content's own refusal line while its requirement is unmet, Use actually applying
// the item's effects, Hold and Put away, and Esc closing it.
async page => {
  const ready = await page.evaluate(
    () => Boolean(window.__hks) && window.__hks.game.scene.isActive("world"),
  );
  if (!ready) throw new Error("world scene never became active");

  const checks = [];
  const visible = () => page.evaluate(() => window.__hks.inventoryVisible());
  const text = (selector) =>
    page.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? "", selector);
  const disabled = (selector) =>
    page.evaluate((sel) => Boolean(document.querySelector(sel)?.hasAttribute("disabled")), selector);
  const flags = () => page.evaluate(() => window.__hks.state().flags);

  const until = async (predicate, label) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await predicate()) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  // A clean game, then the bag: empty to start with, and it says so.
  await page.evaluate(() => window.__hks.newGame());
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__hks.openInventory());

  if (!(await visible())) throw new Error("the inventory did not open");
  const empty = await text("#inventory-detail .empty");
  if (empty === "") throw new Error("an empty bag showed no empty state");
  checks.push(`empty(${empty})`);

  // A memento the content defines: it has a name, a description, and a requirement unmet right now.
  // The real id: a nonexistent one would (correctly) appear by id, which is not what this asserts.
  await page.evaluate(() => window.__hks.addItem("item_cassette_tape", 1));
  await until(async () => (await page.evaluate(() => document.querySelectorAll("#inventory-list button").length)) > 0, "the item to appear");

  const name = await text("#inventory-list button");
  if (name === "" || name.includes("item_cassette")) {
    throw new Error(`the item is shown by id, not by its authored name: ${name}`);
  }
  checks.push(`row(${name})`);

  const locked = await text("#inventory-detail .locked");
  if (locked === "") throw new Error("an unmet requirement produced no refusal line");
  if (!(await disabled("#inventory-detail .actions button"))) {
    throw new Error("Use was enabled while the item's requirement was unmet");
  }
  checks.push(`locked(${locked})`);

  // Meet the requirement — the cassette wants chapter 2 finished — and the same row becomes usable.
  await page.evaluate(() => window.__hks.finishQuest("ch02"));
  await until(async () => (await text("#inventory-detail .locked")) === "", "the refusal to clear");
  if (await disabled("#inventory-detail .actions button")) {
    throw new Error("Use stayed disabled after its requirement was met");
  }
  checks.push("requirement-met");

  // Use applies the content's own effects.
  await page.click("#inventory-detail .actions button");
  await until(async () => (await flags())["ch03_opened"] === true, "the item's effect");
  checks.push("used");

  // Hold and put away, and the header says what is in hand.
  await page.click("#inventory-detail .actions button:nth-child(2)");
  await until(
    async () => (await page.evaluate(() => window.__hks.state().held_item)) === "item_cassette_tape",
    "the item to be held",
  );
  if ((await text("#inventory-held")) === "") throw new Error("holding an item said nothing");
  checks.push(`held(${await text("#inventory-held")})`);

  await page.click("#inventory-detail .actions button:nth-child(2)");
  await until(
    async () => (await page.evaluate(() => window.__hks.state().held_item)) === "",
    "the item to be put away",
  );
  checks.push("put-away");

  // Esc closes it, and the world takes input again.
  await page.keyboard.press("Escape");
  await until(async () => (await visible()) === false, "the inventory to close");
  checks.push("closed");

  // Leave a clean save behind for whatever runs next.
  await page.evaluate(() => window.__hks.newGame());

  return `VERDICT:PASS ${checks.join(" | ")}`;
}
