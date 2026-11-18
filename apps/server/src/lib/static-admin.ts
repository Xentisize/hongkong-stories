import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Serve the admin SPA's entry document.
 *
 * The SPA build lands in `public/admin/` and Vite serves its assets statically, but nothing answers
 * `/admin/` itself: a directory request is redirected to `/admin`, which is not a file, so the app
 * was unreachable at its own URL. FastAPI used to paper over this with `StaticFiles(html=True)`;
 * with that gone, the entry document needs a handler.
 *
 * Assets are left to the static pipeline — this only answers the application URLs, so a missing
 * asset still 404s instead of silently returning HTML (which breaks fonts and JS with a content-type
 * error rather than a clear miss).
 */

export function adminStaticDir(): string {
  return process.env["HKS_ADMIN_STATIC"] ?? join(process.cwd(), "public", "admin");
}

export async function serveAdminIndex(): Promise<Response> {
  try {
    const html = await readFile(join(adminStaticDir(), "index.html"));
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The SPA is rebuilt on deploy; a cached shell pointing at rotated asset hashes is worse
        // than a round trip.
        "cache-control": "no-cache",
      },
    });
  } catch {
    return Response.json({ detail: "admin build not found — run `bun run build` in admin/" }, { status: 503 });
  }
}
