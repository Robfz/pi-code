import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors.ts";
import { git, makeLayoutRepo } from "../testing/layout-repo.ts";
import { listBranches } from "./refs.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-refs-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repo at `<root>/repo` on branch `initial`, without commits. */
function init(initial: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", initial);
  return repo;
}

/** An empty commit on the current branch, committed at Unix time `seconds`. */
function commitAt(repo: string, seconds: number): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    ],
    {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: `@${seconds} +0000` },
      stdio: "ignore",
    },
  );
}

describe("listBranches", () => {
  it("lists local branches by most recent commit and defaults to main", async () => {
    const repo = init("main");
    commitAt(repo, 1_700_000_000);
    git(repo, "checkout", "-q", "-b", "older");
    commitAt(repo, 1_700_000_100);
    git(repo, "checkout", "-q", "-b", "newest");
    commitAt(repo, 1_700_000_200);
    git(repo, "checkout", "-q", "main");

    expect(await listBranches(repo)).toEqual({
      branches: ["newest", "older", "main"],
      defaultBranch: "main",
    });
  });

  it("prefers the branch origin/HEAD names when it exists locally", async () => {
    const { main } = makeLayoutRepo(root, "r", { branches: ["trunk", "main"] });
    git(main, "branch", "-q", "main", "origin/main");

    const { branches, defaultBranch } = await listBranches(main);
    expect(branches.sort()).toEqual(["main", "trunk"]);
    expect(defaultBranch).toBe("trunk");
  });

  it("falls back to main when origin/HEAD names a missing branch", async () => {
    const { main } = makeLayoutRepo(root, "r", { branches: ["trunk", "main"] });
    git(main, "checkout", "-q", "-b", "main", "origin/main");
    git(main, "branch", "-q", "-D", "trunk");
    git(main, "update-ref", "-d", "refs/remotes/origin/trunk");

    expect(await listBranches(main)).toEqual({ branches: ["main"], defaultBranch: "main" });
  });

  it("lists branches only on origin, which can be the default", async () => {
    const repo = init("dev");
    commitAt(repo, 1_700_000_000);
    const first = git(repo, "rev-parse", "HEAD").trim();
    commitAt(repo, 1_700_000_100);
    git(repo, "update-ref", "refs/remotes/origin/trunk", first);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

    expect(await listBranches(repo)).toEqual({
      branches: ["dev", "trunk"],
      defaultBranch: "trunk",
    });
  });

  it("lists a branch on origin and local once, at its most recent commit", async () => {
    const repo = init("main");
    commitAt(repo, 1_700_000_000);
    const oldest = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "branch", "mid");
    git(repo, "checkout", "-q", "-b", "tmp");
    commitAt(repo, 1_700_000_200);
    const newest = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-q", "-D", "tmp");
    commitAt(repo, 1_700_000_100);
    git(repo, "update-ref", "refs/remotes/origin/mid", newest);
    git(repo, "update-ref", "refs/remotes/origin/main", oldest);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    expect(await listBranches(repo)).toEqual({ branches: ["mid", "main"], defaultBranch: "main" });
  });

  it("falls back to master", async () => {
    const repo = init("master");
    commitAt(repo, 1_700_000_000);
    expect(await listBranches(repo)).toEqual({ branches: ["master"], defaultBranch: "master" });
  });

  it("gives no default without main, master or origin/HEAD", async () => {
    const repo = init("dev");
    commitAt(repo, 1_700_000_000);
    expect(await listBranches(repo)).toEqual({ branches: ["dev"], defaultBranch: null });
  });

  it("lists nothing in a repo without commits", async () => {
    const repo = init("main");
    expect(await listBranches(repo)).toEqual({ branches: [], defaultBranch: null });
  });

  it("names a branch by its own name when a tag shares it", async () => {
    const repo = init("main");
    commitAt(repo, 1_700_000_000);
    git(repo, "branch", "x");
    git(repo, "tag", "x");

    expect((await listBranches(repo)).branches.sort()).toEqual(["main", "x"]);
  });

  it("rejects a folder outside a work tree", async () => {
    const folder = join(root, "plain");
    mkdirSync(folder);
    const error = await listBranches(folder).catch((e: unknown) => e);
    expect(isApiError(error, "not_a_git_repo")).toBe(true);
  });
});
