import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInfo, AssistantMessage, ServerEvent } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixturePath, loadFixture } from "../../../../test/fake-pi.ts";
import { type Harness, type HarnessOptions, startHarness } from "../testing/http-harness.ts";
import { PushService, truncate } from "./push-service.ts";
import { SUBSCRIPTIONS_FILE, SubscriptionStore } from "./subscriptions.ts";
import { loadVapidDetails, VAPID_FILE, vapidSubject } from "./vapid.ts";

let harness: Harness | undefined;
let dir: string;

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness({ push: true, ...opts });
  return harness;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-code-push-"));
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  rmSync(dir, { recursive: true, force: true });
});

type Of<T extends ServerEvent["type"]> = Extract<ServerEvent, { type: T }>;

function subscription(n: number) {
  return {
    endpoint: `https://push.example.com/send/${n}`,
    expirationTime: null,
    keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
  };
}

async function subscribe(h: Harness, n: number): Promise<void> {
  const res = await h.api("POST", "/api/push/subscriptions", subscription(n));
  expect(res.status).toBe(204);
}

/** Prompts and waits until the run settled and the resulting pushes went out. */
async function promptAndSettle(h: Harness, agentId: string, message = "hi"): Promise<void> {
  const client = h.sse(agentId, { since: 0 });
  const settledBefore = client.events.length;
  const res = await h.rpc(agentId, { type: "prompt", message });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await client.until(() =>
    client.events
      .slice(settledBefore)
      .find((r) => r.event.type === "pi" && r.event.event.type === "agent_settled"),
  );
  await h.idle(agentId);
  await h.push?.idle();
}

/** Text of the last assistant message recorded in a fixture. */
function lastAssistantText(fixture: string): string {
  let text = "";
  for (const l of loadFixture(fixturePath(fixture))) {
    const line = l.line as { type?: string; message?: AssistantMessage };
    if (l.dir === "out" && line.type === "message_end" && line.message?.role === "assistant") {
      text = line.message.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join(" ");
    }
  }
  return text;
}

describe("VAPID keys", () => {
  it("are generated once with mode 0600 and reused", async () => {
    const data = join(dir, "data");
    const first = await loadVapidDetails(data, "mac.tail1234.ts.net");
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(first.subject).toBe("https://mac.tail1234.ts.net");
    expect(statSync(join(data, VAPID_FILE)).mode & 0o777).toBe(0o600);
    const again = await loadVapidDetails(data, "localhost");
    expect(again.publicKey).toBe(first.publicKey);
    expect(again.privateKey).toBe(first.privateKey);
    expect(again.subject).toBe("mailto:pi-code@localhost");
  });

  it("are regenerated when the file is garbage", async () => {
    writeFileSync(join(dir, VAPID_FILE), "{nope");
    const keys = await loadVapidDetails(dir, "h.ts.net");
    expect(keys.publicKey.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(dir, VAPID_FILE), "utf8")).publicKey).toBe(keys.publicKey);
  });

  it("subject", () => {
    expect(vapidSubject("localhost")).toBe("mailto:pi-code@localhost");
    expect(vapidSubject("a.b.ts.net")).toBe("https://a.b.ts.net");
  });
});

describe("SubscriptionStore", () => {
  it("keys by endpoint, persists atomically with mode 0600, and removes", async () => {
    const store = new SubscriptionStore(dir);
    await store.add(subscription(1));
    await store.add(subscription(2));
    await store.add({ ...subscription(1), keys: { p256dh: "new", auth: "new" } });
    const file = join(dir, SUBSCRIPTIONS_FILE);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { keys: unknown }>;
    expect(Object.keys(saved)).toEqual([subscription(1).endpoint, subscription(2).endpoint]);
    expect(saved[subscription(1).endpoint]?.keys).toEqual({ p256dh: "new", auth: "new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const reloaded = new SubscriptionStore(dir);
    expect((await reloaded.list()).map((s) => s.endpoint)).toHaveLength(2);
    expect(await reloaded.remove(subscription(2).endpoint)).toBe(true);
    expect(await reloaded.remove(subscription(2).endpoint)).toBe(false);
    expect((await new SubscriptionStore(dir).list()).map((s) => s.endpoint)).toEqual([
      subscription(1).endpoint,
    ]);
  });

  it("tightens an existing file to mode 0600 when loading", async () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, SUBSCRIPTIONS_FILE);
    const sub = { ...subscription(1), createdAt: new Date(0).toISOString() };
    writeFileSync(file, JSON.stringify({ [sub.endpoint]: sub }), { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(await new SubscriptionStore(dir).list()).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts empty on a garbage file", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SUBSCRIPTIONS_FILE), "not json");
    expect(await new SubscriptionStore(dir).list()).toEqual([]);
  });
});

describe("payloads", () => {
  const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
    id: "a1",
    cwd: "/home/u/Dev/my-project",
    status: "ready",
    isStreaming: false,
    attention: "finished",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const service = (agents: AgentInfo[]) =>
    new PushService({
      vapid: { publicKey: "pub", privateKey: "priv", subject: "mailto:x@y" },
      store: new SubscriptionStore(dir),
      agents: {
        get: (id) => {
          const a = agents.find((x) => x.id === id);
          return a && { info: () => a };
        },
        list: () => agents,
      },
      send: async () => ({}),
    });
  const assistant = (over: Partial<AssistantMessage>): AssistantMessage =>
    ({
      role: "assistant",
      content: [],
      stopReason: "stop",
      timestamp: 1,
      ...over,
    }) as AssistantMessage;

  it("uses the session name or project folder, truncated text, and the badge count", () => {
    const push = service([
      info(),
      info({ id: "a2", attention: "input", sessionName: "Refactor" }),
      info({ id: "a3", attention: "none" }),
    ]);
    const long = `${"word ".repeat(60)}end`;
    expect(
      push.payloadFor({
        kind: "finished",
        agentId: "a1",
        message: assistant({ content: [{ type: "text", text: long }] }),
      }),
    ).toEqual({
      kind: "finished",
      agentId: "a1",
      title: "my-project",
      body: truncate(long),
      badge: 2,
      url: "/agents/a1",
    });
    expect(truncate(long).length).toBeLessThanOrEqual(140);
    expect(truncate(long).endsWith("…")).toBe(true);
    const failed = push.payloadFor({
      kind: "failed",
      agentId: "a2",
      message: assistant({ stopReason: "error", errorMessage: "529 overloaded" }),
    });
    expect(failed).toMatchObject({ title: "Refactor", body: "529 overloaded" });
  });

  it("never sends an empty body", () => {
    const push = service([info()]);
    const empty = assistant({ content: [{ type: "thinking", thinking: "hm" }] as never });
    expect(push.payloadFor({ kind: "finished", agentId: "a1", message: empty })?.body).toBe(
      "Run finished",
    );
    expect(
      push.payloadFor({
        kind: "failed",
        agentId: "a1",
        message: assistant({ stopReason: "error" }),
      })?.body,
    ).toBe("Run failed");
    expect(
      push.payloadFor({ kind: "input", agentId: "a1", trustPrompt: { cwd: "/home/u/x" } })?.body,
    ).toBe("Trust project x?");
    expect(push.payloadFor({ kind: "input", agentId: "gone", trustPrompt: { cwd: "/" } })).toBe(
      undefined,
    );
  });
});

describe("push API", () => {
  it("serves the VAPID key and stores / deletes subscriptions", async () => {
    const h = await start();
    const key = await h.json<{ publicKey: string }>("GET", "/api/push/vapid-key");
    expect(key.status).toBe(200);
    expect(key.body.publicKey).toBe(h.push?.publicKey);

    await subscribe(h, 1);
    await subscribe(h, 2);
    await subscribe(h, 1);
    const store = new SubscriptionStore(h.dataDir);
    expect((await store.list()).map((s) => s.endpoint)).toEqual([
      subscription(1).endpoint,
      subscription(2).endpoint,
    ]);

    const del = await h.api("DELETE", "/api/push/subscriptions", {
      endpoint: subscription(1).endpoint,
    });
    expect(del.status).toBe(204);
    // Unknown endpoints are fine too.
    expect(
      (await h.api("DELETE", "/api/push/subscriptions", { endpoint: "https://x/y" })).status,
    ).toBe(204);
    expect((await new SubscriptionStore(h.dataDir).list()).map((s) => s.endpoint)).toEqual([
      subscription(2).endpoint,
    ]);
  });

  it("validates bodies and applies the origin guard", async () => {
    const h = await start();
    for (const body of [
      {},
      { endpoint: "http://insecure/x", keys: { p256dh: "a", auth: "b" } },
      { endpoint: "https://ok/x" },
      { endpoint: "https://ok/x", keys: { p256dh: "", auth: "b" } },
    ]) {
      const res = await h.api("POST", "/api/push/subscriptions", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.api("DELETE", "/api/push/subscriptions", {})).status).toBe(400);
    const cross = await fetch(`${h.base}/api/push/subscriptions`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(subscription(1)),
    });
    expect(cross.status).toBe(403);
  });

  it("answers not_found when push is disabled", async () => {
    const h = await start({ push: false });
    expect((await h.api("GET", "/api/push/vapid-key")).status).toBe(404);
  });
});

describe("triggers", () => {
  it("plain answer → one `finished` push to every subscription", async () => {
    const h = await start({ fixture: "plain-answer" });
    await subscribe(h, 1);
    await subscribe(h, 2);
    const agent = await h.open();
    await promptAndSettle(h, agent.id);
    expect(h.pushes.map((p) => p.endpoint).sort()).toEqual([
      subscription(1).endpoint,
      subscription(2).endpoint,
    ]);
    const text = lastAssistantText("plain-answer");
    expect(text.length).toBeGreaterThan(0);
    for (const p of h.pushes) {
      expect(p.payload).toEqual({
        kind: "finished",
        agentId: agent.id,
        title: "project",
        body: truncate(text),
        badge: 1,
        url: `/agents/${agent.id}`,
      });
      expect(p.options.TTL).toBe(3600);
      expect(p.options.urgency).toBe("normal");
      expect(p.options.vapidDetails.publicKey).toBe(h.push?.publicKey);
    }
  });

  it("user aborts (text and mid-tool) push nothing", async () => {
    const h = await start({ fixture: "abort" });
    await subscribe(h, 1);
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    for (const message of ["story", "sleep"]) {
      const before = client.events.filter(
        (r) => r.event.type === "pi" && r.event.event.type === "agent_settled",
      ).length;
      expect((await h.rpc(agent.id, { type: "prompt", message })).status).toBe(200);
      expect((await h.rpc(agent.id, { type: "abort" })).status).toBe(200);
      await client.until(
        () =>
          client.events.filter(
            (r) => r.event.type === "pi" && r.event.event.type === "agent_settled",
          ).length > before || undefined,
      );
    }
    await h.idle(agent.id);
    await h.push?.idle();
    expect(h.pushes).toEqual([]);
  });

  it("extension dialogs → `input` pushes with high urgency and the dialog title", async () => {
    const h = await start({ fixture: "extension-dialog" });
    await subscribe(h, 1);
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    const prompt = h.rpc(agent.id, { type: "prompt", message: "/s0-dialog" });
    const answers: Array<[string, Record<string, unknown>]> = [
      ["select", { value: "banana" }],
      ["confirm", { confirmed: true }],
      ["input", { value: "hello from s0" }],
      ["editor", { cancelled: true }],
    ];
    const titles: string[] = [];
    for (const [method, answer] of answers) {
      const req = await client.waitFor(
        (r) => r.event.type === "ui_request" && r.event.request.method === method,
      );
      const request = (req.event as Of<"ui_request">).request as { id: string; title: string };
      titles.push(request.title);
      await h.idle(agent.id);
      const res = await h.api("POST", `/api/agents/${agent.id}/ui-responses`, {
        id: request.id,
        ...answer,
      });
      expect(res.status).toBe(204);
    }
    expect((await prompt).status).toBe(200);
    await client.waitFor(
      (r) =>
        r.event.type === "ui_request" &&
        "timeout" in r.event.request &&
        r.event.request.timeout === 1500,
    );
    await h.idle(agent.id);
    await h.push?.idle();
    expect(h.pushes.map((p) => p.payload.body)).toEqual([...titles, "S0 timeout select"]);
    for (const p of h.pushes) {
      expect(p.payload).toMatchObject({ kind: "input", agentId: agent.id, badge: 1 });
      expect(p.options.urgency).toBe("high");
    }
  });

  it("a run failing after retries → `failed` push with the error message", async () => {
    const h = await start();
    const errorMessage = "529 Overloaded (retries exhausted)";
    const assistant = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: {},
      stopReason: "error",
      errorMessage,
      timestamp: 1767225600000,
    };
    const state = {
      thinkingLevel: "low",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      sessionId: "s1",
      sessionFile: "/tmp/pi-code-test/s1.jsonl",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    };
    h.fixture = h.writeFixture("failed", [
      { t: 0, dir: "in", line: { id: "q1", type: "get_state" } },
      {
        t: 0,
        dir: "out",
        line: { id: "q1", type: "response", command: "get_state", success: true, data: state },
      },
      { t: 0, dir: "in", line: { id: "p1", type: "prompt", message: "hi" } },
      { t: 0, dir: "out", line: { id: "p1", type: "response", command: "prompt", success: true } },
      { t: 0, dir: "out", line: { type: "agent_start" } },
      { t: 0, dir: "out", line: { type: "message_start", message: assistant } },
      { t: 0, dir: "out", line: { type: "message_end", message: assistant } },
      { t: 0, dir: "out", line: { type: "agent_end", messages: [assistant] } },
      { t: 0, dir: "out", line: { type: "agent_settled" } },
    ]);
    await subscribe(h, 1);
    const agent = await h.open();
    await promptAndSettle(h, agent.id);
    expect(h.pushes.map((p) => p.payload)).toEqual([
      {
        kind: "failed",
        agentId: agent.id,
        title: "project",
        body: errorMessage,
        badge: 1,
        url: `/agents/${agent.id}`,
      },
    ]);
    expect(h.manager.require(agent.id).info().attention).toBe("failed");
  });

  it("the project-trust prompt → `input` push", async () => {
    const h = await start();
    mkdirSync(join(h.project, ".pi"));
    writeFileSync(join(h.project, ".pi", "settings.json"), "{}");
    await subscribe(h, 1);
    const res = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", { cwd: h.project });
    expect(res.body.agent.status).toBe("awaiting_trust");
    await h.push?.idle();
    expect(h.pushes.map((p) => p.payload)).toEqual([
      {
        kind: "input",
        agentId: res.body.agent.id,
        title: "project",
        body: "Trust project project?",
        badge: 1,
        url: `/agents/${res.body.agent.id}`,
      },
    ]);
  });

  it("prunes subscriptions the push service reports gone (404/410), keeps others", async () => {
    const h = await start({
      fixture: "plain-answer",
      push: {
        failWith: (endpoint) =>
          endpoint.endsWith("/1")
            ? 410
            : endpoint.endsWith("/2")
              ? 404
              : endpoint.endsWith("/3")
                ? 500
                : undefined,
      },
    });
    for (const n of [1, 2, 3, 4]) await subscribe(h, n);
    const agent = await h.open();
    await promptAndSettle(h, agent.id);
    expect(h.pushes).toHaveLength(4);
    expect((await new SubscriptionStore(h.dataDir).list()).map((s) => s.endpoint)).toEqual([
      subscription(3).endpoint,
      subscription(4).endpoint,
    ]);
  });
});
