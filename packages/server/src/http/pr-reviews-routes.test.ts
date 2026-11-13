import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentInfo, type PrGuide, type Snapshot, splitPrBlocks } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../agents/agent-manager.ts";
import type { ErrorEnvelope } from "../errors.ts";
import type { GhRunner } from "../pr/github.ts";
import type { GuideInput } from "../pr/guide-job.ts";
import { type Harness, startHarness } from "../testing/http-harness.ts";
import { git } from "../testing/layout-repo.ts";
import {
  type FakePr,
  fakeGh,
  makePrRepo,
  ORIGIN_URL,
  type PrRepo,
  pushToPr,
} from "../testing/pr-repo.ts";

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));
const URL_7 = "https://github.com/octo/repo/pull/7";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** PR 7, whose head is origin's `feature` branch. */
const OPEN = (repo: PrRepo): FakePr => ({
  number: 7,
  state: "OPEN",
  baseRefOid: repo.root,
  headRefOid: repo.head,
  headRefName: "feature",
});

/**
 * A harness running mini-pi, with a pinned layout repo `<home>/octo` whose main checkout is a
 * clone of a repo with PR 7 (head branch `feature` on origin), guides run by a runner that never
 * ends on its own.
 */
async function start() {
  let h: Harness | undefined;
  const sessions = () => join((h as Harness).agentDir, "sessions", "--reviews--");
  const command = (req: SpawnRequest) => ({
    bin: process.execPath,
    args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
    env: { ...process.env, MINI_PI_SESSION_DIR: sessions() },
  });
  const jobs: GuideInput[] = [];
  const guideRunner = (input: GuideInput, signal: AbortSignal) =>
    new Promise<PrGuide>((_resolve, reject) => {
      jobs.push(input);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  let gh: GhRunner = fakeGh([]);
  h = await startHarness({ command, gh: (cwd, args) => gh(cwd, args), guideRunner });
  harness = h;
  mkdirSync(sessions(), { recursive: true });
  const container = join(h.home, "octo");
  const main = join(container, "main");
  const repo = makePrRepo(h.root, main);
  git(repo.origin, "update-ref", "refs/heads/feature", repo.head);
  gh = fakeGh([OPEN(repo)]);
  await h.sidebar.update({ pinned: { [container]: true } });
  return {
    h,
    repo,
    container,
    main,
    worktree: join(container, "pr-7"),
    jobs,
    setGh: (next: GhRunner) => {
      gh = next;
    },
  };
}

function review(h: Harness, url: string) {
  return h.json<{ agent: AgentInfo } & Partial<ErrorEnvelope>>("POST", "/api/pr-reviews", { url });
}

/** The `<pr>` blocks of the agent's user messages. */
async function prPrompts(h: Harness, agentId: string) {
  const snapshot: Snapshot = await h.snapshot(agentId);
  return snapshot.transcript.entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((c) => ("text" in c ? c.text : "")).join("");
    return splitPrBlocks(text).prs;
  });
}

const branchExists = (main: string, branch: string) =>
  git(main, "branch", "--list", branch).trim() !== "";

const head = (dir: string) => git(dir, "rev-parse", "HEAD").trim();

/**
 * Force-pushes a commit adding `file` on top of `repo.root` as the head of PR `number` and
 * `branch`.
 */
function pushHead(repo: PrRepo, parent: string, number: number, branch: string, file: string) {
  const work = join(parent, "pusher");
  git(parent, "clone", "-q", repo.origin, work);
  git(work, "checkout", "-q", repo.root);
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), "{}\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", `add ${file}`);
  const sha = head(work);
  git(
    work,
    "push",
    "-q",
    "origin",
    `+${sha}:refs/pull/${number}/head`,
    `+${sha}:refs/heads/${branch}`,
  );
  rmSync(work, { recursive: true, force: true });
  return sha;
}

describe("POST /api/pr-reviews", () => {
  it("creates the review worktree, opens a conversation there and attaches it", async () => {
    const { h, repo, main, worktree, jobs } = await start();
    const res = await review(h, "https://github.com/Octo/Repo/pull/7/files");
    expect(res.status).toBe(201);
    const agent = res.body.agent;
    expect(agent.cwd).toBe(worktree);

    // The PR's head branch, created at its head and tracking origin's, marked as a review branch.
    expect(git(worktree, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature");
    expect(head(worktree)).toBe(repo.head);
    expect(git(main, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim()).toBe(
      "origin/feature",
    );
    expect(git(main, "config", "--get", "branch.feature.pi-code-review").trim()).toBe("7");

    const file = h.manager.require(agent.id).sessionFile as string;
    expect(h.prService.store.get(file)).toMatchObject({ number: 7, headSha: repo.head });
    const [context] = await prPrompts(h, agent.id);
    expect(context).toMatchObject({ number: 7, update: false });
    expect(jobs).toEqual([
      expect.objectContaining({
        cwd: worktree,
        headSha: repo.head,
        pr: expect.objectContaining({ number: 7 }),
      }),
    ]);
  });

  it("tracks the head branch in a single-branch clone", async () => {
    const { h, repo, main, worktree } = await start();
    rmSync(main, { recursive: true, force: true });
    git(h.root, "clone", "-q", "--no-local", "--single-branch", "-b", "main", repo.origin, main);
    git(main, "config", "remote.origin.url", ORIGIN_URL);
    git(main, "config", `url.${repo.origin}.insteadOf`, ORIGIN_URL);
    expect(git(main, "config", "--get-all", "remote.origin.fetch").trim()).toBe(
      "+refs/heads/main:refs/remotes/origin/main",
    );

    expect((await review(h, URL_7)).status).toBe(201);
    expect(head(worktree)).toBe(repo.head);
    expect(git(main, "config", "--get", "branch.feature.remote").trim()).toBe("origin");
    expect(git(main, "config", "--get", "branch.feature.merge").trim()).toBe("refs/heads/feature");
  });

  it("checks out the pinned head when the PR's head moved past origin's branch", async () => {
    const { h, repo, worktree } = await start();
    // Only `refs/pull/7/head` has the new commit, as when GitHub updates it after the branch.
    const newer = pushToPr(repo, h.root);
    const { body } = await review(h, URL_7);
    expect(head(worktree)).toBe(newer);
    expect(git(worktree, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature");
    const file = h.manager.require(body.agent.id).sessionFile as string;
    expect(h.prService.store.get(file)?.headSha).toBe(newer);
  });

  it("refuses what isn't a PR URL", async () => {
    const { h } = await start();
    for (const body of [{ url: "7" }, { url: "https://github.com/octo/repo/issues/7" }]) {
      const res = await h.json<ErrorEnvelope>("POST", "/api/pr-reviews", body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_body");
    }
    for (const body of [{}, { url: 7 }, { url: URL_7, extra: true }]) {
      const res = await h.json<ErrorEnvelope>("POST", "/api/pr-reviews", body);
      expect(res.body.error).toEqual({ code: "invalid_body", message: "expected { url: string }" });
    }
  });

  it("refuses a repo pi-code hasn't seen", async () => {
    const { h, container } = await start();
    const res = await review(h, "https://github.com/someone/else/pull/7");
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("repo_not_found");
    expect(res.body.error?.message).toContain("someone/else");
    expect(existsSync(join(container, "pr-7"))).toBe(false);
  });

  it("refuses PRs from forks", async () => {
    const { h, repo, worktree, setGh } = await start();
    setGh(fakeGh([{ ...OPEN(repo), fork: true }]));
    const res = await review(h, URL_7);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: "invalid_body",
      message: "PRs from forks aren't supported",
    });
    expect(existsSync(worktree)).toBe(false);
  });

  it("refuses a head branch name git doesn't accept", async () => {
    const { h, repo, worktree, setGh } = await start();
    for (const headRefName of ["-x", "a..b"]) {
      setGh(fakeGh([{ ...OPEN(repo), headRefName }]));
      const res = await review(h, URL_7);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("invalid_body");
      expect(existsSync(worktree)).toBe(false);
    }
  });

  it("starts a merged PR whose head branch is gone from origin at its pull ref", async () => {
    const { h, repo, main, container, setGh } = await start();
    // PR 8's head branch `merged` isn't on origin; `refs/pull/8/head` is.
    setGh(
      fakeGh([
        {
          number: 8,
          state: "MERGED",
          baseRefOid: repo.mergedBase,
          headRefOid: repo.mergedHead,
          headRefName: "merged",
        },
      ]),
    );
    const res = await review(h, "https://github.com/octo/repo/pull/8");
    expect(res.status).toBe(201);
    const worktree = join(container, "pr-8");
    expect(res.body.agent.cwd).toBe(worktree);
    expect(git(worktree, "symbolic-ref", "--short", "HEAD").trim()).toBe("merged");
    expect(head(worktree)).toBe(repo.mergedHead);
    expect(git(main, "config", "--get-regexp", "^branch\\.merged\\.").trim()).toBe(
      "branch.merged.pi-code-review 8",
    );
    const file = h.manager.require(res.body.agent.id).sessionFile as string;
    expect(h.prService.store.get(file)).toMatchObject({ number: 8, headSha: repo.mergedHead });

    expect((await h.api("DELETE", "/api/worktrees", { path: worktree })).status).toBe(204);
    expect(branchExists(main, "merged")).toBe(false);
  });

  it("refuses a PR with neither its head branch nor its pull ref on origin", async () => {
    const { h, repo, main, container, setGh } = await start();
    setGh(fakeGh([{ ...OPEN(repo), number: 9, headRefName: "gone" }]));
    const res = await review(h, "https://github.com/octo/repo/pull/9");
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("git_failed");
    expect(res.body.error?.message).toContain("refs/pull/9/head");
    expect(existsSync(join(container, "pr-9"))).toBe(false);
    expect(branchExists(main, "gone")).toBe(false);
    expect(h.manager.list()).toEqual([]);
  });

  it("leaves no branch or folder when the checkout fails, and works once fixed", async () => {
    const { h, main, worktree } = await start();
    // A required smudge filter that fails makes `git worktree add` fail after creating the branch.
    const attributes = join(main, ".git", "info", "attributes");
    mkdirSync(join(attributes, ".."), { recursive: true });
    writeFileSync(attributes, "* filter=broken\n");
    git(main, "config", "filter.broken.smudge", "false");
    git(main, "config", "filter.broken.required", "true");
    const res = await review(h, URL_7);
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("git_failed");
    expect(existsSync(worktree)).toBe(false);
    expect(branchExists(main, "feature")).toBe(false);
    expect(git(main, "worktree", "list", "--porcelain")).not.toContain("pr-7");
    expect(h.manager.list()).toEqual([]);

    rmSync(attributes);
    expect((await review(h, URL_7)).status).toBe(201);
    expect(existsSync(worktree)).toBe(true);
  });

  it("refuses an existing worktree folder or local branch", async () => {
    const { h, main, worktree } = await start();
    mkdirSync(worktree);
    const exists = await review(h, URL_7);
    expect(exists.status).toBe(409);
    expect(exists.body.error?.code).toBe("worktree_exists");
    rmSync(worktree, { recursive: true });

    git(main, "branch", "feature");
    const branch = await review(h, URL_7);
    expect(branch.status).toBe(409);
    expect(branch.body.error?.code).toBe("branch_exists");
    expect(existsSync(worktree)).toBe(false);
    expect(h.manager.list()).toEqual([]);

    // A review branch of another PR, or one checked out somewhere, isn't a leftover.
    git(main, "config", "branch.feature.pi-code-review", "8");
    expect((await review(h, URL_7)).body.error?.code).toBe("branch_exists");
    git(main, "config", "branch.feature.pi-code-review", "7");
    git(main, "worktree", "add", "-q", join(h.root, "elsewhere"), "feature");
    expect((await review(h, URL_7)).body.error?.code).toBe("branch_exists");
    expect(branchExists(main, "feature")).toBe(true);
  });

  it("removes the worktree and its branch when the folder needs a trust decision", async () => {
    const { h, repo, main, container, setGh } = await start();
    pushHead(repo, h.root, 9, "trusty", ".pi/settings.json");
    setGh(fakeGh([{ ...OPEN(repo), number: 9, headRefName: "trusty", headRefOid: repo.head }]));
    const res = await review(h, "https://github.com/octo/repo/pull/9");
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("agent_busy");
    expect(res.body.error?.message).toContain(`trust its repo's folder ${container}`);
    expect(existsSync(join(container, "pr-9"))).toBe(false);
    expect(branchExists(main, "trusty")).toBe(false);
    expect(git(main, "worktree", "list", "--porcelain")).not.toContain("pr-9");
    expect(h.manager.list()).toEqual([]);
  });

  it("removes the worktree and its branch when the attach fails", async () => {
    const { h, repo, main, worktree, setGh } = await start();
    const gh = fakeGh([OPEN(repo)]);
    setGh(async (cwd, args) => {
      if (args[0] === "api") throw new Error("comments unavailable");
      return gh(cwd, args);
    });
    const res = await review(h, URL_7);
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("gh_failed");
    expect(existsSync(worktree)).toBe(false);
    expect(branchExists(main, "feature")).toBe(false);
    expect(h.manager.list()).toEqual([]);
    expect(h.prService.store.current()).toEqual({});
  });

  it("serializes concurrent requests for one PR", async () => {
    const { h } = await start();
    const results = await Promise.all([review(h, URL_7), review(h, `${URL_7}/files`)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.error?.code).toBe("worktree_exists");
    expect(h.manager.list()).toHaveLength(1);
  });
});

describe("removing a review worktree", () => {
  it("deletes its branch, unpushed commits included, and keeps other branches", async () => {
    const { h, main, container, worktree } = await start();
    expect((await review(h, URL_7)).status).toBe(201);
    writeFileSync(join(worktree, "local.txt"), "local\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-qm", "unpushed");

    const plain = await h.json("POST", "/api/worktrees", { repo: container, name: "wt" });
    expect(plain.status).toBe(201);

    for (const path of [worktree, join(container, "wt")]) {
      expect((await h.api("DELETE", "/api/worktrees", { path })).status).toBe(204);
    }
    expect(branchExists(main, "feature")).toBe(false);
    expect(git(main, "config", "--list")).not.toContain("pi-code-review");
    expect(branchExists(main, "wt")).toBe(true);
  });

  it("deletes its branch when forced over local changes, or when its folder is gone", async () => {
    const { h, main, worktree } = await start();
    expect((await review(h, URL_7)).status).toBe(201);
    writeFileSync(join(worktree, "scratch.txt"), "mine\n");
    const forced = await h.api("DELETE", "/api/worktrees", { path: worktree, force: true });
    expect(forced.status).toBe(204);
    expect(branchExists(main, "feature")).toBe(false);

    expect((await review(h, URL_7)).status).toBe(201);
    rmSync(worktree, { recursive: true, force: true });
    expect((await h.api("DELETE", "/api/worktrees", { path: worktree })).status).toBe(204);
    expect(branchExists(main, "feature")).toBe(false);
  });

  it("deletes the sessions when the branch can't be, and the next review deletes it", async () => {
    const { h, main, worktree } = await start();
    const { body } = await review(h, URL_7);
    const file = h.manager.require(body.agent.id).sessionFile as string;
    // Locks the branch's ref, so `git branch -D` fails.
    const lock = join(main, ".git", "refs", "heads", "feature.lock");
    writeFileSync(lock, "");

    const res = await h.json<ErrorEnvelope>("DELETE", "/api/worktrees", { path: worktree });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("git_failed");
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(h.hub.baseline().sessions.map((s) => s.file)).not.toContain(file);
    expect(branchExists(main, "feature")).toBe(true);

    rmSync(lock);
    const again = await review(h, URL_7);
    expect(again.status).toBe(201);
    expect(again.body.agent.cwd).toBe(worktree);
  });
});

describe("Refresh in a review worktree", () => {
  const refresh = (h: Harness, agentId: string) =>
    h.json<{ worktreeWarning?: string }>("POST", `/api/agents/${agentId}/pr/refresh`, {});

  it("checks the new head out when clean, and leaves a dirty worktree with a warning", async () => {
    const { h, repo, worktree } = await start();
    const { body } = await review(h, URL_7);
    const agentId = body.agent.id;

    const second = pushToPr(repo, h.root);
    const clean = await refresh(h, agentId);
    expect(clean.status).toBe(200);
    expect(clean.body.worktreeWarning).toBeUndefined();
    expect(head(worktree)).toBe(second);
    expect(git(worktree, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature");

    writeFileSync(join(worktree, "scratch.txt"), "mine\n");
    const third = pushToPr(repo, h.root, "f.txt");
    const dirty = await refresh(h, agentId);
    expect(dirty.status).toBe(200);
    expect(dirty.body.worktreeWarning).toBe(
      "pr-7 has local changes; it stays at the previous commit",
    );
    expect(head(worktree)).toBe(second);
    expect(h.prService.store.get(h.manager.require(agentId).sessionFile as string)?.headSha).toBe(
      third,
    );

    // Once clean, a Refresh moves it even though the PR's head didn't move.
    rmSync(join(worktree, "scratch.txt"));
    const retried = await refresh(h, agentId);
    expect(retried.body.worktreeWarning).toBeUndefined();
    expect(head(worktree)).toBe(third);
  });

  it("follows a force-push, and drops a clean worktree's unpushed commit", async () => {
    const { h, repo, worktree } = await start();
    const { body } = await review(h, URL_7);
    writeFileSync(join(worktree, "local.txt"), "local\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-qm", "unpushed");
    const second = pushToPr(repo, h.root);
    expect((await refresh(h, body.agent.id)).body.worktreeWarning).toBeUndefined();
    expect(head(worktree)).toBe(second);

    // Rewritten history: the new head doesn't descend from the old one.
    const rewritten = pushHead(repo, h.root, 7, "feature", "rewritten.txt");
    expect(() => git(repo.origin, "merge-base", "--is-ancestor", second, rewritten)).toThrow();
    expect((await refresh(h, body.agent.id)).body.worktreeWarning).toBeUndefined();
    expect(head(worktree)).toBe(rewritten);
  });

  it("warns when git fails to move the worktree", async () => {
    const { h, repo, worktree } = await start();
    const { body } = await review(h, URL_7);
    const gitDir = git(worktree, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(join(gitDir, "index.lock"), "");
    pushToPr(repo, h.root);
    const res = await refresh(h, body.agent.id);
    expect(res.status).toBe(200);
    expect(res.body.worktreeWarning).toMatch(/^couldn't check out the new head in pr-7: /);
    expect(head(worktree)).toBe(repo.head);
  });

  it("doesn't move the worktree while the agent is running", async () => {
    const { h, repo, worktree } = await start();
    const { body } = await review(h, URL_7);
    const agentId = body.agent.id;
    await h.rpc(agentId, { type: "prompt", message: "hang" });
    await h.idle(agentId);
    expect(h.manager.require(agentId).info().isStreaming).toBe(true);
    pushToPr(repo, h.root);
    const res = await refresh(h, agentId);
    expect(res.status).toBe(200);
    expect(res.body.worktreeWarning).toBe(
      "pr-7 wasn't moved while the agent was running; refresh again when it's idle",
    );
    expect(head(worktree)).toBe(repo.head);
  });

  it("leaves it alone for a conversation there attached to another PR", async () => {
    const { h, repo, worktree, setGh } = await start();
    expect((await review(h, URL_7)).status).toBe(201);
    const nine = pushHead(repo, h.root, 9, "nine", "nine.txt");
    setGh(
      fakeGh([OPEN(repo), { ...OPEN(repo), number: 9, headRefName: "nine", headRefOid: nine }]),
    );
    const other = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", { cwd: worktree });
    await h.waitForStatus(other.body.agent.id, "ready");
    const attach = await h.api("POST", `/api/agents/${other.body.agent.id}/pr`, { pr: "9" });
    expect(attach.status).toBe(200);
    pushHead(repo, h.root, 9, "nine", "nine-2.txt");
    const res = await refresh(h, other.body.agent.id);
    expect(res.status).toBe(200);
    expect(res.body.worktreeWarning).toBeUndefined();
    expect(head(worktree)).toBe(repo.head);
  });

  it("leaves a plain /pr conversation's checkout alone", async () => {
    const { h, repo, main } = await start();
    const { body } = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", { cwd: main });
    await h.waitForStatus(body.agent.id, "ready");
    expect((await h.api("POST", `/api/agents/${body.agent.id}/pr`, { pr: "7" })).status).toBe(200);
    const before = head(main);
    pushToPr(repo, h.root);
    const res = await refresh(h, body.agent.id);
    expect(res.status).toBe(200);
    expect(res.body.worktreeWarning).toBeUndefined();
    expect(head(main)).toBe(before);
  });
});
