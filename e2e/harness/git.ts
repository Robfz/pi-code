import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Git settings for every git the harness and its server run: no global or system config (a
 * user's hooks, templates or gpg signing would run on test repos), and no detached
 * `git maintenance` writing into repos while they are deleted.
 */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
};

/**
 * `env` for running git on test repos: without inherited `GIT_*` variables (a git hook running
 * `pnpm e2e` sets `GIT_DIR`, `GIT_INDEX_FILE`, … for the developer's repo), plus `GIT_ENV`.
 */
export function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...clean, ...GIT_ENV };
}

function git(dir: string, args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.email=e2e@example.com",
      "-c",
      "user.name=e2e",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: dir, env: gitEnv(process.env), stdio: "pipe" },
  );
}

/** Creates `dir` as a git repo with `files` (relative path → content) in one commit on `main`. */
export function initRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Initial commit"]);
}
