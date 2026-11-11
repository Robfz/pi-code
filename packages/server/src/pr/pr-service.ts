/**
 * PR review (design/10-pr-review.md): attaching a conversation to a GitHub PR (`/pr`), refreshing
 * it, and polling its head for newer pushes. Each fetches through `gh` and `git` without a
 * checkout, pins the PR's base and head, stores the attachment by session file and, for attach and
 * refresh, prompts the agent (steering a running one). Attach and refresh also start the
 * conversation's PR guide (design/11-pr-guide.md), which is sent to the agent once ready.
 */
import { createHash } from "node:crypto";
import type { PrAttachment, PrGuide, PrGuideResponse } from "@pi-code/protocol";
import type { Agent, AgentManager } from "../agents/agent-manager.ts";
import { acceptsInput, assertAcceptsInput } from "../agents/commands.ts";
import { ApiError } from "../errors.ts";
import { gitDiff, requireWorkTree } from "../git/git.ts";
import {
  commitsBetween,
  diffStat,
  fetchPr,
  gitCommonDir,
  originRepo,
  pinBase,
  remotePrHead,
  repoFolder,
} from "../git/pr.ts";
import { guideKey } from "../store/guide-store.ts";
import { PrStore, prView, type StoredPr, type StoredPrs } from "../store/pr-store.ts";
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
import { guideUnits } from "./guide-hunks.ts";
import type { GuideInput } from "./guide-job.ts";
import {
  clientGuideState,
  type GuideListener,
  type GuideService,
  guideInputKey,
} from "./guide-service.ts";
import { contextMessage, guideMessage, latestCommentAt, updateMessage } from "./messages.ts";

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
  /** The conversations' PR guides, started on attach and Refresh and sent to them once ready. */
  guides: GuideService;
}

/** An attachment whose folder is known, so its guide key is. */
type KeyedPr = StoredPr & { folder: string };

/** The guide key of an attachment; `undefined` for one made before PR guides, without a folder. */
function prGuideKey(pr: StoredPr): string | undefined {
  return pr.folder === undefined ? undefined : guideKey(pr);
}

/** The guide keys `prs` pin. */
function pinnedGuideKeys(prs: StoredPrs): Set<string> {
  return new Set(Object.values(prs).flatMap((pr) => prGuideKey(pr) ?? []));
}

/** Every id a guide references: its sections' hunks and its other changes. */
function guideIds(guide: PrGuide): Set<string> {
  return new Set([...guide.sections.flatMap((s) => s.hunks), ...guide.other]);
}

/** This generation of a guide: a regenerated guide hashes differently. */
function guideGeneration(guide: PrGuide): string {
  return createHash("sha256").update(JSON.stringify(guide)).digest("hex").slice(0, 16);
}

const UNRESOLVED = "the guide names hunks the PR diff doesn't have; retry";

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
  private readonly guides: GuideService;
  /** Guide prunes, one at a time, each keeping the keys pinned when it starts. */
  private pruning: Promise<void> = Promise.resolve();
  /**
   * The generation (`guideGeneration`) of the guide last sent to each session file, so a guide
   * both a job's end and an attach (or Refresh) find ready is sent once.
   */
  private readonly delivered = new Map<string, string>();
  private readonly unsubscribe: (() => void)[];

  constructor(deps: PrServiceDeps) {
    this.agents = deps.agents;
    this.store = new PrStore(deps.dataDir, {
      keep: (file) => deps.agents().ownerOf(file) !== undefined,
    });
    this.gh = deps.gh ?? runGh;
    this.prompt = deps.prompt ?? sendPrompt;
    this.guides = deps.guides;
    this.unsubscribe = [
      this.guides.subscribe(this.onGuide),
      // Every change of the attachments (attach, refresh, copy, prune) may unpin a guide.
      this.store.subscribe(() => this.pruneGuides()),
    ];
    void this.store.ready.then(() => this.pruneGuides());
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
      const [fetched, gitDir, folder] = await Promise.all([
        this.fetch(agent.cwd, repo, target.number),
        gitCommonDir(agent.cwd),
        repoFolder(agent.cwd),
      ]);
      const pr = this.entry(fetched, repo, gitDir, folder);
      const [files, commits] = await Promise.all([
        diffStat(agent.cwd, fetched.baseSha, fetched.headSha),
        commitsBetween(agent.cwd, fetched.baseSha, fetched.headSha),
      ]);
      const message = contextMessage(pr, fetched.view, fetched.inline, files, commits);
      await this.deliver(agent, file, pr, message);
      await this.startGuide(agent, file, pr, fetched.view);
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
      const [fetched, folder] = await Promise.all([
        this.fetch(agent.cwd, previous.repo, previous.number),
        previous.folder ?? repoFolder(agent.cwd),
      ]);
      const { view, baseSha, headSha, inline } = fetched;
      const pr = this.entry(fetched, previous.repo, previous.gitDir, folder, previous);
      const previousHead =
        headSha === previous.headSha ? previous.previousHeadSha : previous.headSha;
      if (previousHead !== undefined) pr.previousHeadSha = previousHead;
      const [files, commits] = await Promise.all([
        diffStat(agent.cwd, baseSha, headSha),
        commitsBetween(agent.cwd, previous.headSha, headSha),
      ]);
      const message = updateMessage(previous, pr, view, inline, files, commits);
      await this.deliver(agent, file, pr, message);
      // The prune that storing `pr` started cancels the previous key's job once nothing pins it.
      if (guideKey(pr) !== prGuideKey(previous)) await this.startGuide(agent, file, pr, view);
      return prView(pr);
    });
  }

  /**
   * The conversation's PR guide: `generating`, `failed` (a key without a guide or a job reads as
   * failed too), or `ready` with every unit it references resolved against the pinned PR diff.
   * Throws `invalid_body` when no PR is attached.
   */
  async guide(agent: Agent): Promise<PrGuideResponse> {
    const { pr } = await this.guideTarget(agent);
    const key = guideKey(pr);
    const state = clientGuideState(await this.guides.status(key));
    if (state.state !== "ready") return { key, ...state };
    const diff = await gitDiff(agent.cwd, { range: { from: pr.baseSha, to: pr.headSha } });
    const units = guideUnits(diff.files, guideIds(state.guide));
    if (units === undefined) return { key, state: "failed", error: UNRESOLVED };
    return {
      key,
      state: "ready",
      id: guideGeneration(state.guide),
      guide: state.guide,
      units,
      oldRev: diff.oldRev ?? pr.baseSha,
      newRev: diff.newRev ?? pr.headSha,
    };
  }

  /**
   * Retry: generates the conversation's PR guide again, its PR's title and description re-read
   * with `gh`; the new guide is sent to the agents attached to it once ready. Throws
   * `invalid_body` when no PR is attached, and `gh`'s errors (`gh_failed`, `pr_not_found`).
   */
  async retryGuide(agent: Agent): Promise<PrGuideResponse> {
    const file = sessionFileOf(agent);
    return this.locked(file, async () => {
      const { pr, stored } = await this.guideTarget(agent);
      const view = await viewPr(this.gh, agent.cwd, pr.repo, pr.number);
      if (stored.folder === undefined) await this.store.set(file, pr);
      const input = guideInput(agent.cwd, pr, view);
      void this.guides.regenerate(input);
      return { key: guideInputKey(input), state: "generating" };
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

  /** Cancels the deferred polls and stops following the guides and the store. */
  close(): void {
    for (const timer of this.deferred.values()) clearTimeout(timer);
    this.deferred.clear();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  /**
   * The agent's attachment with its folder: the stored one, or for an attachment made before PR
   * guides, read from the agent's folder. Throws `invalid_body` when no PR is attached.
   */
  private async guideTarget(agent: Agent): Promise<{ pr: KeyedPr; stored: StoredPr }> {
    const stored = this.store.get(sessionFileOf(agent));
    if (stored === undefined) {
      throw new ApiError("invalid_body", "this conversation isn't attached to a PR");
    }
    return { pr: { ...stored, folder: stored.folder ?? (await repoFolder(agent.cwd)) }, stored };
  }

  /**
   * Starts the guide of `pr`, just attached or moved by a Refresh: a stored guide is sent to the
   * agent right away, else its job is started (or joined) and the guide sent once ready. A
   * failure is logged: the attachment is stored by now.
   */
  private async startGuide(agent: Agent, file: string, pr: KeyedPr, view: PrView): Promise<void> {
    try {
      // A prune that started before `pr` was stored may still delete its key's guide.
      await this.pruning;
      const input = guideInput(agent.cwd, pr, view);
      const state = await this.guides.status(guideInputKey(input));
      if (state.state !== "ready") {
        void this.guides.ensure(input);
        return;
      }
      const guide = state.guide;
      await this.sendGuide(agent, file, guide, () => this.guidePrompt(agent.cwd, pr, guide));
    } catch (e) {
      console.warn(`[guides] couldn't start the guide of ${file}: ${(e as Error).message}`);
    }
  }

  /**
   * Sends a guide whose job just ended ready to every live agent attached to its key, its prompt
   * built once; a guide no attachment pins any more (cancelled while storing) is pruned.
   */
  private readonly onGuide: GuideListener = (key, state, { finished }) => {
    if (!finished || state.state !== "ready") return;
    const guide = state.guide;
    const attached = Object.entries(this.store.current()).filter(
      ([, pr]) => prGuideKey(pr) === key,
    );
    if (attached.length === 0) {
      this.pruneGuides();
      return;
    }
    // One prompt for all: the attachments of a key share its commits and folder. It is built from
    // the attachments as the job ended, which pin the guide's diff whatever a Refresh does since.
    let prompt: Promise<string> | undefined;
    for (const [file, pr] of attached) {
      // Behind any attach or refresh of the conversation, which may move it to another key.
      void this.locked(file, async () => {
        const current = this.store.get(file);
        const id = this.agents().ownerOf(file);
        const agent = id === undefined ? undefined : this.agents().get(id);
        if (current === undefined || prGuideKey(current) !== key) return;
        if (agent === undefined || !acceptsInput(agent)) return;
        await this.sendGuide(agent, file, guide, () => {
          prompt ??= this.guidePrompt(agent.cwd, pr, guide);
          return prompt;
        });
      }).catch((e: unknown) => {
        console.warn(`[guides] couldn't send the guide to ${file}: ${(e as Error).message}`);
      });
    }
  };

  /** The `<pr-guide>` prompt of `guide`, its units resolved against `pr`'s diff read in `cwd`. */
  private async guidePrompt(cwd: string, pr: StoredPr, guide: PrGuide): Promise<string> {
    const diff = await gitDiff(cwd, { range: { from: pr.baseSha, to: pr.headSha } });
    const units = guideUnits(diff.files, guideIds(guide));
    if (units === undefined) throw new Error(UNRESOLVED);
    return guideMessage(pr, guide, units);
  }

  /**
   * Prompts the agent with `guide` (`prompt` builds the message), unless `file` already got this
   * generation of it or the agent moved to another session file. Runs within `file`'s lock.
   */
  private async sendGuide(
    agent: Agent,
    file: string,
    guide: PrGuide,
    prompt: () => Promise<string>,
  ): Promise<void> {
    const id = guideGeneration(guide);
    if (this.delivered.get(file) === id) return;
    const message = await prompt();
    await agent.pipeline.exclusive(async () => {
      if (agent.sessionFile !== file) return;
      await this.prompt(agent, message);
      this.delivered.set(file, id);
    });
  }

  /**
   * Keeps only the guides the attachments pin (`GuideService.prune`), and forgets the guides
   * sent to conversations no longer attached.
   */
  private pruneGuides(): void {
    const prs = this.store.current();
    for (const file of this.delivered.keys()) {
      if (prs[file] === undefined) this.delivered.delete(file);
    }
    this.pruning = this.pruning
      .then(() => this.guides.prune(pinnedGuideKeys(this.store.current())))
      .catch((e: unknown) => {
        console.warn(`[guides] prune failed: ${(e as Error).message}`);
      });
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
    folder: string,
    previous?: StoredPr,
  ): KeyedPr {
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
      folder,
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

function guideInput(cwd: string, pr: KeyedPr, view: Pick<PrView, "title" | "body">): GuideInput {
  return {
    cwd,
    folder: pr.folder,
    pr: { repo: pr.repo, number: pr.number, title: view.title, body: view.body },
    baseSha: pr.baseSha,
    headSha: pr.headSha,
  };
}

function sessionFileOf(agent: Agent): string {
  const file = agent.sessionFile;
  if (file === undefined) throw new ApiError("agent_busy", "the agent has no session yet");
  return file;
}
