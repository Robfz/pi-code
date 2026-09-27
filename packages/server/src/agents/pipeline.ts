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
import { ApiError, isApiError } from "../errors.ts";
import type { AgentHost, HostCommand } from "./agent-host.ts";
import { EventLog } from "./event-log.ts";

/** What the pipeline needs from its agent (implemented by `Agent`). */
export interface PipelineAgent {
  readonly id: string;
  readonly host: AgentHost;
  status: AgentStatus;
  attention: Attention;
  /** Mirrors the pipeline's cached `get_state` (read by `info()`). */
  state: RpcSessionState | null;
  info(): AgentInfo;
}

/** A notification trigger (push notifications hook in here, S12). */
export type AttentionTrigger =
  | { kind: "finished" | "failed"; agentId: string; message: AssistantMessage }
  | { kind: "input"; agentId: string; request: DialogRequest };

export interface PipelineOptions {
  /** Events kept for SSE replay. Default 10,000. */
  eventLogCapacity?: number;
  /** Called after every published `agent_status`. */
  onAgentInfo?: (info: AgentInfo) => void;
  /** Called when an agent starts needing attention. */
  onTrigger?: (trigger: AttentionTrigger) => void;
}

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
  /** Running RPC `bash` commands: command id → command line. */
  private readonly bashCommands = new Map<string, string>();
  /**
   * Messages whose `message_end` is published (or being published) but whose entry isn't in
   * the transcript yet, by `role:timestamp` (a count, since keys can repeat). An entry sync
   * stops at the first message entry not listed here, so a sync never commits an entry before
   * the events that precede it (pi may have moved on while the sync was queued).
   */
  private readonly unsyncedMessages = new Map<string, number>();
  /** Last assistant message of the current run (for the finished / failed triggers). */
  private runAssistant: AssistantMessage | undefined;

  constructor(agent: PipelineAgent, opts: PipelineOptions = {}) {
    this.agent = agent;
    this.opts = opts;
    this.log = new EventLog(opts.eventLogCapacity);
    this.caches = {
      agent: agent.info(),
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

  /** Synchronous publish: seq, live state, caches, log, fan-out. */
  publish(event: ServerEvent): void {
    this.live = reduceLive(this.live, event);
    this.caches = applyServerEventToCaches(this.caches, event);
    this.agent.state = this.caches.state;
    if (event.type === "transcript_reset") this.unsyncedMessages.clear();
    this.log.append(event);
  }

  private publishAll(events: readonly ServerEvent[]): void {
    for (const event of events) this.publish(event);
  }

  /** Publishes the agent's current info as `agent_status`. */
  publishStatus(): void {
    const info = this.agent.info();
    this.publish({ type: "agent_status", agent: info });
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

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Publishes the initial status and queues initialization (state, transcript, stats → ready). */
  start(): void {
    this.publishStatus();
    void this.enqueue(() => this.initialize());
  }

  private async initialize(): Promise<void> {
    const host = this.agent.host;
    try {
      const state = await host.send<RpcSessionState>({ type: "get_state" });
      const transcript = await host.send<Transcript>({ type: "get_entries" });
      const stats = await host
        .send<SessionStats>({ type: "get_session_stats" })
        .catch(() => undefined);
      if (this.agent.status !== "starting") return;
      this.publish({ type: "transcript_reset", transcript, state });
      if (stats !== undefined) this.publish({ type: "stats", stats });
      this.setStatus("ready");
    } catch (e) {
      this.warnUnlessExited("initialization", e);
    }
  }

  /** pi exited (`agent.status` is already `exited`): drop dialogs, publish the status. */
  onExit(): void {
    void this.enqueue(() => {
      for (const dialog of [...this.live.dialogs]) {
        clearTimeout(this.dialogTimers.get(dialog.request.id));
        this.dialogTimers.delete(dialog.request.id);
        this.publish({ type: "ui_resolved", id: dialog.request.id });
      }
      if (this.agent.attention === "input") this.agent.attention = "none";
      this.publishStatus();
    });
  }

  /** The agent was removed: stop timers and end event streams. */
  dispose(): void {
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
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
      case "turn_end":
        events.push(...(await this.fetchStats()));
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

  private onRunSettled(): void {
    const message = this.runAssistant;
    this.runAssistant = undefined;
    if (message === undefined) return;
    const reason = effectiveStopReason(message);
    if (reason === "aborted") return;
    const kind = reason === "error" ? "failed" : "finished";
    if (this.agent.attention !== "input") this.setAttention(kind);
    this.opts.onTrigger?.({ kind, agentId: this.agent.id, message });
  }

  onUiRequest(request: RpcExtensionUIRequest): void {
    const receivedAt = Date.now();
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
        if (!isCancelled(data)) this.publishAll(await this.resetSession());
        return;
      }
      const events = await this.syncEntries();
      if (STATE_MUTATING_COMMANDS.has(type)) events.push(...(await this.fetchState()));
      this.publishAll(events);
    });
  }

  /**
   * Sends an RPC `bash` without waiting for it: output streams as `bash_output`, completion as
   * `bash_done` followed by the entry sync (its `bashExecution` entry has no event). Returns
   * the command id.
   */
  startBash(command: HostCommand & { command: string }): string {
    const { id, response } = this.agent.host.request<BashResult>(command);
    this.bashCommands.set(id, command.command);
    const finish = (result: BashResult, sync: boolean) =>
      this.enqueue(async () => {
        const entries = sync ? await this.syncEntries() : [];
        this.publishAll([this.bashDone(id, result), ...entries]);
        this.bashCommands.delete(id);
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
    const command = this.bashCommands.get(id);
    return command === undefined
      ? { type: "bash_output", id, delta }
      : { type: "bash_output", id, delta, command };
  }

  private bashDone(id: string, result: BashResult): ServerEvent {
    const command = this.bashCommands.get(id);
    return command === undefined
      ? { type: "bash_done", id, result }
      : { type: "bash_done", id, result, command };
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
      const state = await this.agent.host.send<RpcSessionState>({ type: "get_state" });
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
      const state = await this.agent.host.send<RpcSessionState>({ type: "get_state" });
      return [{ type: "state", state }];
    } catch (e) {
      this.warnUnlessExited("state refresh", e);
      return [];
    }
  }

  private warnUnlessExited(what: string, e: unknown): void {
    if (isApiError(e, "agent_exited") || this.agent.host.status !== "running") return;
    console.warn(`[agent ${this.agent.id}] ${what} failed: ${(e as Error).message}`);
  }
}
