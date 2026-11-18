#!/usr/bin/env bun
/**
 * Static server for `build/web` with caching disabled.
 *
 * `python3 -m http.server` sends no Cache-Control, so Chrome applies heuristic caching and will
 * happily keep serving a stale `index.pck` — which looks exactly like a rendering bug ("my font fix
 * did nothing"). This serves `no-store` so a plain reload always gets the current build.
 *
 * When `tools/export_web.sh` has written `.br` sidecars, a GET for `index.wasm` with
 * `Accept-Encoding: br` returns `index.wasm.br` with `Content-Encoding: br`, so local testing
 * exercises the same transfer path as the pre-compressed static host (PLAN §10.2).
 *
 * Usage: bun tools/serve_web.ts [port] [dir] [host]
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const port = Number(process.argv[2] ?? 8099);
const directory = resolve(process.argv[3] ?? join(root, "build", "web"));
// Loopback by default: a non-loopback bind exposes the build to the LAN. The third argument exists
// so a physical phone can reach it over Wi-Fi.
const host = process.argv[4] ?? "127.0.0.1";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".br": "application/octet-stream",
};

function acceptsBrotli(header: string | undefined): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((part) => part.trim().split(";")[0]!.toLowerCase())
    .some((coding) => coding === "br" || coding === "*");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  const requested = decodeURIComponent(url.pathname);

  let target = resolve(join(directory, requested));
  const contained = relative(directory, target);
  if (contained.startsWith("..") || isAbsolute(contained)) {
    response.writeHead(404).end("not found");
    console.error(`  404 ${requested}`);
    return;
  }

  if (await isDirectory(target)) target = join(target, "index.html");
  if (!(await isFile(target))) {
    response.writeHead(404).end("not found");
    console.error(`  404 ${requested}`);
    return;
  }

  const headers: Record<string, string> = {
    // no-store, because heuristic caching of a stale pack is indistinguishable from a broken build.
    "cache-control": "no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  };

  // Pre-compressed sidecar (§10.2): a request for the artifact itself gets the sidecar as an
  // encoding, not as a separate file. A direct request for `.br` skips this and downloads opaque.
  const sidecar = `${target}.br`;
  if (!target.endsWith(".br") && acceptsBrotli(request.headers["accept-encoding"]) && (await isFile(sidecar))) {
    headers["content-type"] = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    headers["content-encoding"] = "br";
    headers["vary"] = "Accept-Encoding";
    headers["content-length"] = String((await stat(sidecar)).size);
    response.writeHead(200, headers);
    createReadStream(sidecar).pipe(response);
    console.error(`  200 ${requested} (br)`);
    return;
  }

  headers["content-type"] = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
  headers["content-length"] = String((await stat(target)).size);
  response.writeHead(200, headers);
  createReadStream(target).pipe(response);
  console.error(`  200 ${requested}`);
});

if (!(await isFile(join(directory, "index.html")))) {
  console.log(`no build at ${directory} — run tools/export_web.sh first`);
  process.exit(1);
}

server.listen(port, host, () => {
  console.log(`serving ${directory} on http://${host}:${port}/ (no-store)`);
});
