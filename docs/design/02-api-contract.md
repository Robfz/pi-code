# API contract

HTTP + Server-Sent Events between the web client and the server. All types live in `packages/protocol` and are imported by both sides. pi's own protocol types are re-exported from `@earendil-works/pi-coding-agent` (type-only imports): `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `JsonAgentSessionEvent`, `ModelInfo`, plus message and session-entry types.

The server uses Hono's typed routes; the client uses Hono's `hc` client for request/response typing. SSE is consumed with the browser's `EventSource`.

## Conventions

- Base path `/api`. JSON bodies (`Content-Type: application/json` required on every non-GET request).
- Non-GET requests must send an `Origin` equal to the server's origin; otherwise `403 forbidden_origin`.
- Errors: HTTP status + `{ "error": { "code": string, "message": string } }`.
- Paths are absolute host paths. `~` is accepted only by `/api/fs/dirs`.

| Status | Codes |
|---|---|
| 400 | `invalid_body`, `outside_home`, `command_not_allowed`, `streaming_behavior_required` |
| 403 | `forbidden_origin`, `forbidden_host` |
| 404 | `agent_not_found`, `session_not_found`, `not_a_git_repo`, `dialog_not_found` |
| 409 | `session_owned`, `agent_exited`, `agent_busy` |
| 502 | `pi_error` (pi answered `success: false`; message is pi's error) |
| 504 | `pi_timeout` (no response within 60 s; `prompt`-family commands only wait for acceptance) |

## Shared types

```ts
type AgentId = string;          // server-generated, URL-safe
type Attention = "none" | "finished" | "failed" | "input";

interface AgentInfo {
  id: AgentId;
  cwd: string;
  status: "awaiting_trust" | "starting" | "ready" | "exited";
  trustPrompt?: { cwd: string };  // when awaiting_trust
  exitCode?: number;
  stderrTail?: string[];         // only when exited
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming: boolean;
  attention: Attention;
  startedAt: string;             // ISO 8601
}

interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage?: string;         // first user message, ≤200 chars
  createdAt: string;
  updatedAt: string;             // last entry timestamp
  parentSession?: string;
  ownedBy?: AgentId;             // open in the web UI
}

interface ProjectSummary {
  cwd: string;
  sessionCount: number;
  updatedAt: string;
  isGitRepo: boolean;
}

interface GitStatus { branch: string | null; dirty: boolean }

interface GitFileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  patch?: string;                // unified diff; absent when binary or >1 MB
  binary: boolean;
  tooLarge: boolean;
}

type Transcript = { entries: SessionEntry[]; leafId: string | null };  // SessionEntry from pi

type SessionStats = /* pi get_session_stats data */;
type BashResult = /* pi bash response data */;
```

## Health

### `GET /api/health`
→ `200 { ok: true, piVersion: string }`.

## Catalog

### `GET /api/projects`
→ `200 { projects: ProjectSummary[] }`, most recent first.

### `GET /api/sessions?cwd=<abs path>`
`cwd` optional; without it, all sessions across projects.
→ `200 { sessions: SessionSummary[] }`, most recent first.

### `GET /api/fs/dirs?prefix=<path>`
Directory autocomplete under `$HOME`. `prefix` may start with `~`.
→ `200 { dirs: { path: string; isGitRepo: boolean; hasSessions: boolean }[] }` (≤50).
`400 outside_home` if the prefix resolves outside `$HOME`.

## Agents

### `GET /api/agents`
→ `200 { agents: AgentInfo[] }`.

### `POST /api/agents`
Open a conversation.
```ts
type OpenAgentBody = { cwd: string } | { sessionFile: string };
```
- `{ cwd }` → new agent with a new session in that directory.
- `{ sessionFile }` → resume. If the session is already open, returns the existing agent with `200`; otherwise `201`.

→ `201 | 200 { agent: AgentInfo }`, returned immediately (`status: "awaiting_trust"` or `"starting"`); the client connects to snapshot/SSE right away. `400 outside_home`, `404 session_not_found`.

### `POST /api/agents/:id/trust`
Answer the project-trust prompt of an `awaiting_trust` agent; the server then spawns pi, which saves the decision to pi's `trust.json`.
```ts
type TrustBody = { trusted: boolean };
```
→ `200 { agent: AgentInfo }`. `409 agent_busy` if the agent isn't awaiting trust.

### `DELETE /api/agents/:id`
Close: stops the pi process and releases the session. → `204`.

### `POST /api/agents/:id/restart`
Only for `status: "exited"`. Respawns with the last session file. → `200 { agent: AgentInfo }`.

### `GET /api/agents/:id/snapshot`
Full state for (re)hydration. Also clears the agent's attention.
```ts
interface Snapshot {
  agent: AgentInfo;
  state: RpcSessionState | null; // pi get_state; null while starting
  transcript: Transcript;
  live: LiveState;               // see "Live state"
  stats: SessionStats | null;    // pi get_session_stats data; null while starting
  gitStatus: GitStatus | null;
  seq: number;                   // last event included
}
```
→ `200 Snapshot`.

### `POST /api/agents/:id/ack`
Clears attention (client calls it when the conversation becomes visible). → `204`.

## Events — `GET /api/agents/:id/events`

`text/event-stream`. Each event: `id: <seq>` and `data: <ServerEvent JSON>`. `retry: 2000`. A `: ping` comment every 15 s.

Resume: send `Last-Event-ID` (EventSource does this automatically on reconnect) or `?since=<seq>` on first connect after a snapshot. If the server can't replay from there, the first event is `resync`.

```ts
type ServerEvent =
  | { type: "pi"; event: JsonAgentSessionEvent }            // every pi session event, verbatim
  | { type: "ui_request"; request: RpcExtensionUIRequest; receivedAt: number }
  | { type: "ui_resolved"; id: string }
  | { type: "entries_appended"; entries: SessionEntry[]; leafId: string | null }
  | { type: "transcript_reset"; transcript: Transcript; state: RpcSessionState }
  | { type: "state"; state: RpcSessionState }                // after model/thinking/mode/name changes
  | { type: "stats"; stats: SessionStats }                   // after each turn_end
  | { type: "git_status"; status: GitStatus | null }
  | { type: "curator"; toolCallId: string; url: string }     // proxied curator URL
  | { type: "bash_output"; id: string; delta: string }       // `!` / `!!` streaming output
  | { type: "bash_done"; id: string; result: BashResult }
  | { type: "agent_status"; agent: AgentInfo }               // status / attention changes
  | { type: "resync" };
```

## Commands — `POST /api/agents/:id/rpc`

Body: a pi `RpcCommand` without `id`. Response: `200 { data: <pi response data> }`.

Allowlist:

| Group | Commands |
|---|---|
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `clear_queue` |
| Models | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` |
| Queue modes | `set_steering_mode`, `set_follow_up_mode` |
| Compaction / retry | `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry` |
| Bash | `bash`, `abort_bash` |
| Session | `new_session`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `set_session_name` |
| Queries | `get_state`, `get_messages`, `get_entries`, `get_tree`, `get_session_stats`, `get_last_assistant_text`, `get_commands` |

Rules:
- `prompt` while `isStreaming` requires `streamingBehavior: "steer" | "followUp"` → else `400 streaming_behavior_required`.
- `prompt.images`: `ImageContent[]` (base64). Body limit 25 MB.
- `switch_session` to a session owned by another agent → `409 session_owned`.
- `bash` returns `202 { data: { id } }` immediately; output streams as `bash_output` events and completion arrives as `bash_done`. Its `bashExecution` entry is committed like any other entry.
- Commands on an `exited` agent → `409 agent_exited`.


## Dialog answers — `POST /api/agents/:id/ui-responses`

```ts
type UiResponseBody =
  | { id: string; value: string }        // select, input, editor
  | { id: string; confirmed: boolean }   // confirm
  | { id: string; cancelled: true };
```
→ `204`. `404 dialog_not_found` if the dialog is no longer pending (answered elsewhere or timed out).

## Tree navigation — `POST /api/agents/:id/tree/navigate`

In-place move within the session tree (TUI `/tree`), via the pi-code extension.
```ts
interface NavigateBody {
  entryId: string;
  summarize: boolean;              // summarize the branch being left
  customInstructions?: string;     // for the summary
}
```
→ `200 { cancelled: boolean }`. `409 agent_busy` while streaming. The new transcript arrives as `transcript_reset`; if the target is a user message, its text arrives as a `set_editor_text` UI request.

## Git

### `GET /api/agents/:id/git/diff`
→ `200 { files: GitFileDiff[] }`. `404 not_a_git_repo`.

### `GET /api/agents/:id/git/status`
→ `200 { status: GitStatus | null }` (`null` outside a repo).

## Push

### `GET /api/push/vapid-key` → `200 { publicKey: string }`
### `POST /api/push/subscriptions`
Body: the browser's `PushSubscriptionJSON`. → `204`.
### `DELETE /api/push/subscriptions`
Body: `{ endpoint: string }`. → `204`.

Push payload (JSON, delivered to the service worker):
```ts
interface PushPayload {
  kind: "finished" | "failed" | "input";
  agentId: AgentId;
  title: string;
  body: string;
  badge: number;                  // agents needing attention
  url: string;                    // "/agents/<id>"
}
```

## Live state (shared reducer)

`packages/protocol` exports:

```ts
function initialLiveState(): LiveState;
function reduceLive(state: LiveState, event: ServerEvent): LiveState;

interface LiveState {
  run: {
    active: boolean;                               // agent_start … agent_settled
    compaction?: { reason: "manual" | "threshold" | "overflow" };
    retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAt: number };
    lastError?: string;
  };
  streaming?: {                                    // assistant message in flight
    blocks: Record<number, StreamingBlock>;        // keyed by contentIndex
  };
  pendingUser?: UserMessage;                       // message_start(user) not yet committed
  tools: Record<string, ToolRun>;                  // keyed by toolCallId
  curator: Record<string, string>;                 // toolCallId → proxied URL
  queue: { steering: string[]; followUp: string[] };
  dialogs: PendingDialog[];                        // select | confirm | input | editor
  statuses: Record<string, string>;                // setStatus
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title?: string;                                  // setTitle
  editorText?: { text: string; nonce: number };    // set_editor_text
  notices: { id: string; message: string; kind: "info" | "warning" | "error"; at: number }[]; // last 20 notify
  bash: Record<string, { command: string; output: string; done?: BashResult }>;
}

type StreamingBlock =
  | { type: "text"; text: string; done: boolean }
  | { type: "thinking"; text: string; done: boolean }
  | { type: "toolCall"; id: string; name: string; argsText: string; call?: ToolCall };

interface ToolRun {
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  partialResult?: unknown;
  result?: unknown;                                // content + details
}

interface PendingDialog {
  request: RpcExtensionUIRequest;                  // method ∈ select|confirm|input|editor
  receivedAt: number;
  expiresAt?: number;                              // receivedAt + timeout; for the countdown
}
```

Semantics (pi's streaming rules from pi's `docs/json.md`):
- `*_delta` appends to the block at `contentIndex`; `*_end` replaces it with the authoritative content; `message_end(assistant)` clears `streaming`.
- `entries_appended` clears `pendingUser` and removes tools whose results are now committed.
- `transcript_reset` clears `streaming`, `pendingUser` and finished tools.
- `agent_settled` sets `run.active = false`, clears `retry` and `compaction`.
- `ui_request` with a fire-and-forget method updates `statuses` / `widgets` / `title` / `editorText` / `notices`; dialog methods append to `dialogs`; `ui_resolved` removes one (the server publishes it on answer and on timeout).
- The reducer is pure and deterministic; server and client run the same code.
