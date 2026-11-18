#!/usr/bin/env bun
/**
 * Synthesize placeholder ambience loops (PLAN §10.4 audio budget: < 8 MB total).
 *
 * Pure synthesis in Node — layered sines and shaped noise at 22.05 kHz mono — written as 16-bit WAV
 * into client/assets/audio/, then converted to OGG when an ffmpeg is available (OGG is ~10x smaller
 * and the Audio autoload loops AudioStreamOggVorbis natively). These are placeholders: real
 * recordings replace them without touching any code, because the content `music` fields already
 * reference these names.
 *
 * Determinism note: each recipe is seeded from its name, so regenerating an unchanged tool produces
 * an unchanged file. The generator is not byte-identical to the Python one it replaced — a different
 * PRNG means different noise — which is irrelevant for placeholders but worth knowing before
 * comparing output.
 *
 * Usage: bun tools/gen_placeholder_audio.ts [--ogg] [--root DIR]
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RATE = 22050;
const SECONDS = 18;

type Layer = (samples: Float64Array, rng: () => number) => Float64Array;

/** mulberry32 — small, fast, deterministic, and seeded from the recipe name. */
function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hum(freq: number, level: number, lfoRate = 0.1, lfoDepth = 0.3): Layer {
  return (samples, rng) => {
    const phase = rng() * 6.28;
    const n = samples.length;
    for (let i = 0; i < n; i += 1) {
      const t = i / RATE;
      const wobble = 1 + lfoDepth * Math.sin(2 * Math.PI * lfoRate * t + phase);
      samples[i]! += level * wobble * Math.sin(2 * Math.PI * freq * t);
    }
    return samples;
  };
}

/** Brown-ish noise: one-pole smoothed white noise, slowly swelled. */
function noise(level: number, cutoff = 0.08, lfoRate = 0.05, lfoDepth = 0.5): Layer {
  return (samples, rng) => {
    let state = 0;
    const n = samples.length;
    for (let i = 0; i < n; i += 1) {
      const t = i / RATE;
      const target = level * (1 + lfoDepth * Math.sin(2 * Math.PI * lfoRate * t));
      state += (rng() * 2 - 1 - state) * cutoff;
      samples[i]! += target * state;
    }
    return samples;
  };
}

/** Short frequency-swept chirps — sparrows around a market, or a fan belt in distress. */
function chirps(level: number, every: number): Layer {
  return (samples, rng) => {
    const n = samples.length;
    let i = Math.floor(rng() * (n - RATE * 0.5)) + RATE;
    while (i < n - RATE) {
      const length = Math.floor(RATE * (0.08 + rng() * 0.17));
      const base = 1800 + rng() * 1600;
      for (let j = 0; j < length && i + j < n; j += 1) {
        const t = j / RATE;
        const sweep = base + 500 * Math.sin(2 * Math.PI * 6 * t);
        const envelope = Math.sin((Math.PI * j) / length);
        samples[i + j]! += level * envelope * Math.sin(2 * Math.PI * sweep * t);
      }
      i += Math.floor(RATE * (every * 0.6 + rng() * every));
    }
    return samples;
  };
}

// name -> layered recipe. 2027: traffic hum under market murmur and pigeons.
// 1955: busier murmur and more birds. 1963: machine halls and a dripping tap.
const RECIPES: Record<string, Layer[]> = {
  ssp_2027: [noise(0.1, 0.05, 0.03, 0.5), hum(110, 0.05), hum(220, 0.02), chirps(0.05, 6)],
  ssp_cct_2027: [noise(0.07, 0.1, 0.04, 0.4), hum(150, 0.03)],
  ssp_flat_2027: [hum(100, 0.03), noise(0.02, 0.03, 0.02, 0.3)],
  kln_1955: [noise(0.11, 0.06, 0.04, 0.5), hum(90, 0.04), chirps(0.09, 4)],
  kln_1963: [hum(100, 0.09, 0.15, 0.2), hum(200, 0.05), hum(300, 0.03), noise(0.05, 0.2, 0.1, 0.3)],
};

function synth(name: string, recipe: Layer[]): Float64Array {
  const rng = seededRandom(name);
  const n = RATE * SECONDS;
  let samples = new Float64Array(n);
  for (const layer of recipe) samples = layer(samples, rng);

  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const scale = peak === 0 ? 0 : 0.6 / peak;
  for (let i = 0; i < n; i += 1) samples[i]! *= scale;
  return samples;
}

/** 16-bit mono WAV: 44-byte canonical header, then little-endian PCM. */
function wavBytes(samples: Float64Array): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-32767, Math.min(32767, Math.round(samples[i]! * 32767)));
    buffer.writeInt16LE(clamped, 44 + i * 2);
  }
  return buffer;
}

function findFfmpeg(): string | null {
  const probe = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();

  const candidate = join(
    process.env["HOME"] ?? "",
    ".cache/ms-playwright/ffmpeg-1013/ffmpeg-linux",
  );
  return existsSync(candidate) ? candidate : null;
}

const argv = process.argv.slice(2);
const wantOgg = argv.includes("--ogg");
const rootFlag = argv.indexOf("--root");
const root = rootFlag >= 0 && argv[rootFlag + 1] ? argv[rootFlag + 1]! : join(import.meta.dir, "..");
const outDir = join(root, "client", "assets", "audio");

await mkdir(outDir, { recursive: true });
const ffmpeg = findFfmpeg();

for (const [name, recipe] of Object.entries(RECIPES)) {
  const wavPath = join(outDir, `${name}.wav`);
  await writeFile(wavPath, wavBytes(synth(name, recipe)));
  let size = statSync(wavPath).size;

  if (wantOgg && ffmpeg) {
    const oggPath = join(outDir, `${name}.ogg`);
    const result = spawnSync(ffmpeg, [
      "-y", "-loglevel", "error", "-i", wavPath,
      "-c:a", "libvorbis", "-qscale:a", "2", oggPath,
    ]);
    if (result.status !== 0) {
      console.error(`ffmpeg failed for ${name}: ${result.stderr?.toString() ?? ""}`);
      continue;
    }
    await rm(wavPath, { force: true });
    size = statSync(oggPath).size;
    console.log(`wrote ${oggPath} (${size} bytes, ogg)`);
  } else {
    console.log(`wrote ${wavPath} (${size} bytes, wav)`);
  }
}

const total = (await readdir(outDir)).reduce(
  (sum, file) => sum + statSync(join(outDir, file)).size,
  0,
);
console.log(`audio budget check: ${(total / 1_000_000).toFixed(1)} MB total`);
