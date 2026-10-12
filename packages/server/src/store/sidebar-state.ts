/**
 * The sidebar's pins and collapsed groups (design/05-desktop.md, "Sidebar state"), persisted to
 * `<dataDir>/sidebar.json` and shared by every client through the live stream.
 */
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  applySidebarPatch,
  SIDEBAR_KEYS,
  type SidebarPatch,
  type SidebarState,
} from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.ts";

export const SIDEBAR_FILE = "sidebar.json";

/** The `paths` that are directories on disk. */
async function directories(paths: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>();
  await Promise.all(
    paths.map((path) =>
      stat(path).then(
        (s) => {
          if (s.isDirectory()) present.add(path);
        },
        () => {},
      ),
    ),
  );
  return present;
}

function paths(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((p): p is string => typeof p === "string" && isAbsolute(p)))]
    : [];
}

/** Validates a `PATCH /api/sidebar` body; throws `invalid_body`. */
export function parseSidebarPatch(value: unknown): SidebarPatch {
  const invalid = () =>
    new ApiError(
      "invalid_body",
      "expected { pinned?: Record<path, boolean>, collapsed?: Record<path, boolean> } with absolute paths",
    );
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !(SIDEBAR_KEYS as string[]).includes(key))) throw invalid();
  const patch: SidebarPatch = {};
  for (const key of SIDEBAR_KEYS) {
    const flags = body[key];
    if (flags === undefined) continue;
    if (typeof flags !== "object" || flags === null || Array.isArray(flags)) throw invalid();
    const entries = Object.entries(flags);
    if (entries.some(([path, on]) => !isAbsolute(path) || typeof on !== "boolean")) {
      throw invalid();
    }
    patch[key] = Object.fromEntries(entries) as Record<string, boolean>;
  }
  return patch;
}

/**
 * Pins and collapsed groups, keyed by path. An entry whose directory is gone is dropped: on load,
 * on `prune` (each catalog refresh) and when a patch would add it. Changes are applied one at a
 * time, in arrival order, and written atomically.
 */
export class SidebarStateStore {
  /** Resolves once the file is read and pruned. */
  readonly ready: Promise<void>;
  private readonly path: string;
  private state: SidebarState = { pinned: [], collapsed: [] };
  private queue: Promise<unknown>;
  private readonly listeners = new Set<(state: SidebarState) => void>();

  constructor(dataDir: string) {
    this.path = join(dataDir, SIDEBAR_FILE);
    this.ready = this.load();
    this.queue = this.ready;
  }

  current(): SidebarState {
    return this.state;
  }

  /** Applies `patch`; resolves with the resulting state. */
  update(patch: SidebarPatch): Promise<SidebarState> {
    return this.enqueue(async () => {
      await this.commit(applySidebarPatch(this.state, await withoutMissingAdds(patch)));
      return this.state;
    });
  }

  /** Drops the entries whose directory no longer exists. */
  prune(): Promise<void> {
    return this.enqueue(async () => {
      await this.commit(await this.existing(this.state));
    });
  }

  /** Listens to every change; returns the unsubscribe function. */
  subscribe(listener: (state: SidebarState) => void): () => void {
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
      console.warn(`[sidebar] ignoring unreadable ${this.path}: ${(e as Error).message}`);
    }
    const record =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const stored = { pinned: paths(record.pinned), collapsed: paths(record.collapsed) };
    this.state = await this.existing(stored);
    if (data !== undefined && !sameState(this.state, stored)) {
      await writeJsonFileAtomic(this.path, this.state).catch((e: unknown) => {
        console.warn(`[sidebar] failed to save ${this.path}:`, e);
      });
    }
  }

  private async existing(state: SidebarState): Promise<SidebarState> {
    const present = await directories([...new Set([...state.pinned, ...state.collapsed])]);
    return {
      pinned: state.pinned.filter((p) => present.has(p)),
      collapsed: state.collapsed.filter((p) => present.has(p)),
    };
  }

  /** Adopts `next` when it differs, once written, and tells the listeners. */
  private async commit(next: SidebarState): Promise<void> {
    if (sameState(next, this.state)) return;
    await writeJsonFileAtomic(this.path, next);
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** `patch` without the paths it would add whose directory doesn't exist. */
async function withoutMissingAdds(patch: SidebarPatch): Promise<SidebarPatch> {
  const flags = SIDEBAR_KEYS.flatMap((key) => Object.entries(patch[key] ?? {}));
  const present = await directories(flags.flatMap(([path, on]) => (on ? [path] : [])));
  const kept: SidebarPatch = {};
  for (const key of SIDEBAR_KEYS) {
    const entries = Object.entries(patch[key] ?? {});
    kept[key] = Object.fromEntries(entries.filter(([path, on]) => !on || present.has(path)));
  }
  return kept;
}

function sameState(a: SidebarState, b: SidebarState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
