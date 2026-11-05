/**
 * The conversations' PR attachments (design/10-pr-review.md, "Store"), persisted to
 * `<dataDir>/prs.json` keyed by session file, shared by every client through the live stream, and
 * mirrored by hidden refs in each repository (`refs/pi-code/pr/<number>/<sha>`).
 */
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PrAttachment, PrAttachments, PrState } from "@pi-code/protocol";
import { type PrPin, syncPrRefs } from "../git/pr.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.ts";

export const PRS_FILE = "prs.json";

/** An attachment as stored: what clients see, plus what only the server needs. */
export interface StoredPr extends PrAttachment {
  /** The repository's common git dir, where its pinned commits' refs live. */
  gitDir: string;
  /** The newest comment or review time already reported to the agent (GitHub's clock). */
  commentsSince?: string;
  /** The ids of the inline review comments already reported to the agent. */
  reportedInline?: number[];
  /** The head before the last refresh moved it, which the update prompt diffs against. */
  previousHeadSha?: string;
}

export type StoredPrs = Record<string, StoredPr>;

const STATES: readonly PrState[] = ["open", "closed", "merged"];
const STRING_FIELDS = [
  "repo",
  "title",
  "url",
  "baseRefName",
  "headRefName",
  "baseSha",
  "headSha",
  "remoteHeadSha",
  "gitDir",
] as const;

function parseEntry(value: unknown): StoredPr | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (STRING_FIELDS.some((key) => typeof v[key] !== "string")) return undefined;
  if (!Number.isSafeInteger(v.number) || !STATES.includes(v.state as PrState)) return undefined;
  const entry = { ...(v as unknown as StoredPr) };
  if (typeof v.commentsSince !== "string") delete entry.commentsSince;
  if (!Array.isArray(v.reportedInline) || !v.reportedInline.every(Number.isSafeInteger)) {
    delete entry.reportedInline;
  }
  if (typeof v.previousHeadSha !== "string") delete entry.previousHeadSha;
  return entry;
}

/** What clients see of a stored attachment. */
export function prView({
  gitDir: _dir,
  commentsSince: _since,
  reportedInline: _reported,
  previousHeadSha: _previous,
  ...pr
}: StoredPr): PrAttachment {
  return pr;
}

/** What clients see of the stored attachments. */
export function prsView(prs: StoredPrs): PrAttachments {
  return Object.fromEntries(Object.entries(prs).map(([file, pr]) => [file, prView(pr)]));
}

/** The commits `prs` pin, by repository: each PR's head, base and previous head. */
function pinsByRepo(prs: StoredPrs): Map<string, Map<string, PrPin>> {
  const repos = new Map<string, Map<string, PrPin>>();
  for (const pr of Object.values(prs)) {
    const pins = repos.get(pr.gitDir) ?? new Map<string, PrPin>();
    for (const sha of [pr.headSha, pr.baseSha, pr.previousHeadSha]) {
      if (sha === undefined) continue;
      pins.set(`${pr.number}/${sha}`, { number: pr.number, sha });
    }
    repos.set(pr.gitDir, pins);
  }
  return repos;
}

export interface PrStoreOptions {
  /**
   * Keeps an entry whose session file isn't on disk (yet): pi writes a new session's file only
   * with its first reply, so the agent holding it decides.
   */
  keep?: (sessionFile: string) => boolean;
  /** Mirrors one repository's pins as refs (default `syncPrRefs`). */
  syncRefs?: (gitDir: string, pins: Iterable<PrPin>) => Promise<void>;
}

/**
 * PR attachments by session file. An entry whose session file is gone (and not kept) is dropped
 * on load and on `prune` (each catalog refresh). Changes are applied one at a time, in arrival
 * order, written atomically, then mirrored to the refs of the repositories whose pins changed
 * (or whose last mirroring failed). Loading mirrors every repository the file names.
 */
export class PrStore {
  /** Resolves once the file is read and pruned and the refs are mirrored. */
  readonly ready: Promise<void>;
  private readonly path: string;
  private readonly keep: (sessionFile: string) => boolean;
  private readonly syncRefs: (gitDir: string, pins: Iterable<PrPin>) => Promise<void>;
  private prs: StoredPrs = {};
  private queue: Promise<unknown>;
  private readonly listeners = new Set<(prs: StoredPrs) => void>();
  /** Repositories whose last ref sync failed, synced again on the next change. */
  private readonly unsynced = new Set<string>();

  constructor(dataDir: string, opts: PrStoreOptions = {}) {
    this.path = join(dataDir, PRS_FILE);
    this.keep = opts.keep ?? (() => false);
    this.syncRefs = opts.syncRefs ?? syncPrRefs;
    this.ready = this.load();
    this.queue = this.ready;
  }

  current(): StoredPrs {
    return this.prs;
  }

  get(sessionFile: string): StoredPr | undefined {
    return this.prs[sessionFile];
  }

  /** Stores `pr` for `sessionFile`, replacing its entry. */
  set(sessionFile: string, pr: StoredPr): Promise<void> {
    return this.enqueue(() => this.commit({ ...this.prs, [sessionFile]: pr }));
  }

  /** Gives `to` (a clone) the attachment of `from`, if it has one. */
  copy(from: string, to: string): Promise<void> {
    return this.enqueue(async () => {
      const pr = this.prs[from];
      if (pr !== undefined) await this.commit({ ...this.prs, [to]: { ...pr } });
    });
  }

  /** Drops the entries whose session file no longer exists. */
  prune(): Promise<void> {
    return this.enqueue(async () => this.commit(await this.existing(this.prs)));
  }

  /** Listens to every change; returns the unsubscribe function. */
  subscribe(listener: (prs: StoredPrs) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async load(): Promise<void> {
    let data: unknown;
    try {
      data = await readJsonFile(this.path);
    } catch (e) {
      console.warn(`[prs] ignoring unreadable ${this.path}: ${(e as Error).message}`);
    }
    const stored: StoredPrs = {};
    if (typeof data === "object" && data !== null) {
      for (const [file, value] of Object.entries(data)) {
        const entry = parseEntry(value);
        if (isAbsolute(file) && entry !== undefined) stored[file] = entry;
      }
    }
    this.prs = stored;
    if (data === undefined) return;
    const kept = await this.existing(stored);
    if (JSON.stringify(kept) !== JSON.stringify(data)) {
      await this.adopt(kept).catch((e: unknown) => {
        console.warn(`[prs] failed to save ${this.path}:`, e);
      });
    }
    // The refs can lag the file: a sync failed before the restart, or the server stopped between
    // a write and its sync. The pruned entries' repositories are included, to drop their refs.
    await this.mirror(pinsByRepo(stored).keys(), pinsByRepo(this.prs));
  }

  private async existing(prs: StoredPrs): Promise<StoredPrs> {
    const entries = Object.entries(prs);
    const present = await Promise.all(
      entries.map(
        ([file]) =>
          this.keep(file) ||
          stat(file).then(
            (s) => s.isFile(),
            () => false,
          ),
      ),
    );
    return Object.fromEntries(entries.filter((_, i) => present[i]));
  }

  /**
   * Adopts `next` when it differs from the current entries and mirrors the refs of the
   * repositories whose pins changed or whose last sync failed.
   */
  private async commit(next: StoredPrs): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(this.prs)) return;
    const before = pinsByRepo(this.prs);
    await this.adopt(next);
    const after = pinsByRepo(next);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((gitDir) => {
      const pins = after.get(gitDir) ?? new Map<string, PrPin>();
      const old = before.get(gitDir) ?? new Map<string, PrPin>();
      const same = pins.size === old.size && [...pins.keys()].every((key) => old.has(key));
      return !same || this.unsynced.has(gitDir);
    });
    await this.mirror(changed, after);
  }

  /** Writes `next`, adopts it and tells the listeners. */
  private async adopt(next: StoredPrs): Promise<void> {
    await writeJsonFileAtomic(this.path, next);
    this.prs = next;
    for (const listener of this.listeners) listener(next);
  }

  /** Syncs each of `gitDirs` to its pins in `repos` (none when absent), noting failures. */
  private async mirror(
    gitDirs: Iterable<string>,
    repos: Map<string, Map<string, PrPin>>,
  ): Promise<void> {
    for (const gitDir of gitDirs) {
      try {
        await this.syncRefs(gitDir, (repos.get(gitDir) ?? new Map<string, PrPin>()).values());
        this.unsynced.delete(gitDir);
      } catch (e) {
        this.unsynced.add(gitDir);
        console.warn(`[prs] failed to update the refs in ${gitDir}: ${(e as Error).message}`);
      }
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}
