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

/** A folder's place in a `<repo>/main` layout (`docs/design/06-worktrees.md`). */
export interface RepoLayout {
  /** The container folder. */
  repo: string;
  role: "container" | "main" | "worktree";
  /** The main checkout (`<repo>/main` or `<repo>/master`). */
  main: string;
  /** The worktree folder is not on disk. */
  missing?: true;
}

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
  /** Absent outside a layout repo. */
  layout?: RepoLayout;
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
  /** Timestamp of the last user message; absent before the first prompt. */
  lastPromptAt?: string;
  parentSession?: string;
  /** Agent that has this session open in the web UI. */
  ownedBy?: AgentId;
  /** Absent outside a layout repo. */
  layout?: RepoLayout;
  /** The cwd is not a directory on disk, as of the latest scan. */
  missing?: true;
}

/**
 * A session as the live stream carries it: without `ownedBy` (it would go stale; clients match
 * agents by `sessionFile`) or `updatedAt` (it moves on every write, which would send a `catalog`
 * frame for nothing a client shows).
 */
export type StreamedSession = Omit<SessionSummary, "ownedBy" | "updatedAt">;

export interface ProjectSummary {
  cwd: string;
  sessionCount: number;
  /** The latest `lastPromptAt` of its sessions; absent when none has a prompt. */
  lastPromptAt?: string;
  /** The latest `createdAt` of its sessions. */
  createdAt: string;
  isGitRepo: boolean;
  /** Absent outside a layout repo. */
  layout?: RepoLayout;
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
  /** Branch mode without uncommitted changes: the working-tree copy differs from `HEAD`. */
  worktreeChanged?: true;
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
// Sidebar

/** The sidebar's pins and collapsed groups, kept on the server and shared by every client. */
export interface SidebarState {
  /** Pinned layout repos (their container paths). */
  pinned: string[];
  /** Collapsed groups: folder cwds, repo containers and worktree cwds. */
  collapsed: string[];
}

/** `PATCH /api/sidebar`: path → whether it is pinned / collapsed; other paths are unchanged. */
export type SidebarPatch = { [K in keyof SidebarState]?: Record<string, boolean> };

/** `SidebarState` as the server sends it. */
export interface SidebarView extends SidebarState {
  /** Pinned repo (container path) → its main checkout; absent when it no longer resolves. */
  mains: Record<string, string>;
}

export interface SidebarResponse {
  sidebar: SidebarView;
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
// Events — carried in `GET /api/stream` `event` frames

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
   * `!` / `!!` streaming output. `id` is the rpc command id. The server includes the
   * `command` it sent, and `excludeFromContext: true` for `!!` commands.
   */
  | {
      type: "bash_output";
      id: string;
      delta: string;
      command?: string;
      excludeFromContext?: boolean;
    }
  | {
      type: "bash_done";
      id: string;
      result: BashResult;
      command?: string;
      excludeFromContext?: boolean;
    }
  /**
   * The pi process exited or was replaced: everything it had in flight (run, streaming
   * message, pending user message, tools, curators, queue, dialogs, bash runs) is dropped.
   */
  | { type: "live_reset" }
  /** Agent status / attention changes. */
  | { type: "agent_status"; agent: AgentInfo };

export type ServerEventType = ServerEvent["type"];

/** An event with its per-agent sequence number (SSE `id`). */
export interface SequencedEvent {
  seq: number;
  event: ServerEvent;
}

// ---------------------------------------------------------------------------
// Live stream — `GET /api/stream` (`docs/design/05-desktop.md`)

/** `agentId:seq` pairs joined by `,` — the `open` query value and every SSE `id:`. */
export type CursorList = string;

export type StreamFrame =
  | {
      type: "baseline";
      agents: AgentInfo[];
      /** Every session, most recently prompted first. */
      sessions: StreamedSession[];
      /** cwd → branch, for folders with a live agent inside a git work tree. */
      branches: Record<string, string>;
      sidebar: SidebarView;
    }
  /** An opened agent's event; `seq` duplicates its pair in the SSE `id:`. */
  | { type: "event"; agentId: AgentId; seq: number; event: ServerEvent }
  /** The agent's cursor can't be replayed: refetch its snapshot. */
  | { type: "resync"; agentId: AgentId }
  /** Any agent's info changed (or a new agent). */
  | { type: "agent"; agent: AgentInfo }
  | { type: "agent_closed"; agentId: AgentId }
  /** Every session, as in `baseline`; replaces the previous list. */
  | { type: "catalog"; sessions: StreamedSession[] }
  /** The sidebar state changed; replaces the previous one. */
  | { type: "sidebar"; sidebar: SidebarView }
  /** `null`: the folder stopped being tracked (no live agent left) after reporting a branch. */
  | { type: "branch"; cwd: string; branch: string | null };

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
  /** Short sha of the old side (`HEAD` or the merge-base); absent without commits. */
  oldRev?: string;
  /** Short sha of `HEAD` when it is the new side; absent when the new side is the working tree. */
  newRev?: string;
}

export interface GitBranchesResponse {
  /** Local and `origin` branches (without `origin/`, once each), most recent commit first. */
  branches: string[];
  defaultBranch: string | null;
}

export interface FileSearchResponse {
  /** Cwd-relative paths, best match first, at most 10. */
  files: string[];
}

export interface FileContentResponse {
  /** Cwd-relative, normalized. */
  path: string;
  /** Absent when binary or too large. */
  content?: string;
  binary: boolean;
  tooLarge: boolean;
}

export interface GitStatusResponse {
  status: GitStatus | null;
}

// ---------------------------------------------------------------------------
// Worktrees

/** `POST /api/worktrees`: creates `<repo>/<name>` and opens an agent there (`AgentResponse`). */
export interface CreateWorktreeBody {
  /** The layout container, absolute. */
  repo: string;
  /** Folder name: one segment. */
  name: string;
  /** Default: `name`; may contain `/`. */
  branch?: string;
  /** Default: `origin/main`, else `origin/master`. */
  base?: string;
}

/** `DELETE /api/worktrees`. */
export interface RemoveWorktreeBody {
  path: string;
  /** Remove despite uncommitted changes or submodules. */
  force?: boolean;
}

/** `DELETE /api/sessions`. */
export interface DeleteSessionBody {
  /** Absolute path of the session file. */
  file: string;
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
