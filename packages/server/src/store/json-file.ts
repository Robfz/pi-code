import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Reads and parses a JSON file; `undefined` when it doesn't exist. Other errors propagate. */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return JSON.parse(text) as unknown;
}

/**
 * Writes `value` as JSON atomically: to a temp file in the same directory (created with
 * `0700` if missing), then renamed over `path`. The file gets `mode` (default `0600`).
 */
export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
