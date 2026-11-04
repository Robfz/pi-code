import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrPin } from "../git/pr.ts";
import { git } from "../testing/layout-repo.ts";
import { PRS_FILE, PrStore, prsView, type StoredPr } from "./pr-store.ts";

let root: string;
let data: string;
let a: string;
let b: string;
/** `syncRefs` calls: git dir → the pinned refs. */
let synced: [string, string[]][];

const syncRefs = async (gitDir: string, pins: Iterable<PrPin>) => {
  synced.push([gitDir, [...pins].map((p) => `${p.number}/${p.sha}`).sort()]);
};

function pr(number: number, headSha: string, gitDir = "/repo/.git"): StoredPr {
  return {
    repo: "octo/repo",
    number,
    title: `PR ${number}`,
    url: `https://github.com/octo/repo/pull/${number}`,
    state: "open",
    baseRefName: "main",
    headRefName: "feature",
    baseSha: "base",
    headSha,
    remoteHeadSha: headSha,
    gitDir,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-prs-")));
  data = join(root, "data");
  a = join(root, "a.jsonl");
  b = join(root, "b.jsonl");
  writeFileSync(a, "");
  writeFileSync(b, "");
  synced = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const saved = (): unknown => JSON.parse(readFileSync(join(data, PRS_FILE), "utf8"));

describe("PrStore", () => {
  it("persists attachments by session file and announces changes", async () => {
    const store = new PrStore(data, { syncRefs });
    await store.ready;
    expect(store.current()).toEqual({});
    const changes: string[][] = [];
    store.subscribe((prs) => changes.push(Object.keys(prs)));

    const entry = {
      ...pr(7, "h1"),
      commentsSince: "2026-01-01T00:00:00Z",
      reportedInline: [3, 4],
      previousHeadSha: "h0",
    };
    await store.set(a, entry);
    await store.set(a, { ...entry });
    expect(changes).toEqual([[a]]);
    expect(saved()).toEqual({ [a]: entry });
    expect(synced).toEqual([["/repo/.git", ["7/base", "7/h0", "7/h1"]]]);
    // Clients see neither the git dir nor the comment and previous head bookkeeping.
    expect(prsView(store.current())).toEqual({
      [a]: {
        repo: "octo/repo",
        number: 7,
        title: "PR 7",
        url: "https://github.com/octo/repo/pull/7",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        baseSha: "base",
        headSha: "h1",
        remoteHeadSha: "h1",
      },
    });

    const reloaded = new PrStore(data, { syncRefs });
    await reloaded.ready;
    expect(reloaded.current()).toEqual(store.current());
  });

  it("copies an attachment to a fork or clone", async () => {
    const store = new PrStore(data, { syncRefs });
    await store.set(a, pr(7, "h1"));
    await store.copy(a, b);
    await store.copy(join(root, "unattached.jsonl"), join(root, "other.jsonl"));
    expect(store.get(b)).toEqual(pr(7, "h1"));
    expect(Object.keys(store.current())).toEqual([a, b]);
  });

  it("applies overlapping changes one at a time, in arrival order", async () => {
    const store = new PrStore(data, { syncRefs });
    await Promise.all([
      store.set(a, pr(7, "h1")),
      store.copy(a, b),
      store.set(a, pr(7, "h2")),
      store.set(join(root, "c.jsonl"), pr(9, "h3")),
    ]);
    const expected = { [a]: pr(7, "h2"), [b]: pr(7, "h1"), [join(root, "c.jsonl")]: pr(9, "h3") };
    expect(store.current()).toEqual(expected);
    expect(saved()).toEqual(expected);
  });

  it("prunes entries whose session file is gone, unless kept, on load and on prune", async () => {
    const c = join(root, "c.jsonl");
    const seeded = new PrStore(data, { syncRefs });
    await seeded.set(a, pr(7, "h1"));
    await seeded.set(b, pr(8, "h2"));
    await seeded.set(c, pr(9, "h3"));

    rmSync(a);
    synced = [];
    const kept = new Set([c]);
    const store = new PrStore(data, { syncRefs, keep: (file) => kept.has(file) });
    await store.ready;
    expect(Object.keys(store.current())).toEqual([b, c]);
    expect(Object.keys(saved() as object)).toEqual([b, c]);
    // The pruned PR's refs go.
    expect(synced).toEqual([["/repo/.git", ["8/base", "8/h2", "9/base", "9/h3"]]]);

    rmSync(b);
    kept.clear();
    await store.prune();
    expect(store.current()).toEqual({});
    expect(synced.at(-1)).toEqual(["/repo/.git", []]);
  });

  it("drops malformed entries on load", async () => {
    const store0 = new PrStore(data, { syncRefs });
    await store0.set(a, pr(7, "h1"));
    writeFileSync(
      join(data, PRS_FILE),
      JSON.stringify({ [a]: pr(7, "h1"), [b]: { number: "8" }, relative: pr(9, "h") }),
    );
    const store = new PrStore(data, { syncRefs });
    await store.ready;
    expect(Object.keys(store.current())).toEqual([a]);
  });

  it("mirrors each repository's pins as refs, only where they changed", async () => {
    const store = new PrStore(data, { syncRefs });
    await store.set(a, pr(7, "h1", "/one/.git"));
    await store.set(b, pr(8, "h2", "/two/.git"));
    // A fork pins the same commits: no ref changes.
    await store.copy(a, join(root, "fork.jsonl"));
    // A refresh moves one conversation's head; the fork still pins the old one.
    await store.set(a, pr(7, "h3", "/one/.git"));
    // A new remote head (Outdated) pins nothing new.
    await store.set(b, { ...pr(8, "h2", "/two/.git"), remoteHeadSha: "h9" });
    expect(synced).toEqual([
      ["/one/.git", ["7/base", "7/h1"]],
      ["/two/.git", ["8/base", "8/h2"]],
      ["/one/.git", ["7/base", "7/h1", "7/h3"]],
    ]);

    synced = [];
    rmSync(b);
    await store.prune();
    expect(synced).toEqual([
      ["/one/.git", ["7/base", "7/h3"]],
      ["/two/.git", []],
    ]);
  });

  it("mirrors a repository again on the next change after a failed sync", async () => {
    let fail = true;
    const flaky = async (gitDir: string, pins: Iterable<PrPin>) => {
      await syncRefs(gitDir, pins);
      if (fail) throw new Error("cannot lock ref");
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new PrStore(data, { syncRefs: flaky });
    await store.set(a, pr(7, "h1"));
    fail = false;
    // Same pins, but the last sync failed.
    await store.set(a, { ...pr(7, "h1"), remoteHeadSha: "h2" });
    await store.set(a, { ...pr(7, "h1"), remoteHeadSha: "h3" });
    expect(synced).toEqual([
      ["/repo/.git", ["7/base", "7/h1"]],
      ["/repo/.git", ["7/base", "7/h1"]],
    ]);
  });

  it("reconciles every repository's refs with the pins on load", async () => {
    /** A repository with two commits; returns its git dir and the commits. */
    const repo = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "one");
      git(dir, "commit", "-q", "--allow-empty", "-m", "two");
      const [two, one] = git(dir, "rev-list", "HEAD").trim().split("\n");
      return { dir, gitDir: join(dir, ".git"), one: one as string, two: two as string };
    };
    const refs = (dir: string) =>
      git(dir, "for-each-ref", "--format=%(refname)", "refs/pi-code/").split("\n").filter(Boolean);
    const kept = repo("kept");
    const pruned = repo("pruned");
    const seeded = new PrStore(data);
    await seeded.set(a, { ...pr(7, kept.two, kept.gitDir), baseSha: kept.one });
    await seeded.set(b, { ...pr(8, pruned.two, pruned.gitDir), baseSha: pruned.one });

    // The refs fall out of step with the file while the server is down.
    git(kept.dir, "update-ref", "-d", `refs/pi-code/pr/7/${kept.two}`);
    git(kept.dir, "update-ref", `refs/pi-code/pr/9/${kept.two}`, kept.two);
    rmSync(b);
    const store = new PrStore(data);
    await store.ready;
    expect(refs(kept.dir).sort()).toEqual(
      [`refs/pi-code/pr/7/${kept.one}`, `refs/pi-code/pr/7/${kept.two}`].sort(),
    );
    expect(refs(pruned.dir)).toEqual([]);
  });
});
