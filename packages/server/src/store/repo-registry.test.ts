import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoLayout, StreamFrame } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, makeLayoutRepo } from "../testing/layout-repo.ts";
import { REPOS_FILE, RepoRegistry, seenRepos } from "./repo-registry.ts";

let root: string;
let data: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-repos-")));
  data = join(root, "data");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A layout repo whose origin is configured as `url`. */
function repoWithOrigin(name: string, url: string) {
  const repo = makeLayoutRepo(root, name);
  git(repo.main, "config", "remote.origin.url", url);
  return { repo: repo.repo, main: repo.main };
}

const saved = (): unknown => JSON.parse(readFileSync(join(data, REPOS_FILE), "utf8"));

describe("seenRepos", () => {
  it("lists the sessions' layout repos and the pinned repos", () => {
    const layout = (repo: string, role: RepoLayout["role"]): RepoLayout => ({
      repo,
      role,
      main: `${repo}/main`,
    });
    expect(
      seenRepos({
        sessions: [{ layout: layout("/a", "worktree") }, {}, { layout: layout("/b", "container") }],
        sidebar: { mains: { "/c": "/c/master" } },
      }),
    ).toEqual([
      { repo: "/a", main: "/a/main" },
      { repo: "/b", main: "/b/main" },
      { repo: "/c", main: "/c/master" },
    ]);
  });
});

describe("RepoRegistry", () => {
  it("registers the GitHub repos it sees and persists them", async () => {
    const octo = repoWithOrigin("octo", "git@github.com:Octo/Repo.git");
    const gitlab = repoWithOrigin("lab", "git@gitlab.com:o/r.git");
    const registry = new RepoRegistry(data);
    await registry.sync([octo, gitlab, octo]);
    expect(registry.current()).toEqual([{ ...octo, github: "Octo/Repo" }]);
    expect(saved()).toEqual([{ ...octo, github: "Octo/Repo" }]);

    expect(await registry.find("octo/repo")).toEqual({ ...octo, github: "Octo/Repo" });
    expect(await registry.find("octo/other")).toBeUndefined();

    const reloaded = new RepoRegistry(data);
    await reloaded.ready;
    expect(reloaded.current()).toEqual(registry.current());
  });

  it("skips folders that aren't the layout's main checkout", async () => {
    const octo = repoWithOrigin("octo", "git@github.com:octo/repo.git");
    const registry = new RepoRegistry(data);
    await registry.sync([{ repo: octo.repo, main: join(octo.repo, "other") }]);
    expect(registry.current()).toEqual([]);
  });

  it("reads origins again on a miss", async () => {
    const octo = repoWithOrigin("octo", "git@gitlab.com:octo/repo.git");
    const registry = new RepoRegistry(data);
    await registry.sync([octo]);
    expect(registry.current()).toEqual([]);
    git(octo.main, "config", "remote.origin.url", "https://github.com/octo/repo");
    // A sync doesn't read a repo it has seen again.
    await registry.sync([octo]);
    expect(registry.current()).toEqual([]);
    expect(await registry.find("octo/repo")).toEqual({ ...octo, github: "octo/repo" });

    // An origin renamed on GitHub's side is found once read again.
    git(octo.main, "config", "remote.origin.url", "https://github.com/octo/renamed");
    expect(await registry.find("octo/renamed")).toEqual({ ...octo, github: "octo/renamed" });
    expect(registry.current()).toEqual([{ ...octo, github: "octo/renamed" }]);
  });

  it("drops repos whose main checkout is gone, on sync and on load", async () => {
    const a = repoWithOrigin("a", "git@github.com:o/a.git");
    const b = repoWithOrigin("b", "git@github.com:o/b.git");
    const registry = new RepoRegistry(data);
    await registry.sync([a, b]);
    rmSync(a.main, { recursive: true, force: true });
    await registry.sync([]);
    expect(registry.current().map((r) => r.github)).toEqual(["o/b"]);
    expect(saved()).toEqual([{ ...b, github: "o/b" }]);

    rmSync(b.main, { recursive: true, force: true });
    const reloaded = new RepoRegistry(data);
    await reloaded.ready;
    expect(reloaded.current()).toEqual([]);
    expect(saved()).toEqual([]);
  });

  it("ignores unreadable files and malformed entries", async () => {
    const a = repoWithOrigin("a", "git@github.com:o/a.git");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, REPOS_FILE), "{");
    const unreadable = new RepoRegistry(data);
    await unreadable.ready;
    expect(unreadable.current()).toEqual([]);

    writeFileSync(
      join(data, REPOS_FILE),
      JSON.stringify([{ ...a, github: "o/a" }, { repo: "relative", main: "x", github: "o/x" }, 3]),
    );
    const registry = new RepoRegistry(data);
    await registry.ready;
    expect(registry.current()).toEqual([{ ...a, github: "o/a" }]);
    // A cache: entries it can't read are skipped, not rewritten away.
    expect(saved()).toHaveLength(3);
  });

  it("follows the hub's sessions and pins", async () => {
    const a = repoWithOrigin("a", "git@github.com:o/a.git");
    const b = repoWithOrigin("b", "git@github.com:o/b.git");
    const c = repoWithOrigin("c", "git@github.com:o/c.git");
    const listeners = new Set<(frame: StreamFrame) => void>();
    const send = (type: string) => {
      for (const listener of listeners) listener({ type } as StreamFrame);
    };
    let sessions = [{ layout: { repo: a.repo, role: "main", main: a.main } }];
    let pinned: Record<string, string> = {};
    let baselines = 0;
    const hub = {
      ready: Promise.resolve(),
      baseline: () => {
        baselines += 1;
        return {
          sessions,
          sidebar: { pinned: Object.keys(pinned), collapsed: [], mains: pinned },
        } as never;
      },
      subscribe: (listener: (frame: never) => void) => {
        listeners.add(listener as (frame: StreamFrame) => void);
        return () => listeners.delete(listener as (frame: StreamFrame) => void);
      },
    };
    const registry = new RepoRegistry(data);
    registry.follow(hub);
    // `find` runs after the syncs queued before it.
    await hub.ready;
    expect(await registry.find("o/a")).toMatchObject({ repo: a.repo });

    pinned = { [b.repo]: b.main };
    send("sidebar");
    expect(await registry.find("o/b")).toMatchObject({ repo: b.repo });

    sessions = [...sessions, { layout: { repo: c.repo, role: "worktree", main: c.main } }];
    send("catalog");
    expect(await registry.find("o/c")).toMatchObject({ repo: c.repo });

    const read = baselines;
    send("agent_status");
    send("guide");
    expect(baselines).toBe(read);

    await registry.close();
    expect(listeners.size).toBe(0);
  });
});
