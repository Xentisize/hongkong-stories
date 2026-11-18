#!/usr/bin/env bun
/**
 * Assemble the player demo: build the client for `/play/` and copy it into the API's static dir.
 *
 * Why a path and not the root: the demo is served by the API so the game and its `/v1` share an
 * origin. A static host alone cannot do that — the bundle calls `/v1` on its own origin, which is why
 * publishing `dist/` to a static host without a public API produces a game that cannot talk.
 *
 * Why `--base=/play/`: a Vite build defaults to root-absolute chunks (`/assets/index-*.js`), and
 * those would 404 under `/play/`. The base rewrites them, and the build goes to `dist-demo` so the
 * ordinary `dist/` (used by the verification preview) is left alone.
 *
 * Usage: bun tools/assemble_demo.ts
 */

import { $ } from "bun";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const client = join(repo, "apps", "client");
const built = join(client, "dist-demo");
const target = join(repo, "apps", "server", "public", "play");

await rm(built, { recursive: true, force: true });
await $`bunx vite build --base=/play/ --outDir dist-demo`.cwd(client);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(built, target, { recursive: true });

// Fail loudly if the build produced no entry point: a silent copy would leave a 503 at /play.
await stat(join(target, "index.html"));

console.log(`demo assembled → ${target}`);
console.log("serve it:  cd apps/server && bun run dev   (then open http://<host>:3000/play)");
// Measured, not guessed: a dev server already running keeps the public directory listing it read at
// boot, so it answers the new entry point (a route, read per request) and then 404s the chunk that
// entry names. Restarting is the difference between "the demo broke" and "the demo is new".
console.log("if the API is already running, restart it — it caches public/ at boot");
