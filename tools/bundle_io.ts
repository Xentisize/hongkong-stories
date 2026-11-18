/**
 * Filesystem and zip plumbing for the bundle tools.
 *
 * Kept apart from `bundle.ts` so the verification rules stay pure and testable without a 7 MB
 * archive. Everything platform-specific lives here: hashing, staging, and the zip/unzip calls.
 *
 * The zip step shells out to `zip`/`unzip` rather than using a library. Both ship with macOS and
 * every Linux CI image, the flag set is small and explicit, and a bundling tool that cannot run on a
 * machine without the CLI should say so in one place instead of failing inside a dependency.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface StagedFile {
  /** Bundle-relative path, e.g. `content/items/x.json`. */
  path: string;
  bytes: Uint8Array;
}

/** Write staged files under a directory, creating parents. */
export async function stageFiles(root: string, files: StagedFile[]): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Zip a staged directory. `-X` drops extra file attributes so the archive depends only on content. */
export async function zipDirectory(directory: string, output: string): Promise<void> {
  const result = Bun.spawnSync(["zip", "-r", "-q", "-X", output, "."], { cwd: directory });
  if (result.exitCode !== 0) {
    throw new Error(`zip failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  }
}

/** Unpack an archive into a directory that already exists. */
export async function unzipInto(archive: string, directory: string): Promise<void> {
  const result = Bun.spawnSync(["unzip", "-q", "-o", archive, "-d", directory]);
  if (result.exitCode !== 0) {
    throw new Error(`unzip failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  }
}

/** A reader over an unpacked bundle directory, for `verifyBundle`. */
export function directoryReader(root: string) {
  return {
    has: (path: string) => exists(join(root, path)),
    read: async (path: string): Promise<Uint8Array | null> => {
      try {
        return new Uint8Array(await readFile(join(root, path)));
      } catch {
        return null;
      }
    },
    digest: sha256Hex,
  };
}

/**
 * `verifyBundle` with a synchronous reader.
 *
 * The pure verifier takes read() returning bytes directly; reading a 7 MB archive one file at a time
 * is fast enough that an async reader would only add plumbing, so the directory is indexed once.
 */
export async function readDirectoryIndex(root: string): Promise<{
  has: (path: string) => boolean;
  read: (path: string) => Uint8Array | null;
  digest: (bytes: Uint8Array) => string;
  files: string[];
}> {
  const listing = [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })].sort();
  const cache = new Map<string, Uint8Array>();
  for (const relative of listing) cache.set(relative, new Uint8Array(await readFile(join(root, relative))));

  return {
    has: (path) => cache.has(path),
    read: (path) => cache.get(path) ?? null,
    digest: sha256Hex,
    files: listing,
  };
}
