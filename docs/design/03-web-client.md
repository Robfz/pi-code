# Web client design

React SPA, mobile-first, installable PWA. Source: `packages/web`.

| Concern | Choice |
|---|---|
| Build | Vite, TypeScript |
| Routing | TanStack Router (code-based route tree) |
| Server data | TanStack Query (catalog, agents, models, commands, git diff) |
| Live conversation | Zustand store fed by SSE through the shared reducer |
| UI | Tailwind v4 + shadcn/ui |
| Markdown / code | Streamdown (Shiki) |
| Diffs | `@git-diff-view/react` (unified on phones, split on wide screens) |
| PWA | `vite-plugin-pwa`, `injectManifest` strategy (custom service worker) |
| API client | Hono `hc` typed client + `EventSource` |

## Routes

| Path | Screen |
|---|---|
| `/` | Home: open agents (with attention badges), recent sessions, "New conversation" |
| `/sessions` | All sessions, filterable by project (`?cwd=`) |
| `/agents/$agentId` | Conversation |
| `/agents/$agentId/tree` | Session tree |
| `/agents/$agentId/diff` | Git diff of the project |
| `/share` | Share-target landing (`?title&text&url`) |
| `/settings` | Notifications permission, tool expansion default, about |

"New conversation" opens the **project picker**: recent projects (`GET /api/projects`) plus a path field with autocomplete (`GET /api/fs/dirs`), then `POST /api/agents { cwd }`. Opening a session from a list calls `POST /api/agents { sessionFile }` and navigates to the agent (existing agent if already open).

## Live conversation store

One Zustand store per open agent, created when the conversation route mounts:

```ts
interface ConversationStore {
  agent: AgentInfo;
  state: RpcSessionState;
  transcript: Transcript;
  live: LiveState;
  stats: SessionStats;
  gitStatus: GitStatus | null;
  seq: number;
  connection: "connecting" | "live" | "reconnecting" | "offline";
  apply(event: ServerEvent, seq: number): void;   // reduceLive + transcript/state updates
  hydrate(snapshot: Snapshot): void;
}
```

Connection lifecycle:

1. `GET /snapshot` → `hydrate`.
2. `new EventSource('/api/agents/:id/events?since=' + seq)`; each message → `apply`.
3. `resync` → close, go back to 1.
4. `visibilitychange` → visible: if the EventSource is closed, go back to 1; `POST /ack`.
5. Unmount → close the EventSource.

Components subscribe with selectors (`useStore(s => s.live.streaming)`), so token deltas only re-render the streaming message.

The **active branch** is derived from `transcript`: walk `parentId` from `leafId` to the root, reverse. Memoized on `(entries.length, leafId)`.

## Conversation screen

```
┌ header: session name · project · ⋮ (tree, diff, fork, clone, compact, rename, close) ┐
│ transcript (active branch, committed)                                               │
│ live: pending user message, streaming assistant message, running tools, bash output │
│ widgets (aboveEditor)                                                               │
│ composer                                                                            │
│ widgets (belowEditor)                                                               │
└ status bar ─────────────────────────────────────────────────────────────────────────┘
```

Dialogs render as bottom sheets over this screen.

### Transcript rendering

| Entry / role | Rendering |
|---|---|
| `user` message | Text + image thumbnails |
| `assistant` message | Text (Streamdown), thinking (collapsed, expandable), each tool call paired with its `toolResult` by `toolCallId` → tool renderer |
| `bashExecution` | Command, output (collapsed if long), exit code; muted when `excludeFromContext` (`!!`) |
| `custom` message (`display: true`) | Markdown of `content`; known `customType`s from pi-web-access / pi-mcp-adapter get small cards; others generic |
| `compactionSummary` / `compaction` | Divider "Context compacted (N tokens)", expandable summary |
| `branchSummary` | Divider "Branch summary", expandable |
| `model_change`, `thinking_level_change` | Inline muted marker |
| `label` | Badge on the target entry |
| `custom` entries (extension state), `session_info`, `usage` | Not shown |

Assistant errors (`stopReason: error`) show the error message; `aborted` shows "Stopped".

### Tool renderers

A registry keyed by `toolName`. Each renderer receives `{ args, status, partialResult, result: { content, details }, isError, expanded }`. Every tool has a collapsed one-line summary and an expanded body; a header toggle expands/collapses all (the TUI's Ctrl+O).

| Tool | Collapsed | Expanded |
|---|---|---|
| `read` | path, line range | highlighted content |
| `bash` | command, exit code | output (streams from `partialResult`) |
| `edit` | path, `+n −m` | `details.patch` in the diff viewer |
| `write` | path, line count | content (new files as an all-added diff) |
| `grep` / `find` / `ls` | pattern / path, match count | result list |
| `subagent` | mode, agents, status | progress widget from `SubagentDetails`: per-agent cards (agent, task, status, duration, usage), markdown output, nested tool calls |
| `web_search` / `source_check` | queries, result count | results with links, summary; **Review in curator** button when a `curator` event exists for the call |
| `fetch_content` / `get_search_content` | URL(s) | extracted content (markdown) |
| `mcp` and MCP namespace tools | server · tool | arguments, result content |
| anything else | tool name | arguments (JSON), text result |

### Composer

- Enter/Send: idle → `prompt`. While running, two actions: **Steer** (`streamingBehavior: "steer"`) and **Queue** (`"followUp"`). **Stop** → `abort`. **Stop & edit** → `clear_queue` then `abort`, restoring queued text into the composer.
- Queue display (from `live.queue`) above the composer.
- `!cmd` → `bash`; `!!cmd` → `bash { excludeFromContext: true }`.
- Image attach (camera or gallery, `accept="image/*"`), sent as `prompt.images`; hidden when the current model's `input` lacks `"image"`.
- `set_editor_text` UI requests replace the composer text.
- Slash autocomplete: built-in commands implemented by the client (below) + `get_commands` (extension, skill, template), excluding pi-code's own extension commands.

Built-in commands:

| Command | Action |
|---|---|
| `/new` | `new_session` |
| `/resume` | session list for this project |
| `/name <name>` | `set_session_name` |
| `/model [provider/id]` | model picker / `set_model` |
| `/thinking [level]` | thinking picker / `set_thinking_level` |
| `/compact [instructions]` | `compact` |
| `/tree` | tree screen |
| `/fork` | picker from `get_fork_messages` → `fork` |
| `/clone` | `clone` |
| `/session` | stats sheet (`get_session_stats`) |
| `/copy` | copy last assistant text |
| `/diff` | diff screen |
| `/settings`, `/login`, `/logout`, `/trust`, `/export`, `/share`, `/import`, `/reload`, `/scoped-models`, `/hotkeys`, `/quit` … | "Use the TUI for this" |

### Extension UI

| Request | Rendering |
|---|---|
| `select` | Bottom sheet, option list |
| `confirm` | Bottom sheet, message + Yes/No |
| `input` | Bottom sheet, text field |
| `editor` | Full-screen textarea, prefilled |
| `notify` | Toast (info / warning / error) |
| `setStatus` | Chip in the status bar |
| `setWidget` | Monospace block above/below the composer |
| `setTitle` | `document.title` |
| `set_editor_text` | Composer text |

Dialog titles and messages are rendered with URLs linkified and a copy button next to each URL — this is the copy-paste flow for MCP OAuth (open the URL, approve, paste the redirect URL back into the input). Dialogs with `expiresAt` show a countdown. An agent with `status: "awaiting_trust"` shows a trust sheet (project path, what trusting loads) answered with `POST /trust`.

### Status bar

Mirrors the TUI status-bar extension: folder name · git branch + dirty dot · context bar (5 cells from `stats.contextUsage.percent`) · session name · model + thinking level · cost. Extension `setStatus` chips follow. Run state (running / compacting / retrying n/m) shows as a leading indicator.

## Tree screen

`get_tree` rendered as an indented tree of user and assistant entries (tool traffic collapsed), labels as badges, the current leaf highlighted. Actions on an entry:

- **Go here** → `POST /tree/navigate` with a "summarize the branch you're leaving?" choice (and optional instructions).
- **Fork from here** (user messages) → `fork`.

Disabled while a run is active.

## Diff screen

`GET /git/diff` on open and on refresh. File list with status and `+/−` counts; tapping a file shows its patch in the diff viewer. Handles `binary`, `tooLarge`, and `not_a_git_repo`.

## PWA

**Manifest:** name "pi-code", standalone display, icons, theme colors, and

```json
"share_target": { "action": "/share", "method": "GET", "params": { "title": "title", "text": "text", "url": "url" } }
```

**Service worker** (`src/sw.ts`, injectManifest):

- Precaches the app shell; API requests always go to the network.
- `push`: parse `PushPayload`; `navigator.setAppBadge(badge)` (or `clearAppBadge` at 0); if a pi-code window is focused, don't show a notification; else `showNotification(title, { body, tag: agentId, data: { url } })`.
- `notificationclick`: focus an existing window and navigate it to `url`, else `openWindow(url)`.

**Notifications setup:** `/settings` has an "Enable notifications" button (permission must come from a user gesture) → `pushManager.subscribe` with the VAPID key → `POST /api/push/subscriptions`. The same flow works in desktop Chrome, which covers desktop notifications.

**Share target:** `/share` shows "Send to…" with open agents, recent sessions and "New conversation in…". Choosing one navigates to the conversation with the composer prefilled with `title`, `text` and `url`.

**Offline:** app shell only; a banner shows when the server is unreachable.
