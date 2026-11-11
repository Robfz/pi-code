import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentInfo,
  type PrGuide,
  type PrGuideResponse,
  type Snapshot,
  splitPrGuideBlocks,
} from "@pi-code/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnRequest } from "../agents/agent-manager.ts";
import type { ErrorEnvelope } from "../errors.ts";
import type { GhRunner } from "../pr/github.ts";
import { GUIDE_VERSION } from "../pr/guide-format.ts";
import type { GuideInput } from "../pr/guide-job.ts";
import { GuideStore } from "../store/guide-store.ts";
import type { StoredPr } from "../store/pr-store.ts";
import { type Harness, startHarness } from "../testing/http-harness.ts";
import { type FakePr, fakeGh, makePrRepo, type PrRepo, pushToPr } from "../testing/pr-repo.ts";

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));

let harness: Harness | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = undefined;
});

/** A guide runner whose jobs the test settles. */
function fakeRunner() {
  const jobs: {
    input: GuideInput;
    signal: AbortSignal;
    resolve: (guide: PrGuide) => void;
    reject: (e: Error) => void;
  }[] = [];
  const run = (input: GuideInput, signal: AbortSignal) =>
    new Promise<PrGuide>((resolve, reject) => {
      jobs.push({ input, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  return { run, jobs };
}

const OPEN = (repo: PrRepo): FakePr => ({
  number: 7,
  state: "OPEN",
  baseRefOid: repo.root,
  headRefOid: repo.head,
});

/**
 * A harness running mini-pi in a clone of a repo with PR 7, guides run by a fake runner.
 * `holdGh()` holds every `gh` call from then on until its `release`.
 */
async function start() {
  let h: Harness | undefined;
  const sessions = () => join((h as Harness).agentDir, "sessions", "--project--");
  const command = (req: SpawnRequest) => ({
    bin: process.execPath,
    args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
    env: { ...process.env, MINI_PI_SESSION_DIR: sessions() },
  });
  const runner = fakeRunner();
  let gh = fakeGh([]);
  let hold: { calls: number; released: Promise<void> } | undefined;
  const ghRunner: GhRunner = async (cwd, args) => {
    const held = hold;
    if (held !== undefined) {
      held.calls++;
      await held.released;
    }
    return gh(cwd, args);
  };
  const holdGh = () => {
    let release = () => {};
    const held = { calls: 0, released: new Promise<void>((resolve) => (release = resolve)) };
    hold = held;
    return {
      waiting: () => held.calls,
      release: () => {
        hold = undefined;
        release();
      },
    };
  };
  h = await startHarness({ command, gh: ghRunner, guideRunner: runner.run });
  harness = h;
  mkdirSync(sessions(), { recursive: true });
  const repo = makePrRepo(h.root, h.project);
  gh = fakeGh([OPEN(repo)]);
  return { h, repo, runner, gh: () => gh, holdGh };
}

/** The guide a job for `input` returns: a.txt's hunk explained, b.txt's left to Other changes. */
function guideFor(input: GuideInput, explanation = "Why a changes."): PrGuide {
  return {
    version: GUIDE_VERSION,
    repo: input.pr.repo,
    number: input.pr.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
    sections: [{ title: "Core", explanation, hunks: ["a.txt#1"] }],
    other: ["b.txt#1"],
  };
}

const attach = (h: Harness, agentId: string) =>
  h.json<Partial<ErrorEnvelope>>("POST", `/api/agents/${agentId}/pr`, { pr: "7" });
const guide = (h: Harness, agentId: string) =>
  h.json<PrGuideResponse & Partial<ErrorEnvelope>>("GET", `/api/agents/${agentId}/pr/guide`);
const retry = (h: Harness, agentId: string) =>
  h.json<PrGuideResponse & Partial<ErrorEnvelope>>(
    "POST",
    `/api/agents/${agentId}/pr/guide/retry`,
    {},
  );
const refresh = (h: Harness, agentId: string) =>
  h.api("POST", `/api/agents/${agentId}/pr/refresh`, {});

/** Opens an agent in `cwd` and waits until it is ready. */
async function openIn(h: Harness, cwd: string): Promise<AgentInfo> {
  const { body } = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", { cwd });
  await h.waitForStatus(body.agent.id, "ready");
  return body.agent;
}

/** The `<pr-guide>` blocks of the agent's user messages, in order. */
async function guidePrompts(h: Harness, agentId: string) {
  const snapshot: Snapshot = await h.snapshot(agentId);
  return snapshot.transcript.entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((c) => ("text" in c ? c.text : "")).join("");
    const { guides, body } = splitPrGuideBlocks(text);
    return guides.map((g) => ({ ...g, body }));
  });
}

/** Waits until the agent has received `n` guide prompts; returns them. */
async function receivedGuides(h: Harness, agentId: string, n: number) {
  let prompts: Awaited<ReturnType<typeof guidePrompts>> = [];
  await vi.waitFor(
    async () => {
      prompts = await guidePrompts(h, agentId);
      expect(prompts).toHaveLength(n);
    },
    { timeout: 5_000 },
  );
  return prompts;
}

/**
 * Resolves once the guide deliveries queued so far behind the conversation's attach, Refresh and
 * polls are done: a poll asked for once the one in flight (if any) is done runs after them.
 */
async function settled(h: Harness, file: string) {
  const conversation = { cwd: h.project, sessionFile: file };
  await h.prService.poll(conversation);
  await h.prService.poll(conversation);
}

/** A live stream client, once connected: frames broadcast from now on reach it. */
async function connected(h: Harness) {
  const client = h.stream();
  await client.waitFor((f) => f.type === "baseline");
  return client;
}

/** The agent's session file. */
const fileOf = (h: Harness, agentId: string) => h.manager.require(agentId).sessionFile as string;

const UNRESOLVED = "the guide names hunks the PR diff doesn't have; retry";

const guideFiles = (h: Harness) => {
  try {
    return readdirSync(join(h.dataDir, "guides"));
  } catch {
    return [];
  }
};

describe("PR guide", () => {
  it("generates on attach, reports it live, serves it with its hunks and sends it to the agent", async () => {
    const { h, repo, runner } = await start();
    const agent = await h.open();
    const client = h.stream();
    expect((await attach(h, agent.id)).status).toBe(200);
    const key = `octo/repo#7@${repo.root}..${repo.head}`;

    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    expect(runner.jobs[0]?.input).toEqual({
      cwd: h.project,
      folder: "",
      pr: { repo: "octo/repo", number: 7, title: "PR 7", body: "The description." },
      baseSha: repo.root,
      headSha: repo.head,
    });
    await client.waitFor((f) => f.type === "guide" && f.key === key && f.state === "generating");
    expect((await guide(h, agent.id)).body).toEqual({ key, state: "generating" });

    const input = runner.jobs[0]?.input as GuideInput;
    runner.jobs[0]?.resolve(guideFor(input));
    await client.waitFor((f) => f.type === "guide" && f.key === key && f.state === "ready");
    const ready = await guide(h, agent.id);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      key,
      state: "ready",
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      guide: guideFor(input),
      oldRev: repo.root.slice(0, 7),
      newRev: repo.head.slice(0, 7),
      units: {
        "a.txt#1": {
          path: "a.txt",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: expect.stringMatching(
            /^diff --git a\/a.txt b\/a.txt\n.*\n--- a\/a.txt\n\+\+\+ b\/a.txt\n@@ -1 \+1 @@\n-one\n\+two\n$/,
          ),
        },
        "b.txt#1": {
          path: "b.txt",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: expect.stringContaining("+++ b/b.txt\n@@ -0,0 +1 @@\n+b\n"),
        },
      },
    });

    const [prompt] = await receivedGuides(h, agent.id, 1);
    const head = repo.head.slice(0, 12);
    expect(prompt).toMatchObject({ number: 7, title: "PR 7" });
    expect(prompt?.text).toContain(
      `1. Core\n  Why a changes.\nHunks:\n- @${head}:./a.txt:1\n\nOther changes:\n- @${head}:./b.txt:1`,
    );
    expect(prompt?.text).toContain("model-written summary of untrusted material");
    expect(guideFiles(h)).toHaveLength(1);
  });

  it("sends a stored guide right away to a conversation attaching to the same diff", async () => {
    const { h, runner } = await start();
    const first = await h.open();
    await attach(h, first.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await receivedGuides(h, first.id, 1);

    const second = await h.open();
    expect((await attach(h, second.id)).status).toBe(200);
    await receivedGuides(h, second.id, 1);
    expect((await guide(h, second.id)).body.state).toBe("ready");
    expect(runner.jobs).toHaveLength(1);
    expect(await guidePrompts(h, first.id)).toHaveLength(1);
  });

  it("moves to the new diff's guide on Refresh, cancelling the old job once nothing pins it", async () => {
    const { h, repo, runner } = await start();
    const a = await h.open();
    const b = await h.open();
    await attach(h, a.id);
    await attach(h, b.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const pushed = pushToPr(repo, h.root);

    expect((await refresh(h, a.id)).status).toBe(200);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    expect(runner.jobs[1]?.input.headSha).toBe(pushed);
    // b still pins the old diff.
    expect(runner.jobs[0]?.signal.aborted).toBe(false);
    expect((await guide(h, a.id)).body).toEqual({
      key: `octo/repo#7@${repo.root}..${pushed}`,
      state: "generating",
    });

    expect((await refresh(h, b.id)).status).toBe(200);
    expect(runner.jobs[0]?.signal.aborted).toBe(true);
    // b joins the running job of the new diff.
    expect(runner.jobs).toHaveLength(2);

    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input));
    const [toA] = await receivedGuides(h, a.id, 1);
    await receivedGuides(h, b.id, 1);
    expect(toA?.text).toContain(`Head: ${pushed}`);
  });

  it("reports a failure, regenerates on Retry with the PR re-read, and sends each new guide", async () => {
    const { h, repo, runner, gh } = await start();
    const agent = await h.open();
    const client = h.stream();
    await attach(h, agent.id);
    const key = `octo/repo#7@${repo.root}..${repo.head}`;
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    runner.jobs[0]?.reject(new Error("the model broke"));
    await client.waitFor((f) => f.type === "guide" && f.state === "failed");
    expect((await guide(h, agent.id)).body).toEqual({
      key,
      state: "failed",
      error: "the model broke",
    });
    expect(await guidePrompts(h, agent.id)).toEqual([]);

    const views = () => gh().calls.filter((args) => args[1] === "view").length;
    const viewed = views();
    const res = await retry(h, agent.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key, state: "generating" });
    expect(views()).toBe(viewed + 1);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    expect(runner.jobs[1]?.input.pr).toEqual({
      repo: "octo/repo",
      number: 7,
      title: "PR 7",
      body: "The description.",
    });
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input, "First take."));
    await receivedGuides(h, agent.id, 1);
    const first = await guide(h, agent.id);

    // Retry replaces a ready guide too.
    await retry(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(3));
    expect((await guide(h, agent.id)).body.state).toBe("generating");
    runner.jobs[2]?.resolve(guideFor(runner.jobs[2].input, "Second take."));
    const prompts = await receivedGuides(h, agent.id, 2);
    expect(prompts[1]?.text).toContain("Second take.");
    const second = await guide(h, agent.id);
    expect(second.body.state === "ready" && second.body.guide.sections[0]?.explanation).toBe(
      "Second take.",
    );
    expect(first.body.state === "ready" && first.body.id).not.toBe(
      second.body.state === "ready" && second.body.id,
    );
  });

  it("reads a key without a guide or a job as failed, asking for a retry", async () => {
    const { h, repo, runner } = await start();
    const agent = await h.open();
    const client = h.stream();
    await attach(h, agent.id);
    const key = `octo/repo#7@${repo.root}..${repo.head}`;
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    // As after a restart: nothing stored, nothing running, no failure kept.
    h.guides.cancel(key);
    await client.waitFor((f) => f.type === "guide" && f.state === "failed");
    expect((await guide(h, agent.id)).body).toEqual({
      key,
      state: "failed",
      error: "the guide isn't being generated (the server may have restarted meanwhile); retry",
    });
  });

  it("shares the guide with a clone, which gets it once ready without another job", async () => {
    const { h, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const original = h.manager.require(agent.id).sessionFile as string;
    expect((await h.rpc(agent.id, { type: "clone" })).status).toBe(200);
    expect(h.manager.require(agent.id).sessionFile).not.toBe(original);

    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await receivedGuides(h, agent.id, 1);
    expect((await guide(h, agent.id)).body.state).toBe("ready");
    expect(runner.jobs).toHaveLength(1);
  });

  it("prunes the guides no attachment pins, keeping a subfolder conversation's", async () => {
    const { h, repo, runner } = await start();
    const sub = join(h.project, "sub");
    mkdirSync(sub);
    const inSub = await openIn(h, sub);
    await attach(h, inSub.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    expect(runner.jobs[0]?.input).toMatchObject({ cwd: sub, folder: "sub/" });
    runner.jobs[0]?.resolve({ ...guideFor(runner.jobs[0].input), sections: [], other: [] });
    await vi.waitFor(() => expect(guideFiles(h)).toHaveLength(1));
    expect((await guide(h, inSub.id)).body).toMatchObject({
      key: `octo/repo#7@${repo.root}..${repo.head}:sub/`,
      state: "ready",
    });

    // Attaching another conversation changes the attachments, which prunes.
    const top = await h.open();
    await attach(h, top.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input));
    await receivedGuides(h, top.id, 1);
    expect(guideFiles(h)).toHaveLength(2);

    const file = h.manager.require(top.id).sessionFile as string;
    const client = h.stream();
    expect((await h.api("DELETE", "/api/sessions", { file })).status).toBe(204);
    await client.waitFor((f) => f.type === "prs" && f.prs[file] === undefined);
    await vi.waitFor(() => expect(guideFiles(h)).toHaveLength(1));
    expect((await guide(h, inSub.id)).body.state).toBe("ready");
  });

  it("doesn't send a guide to a conversation whose agent doesn't accept input", async () => {
    const { h, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const file = fileOf(h, agent.id);
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    // pi exits: the agent keeps its session (and its attachment) until restarted or closed.
    const live = h.manager.require(agent.id);
    await live.host.close();
    await vi.waitFor(() => expect(live.status).toBe("exited"));
    expect(h.manager.ownerOf(file)).toBe(agent.id);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = await connected(h);
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await client.waitFor((f) => f.type === "guide" && f.state === "ready");
    await settled(h, file);
    // Not even tried: a send would fail with `agent_exited`.
    expect(warned).not.toHaveBeenCalledWith(expect.stringContaining("couldn't send the guide"));
    expect(readFileSync(file, "utf8")).toContain("<pr ");
    expect(readFileSync(file, "utf8")).not.toContain("<pr-guide");
  });

  it("doesn't send a guide to an agent that moved to another session before it was sent", async () => {
    const { h, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const live = h.manager.require(agent.id);
    const original = live.sessionFile as string;
    // Holds the agent's session lock, so a clone and then the guide's send queue up behind it.
    const exclusive = vi.spyOn(live.pipeline, "exclusive");
    let release = () => {};
    const held = live.pipeline.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    const cloned = h.rpc(agent.id, { type: "clone" });
    await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(2));
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    // The send found the conversation's agent holding `original`, and waits its turn.
    await vi.waitFor(() => expect(exclusive).toHaveBeenCalledTimes(3));
    release();
    await held;
    expect((await cloned).status).toBe(200);
    expect(live.sessionFile).not.toBe(original);
    await settled(h, original);
    expect(await guidePrompts(h, agent.id)).toEqual([]);
  });

  it("doesn't send a guide to a conversation a Refresh moved to another diff meanwhile", async () => {
    const { h, repo, runner, holdGh } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const file = fileOf(h, agent.id);
    const pushed = pushToPr(repo, h.root);
    const client = h.stream();
    // The Refresh holds the conversation's lock while `gh` is held.
    const gh = holdGh();
    const refreshed = refresh(h, agent.id);
    await vi.waitFor(() => expect(gh.waiting()).toBeGreaterThan(0));
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await client.waitFor((f) => f.type === "guide" && f.state === "ready");
    gh.release();
    expect((await refreshed).status).toBe(200);
    expect(h.prService.store.get(file)?.headSha).toBe(pushed);
    await settled(h, file);
    expect(await guidePrompts(h, agent.id)).toEqual([]);

    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input));
    const [prompt] = await receivedGuides(h, agent.id, 1);
    expect(prompt?.text).toContain(`Head: ${pushed}`);
  });

  it("sends a guide once to a conversation attaching as its job ends", async () => {
    const { h, runner } = await start();
    const first = await h.open();
    await attach(h, first.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const second = await h.open();
    const file = fileOf(h, second.id);
    // Holds the second attach once its attachment is stored, before it looks the guide up.
    const set = h.prService.store.set.bind(h.prService.store);
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(h.prService.store, "set").mockImplementation(async (f, pr) => {
      await set(f, pr);
      if (f === file) await released;
    });
    const attached = attach(h, second.id);
    await vi.waitFor(() => expect(h.prService.store.get(file)).toBeDefined());
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await receivedGuides(h, first.id, 1);
    release();
    expect((await attached).status).toBe(200);
    await receivedGuides(h, second.id, 1);
    await settled(h, file);
    expect(await guidePrompts(h, second.id)).toHaveLength(1);
  });

  it("doesn't send a stored guide that a cancel reports as ready", async () => {
    const { h, repo, runner } = await start();
    const first = await h.open();
    await attach(h, first.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await receivedGuides(h, first.id, 1);
    await retry(h, first.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    // Joins the Retry's job.
    const second = await h.open();
    await attach(h, second.id);
    expect((await guide(h, second.id)).body.state).toBe("generating");

    const client = await connected(h);
    h.guides.cancel(`octo/repo#7@${repo.root}..${repo.head}`);
    await client.waitFor((f) => f.type === "guide" && f.state === "ready");
    await settled(h, fileOf(h, second.id));
    expect(await guidePrompts(h, second.id)).toEqual([]);
    expect(await guidePrompts(h, first.id)).toHaveLength(1);
  });

  it("generates the guide again for a conversation attaching while a prune deletes it", async () => {
    const { h, runner } = await start();
    const first = await h.open();
    await attach(h, first.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await receivedGuides(h, first.id, 1);
    const firstFile = fileOf(h, first.id);
    await vi.waitFor(() => expect(existsSync(firstFile)).toBe(true));
    const second = await h.open();
    const file = fileOf(h, second.id);
    // Holds the prune that keeps no key: the one deleting the first conversation's attachment.
    const prune = h.guides.prune.bind(h.guides);
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const pruned = vi.spyOn(h.guides, "prune").mockImplementation(async (keys) => {
      const keep = [...keys];
      if (keep.length === 0) await released;
      return prune(keep);
    });
    expect((await h.api("DELETE", "/api/sessions", { file: firstFile })).status).toBe(204);
    await vi.waitFor(() => expect(pruned).toHaveBeenCalledWith(new Set()));

    // The prune ends a while after the second attachment is stored, past the guide's lookup.
    const set = h.prService.store.set.bind(h.prService.store);
    vi.spyOn(h.prService.store, "set").mockImplementation(async (f, pr) => {
      await set(f, pr);
      if (f === file) setTimeout(release, 100);
    });
    expect((await attach(h, second.id)).status).toBe(200);
    expect(runner.jobs).toHaveLength(2);
    expect(await guidePrompts(h, second.id)).toEqual([]);
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input, "Again."));
    const [prompt] = await receivedGuides(h, second.id, 1);
    expect(prompt?.text).toContain("Again.");
    expect(guideFiles(h)).toHaveLength(1);
  });

  it("cancels the job of a guide no attachment pins any more", async () => {
    const { h, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const file = fileOf(h, agent.id);
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    expect((await h.api("DELETE", "/api/sessions", { file })).status).toBe(204);
    await vi.waitFor(() => expect(runner.jobs[0]?.signal.aborted).toBe(true));
    expect(guideFiles(h)).toEqual([]);
  });

  it("deletes a guide stored once no attachment pins it any more", async () => {
    const { h, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const file = fileOf(h, agent.id);
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    // Holds the job's store write: a cancel then leaves the job to finish.
    const write = GuideStore.prototype.write;
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let writing = false;
    vi.spyOn(GuideStore.prototype, "write").mockImplementation(async function (
      this: GuideStore,
      key,
      guide,
    ) {
      writing = true;
      await released;
      return write.call(this, key, guide);
    });
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await vi.waitFor(() => expect(writing).toBe(true));
    const client = h.stream();
    expect((await h.api("DELETE", "/api/sessions", { file })).status).toBe(204);
    await client.waitFor((f) => f.type === "prs" && f.prs[file] === undefined);
    expect(runner.jobs[0]?.signal.aborted).toBe(false);

    release();
    await client.waitFor((f) => f.type === "guide" && f.state === "ready");
    await vi.waitFor(() => expect(guideFiles(h)).toEqual([]));
  });

  it("starts nothing on a Refresh that leaves the commits where they were", async () => {
    const { h, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const file = fileOf(h, agent.id);
    runner.jobs[0]?.reject(new Error("the model broke"));
    await vi.waitFor(async () => expect((await guide(h, agent.id)).body.state).toBe("failed"));
    const ensure = vi.spyOn(h.guides, "ensure");
    // A failed guide is Retry's to generate again.
    expect((await refresh(h, agent.id)).status).toBe(200);
    expect(ensure).not.toHaveBeenCalled();
    expect((await guide(h, agent.id)).body.state).toBe("failed");

    await retry(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input));
    await receivedGuides(h, agent.id, 1);
    expect((await refresh(h, agent.id)).status).toBe(200);
    await settled(h, file);
    expect(ensure).not.toHaveBeenCalled();
    expect(runner.jobs).toHaveLength(2);
    expect(await guidePrompts(h, agent.id)).toHaveLength(1);
  });

  it("stores the folder of an attachment made before PR guides on Refresh, and starts its guide", async () => {
    const { h, repo, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const file = fileOf(h, agent.id);
    // As attached before PR guides: no folder, so no key; the job of the key is cancelled.
    const { folder: _, ...legacy } = h.prService.store.get(file) as StoredPr;
    await h.prService.store.set(file, legacy);
    await vi.waitFor(() => expect(runner.jobs[0]?.signal.aborted).toBe(true));

    expect((await refresh(h, agent.id)).status).toBe(200);
    expect(h.prService.store.get(file)?.folder).toBe("");
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    expect(runner.jobs[1]?.input).toMatchObject({ folder: "", headSha: repo.head });
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input));
    await receivedGuides(h, agent.id, 1);
    expect((await guide(h, agent.id)).body.state).toBe("ready");
  });

  it("reads a guide naming hunks the PR diff doesn't have as failed, and doesn't send it", async () => {
    const { h, repo, runner } = await start();
    const agent = await h.open();
    const client = h.stream();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = runner.jobs[0]?.input as GuideInput;
    runner.jobs[0]?.resolve({ ...guideFor(input), other: ["b.txt#1", "nope.txt#1"] });
    await client.waitFor((f) => f.type === "guide" && f.state === "ready");
    expect((await guide(h, agent.id)).body).toEqual({
      key: `octo/repo#7@${repo.root}..${repo.head}`,
      state: "failed",
      error: UNRESOLVED,
    });
    await settled(h, fileOf(h, agent.id));
    expect(warned).toHaveBeenCalledWith(expect.stringContaining(UNRESOLVED));
    expect(await guidePrompts(h, agent.id)).toEqual([]);
  });

  it("serves an attachment stored without its folder after a Retry, which stores the folder", async () => {
    const { h, repo, runner } = await start();
    const agent = await h.open();
    await attach(h, agent.id);
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1));
    runner.jobs[0]?.resolve(guideFor(runner.jobs[0].input));
    await receivedGuides(h, agent.id, 1);
    // As attached before PR guides: no folder, so no key pins the guide, which is pruned.
    const file = h.manager.require(agent.id).sessionFile as string;
    const { folder: _, ...legacy } = h.prService.store.get(file) as StoredPr;
    await h.prService.store.set(file, legacy);
    await vi.waitFor(() => expect(guideFiles(h)).toEqual([]));
    const key = `octo/repo#7@${repo.root}..${repo.head}`;
    expect((await guide(h, agent.id)).body).toMatchObject({ key, state: "failed" });

    expect((await retry(h, agent.id)).body).toEqual({ key, state: "generating" });
    expect(h.prService.store.get(file)?.folder).toBe("");
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2));
    // Another generation: the same one, already sent, wouldn't be sent again.
    runner.jobs[1]?.resolve(guideFor(runner.jobs[1].input, "Again."));
    await receivedGuides(h, agent.id, 2);
    expect((await guide(h, agent.id)).body.state).toBe("ready");
  });

  it("refuses a conversation without a PR", async () => {
    const { h } = await start();
    const agent = await h.open();
    for (const res of [await guide(h, agent.id), await retry(h, agent.id)]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: "invalid_body",
        message: "this conversation isn't attached to a PR",
      });
    }
    expect((await guide(h, "nope")).status).toBe(404);
  });
});
