/**
 * HTTP + SSE contract between the web client and the server
 * (`docs/design/02-api-contract.md`).
 */

import type { LiveState } from "./live.ts";
import type {
  BashResult,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
  SessionEntry,
  SessionStats,
} from "./pi-types.ts";

// ---------------------------------------------------------------------------
// Shared types

/** Server-generated, URL-safe agent id. */
export type AgentId = string;

export type Attention = "none" | "finished" | "failed" | "input";

export type AgentStatus = "awaiting_trust" | "starting" | "ready" | "exited";

export interface AgentInfo {
  id: AgentId;
  cwd: string;
  status: AgentStatus;
  /** Present while `status` is `awaiting_trust`. */
  trustPrompt?: { cwd: string };
  exitCode?: number;
  /** Only when exited. */
  stderrTail?: string[];
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming: boolean;
  attention: Attention;
  /** ISO 8601. */
  startedAt: string;
}

export interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  name?: string;
  /** First user message, ≤200 chars. */
  firstMessage?: string;
  createdAt: string;
  /** Last entry timestamp. */
  updatedAt: string;
  parentSession?: string;
  /** Agent that has this session open in the web UI. */
  ownedBy?: AgentId;
}

export interface ProjectSummary {
  cwd: string;
  sessionCount: number;
  updatedAt: string;
  isGitRepo: boolean;
}

export interface GitStatus {
  branch: string | null;
  dirty: boolean;
}

export interface GitFileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Unified diff; absent when binary or >1 MB. */
  patch?: string;
  binary: boolean;
  tooLarge: boolean;
}

/** Committed session entries (all branches) and the current leaf. */
export interface Transcript {
  entries: SessionEntry[];
  leafId: string | null;
}

// ---------------------------------------------------------------------------
// Health / catalog

export interface HealthResponse {
  ok: true;
  piVersion: string;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

export interface DirSuggestion {
  path: string;
  isGitRepo: boolean;
  hasSessions: boolean;
}

export interface DirsResponse {
  dirs: DirSuggestion[];
}

// ---------------------------------------------------------------------------
// Agents

export interface AgentsResponse {
  agents: AgentInfo[];
}

export interface AgentResponse {
  agent: AgentInfo;
}

/** `POST /api/agents`: new session in `cwd`, or resume `sessionFile`. */
export type OpenAgentBody = { cwd: string } | { sessionFile: string };

/** `POST /api/agents/:id/trust`. */
export interface TrustBody {
  trusted: boolean;
}

/** `GET /api/agents/:id/snapshot`. */
export interface Snapshot {
  agent: AgentInfo;
  /** pi `get_state`; null while starting. */
  state: RpcSessionState | null;
  transcript: Transcript;
  live: LiveState;
  /** pi `get_session_stats` data; null while starting. */
  stats: SessionStats | null;
  gitStatus: GitStatus | null;
  /** Last event included. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Events — `GET /api/agents/:id/events`

export type ServerEvent =
  /**
   * Every pi session event, verbatim. `receivedAt` (server clock, ms since epoch) is optional;
   * the reducer uses it for `run.retry.startedAt` on `auto_retry_start` (0 when absent).
   */
  | { type: "pi"; event: JsonAgentSessionEvent; receivedAt?: number }
  | { type: "ui_request"; request: RpcExtensionUIRequest; receivedAt: number }
  | { type: "ui_resolved"; id: string }
  | { type: "entries_appended"; entries: SessionEntry[]; leafId: string | null }
  | { type: "transcript_reset"; transcript: Transcript; state: RpcSessionState }
  /** After model / thinking / mode / name changes. */
  | { type: "state"; state: RpcSessionState }
  /** After each `turn_end`. */
  | { type: "stats"; stats: SessionStats }
  | { type: "git_status"; status: GitStatus | null }
  /** Proxied curator URL for a running tool. */
  | { type: "curator"; toolCallId: string; url: string }
  /**
   * `!` / `!!` streaming output. `id` is the rpc command id. `command` is optional so the live
   * state can show what runs; the server should include it (it knows the command it sent).
   */
  | { type: "bash_output"; id: string; delta: string; command?: string }
  | { type: "bash_done"; id: string; result: BashResult; command?: string }
  /** Agent status / attention changes. */
  | { type: "agent_status"; agent: AgentInfo }
  | { type: "resync" };

export type ServerEventType = ServerEvent["type"];

/** An event with its per-agent sequence number (SSE `id`). */
export interface SequencedEvent {
  seq: number;
  event: ServerEvent;
}

// ---------------------------------------------------------------------------
// Dialog answers / tree navigation

/** `POST /api/agents/:id/ui-responses`. */
export type UiResponseBody =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

/** `POST /api/agents/:id/tree/navigate`. */
export interface NavigateBody {
  entryId: string;
  /** Summarize the branch being left. */
  summarize: boolean;
  /** Instructions for the summary. */
  customInstructions?: string;
}

export interface NavigateResponse {
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Git

export interface GitDiffResponse {
  files: GitFileDiff[];
}

export interface GitStatusResponse {
  status: GitStatus | null;
}

// ---------------------------------------------------------------------------
// Push

export interface VapidKeyResponse {
  publicKey: string;
}

/** `DELETE /api/push/subscriptions`. */
export interface PushUnsubscribeBody {
  endpoint: string;
}

/** Payload delivered to the service worker. */
export interface PushPayload {
  kind: "finished" | "failed" | "input";
  agentId: AgentId;
  title: string;
  body: string;
  /** Agents needing attention. */
  badge: number;
  /** `/agents/<id>`. */
  url: string;
}
