/**
 * Integration-test harness: the real Hono app on a real HTTP listener (127.0.0.1, random
 * port), an `AgentManager` spawning the fake pi, and a streaming SSE client.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import {
  type AgentInfo,
  applyServerEventToCaches,
  type PushPayload,
  reduceLive,
  type ServerEvent,
  type SessionCaches,
  type Snapshot,
} from "@pi-code/protocol";
import type { AgentHostOptions } from "../agents/agent-host.ts";
import { AgentManager, type AgentManagerDeps } from "../agents/agent-manager.ts";
import { createApp } from "../app.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
import { CuratorRegistry } from "../curator/registry.ts";
import type { ErrorEnvelope } from "../errors.ts";
import { type PushSendOptions, PushService } from "../push/push-service.ts";
import { SubscriptionStore } from "../push/subscriptions.ts";
import { loadVapidDetails } from "../push/vapid.ts";
import { fakePiCommand } from "./stub-process.ts";

const HOSTNAME = "mac.tail1234.ts.net";

export interface HarnessOptions {
  fixture?: string;
  speed?: number;
  delayGetEntriesMs?: number;
  /** Overrides the fake-pi command. */
  command?: AgentManagerDeps["command"];
  eventLogCapacity?: number;
  hostOptions?: AgentHostOptions;
  ssePingMs?: number;
  /** Pipeline tuning (e.g. a stub git status, a short debounce). */
  pipeline?: AgentManagerDeps["pipeline"];
  /**
   * Web Push with a recording sender (keys and subscriptions in `<root>/data`). `failWith`
   * makes sends to an endpoint reject with that HTTP status.
   */
  push?: boolean | { failWith?: (endpoint: string) => number | undefined };
  /** Curator registry wired into the pipelines (`harness.curators`). */
  curator?: boolean;
}

/** A push message the harness's fake sender received. */
export interface SentPush {
  endpoint: string;
  payload: PushPayload;
  options: PushSendOptions;
}

export interface Received {
  /** SSE `id`, when present. */
  seq?: number;
  event: ServerEvent;
}

/** Minimal streaming SSE client over `fetch`. */
export class SseClient {
  readonly events: Received[] = [];
  /** Named events (`event: <name>`), which aren't `ServerEvent`s. */
  readonly named: { name: string; id?: string; data: string }[] = [];
  retry: number | undefined;
  status: number | undefined;
  private readonly controller = new AbortController();
  private readonly waiters = new Set<() => void>();
  private ended = false;
  readonly done: Promise<void>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.done = this.run(url, headers).finally(() => {
      this.ended = true;
      for (const w of this.waiters) w();
    });
  }

  get lastSeq(): number | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const seq = this.events[i]?.seq;
      if (seq !== undefined) return seq;
    }
    return undefined;
  }

  private async run(url: string, headers: Record<string, string>): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: this.controller.signal });
    } catch {
      return;
    }
    this.status = res.status;
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let id: string | undefined;
    let name: string | undefined;
    let data: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (line === "") {
            if (name !== undefined) {
              this.named.push({ name, data: data.join("\n"), ...(id === undefined ? {} : { id }) });
              for (const w of this.waiters) w();
            } else if (data.length > 0) {
              const event = JSON.parse(data.join("\n")) as ServerEvent;
              this.events.push(id === undefined ? { event } : { seq: Number(id), event });
              for (const w of this.waiters) w();
            }
            id = undefined;
            name = undefined;
            data = [];
          } else if (line.startsWith(":")) {
            // comment
          } else {
            const colon = line.indexOf(":");
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "data") data.push(value);
            else if (field === "id") id = value;
            else if (field === "event") name = value;
            else if (field === "retry") this.retry = Number(value);
          }
        }
      }
    } catch {
      // aborted
    }
  }

  /** Resolves with the first received event (from the start) satisfying `pred`. */
  waitFor(pred: (r: Received) => boolean, timeoutMs = 5_000): Promise<Received> {
    return this.until(() => this.events.find(pred), timeoutMs);
  }

  /** Resolves once an event with `seq >= seq` arrived. */
  waitForSeq(seq: number, timeoutMs = 5_000): Promise<Received> {
    return this.waitFor((r) => r.seq !== undefined && r.seq >= seq, timeoutMs);
  }

  until<T>(check: () => T | undefined, timeoutMs = 5_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const tick = () => {
        const found = check();
        if (found !== undefined) {
          cleanup();
          resolve(found);
        } else if (this.ended) {
          cleanup();
          reject(new Error("SSE stream ended"));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`SSE wait timed out; got ${this.events.map(describe).join(", ")}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(tick);
      };
      this.waiters.add(tick);
      tick();
    });
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.done;
  }
}

/** Short label of an event (for assertion messages). */
export function describe({ event }: Received): string {
  return event.type === "pi" ? `pi:${event.event.type}` : event.type;
}

/** Snapshot state after applying `events` the way the client does. */
export function replay(snapshot: Snapshot, events: readonly ServerEvent[]) {
  let live = snapshot.live;
  let caches: SessionCaches = {
    agent: snapshot.agent,
    state: snapshot.state,
    transcript: snapshot.transcript,
    stats: snapshot.stats,
    gitStatus: snapshot.gitStatus,
  };
  for (const event of events) {
    live = reduceLive(live, event);
    caches = applyServerEventToCaches(caches, event);
  }
  return { ...caches, live };
}

/** The comparable part of a snapshot (everything but `seq`). */
export function stateOf(snapshot: Snapshot) {
  const { seq: _, ...rest } = snapshot;
  return rest;
}

export class Harness {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  /** pi's agent dir for this harness (`sessions/`, `trust.json`). */
  readonly agentDir: string;
  readonly manager: AgentManager;
  readonly catalog: SessionCatalog;
  /** pi-code's data dir (VAPID keys, push subscriptions). */
  readonly dataDir: string;
  push: PushService | undefined;
  /** Push messages sent (successfully or not), in order. */
  readonly pushes: SentPush[] = [];
  readonly curators: CuratorRegistry | undefined;
  /** Fixture name or path used for agents opened from now on. */
  fixture: string;
  private server: ServerType | undefined;
  private readonly clients: SseClient[] = [];
  port = 0;

  constructor(opts: HarnessOptions) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-http-")));
    this.home = join(this.root, "home");
    this.project = join(this.home, "project");
    mkdirSync(this.project, { recursive: true });
    this.agentDir = join(this.root, "agent");
    mkdirSync(join(this.agentDir, "sessions"), { recursive: true });
    this.dataDir = join(this.root, "data");
    this.fixture = opts.fixture ?? "plain-answer";
    this.curators = opts.curator
      ? new CuratorRegistry({ hostname: HOSTNAME, proxyPort: 4181 })
      : undefined;
    const pipeline = {
      ...opts.pipeline,
      ...(this.curators !== undefined ? { curator: this.curators } : {}),
    };
    const fakeOpts = {
      ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      ...(opts.delayGetEntriesMs !== undefined
        ? { delayGetEntriesMs: opts.delayGetEntriesMs }
        : {}),
    };
    this.manager = new AgentManager({
      home: this.home,
      command: opts.command ?? (() => fakePiCommand(this.fixture, fakeOpts)),
      ...(opts.eventLogCapacity !== undefined ? { eventLogCapacity: opts.eventLogCapacity } : {}),
      ...(opts.hostOptions !== undefined ? { hostOptions: opts.hostOptions } : {}),
      // Project-trust pre-check against `<root>/agent/trust.json`; sessions in `<root>/agent`.
      agentDir: this.agentDir,
      pipeline,
      onTrigger: (trigger) => void this.push?.notify(trigger),
    });
    this.catalog = new SessionCatalog({
      agentDir: this.agentDir,
      ownerOf: (file) => this.manager.ownerOf(file),
    });
  }

  async listen(opts: HarnessOptions): Promise<void> {
    let app: ReturnType<typeof createApp> | undefined;
    this.server = await new Promise<ServerType>((resolve) => {
      const server = serve(
        { fetch: (req) => (app as ReturnType<typeof createApp>).fetch(req), port: 0 },
        () => resolve(server),
      );
    });
    this.port = (this.server.address() as AddressInfo).port;
    if (opts.push) {
      const failWith = typeof opts.push === "object" ? opts.push.failWith : undefined;
      this.push = new PushService({
        vapid: await loadVapidDetails(this.dataDir, HOSTNAME),
        store: new SubscriptionStore(this.dataDir),
        agents: this.manager,
        send: async (sub, payload, options) => {
          this.pushes.push({
            endpoint: sub.endpoint,
            payload: JSON.parse(payload) as PushPayload,
            options,
          });
          const status = failWith?.(sub.endpoint);
          if (status !== undefined) {
            throw Object.assign(new Error(`push service answered ${status}`), {
              statusCode: status,
            });
          }
          return { statusCode: 201 };
        },
      });
    }
    app = createApp({
      hostname: HOSTNAME,
      port: this.port,
      staticDir: this.root,
      manager: this.manager,
      catalog: this.catalog,
      piVersion: async () => "test",
      ...(this.push !== undefined ? { push: this.push } : {}),
      ...(opts.ssePingMs !== undefined ? { sse: { pingMs: opts.ssePingMs } } : {}),
    });
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: method === "GET" ? {} : { origin: this.base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async json<T = unknown>(method: string, path: string, body?: unknown) {
    const res = await this.api(method, path, body);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  async rpc<T = unknown>(agentId: string, command: Record<string, unknown>) {
    return this.json<{ data: T } & Partial<ErrorEnvelope>>(
      "POST",
      `/api/agents/${agentId}/rpc`,
      command,
    );
  }

  async snapshot(agentId: string): Promise<Snapshot> {
    const { status, body } = await this.json<Snapshot>("GET", `/api/agents/${agentId}/snapshot`);
    if (status !== 200) throw new Error(`snapshot: ${status}`);
    return body;
  }

  /** Opens an agent in the project dir and waits until it is ready. */
  async open(): Promise<AgentInfo> {
    const { status, body } = await this.json<{ agent: AgentInfo }>("POST", "/api/agents", {
      cwd: this.project,
    });
    if (status !== 201) throw new Error(`open: ${status} ${JSON.stringify(body)}`);
    await this.waitForStatus(body.agent.id, "ready");
    return body.agent;
  }

  waitForStatus(id: string, status: AgentInfo["status"]): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.manager.get(id)?.info().status === status) {
          this.manager.off("agent", check);
          resolve();
        }
      };
      this.manager.on("agent", check);
      check();
    });
  }

  /** Resolves once everything the agent's pipeline has queued so far is published. */
  async idle(agentId: string): Promise<void> {
    await this.manager.require(agentId).pipeline.enqueue(() => {});
  }

  sse(
    agentId: string,
    opts: { since?: number | string; lastEventId?: number | string } = {},
  ): SseClient {
    const query = opts.since === undefined ? "" : `?since=${opts.since}`;
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
    const client = new SseClient(`${this.base}/api/agents/${agentId}/events${query}`, headers);
    this.clients.push(client);
    return client;
  }

  /** Writes a custom fixture file (JSONL) into the temp dir and returns its path. */
  writeFixture(name: string, lines: unknown[]): string {
    const path = join(this.root, `${name}.jsonl`);
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
    await this.manager.closeAll();
    await this.push?.idle();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // SSE connections may linger; the listener closes once they end.
      (this.server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const harness = new Harness(opts);
  await harness.listen(opts);
  return harness;
}
