import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo, StreamFrame } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../agents/agent-manager.ts";
import { ApiError, type ErrorEnvelope } from "../errors.ts";
import { type Harness, type HarnessOptions, startHarness } from "../testing/http-harness.ts";
import { git, type LayoutRepo, makeLayoutRepo } from "../testing/layout-repo.ts";

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));

let harness: Harness | undefined;
let layout: LayoutRepo;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Where mini-pi writes new sessions; also the encoded dir that tests share between cwds. */
const sessionsDir = (h: Harness) => join(h.agentDir, "sessions", "--shared--");

/**
 * A harness whose agents run mini-pi (real session files; `prompt "crash"` exits), with a
 * layout repo at `<home>/repo`. `failOpen` makes spawning in a cwd with that basename throw.
 */
async function start(opts: HarnessOptions & { failOpen?: string } = {}): Promise<Harness> {
  let h: Harness | undefined;
  const command = (req: SpawnRequest) => {
    if (opts.failOpen !== undefined && req.cwd.endsWith(`/${opts.failOpen}`)) {
      throw new ApiError("pi_error", "spawn failed");
    }
    return {
      bin: process.execPath,
      args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
      env: { ...process.env, MINI_PI_SESSION_DIR: sessionsDir(h as Harness) },
    };
  };
  h = await startHarness({ command, ...opts });
  mkdirSync(sessionsDir(h), { recursive: true });
  layout = makeLayoutRepo(h.home, "repo");
  harness = h;
  return h;
}

/** Writes a session updated now, with header `cwd`, into `<agentDir>/sessions/<dir>`. */
function writeSession(h: Harness, id: string, cwd: string, dir = "--shared--"): string {
  const path = join(h.agentDir, "sessions", dir);
  mkdirSync(path, { recursive: true });
  const file = join(path, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  return file;
}

async function createWt(h: Harness, name: string, extra: Record<string, unknown> = {}) {
  return h.json<{ agent: AgentInfo } & Partial<ErrorEnvelope>>("POST", "/api/worktrees", {
    repo: layout.repo,
    name,
    ...extra,
  });
}

/** Creates `<repo>/<name>` through the API and waits for its agent to be ready. */
async function createReady(h: Harness, name: string): Promise<{ path: string; agent: AgentInfo }> {
  const res = await createWt(h, name);
  if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
  await h.waitForStatus(res.body.agent.id, "ready");
  await h.idle(res.body.agent.id);
  return { path: join(layout.repo, name), agent: res.body.agent };
}

async function openReady(h: Harness, cwd: string): Promise<AgentInfo> {
  const res = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", { cwd });
  if (res.status !== 201) throw new Error(`open: ${res.status} ${JSON.stringify(res.body)}`);
  await h.waitForStatus(res.body.agent.id, "ready");
  await h.idle(res.body.agent.id);
  return res.body.agent;
}

function remove(h: Harness, path: string, force?: boolean) {
  return h.json<ErrorEnvelope | undefined>(
    "DELETE",
    "/api/worktrees",
    force === undefined ? { path } : { path, force },
  );
}

const codeOf = (res: { body: unknown }) => (res.body as ErrorEnvelope).error.code;
const worktreeList = () => git(layout.main, "worktree", "list", "--porcelain");
const branches = () => git(layout.main, "branch", "--format=%(refname:short)").split("\n");

describe("POST /api/worktrees", () => {
  it("creates the worktree and opens an agent in it", async () => {
    const h = await start();
    const client = h.stream();
    await client.waitFor((f) => f.type === "baseline");
    const res = await createWt(h, "wt", { branch: "feature/wt" });
    expect(res.status).toBe(201);
    const path = join(layout.repo, "wt");
    expect(res.body.agent).toMatchObject({
      cwd: path,
      status: "starting",
      layout: { repo: layout.repo, role: "worktree" },
    });
    expect(git(path, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature/wt");
    const frame = await client.waitFor(
      (f) => f.type === "agent" && f.agent.id === res.body.agent.id,
    );
    expect((frame as Extract<StreamFrame, { type: "agent" }>).agent.layout).toEqual({
      repo: layout.repo,
      role: "worktree",
    });
  });

  it("validates the body", async () => {
    const h = await start();
    for (const body of [
      { repo: layout.repo },
      { repo: layout.repo, name: 1 },
      { repo: layout.repo, name: "x", branch: 2 },
      { repo: "repo", name: "x" },
      { repo: layout.repo, name: ".git" },
      { repo: layout.repo, name: "x", branch: "@{-1}" },
      [],
    ]) {
      const res = await h.json("POST", "/api/worktrees", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(res)).toBe("invalid_body");
    }
  });

  it("requires a layout container inside $HOME", async () => {
    const h = await start();
    const plain = join(h.home, "plain");
    git(h.home, "clone", "-q", layout.origin, plain);
    for (const repo of [plain, layout.main]) {
      const res = await h.json("POST", "/api/worktrees", { repo, name: "x" });
      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe("not_in_layout");
    }

    const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-outside-")));
    try {
      const elsewhere = makeLayoutRepo(outside, "r");
      symlinkSync(elsewhere.repo, join(h.home, "linked"));
      for (const repo of [elsewhere.repo, join(h.home, "linked")]) {
        const res = await h.json("POST", "/api/worktrees", { repo, name: "x" });
        expect(res.status).toBe(400);
        expect(codeOf(res)).toBe("outside_home");
      }
      expect(existsSync(join(elsewhere.repo, "x"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns the open's error, naming the created worktree", async () => {
    const h = await start({ failOpen: "boom" });
    const res = await createWt(h, "boom");
    const path = join(layout.repo, "boom");
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({
      code: "pi_error",
      message: `spawn failed (the worktree was created at ${path})`,
    });
    expect(existsSync(join(path, ".git"))).toBe(true);
  });

  it("is guarded by Origin and Content-Type", async () => {
    const h = await start();
    const body = JSON.stringify({ repo: layout.repo, name: "x" });
    const noOrigin = await fetch(`${h.base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(noOrigin.status).toBe(403);
    const text = await fetch(`${h.base}/api/worktrees`, {
      method: "POST",
      headers: { origin: h.base, "content-type": "text/plain" },
      body,
    });
    expect(text.status).toBe(400);
    expect(existsSync(join(layout.repo, "x"))).toBe(false);
  });
});

describe("DELETE /api/worktrees", () => {
  it("removes the worktree, closes its agents and deletes its sessions", async () => {
    const h = await start();
    const { path, agent: live } = await createReady(h, "wt");
    const exited = await openReady(h, path);
    await h.rpc(exited.id, { type: "prompt", message: "crash" });
    await h.waitForStatus(exited.id, "exited");
    const other = await openReady(h, layout.main);
    const inWt = writeSession(h, "in-wt", path, "--elsewhere--");
    const inSub = writeSession(h, "in-sub", join(path, "packages", "server"));
    // Same encoded dir, another cwd: kept.
    const inMain = writeSession(h, "in-main", layout.main);
    const miniPiFiles = [live, exited].map((a) => h.manager.require(a.id).sessionFile as string);
    await h.hub.refreshCatalog();
    const client = h.stream();
    await client.waitFor((f) => f.type === "baseline");

    const res = await remove(h, path);
    expect(res.status).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(layout.main, ".git", "worktrees", "wt"))).toBe(false);
    expect(worktreeList()).not.toContain(path);
    expect(branches()).toContain("wt");
    for (const file of [inWt, inSub, ...miniPiFiles]) expect(existsSync(file), file).toBe(false);
    expect(existsSync(inMain)).toBe(true);
    expect(existsSync(join(h.agentDir, "sessions", "--elsewhere--"))).toBe(true);
    expect(h.manager.list().map((a) => a.id)).toEqual([other.id]);

    await client.waitFor((f) => f.type === "catalog");
    const types = client.frames.map(({ frame }) => frame);
    const closedAt = [live.id, exited.id].map((id) =>
      types.findIndex((f) => f.type === "agent_closed" && f.agentId === id),
    );
    const catalogAt = types.findIndex((f) => f.type === "catalog");
    expect(Math.min(...closedAt)).toBeGreaterThan(0);
    expect(catalogAt).toBeGreaterThan(Math.max(...closedAt));
    const catalog = types[catalogAt] as Extract<StreamFrame, { type: "catalog" }>;
    expect(catalog.sessions.map((s) => s.id)).toContain("in-main");
    expect(catalog.sessions.some((s) => s.cwd.startsWith(path))).toBe(false);
  });

  it("refuses a dirty worktree, keeping its agents, until forced", async () => {
    const h = await start();
    const { path, agent } = await createReady(h, "wt");
    writeFileSync(join(path, "file.txt"), "one\n");
    git(path, "add", "file.txt");
    git(path, "commit", "-q", "-m", "file");
    writeFileSync(join(path, "file.txt"), "two\n");

    const dirty = await remove(h, path);
    expect(dirty.status).toBe(409);
    expect(codeOf(dirty)).toBe("worktree_dirty");
    expect(h.manager.get(agent.id)?.status).toBe("ready");
    expect(existsSync(path)).toBe(true);

    expect((await remove(h, path, true)).status).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(h.manager.get(agent.id)).toBeUndefined();
  });

  it("counts untracked files as dirty", async () => {
    const h = await start();
    const { path } = await createReady(h, "wt");
    writeFileSync(join(path, "untracked.txt"), "x\n");
    const res = await remove(h, path);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("worktree_dirty");
  });

  it("refuses a worktree holding a submodule, keeping its agents, until forced", async () => {
    const h = await start();
    const { path, agent } = await createReady(h, "wt");
    git(path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", layout.origin, "sub");
    git(path, "commit", "-q", "-m", "submodule");
    const res = await remove(h, path);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("worktree_dirty");
    expect(h.manager.get(agent.id)?.status).toBe("ready");
    expect((await remove(h, path, true)).status).toBe(204);
    expect(existsSync(path)).toBe(false);
  });

  it("removes a missing worktree and an already pruned one", async () => {
    const h = await start();
    const missing = join(layout.repo, "missing");
    const pruned = join(layout.repo, "pruned");
    git(layout.main, "worktree", "add", "-q", "-b", "pruned", pruned);
    rmSync(pruned, { recursive: true });
    git(layout.main, "worktree", "prune");
    git(layout.main, "worktree", "add", "-q", "-b", "missing", missing);
    rmSync(missing, { recursive: true });
    expect(worktreeList()).toContain(missing);
    const files = [writeSession(h, "m", missing), writeSession(h, "p", pruned)];

    expect((await remove(h, missing)).status).toBe(204);
    expect(worktreeList()).not.toContain(missing);
    expect((await remove(h, pruned)).status).toBe(204);
    expect((await remove(h, pruned)).status).toBe(204);
    for (const file of files) expect(existsSync(file)).toBe(false);
  });

  it("only removes linked worktrees inside $HOME", async () => {
    const h = await start();
    for (const path of [layout.main, layout.repo, h.project]) {
      const res = await remove(h, path);
      expect(res.status, path).toBe(400);
      expect(codeOf(res)).toBe("not_a_worktree");
    }
    expect(existsSync(layout.main)).toBe(true);
    const outside = await remove(h, join(tmpdir(), "elsewhere"));
    expect(outside.status).toBe(400);
    expect(codeOf(outside)).toBe("outside_home");
    const relative = await remove(h, "repo/wt");
    expect(codeOf(relative)).toBe("invalid_body");
  });

  it("falls back to unlink when trash fails", async () => {
    const h = await start({ trashCommand: "false" });
    const wt = join(layout.repo, "wt");
    git(layout.main, "worktree", "add", "-q", "-b", "wt", wt);
    const file = writeSession(h, "s", wt);
    expect((await remove(h, wt)).status).toBe(204);
    expect(existsSync(file)).toBe(false);
  });

  it("fails with internal naming an undeletable file, after deleting the others", async () => {
    const h = await start({ trashCommand: "false" });
    const wt = join(layout.repo, "wt");
    git(layout.main, "worktree", "add", "-q", "-b", "wt", wt);
    const locked = writeSession(h, "locked", wt, "--locked--");
    const deletable = writeSession(h, "ok", wt);
    const lockedDir = join(h.agentDir, "sessions", "--locked--");
    chmodSync(lockedDir, 0o555);
    try {
      const res = await remove(h, wt);
      expect(res.status).toBe(500);
      expect(codeOf(res)).toBe("internal");
      expect((res.body as ErrorEnvelope).error.message).toContain(locked);
      expect(existsSync(deletable)).toBe(false);
      expect(existsSync(locked)).toBe(true);
      expect(existsSync(wt)).toBe(false);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });
});
