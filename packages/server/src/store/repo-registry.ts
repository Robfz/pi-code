/**
 * The layout repos pi-code has seen (design/11-pr-guide.md, "Repo registry"): every `<repo>/main`
 * repo of a session or a pin, with the GitHub repo its main checkout's `origin` names, persisted
 * to `<dataDir>/repos.json`, a cache rebuilt from the sessions and pins. A pasted PR URL finds its
 * local repo here.
 */
import { isAbsolute, join } from "node:path";
import type { RepoLayout, SidebarView, StreamedSession } from "@pi-code/protocol";
import { mainCheckoutIn } from "../catalog/layout.ts";
import { originRepo } from "../git/pr.ts";
import type { StreamHub } from "../live/stream-hub.ts";
import { sameRepo } from "../pr/github.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.ts";

export const REPOS_FILE = "repos.json";

/** A layout repo: its container and main checkout. */
export interface SeenRepo {
  repo: string;
  main: string;
}

export interface RegisteredRepo extends SeenRepo {
  /** `owner/name` of the main checkout's `origin`. */
  github: string;
}

/** What the registry reads from the live listings. */
interface Listings {
  sessions: readonly Pick<StreamedSession, "layout">[];
  sidebar: Pick<SidebarView, "mains">;
}

/** The layout repos of `listings`: each session's, and each pinned repo's. */
export function seenRepos({ sessions, sidebar }: Listings): SeenRepo[] {
  const layouts = sessions.flatMap((s): RepoLayout[] => (s.layout === undefined ? [] : [s.layout]));
  return [
    ...layouts.map(({ repo, main }) => ({ repo, main })),
    ...Object.entries(sidebar.mains).map(([repo, main]) => ({ repo, main })),
  ];
}

/** `origin`'s GitHub repo in `main`, or `undefined` (no origin, not GitHub, git failing). */
async function githubOf(main: string): Promise<string | undefined> {
  return originRepo(main).catch(() => undefined);
}

function isEntry(value: unknown): value is RegisteredRepo {
  const { repo, main, github } = (value ?? {}) as Record<string, unknown>;
  return (
    typeof repo === "string" &&
    isAbsolute(repo) &&
    typeof main === "string" &&
    typeof github === "string"
  );
}

/**
 * The repos, keyed by container. A repo's `origin` is read when it is first seen and again for
 * every known repo on a lookup miss (an origin added or changed since); a repo whose main
 * checkout is gone is dropped on load and on every sync. Repos whose origin isn't on GitHub
 * are remembered in memory only, so listing changes don't read them again. Changes run one at a
 * time and are written atomically; the file only spares reading origins after a restart, so
 * entries it holds that don't parse are skipped, not rewritten.
 */
export class RepoRegistry {
  /** Resolves once the file is read and pruned. */
  readonly ready: Promise<void>;
  private readonly path: string;
  private repos = new Map<string, RegisteredRepo>();
  /** Seen repos without a GitHub `origin`, by container. */
  private readonly others = new Map<string, SeenRepo>();
  private queue: Promise<unknown>;
  /** Stops following the hub (`follow`). */
  private unfollow: (() => void) | undefined;
  private closed = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, REPOS_FILE);
    this.ready = this.load();
    this.queue = this.ready;
  }

  current(): RegisteredRepo[] {
    return [...this.repos.values()];
  }

  /** Adds the repos in `seen` not known yet, and drops every repo whose main checkout is gone. */
  sync(seen: Iterable<SeenRepo>): Promise<void> {
    return this.enqueue(async () => {
      const next = new Map(this.repos);
      for (const repo of seen) {
        if (next.has(repo.repo) || this.others.has(repo.repo)) continue;
        if (mainCheckoutIn(repo.repo) === repo.main) await this.classify(repo, next);
      }
      await this.commit(next);
    });
  }

  /**
   * The repo whose `origin` is the GitHub repo `github` (`owner/name`, any case). On a miss,
   * every known repo's `origin` is read again first.
   */
  find(github: string): Promise<RegisteredRepo | undefined> {
    return this.enqueue(async () => {
      const found = this.match(github);
      if (found !== undefined) return found;
      const known = [...this.repos.values(), ...this.others.values()];
      const next = new Map<string, RegisteredRepo>();
      this.others.clear();
      for (const repo of known) {
        if (mainCheckoutIn(repo.repo) === repo.main) await this.classify(repo, next);
      }
      await this.commit(next);
      return this.match(github);
    });
  }

  /**
   * Syncs with the hub's sessions and pins: once it is ready, then on every `catalog` and
   * `sidebar` frame, until `close`.
   */
  follow(hub: Pick<StreamHub, "ready" | "baseline" | "subscribe">): void {
    const sync = () => {
      if (this.closed) return;
      this.sync(seenRepos(hub.baseline())).catch((e: unknown) => {
        console.warn(`[repos] sync failed: ${(e as Error).message}`);
      });
    };
    void hub.ready.then(sync);
    this.unfollow = hub.subscribe((frame) => {
      if (frame.type === "catalog" || frame.type === "sidebar") sync();
    });
  }

  /** Stops following the hub; resolves once the queued changes are done (and written). */
  async close(): Promise<void> {
    this.closed = true;
    this.unfollow?.();
    this.unfollow = undefined;
    await this.queue;
  }

  /** Reads `seen`'s `origin`: a GitHub repo goes into `next`, any other into `others`. */
  private async classify(
    { repo, main }: SeenRepo,
    next: Map<string, RegisteredRepo>,
  ): Promise<void> {
    const github = await githubOf(main);
    if (github === undefined) this.others.set(repo, { repo, main });
    else next.set(repo, { repo, main, github });
  }

  private match(github: string): RegisteredRepo | undefined {
    return [...this.repos.values()].find((r) => sameRepo(r.github, github));
  }

  private async load(): Promise<void> {
    let data: unknown;
    try {
      data = await readJsonFile(this.path);
    } catch (e) {
      console.warn(`[repos] ignoring unreadable ${this.path}: ${(e as Error).message}`);
    }
    const stored = Array.isArray(data) ? data.filter(isEntry) : [];
    const present = stored.filter((r) => mainCheckoutIn(r.repo) === r.main);
    this.repos = new Map(present.map((r) => [r.repo, r]));
    if (present.length !== stored.length) await this.write();
  }

  /**
   * Adopts `next` without the repos whose main checkout is gone, and writes it when it changed.
   * The file only spares reading origins again after a restart, so a failed write is logged.
   */
  private async commit(next: Map<string, RegisteredRepo>): Promise<void> {
    for (const [repo, entry] of next) if (mainCheckoutIn(repo) !== entry.main) next.delete(repo);
    const changed = JSON.stringify([...next.values()]) !== JSON.stringify(this.current());
    this.repos = next;
    if (changed) await this.write();
  }

  private async write(): Promise<void> {
    await writeJsonFileAtomic(this.path, this.current()).catch((e: unknown) => {
      console.warn(`[repos] failed to save ${this.path}: ${(e as Error).message}`);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}
