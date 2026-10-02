/** Test helpers: real git repos in the `<repo>/main` layout, cloned from a bare `origin`. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const CONFIG = ["user.email=t@example.com", "user.name=t", "init.defaultBranch=main"];

/** Runs `git args` in `cwd` with a fixed identity; returns stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...CONFIG.flatMap((c) => ["-c", c]), ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface LayoutRepo {
  /** Bare repository cloned as `origin`. */
  origin: string;
  /** The container. */
  repo: string;
  /** The main checkout, `<repo>/<checkout>`. */
  main: string;
}

/**
 * A bare `origin` at `<parent>/<name>.git` with one commit on each of `branches` (default
 * `main`; the first is origin's HEAD), cloned into `<parent>/<name>/<checkout>` (default `main`).
 */
export function makeLayoutRepo(
  parent: string,
  name: string,
  opts: { branches?: string[]; checkout?: string } = {},
): LayoutRepo {
  const branches = opts.branches ?? ["main"];
  const origin = join(parent, `${name}.git`);
  const seed = join(parent, `${name}.seed`);
  mkdirSync(seed, { recursive: true });
  git(parent, "init", "-q", "--bare", origin);
  git(seed, "init", "-q");
  git(seed, "commit", "-q", "--allow-empty", "-m", "init");
  for (const branch of branches) git(seed, "push", "-q", origin, `HEAD:refs/heads/${branch}`);
  git(origin, "symbolic-ref", "HEAD", `refs/heads/${branches[0]}`);
  rmSync(seed, { recursive: true, force: true });
  const repo = join(parent, name);
  const main = join(repo, opts.checkout ?? "main");
  mkdirSync(repo, { recursive: true });
  git(repo, "clone", "-q", origin, main);
  return { origin, repo, main };
}
