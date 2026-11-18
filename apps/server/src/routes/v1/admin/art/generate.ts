import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { isRecord, toKey } from "@hkstories/core";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { contentDir } from "@/lib/content";
import { PALETTE_NAME } from "@/lib/palette";
import { processArt } from "@/lib/pixelate";
import {
  SeedreamError,
  generateImage,
  imageModel,
  imageModelTransparent,
} from "@/lib/seedream";
import { OUTLINED, TARGETS, buildPrompt, isArtKind, packPath } from "@/lib/templates";
import { logEvent } from "@/lib/usage";

/**
 * POST /v1/admin/art/generate — generate, post-process and persist one asset (PLAN 8).
 *
 * The PNG and its provenance sidecar (§8.4: model, seed, palette, cost — "regenerate this sprite
 * exactly" must stay possible) land directly in the content pack; the admin then references the
 * returned pack-relative path from the draft it is authoring.
 *
 * This is the route that used to keep a Python interpreter alive for Pillow. The pixel work is now
 * `lib/pixelate.ts` on sharp, and its output was diffed pixel for pixel against the Pillow original
 * on every production shape before adoption.
 */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/v1/admin/art/generate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireAdmin(request);

          const apiKey = process.env.OPENROUTER_API_KEY ?? "";
          if (!apiKey) fail(503, "OPENROUTER_API_KEY is not configured");

          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "expected a JSON object");

          const kind = toKey(body["kind"] ?? "");
          if (!isArtKind(kind)) fail(400, `unknown art kind '${kind}'`);

          const subjectId = toKey(body["subject_id"] ?? "");
          if (!subjectId || subjectId.includes("/") || subjectId.startsWith(".")) {
            fail(400, "bad subject_id");
          }

          const desc = String(body["desc"] ?? "").trim();
          if (!desc) fail(422, "desc is required");

          // A seed is either a number or nothing: `Number("abc")` is NaN, and a NaN seed reaches the
          // provider as a field it cannot honour — a 502 that blames the model for our input.
          const rawSeed = body["seed"];
          const seed =
            rawSeed === undefined || rawSeed === null
              ? undefined
              : Number.isFinite(Number(rawSeed))
                ? Number(rawSeed)
                : fail(422, "seed must be a number");

          const [aspect, target, background] = TARGETS[kind];
          const outlined = OUTLINED.has(kind);
          const prompt = buildPrompt(kind, desc);
          const root = resolve(contentDir());

          // §8.2 consistency levers: the style bible rides along as input_references[0] on every
          // generation when it exists and the caller did not opt out.
          const referencePaths: string[] = [];
          if (body["use_style_bible"] !== false && (await exists(join(root, "art", "stylebible.png")))) {
            referencePaths.push("art/stylebible.png");
          }

          // Extra references must be pack-relative files: this endpoint reads and uploads them.
          const requested = Array.isArray(body["input_references"]) ? body["input_references"] : [];
          for (const entry of requested) {
            const rel = toKey(entry);
            const file = resolve(join(root, rel));
            const escaped = relative(root, file);
            if (escaped.startsWith("..") || isAbsolute(escaped)) {
              fail(400, `reference escapes the pack: ${rel}`);
            }
            if (!(await exists(file))) fail(400, `reference not found in pack: ${rel}`);
            if (!referencePaths.includes(rel)) referencePaths.push(rel);
          }

          // Live-verified wire format: each entry is a chat-style image part, not a bare string.
          const references = await Promise.all(
            referencePaths.map(async (rel) => ({
              type: "image_url" as const,
              image_url: {
                url: "data:image/png;base64," + (await readFile(join(root, rel))).toString("base64"),
              },
            })),
          );

          // Reference-less transparent subjects need the newer model (live-verified constraint);
          // reference-based and opaque generations run the default image model.
          const model =
            references.length === 0 && background === "transparent"
              ? imageModelTransparent()
              : imageModel();

          let generated;
          try {
            generated = await generateImage({
              apiKey,
              model,
              prompt,
              aspectRatio: aspect,
              background,
              seed,
              inputReferences: references,
            });
          } catch (error) {
            if (error instanceof SeedreamError) {
              return Response.json(
                { detail: { code: error.code, message: error.message } },
                { status: 502 },
              );
            }
            throw error;
          }

          // The style bible needs a transparent fringe: Seed requires the reference PNG to carry at
          // least one transparent pixel before it will honour a transparent output.
          const pad = kind === "stylebible" ? 2 : 0;
          const processed = await processArt(generated.png, target, { outline: outlined, pad });

          const packRel = packPath(kind, subjectId);
          const targetFile = join(root, packRel);
          await mkdir(dirname(targetFile), { recursive: true });
          await writeFile(targetFile, processed);

          const now = new Date();
          const promptId = `gen_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`;
          const provenance = {
            prompt_id: promptId,
            model,
            seed: generated.seed,
            resolution: "1K",
            aspect_ratio: aspect,
            background,
            input_references: referencePaths,
            post: {
              palette: PALETTE_NAME,
              target_px: [...target],
              outline: outlined,
              pad,
            },
            cost_usd: generated.costUsd,
            accepted_by: "admin",
            ts: now.toISOString(),
            prompt,
          };
          await writeFile(
            `${targetFile.replace(/\.png$/, "")}.gen.json`,
            JSON.stringify(provenance, null, 2) + "\n",
            "utf8",
          );

          await logEvent("image", { path: packRel, cost_usd: generated.costUsd });

          return Response.json({
            path: packRel,
            png_base64: processed.toString("base64"),
            seed: generated.seed,
            cost_usd: generated.costUsd,
            prompt_id: promptId,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
