import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentInfo,
  type FileContentResponse,
  type GitDiffResponse,
  type PrAttachment,
  type Snapshot,
  splitPrBlocks,
} from "@pi-code/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnRequest } from "../agents/agent-manager.ts";
import type { ErrorEnvelope } from "../errors.ts";
import { remotePrHead } from "../git/pr.ts";
import type { GhRunner } from "../pr/github.ts";
import { type Harness, promptAndSettle, startHarness } from "../testing/http-harness.ts";
import { git } from "../testing/layout-repo.ts";
import { type FakePr, fakeGh, makePrRepo, type PrRepo, pushToPr } from "../testing/pr-repo.ts";

// The real `remotePrHead`, watched, to tell a failed poll from one that never ran.
vi.mock("../git/pr.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/pr.ts")>();
  return { ...actual, remotePrHead: vi.fn(actual.remotePrHead) };
});

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));

let harness: Harness | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = undefined;
});

/** A harness running mini-pi in a clone of a repo with PRs 7 (open) and 8 (merged). */
async function start(prs: (repo: PrRepo) => FakePr[]) {
  let h: Harness | undefined;
  const sessions = () => join((h as Harness).agentDir, "sessions", "--project--");
  const command = (req: SpawnRequest) => ({
    bin: process.execPath,
    args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
    env: { ...process.env, MINI_PI_SESSION_DIR: sessions() },
  });
  // Answers for the PRs as they are once the repo exists; `setPrs` and `setGh` change them.
  let fake: GhRunner = fakeGh([]);
  h = await startHarness({ command, gh: (cwd, args) => fake(cwd, args) });
  harness = h;
  mkdirSync(sessions(), { recursive: true });
  const repo = makePrRepo(h.root, h.project);
  fake = fakeGh(prs(repo));
  return {
    h,
    repo,
    setPrs: (next: FakePr[]) => {
      fake = fakeGh(next);
    },
    setGh: (gh: GhRunner) => {
      fake = gh;
    },
  };
}

const OPEN = (repo: PrRepo): FakePr => ({
  number: 7,
  state: "OPEN",
  baseRefOid: repo.root,
  headRefOid: repo.head,
  current: true,
  comments: [{ author: { login: "bob" }, body: "Looks good", createdAt: "2026-01-02T00:00:00Z" }],
  reviews: [
    {
      author: { login: "dave" },
      body: "Ship it",
      state: "APPROVED",
      submittedAt: "2026-01-02T12:00:00Z",
    },
  ],
  inline: [
    {
      id: 1,
      path: "a.txt",
      line: 1,
      user: { login: "carol" },
      body: "Why two?",
      created_at: "2026-01-03T00:00:00Z",
      in_reply_to_id: null,
    },
  ],
});

const MERGED = (repo: PrRepo): FakePr => ({
  number: 8,
  state: "MERGED",
  baseRefOid: repo.mergedBase,
  headRefOid: repo.mergedHead,
});

function attach(h: Harness, agentId: string, pr?: string) {
  return h.json<{ pr: PrAttachment } & Partial<ErrorEnvelope>>(
    "POST",
    `/api/agents/${agentId}/pr`,
    pr === undefined ? {} : { pr },
  );
}

/** The `<pr>` blocks of the agent's user messages, in order. */
async function prPrompts(h: Harness, agentId: string) {
  const snapshot: Snapshot = await h.snapshot(agentId);
  return snapshot.transcript.entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((c) => ("text" in c ? c.text : "")).join("");
    return splitPrBlocks(text).prs.map((pr) => ({ ...pr, body: splitPrBlocks(text).body }));
  });
}

const prRefs = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname)", "refs/pi-code/")
    .split("\n")
    .filter(Boolean)
    .sort();

describe("POST /api/agents/:id/pr", () => {
  it("attaches the PR, prompts the agent with its context and pins its commits", async () => {
    const { h, repo } = await start((r) => [OPEN(r), MERGED(r)]);
    const agent = await h.open();
    const res = await attach(h, agent.id, "https://github.com/Octo/Repo/pull/7");
    expect(res.status).toBe(200);
    expect(res.body.pr).toEqual({
      repo: "octo/repo",
      number: 7,
      title: "PR 7",
      url: "https://github.com/octo/repo/pull/7",
      state: "open",
      baseRefName: "main",
      headRefName: "pr-7",
      baseSha: repo.root,
      headSha: repo.head,
      remoteHeadSha: repo.head,
    });
    const file = h.manager.require(agent.id).sessionFile as string;
    expect(h.prService.store.get(file)).toMatchObject({
      number: 7,
      commentsSince: "2026-01-02T12:00:00Z",
      reportedInline: [1],
    });

    const [context] = await prPrompts(h, agent.id);
    expect(context).toMatchObject({ number: 7, title: "PR 7", state: "open", update: false });
    expect(context?.text).toContain(`git diff ${repo.root}..${repo.head}`);
    expect(context?.text).toContain("git ls-remote origin refs/pull/7/head");
    expect(context?.text).toContain("gh pr review 7 --repo octo/repo");
    expect(context?.text).toContain("gh api repos/octo/repo/pulls/7/comments");
    expect(context?.text).toContain("- a.txt (+1 −1)");
    expect(context?.text).toMatch(
      /Commits \(newest first, merges counted once\):\n- [0-9a-f]{7,} add b\n- [0-9a-f]{7,} change a\n\nChanged files/,
    );
    expect(context?.text).toContain("Author: @alice");
    expect(context?.text).toContain("Description:\n  The description.");
    expect(context?.text).toContain("@bob commented");
    expect(context?.text).toContain("@dave reviewed (approved)");
    expect(context?.text).toContain("- a.txt:1, @carol");
    expect(context?.body).toMatch(/overview/);

    expect(prRefs(h.project)).toEqual(
      [`refs/pi-code/pr/7/${repo.head}`, `refs/pi-code/pr/7/${repo.root}`].sort(),
    );
    // The working tree is untouched.
    expect(git(h.project, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");

    const again = await attach(h, agent.id, "8");
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("pr_attached");
  });

  it("serves the PR diff and the files at its commits", async () => {
    const { h, repo } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    expect((await attach(h, agent.id)).status).toBe(200);

    const diff = await h.json<GitDiffResponse>("GET", `/api/agents/${agent.id}/git/diff?pr=1`);
    expect(diff.status).toBe(200);
    expect(diff.body.files.map((f) => [f.status, f.path])).toEqual([
      ["modified", "a.txt"],
      ["added", "b.txt"],
    ]);
    expect(diff.body.oldRev).toBe(repo.root.slice(0, 7));
    expect(diff.body.newRev).toBe(repo.head.slice(0, 7));

    // b.txt exists only at the PR head, not on disk.
    const rev = repo.head.slice(0, 7);
    const file = await h.json<FileContentResponse>(
      "GET",
      `/api/agents/${agent.id}/files/content?path=b.txt&rev=${rev}`,
    );
    expect(file.body).toEqual({
      path: "b.txt",
      rev,
      content: "b\n",
      binary: false,
      tooLarge: false,
    });
  });

  it("refuses other repos, non-GitHub origins, unknown PRs and a branch without one", async () => {
    const { h } = await start((r) => [{ ...OPEN(r), current: false }]);
    const agent = await h.open();
    const other = await attach(h, agent.id, "https://github.com/someone/else/pull/7");
    expect(other.status).toBe(400);
    expect(other.body.error?.message).toMatch(/someone\/else.*octo\/repo/);
    expect((await attach(h, agent.id, "99")).body.error?.code).toBe("pr_not_found");
    expect((await attach(h, agent.id)).body.error).toEqual({
      code: "pr_not_found",
      message: "No PR for this branch",
    });
    expect((await attach(h, agent.id, "nope")).body.error?.code).toBe("invalid_body");
    git(h.project, "config", "remote.origin.url", "https://example.com/octo/repo.git");
    expect((await attach(h, agent.id, "7")).body.error?.code).toBe("not_a_github_repo");
    expect(h.prService.store.current()).toEqual({});
  });

  it("refuses a PR of the folder's other remotes: only origin's repo counts", async () => {
    const { h, repo, setGh } = await start(() => []);
    // `upstream` names a GitHub repo that would serve PR 7 too.
    const upstream = "git@github.com:octo/upstream.git";
    git(h.project, "remote", "add", "upstream", upstream);
    git(h.project, "config", `url.${repo.origin}.insteadOf`, upstream);
    const gh = fakeGh([{ ...OPEN(repo), url: "https://github.com/octo/upstream/pull/7" }]);
    setGh(gh);
    const agent = await h.open();
    const res = await attach(h, agent.id, "https://github.com/octo/upstream/pull/7");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: "invalid_body",
      message: "that PR is in octo/upstream, but this folder's origin is octo/repo",
    });
    expect(gh.calls).toEqual([]);
    expect(h.prService.store.current()).toEqual({});
    expect(prRefs(h.project)).toEqual([]);
  });

  it("refuses a malformed body", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    for (const body of [{ pr: 7 }, { pr: "7", force: true }, ["7"]]) {
      const res = await h.json<ErrorEnvelope>("POST", `/api/agents/${agent.id}/pr`, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: "invalid_body", message: "expected { pr?: string }" });
    }
    expect(h.prService.store.current()).toEqual({});
  });

  it("refuses a folder that isn't a git repository", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    rmSync(join(h.project, ".git"), { recursive: true, force: true });
    const agent = await h.open();
    const res = await attach(h, agent.id, "7");
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("not_a_git_repo");
    expect(h.prService.store.current()).toEqual({});
  });

  it("refuses a branch PR gh finds in another repo, but follows a renamed repo's number", async () => {
    const { h, setPrs, repo } = await start((r) => [
      { ...OPEN(r), url: "https://github.com/someone/fork/pull/7" },
    ]);
    const agent = await h.open();
    const other = await attach(h, agent.id);
    expect(other.status).toBe(400);
    expect(other.body.error?.message).toBe(
      "this branch's PR is in someone/fork, but this folder's origin is octo/repo",
    );
    expect(h.prService.store.current()).toEqual({});

    // gh was asked for origin's PR 7 and answers with the repo's new name.
    setPrs([{ ...OPEN(repo), url: "https://github.com/octo/renamed/pull/7" }]);
    const renamed = await attach(h, agent.id, "7");
    expect(renamed.status).toBe(200);
    expect(renamed.body.pr).toMatchObject({ repo: "octo/repo", number: 7 });
  });

  it("attaches once when two attaches race", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    const results = await Promise.all([attach(h, agent.id, "7"), attach(h, agent.id, "7")]);
    expect(results.map((r) => r.body.error?.code ?? r.status).sort()).toEqual([200, "pr_attached"]);
    expect(await prPrompts(h, agent.id)).toHaveLength(1);
  });

  it("steers a running agent with the context and update prompts", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    await h.rpc(agent.id, { type: "prompt", message: "hang" });
    await h.idle(agent.id);
    expect((await attach(h, agent.id, "7")).status).toBe(200);
    expect((await h.api("POST", `/api/agents/${agent.id}/pr/refresh`, {})).status).toBe(200);
    await h.idle(agent.id);
    const { live } = await h.snapshot(agent.id);
    const queued = live.queue.steering.map((m) => splitPrBlocks(m).prs[0]?.update);
    expect(queued).toEqual([undefined, false, true]);
  });

  it("refuses to deliver when the conversation moved to another session meanwhile", async () => {
    const { h, repo, setGh } = await start(() => []);
    const real = fakeGh([OPEN(repo)]);
    let viewing!: () => void;
    let release!: () => void;
    const viewed = new Promise<void>((resolve) => {
      viewing = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setGh(async (cwd, args) => {
      if (args[1] === "view") {
        viewing();
        await gate;
      }
      return real(cwd, args);
    });
    const agent = await h.open();
    const attaching = attach(h, agent.id, "7");
    await viewed;
    expect((await h.rpc(agent.id, { type: "new_session" })).status).toBe(200);
    release();
    const res = await attaching;
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("agent_busy");
    expect(h.prService.store.current()).toEqual({});
    expect(await prPrompts(h, agent.id)).toEqual([]);
  });

  it("pins a worktree conversation's commits in the repository's shared refs", async () => {
    const { h, repo } = await start((r) => [OPEN(r)]);
    const worktree = join(h.home, "wt");
    git(h.project, "worktree", "add", "-q", worktree);
    const opened = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", { cwd: worktree });
    expect(opened.status).toBe(201);
    const inWorktree = opened.body.agent.id;
    await h.waitForStatus(inWorktree, "ready");
    expect((await attach(h, inWorktree, "7")).status).toBe(200);
    const commonDir = git(h.project, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const worktreeFile = h.manager.require(inWorktree).sessionFile as string;
    expect(h.prService.store.get(worktreeFile)?.gitDir).toBe(commonDir.trim());

    // The main checkout's conversation moves on twice, dropping its own pin of the first head.
    const main = await h.open();
    expect((await attach(h, main.id, "7")).status).toBe(200);
    const first = pushToPr(repo, h.root);
    expect((await h.api("POST", `/api/agents/${main.id}/pr/refresh`, {})).status).toBe(200);
    const second = pushToPr(repo, h.root, "f.txt");
    expect((await h.api("POST", `/api/agents/${main.id}/pr/refresh`, {})).status).toBe(200);
    const mainFile = h.manager.require(main.id).sessionFile as string;
    expect(h.prService.store.get(mainFile)).toMatchObject({
      headSha: second,
      previousHeadSha: first,
    });
    // The worktree conversation still pins it.
    expect(prRefs(worktree)).toEqual(
      [
        `refs/pi-code/pr/7/${second}`,
        `refs/pi-code/pr/7/${first}`,
        `refs/pi-code/pr/7/${repo.head}`,
        `refs/pi-code/pr/7/${repo.root}`,
      ].sort(),
    );
  });

  it("refuses the PR diff of a conversation without a PR", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    const diff = await h.json<ErrorEnvelope>("GET", `/api/agents/${agent.id}/git/diff?pr=1`);
    expect(diff.status).toBe(400);
    expect(diff.body.error.code).toBe("invalid_body");
  });

  it("pins a merged PR's recorded base", async () => {
    const { h, repo } = await start((r) => [MERGED(r)]);
    const agent = await h.open();
    const res = await attach(h, agent.id, "8");
    expect(res.body.pr).toMatchObject({ state: "merged", baseSha: repo.mergedBase });
    const diff = await h.json<GitDiffResponse>("GET", `/api/agents/${agent.id}/git/diff?pr=1`);
    expect(diff.body.files.map((f) => f.path)).toEqual(["d.txt"]);
  });
});

describe("Outdated and refresh", () => {
  it("polls the PR head, after turns too, and refresh re-pins it and tells the agent", async () => {
    const { h, repo } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    await attach(h, agent.id, "7");
    const file = h.manager.require(agent.id).sessionFile as string;
    const client = h.stream();

    const pushed = pushToPr(repo, h.root);
    expect((await h.api("POST", `/api/agents/${agent.id}/pr/poll`, {})).status).toBe(204);
    expect(h.prService.store.get(file)).toMatchObject({
      headSha: repo.head,
      remoteHeadSha: pushed,
    });
    await client.waitFor((f) => f.type === "prs" && f.prs[file]?.remoteHeadSha === pushed);

    // A turn's end polls too, once the last poll is old enough.
    const second = pushToPr(repo, h.root, "f.txt");
    const now = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => now() + 60_000);
    await promptAndSettle(h, agent.id);
    await client.waitFor((f) => f.type === "prs" && f.prs[file]?.remoteHeadSha === second);

    // Refresh pins the head as fetched, even while gh still reports the previous one.
    const refreshed = await h.json<{ pr: PrAttachment }>(
      "POST",
      `/api/agents/${agent.id}/pr/refresh`,
      {},
    );
    expect(refreshed.body.pr).toMatchObject({ headSha: second, remoteHeadSha: second });
    const update = (await prPrompts(h, agent.id)).at(-1);
    expect(update?.update).toBe(true);
    expect(update?.text).toContain(`New commits since ${repo.head.slice(0, 7)}`);
    expect(update?.text).toContain(`git diff ${repo.head}..${second}`);
    // Comments already reported aren't repeated.
    expect(update?.text).not.toContain("Why two?");
    // The previous head stays pinned while the update prompt diffs against it.
    expect(prRefs(h.project)).toEqual(
      [
        `refs/pi-code/pr/7/${second}`,
        `refs/pi-code/pr/7/${repo.head}`,
        `refs/pi-code/pr/7/${repo.root}`,
      ].sort(),
    );

    // A refresh without new pushes keeps the previous head pinned.
    expect((await h.api("POST", `/api/agents/${agent.id}/pr/refresh`, {})).status).toBe(200);
    expect(h.prService.store.get(file)).toMatchObject({
      headSha: second,
      previousHeadSha: repo.head,
    });
    expect((await prPrompts(h, agent.id)).at(-1)?.text).toContain("No new commits.");
    expect(prRefs(h.project)).toHaveLength(3);
  });

  it("re-pins a PR merged since, on GitHub's recorded base, and stops polling it", async () => {
    const { h, repo, setPrs } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    await attach(h, agent.id, "7");
    const file = h.manager.require(agent.id).sessionFile as string;

    // main fast-forwards to the PR's head: its merge-base with main is the head itself now.
    git(repo.origin, "update-ref", "refs/heads/main", repo.head);
    setPrs([{ ...OPEN(repo), state: "MERGED" }]);
    const refreshed = await h.json<{ pr: PrAttachment }>(
      "POST",
      `/api/agents/${agent.id}/pr/refresh`,
      {},
    );
    expect(refreshed.body.pr).toMatchObject({
      state: "merged",
      baseSha: repo.root,
      headSha: repo.head,
    });
    expect((await prPrompts(h, agent.id)).at(-1)?.text).toContain("State: merged (was open)");

    const remoteHead = vi.mocked(remotePrHead);
    remoteHead.mockClear();
    pushToPr(repo, h.root);
    expect((await h.api("POST", `/api/agents/${agent.id}/pr/poll`, {})).status).toBe(204);
    expect(remoteHead).not.toHaveBeenCalled();
    expect(h.prService.store.get(file)?.remoteHeadSha).toBe(repo.head);
  });

  it("polls on turn ends at most every 30 seconds, deferring the rest to the interval's end", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const opened = await h.open();
    await attach(h, opened.id, "7");
    await h.idle(opened.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const poll = vi.spyOn(h.prService, "poll");
      h.prService.onTurnEnd(opened.id);
      await poll.mock.results[0]?.value;
      h.prService.onTurnEnd(opened.id);
      vi.advanceTimersByTime(29_000);
      h.prService.onTurnEnd(opened.id);
      expect(poll).toHaveBeenCalledTimes(1);
      // The last turn ended within the interval, and is still followed by a poll.
      vi.advanceTimersByTime(1_000);
      expect(poll).toHaveBeenCalledTimes(2);
      await poll.mock.results[1]?.value;
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a deferred turn-end poll once the agent moved to another session or is gone", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const opened = await h.open();
    await attach(h, opened.id, "7");
    await h.idle(opened.id);
    const attached = h.manager.require(opened.id).sessionFile as string;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const poll = vi.spyOn(h.prService, "poll");
      h.prService.onTurnEnd(opened.id);
      await poll.mock.results[0]?.value;
      // Deferred, then the agent goes before the timer fires.
      h.prService.onTurnEnd(opened.id);
      const get = vi.spyOn(h.manager, "get").mockReturnValue(undefined);
      vi.advanceTimersByTime(30_000);
      expect(poll).toHaveBeenCalledTimes(1);
      get.mockRestore();

      // Deferred, then the conversation moves to a new session before the timer fires.
      h.prService.onTurnEnd(opened.id);
      expect(poll).toHaveBeenCalledTimes(2);
      await poll.mock.results[1]?.value;
      h.prService.onTurnEnd(opened.id);
      expect((await h.rpc(opened.id, { type: "new_session" })).status).toBe(200);
      expect(h.manager.require(opened.id).sessionFile).not.toBe(attached);
      vi.advanceTimersByTime(30_000);
      expect(poll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to refresh a conversation without a PR", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("POST", `/api/agents/${agent.id}/pr/refresh`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: "invalid_body",
      message: "this conversation isn't attached to a PR",
    });
  });

  it("shares a running poll and keeps the last state when it fails", async () => {
    const { h, repo } = await start((r) => [OPEN(r)]);
    const opened = await h.open();
    await attach(h, opened.id, "7");
    const agent = h.manager.require(opened.id);
    const file = agent.sessionFile as string;
    const first = h.prService.poll(agent);
    expect(h.prService.poll(agent)).toBe(first);
    await first;

    pushToPr(repo, h.root);
    git(h.project, "config", "remote.origin.url", join(h.root, "missing.git"));
    const remoteHead = vi.mocked(remotePrHead);
    remoteHead.mockClear();
    expect((await h.api("POST", `/api/agents/${opened.id}/pr/poll`, {})).status).toBe(204);
    // The poll ran and failed.
    expect(remoteHead).toHaveBeenCalledTimes(1);
    await expect(remoteHead.mock.results[0]?.value).rejects.toMatchObject({ code: "git_failed" });
    expect(h.prService.store.get(file)?.remoteHeadSha).toBe(repo.head);
  });

  it("doesn't poll merged PRs", async () => {
    const { h, repo } = await start((r) => [MERGED(r)]);
    const agent = await h.open();
    await attach(h, agent.id, "8");
    git(repo.origin, "update-ref", "refs/pull/8/head", repo.root);
    await h.api("POST", `/api/agents/${agent.id}/pr/poll`, {});
    const file = h.manager.require(agent.id).sessionFile as string;
    expect(h.prService.store.get(file)?.remoteHeadSha).toBe(repo.mergedHead);
  });
});

describe("attachments follow the session", () => {
  it("copies the attachment to clones", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    await attach(h, agent.id, "7");
    const original = h.manager.require(agent.id).sessionFile as string;

    expect((await h.rpc(agent.id, { type: "clone" })).status).toBe(200);
    const cloned = h.manager.require(agent.id).sessionFile as string;
    expect(cloned).not.toBe(original);
    expect(h.prService.store.get(cloned)).toEqual(h.prService.store.get(original));
  });

  it("refuses tree navigation and forks of an attached conversation", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const attached = await h.open();
    const plain = await h.open();
    await attach(h, attached.id, "7");
    await promptAndSettle(h, plain.id, "hello");
    const firstUser = async (id: string) =>
      (await h.snapshot(id)).transcript.entries.find(
        (e) => e.type === "message" && e.message.role === "user",
      )?.id as string;
    const navigate = async (id: string) =>
      h.json<ErrorEnvelope>("POST", `/api/agents/${id}/tree/navigate`, {
        entryId: await firstUser(id),
        summarize: false,
      });
    const fork = async (id: string) =>
      h.json<ErrorEnvelope>("POST", `/api/agents/${id}/rpc`, {
        type: "fork",
        entryId: await firstUser(id),
      });

    const navigatePrompt = async (id: string) =>
      h.json<ErrorEnvelope>("POST", `/api/agents/${id}/rpc`, {
        type: "prompt",
        message: `/pi-code-tree ${JSON.stringify({ entryId: await firstUser(id) })}`,
      });

    const file = h.manager.require(attached.id).sessionFile;
    const leafId = (await h.snapshot(attached.id)).transcript.leafId;
    for (const res of [
      await navigate(attached.id),
      await navigatePrompt(attached.id),
      await fork(attached.id),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("pr_attached");
    }
    expect(h.manager.require(attached.id).sessionFile).toBe(file);
    expect((await h.snapshot(attached.id)).transcript.leafId).toBe(leafId);

    expect((await navigate(plain.id)).status).toBe(200);
    expect((await navigatePrompt(plain.id)).status).toBe(200);
    expect((await fork(plain.id)).status).toBe(200);
  });

  it("refuses tree navigation and forks queued behind a switch to an attached session", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const owner = await h.open();
    await attach(h, owner.id, "7");
    const attachedFile = h.manager.require(owner.id).sessionFile as string;
    expect((await h.rpc(owner.id, { type: "new_session" })).status).toBe(200);

    const opened = await h.open();
    await promptAndSettle(h, opened.id, "hello");
    const agent = h.manager.require(opened.id);
    const entryId = (await h.snapshot(opened.id)).transcript.entries.find(
      (e) => e.type === "message" && e.message.role === "user",
    )?.id as string;

    // Holds the session lock until the switch and the requests behind it are queued.
    const exclusive = vi.spyOn(agent.pipeline, "exclusive");
    let release!: () => void;
    const held = agent.pipeline.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const switching = h.rpc(opened.id, { type: "switch_session", sessionPath: attachedFile });
    await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(2));
    const requests = [
      h.json<ErrorEnvelope>("POST", `/api/agents/${opened.id}/tree/navigate`, {
        entryId,
        summarize: false,
      }),
      h.rpc(opened.id, {
        type: "prompt",
        message: `/pi-code-tree ${JSON.stringify({ entryId })}`,
      }),
      h.rpc(opened.id, { type: "fork", entryId }),
    ];
    await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(5));
    release();
    await held;

    expect((await switching).status).toBe(200);
    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe("pr_attached");
    }
    expect(agent.sessionFile).toBe(attachedFile);
  });

  it("reports a clone as done even when copying the attachment fails", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    await attach(h, agent.id, "7");
    const original = h.manager.require(agent.id).sessionFile as string;
    vi.spyOn(h.prService.store, "copy").mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await h.rpc(agent.id, { type: "clone" })).status).toBe(200);
    expect(h.manager.require(agent.id).sessionFile).not.toBe(original);
  });

  it("drops the attachment and its refs when the session is deleted", async () => {
    const { h } = await start((r) => [OPEN(r)]);
    const agent = await h.open();
    await attach(h, agent.id, "7");
    const file = h.manager.require(agent.id).sessionFile as string;
    const client = h.stream();
    const res = await h.api("DELETE", "/api/sessions", { file });
    expect(res.status).toBe(204);
    await client.waitFor((f) => f.type === "prs" && f.prs[file] === undefined);
    await h.prService.store.prune();
    expect(prRefs(h.project)).toEqual([]);
  });
});
