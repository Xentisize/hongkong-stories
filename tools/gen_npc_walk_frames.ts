#!/usr/bin/env bun
/**
 * Generate NPC walk frames through the real art pipeline (PLAN 8).
 *
 * The offline twin of `POST /v1/admin/art/generate`: same post-processor, same provenance sidecar,
 * no admin token needed. It exists because the art pipeline is the only thing that produces
 * game-ready 26x34 cells, and driving it by hand for eight frames per character is how a cast ends
 * up inconsistent.
 *
 * Frame naming matches `tools/assemble_npc_sheet.ts`:
 *   <npc_id>_walk_<down|right|left|up>_<stand|step>.png
 *
 * ## Consistency: two mechanisms, because one was not enough
 *
 * A first run generated every frame independently from text alone, and a vision review plus a
 * follow-up measurement both rejected it: clothing, proportions and apparent scale drifted, and one
 * frame rendered so faintly its silhouette collapsed. So:
 *
 * 1. **Identity anchor.** The first frame (down/stand) is generated with only the style bible, then
 *    that accepted frame is attached as an extra input reference for the other seven. The design is
 *    pinned by an image, not by re-describing it seven times.
 * 2. **Result gate + retry.** `processArt` crops to the alpha bbox and force-resizes, so a faint
 *    render silently becomes a small figure instead of an error. Each frame is checked after
 *    processing and regenerated with a bumped seed if the silhouette does not fill most of the cell.
 *
 * Usage: bun tools/gen_npc_walk_frames.ts <npc_id> --desc "..." [--seed N] [--dry-run]
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import sharp from "sharp";

import { PALETTE_NAME } from "../apps/server/src/lib/palette";
import { processArt } from "../apps/server/src/lib/pixelate";
import { generateImage, imageModel, imageModelTransparent } from "../apps/server/src/lib/seedream";
import { TARGETS, buildPrompt } from "../apps/server/src/lib/templates";
import { COLUMNS, ROWS } from "./lib/sheets";

const ROOT = join(import.meta.dir, "..");
const CONTENT = join(ROOT, "client", "content");
const ART = join(CONTENT, "art", "npcs");

/** The anchor frame is generated first and then referenced by every other frame. */
const ANCHOR: readonly [string, string] = ["down", "stand"];

/** A usable cell's silhouette should fill most of 26x34; a faint render survives as a small blob. */
const MIN_FILL = 0.75;
const MIN_COVERAGE = 0.1;
const MAX_COVERAGE = 0.95;
const MAX_ATTEMPTS = 3;

const VIEW: Record<string, string> = {
  down: "facing the viewer",
  right: "side view facing right",
  left: "side view facing left",
  up: "back view",
};

function poseClause(direction: string, pose: string): string {
  if (pose === "step") return "mid-step walking with one leg forward";
  if (direction === "down") return "standing still, arms relaxed";
  return "standing still";
}

/** Minimal .env reader — no dotenv dependency for a build-time tool. */
async function readEnv(): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = await readFile(join(ROOT, ".env"), "utf8");
  } catch {
    return values;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const at = trimmed.indexOf("=");
    values[trimmed.slice(0, at).trim()] = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return values;
}

function buildFramePrompt(character: string, direction: string, pose: string, anchored: boolean): string {
  const same = anchored ? "the same character as the reference image, " : "";
  const desc =
    "EXACTLY ONE cute chibi character, single figure centered: " +
    `${same}${character}, big head small body, ${VIEW[direction]}, ` +
    `${poseClause(direction, pose)}, full body, no duplicates, no sheet layout, ` +
    "plain transparent background";
  return buildPrompt("sprite", desc);
}

async function dataUrl(path: string): Promise<{ url: string; ref: unknown } | null> {
  try {
    const bytes = await readFile(path);
    return {
      ref: { type: "image_url", image_url: { url: "data:image/png;base64," + bytes.toString("base64") } },
      url: path,
    };
  } catch {
    return null;
  }
}

/** Reject frames whose figure failed to render into a usable silhouette. */
async function silhouetteOk(png: Buffer, cell: readonly [number, number]): Promise<{ ok: boolean; detail: string }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3]! < 128) continue;
      opaque += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return { ok: false, detail: "empty alpha" };

  const fillW = (maxX - minX + 1) / cell[0];
  const fillH = (maxY - minY + 1) / cell[1];
  const ink = opaque / (cell[0] * cell[1]);
  const detail = `fill ${fillW.toFixed(2)}x${fillH.toFixed(2)} ink ${Math.round(ink * 100)}%`;

  if (fillW < MIN_FILL || fillH < MIN_FILL) return { ok: false, detail: `silhouette too small (${detail})` };
  if (ink < MIN_COVERAGE || ink > MAX_COVERAGE) return { ok: false, detail: `ink coverage out of band (${detail})` };
  return { ok: true, detail };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const positional = argv.filter((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  const npcId = positional[0];
  const descFlag = argv.indexOf("--desc");
  const desc = descFlag >= 0 ? (argv[descFlag + 1] ?? "").trim() : "";
  const seedFlag = argv.indexOf("--seed");
  const baseSeed = seedFlag >= 0 ? Number(argv[seedFlag + 1]) : undefined;
  const dryRun = argv.includes("--dry-run");

  if (!npcId || !desc) {
    console.error('usage: bun tools/gen_npc_walk_frames.ts <npc_id> --desc "..." [--seed N] [--dry-run]');
    return 2;
  }

  const env = await readEnv();
  const apiKey = env["OPENROUTER_API_KEY"] ?? process.env["OPENROUTER_API_KEY"] ?? "";
  const model = env["HKS_IMAGE_MODEL"] ?? env["IMAGE_GENERATION_MODEL"] ?? imageModel();

  const frames = COLUMNS.flatMap((direction) => ROWS.map((pose) => ({ direction, pose })));

  if (dryRun) {
    console.log(`model: ${model}`);
    console.log(`frames: ${frames.length} (anchor ${ANCHOR[0]}/${ANCHOR[1]} generated first)`);
    for (const { direction, pose } of frames) {
      const anchored = direction !== ANCHOR[0] || pose !== ANCHOR[1];
      console.log(`\n--- ${npcId}_walk_${direction}_${pose} (anchor ref: ${anchored})`);
      console.log(buildFramePrompt(desc, direction, pose, anchored));
    }
    return 0;
  }

  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set in .env");
    return 2;
  }

  const bible = await dataUrl(join(CONTENT, "art", "stylebible.png"));
  const [, target, background] = TARGETS.sprite;
  const cell: readonly [number, number] = [target[0] + 2, target[1] + 2];

  await mkdir(ART, { recursive: true });

  let totalCost = 0;
  const failures: string[] = [];
  let anchorPng: Buffer | null = null;
  let anchorPath = "";

  for (const { direction, pose } of frames) {
    const subject = `${npcId}_walk_${direction}_${pose}`;
    const isAnchor = direction === ANCHOR[0] && pose === ANCHOR[1];
    const anchored = !isAnchor && anchorPng !== null;
    const prompt = buildFramePrompt(desc, direction, pose, anchored);

    const referencePaths: string[] = [];
    const references: unknown[] = [];
    if (bible) {
      references.push(bible.ref);
      referencePaths.push("art/stylebible.png");
    }
    if (anchored && anchorPng) {
      references.push({
        type: "image_url",
        image_url: { url: "data:image/png;base64," + anchorPng.toString("base64") },
      });
      referencePaths.push(anchorPath);
    }

    const selectedModel =
      references.length === 0 && background === "transparent" ? imageModelTransparent() : model;

    let processed: Buffer | null = null;
    let seedUsed: number | undefined;
    let seedReturned = 0;
    let cost = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const attemptSeed = baseSeed === undefined ? undefined : baseSeed + (attempt - 1);
      try {
        const generated = await generateImage({
          apiKey,
          model: selectedModel,
          prompt,
          aspectRatio: TARGETS.sprite[0],
          background,
          seed: attemptSeed,
          inputReferences: references,
        });
        cost = generated.costUsd;
        seedReturned = generated.seed;
        totalCost += cost;

        const candidate = await processArt(generated.png, target, { outline: true, pad: 0 });
        const verdict = await silhouetteOk(candidate, cell);
        seedUsed = attemptSeed;

        if (verdict.ok) {
          processed = candidate;
          console.log(`wrote ${subject}  seed=${attemptSeed}  ${verdict.detail}  $${cost.toFixed(4)}`);
          break;
        }
        console.error(`  attempt ${attempt}: ${subject} rejected — ${verdict.detail}`);
      } catch (error) {
        console.error(`  attempt ${attempt} failed for ${subject}: ${String(error)}`);
      }
    }

    if (!processed) {
      failures.push(subject);
      continue;
    }

    const out = join(ART, `${subject}.png`);
    await writeFile(out, processed);

    const now = new Date();
    const provenance = {
      prompt_id: `gen_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`,
      model: selectedModel,
      // The images endpoint does not reliably echo the seed it was given, so record both what was
      // asked for (what "regenerate exactly" needs) and what came back.
      seed: seedUsed ?? null,
      seed_returned: seedReturned,
      resolution: "1K",
      aspect_ratio: TARGETS.sprite[0],
      background,
      input_references: referencePaths,
      post: { palette: PALETTE_NAME, target_px: [...target], outline: true, pad: 0 },
      cost_usd: cost,
      accepted_by: "tools/gen_npc_walk_frames",
      ts: now.toISOString(),
      prompt,
    };
    await writeFile(
      out.replace(/\.png$/, ".gen.json"),
      JSON.stringify(provenance, null, 2) + "\n",
      "utf8",
    );

    if (isAnchor) {
      anchorPng = processed;
      anchorPath = `art/npcs/${subject}.png`;
    }
  }

  console.log(`\ntotal cost: $${totalCost.toFixed(4)}   failures: ${failures.length}`);
  if (failures.length > 0) {
    console.error("failed frames: " + failures.join(", "));
    return 1;
  }
  return 0;
}

process.exit(await main());
