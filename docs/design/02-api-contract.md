# API contract

HTTP + Server-Sent Events between the web client and the server. All types live in `packages/protocol` and are imported by both sides. pi's own protocol types are re-exported from `@earendil-works/pi-coding-agent` (type-only imports): `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `JsonAgentSessionEvent`, `ModelInfo`, plus message and session-entry types.

Both sides share these types; the client calls the API through a small typed `fetch` wrapper. The live stream is consumed with the browser's `EventSource`, one per tab. The design behind the stream, the catalog window and attention acks is in [`05-desktop.md`](05-desktop.md).

## Conventions

- Base path `/api`. JSON bodies (`Content-Type: application/json` required on every non-GET request).
- Non-GET requests must send an `Origin` equal to the server's origin; otherwise `403 forbidden_origin`.
- Errors: HTTP status + `{ "error": { "code": string, "message": string } }`.
- Paths are absolute host paths. `~` is accepted only by `/api/fs/dirs`.

| Status | Codes |
|---|---|
| 400 | `invalid_body`, `outside_home`, `command_not_allowed`, `streaming_behavior_required`, `not_in_layout`, `not_a_worktree`, `session_not_listed`, `not_a_github_repo` |
| 403 | `forbidden_origin`, `forbidden_host` |
| 404 | `agent_not_found`, `session_not_found`, `not_a_git_repo`, `dialog_not_found`, `file_not_found`, `pr_not_found` |
| 409 | `session_owned`, `agent_exited`, `agent_busy`, `worktree_exists`, `branch_exists`, `worktree_dirty`, `pr_attached` |
| 502 | `pi_error` (pi answered `success: false`; message is pi's error), `git_failed` (message: the git command and its stderr), `gh_failed` (`gh` missing, logged out or failing) |
| 504 | `pi_timeout` (no response within 60 s; `prompt`-family commands only wait for acceptance) |

## Shared types

```ts
type AgentId = string;          // server-generated, URL-safe
type Attention = "none" | "finished" | "failed" | "input";

/** A folder's place in a `<repo>/main` layout (06-worktrees.md). */
interface RepoLayout {
  repo: string;                  // the container folder
  role: "container" | "main" | "worktree";
  main: string;                  // the main checkout, `<repo>/main` or `<repo>/master`
  missing?: true;                // worktree folder not on disk
}

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
  layout?: RepoLayout;           // absent outside a layout repo; classified at creation
}

interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage?: string;         // first user message, ≤200 chars, without leading `<file>` blocks; `#12 Title` when it starts with a `<pr>` block (10-pr-review.md), `#12 Title (guide)` with a `<pr-guide>` block (11-pr-guide.md), `/skill:name args` with an expanded skill
  createdAt: string;
  updatedAt: string;             // last entry timestamp
  lastPromptAt?: string;         // last user message's timestamp; absent before the first prompt
  parentSession?: string;
  ownedBy?: AgentId;             // open in the web UI
  layout?: RepoLayout;           // absent outside a layout repo; as of the latest scan
  missing?: true;                // the cwd is not a directory on disk, as of the latest scan
}

// A session as the live stream carries it: `ownedBy` would go stale, `updatedAt` moves on every write.
type StreamedSession = Omit<SessionSummary, "ownedBy" | "updatedAt">;

interface ProjectSummary {
  cwd: string;
  sessionCount: number;
  lastPromptAt?: string;         // the latest of its sessions'; absent when none has a prompt
  createdAt: string;             // the latest of its sessions'
  isGitRepo: boolean;
  layout?: RepoLayout;
}

interface SidebarState {
  pinned: string[];              // pinned layout repos (container paths)
  collapsed: string[];           // collapsed groups: folder cwds, repo containers, worktree cwds
}

/** `SidebarState` as the server sends it. */
interface SidebarView extends SidebarState {
  mains: Record<string, string>; // pinned repo → its main checkout; absent when it doesn't resolve
}

interface GitStatus { branch: string | null; dirty: boolean }

/** A conversation's GitHub PR, pinned to two commits (10-pr-review.md). */
interface PrAttachment {
  repo: string;                  // owner/name of the folder's origin
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  baseRefName: string;
  headRefName: string;
  baseSha: string;               // pinned base: merge-base(origin's <base> as fetched, head), or for merged PRs merge-base(GitHub's base, head)
  headSha: string;               // pinned head
  remoteHeadSha: string;         // origin's head as last polled; ≠ headSha: Outdated
}

type PrAttachments = Record<string, PrAttachment>;  // session file → PR

interface GitFileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  patch?: string;                // unified diff; absent when binary or >1 MB
  binary: boolean;
  tooLarge: boolean;
  worktreeChanged?: true;        // branch mode without uncommitted: the working tree differs from HEAD
}

type Transcript = { entries: SessionEntry[]; leafId: string | null };  // SessionEntry from pi

type SessionStats = /* pi get_session_stats data */;
type BashResult = /* pi bash response data */;
```

## Health

### `GET /api/health`
→ `200 { ok: true, piVersion: string }`.

## Catalog

Listings are ordered by the last user prompt: prompted entries first, newest prompt first, then the never-prompted ones, newest created first ([`05-desktop.md`](05-desktop.md), "Ordering").

### `GET /api/projects`
→ `200 { projects: ProjectSummary[] }`, most recently prompted first.

### `GET /api/sessions?cwd=<abs path>&q=<text>`
Both optional. `cwd` keeps the sessions whose header `cwd` equals it; `q` keeps those whose `cwd` path or `name` contains it, case-insensitively. Without either, all sessions across projects.
→ `200 { sessions: SessionSummary[] }`, most recently prompted first.

### `GET /api/fs/dirs?prefix=<path>`
Directory autocomplete under `$HOME`. `prefix` may start with `~`.
→ `200 { dirs: { path: string; isGitRepo: boolean; hasSessions: boolean }[] }` (≤50).
`400 outside_home` if the prefix resolves outside `$HOME`.

### `DELETE /api/sessions`
Deletes one session ([`08-delete-sessions.md`](08-delete-sessions.md)): closes every agent, exited ones included, whose `sessionFile` is the file's realpath, then moves the file to the Trash (else unlinks it) if the catalog lists it (`<agentDir>/sessions/<dir>/*.jsonl` with a session header).
```ts
interface DeleteSessionBody {
  file: string;      // absolute
}
```
→ `204`, also when the file doesn't exist (already deleted, or a new conversation pi hasn't written yet). Errors: `400 invalid_body` (`file` missing, empty or not absolute), `400 session_not_listed` (the file exists but isn't a listed session; it is kept, and the message says when an agent was stopped), `500 internal` naming a file that couldn't be deleted.

## Sidebar

### `PATCH /api/sidebar`
Sets pins and collapsed groups ([`05-desktop.md`](05-desktop.md), "Sidebar state"), path by path; paths not in the body keep their flag, so the request is idempotent.
```ts
interface SidebarPatch {
  pinned?: Record<string, boolean>;     // absolute path → pinned
  collapsed?: Record<string, boolean>;  // absolute path → collapsed
}
```
→ `200 { sidebar: SidebarView }`, the state after the change; a path whose directory doesn't exist is not added. Every change also goes to every stream as a `sidebar` frame. `400 invalid_body` for another shape, a relative path or a non-boolean flag.

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

→ `201 | 200 { agent: AgentInfo }`, returned immediately (`status: "awaiting_trust"` or `"starting"`); the client fetches the snapshot and opens the agent on the stream right away. If the owning agent has exited, it is restarted and returned (same id, `200`).

A session file must be an absolute path to an existing `.jsonl` file whose realpath is inside `$HOME` or pi's sessions dir (`<agentDir>/sessions`). `400 invalid_body` (not absolute), `400 outside_home`, `404 session_not_found`.

### `POST /api/agents/:id/trust`
Answer the project-trust prompt of an `awaiting_trust` agent; the server then spawns pi, which saves the decision to pi's `trust.json`.
```ts
type TrustBody = { trusted: boolean };
```
→ `200 { agent: AgentInfo }`. `409 agent_busy` if the agent isn't awaiting trust.

### `DELETE /api/agents/:id`
Stop: stops the pi process and releases the session, which stays listed. → `204`.

### `POST /api/agents/:id/restart`
Only for `status: "exited"`. Respawns with the last session file. → `200 { agent: AgentInfo }`.

### `GET /api/agents/:id/snapshot`
Full state for (re)hydration. No side effects: fetching it leaves `attention` as it is.
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
Sets attention to `none`, except `input` while the agent has a pending dialog or trust prompt, which stays. The web client calls it for the conversation on screen ([`05-desktop.md`](05-desktop.md), "Live registry"). → `204`.

`input` attention clears when the agent's last pending dialog is resolved (answered or timed out), when the trust prompt is answered, and when pi exits.

## Live stream — `GET /api/stream`

`text/event-stream`, one per tab. It carries every agent's info and the session catalog, plus the events of each agent the request **opens**.

```
GET /api/stream?open=<agentId>:<seq>,<agentId>:<seq>
```

- `open` (optional): the opened agents, each with the last `seq` the client holds (from its snapshot or the last applied event). Without it, only `baseline` and the frames every connection gets (`agent`, `agent_closed`, `catalog`, `branch`, `sidebar`, `prs`, `guide`). Pairs without `:` or without an id are ignored, and so are ids of unknown agents.
- `Last-Event-ID`: the same `agentId:seq,…` format (EventSource sends the last `id:` on reconnect). `open` decides which agents are streamed; for each, a cursor from `Last-Event-ID` wins over the query's. Header cursors for agents not in `open` are ignored.
- Per agent, a cursor replays the events after it when it is a non-negative integer, not ahead of the agent's log, and its successor is still in the log's ring buffer (a caught-up cursor replays nothing). Otherwise that agent gets a `resync` frame and streams live from the log's current `seq`; the other agents are unaffected.

The response waits for the first catalog scan and the sidebar state load after startup. Then it writes `retry: 2000`, the `baseline` frame, per opened agent (in `open` order) its replayed `event` frames or its `resync`, then live frames. Replay and subscription happen in one synchronous block, so no event falls between them. Every 15 s a named `ping` event (`event: ping`, `data: {}`, no `id:`) lets clients detect a dead stream; it is not a frame and isn't replayed. A connection with 20,000 live frames queued (a stalled socket; replay isn't counted) is ended, and the client reconnects.

Every frame is a default (`message`) event with `data: <StreamFrame JSON>` and `id: <CursorList>`: the `agentId:seq` pair of every opened agent whose position is established, in `open` order, as of that frame, so the last received `id:` is a complete resume point. A resyncing agent joins the list with its `resync` frame (at the log's `seq`); an agent whose log closes (the agent was removed) leaves it, and its events stop.

```ts
/** `agentId:seq` pairs joined by `,` — the `open` query value and every SSE `id:`. */
type CursorList = string;

type StreamFrame =
  | { type: "baseline"; agents: AgentInfo[]; sessions: StreamedSession[]; branches: Record<string, string>; sidebar: SidebarView; prs: PrAttachments }
  | { type: "event"; agentId: AgentId; seq: number; event: ServerEvent } // opened agents only
  | { type: "resync"; agentId: AgentId }                  // the cursor can't be replayed: refetch the snapshot
  | { type: "agent"; agent: AgentInfo }                   // any agent's info changed (or a new agent)
  | { type: "agent_closed"; agentId: AgentId }
  | { type: "catalog"; sessions: StreamedSession[] }      // every session; replaces the previous list
  | { type: "branch"; cwd: string; branch: string | null } // null: no longer tracked
  | { type: "sidebar"; sidebar: SidebarView }             // replaces the previous state
  | { type: "prs"; prs: PrAttachments }                   // replaces the previous attachments
  | { type: "guide"; key: string; state: "generating" | "ready" | "failed" }; // a PR guide's state changed
```

- `baseline.agents`: every agent the server holds, exited included (`GET /api/agents`). `baseline.sessions` and `catalog.sessions`: every session, most recently prompted first, without `ownedBy` (clients match agents by `sessionFile`) or `updatedAt`. `baseline.branches`: cwd → branch for folders with a live agent inside a git work tree. `baseline.sidebar`: the sidebar state. `baseline.prs`: the PR attachments by session file. Every `SidebarView` the server sends resolves `mains` (`mainCheckoutIn`) as it sends it.
- `event.seq` duplicates the agent's pair in `id:`, so clients never parse ids.
- `agent` is sent on every `AgentInfo` change: status, attention, `isStreaming`, `sessionName`, `sessionFile`, `sessionId`.
- `catalog` is sent when a rescan of pi's sessions dir (TUI sessions included), or the hourly tick, changes the streamed list (a session's `layout` and `missing` included; agent output, which moves only `updatedAt`, doesn't); `sidebar` when the sidebar state changes (`PATCH /api/sidebar`, or pruning); `prs` when the PR attachments change (attach, refresh, a poll that sees a new head, a clone, pruning); `branch` when the branch of a folder with a live agent is first read or changes, and with `null` when the folder loses its last live agent; `guide` when a PR guide's state changes (a job starts, ends or is cancelled; a key left with nothing stored or running is sent as `failed`), naming its guide key: clients refetch `GET /api/agents/:id/pr/guide` for the conversations showing that key ([`11-pr-guide.md`](11-pr-guide.md)).

## Events

The `ServerEvent`s of one agent, carried in `event` frames. `seq` is per agent and increases by one per event. `resync` is not a `ServerEvent`; it exists only as a stream frame.

Once pi is up, the initial state arrives as `transcript_reset` → `stats` → (`git_status`) → `agent_status` with `status: "ready"`.

```ts
type ServerEvent =
  | { type: "pi"; event: JsonAgentSessionEvent; receivedAt?: number } // every pi session event, verbatim; receivedAt = server clock (ms)
  | { type: "ui_request"; request: RpcExtensionUIRequest; receivedAt: number }
  | { type: "ui_resolved"; id: string }
  | { type: "entries_appended"; entries: SessionEntry[]; leafId: string | null } // new entries + pi's leaf, usually the last one; after tree navigation `entries` may be empty and `leafId` any entry
  | { type: "transcript_reset"; transcript: Transcript; state: RpcSessionState }
  | { type: "state"; state: RpcSessionState }                // after model/thinking/mode/name changes
  | { type: "stats"; stats: SessionStats }                   // after each turn_end and tree navigation
  | { type: "git_status"; status: GitStatus | null }         // after each post-turn / bash refresh, changed or not
  | { type: "curator"; toolCallId: string; url: string }     // proxied curator URL
  | { type: "bash_output"; id: string; delta: string; command?: string; excludeFromContext?: boolean } // `!` / `!!` streaming output
  | { type: "bash_done"; id: string; result: BashResult; command?: string; excludeFromContext?: boolean }
  | { type: "live_reset" }                                   // pi exited or was respawned
  | { type: "agent_status"; agent: AgentInfo };              // status / attention changes
```

- `git_status`: published after every scheduled refresh (2 s after `turn_end` and after a `bash` command) even when the status is unchanged, and at startup only when it differs. The web client refetches the review panel's diff and open file on every one.
- `bash_*`: `id` is the rpc command id; `command` is the command line sent; `excludeFromContext: true` for commands sent with `excludeFromContext` (`!!`).
- `curator`: only for pi-web-access `web_search` tools reporting a loopback curator URL (`http://localhost|127.0.0.1|[::1]:<port>/?session=<token>`).
- `live_reset`: published when pi exits (after `ui_resolved` for its pending dialogs, before the `exited` `agent_status`) and when a new pi process starts, only if there is in-flight state to drop.

## Commands — `POST /api/agents/:id/rpc`

Body: a pi `RpcCommand` without `id`. Response: `200 { data: <pi response data> }`, sent after the command's follow-up events (entry sync, `state`, `transcript_reset` + `stats` for session changes) are published.

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
- `prompt.images`: `ImageContent[]` (base64). Body limit 25 MB. pi's `prompt` has no file field: the web client inlines attached text files into `message` as leading `<file name="…" length="…">\n…\n</file>\n` blocks: pi's CLI convention plus `length` (content UTF-16 length) so a `</file>` line in the content can't end a block early. The name is escaped (`&amp;`, `&quot;`, `&lt;`, `&#10;`).
- Line references (`@path:N`, `@path:N-M`, `@"quoted path":N`, `@<sha>:./path:N`) are plain text in `message`, passed to the model verbatim. `@pi-code/protocol` exports their only parser and formatter, `findCodeRefs` and `formatCodeRef` (`code-refs.ts`; syntax in [`07-code-review.md`](07-code-review.md), "References").
- `switch_session`: `sessionPath` is validated like `POST /api/agents { sessionFile }` (`400 invalid_body | outside_home`, `404 session_not_found`) and its realpath is sent to pi; a session owned by another agent → `409 session_owned`.
- `fork`, or a `prompt` running the pi-code extension's `/pi-code-tree`, of a conversation attached to a PR → `409 pr_attached` ([`10-pr-review.md`](10-pr-review.md), "Store"); `clone` is allowed and copies the attachment.
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
→ `200 { cancelled: boolean; leafId?: string | null; seq?: number }` once the navigation's events (`entries_appended` with the new leaf, see the event list, or `transcript_reset` on a fallback; then `stats`, published even when the leaf didn't move) are published: `cancelled` when the leaf didn't move, `leafId` the resulting leaf, `seq` the agent's seq after those events, so a client can wait for its store to reach it; if the target is a user message, its text arrives as a `set_editor_text` UI request. Errors: `400 invalid_body` (malformed body, or `entryId` not in the transcript), `409 agent_busy` (streaming, or awaiting trust), `409 agent_exited`, `409 pr_attached` (the conversation is attached to a PR, see [`10-pr-review.md`](10-pr-review.md)), `500 internal` (pi lacks the pi-code extension's `pi-code-tree` command), `502 pi_error` (navigation failed; message is the extension's error).

## Worktrees

Linked worktrees of `<repo>/main` layout repos ([`06-worktrees.md`](06-worktrees.md)). Paths are canonicalized (realpath, or for a missing path its nearest existing ancestor's plus the rest) and must be inside `$HOME`, else `400 outside_home`.

### `POST /api/worktrees`
Fetches `origin`, adds the worktree `<repo>/<name>` on a new branch, and opens a conversation there.
```ts
interface CreateWorktreeBody {
  repo: string;      // the layout container, absolute
  name: string;      // folder name: one segment, no control characters, not starting with "."
  branch?: string;   // default: name; may contain "/"
  base?: string;     // default: origin/main, else origin/master
}
```
→ `201 { agent: AgentInfo }`, as `POST /api/agents { cwd }`. Errors: `400 not_in_layout` (`repo` isn't a layout container), `400 invalid_body` (body, name, branch or base invalid, or no default base), `409 worktree_exists`, `409 branch_exists`, `502 git_failed` (fetch or `worktree add`). If the conversation fails to open, the error is the open's, its message naming the created worktree.

### `DELETE /api/worktrees`
Removes a linked or missing worktree: closes the agents inside it, runs `git worktree remove` (keeping the branch) and deletes the session files whose header `cwd` is inside it (to the Trash, else unlinked).
```ts
interface RemoveWorktreeBody {
  path: string;      // absolute
  force?: boolean;   // remove despite uncommitted changes or submodules
}
```
→ `204`, also for an already pruned missing worktree. Errors: `400 not_a_worktree` (also the main checkout and the container), `409 worktree_dirty` (without `force`: uncommitted changes, untracked files or submodules; checked before any agent is closed, and returned when git refuses the plain remove), `502 git_failed`, `500 internal` naming session files that couldn't be deleted.

## Git

The review panel's routes; behavior, limits and rationale in [`07-code-review.md`](07-code-review.md). Each runs in the agent's cwd, with cwd-relative paths, and answers `404 not_a_git_repo` outside a git work tree.

### `GET /api/agents/:id/git/diff?base=<branch>&uncommitted=1` · `?pr=1`
All optional. Without `base`: the working tree against `HEAD` (the empty tree without commits), untracked files included; `uncommitted` is ignored. With `base`, a branch name, resolved to `origin/<base>` if it exists, else the local branch: the changes since `merge-base(<base>, HEAD)`, up to `HEAD`, or with `uncommitted=1` up to the working tree, untracked files included. With `pr=1` (which wins over `base`): the attached PR's pinned base to its pinned head, read from the object database, with the hunk options pinned rather than taken from the user's git config ([`10-pr-review.md`](10-pr-review.md), [`11-pr-guide.md`](11-pr-guide.md)).
```ts
interface GitDiffResponse {
  files: GitFileDiff[];
  oldRev?: string;               // short sha of the old side (HEAD, the merge-base or the PR's base); absent without commits
  newRev?: string;               // short sha of the new side when it is a commit (HEAD, the PR's head); absent for the working tree
}
```
→ `200 GitDiffResponse`. `400 invalid_body`: `base` starts with `-`, is `HEAD`, or names neither `origin/<base>` nor a local branch as written ("unknown branch <base>"), the repo has no commits, `<base>` and `HEAD` have no common commit, or `pr=1` without an attached PR. `502 git_failed`: a pinned PR commit is missing.

### `GET /api/agents/:id/git/branches`
```ts
interface GitBranchesResponse {
  branches: string[];            // local and origin branches (no origin/ prefix, once each), most recent commit first
  defaultBranch: string | null;  // origin/HEAD's branch if listed, else main, else master
}
```
→ `200 GitBranchesResponse`.

### `POST /api/agents/:id/git/fetch`
`git fetch origin`, never prompting for credentials. → `204`. `502 git_failed` with git's error: no `origin` remote, network or auth failure.

### `GET /api/agents/:id/files?q=<text>`
Fuzzy search over the cwd's tracked and untracked, non-ignored files. `q` is trimmed; empty → no results; over 200 characters → `400 invalid_body`.
→ `200 { files: string[] }` (`FileSearchResponse`), cwd-relative paths, best first (basename matches before path-only matches), at most 10.

### `GET /api/agents/:id/files/content?path=<path>&rev=<sha>`
Reads a working-tree file, or with `rev` (7–40 lowercase hex characters naming a commit) the file as committed there, read from the object database (`<rev>:./<path>`; it needn't exist on disk). `path` is cwd-relative or absolute.
```ts
interface FileContentResponse {
  path: string;                  // cwd-relative, normalized
  rev?: string;                  // as asked, when reading a commit
  content?: string;              // UTF-8; absent when binary or tooLarge
  binary: boolean;               // a NUL byte in the first 8000 bytes
  tooLarge: boolean;             // over 1 MB
}
```
→ `200 FileContentResponse`. `400 invalid_body` (missing `path`; its realpath outside the cwd's, or with `rev` the path itself; a malformed `rev`), `404 file_not_found` (missing, or not a regular file; with `rev`, no such commit or no file at that path in it).

## Pull requests

PR review ([`10-pr-review.md`](10-pr-review.md)). Attachments are keyed by the agent's session file and reach clients through `baseline.prs` and `prs` frames.

### `POST /api/agents/:id/pr`
Attaches the conversation to a PR of the folder's `origin` and sends the agent the PR's context as a prompt (steering a running agent).
```ts
interface AttachPrBody {
  pr?: string;                   // a number (`12`, `#12`) or a PR URL; absent or empty: the current branch's PR
}
interface PrResponse { pr: PrAttachment }
```
→ `200 PrResponse`. Errors: `400 invalid_body` (malformed body or argument; a PR of another repository), `400 not_a_github_repo` (no `origin`, or not on GitHub), `404 not_a_git_repo`, `404 pr_not_found` ("No PR for this branch" without a number), `409 pr_attached` (attachments are permanent), `409 agent_busy` (no session yet, awaiting trust, or the agent moved to another session while the PR was fetched), `409 agent_exited`, `502 gh_failed`, `502 git_failed`.

### `POST /api/agents/:id/pr/refresh`
Re-fetches the attached PR, re-pins its base and head, and sends the agent an update prompt (new commits, files, comments). → `200 PrResponse`. `400 invalid_body` when no PR is attached; otherwise the errors of attaching.

### `POST /api/agents/:id/pr/poll`
`git ls-remote origin refs/pull/<n>/head`; a head other than the stored `remoteHeadSha` is stored (a `prs` frame). Merged PRs and unattached conversations are skipped; failures are silent. → `204`.

Attaching, and a Refresh that moves the pinned commits, also start the conversation's PR guide, sent to the agent as a `<pr-guide>` prompt once ready ([`11-pr-guide.md`](11-pr-guide.md)).

### `GET /api/agents/:id/pr/guide`
The conversation's PR guide, with what the Guide tab needs to render each unit it references.
```ts
type PrGuideUnit = {
  path: string;
  oldPath?: string;               // renames
  status: GitFileDiff["status"];
  additions: number;              // the file's added and removed lines (0 for a file without hunks)
  deletions: number;
} & (
  | { patch: string }             // a hunk: a self-contained unified patch (its file's header lines, then the hunk)
  | { noHunks: "binary" | "tooLarge" | "noContent" }  // a file-level unit (`<path>#0`)
);
type PrGuideResponse = {
  key: string;                    // the guide key: `owner/repo#N@<baseSha>..<headSha>[:<folder>]`, as `guide` frames name it
} & (
  | { state: "generating" }
  | { state: "failed"; error: string }  // also a key with nothing stored or running (a job lost to a restart): retry
  | {
      state: "ready";
      id: string;                         // this generation of the guide; a Retry's guide gets another
      guide: PrGuide;                     // sections and other changes (11-pr-guide.md, "Guide format")
      units: Record<string, PrGuideUnit>; // every id in the guide's sections and `other`
      oldRev: string;                     // short shas of the PR diff's sides, as in GitDiffResponse
      newRev: string;
    }
);
```
→ `200 PrGuideResponse`. `400 invalid_body` when no PR is attached, `409 agent_busy` when the agent has no session yet, `502 git_failed` (reading the folder of an attachment stored without one, or a pinned commit missing for a ready guide's diff).

### `POST /api/agents/:id/pr/guide/retry`
Re-reads the PR's title and description with `gh pr view` and generates the guide again, replacing a running job and the stored guide; the new guide is sent to the agents attached to it once ready. → `200 PrGuideResponse` (`generating`). `400 invalid_body` when no PR is attached, `404 pr_not_found`, `409 agent_busy` when the agent has no session yet, `502 gh_failed`, `502 git_failed` (reading the folder of an attachment stored without one).

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
    startedAt?: number;                            // receivedAt of agent_start
  };
  streaming?: {                                    // assistant message in flight
    timestamp?: number;                            // the message's timestamp from message_start; keys thinkingMs
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
  bash: Record<string, { command: string; output: string; done?: BashResult; excludeFromContext?: boolean }>;
  thinkingMs: Record<string, number>;              // thinking durations by `${message timestamp}:${contentIndex}`; outlives runs
}

type StreamingBlock =                              // every variant also has startedAt?, endedAt?
  | { type: "text"; text: string; done: boolean }
  | { type: "thinking"; text: string; done: boolean }
  | { type: "toolCall"; id: string; name: string; argsText: string; call?: ToolCall };

interface ToolRun {
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  partialResult?: unknown;
  result?: unknown;                                // content + details
  startedAt?: number;                              // receivedAt of tool_execution_start
  durationMs?: number;                             // tool_execution_end's durationMs, else its receivedAt − startedAt
}

interface PendingDialog {
  request: RpcExtensionUIRequest;                  // method ∈ select|confirm|input|editor
  receivedAt: number;
  expiresAt?: number;                              // receivedAt + timeout; for the countdown
}
```

Semantics (pi's streaming rules from pi's `docs/json.md`):
- `*_delta` appends to the block at `contentIndex`; `*_end` replaces it with the authoritative content; `message_end(assistant)` clears `streaming`.
- `entries_appended` clears `pendingUser` and removes tools whose results are now committed. One from tree navigation (its `leafId` isn't the last appended entry, or it carries a `branch_summary`) also clears a settled run's `lastError`, finished tools and finished bash runs, which belong to the branch being left.
- `transcript_reset` clears `streaming`, `pendingUser`, a settled run's `lastError`, finished tools and finished bash runs.
- `agent_settled` (and `agent_status` exited) sets `run.active = false`, clears `streaming`, `retry` and `compaction`.
- `live_reset` does the same and also clears `pendingUser`, `tools`, `curator`, `queue`, `dialogs` and `bash`; extension UI (`statuses`, `widgets`, `title`, `editorText`, `notices`), `run.lastError` and `thinkingMs` stay.
- `ui_request` with a fire-and-forget method updates `statuses` / `widgets` / `title` / `editorText` / `notices`; dialog methods append to `dialogs`; `ui_resolved` removes one (the server publishes it on answer and on timeout).
- **Timing** comes from each event's `receivedAt` (the server's clock), so snapshots carry it and a reload mid-run keeps it; without `receivedAt` the fields stay absent. A block gets `startedAt` when it is created (its `*_start`, or the delta that creates it) and `endedAt` at its `*_end`; a tool run gets `startedAt` at `tool_execution_start` and `durationMs` at `tool_execution_end`; `run.startedAt` is set at `agent_start` and dropped on settling. At `thinking_end`, `endedAt − startedAt` goes into `thinkingMs` under the streaming message's `timestamp` and the block's `contentIndex`, so a committed thinking block finds its duration by its message's `timestamp` and its index in `content`. Settling, `live_reset` and `transcript_reset` keep `thinkingMs`, which lives as long as the agent's live state on the server. Details in [`09-ui-overhaul.md`](09-ui-overhaul.md), "Protocol: timing in `reduceLive`".
- The reducer is pure and deterministic; server and client run the same code.
