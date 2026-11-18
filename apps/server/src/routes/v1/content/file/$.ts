import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { contentDir } from "@/lib/content";
import { preflight, withCors } from "@/lib/cors";

/**
 * GET /v1/content/file/* — the content pack's bytes (PLAN 5.7, 10.3).
 *
 * The client boots on its bundled baseline, then asks for art bytes when a hot-pack version moves;
 * the admin's art block previews the same path. Both are `no-cache`, because a stale pack looks
 * exactly like a broken build.
 *
 * **Files are served by allowlist, not by trust:** the requested path must resolve inside the
 * content directory or the answer is a 404 — no listing, no traversal. This route reads arbitrary
 * files under one directory, so that check is the whole security boundary.
 *
 * The splat is taken from the URL rather than a route param: the path can contain slashes, and
 * decoding it once here keeps the check in one obvious place.
 */

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
};

const PREFIX = "/v1/content/file/";

export const Route = createFileRoute("/v1/content/file/$")({
  server: {
    handlers: {
      GET: withCors(async ({ request }) => {
        const { pathname } = new URL(request.url);
        const encoded = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : "";
        const requested = decodeURIComponent(encoded).replace(/^\/+/, "");

        const root = resolve(contentDir());
        const candidate = resolve(join(root, requested));
        const contained = relative(root, candidate);

        if (!requested || contained.startsWith("..") || isAbsolute(contained)) {
          return Response.json({ detail: "no such content file" }, { status: 404 });
        }

        try {
          const info = await stat(candidate);
          if (!info.isFile()) throw new Error("not a file");
          const body = await readFile(candidate);
          return new Response(body, {
            headers: {
              "content-type": MEDIA_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream",
              "cache-control": "no-cache",
              "content-length": String(body.byteLength),
            },
          });
        } catch {
          return Response.json({ detail: "no such content file" }, { status: 404 });
        }
      }),

      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
