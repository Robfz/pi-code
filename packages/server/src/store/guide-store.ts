/**
 * Stored PR guides (design/11-pr-guide.md, "Store"): one JSON file per PR diff under
 * `<dataDir>/guides/`, keyed by `owner/repo#N@<baseSha>..<headSha>` (plus the folder the diff is
 * read from, below the top level), so every conversation pinned to the same diff shares it.
 */
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PrGuide, PrGuideStatus } from "@pi-code/protocol";
import { GUIDE_VERSION, isGuide } from "../pr/guide-format.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.ts";

export const GUIDES_DIR = "guides";

/** What identifies a PR diff. */
export interface GuideKeyParts {
  /** `owner/name`. */
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  /**
   * The folder the diff is read from, relative to the repository's top level (`""` or absent
   * there): below it, the diff holds only that folder's changes, with paths relative to it.
   */
  folder?: string;
}

/** `owner/repo#N@<baseSha>..<headSha>`, then `:<folder>` below the top level. */
export function guideKey({ repo, number, baseSha, headSha, folder }: GuideKeyParts): string {
  return `${repo}#${number}@${baseSha}..${headSha}${folder ? `:${folder}` : ""}`;
}

/**
 * The key's file name: its SHA-256, so the name is safe and short whatever the key holds (a key
 * spelled out can pass the file system's 255-byte name limit). The file itself names the PR diff.
 */
function fileName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

/** A stored guide as read: usable, or why not. */
export type StoredGuide = Exclude<PrGuideStatus, { state: "generating" }>;

export class GuideStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, GUIDES_DIR);
  }

  /**
   * The guide stored for `key`; `undefined` when there is none. A file of another format
   * version, or one that can't be read, is a failure the user retries.
   */
  async read(key: string): Promise<StoredGuide | undefined> {
    let data: unknown;
    try {
      data = await readJsonFile(join(this.dir, fileName(key)));
    } catch (e) {
      return {
        state: "failed",
        error: `the stored guide can't be read (${(e as Error).message}); retry`,
      };
    }
    if (data === undefined) return undefined;
    if (typeof data !== "object" || data === null) {
      return { state: "failed", error: "the stored guide is malformed; retry" };
    }
    const value = data as Record<string, unknown>;
    if (value.version !== GUIDE_VERSION) {
      return { state: "failed", error: "guide format is outdated; retry" };
    }
    if (!isGuide(value)) return { state: "failed", error: "the stored guide is malformed; retry" };
    return { state: "ready", guide: value as unknown as PrGuide };
  }

  /** Stores `guide` for `key`, replacing any guide stored for it. */
  write(key: string, guide: PrGuide): Promise<void> {
    return writeJsonFileAtomic(join(this.dir, fileName(key)), guide);
  }

  delete(key: string): Promise<void> {
    return rm(join(this.dir, fileName(key)), { force: true });
  }

  /**
   * Deletes every stored guide but those of `keepKeys`, built like any key (`guideKey`), the
   * folder included.
   */
  async prune(keepKeys: Iterable<string>): Promise<void> {
    const keep = new Set([...keepKeys].map(fileName));
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json") && !keep.has(name))
        .map((name) => rm(join(this.dir, name), { force: true })),
    );
  }
}
