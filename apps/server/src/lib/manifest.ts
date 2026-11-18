import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `client/content/manifest.json` (PLAN 5.7), the TypeScript replacement for the retired
 * `tools/gen_content_manifest.py`.
 *
 * Discovery has to be manifest-driven rather than a directory scan: an exported Godot build may
 * store `.json` as an imported resource (`item.json.remap`), which a naive scan lists under a
 * different name and then fails to read. The manifest is also what the hot-pack endpoint serves,
 * so this is the interface, not an implementation detail.
 *
 * The hash is a **wire contract**: the client compares `content_hash` against the version it
 * booted with, so the byte sequence here must match the Python generator exactly — kinds in this
 * order, file names sorted, `kind/name` then the file bytes, hex truncated to 12. A divergence
 * would be invisible until some clients refused to hot-pack.
 */

export const MANIFEST_KINDS = [
  "npcs",
  "items",
  "locations",
  "quests",
  "lore",
  "settings",
  "chapters",
] as const;

export interface ContentManifest {
  manifest_schema: number;
  version: number;
  content_hash: string;
  files: string[];
}

/**
 * Hash the pack without touching disk.
 *
 * Split from `regenerateManifest` so the content gate can ask "is the committed manifest still what
 * these bytes hash to?" — a question nobody was asking, which is how the committed hash drifted away
 * from the committed content without a single failure.
 */
export async function computeManifest(
  contentDir: string,
  options: { version?: number } = {},
): Promise<ContentManifest> {
  const files: string[] = [];
  const digest = createHash("sha256");

  for (const kind of MANIFEST_KINDS) {
    const dir = join(contentDir, kind);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // a kind with no authored files
    }

    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const relative = `${kind}/${name}`;
      files.push(relative);
      digest.update(relative, "utf8");
      digest.update(await readFile(join(dir, name)));
    }
  }

  return {
    manifest_schema: 1,
    version: options.version ?? 1,
    content_hash: digest.digest("hex").slice(0, 12),
    files,
  };
}

/**
 * Why a committed manifest no longer describes the pack, or an empty list when it does.
 *
 * Pure so the gate's rule can be tested: the failure it prevents — an author edits content, the hash
 * does not move, and every booted client keeps the old pack — is invisible without one.
 */
export function manifestDrift(
  committed: { content_hash?: unknown; files?: unknown },
  fresh: ContentManifest,
): string[] {
  const drift: string[] = [];

  if (committed.content_hash !== fresh.content_hash) {
    drift.push(`content_hash ${String(committed.content_hash)} ≠ ${fresh.content_hash}`);
  }
  if (JSON.stringify(committed.files) !== JSON.stringify(fresh.files)) {
    drift.push(`the file list differs (${fresh.files.length} files hashed)`);
  }

  return drift;
}

export async function regenerateManifest(
  contentDir: string,
  options: { bump: boolean } = { bump: false },
): Promise<ContentManifest> {
  const manifestPath = join(contentDir, "manifest.json");

  let version = 1;
  if (options.bump) {
    try {
      const existing = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
      version = Number(existing.version ?? 0) + 1;
    } catch {
      version = 1; // no manifest yet: start at 1
    }
  }

  const manifest = await computeManifest(contentDir, { version });

  await mkdir(contentDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

/**
 * Order-independent serialisation for comparing two entities.
 *
 * `publish_preview` must answer "is this draft different from the baseline?", and raw
 * `JSON.stringify` would report a difference for key reordering that carries no meaning.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
