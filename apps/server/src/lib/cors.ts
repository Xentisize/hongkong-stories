/**
 * CORS for the routes a browser talks to directly (PLAN 10.3).
 *
 * The game client is served from Pages while this API runs on a container, so the responses are
 * cross-origin and `/v1/session` and `/v1/chat` spend real money — the allowance is an explicit
 * list, never `*`.
 *
 * A request from an origin that is not on the list gets **no** `Access-Control-Allow-Origin`
 * header at all rather than a different origin substituted in: the browser blocks either way,
 * but omitting it keeps the response honest about who it was for, and a stray
 * `allow-origin: <someone else>` reads like a misconfiguration to whoever debugs it next.
 */

/** The Python default: the local preview server and the Vite dev server. */
const DEFAULT_ORIGINS = [
  "http://localhost:8099",
  "http://127.0.0.1:8099",
  "http://localhost:5173",
];

export function allowedOrigins(): string[] {
  const raw = process.env.HKS_ALLOWED_ORIGINS;
  if (raw === undefined) return DEFAULT_ORIGINS;
  const list = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ORIGINS;
}

/** Attach the CORS headers this request is entitled to. */
export function applyCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.append("vary", "origin");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "600");

  const origin = request.headers.get("origin");
  if (origin && allowedOrigins().includes(origin)) {
    headers.set("access-control-allow-origin", origin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type HandlerContext = { request: Request };
type Handler = (context: HandlerContext) => Promise<Response> | Response;

/**
 * Wrap a route handler so every return path carries the right headers.
 *
 * Wrapping beats adding `applyCors` to each `return`: these handlers have several early-exit
 * error paths, and one missed branch is a bug that only shows up in the browser.
 */
export function withCors(handler: Handler): Handler {
  return async (context) => applyCors(await handler(context), context.request);
}

/** An empty 204 for the preflight, carrying the same allowance rules. */
export function preflight(request: Request): Response {
  return applyCors(new Response(null, { status: 204 }), request);
}
