#!/usr/bin/env node
// Headless end-to-end smoke test for the exported web build (docs/PLAN.md §11).
//
//   node tools/web_smoke.mjs [url] [out.png] [waitMs] [mode]
//     mode = boot   just load and report
//            talk   walk to the shopkeeper, press E, report the conversation
//
// Chrome's --virtual-time-budget screenshots as soon as virtual time expires, which for a
// Godot build means "wasm downloaded but not yet compiled" — you get the loading screen. So
// this drives CDP and waits in real time.
//
// `talk` mode injects real key events, which makes this an end-to-end test rather than a boot
// test: input → interaction → Dialogue → (model or scripted fallback). With `?trace=1` (added
// below) the game logs every finished line as "[Dialogue] <npc>: <text>", with " (fallback)"
// appended when the backend could not be reached, so the caller can tell the two apart.
//
// Exit code is 0 only when nothing unexpected happened, so CI can gate on it.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8099/";
// The game only logs finished lines when asked (`?trace=1`) — every assertion below greps those
// console lines, so the request is added here instead of being left to whoever runs the test.
const url = (() => {
  const parsed = new URL(baseUrl);
  if (!parsed.searchParams.has("trace")) parsed.searchParams.set("trace", "1");
  return parsed.toString();
})();
const out = process.argv[3] ?? "/tmp/hk_web_smoke.png";
const waitMs = Number(process.argv[4] ?? 9000);
const mode = process.argv[5] ?? "boot";

// Noise that is expected and harmless when the backend is deliberately stopped. Kept explicit
// rather than "ignore everything that looks scary": a real failure must still be loud.
const EXPECTED_OFFLINE = [
  /ERR_CONNECTION_REFUSED/,
  /Failed to fetch/,
  /WebSocket connection to .* failed/,
  /^WARNING: Dialogue: chat failed/,
  /^\s+at: /, // stack-trace continuation lines from the warning above
];
const BOOT_PREFIXES = ["Godot Engine", "OpenGL API", "Build configuration", "[Main]", "[ContentDB]"];

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
// When Chrome runs on the Windows side (WSL interop) its CDP socket lives on the Windows
// loopback, which WSL2/NAT cannot reach on 127.0.0.1 — set CDP_HOST to the Windows host IP
// and the script additionally asks Chrome to bind 0.0.0.0.
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
// A Windows Chrome needs a Windows-style profile path (C:\...), which mkdtempSync cannot
// produce from WSL — PROFILE_DIR supplies one verbatim when the browser runs on the host.
const profile = process.env.PROFILE_DIR || mkdtempSync(join(tmpdir(), "hk-chrome-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromeArgs = [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1152,648", url,
];
if (CDP_HOST !== "127.0.0.1") chromeArgs.push("--remote-debugging-address=0.0.0.0");
const chrome = spawn(CHROME, chromeArgs, { stdio: "ignore" });

async function pageTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://${CDP_HOST}:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* chrome not listening yet */ }
    await sleep(150);
  }
  throw new Error("no debuggable page target — did Chrome start?");
}

const external = await pageTarget();
// Chrome reports its debugger URL with the host it thinks it is on; rewrite to CDP_HOST.
const wsUrl = external.webSocketDebuggerUrl.replace(/127\.0\.0\.1|localhost/g, CDP_HOST);
const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const messages = []; // every console line, tagged with its level

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") {
    messages.push({ level: "error", text: msg.params?.exceptionDetails?.exception?.description ?? "uncaught exception" });
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    messages.push({ level: msg.params.type === "error" ? "error" : "info", text });
  } else if (msg.method === "Log.entryAdded") {
    const entry = msg.params?.entry;
    if (entry) messages.push({ level: entry.level === "error" ? "error" : "info", text: entry.text });
  }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

async function holdKey(key, code, vk, ms) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await sleep(ms);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");

await sleep(waitMs);

if (mode === "talk") {
  if (url.includes("smoke=1")) {
    // The game's smoke hook (?smoke=1) opens the conversation itself — headless CDP drops
    // synthesized key events unreliably, so this path needs no input simulation at all.
    await sleep(16000);
  } else {
    // The title screen covers the game at boot. Dismiss it three ways for robustness —
    // Esc, Enter (the title closes on ui_accept too), and a plain click on the canvas
    // center, which also hands the canvas the keyboard focus so the walk keys land.
    await holdKey("Escape", "Escape", 27, 120);
    await sleep(400);
    await holdKey("Enter", "Enter", 13, 120);
    await sleep(400);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 576, y: 250, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 576, y: 250, button: "left", clickCount: 1 });
    await sleep(600);
    // Market street (the P3 default): spawn (13.5, 6.5); Uncle Ken's home tile is (7, 4).
    // 72 px/s over 24px tiles, so these holds are generous on purpose. NPCs wander now
    // (P6+), so after the calibrated walk we press E while sweeping nearby cells until a
    // conversation opens — the [Dialogue] console line marks a finished reply.
    await holdKey("ArrowLeft", "ArrowLeft", 37, 2200);
    await holdKey("ArrowUp", "ArrowUp", 38, 900);
    for (let attempt = 0; attempt < 4; attempt++) {
      await holdKey("e", "KeyE", 69, 90);
      await sleep(2500);
      if (messages.some((m) => m.text.startsWith("[Dialogue]"))) break;
      await holdKey("ArrowRight", "ArrowRight", 39, 500);
      await holdKey("ArrowDown", "ArrowDown", 40, 300);
    }
    await sleep(14000); // first token measured ~3s; allows a cold start
  }
}

const probe = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
    loaderStatus: document.querySelector('#status')?.textContent?.trim() || null,
    title: document.title
  })`,
  returnByValue: true,
});
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) writeFileSync(out, Buffer.from(shot.result.data, "base64"));

// ---- classify ----
const oneLine = (text) => String(text).split("\n")[0].trim().slice(0, 150);
const dialogue = messages.filter((m) => m.text.startsWith("[Dialogue]")).map((m) => m.text);
const boot = messages.filter((m) => BOOT_PREFIXES.some((p) => m.text.startsWith(p))).map((m) => oneLine(m.text));
const offlineNoise = messages.filter((m) => EXPECTED_OFFLINE.some((re) => re.test(m.text)));
const unexpected = messages.filter(
  (m) => m.level === "error"
    && !EXPECTED_OFFLINE.some((re) => re.test(m.text))
    && !m.text.startsWith("[Dialogue]"),
);

const usedFallback = dialogue.some((t) => t.includes("(fallback)")) || offlineNoise.length > 0;
const page = JSON.parse(probe.result?.result?.value ?? "{}");
const loaderDone = page.loaderStatus === null;

const row = (label, value) => console.log(`  ${label.padEnd(14)}${value}`);

console.log(`\nweb smoke — mode=${mode}`);
row("canvas", page.canvas ? `${page.canvas[0]}x${page.canvas[1]} · loader ${loaderDone ? "done" : "STUCK"} · ${page.title ?? "?"}` : "MISSING");
for (const line of boot) row("boot", line);
if (dialogue.length === 0) row("dialogue", mode === "talk" ? "NONE (walk or interact failed)" : "not attempted");
for (const line of dialogue) row("dialogue", line);
row("fallback", usedFallback ? "yes — scripted lines used" : "no — model answered");
row("offline noise", offlineNoise.length ? `${offlineNoise.length} expected (backend unreachable)` : "none");
row("unexpected", unexpected.length ? unexpected.map(oneLine) : "none");
row("screenshot", out);

ws.close();
chrome.kill();

const failed = !page.canvas || unexpected.length > 0 || (mode === "talk" && dialogue.length === 0);
if (failed) {
  console.log("\nRESULT: FAIL\n");
  process.exitCode = 1;
} else {
  console.log("\nRESULT: PASS\n");
}
