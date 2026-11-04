/**
 * PR review (design/10-pr-review.md): attaching a conversation to a GitHub PR (`/pr`), refreshing
 * it, and polling its head for newer pushes. Each fetches through `gh` and `git` without a
 * checkout, pins the PR's base and head, stores the attachment by session file and, for attach and
 * refresh, prompts the agent (steering a running one).
 */
import type { PrAttachment } from "@pi-code/protocol";
import type { Agent, AgentManager } from "../agents/agent-manager.ts";
import { assertAcceptsInput } from "../agents/commands.ts";
import { ApiError } from "../errors.ts";
import { requireWorkTree } from "../git/git.ts";
import {
  commitsBetween,
  diffStat,
  fetchPr,
  gitCommonDir,
  originRepo,
  pinBase,
  remotePrHead,
} from "../git/pr.ts";
import { PrStore, prView, type StoredPr } from "../store/pr-store.ts";
import {
  type GhRunner,
  type InlineComment,
  inlineComments,
  type PrView,
  parsePrArg,
  parsePrUrl,
  runGh,
  sameRepo,
  viewPr,
} from "./github.ts";
import { contextMessage, latestCommentAt, updateMessage } from "./messages.ts";

/** The least time between two polls of a conversation started by its turns. */
const TURN_POLL_INTERVAL_MS = 30_000;

/** Sends `message` to `agent` as a prompt; a running agent is steered. */
type PromptSender = (agent: Agent, message: string) => Promise<void>;

/** `prompt` as the composer sends it while the agent runs; pi ignores the behavior when idle. */
const sendPrompt: PromptSender = async (agent, message) => {
  assertAcceptsInput(agent);
  const data = await agent.host.send({ type: "prompt", message, streamingBehavior: "steer" });
  await agent.pipeline.afterCommand("prompt", data);
};

export interface PrServiceDeps {
  /** Where the store keeps `prs.json`. */
  dataDir: string;
  /**
   * The agents: the store keeps the entry of a session file one holds, and `onTurnEnd` finds the
   * agent to poll.
   */
  agents: () => Pick<AgentManager, "get" | "ownerOf">;
  /** Default: the real `gh`. */
  gh?: GhRunner;
  /** Default: an RPC `prompt` with `streamingBehavior: "steer"`. */
  prompt?: PromptSender;
}

interface Fetched {
  view: PrView;
  baseSha: string;
  headSha: string;
  inline: InlineComment[];
}

export class PrService {
  readonly store: PrStore;
  private readonly agents: PrServiceDeps["agents"];
  private readonly gh: GhRunner;
  private readonly prompt: PromptSender;
  /** Attach, refresh and poll run one at a time per session file. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Polls in flight by session file, so repeated triggers share one. */
  private readonly polls = new Map<string, Promise<void>>();
  /** When each session file's last poll was asked for (`Date.now()`). */
  private readonly polledAt = new Map<string, number>();
  /** Polls deferred by `onTurnEnd` to the end of the interval, by session file. */
  private readonly deferred = new Map<string, NodeJS.Timeout>();

  constructor(deps: PrServiceDeps) {
    this.agents = deps.agents;
    this.store = new PrStore(deps.dataDir, {
      keep: (file) => deps.agents().ownerOf(file) !== undefined,
    });
    this.gh = deps.gh ?? runGh;
    this.prompt = deps.prompt ?? sendPrompt;
  }

  /**
   * `/pr [arg]`: attaches the agent's conversation to the PR `arg` names (a URL or number), or
   * to the current branch's PR, and sends the agent its context. Throws `pr_attached`,
   * `not_a_git_repo`, `not_a_github_repo`, `invalid_body` (a bad argument or another repo's
   * PR), `pr_not_found`, `gh_failed`, `git_failed`, or `agent_busy` when the conversation moved
   * to another session during the fetch.
   */
  async attach(agent: Agent, arg: string): Promise<PrAttachment> {
    assertAcceptsInput(agent);
    const target = parsePrArg(arg);
    const file = sessionFileOf(agent);
    return this.locked(file, async () => {
      if (this.store.get(file) !== undefined) {
        throw new ApiError(
          "pr_attached",
          "this conversation is already attached to a PR; start a new conversation for another",
        );
      }
      await requireWorkTree(agent.cwd);
      const repo = await originRepo(agent.cwd);
      if (target.repo !== undefined && !sameRepo(target.repo, repo)) {
        throw new ApiError(
          "invalid_body",
          `that PR is in ${target.repo}, but this folder's origin is ${repo}`,
        );
      }
      const [fetched, gitDir] = await Promise.all([
        this.fetch(agent.cwd, repo, target.number),
        gitCommonDir(agent.cwd),
      ]);
      const pr = this.entry(fetched, repo, gitDir);
      const files = await diffStat(agent.cwd, fetched.baseSha, fetched.headSha);
      await this.deliver(agent, file, pr, contextMessage(pr, fetched.view, fetched.inline, files));
      return prView(pr);
    });
  }

  /**
   * Re-fetches the attached PR, pins its new base and head, and sends the agent what changed
   * (commits, files, new comments). Throws `invalid_body` when no PR is attached, and the
   * errors of `attach`.
   */
  async refresh(agent: Agent): Promise<PrAttachment> {
    assertAcceptsInput(agent);
    const file = sessionFileOf(agent);
    return this.locked(file, async () => {
      const previous = this.store.get(file);
      if (previous === undefined) {
        throw new ApiError("invalid_body", "this conversation isn't attached to a PR");
      }
      const fetched = await this.fetch(agent.cwd, previous.repo, previous.number);
      const { view, baseSha, headSha, inline } = fetched;
      const pr = this.entry(fetched, previous.repo, previous.gitDir, previous);
      const previousHead =
        headSha === previous.headSha ? previous.previousHeadSha : previous.headSha;
      if (previousHead !== undefined) pr.previousHeadSha = previousHead;
      const [files, commits] = await Promise.all([
        diffStat(agent.cwd, baseSha, headSha),
        commitsBetween(agent.cwd, previous.headSha, headSha),
      ]);
      const message = updateMessage(previous, pr, view, inline, files, commits);
      await this.deliver(agent, file, pr, message);
      return prView(pr);
    });
  }

  /**
   * Reads the attached PR's head on `origin` (`git ls-remote`) and stores it when it moved, which
   * marks the conversation Outdated. Merged PRs and conversations without a PR are skipped;
   * failures are silent. Concurrent calls for a conversation share one poll.
   */
  poll(agent: Pick<Agent, "cwd" | "sessionFile">): Promise<void> {
    const file = agent.sessionFile;
    const pr = file === undefined ? undefined : this.store.get(file);
    if (file === undefined || pr === undefined || pr.state === "merged") return Promise.resolve();
    this.polledAt.set(file, Date.now());
    const running = this.polls.get(file);
    if (running) return running;
    const poll = this.locked(file, async () => {
      const head = await remotePrHead(agent.cwd, pr.number);
      const current = this.store.get(file);
      if (head === undefined || current === undefined || current.remoteHeadSha === head) return;
      await this.store.set(file, { ...current, remoteHeadSha: head });
    })
      .catch(() => {})
      .finally(() => this.polls.delete(file));
    this.polls.set(file, poll);
    return poll;
  }

  /**
   * Polls the agent's PR after its turns, at most every `TURN_POLL_INTERVAL_MS` (a turn ends with
   * every model step): the pipeline's `onTurnEnd` hook. A turn ending sooner defers its poll to
   * the end of the interval, so the run's last turn (a push, say) is always followed by one.
   */
  readonly onTurnEnd = (agentId: string): void => {
    const agent = this.agents().get(agentId);
    const file = agent?.sessionFile;
    if (agent === undefined || file === undefined || this.deferred.has(file)) return;
    const wait = (this.polledAt.get(file) ?? 0) + TURN_POLL_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      void this.poll(agent);
      return;
    }
    const timer = setTimeout(() => {
      this.deferred.delete(file);
      const current = this.agents().get(agentId);
      if (current?.sessionFile === file) void this.poll(current);
    }, wait);
    timer.unref();
    this.deferred.set(file, timer);
  };

  /** Cancels the deferred polls. */
  close(): void {
    for (const timer of this.deferred.values()) clearTimeout(timer);
    this.deferred.clear();
  }

  /**
   * Fetches the PR's metadata, comments and commits and pins its base and head: the head as
   * fetched from `refs/pull/<n>/head` (what `poll` compares), which may be newer than gh's
   * `headRefOid`.
   */
  private async fetch(cwd: string, repo: string, number?: number): Promise<Fetched> {
    const view = await viewPr(this.gh, cwd, repo, number);
    // Without a number gh picks the repo itself, which may be another remote's. With one, gh was
    // given origin's repo, and its URL may name the repo's new name after a rename or transfer.
    const viewRepo = parsePrUrl(view.url)?.repo;
    if (number === undefined && (viewRepo === undefined || !sameRepo(viewRepo, repo))) {
      throw new ApiError(
        "invalid_body",
        `this branch's PR is in ${viewRepo ?? view.url}, but this folder's origin is ${repo}`,
      );
    }
    const pin = async () => {
      const { headSha, baseTip } = await fetchPr(cwd, view.number, view.baseRefName);
      const baseSha = await pinBase(cwd, {
        state: view.state,
        baseTip,
        baseRefOid: view.baseRefOid,
        headSha,
      });
      return { baseSha, headSha };
    };
    const [pinned, inline] = await Promise.all([
      pin(),
      inlineComments(this.gh, cwd, repo, view.number),
    ]);
    return { view, inline, ...pinned };
  }

  /**
   * Prompts the agent and stores `pr` for `file`, unless the agent moved to another session
   * meanwhile (a fetch takes seconds): session changes wait for this, and this for them.
   */
  private deliver(agent: Agent, file: string, pr: StoredPr, message: string): Promise<void> {
    return agent.pipeline.exclusive(async () => {
      if (agent.sessionFile !== file) {
        throw new ApiError(
          "agent_busy",
          "the conversation changed while the PR was fetched; run the command again",
        );
      }
      await this.prompt(agent, message);
      await this.store.set(file, pr);
    });
  }

  /**
   * The entry for a fetched PR, its comments marked as reported to the agent; `previous` is the
   * entry it replaces, whose newest comment time stands when the PR has none.
   */
  private entry(
    { view, baseSha, headSha, inline }: Fetched,
    repo: string,
    gitDir: string,
    previous?: StoredPr,
  ): StoredPr {
    const since = latestCommentAt(view) ?? previous?.commentsSince;
    return {
      repo,
      number: view.number,
      title: view.title,
      url: view.url,
      state: view.state,
      baseRefName: view.baseRefName,
      headRefName: view.headRefName,
      baseSha,
      headSha,
      remoteHeadSha: headSha,
      gitDir,
      ...(since !== undefined ? { commentsSince: since } : {}),
      reportedInline: inline.map((c) => c.id),
    };
  }

  private locked<T>(file: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(file) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => {});
    this.locks.set(file, settled);
    void settled.then(() => {
      if (this.locks.get(file) === settled) this.locks.delete(file);
    });
    return run;
  }
}

function sessionFileOf(agent: Agent): string {
  const file = agent.sessionFile;
  if (file === undefined) throw new ApiError("agent_busy", "the agent has no session yet");
  return file;
}
