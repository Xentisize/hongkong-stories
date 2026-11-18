#!/usr/bin/env bun
/**
 * Runs the TypeScript art post-processor over a set of cases so `tools/compare_pixelate.py` can
 * diff it against the Pillow original. Not shipped: a verification harness for the port.
 *
 * Usage: bun tools/pixelate_parity.ts <plan.json>
 *
 * The plan is written by the Python side and carries, per case, the input PNG path, the pixel
 * target and the outline/pad flags — so both implementations are given identical instructions.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { processArt } from "../apps/server/src/lib/pixelate";

interface Case {
  name: string;
  png: string;
  target: [number, number];
  outline: boolean;
  pad: number;
}

interface Plan {
  out_dir: string;
  cases: Case[];
}

const planPath = process.argv[2];
if (!planPath) {
  console.error("usage: bun tools/pixelate_parity.ts <plan.json>");
  process.exit(2);
}

const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
const outDir = join(plan.out_dir, "ts");
await mkdir(outDir, { recursive: true });

for (const testCase of plan.cases) {
  const source = await readFile(testCase.png);
  const processed = await processArt(source, testCase.target, {
    outline: testCase.outline,
    pad: testCase.pad,
  });
  const target = join(outDir, `${testCase.name}.png`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, processed);
  console.log(`ts  ${testCase.name}: ${processed.length} bytes`);
}
