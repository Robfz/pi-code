/** Local branches and default-branch detection (design/07-code-review.md, "GET git/branches"). */
import type { GitBranchesResponse } from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import { gitTopLevel, runGit } from "./git.ts";

const ORIGIN_PREFIX = "refs/remotes/origin/";

/**
 * The local branches of the repo containing `cwd`, most recent commit first, and the default
 * branch: the one `origin/HEAD` names when it exists locally, else `main`, else `master`, else
 * `null`. Throws `not_a_git_repo` outside a work tree.
 */
export async function listBranches(cwd: string): Promise<GitBranchesResponse> {
  if ((await gitTopLevel(cwd)) === null) {
    throw new ApiError("not_a_git_repo", `${cwd} is not inside a git work tree`);
  }
  // `lstrip=2` rather than `refname:short`, which writes `heads/x` when a tag is also named `x`.
  const [listed, originHead] = await Promise.all([
    runGit(cwd, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:lstrip=2)",
      "refs/heads",
    ]),
    runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { okCodes: [0, 1, 128] }),
  ]);
  const branches = listed.stdout.split("\n").filter((b) => b !== "");
  const target = originHead.stdout.trim();
  const candidates = [
    ...(originHead.code === 0 && target.startsWith(ORIGIN_PREFIX)
      ? [target.slice(ORIGIN_PREFIX.length)]
      : []),
    "main",
    "master",
  ];
  const defaultBranch = candidates.find((b) => branches.includes(b)) ?? null;
  return { branches, defaultBranch };
}
