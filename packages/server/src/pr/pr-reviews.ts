/**
 * Starting a PR review from its URL (design/11-pr-guide.md, "Entry"): the review worktree
 * `<repo>/pr-<number>` on the PR's head branch, a conversation there, and `/pr`'s attach.
 */
import { basename } from "node:path";
import type { Agent, AgentManager } from "../agents/agent-manager.ts";
import { ApiError } from "../errors.ts";
import { addReviewWorktree, discardReviewWorktree } from "../git/worktrees.ts";
import { KeyedLock } from "../keyed-lock.ts";
import type { RepoRegistry } from "../store/repo-registry.ts";
import { parsePrUrl } from "./github.ts";
import type { PrService } from "./pr-service.ts";

export interface PrReviewsDeps {
  manager: AgentManager;
  prs: PrService;
  repos: RepoRegistry;
}

export class PrReviews {
  private readonly deps: PrReviewsDeps;
  /** One start at a time per PR (`owner/name#N`, lower-cased). */
  private readonly locks = new KeyedLock();

  constructor(deps: PrReviewsDeps) {
    this.deps = deps;
  }

  /**
   * Creates the review worktree of the PR at `url`, opens a conversation there and attaches it to
   * the PR, which sends the agent its context and starts the guide. Returns the agent. Throws
   * `invalid_body` (not a PR URL, a fork's PR, an invalid head branch name), `repo_not_found`,
   * `worktree_exists`, `branch_exists` (but for a leftover review branch of this PR, which is
   * deleted), `agent_busy` (the worktree needs a trust decision), and the errors of `gh`,
   * `git` and the attach; a failure after the worktree was created removes it and its branch.
   */
  async start(url: string): Promise<Agent> {
    const target = parsePrUrl(url);
    if (target === undefined) {
      throw new ApiError("invalid_body", `expected a GitHub PR URL, got "${url.trim()}"`);
    }
    const key = `${target.repo}#${target.number}`.toLowerCase();
    return this.locks.run(key, async () => {
      const repo = await this.deps.repos.find(target.repo);
      if (repo === undefined) {
        throw new ApiError(
          "repo_not_found",
          `no <repo>/main checkout of ${target.repo} is known: open a conversation in its main checkout or pin it, then try again`,
        );
      }
      const view = await this.deps.prs.view(repo.main, repo.github, target.number);
      if (view.crossRepository) {
        throw new ApiError("invalid_body", "PRs from forks aren't supported");
      }
      const branch = view.headRefName;
      const path = await addReviewWorktree({
        home: this.deps.manager.home,
        repo: repo.repo,
        number: view.number,
        branch,
      });
      let agent: Agent | undefined;
      try {
        agent = await this.deps.manager.open({ cwd: path });
        if (agent.status === "awaiting_trust") {
          throw new ApiError(
            "agent_busy",
            `${basename(path)} has project resources (.pi, .agents) that need a trust decision: trust its repo's folder ${repo.repo} first, then try again`,
          );
        }
        // Initialization (pi's state, its session file) is queued on the pipeline.
        await agent.pipeline.enqueue(() => {});
        await this.deps.prs.attach(agent, url);
        return agent;
      } catch (e) {
        await this.discard(agent, repo.main, path, branch);
        throw e;
      }
    });
  }

  /** Closes the review's agent and removes its worktree and branch; failures are logged. */
  private async discard(
    agent: Agent | undefined,
    main: string,
    path: string,
    branch: string,
  ): Promise<void> {
    const warn = (e: unknown) => {
      console.warn(`[pr-reviews] couldn't discard ${path}: ${(e as Error).message}`);
    };
    if (agent !== undefined) await this.deps.manager.close(agent.id).catch(warn);
    await discardReviewWorktree(main, path, branch).catch(warn);
  }
}
