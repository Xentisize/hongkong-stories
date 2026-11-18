#!/usr/bin/env bun
/**
 * The demo: the built game and the API it talks to, on one origin.
 *
 * `bun run build` in `apps/client` produces a static bundle that assumes `/v1` is same-origin. This
 * serves that bundle and proxies `/v1` to the API, so what a reviewer opens is the same artifact the
 * deploy publishes — not a dev server with a proxy bolted on.
 *
 * Two details are load-bearing:
 *
 * - **`/v1/chat` is SSE and must stream.** The proxy hands the upstream body straight back rather
 *   than reading it first; buffering it would hold the whole turn and make the dialogue look broken
 *   for several seconds.
 * - **`no-store`.** A demo exists to show the build you just made. A cached bundle silently shows
 *   the previous one, which is the most confusing failure a reviewer can hit.
 *
 * Usage: bun tools/serve_demo.ts [port] [dist_dir] [api_url] [host]
 */

import { stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const port = Number(process.env["DEMO_PORT"] ?? args[0] ?? 8100);
const dist = resolve(
  process.env["DEMO_DIST"] ?? args[1] ?? join(import.meta.dir, "..", "apps", "client", "dist"),
);
const api = process.env["DEMO_API"] ?? args[2] ?? "http://127.0.0.1:3000";
// Loopback by default: a demo does not need to be reachable from the LAN unless asked.
const host = process.env["DEMO_HOST"] ?? args[3] ?? "127.0.0.1";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const indexHtml = join(dist, "index.html");
if (!(await isFile(indexHtml))) {
  console.error(`no build at ${dist} — run: cd apps/client && bun run build`);
  process.exit(1);
}

const server = Bun.serve({
  port,
  hostname: host,

  async fetch(request) {
    const url = new URL(request.url);

    // --- API: streamed through, never buffered ------------------------------------------
    if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
      const upstream = new URL(url.pathname + url.search, api);
      const headers = new Headers(request.headers);
      headers.delete("host");

      try {
        const response = await fetch(upstream, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          // Bun requires this to stream a request body it cannot measure.
          duplex: "half",
        } as RequestInit);

        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      } catch (error) {
        return Response.json(
          { detail: `the API is not reachable at ${api}: ${String(error).slice(0, 120)}` },
          { status: 502 },
        );
      }
    }

    // --- static, with an SPA fallback ---------------------------------------------------
    // `decodeURIComponent` throws on a truncated escape; a bad URL is a 400, not a crash.
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (pathname.endsWith("/")) pathname += "index.html";

    const wanted = resolve(join(dist, pathname));
    // A path that resolves outside the bundle is a request for something this is not serving.
    if (wanted !== dist && !wanted.startsWith(dist + "/")) {
      return new Response("forbidden", { status: 403 });
    }

    if (await isFile(wanted)) {
      return new Response(Bun.file(wanted), {
        headers: {
          "content-type": TYPES[extname(wanted).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    }

    // A path that names a file is a file. Falling back to index.html here would answer a missing
    // asset with HTML and a `text/html` content-type, and the app would report a decode error
    // instead of a 404 — which is the harder failure to read.
    if (extname(pathname) !== "") {
      return new Response("not found", { status: 404 });
    }

    const target = indexHtml;
    const body = Bun.file(target);

    return new Response(body, {
      headers: {
        "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  },
});

console.log(`demo ready: ${dist} + ${api} → http://${host}:${server.port}/`);
