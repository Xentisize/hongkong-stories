#!/usr/bin/env node
// Headless smoke test for the exported web build (docs/PLAN.md §11 "E2E smoke").
//
//   node tools/web_smoke.mjs <url> <out.png> <waitMs>
//
// Chrome's --virtual-time-budget screenshots as soon as virtual time expires, which for a
// Godot build means "wasm downloaded but not yet compiled" — you get the loading screen.
// So we drive CDP instead and wait in real time, then also collect console errors, which is
// the difference between "the file exists" and "the game booted".
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8099/";
const out = process.argv[3] ?? "/tmp/hk_web_smoke.png";
const waitMs = Number(process.argv[4] ?? 9000);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), "hk-chrome-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1152,648", url,
], { stdio: "ignore" });

async function pageTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* chrome not listening yet */ }
    await sleep(150);
  }
  throw new Error("no debuggable page target — did Chrome start?");
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const errors = [];
const pageLogs = [];

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push(msg.params?.exceptionDetails?.exception?.description ?? "uncaught exception");
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (msg.params.type === "error") errors.push(text);
    else pageLogs.push(text);
  } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
    errors.push(msg.params.entry.text);
  }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");

await sleep(waitMs);

const probe = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
    loaderStatus: document.querySelector('#status')?.textContent?.trim() || null,
    title: document.title
  })`,
  returnByValue: true,
});

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
} else {
  errors.push(`captureScreenshot failed: ${JSON.stringify(shot.error ?? {})}`);
}

console.log("page    :", probe.result?.result?.value ?? "(no result)");
console.log("logs    :", pageLogs.length ? pageLogs : "none");
console.log("errors  :", errors.length ? errors : "none");
console.log("screenshot:", out);

ws.close();
chrome.kill();
