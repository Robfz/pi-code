import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../testing/layout-repo.ts";
import { makePrRepo, type PrRepo, pushToPr, REPO } from "../testing/pr-repo.ts";
import { hasCommit } from "./git.ts";
import {
  commitsBetween,
  diffStat,
  fetchPr,
  gitCommonDir,
  originRepo,
  pinBase,
  remotePrHead,
  syncPrRefs,
} from "./pr.ts";
import { fetchOrigin } from "./refs.ts";

let root: string;
let clone: string;
let repo: PrRepo;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-pr-git-")));
  clone = join(root, "clone");
  repo = makePrRepo(root, clone);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const refs = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/pi-code/")
    .split("\n")
    .filter(Boolean);

describe("originRepo", () => {
  it("reads origin's configured GitHub URL", async () => {
    expect(await originRepo(clone)).toBe(REPO);
  });

  it("refuses a non-GitHub origin and a missing one", async () => {
    git(clone, "config", "remote.origin.url", "git@gitlab.com:octo/repo.git");
    await expect(originRepo(clone)).rejects.toMatchObject({ code: "not_a_github_repo" });
    git(clone, "remote", "remove", "origin");
    await expect(originRepo(clone)).rejects.toMatchObject({
      code: "not_a_github_repo",
      message: "this repository has no origin remote",
    });
  });
});

describe("fetchPr and pinBase", () => {
  it("fetches an open PR's head and base branch and pins their merge-base", async () => {
    // origin's main moves on after the clone.
    git(repo.origin, "update-ref", "refs/heads/main", repo.mergedBase);
    const originMain = git(clone, "rev-parse", "refs/remotes/origin/main");
    expect(await hasCommit(clone, repo.head)).toBe(false);
    expect(await fetchPr(clone, 7, "main")).toEqual({
      headSha: repo.head,
      baseTip: repo.mergedBase,
    });
    expect(await hasCommit(clone, repo.head)).toBe(true);
    // Nothing is checked out, no temporary ref is left, and origin/main is left to `git fetch`.
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(refs(clone)).toEqual([]);
    expect(git(clone, "rev-parse", "refs/remotes/origin/main")).toBe(originMain);
    const base = await pinBase(clone, {
      state: "open",
      baseTip: repo.mergedBase,
      baseRefOid: repo.mergedBase,
      headSha: repo.head,
    });
    expect(base).toBe(repo.root);
  });

  it("pins a merged PR's recorded base, where the merge-base would be the head", async () => {
    const { baseTip } = await fetchPr(clone, 8, "main");
    const pin = {
      baseTip,
      baseRefOid: repo.mergedBase,
      headSha: repo.mergedHead,
    };
    expect(await pinBase(clone, { ...pin, state: "merged" })).toBe(repo.mergedBase);
    expect(await pinBase(clone, { ...pin, state: "closed" })).toBe(repo.mergedHead);
  });

  it("falls back to the recorded base when the base branch is gone, even with a stale origin/<base>", async () => {
    await fetchPr(clone, 7, "main");
    git(clone, "update-ref", "refs/remotes/origin/gone", repo.head);
    const fetched = await fetchPr(clone, 7, "gone");
    expect(fetched).toEqual({ headSha: repo.head });
    const base = await pinBase(clone, {
      state: "closed",
      baseTip: fetched.baseTip,
      baseRefOid: repo.root,
      headSha: repo.head,
    });
    expect(base).toBe(repo.root);
  });

  it("fails when the base branch exists but can't be fetched", async () => {
    // No ref can be created under refs/pi-code/fetch/.
    const gitDir = await gitCommonDir(clone);
    mkdirSync(join(gitDir, "refs", "pi-code"), { recursive: true });
    writeFileSync(join(gitDir, "refs", "pi-code", "fetch"), "");
    await expect(fetchPr(clone, 7, "main")).rejects.toMatchObject({ code: "git_failed" });
  });

  it("fetches alongside another fetch of the same repository", async () => {
    git(repo.origin, "update-ref", "refs/heads/main", repo.mergedBase);
    const worktree = join(root, "wt");
    git(clone, "worktree", "add", "-q", worktree);
    const results = await Promise.all([
      fetchPr(clone, 7, "main"),
      fetchPr(worktree, 8, "main"),
      fetchOrigin(clone),
    ]);
    expect(results.slice(0, 2)).toEqual([
      { headSha: repo.head, baseTip: repo.mergedBase },
      { headSha: repo.mergedHead, baseTip: repo.mergedBase },
    ]);
  });

  it("fails with git_failed on missing commits", async () => {
    const missing = "f".repeat(40);
    await expect(diffStat(clone, repo.root, missing)).rejects.toMatchObject({
      code: "git_failed",
    });
    await expect(
      pinBase(clone, {
        state: "open",
        baseTip: repo.root,
        baseRefOid: repo.root,
        headSha: missing,
      }),
    ).rejects.toMatchObject({ code: "git_failed" });
  });

  it("returns the head as fetched, newer than the one first seen, whatever FETCH_HEAD holds", async () => {
    await fetchPr(clone, 7, "main");
    const pushed = pushToPr(repo, root);
    // FETCH_HEAD still names the old head.
    git(clone, "config", "fetch.writeFetchHEAD", "false");
    expect((await fetchPr(clone, 7, "main")).headSha).toBe(pushed);
  });

  it("fails clearly when the PR has no head ref", async () => {
    await expect(fetchPr(clone, 99, "main")).rejects.toMatchObject({ code: "git_failed" });
  });
});

describe("remotePrHead", () => {
  it("reads the PR head on origin, and sees new pushes", async () => {
    expect(await remotePrHead(clone, 7)).toBe(repo.head);
    const pushed = pushToPr(repo, root);
    expect(await remotePrHead(clone, 7)).toBe(pushed);
    expect(await remotePrHead(clone, 99)).toBeUndefined();
  });
});

describe("diffStat and commitsBetween", () => {
  it("counts lines per file and lists new commits, or null after a force-push", async () => {
    await fetchPr(clone, 7, "main");
    expect(await diffStat(clone, repo.root, repo.head)).toEqual([
      { path: "a.txt", additions: 1, deletions: 1 },
      { path: "b.txt", additions: 1, deletions: 0 },
    ]);
    const list = await commitsBetween(clone, repo.root, repo.head);
    expect(list?.commits.map((c) => c.slice(8))).toEqual(["add b", "change a"]);
    expect(list?.total).toBe(2);
    expect(await commitsBetween(clone, repo.head, repo.mergedBase)).toBeNull();
  });

  it("counts a merge of the base branch once, and lists at most 50 commits", async () => {
    // main gets 60 commits and is merged into the PR branch.
    const work = join(root, "work");
    git(root, "clone", "-q", repo.origin, work);
    for (let i = 0; i < 60; i++) git(work, "commit", "-q", "--allow-empty", "-m", `main ${i}`);
    git(work, "fetch", "-q", "origin", "refs/pull/7/head");
    git(work, "checkout", "-q", "-b", "pr", "FETCH_HEAD");
    git(work, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    git(work, "push", "-q", "origin", "main", "HEAD:refs/pull/7/head");
    const { headSha } = await fetchPr(clone, 7, "main");
    expect(await commitsBetween(clone, repo.head, headSha)).toEqual({
      commits: [expect.stringMatching(/ merge main$/)],
      total: 1,
    });

    git(clone, "fetch", "-q", "origin");
    const many = await commitsBetween(clone, repo.root, "refs/remotes/origin/main");
    expect(many?.commits).toHaveLength(50);
    expect(many?.total).toBe(62);
  }, 30_000);
});

describe("the agent's one-file diff command", () => {
  /** `git diff <range> -- <pathspec>` through a shell, as the context message has the agent run it. */
  const diff = (cwd: string, pathspec: string) =>
    execFileSync("sh", ["-c", `git diff HEAD~1..HEAD -- ${pathspec}`], { cwd, encoding: "utf8" });

  it("matches the named file literally, from a subfolder too", () => {
    writeFileSync(join(clone, "a*b.ts"), "star\n");
    writeFileSync(join(clone, "aXb.ts"), "x\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "add a*b.ts and aXb.ts");
    const sub = join(clone, "sub");
    mkdirSync(sub);

    const literal = diff(sub, "':(top,literal)a*b.ts'");
    expect(literal).toContain("a*b.ts");
    expect(literal).not.toContain("aXb.ts");
    // Without `literal`, the name is a glob that matches both.
    expect(diff(sub, ":/'a*b.ts'")).toContain("aXb.ts");
  });
});

describe("syncPrRefs", () => {
  it("creates the pinned refs and removes the others, leaving unknown commits out", async () => {
    await fetchPr(clone, 7, "main");
    const gitDir = await gitCommonDir(clone);
    await syncPrRefs(gitDir, [
      { number: 7, sha: repo.head },
      { number: 7, sha: repo.root },
      { number: 9, sha: "f".repeat(40) },
    ]);
    expect(refs(clone).sort()).toEqual(
      [
        `refs/pi-code/pr/7/${repo.head} ${repo.head}`,
        `refs/pi-code/pr/7/${repo.root} ${repo.root}`,
      ].sort(),
    );

    await syncPrRefs(gitDir, [{ number: 7, sha: repo.head }]);
    expect(refs(clone)).toEqual([`refs/pi-code/pr/7/${repo.head} ${repo.head}`]);

    // The ref keeps the fetched head alive once FETCH_HEAD moves on.
    git(clone, "fetch", "-q", "origin", "main");
    git(clone, "reflog", "expire", "--expire=now", "--all");
    git(clone, "gc", "-q", "--prune=now");
    expect(await hasCommit(clone, repo.head)).toBe(true);

    await syncPrRefs(gitDir, []);
    expect(refs(clone)).toEqual([]);
    await syncPrRefs(join(root, "missing", ".git"), [{ number: 1, sha: repo.head }]);
  });

  it("still creates the missing refs when a stale one can't be deleted, then throws", async () => {
    await fetchPr(clone, 7, "main");
    const gitDir = await gitCommonDir(clone);
    await syncPrRefs(gitDir, [{ number: 7, sha: repo.root }]);
    const stale = `refs/pi-code/pr/7/${repo.root}`;
    writeFileSync(join(gitDir, `${stale}.lock`), "");
    await expect(syncPrRefs(gitDir, [{ number: 7, sha: repo.head }])).rejects.toThrow(
      /update-ref -d/,
    );
    expect(refs(clone).sort()).toEqual(
      [`refs/pi-code/pr/7/${repo.head} ${repo.head}`, `${stale} ${repo.root}`].sort(),
    );
    rmSync(join(gitDir, `${stale}.lock`));
    await syncPrRefs(gitDir, [{ number: 7, sha: repo.head }]);
    expect(refs(clone)).toEqual([`refs/pi-code/pr/7/${repo.head} ${repo.head}`]);
  });

  it("shares one set of refs between a repository's worktrees", async () => {
    const worktree = join(root, "wt");
    git(clone, "worktree", "add", "-q", worktree);
    expect(await gitCommonDir(worktree)).toBe(await gitCommonDir(clone));
  });
});
