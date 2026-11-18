import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { assetsDir } from "@/lib/content";
import { preflight, withCors } from "@/lib/cors";

/**
 * GET /v1/assets/file/* — the game's shipped art, for editor previews.
 *
 * A location's `atlas` is a Godot resource path (`res://assets/tiles/p1_tiles_2027.png`), which the
 * browser cannot resolve: those files live in `client/assets/`, not in the content pack that
 * `/v1/content/file` serves. Without this route the map editor has no tiles to draw.
 *
 * Same containment rule as the content route — the resolved path must stay inside the assets
 * directory or the answer is 404. No auth, deliberately: an `<img>` tag cannot carry a bearer
 * header, and these files ship to every player in the web export anyway.
 */

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

const PREFIX = "/v1/assets/file/";

export const Route = createFileRoute("/v1/assets/file/$")({
  server: {
    handlers: {
      GET: withCors(async ({ request }) => {
        const { pathname } = new URL(request.url);
        const encoded = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : "";
        const requested = decodeURIComponent(encoded).replace(/^\/+/, "");

        const root = resolve(assetsDir());
        const candidate = resolve(join(root, requested));
        const contained = relative(root, candidate);

        if (!requested || contained.startsWith("..") || isAbsolute(contained)) {
          return Response.json({ detail: "no such asset" }, { status: 404 });
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
          return Response.json({ detail: "no such asset" }, { status: 404 });
        }
      }),

      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
