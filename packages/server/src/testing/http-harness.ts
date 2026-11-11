/**
 * Integration-test harness: the real Hono app on a real HTTP listener (127.0.0.1, random
 * port), an `AgentManager` spawning the fake pi, and `GET /api/stream` clients.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import {
  type AgentId,
  type AgentInfo,
  applyServerEventToCaches,
  type CursorList,
  type PushPayload,
  reduceLive,
  type SequencedEvent,
  type ServerEvent,
  type SessionCaches,
  type Snapshot,
  type StreamFrame,
} from "@pi-code/protocol";
import type { AgentHostOptions } from "../agents/agent-host.ts";
import { AgentManager, type AgentManagerDeps } from "../agents/agent-manager.ts";
import { createApp } from "../app.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
import { type SessionWatcher, watchSessions } from "../catalog/watcher.ts";
import { CuratorRegistry } from "../curator/registry.ts";
import type { ErrorEnvelope } from "../errors.ts";
import type { SseOptions } from "../http/stream.ts";
import { StreamHub } from "../live/stream-hub.ts";
import type { GhRunner } from "../pr/github.ts";
import type { GuideRunner, GuideService } from "../pr/guide-service.ts";
import { PrService } from "../pr/pr-service.ts";
import { type PushSendOptions, PushService } from "../push/push-service.ts";
import { SubscriptionStore } from "../push/subscriptions.ts";
import { loadVapidDetails } from "../push/vapid.ts";
import { SidebarStateStore } from "../store/sidebar-state.ts";
import { testGuides } from "./guides.ts";
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
  /** SSE tuning (e.g. a short ping interval, a small backlog limit). */
  sse?: SseOptions;
  /** Pipeline tuning (e.g. a stub git status, a short debounce). */
  pipeline?: AgentManagerDeps["pipeline"];
  /**
   * Web Push with a recording sender (keys and subscriptions in `<root>/data`). `failWith`
   * makes sends to an endpoint reject with that HTTP status.
   */
  push?: boolean | { failWith?: (endpoint: string) => number | undefined };
  /** Curator registry wired into the pipelines (`harness.curators`). */
  curator?: boolean;
  /** Watches `<agentDir>/sessions` and feeds rescans to the hub, as the server does. */
  watchSessions?: boolean;
  /** Trash command for session files (default `rm`, keeping test files out of the real Trash). */
  trashCommand?: string;
  /** Stands in for `gh` (PR review); without it, `gh` calls fail. */
  gh?: GhRunner;
  /** Stands in for the PR guide job; without it, guide jobs fail. */
  guideRunner?: GuideRunner;
}

/** A push message the harness's fake sender received. */
interface SentPush {
  endpoint: string;
  payload: PushPayload;
  options: PushSendOptions;
}

/** One dispatched SSE message. */
interface SseMessage {
  /** `event:` field, for named events. */
  name?: string;
  /** `id:` field, when present. */
  id?: string;
  data: string;
}

/** A `GET /api/stream` frame with its SSE `id:` (the cursor list). */
interface ReceivedFrame {
  id?: CursorList;
  frame: StreamFrame;
}

/** Streaming client of the live stream (`GET /api/stream`) over `fetch`. */
export class StreamClient {
  readonly frames: ReceivedFrame[] = [];
  /** Named events (`event: <name>`), which aren't frames. */
  readonly named: SseMessage[] = [];
  retry: number | undefined;
  status: number | undefined;
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly waiters = new Set<() => void>();
  private ended = false;

  constructor(url: string, headers: Record<string, string>) {
    this.done = this.run(url, headers).finally(() => {
      this.ended = true;
      for (const w of this.waiters) w();
    });
  }

  /** `id:` of the last frame: where a reconnect resumes. */
  get lastId(): CursorList | undefined {
    return this.frames.at(-1)?.id;
  }

  /** One agent's `event` frames. */
  events(agentId: AgentId): SequencedEvent[] {
    return this.frames.flatMap(({ frame }) =>
      frame.type === "event" && frame.agentId === agentId
        ? [{ seq: frame.seq, event: frame.event }]
        : [],
    );
  }

  private received(message: SseMessage): void {
    if (message.name !== undefined) this.named.push(message);
    else {
      const frame = JSON.parse(message.data) as StreamFrame;
      this.frames.push(message.id === undefined ? { frame } : { id: message.id, frame });
    }
    for (const w of this.waiters) w();
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
            if (name !== undefined || data.length > 0) {
              this.received({
                data: data.join("\n"),
                ...(name === undefined ? {} : { name }),
                ...(id === undefined ? {} : { id }),
              });
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

  /** Resolves with the first defined result of `check`, re-run on every message. */
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
        reject(new Error(`SSE wait timed out; got ${this.summary()}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(tick);
      };
      this.waiters.add(tick);
      tick();
    });
  }

  /** What was received so far (for timeout messages). */
  private summary(): string {
    return this.frames
      .map(({ frame }) =>
        frame.type === "event" ? `${frame.agentId}:${describe(frame)}` : frame.type,
      )
      .join(", ");
  }

  /** Resolves with the first received frame (from the start) satisfying `pred`. */
  waitFor(pred: (frame: StreamFrame) => boolean, timeoutMs = 5_000): Promise<StreamFrame> {
    return this.until(() => this.frames.find((f) => pred(f.frame))?.frame, timeoutMs);
  }

  /** Resolves with the first received event of `agentId` (from the start) satisfying `pred`. */
  waitForEvent(
    agentId: AgentId,
    pred: (e: SequencedEvent) => boolean,
    timeoutMs = 5_000,
  ): Promise<SequencedEvent> {
    return this.until(() => this.events(agentId).find(pred), timeoutMs);
  }

  /** Resolves once an `event` frame of `agentId` with `seq >= seq` arrived. */
  waitForSeq(agentId: AgentId, seq: number, timeoutMs = 5_000): Promise<StreamFrame> {
    return this.waitFor(
      (f) => f.type === "event" && f.agentId === agentId && f.seq >= seq,
      timeoutMs,
    );
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.done;
  }
}

/** Short label of an event (for assertion messages). */
export function describe({ event }: { event: ServerEvent }): string {
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

/** Seq of the agent's last published event. */
export function seqOf(h: Harness, agentId: string): number {
  return h.manager.require(agentId).pipeline.seq;
}

/** Prompts and waits until the run and its side effects (events, pushes) are published. */
export async function promptAndSettle(h: Harness, agentId: string, message = "hi"): Promise<void> {
  // Opened from the current seq, so the run's events are replayed however late it connects.
  const client = h.stream({ open: [[agentId, seqOf(h, agentId)]] });
  const res = await h.rpc(agentId, { type: "prompt", message });
  if (res.status !== 200) throw new Error(`prompt: ${res.status} ${JSON.stringify(res.body)}`);
  await client.waitForEvent(
    agentId,
    (r) => r.event.type === "pi" && r.event.event.type === "agent_settled",
    10_000,
  );
  await client.close();
  await h.idle(agentId);
  await h.push?.idle();
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
  readonly hub: StreamHub;
  readonly sidebar: SidebarStateStore;
  readonly prService: PrService;
  /** PR guides (store in `<root>/data`), run by `guideRunner`. */
  readonly guides: GuideService;
  /** pi-code's data dir (VAPID keys, push subscriptions). */
  readonly dataDir: string;
  push: PushService | undefined;
  /** Push messages sent (successfully or not), in order. */
  readonly pushes: SentPush[] = [];
  readonly curators: CuratorRegistry | undefined;
  /** Fixture name or path used for agents opened from now on. */
  fixture: string;
  private server: ServerType | undefined;
  private readonly sessionsWatcher: SessionWatcher | undefined;
  private readonly clients: StreamClient[] = [];
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
    this.guides = testGuides(this.dataDir, opts.guideRunner);
    this.prService = new PrService({
      dataDir: this.dataDir,
      agents: () => this.manager,
      guides: this.guides,
      gh:
        opts.gh ??
        (async () => {
          throw new Error("no gh in this harness");
        }),
    });
    const pipeline = {
      onTurnEnd: this.prService.onTurnEnd,
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
    this.sidebar = new SidebarStateStore(this.dataDir);
    this.hub = new StreamHub({
      manager: this.manager,
      catalog: this.catalog,
      sidebar: this.sidebar,
      prs: this.prService.store,
      guides: this.guides,
    });
    this.sessionsWatcher = opts.watchSessions
      ? watchSessions(join(this.agentDir, "sessions"), () => void this.hub.refreshCatalog())
      : undefined;
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
      hub: this.hub,
      sidebar: this.sidebar,
      prService: this.prService,
      piVersion: async () => "test",
      ...(this.push !== undefined ? { push: this.push } : {}),
      ...(opts.sse !== undefined ? { sse: opts.sse } : {}),
      trashCommand: opts.trashCommand ?? "rm",
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

  /**
   * Opens `GET /api/stream`: `open` lists `[agentId, seq]` pairs (or is a raw `CursorList`),
   * `lastEventId` is sent as `Last-Event-ID`.
   */
  stream(
    opts: {
      open?: readonly (readonly [AgentId, number | string])[] | CursorList;
      lastEventId?: CursorList;
    } = {},
  ): StreamClient {
    const open =
      typeof opts.open === "string"
        ? opts.open
        : opts.open?.map(([id, seq]) => `${id}:${seq}`).join(",");
    const query = open === undefined ? "" : `?open=${encodeURIComponent(open)}`;
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
    const client = new StreamClient(`${this.base}/api/stream${query}`, headers);
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
    this.sessionsWatcher?.close();
    this.prService.close();
    await Promise.all([this.manager.closeAll(), this.guides.close()]);
    this.hub.close();
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
