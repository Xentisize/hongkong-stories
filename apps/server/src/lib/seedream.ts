/**
 * OpenRouter images client (PLAN 2, 8.1), ported from `server/app/services`-era
 * `server/app/assets/seedream.py`.
 *
 * `POST /v1/images` with the dedicated image contract — `{model, prompt, resolution,
 * aspect_ratio, background, seed, input_references}` responding with `data[].b64_json` and
 * `usage.cost` — not the legacy chat/completions modalities route. The key never leaves this
 * process, and every failure surfaces as a `SeedreamError` the admin route turns into a 502 with a
 * code the SPA can show, never a raised 500 with the payload attached.
 */

const IMAGE_URL = "https://openrouter.ai/api/v1/images";
/** Image renders are slower than chat turns; the chat upstream timeout does not apply here. */
const IMAGE_TIMEOUT_MS = 90_000;

export class SeedreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SeedreamError";
  }
}

export interface GeneratedImage {
  png: Buffer;
  seed: number;
  costUsd: number;
}

export interface GenerateImageOptions {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  background: string;
  seed?: number;
  /** Chat-style image parts: `{type: "image_url", image_url: {url}}`, not bare strings. */
  inputReferences?: unknown[];
}

/**
 * Image model slugs. The server reads `HKS_IMAGE_MODEL`; an operator's `.env` may use
 * `IMAGE_GENERATION_MODEL`, so that is honoured as a fallback rather than silently ignored.
 */
export function imageModel(): string {
  return (
    process.env.HKS_IMAGE_MODEL ??
    process.env.IMAGE_GENERATION_MODEL ??
    "bytedance-seed/seedream-5-0-flash"
  );
}

export function imageModelTransparent(): string {
  return (
    process.env.HKS_IMAGE_MODEL_TRANSPARENT ??
    process.env.HKS_IMAGE_MODEL ??
    "bytedance-seed/seedream-5-5"
  );
}

export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage> {
  if (!options.apiKey) throw new SeedreamError("no_api_key", "OPENROUTER_API_KEY is not configured");

  const payload: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    resolution: "1K", // 2K costs more and buys nothing after downscaling (PLAN 8.1)
    aspect_ratio: options.aspectRatio,
    background: options.background,
  };
  if (options.seed !== undefined && options.seed !== null) payload["seed"] = Math.trunc(options.seed);
  // Consistency mechanism (PLAN 8.2): reference images arrive as data URLs built by the route from
  // pack files.
  if (options.inputReferences && options.inputReferences.length > 0) {
    payload["input_references"] = options.inputReferences;
  }

  let response: Response;
  try {
    response = await fetch(IMAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SeedreamError("upstream_unreachable", `images request failed: ${String(error)}`);
  }

  if (!response.ok) {
    // Surface the upstream body (truncated): "what did the images endpoint refuse" is the first
    // question every authoring failure asks, and the key is never in an error body.
    const body = (await response.text().catch(() => "")).slice(0, 400);
    throw new SeedreamError(`upstream_http_${response.status}`, body);
  }

  const data = (await response.json().catch(() => ({}))) as {
    data?: Array<{ b64_json?: string; seed?: number }>;
    usage?: { cost?: number };
  };

  const first = Array.isArray(data.data) ? data.data[0] : undefined;
  if (!first || typeof first.b64_json !== "string" || first.b64_json.length === 0) {
    throw new SeedreamError("empty_response", "images endpoint returned no image");
  }

  let png: Buffer;
  try {
    png = Buffer.from(first.b64_json, "base64");
  } catch (error) {
    throw new SeedreamError("bad_payload", `images endpoint returned undecodable data: ${String(error)}`);
  }

  return {
    png,
    seed: Number(first.seed ?? payload["seed"] ?? 0),
    costUsd: Number(data.usage?.cost ?? 0),
  };
}
