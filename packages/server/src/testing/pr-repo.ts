/**
 * Test helpers for PR review: a bare `origin` with GitHub-style `refs/pull/<n>/head` refs, cloned
 * with a GitHub `origin` URL that `insteadOf` rewrites to the bare repository, and a fake `gh`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GhError, type GhRunner } from "../pr/github.ts";
import { git } from "./layout-repo.ts";

/** The GitHub URL the clone's `origin` is configured with. */
export const ORIGIN_URL = "git@github.com:octo/repo.git";
export const REPO = "octo/repo";

export interface PrRepo {
  /** The bare repository behind `ORIGIN_URL`. */
  origin: string;
  /** `main`'s first commit: the merge-base of open PR 7. */
  root: string;
  /** PR 7's head (open, based on `main`). */
  head: string;
  /** `main` when PR 8 was merged: PR 8's recorded base. */
  mergedBase: string;
  /** PR 8's head, merged into `main`. */
  mergedHead: string;
}

function commit(dir: string, file: string, text: string, message: string): string {
  writeFileSync(join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

/**
 * `<parent>/origin.git` with `main` and two PRs: 7, open (`a.txt` changed, `b.txt` added on top
 * of main's first commit), and 8, merged (`d.txt` added), cloned into `clone`.
 */
export function makePrRepo(parent: string, clone: string): PrRepo {
  const origin = join(parent, "origin.git");
  const seed = join(parent, "seed");
  mkdirSync(seed, { recursive: true });
  git(parent, "init", "-q", "--bare", origin);
  git(seed, "init", "-q", "-b", "main");
  const root = commit(seed, "a.txt", "one\n", "root");
  git(seed, "checkout", "-q", "-b", "feature");
  commit(seed, "a.txt", "two\n", "change a");
  const head = commit(seed, "b.txt", "b\n", "add b");
  git(seed, "checkout", "-q", "main");
  const mergedBase = commit(seed, "c.txt", "c\n", "add c");
  git(seed, "checkout", "-q", "-b", "merged");
  const mergedHead = commit(seed, "d.txt", "d\n", "add d");
  git(seed, "checkout", "-q", "main");
  git(seed, "merge", "-q", "--no-ff", "-m", "merge 8", "merged");
  git(
    seed,
    "push",
    "-q",
    origin,
    "main",
    `${head}:refs/pull/7/head`,
    `${mergedHead}:refs/pull/8/head`,
  );
  rmSync(seed, { recursive: true, force: true });

  // `--no-local`: only the objects a real clone gets, not the PR heads.
  git(parent, "clone", "-q", "--no-local", origin, clone);
  git(clone, "config", "remote.origin.url", ORIGIN_URL);
  git(clone, "config", `url.${origin}.insteadOf`, ORIGIN_URL);
  return { origin, root, head, mergedBase, mergedHead };
}

/** Pushes a new commit adding `file` on top of PR 7's head; returns it. */
export function pushToPr(repo: PrRepo, parent: string, file = "e.txt"): string {
  const work = join(parent, "pusher");
  git(parent, "clone", "-q", repo.origin, work);
  git(work, "fetch", "-q", "origin", "refs/pull/7/head");
  git(work, "checkout", "-q", "FETCH_HEAD");
  const sha = commit(work, file, `${file}\n`, `add ${file}`);
  git(work, "push", "-q", "origin", `${sha}:refs/pull/7/head`);
  rmSync(work, { recursive: true, force: true });
  return sha;
}

export interface FakePr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefOid: string;
  headRefOid: string;
  title?: string;
  /** Default: the PR in `REPO`. */
  url?: string;
  /** `gh pr view` without a number resolves to this PR. */
  current?: boolean;
  /** Default: `pr-<number>`. */
  headRefName?: string;
  /** Its head branch is in a fork. */
  fork?: boolean;
  comments?: { author: { login: string }; body: string; createdAt: string }[];
  reviews?: { author: { login: string }; body: string; state: string; submittedAt: string }[];
  /** As GitHub's REST API returns them. */
  inline?: Record<string, unknown>[];
}

/** A `gh` that knows `prs` (in `REPO`) and records its calls. */
export function fakeGh(prs: FakePr[]): GhRunner & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const gh = async (_cwd: string, args: readonly string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      const numbered = /^\d+$/.test(args[2] ?? "");
      const pr = numbered
        ? prs.find((p) => p.number === Number(args[2]))
        : prs.find((p) => p.current);
      if (pr === undefined) {
        throw new GhError(
          "gh failed",
          numbered
            ? `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.`
            : 'no pull requests found for branch "x"',
        );
      }
      const data: Record<string, unknown> = {
        number: pr.number,
        title: pr.title ?? `PR ${pr.number}`,
        url: pr.url ?? `https://github.com/${REPO}/pull/${pr.number}`,
        state: pr.state,
        author: { login: "alice" },
        body: "The description.",
        baseRefName: "main",
        headRefName: pr.headRefName ?? `pr-${pr.number}`,
        isCrossRepository: pr.fork ?? false,
        baseRefOid: pr.baseRefOid,
        headRefOid: pr.headRefOid,
        comments: pr.comments ?? [],
        reviews: pr.reviews ?? [],
      };
      // Only the fields asked for, like gh, so a misspelt field goes missing.
      const fields = (args[args.indexOf("--json") + 1] ?? "").split(",");
      return JSON.stringify(Object.fromEntries(fields.map((field) => [field, data[field]])));
    }
    // `gh api --jq '.[] | tojson'`: one object per line.
    if (args[0] === "api" && args.at(-1) === ".[] | tojson") {
      const number = Number(/pulls\/(\d+)\/comments/.exec(args[2] ?? "")?.[1]);
      const pr = prs.find((p) => p.number === number);
      return (pr?.inline ?? []).map((c) => JSON.stringify(c)).join("\n");
    }
    throw new GhError("gh failed", `unexpected gh ${args.join(" ")}`);
  };
  return Object.assign(gh, { calls });
}
