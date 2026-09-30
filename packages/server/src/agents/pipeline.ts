import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AgentInfo,
  type AgentMessage,
  type AgentStatus,
  type AssistantMessage,
  type Attention,
  applyServerEventToCaches,
  type BashResult,
  type DialogRequest,
  effectiveStopReason,
  type GitStatus,
  initialLiveState,
  isDialogRequest,
  type JsonAgentSessionEvent,
  type LiveState,
  type RpcExtensionUIRequest,
  type RpcSessionState,
  reduceLive,
  type ServerEvent,
  type SessionCaches,
  type SessionEntry,
  type SessionStats,
  type Snapshot,
  type Transcript,
  type UiResponseBody,
} from "@pi-code/protocol";
import { type CuratorHook, curatorUrlOf } from "../curator/registry.ts";
import { ApiError, isApiError } from "../errors.ts";
import { gitStatus } from "../git/git.ts";
import { canonicalize } from "../paths.ts";
import type { AgentHost, HostCommand } from "./agent-host.ts";
import { EventLog } from "./event-log.ts";

/** What the pipeline needs from its agent (implemented by `Agent`). */
export interface PipelineAgent {
  readonly id: string;
  readonly cwd: string;
  /** The current pi process (throws while there is none, see `hasHost`). */
  readonly host: AgentHost;
  readonly hasHost: boolean;
  status: AgentStatus;
  attention: Attention;
  /** Mirrors the pipeline's cached `get_state` (read by `info()`). */
  state: RpcSessionState | null;
  info(): AgentInfo;
}

/** A notification trigger (push notifications hook in here). */
export type AttentionTrigger =
  | { kind: "finished" | "failed"; agentId: string; message: AssistantMessage }
  | { kind: "input"; agentId: string; request: DialogRequest }
  | { kind: "input"; agentId: string; trustPrompt: { cwd: string } };

export interface PipelineOptions {
  /** Events kept for SSE replay. Default 10,000. */
  eventLogCapacity?: number;
  /**
   * Called with the agent's info after every published `agent_status`, and after any other
   * published event that changes its `isStreaming`, `sessionName`, `sessionFile` or `sessionId`.
   */
  onAgentInfo?: (info: AgentInfo) => void;
  /** Called when an agent starts needing attention. */
  onTrigger?: (trigger: AttentionTrigger) => void;
  /** Git status of a directory (default: `git` itself). */
  gitStatus?: (cwd: string) => Promise<GitStatus | null>;
  /** Delay between `turn_end` (or `bash` completion) and the git status refresh. Default 2 s. */
  gitDebounceMs?: number;
  /** Curator proxy registry (`details.curatorUrl` → `curator` event). */
  curator?: CuratorHook;
}

/** Synthetic `extension_ui_request` ids the server publishes to clear stale statuses/widgets. */
const CLEAR_ID_PREFIX = "pi-code-clear-";

/** Commands after which pi may be in another session: full transcript + state refresh. */
export const SESSION_CHANGING_COMMANDS: ReadonlySet<string> = new Set([
  "new_session",
  "switch_session",
  "fork",
  "clone",
]);

/** Commands after which `get_state` is refreshed and published as `state`. */
export const STATE_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  "set_model",
  "cycle_model",
  "set_thinking_level",
  "cycle_thinking_level",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_auto_compaction",
  "set_auto_retry",
  "set_session_name",
]);

/** Query commands: no side effects, so no entry sync after them. */
export function isQueryCommand(type: string): boolean {
  return type.startsWith("get_");
}

/** Key matching a message entry to its `message_end` event. */
function messageKey(message: Pick<AgentMessage, "role" | "timestamp">): string {
  return `${message.role}:${String(message.timestamp)}`;
}

function sessionFieldsDiffer(a: AgentInfo, b: AgentInfo): boolean {
  return (
    a.isStreaming !== b.isStreaming ||
    a.sessionName !== b.sessionName ||
    a.sessionFile !== b.sessionFile ||
    a.sessionId !== b.sessionId
  );
}

function isCancelled(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { cancelled?: unknown }).cancelled === true
  );
}

/**
 * The per-agent event pipeline. Every pi record goes through one sequential async queue:
 * side effects first (entry syncs, stats, state; they await pi), then a synchronous publish
 * per resulting event — seq, `reduceLive`, `applyServerEventToCaches`, event log, SSE fan-out.
 * Because nothing awaits inside a publish, the snapshot (built from memory) always reflects
 * exactly the events up to its `seq`.
 */
export class AgentPipeline {
  readonly log: EventLog;
  private readonly agent: PipelineAgent;
  private readonly opts: PipelineOptions;
  private live: LiveState = initialLiveState();
  private caches: SessionCaches;
  private queue: Promise<void> = Promise.resolve();
  private sessionLock: Promise<void> = Promise.resolve();
  private readonly dialogTimers = new Map<string, NodeJS.Timeout>();
  /** Running RPC `bash` commands by command id. */
  private readonly bashCommands = new Map<
    string,
    { command: string; excludeFromContext: boolean }
  >();
  /**
   * Messages whose `message_end` is published (or being published) but whose entry isn't in
   * the transcript yet, by `role:timestamp` (a count, since keys can repeat). An entry sync
   * stops at the first message entry not listed here, so a sync never commits an entry before
   * the events that precede it (pi may have moved on while the sync was queued).
   */
  private readonly unsyncedMessages = new Map<string, number>();
  /** Last assistant message of the current run (for the finished / failed triggers). */
  private runAssistant: AssistantMessage | undefined;
  /**
   * Status / widget keys set since a session change or respawn began. Extensions re-initialise
   * then (their new records arrive before the command response), so keys not set again belong
   * to the previous session and are cleared once the change completes.
   */
  private freshUi: { statuses: Set<string>; widgets: Set<string> } | undefined;
  private clearIds = 0;
  /** The info last passed to `onAgentInfo`. */
  private reported: AgentInfo;
  private gitTimer: NodeJS.Timeout | undefined;
  private gitRefreshing = false;
  private gitAgain = false;
  private disposed = false;
  /** The last session file canonicalized by `getState`, if it existed: pi's path → canonical. */
  private sessionPath: { raw: string; canonical: string } | undefined;

  constructor(agent: PipelineAgent, opts: PipelineOptions = {}) {
    this.agent = agent;
    this.opts = opts;
    this.log = new EventLog(opts.eventLogCapacity);
    this.reported = agent.info();
    this.caches = {
      agent: this.reported,
      state: null,
      transcript: { entries: [], leafId: null },
      stats: null,
      gitStatus: null,
    };
  }

  get seq(): number {
    return this.log.seq;
  }

  get state(): RpcSessionState | null {
    return this.caches.state;
  }

  get transcript(): Transcript {
    return this.caches.transcript;
  }

  get liveState(): LiveState {
    return this.live;
  }

  /** Whether a run is in progress (a `prompt` then needs `streamingBehavior`). */
  isStreaming(): boolean {
    return this.live.run.active || (this.caches.state?.isStreaming ?? false);
  }

  /** Full state for (re)hydration, built synchronously: exactly the events up to `seq`. */
  snapshot(): Snapshot {
    const { agent, state, transcript, stats, gitStatus } = this.caches;
    return { agent, state, transcript, live: this.live, stats, gitStatus, seq: this.log.seq };
  }

  // -------------------------------------------------------------------------
  // Queue and publish

  /** Runs `task` after every previously queued task. Never rejects. */
  enqueue(task: () => Promise<void> | void): Promise<void> {
    const run = this.queue.then(task).catch((e) => {
      console.error(`[agent ${this.agent.id}] pipeline task failed:`, e);
    });
    this.queue = run;
    return run;
  }

  /** Runs `fn` exclusively among session-changing operations of this agent. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sessionLock.then(fn);
    this.sessionLock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Synchronous publish: seq, live state, caches, log, fan-out, info report. */
  publish(event: ServerEvent): void {
    const state = this.caches.state;
    this.live = reduceLive(this.live, event);
    this.caches = applyServerEventToCaches(this.caches, event);
    this.agent.state = this.caches.state;
    if (event.type === "transcript_reset") this.unsyncedMessages.clear();
    this.log.append(event);
    // Besides the status (reported by `publishStatus`), those fields derive from the state.
    if (this.caches.state !== state) {
      const info = this.agent.info();
      if (sessionFieldsDiffer(info, this.reported)) this.reportInfo(info);
    }
  }

  private publishAll(events: readonly ServerEvent[]): void {
    for (const event of events) this.publish(event);
  }

  /** Publishes the agent's current info as `agent_status`. */
  publishStatus(): void {
    const info = this.agent.info();
    this.publish({ type: "agent_status", agent: info });
    this.reportInfo(info);
  }

  private reportInfo(info: AgentInfo): void {
    this.reported = info;
    this.opts.onAgentInfo?.(info);
  }

  setStatus(status: AgentStatus): void {
    if (this.agent.status === status) return;
    this.agent.status = status;
    this.publishStatus();
  }

  setAttention(attention: Attention): void {
    if (this.agent.attention === attention) return;
    this.agent.attention = attention;
    this.publishStatus();
  }

  /**
   * `POST /ack`: clears `finished` / `failed`. `input` stays while a dialog or the trust
   * prompt is pending; it clears when those are answered.
   */
  ack(): void {
    const pending = this.live.dialogs.length > 0 || this.agent.status === "awaiting_trust";
    if (this.agent.attention === "input" && pending) return;
    this.setAttention("none");
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /**
   * Publishes the initial status and, unless the agent awaits the trust decision, queues
   * initialization (state, transcript, stats, git status → ready).
   */
  start(): void {
    this.publishStatus();
    if (this.agent.status === "starting") void this.enqueue(() => this.initialize());
  }

  /**
   * A new pi process was attached (after the trust decision, or a restart): forget the old
   * process's in-flight state, become `starting`, and initialize again. Statuses and widgets
   * the new process doesn't set before it is ready are cleared.
   */
  spawned(): void {
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    this.bashCommands.clear();
    this.unsyncedMessages.clear();
    this.runAssistant = undefined;
    this.beginUiRefresh();
    this.setStatus("starting");
    // Late records of the previous process (e.g. a rejected bash's `bash_done`) may have
    // landed after the exit's reset.
    void this.enqueue(() => this.resetLive());
    void this.enqueue(() => this.initialize());
  }

  private async initialize(): Promise<void> {
    const host = this.agent.host;
    try {
      const state = await this.getState(host);
      const transcript = await host.send<Transcript>({ type: "get_entries" });
      const stats = await host
        .send<SessionStats>({ type: "get_session_stats" })
        .catch(() => undefined);
      const git = await this.readGitStatus();
      if (this.agent.status !== "starting" || this.agent.host !== host) return;
      this.publish({ type: "transcript_reset", transcript, state });
      if (stats !== undefined) this.publish({ type: "stats", stats });
      this.clearStaleUi();
      if (git !== undefined) this.publishGitStatus(git);
      this.setStatus("ready");
    } catch (e) {
      this.warnUnlessExited("initialization", e);
    }
  }

  /**
   * pi exited (`agent.status` is already `exited`): resolve its dialogs, drop the rest of its
   * live state (`live_reset`), stop the git refresh, publish the status.
   */
  onExit(): void {
    this.opts.curator?.releaseAgent(this.agent.id);
    clearTimeout(this.gitTimer);
    this.gitTimer = undefined;
    void this.enqueue(() => {
      for (const dialog of [...this.live.dialogs]) {
        clearTimeout(this.dialogTimers.get(dialog.request.id));
        this.dialogTimers.delete(dialog.request.id);
        this.publish({ type: "ui_resolved", id: dialog.request.id });
      }
      this.resetLive();
      if (this.agent.attention === "input") this.agent.attention = "none";
      this.publishStatus();
    });
  }

  /** Publishes `live_reset` unless there is nothing in flight to drop. */
  private resetLive(): void {
    const event: ServerEvent = { type: "live_reset" };
    if (reduceLive(this.live, event) !== this.live) this.publish(event);
  }

  /** The agent was removed: stop timers and end event streams. */
  dispose(): void {
    this.disposed = true;
    this.opts.curator?.releaseAgent(this.agent.id);
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    clearTimeout(this.gitTimer);
    this.log.close();
  }

  // -------------------------------------------------------------------------
  // pi records

  onEvent(event: JsonAgentSessionEvent): void {
    const receivedAt = Date.now();
    void this.enqueue(() => this.handleEvent(event, receivedAt));
  }

  private async handleEvent(event: JsonAgentSessionEvent, receivedAt: number): Promise<void> {
    if (event.type === "bash_execution_update") {
      if (event.id !== undefined) this.publish(this.bashOutput(event.id, event.delta));
      return;
    }
    if (event.type === "message_end") {
      const key = messageKey(event.message);
      this.unsyncedMessages.set(key, (this.unsyncedMessages.get(key) ?? 0) + 1);
    }
    const events: ServerEvent[] = [{ type: "pi", event, receivedAt }];
    switch (event.type) {
      case "message_end":
      case "entry_appended":
        events.push(...(await this.syncEntries()));
        break;
      case "agent_settled":
        // End of the run: every event of it is published, so nothing needs holding back.
        events.push(...(await this.syncEntries({ gated: false })));
        break;
      case "tool_execution_update":
        events.push(...this.curatorEvents(event.toolCallId, event.toolName, event.partialResult));
        break;
      case "tool_execution_end":
        // The tool is done, so is its curator.
        this.opts.curator?.release(this.agent.id, event.toolCallId);
        break;
      case "turn_end":
        events.push(...(await this.fetchStats()));
        this.scheduleGitStatus();
        break;
      case "compaction_end":
        if (!event.aborted && event.errorMessage === undefined) {
          events.push(...(await this.resetSession()));
        } else {
          events.push(...(await this.syncEntries()));
        }
        break;
      default:
        break;
    }
    this.publishAll(events);

    switch (event.type) {
      case "agent_start":
        this.runAssistant = undefined;
        break;
      case "message_end":
        if (event.message.role === "assistant") this.runAssistant = event.message;
        break;
      case "agent_settled":
        this.onRunSettled();
        break;
      default:
        break;
    }
  }

  /** Registers a running tool's curator and returns the `curator` event (once per URL). */
  private curatorEvents(
    toolCallId: string,
    toolName: string,
    partialResult: unknown,
  ): ServerEvent[] {
    const curator = this.opts.curator;
    const raw = curator && curatorUrlOf(partialResult);
    if (!curator || raw === undefined) return [];
    const url = curator.register(this.agent.id, toolCallId, toolName, raw);
    if (url === undefined || this.live.curator[toolCallId] === url) return [];
    return [{ type: "curator", toolCallId, url }];
  }

  /**
   * End of a run: `finished` when the last assistant message stopped normally (`stop` /
   * `length`), `failed` on an error (after retries); user aborts notify nothing.
   */
  private onRunSettled(): void {
    const message = this.runAssistant;
    this.runAssistant = undefined;
    if (message === undefined) return;
    const reason = effectiveStopReason(message);
    let kind: "finished" | "failed";
    if (reason === "stop" || reason === "length") kind = "finished";
    else if (reason === "error") kind = "failed";
    else return;
    if (this.agent.attention !== "input") this.setAttention(kind);
    this.opts.onTrigger?.({ kind, agentId: this.agent.id, message });
  }

  onUiRequest(request: RpcExtensionUIRequest): void {
    const receivedAt = Date.now();
    // Tracked on receipt: a respawned pi's startup records are queued behind initialization.
    if (request.method === "setStatus") this.freshUi?.statuses.add(request.statusKey);
    if (request.method === "setWidget") this.freshUi?.widgets.add(request.widgetKey);
    void this.enqueue(() => {
      this.publish({ type: "ui_request", request, receivedAt });
      if (!isDialogRequest(request)) return;
      const timeout = "timeout" in request ? request.timeout : undefined;
      if (timeout !== undefined && timeout > 0) {
        this.scheduleExpiry(request.id, receivedAt + timeout);
      }
      this.setAttention("input");
      this.opts.onTrigger?.({ kind: "input", agentId: this.agent.id, request });
    });
  }

  // -------------------------------------------------------------------------
  // Dialogs

  isDialogPending(id: string): boolean {
    return this.live.dialogs.some((d) => d.request.id === id);
  }

  /**
   * Writes a dialog answer to pi (pi sends no response) and publishes `ui_resolved`.
   * Throws `dialog_not_found` if it is no longer pending.
   */
  answerDialog(answer: UiResponseBody): void {
    if (!this.isDialogPending(answer.id)) {
      throw new ApiError("dialog_not_found", `no pending dialog ${answer.id}`);
    }
    this.agent.host.sendNoReply({ type: "extension_ui_response", ...answer });
    this.resolveDialog(answer.id);
  }

  /** pi resolves timed-out dialogs silently; this timer mirrors that. */
  private scheduleExpiry(id: string, expiresAt: number): void {
    clearTimeout(this.dialogTimers.get(id));
    const timer = setTimeout(
      () => {
        this.dialogTimers.delete(id);
        if (this.isDialogPending(id)) this.resolveDialog(id);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref();
    this.dialogTimers.set(id, timer);
  }

  private resolveDialog(id: string): void {
    clearTimeout(this.dialogTimers.get(id));
    this.dialogTimers.delete(id);
    this.publish({ type: "ui_resolved", id });
    if (this.live.dialogs.length === 0 && this.agent.attention === "input") {
      this.setAttention("none");
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  /**
   * Side effects of a successful command response, queued behind the records received so far:
   * session changes → `transcript_reset` + `stats`; other non-query commands → entry sync (many create
   * entries without any event), plus `state` for state-mutating ones. Resolves once published.
   */
  afterCommand(type: string, data: unknown): Promise<void> {
    if (isQueryCommand(type)) return Promise.resolve();
    return this.enqueue(async () => {
      if (SESSION_CHANGING_COMMANDS.has(type)) {
        if (isCancelled(data)) {
          this.freshUi = undefined;
          return;
        }
        this.publishAll(await this.resetSession());
        this.clearStaleUi();
        return;
      }
      const events = await this.syncEntries();
      if (STATE_MUTATING_COMMANDS.has(type)) events.push(...(await this.fetchState()));
      this.publishAll(events);
    });
  }

  /**
   * Full resync after an out-of-band session change (tree navigation): `transcript_reset` +
   * `stats`. Resolves once published.
   */
  resync(): Promise<void> {
    return this.enqueue(async () => {
      this.publishAll(await this.resetSession());
    });
  }

  /**
   * Starts collecting the status / widget keys extensions set from now on; call right before
   * sending a session-changing command. See `freshUi`.
   */
  beginUiRefresh(): void {
    this.freshUi = { statuses: new Set(), widgets: new Set() };
  }

  /** Clears the statuses / widgets not set again since `beginUiRefresh` (synthetic requests). */
  private clearStaleUi(): void {
    const fresh = this.freshUi;
    this.freshUi = undefined;
    if (fresh === undefined) return;
    const receivedAt = Date.now();
    for (const statusKey of Object.keys(this.live.statuses)) {
      if (fresh.statuses.has(statusKey)) continue;
      this.publish({
        type: "ui_request",
        request: {
          type: "extension_ui_request",
          id: `${CLEAR_ID_PREFIX}${++this.clearIds}`,
          method: "setStatus",
          statusKey,
          statusText: undefined,
        },
        receivedAt,
      });
    }
    for (const widgetKey of Object.keys(this.live.widgets)) {
      if (fresh.widgets.has(widgetKey)) continue;
      this.publish({
        type: "ui_request",
        request: {
          type: "extension_ui_request",
          id: `${CLEAR_ID_PREFIX}${++this.clearIds}`,
          method: "setWidget",
          widgetKey,
          widgetLines: undefined,
        },
        receivedAt,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Git status

  /** Refreshes the git status `gitDebounceMs` after the last call (turn ends, bash commands). */
  scheduleGitStatus(): void {
    if (this.disposed || this.agent.status === "exited") return;
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => {
      this.gitTimer = undefined;
      void this.refreshGitStatus();
    }, this.opts.gitDebounceMs ?? 2_000);
    this.gitTimer.unref();
  }

  /** Reads the git status (outside the queue) and publishes `git_status` if it changed. */
  async refreshGitStatus(): Promise<void> {
    if (this.gitRefreshing) {
      this.gitAgain = true;
      return;
    }
    this.gitRefreshing = true;
    try {
      do {
        this.gitAgain = false;
        const status = await this.readGitStatus();
        if (status !== undefined && !this.disposed && this.agent.status !== "exited") {
          await this.enqueue(() => this.publishGitStatus(status));
        }
      } while (this.gitAgain && !this.disposed && this.agent.status !== "exited");
    } finally {
      this.gitRefreshing = false;
    }
  }

  /** The cwd's git status; `undefined` when it couldn't be read. */
  private async readGitStatus(): Promise<GitStatus | null | undefined> {
    try {
      return await (this.opts.gitStatus ?? gitStatus)(this.agent.cwd);
    } catch (e) {
      console.warn(`[agent ${this.agent.id}] git status failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  private publishGitStatus(status: GitStatus | null): void {
    const current = this.caches.gitStatus;
    const same =
      status === null
        ? current === null
        : current !== null && current.branch === status.branch && current.dirty === status.dirty;
    if (!same) this.publish({ type: "git_status", status });
  }

  /**
   * Sends an RPC `bash` without waiting for it: output streams as `bash_output`, completion as
   * `bash_done` followed by the entry sync (its `bashExecution` entry has no event). Returns
   * the command id.
   */
  startBash(command: HostCommand & { command: string; excludeFromContext?: boolean }): string {
    const { id, response } = this.agent.host.request<BashResult>(command);
    this.bashCommands.set(id, {
      command: command.command,
      excludeFromContext: command.excludeFromContext === true,
    });
    const finish = (result: BashResult, sync: boolean) =>
      this.enqueue(async () => {
        const entries = sync ? await this.syncEntries() : [];
        this.publishAll([this.bashDone(id, result), ...entries]);
        this.bashCommands.delete(id);
        if (sync) this.scheduleGitStatus();
      });
    response.then(
      (result) => finish(result, true),
      (error: unknown) =>
        finish(
          {
            output: error instanceof Error ? error.message : String(error),
            exitCode: undefined,
            cancelled: true,
            truncated: false,
          },
          false,
        ),
    );
    return id;
  }

  private bashOutput(id: string, delta: string): ServerEvent {
    return { type: "bash_output", id, delta, ...this.bashFields(id) };
  }

  private bashDone(id: string, result: BashResult): ServerEvent {
    return { type: "bash_done", id, result, ...this.bashFields(id) };
  }

  /** `command` (and `excludeFromContext` for `!!`) of a running bash command. */
  private bashFields(id: string): { command?: string; excludeFromContext?: true } {
    const bash = this.bashCommands.get(id);
    if (bash === undefined) return {};
    return bash.excludeFromContext
      ? { command: bash.command, excludeFromContext: true }
      : { command: bash.command };
  }

  // -------------------------------------------------------------------------
  // Side effects (await pi; return events to publish)

  /**
   * `get_entries { since: <last entry> }` → `entries_appended`. Falls back to a full reset when
   * pi doesn't know `since` or its leaf isn't the last new entry. When `gated`, stops at the
   * first message entry whose `message_end` hasn't been published yet (see `unsyncedMessages`).
   */
  private async syncEntries(opts: { gated?: boolean } = {}): Promise<ServerEvent[]> {
    const gated = opts.gated ?? true;
    const current = this.caches.transcript;
    const since = current.entries.at(-1)?.id;
    let data: Transcript;
    try {
      data = await this.agent.host.send<Transcript>(
        since === undefined ? { type: "get_entries" } : { type: "get_entries", since },
      );
    } catch (e) {
      if (since !== undefined && isApiError(e, "pi_error")) return this.resetTranscript();
      this.warnUnlessExited("entry sync", e);
      return [];
    }
    const known = new Set(current.entries.map((e) => e.id));
    const fresh = data.entries.filter((e) => !known.has(e.id));
    const cut = gated ? fresh.findIndex((e) => !this.isCommittable(e)) : -1;
    if (cut >= 0) {
      const ready = fresh.slice(0, cut);
      const last = ready.at(-1);
      if (last === undefined) return [];
      this.markSynced(ready);
      return [{ type: "entries_appended", entries: ready, leafId: last.id }];
    }
    const expectedLeaf = fresh.at(-1)?.id ?? current.leafId;
    if (data.leafId !== expectedLeaf) return this.resetTranscript();
    if (fresh.length === 0) return [];
    this.markSynced(fresh);
    return [{ type: "entries_appended", entries: fresh, leafId: data.leafId }];
  }

  private isCommittable(entry: SessionEntry): boolean {
    if (entry.type !== "message" || entry.message.role === "bashExecution") return true;
    return (this.unsyncedMessages.get(messageKey(entry.message)) ?? 0) > 0;
  }

  private markSynced(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const key = messageKey(entry.message);
      const count = this.unsyncedMessages.get(key);
      if (count === undefined) continue;
      if (count <= 1) this.unsyncedMessages.delete(key);
      else this.unsyncedMessages.set(key, count - 1);
    }
  }

  /** Full `get_entries` + `get_state` → `transcript_reset`. */
  private async resetTranscript(): Promise<ServerEvent[]> {
    try {
      const transcript = await this.agent.host.send<Transcript>({ type: "get_entries" });
      const state = await this.getState(this.agent.host);
      return [{ type: "transcript_reset", transcript, state }];
    } catch (e) {
      this.warnUnlessExited("transcript reset", e);
      return [];
    }
  }

  /**
   * `transcript_reset` followed by fresh `stats`: after a session change or a compaction the
   * cached stats describe another session file or the pre-compaction context.
   */
  private async resetSession(): Promise<ServerEvent[]> {
    const reset = await this.resetTranscript();
    return reset.length === 0 ? reset : [...reset, ...(await this.fetchStats())];
  }

  private async fetchStats(): Promise<ServerEvent[]> {
    try {
      const stats = await this.agent.host.send<SessionStats>({ type: "get_session_stats" });
      return [{ type: "stats", stats }];
    } catch (e) {
      this.warnUnlessExited("stats refresh", e);
      return [];
    }
  }

  private async fetchState(): Promise<ServerEvent[]> {
    try {
      const state = await this.getState(this.agent.host);
      return [{ type: "state", state }];
    } catch (e) {
      this.warnUnlessExited("state refresh", e);
      return [];
    }
  }

  /**
   * `get_state` with `sessionFile` canonicalized, matching the catalog's paths (pi reports a new
   * session's path as it built it, e.g. through a symlinked agent dir). A file that doesn't exist
   * yet (pi writes new sessions lazily) is canonicalized through its directory.
   */
  private async getState(host: AgentHost): Promise<RpcSessionState> {
    const state = await host.send<RpcSessionState>({ type: "get_state" });
    const raw = state.sessionFile;
    if (raw === undefined) return state;
    if (this.sessionPath?.raw === raw) return { ...state, sessionFile: this.sessionPath.canonical };
    let sessionFile: string;
    if (existsSync(raw)) {
      sessionFile = await canonicalize(raw);
      this.sessionPath = { raw, canonical: sessionFile };
    } else {
      sessionFile = join(await canonicalize(dirname(raw)), basename(raw));
    }
    return { ...state, sessionFile };
  }

  private warnUnlessExited(what: string, e: unknown): void {
    if (isApiError(e, "agent_exited")) return;
    if (!this.agent.hasHost || this.agent.host.status !== "running") return;
    console.warn(`[agent ${this.agent.id}] ${what} failed: ${(e as Error).message}`);
  }
}
