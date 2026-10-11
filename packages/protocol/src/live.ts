/**
 * Live state: everything in flight and not yet committed to the session (streaming assistant
 * message, running tools, pending dialogs, extension UI, queue, compaction / retry status).
 *
 * `reduceLive` is pure and deterministic; the server (snapshots) and the client (live UI) run
 * the same code over the same `ServerEvent`s, so a snapshot at `seq` plus the events after it
 * always equals the state reduced from the start.
 *
 * Updates are immutable and structural: an event returns a new state object, but slices it
 * doesn't touch keep their identity, and events that change nothing return the input state
 * unchanged. That keeps selector-based React subscriptions from re-rendering needlessly.
 *
 * Timing fields (`startedAt`, `endedAt`, `durationMs`, `thinkingMs`) come from the events'
 * `receivedAt` (the server's clock), so snapshots carry them; without `receivedAt` they're absent.
 */

import type {
  AssistantMessage,
  BashResult,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  SessionEntry,
  StopReason,
  ToolCall,
  UserMessage,
} from "./pi-types.ts";
import type { ServerEvent } from "./types.ts";

export interface LiveRun {
  /** `agent_start` … `agent_settled`. */
  active: boolean;
  compaction?: { reason: "manual" | "threshold" | "overflow" };
  retry?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
    /** `receivedAt` of the `auto_retry_start` event (0 when the server didn't stamp it). */
    startedAt: number;
  };
  lastError?: string;
  /** `receivedAt` of `agent_start`. */
  startedAt?: number;
}

/** `startedAt` when the block is created (its `*_start` or first delta), `endedAt` at its `*_end`. */
interface BlockTiming {
  startedAt?: number;
  endedAt?: number;
}

export type StreamingBlock =
  | ({ type: "text"; text: string; done: boolean } & BlockTiming)
  | ({ type: "thinking"; text: string; done: boolean } & BlockTiming)
  | ({
      type: "toolCall";
      id: string;
      name: string;
      argsText: string;
      call?: ToolCall;
    } & BlockTiming);

export interface StreamingMessage {
  /** The assistant message's `timestamp` from `message_start`; keys `thinkingMs`. */
  timestamp?: number;
  /** Keyed by `contentIndex`. */
  blocks: Record<number, StreamingBlock>;
}

export interface ToolRun {
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  partialResult?: unknown;
  /** `{ content, details? }` from `tool_execution_end`. */
  result?: unknown;
  /** `receivedAt` of `tool_execution_start`. */
  startedAt?: number;
  /** `tool_execution_end`'s `durationMs`, else its `receivedAt` minus `startedAt`. */
  durationMs?: number;
}

export const DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type DialogMethod = (typeof DIALOG_METHODS)[number];

/** Extension UI request that waits for an answer. */
export type DialogRequest = Extract<RpcExtensionUIRequest, { method: DialogMethod }>;

export interface PendingDialog {
  request: DialogRequest;
  receivedAt: number;
  /** `receivedAt + timeout`, for the countdown. pi resolves expired dialogs without an event. */
  expiresAt?: number;
}

export interface Widget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface Notice {
  id: string;
  message: string;
  kind: "info" | "warning" | "error";
  at: number;
}

export interface BashRun {
  command: string;
  output: string;
  done?: BashResult;
  /** A `!!` command: its output stays out of the model's context. */
  excludeFromContext?: boolean;
}

export interface LiveState {
  run: LiveRun;
  /** Assistant message in flight. */
  streaming?: StreamingMessage;
  /** `message_start(user)` not yet committed. */
  pendingUser?: UserMessage;
  /** Keyed by `toolCallId`. */
  tools: Record<string, ToolRun>;
  /** `toolCallId` → proxied curator URL. */
  curator: Record<string, string>;
  queue: { steering: string[]; followUp: string[] };
  /** select | confirm | input | editor, in arrival order. */
  dialogs: PendingDialog[];
  /** `setStatus`, by status key. Texts may contain ANSI escapes. */
  statuses: Record<string, string>;
  /** `setWidget`, by widget key. */
  widgets: Record<string, Widget>;
  /** `setTitle`. */
  title?: string;
  /** `set_editor_text`; `nonce` increments on every request so repeated texts still apply. */
  editorText?: { text: string; nonce: number };
  /** Last `MAX_NOTICES` `notify` requests, oldest first. */
  notices: Notice[];
  /** RPC `bash` runs, by command id. */
  bash: Record<string, BashRun>;
  /**
   * Thinking durations by `thinkingKey(assistantMessage.timestamp, contentIndex)`, the latest
   * `MAX_THINKING_DURATIONS`. They outlive runs, so a committed thinking block can look its
   * duration up.
   */
  thinkingMs: Record<string, number>;
}

export const MAX_NOTICES = 20;
export const MAX_THINKING_DURATIONS = 500;

/** A thinking block's `thinkingMs` key: its assistant message's `timestamp` and content index. */
export function thinkingKey(timestamp: number, contentIndex: number): string {
  return `${timestamp}:${contentIndex}`;
}

export function initialLiveState(): LiveState {
  return {
    run: { active: false },
    tools: {},
    curator: {},
    queue: { steering: [], followUp: [] },
    dialogs: [],
    statuses: {},
    widgets: {},
    notices: [],
    bash: {},
    thinkingMs: {},
  };
}

export function isDialogRequest(request: RpcExtensionUIRequest): request is DialogRequest {
  return (DIALOG_METHODS as readonly string[]).includes(request.method);
}

/**
 * The stop reason as the user sees it. pi reports an abort during a running tool as an extra
 * empty assistant turn with `stopReason: "error"` and `errorMessage: "This operation was
 * aborted"`; this maps that case to `"aborted"`.
 */
export function effectiveStopReason(
  message: Pick<AssistantMessage, "stopReason" | "errorMessage">,
): StopReason {
  if (
    message.stopReason === "error" &&
    message.errorMessage !== undefined &&
    /operation was aborted/i.test(message.errorMessage)
  ) {
    return "aborted";
  }
  return message.stopReason;
}

/** Apply one server event. Unknown event types return `state` unchanged. */
export function reduceLive(state: LiveState, event: ServerEvent): LiveState {
  switch (event.type) {
    case "pi":
      return reducePi(state, event.event, event.receivedAt);
    case "ui_request":
      return reduceUiRequest(state, event.request, event.receivedAt);
    case "ui_resolved": {
      if (!state.dialogs.some((d) => d.request.id === event.id)) return state;
      return { ...state, dialogs: state.dialogs.filter((d) => d.request.id !== event.id) };
    }
    case "entries_appended":
      return reduceEntriesAppended(state, event.entries);
    case "transcript_reset":
      return reduceTranscriptReset(state);
    case "curator": {
      if (state.curator[event.toolCallId] === event.url) return state;
      return { ...state, curator: { ...state.curator, [event.toolCallId]: event.url } };
    }
    case "bash_output": {
      const prev = state.bash[event.id];
      const run: BashRun = {
        ...prev,
        command: event.command ?? prev?.command ?? "",
        output: (prev?.output ?? "") + event.delta,
      };
      const exclude = event.excludeFromContext ?? prev?.excludeFromContext;
      if (exclude !== undefined) run.excludeFromContext = exclude;
      return { ...state, bash: { ...state.bash, [event.id]: run } };
    }
    case "bash_done": {
      const prev = state.bash[event.id];
      const run: BashRun = {
        command: event.command ?? prev?.command ?? "",
        output: prev?.output ?? "",
        done: event.result,
      };
      const exclude = event.excludeFromContext ?? prev?.excludeFromContext;
      if (exclude !== undefined) run.excludeFromContext = exclude;
      return { ...state, bash: { ...state.bash, [event.id]: run } };
    }
    case "live_reset":
      return resetLive(state);
    case "agent_status":
      // pi is gone: nothing in flight will finish. Dialogs stay until `ui_resolved`.
      return event.agent.status === "exited" ? settle(state) : state;
    default:
      // state, stats, git_status, and unknown types don't touch live state.
      return state;
  }
}

/** The last `max` entries of a record, by insertion order (its keys aren't integers). */
function latest<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length > max ? Object.fromEntries(entries.slice(-max)) : record;
}

// ---------------------------------------------------------------------------
// pi session events

function reducePi(
  state: LiveState,
  event: JsonAgentSessionEvent,
  receivedAt: number | undefined,
): LiveState {
  switch (event.type) {
    case "agent_start": {
      const { lastError: _, startedAt: __, ...run } = state.run;
      return { ...state, run: { ...run, active: true, ...timing("startedAt", receivedAt) } };
    }
    case "agent_settled":
      return settle(state);

    case "message_start":
    case "message_end": {
      const message = event.message;
      if (message.role === "user") {
        // message_end only refreshes a message that is still pending, so it can't resurrect one
        // whose entry was already committed.
        if (event.type === "message_end" && state.pendingUser === undefined) return state;
        return { ...state, pendingUser: message };
      }
      if (message.role !== "assistant") return state; // system, toolResult, custom, …
      if (event.type === "message_start") {
        return { ...state, streaming: { timestamp: message.timestamp, blocks: {} } };
      }
      const { streaming: _, ...rest } = state;
      const failed =
        message.stopReason === "error" && effectiveStopReason(message) === "error"
          ? (message.errorMessage ?? "Unknown error")
          : undefined;
      return failed === undefined ? rest : { ...rest, run: { ...rest.run, lastError: failed } };
    }
    case "message_update":
      return reduceMessageUpdate(state, event.assistantMessageEvent, receivedAt);

    case "tool_execution_start":
      return setTool(state, event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
        status: "running",
        ...timing("startedAt", receivedAt),
      });
    case "tool_execution_update": {
      const prev = state.tools[event.toolCallId];
      return setTool(state, event.toolCallId, {
        toolName: event.toolName,
        args: prev?.args ?? event.args,
        status: "running",
        partialResult: event.partialResult,
        ...timing("startedAt", prev?.startedAt),
      });
    }
    case "tool_execution_end": {
      const prev = state.tools[event.toolCallId];
      const startedAt = prev?.startedAt;
      const measured =
        receivedAt !== undefined && startedAt !== undefined ? receivedAt - startedAt : undefined;
      return setTool(state, event.toolCallId, {
        toolName: event.toolName,
        args: prev?.args ?? null,
        status: event.isError ? "error" : "done",
        result: event.result,
        ...timing("startedAt", startedAt),
        ...timing("durationMs", event.durationMs ?? measured),
      });
    }

    case "queue_update":
      return {
        ...state,
        queue: { steering: [...event.steering], followUp: [...event.followUp] },
      };

    case "compaction_start": {
      // A manual /compact is a fresh user action: drop the previous run's error banner (like
      // agent_start). Automatic compactions keep it, since they follow the run that set it.
      const { lastError: _, ...rest } = state.run;
      const run = event.reason === "manual" ? rest : state.run;
      return { ...state, run: { ...run, compaction: { reason: event.reason } } };
    }
    case "compaction_end": {
      const { compaction: _, ...run } = state.run;
      const failed =
        event.errorMessage !== undefined && !event.aborted && !event.willRetry
          ? event.errorMessage
          : undefined;
      return { ...state, run: failed === undefined ? run : { ...run, lastError: failed } };
    }

    case "auto_retry_start":
      return {
        ...state,
        run: {
          ...state.run,
          retry: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorMessage: event.errorMessage,
            startedAt: receivedAt ?? 0,
          },
        },
      };
    case "auto_retry_end": {
      const { retry: _, lastError: __, ...run } = state.run;
      return {
        ...state,
        run: event.success ? run : { ...run, lastError: event.finalError ?? "Retry failed" },
      };
    }

    default:
      // turn_*, agent_end, entry_appended (synced by the server), thinking_level_changed and
      // session_info_changed (session state), bash_execution_update (arrives as bash_output),
      // summarization_retry_*, and unknown types.
      return state;
  }
}

type AssistantEvent = Extract<
  JsonAgentSessionEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

function reduceMessageUpdate(
  state: LiveState,
  event: AssistantEvent,
  receivedAt: number | undefined,
): LiveState {
  switch (event.type) {
    case "text_start":
    case "thinking_start": {
      const type = event.type === "text_start" ? "text" : "thinking";
      return setBlock(state, event.contentIndex, {
        type,
        text: "",
        done: false,
        ...timing("startedAt", receivedAt),
      });
    }
    case "text_delta":
    case "thinking_delta": {
      const type = event.type === "text_delta" ? "text" : "thinking";
      const prev = state.streaming?.blocks[event.contentIndex];
      if (prev?.type === type) {
        if (event.delta === "") return state;
        return setBlock(state, event.contentIndex, {
          type,
          text: prev.text + event.delta,
          done: false,
          ...timing("startedAt", prev.startedAt),
        });
      }
      return setBlock(state, event.contentIndex, {
        type,
        text: event.delta,
        done: false,
        ...timing("startedAt", receivedAt),
      });
    }
    case "text_end":
    case "thinking_end": {
      const type = event.type === "text_end" ? "text" : "thinking";
      const prev = state.streaming?.blocks[event.contentIndex];
      const startedAt = prev?.type === type ? prev.startedAt : undefined;
      const next = setBlock(state, event.contentIndex, {
        type,
        text: event.content,
        done: true,
        ...timing("startedAt", startedAt),
        ...timing("endedAt", receivedAt),
      });
      const timestamp = state.streaming?.timestamp;
      if (
        type !== "thinking" ||
        timestamp === undefined ||
        startedAt === undefined ||
        receivedAt === undefined
      ) {
        return next;
      }
      const key = thinkingKey(timestamp, event.contentIndex);
      const thinkingMs = { ...next.thinkingMs, [key]: receivedAt - startedAt };
      return { ...next, thinkingMs: latest(thinkingMs, MAX_THINKING_DURATIONS) };
    }
    case "toolcall_start":
      return setBlock(state, event.contentIndex, {
        type: "toolCall",
        id: event.id,
        name: event.toolName,
        argsText: "",
        ...timing("startedAt", receivedAt),
      });
    case "toolcall_delta": {
      const prev = state.streaming?.blocks[event.contentIndex];
      if (prev?.type === "toolCall") {
        if (event.delta === "") return state;
        return setBlock(state, event.contentIndex, {
          ...prev,
          argsText: prev.argsText + event.delta,
        });
      }
      return setBlock(state, event.contentIndex, {
        type: "toolCall",
        id: "",
        name: "",
        argsText: event.delta,
        ...timing("startedAt", receivedAt),
      });
    }
    case "toolcall_end": {
      const prev = state.streaming?.blocks[event.contentIndex];
      const started = prev?.type === "toolCall" ? prev : undefined;
      return setBlock(state, event.contentIndex, {
        type: "toolCall",
        id: event.toolCall.id,
        name: event.toolCall.name,
        argsText:
          started !== undefined && started.argsText !== ""
            ? started.argsText
            : JSON.stringify(event.toolCall.arguments),
        call: event.toolCall,
        ...timing("startedAt", started?.startedAt),
        ...timing("endedAt", receivedAt),
      });
    }
    default:
      // start / done / error: message_start and message_end carry the authoritative message.
      return state;
  }
}

function setBlock(state: LiveState, index: number, block: StreamingBlock): LiveState {
  const blocks = state.streaming?.blocks ?? {};
  return { ...state, streaming: { ...state.streaming, blocks: { ...blocks, [index]: block } } };
}

/** `{ [key]: value }`, or `{}` for an unknown value: timing fields are left out, not undefined. */
function timing<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: number });
}

function setTool(state: LiveState, toolCallId: string, run: ToolRun): LiveState {
  return { ...state, tools: { ...state.tools, [toolCallId]: run } };
}

/** End of a run (or of the pi process): nothing is streaming, no retry or compaction pending. */
function settle(state: LiveState): LiveState {
  const { active, compaction, retry } = state.run;
  if (!active && !compaction && !retry && state.streaming === undefined) return state;
  const { streaming: _, ...rest } = state;
  const run: LiveRun = { active: false };
  if (state.run.lastError !== undefined) run.lastError = state.run.lastError;
  return { ...rest, run };
}

/**
 * The pi process is gone or replaced: drop everything it had in flight. Extension UI (statuses,
 * widgets, title, notices, editor text) and the last run error stay.
 */
function resetLive(state: LiveState): LiveState {
  const settled = settle(state);
  const empty = (record: Record<string, unknown>) => Object.keys(record).length === 0;
  if (
    settled === state &&
    state.pendingUser === undefined &&
    empty(state.tools) &&
    empty(state.curator) &&
    empty(state.bash) &&
    state.dialogs.length === 0 &&
    state.queue.steering.length === 0 &&
    state.queue.followUp.length === 0
  ) {
    return state;
  }
  const { pendingUser: _, ...rest } = settled;
  return {
    ...rest,
    tools: {},
    curator: {},
    queue: { steering: [], followUp: [] },
    dialogs: [],
    bash: {},
  };
}

// ---------------------------------------------------------------------------
// Extension UI

function reduceUiRequest(
  state: LiveState,
  request: RpcExtensionUIRequest,
  receivedAt: number,
): LiveState {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor": {
      if (state.dialogs.some((d) => d.request.id === request.id)) return state;
      const timeout = "timeout" in request ? request.timeout : undefined;
      const dialog: PendingDialog = { request, receivedAt };
      if (timeout !== undefined && timeout > 0) dialog.expiresAt = receivedAt + timeout;
      return { ...state, dialogs: [...state.dialogs, dialog] };
    }
    case "notify": {
      const notice: Notice = {
        id: request.id,
        message: request.message,
        kind: request.notifyType ?? "info",
        at: receivedAt,
      };
      return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES) };
    }
    case "setStatus": {
      const { statusKey, statusText } = request;
      if (statusText === undefined || statusText === null) {
        if (!(statusKey in state.statuses)) return state;
        return { ...state, statuses: omitKeys(state.statuses, [statusKey]) };
      }
      if (state.statuses[statusKey] === statusText) return state;
      return { ...state, statuses: { ...state.statuses, [statusKey]: statusText } };
    }
    case "setWidget": {
      const { widgetKey, widgetLines } = request;
      if (widgetLines === undefined || widgetLines === null) {
        if (!(widgetKey in state.widgets)) return state;
        return { ...state, widgets: omitKeys(state.widgets, [widgetKey]) };
      }
      const widget: Widget = {
        lines: [...widgetLines],
        placement: request.widgetPlacement ?? "aboveEditor",
      };
      return { ...state, widgets: { ...state.widgets, [widgetKey]: widget } };
    }
    case "setTitle":
      if (state.title === request.title) return state;
      return { ...state, title: request.title };
    case "set_editor_text":
      return {
        ...state,
        editorText: { text: request.text, nonce: (state.editorText?.nonce ?? 0) + 1 },
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Transcript sync

function reduceEntriesAppended(state: LiveState, entries: readonly SessionEntry[]): LiveState {
  const toolResults = new Set<string>();
  const bashCommands = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") toolResults.add(message.toolCallId);
    else if (message.role === "bashExecution") bashCommands.add(message.command);
  }

  let next = state;
  if (next.pendingUser !== undefined) {
    const { pendingUser: _, ...rest } = next;
    next = rest;
  }
  const committedTools = Object.keys(next.tools).filter((id) => toolResults.has(id));
  if (committedTools.length > 0) next = { ...next, tools: omitKeys(next.tools, committedTools) };
  const committedCurators = Object.keys(next.curator).filter((id) => toolResults.has(id));
  if (committedCurators.length > 0) {
    next = { ...next, curator: omitKeys(next.curator, committedCurators) };
  }
  const committedBash = Object.entries(next.bash)
    .filter(
      ([, run]) => run.done !== undefined && (run.command === "" || bashCommands.has(run.command)),
    )
    .map(([id]) => id);
  if (bashCommands.size > 0 && committedBash.length > 0) {
    next = { ...next, bash: omitKeys(next.bash, committedBash) };
  }
  return next;
}

function reduceTranscriptReset(state: LiveState): LiveState {
  const { streaming: _, pendingUser: __, ...rest } = state;
  let next: LiveState = rest;
  // A settled run's error banner belongs to the transcript being replaced (session switch, fork,
  // compaction); run errors that matter are in the transcript's own assistant entries.
  if (!state.run.active && state.run.lastError !== undefined) {
    const { lastError: ___, ...run } = state.run;
    next = { ...next, run };
  }
  const finishedTools = Object.entries(state.tools)
    .filter(([, run]) => run.status !== "running")
    .map(([id]) => id);
  if (finishedTools.length > 0) next = { ...next, tools: omitKeys(next.tools, finishedTools) };
  const orphanCurators = Object.keys(next.curator).filter((id) => !(id in next.tools));
  if (orphanCurators.length > 0)
    next = { ...next, curator: omitKeys(next.curator, orphanCurators) };
  const finishedBash = Object.entries(state.bash)
    .filter(([, run]) => run.done !== undefined)
    .map(([id]) => id);
  if (finishedBash.length > 0) next = { ...next, bash: omitKeys(next.bash, finishedBash) };
  const unchanged =
    next.run === state.run &&
    next.tools === state.tools &&
    next.curator === state.curator &&
    next.bash === state.bash &&
    state.streaming === undefined &&
    state.pendingUser === undefined;
  return unchanged ? state : next;
}

function omitKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}
