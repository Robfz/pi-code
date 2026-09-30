# Web client design

React SPA, mobile-first, installable PWA, with a desktop shell at ≥1024px. Source: `packages/web`. The live registry, desktop shell, sidebar and layout are specified in [`05-desktop.md`](05-desktop.md); this document summarizes them.

| Concern | Choice |
|---|---|
| Build | Vite, TypeScript |
| Routing | TanStack Router (code-based route tree) |
| Server data | TanStack Query (catalog, session search, models, commands, git diff, health) |
| Live state | `LiveRegistry`: one `GET /api/stream` EventSource per tab feeding a Zustand overview and one Zustand store per opened conversation, through the shared reducer |
| UI | Tailwind v4 + shadcn/ui |
| Markdown / code | Streamdown + `@streamdown/code` (Shiki, loaded on demand; grammars and themes are lazy chunks outside the precache) |
| Diffs | `@git-diff-view/react` (split when the viewer is ≥1024px wide, unified otherwise) |
| PWA | `vite-plugin-pwa`, `injectManifest` strategy (custom service worker) |
| API client | Typed `fetch` wrapper per route (`src/lib/api.ts`, types from `@pi-code/protocol`) + `EventSource` |

## Routes

| Path | Screen |
|---|---|
| `/` | Phone: Home (open agents with attention badges, recent sessions, "New conversation"). Desktop: "Pick a conversation or start a new one" with a New conversation button |
| `/sessions` | All sessions, filterable by project (`?cwd=`) |
| `/agents/$agentId` | Conversation |
| `/agents/$agentId/tree` | Session tree |
| `/agents/$agentId/diff` | Git diff of the project |
| `/share` | Share-target landing (`?title&text&url`) |
| `/settings` | Notifications permission, tool expansion default, about |

"New conversation" opens the **project picker**: recent projects (`GET /api/projects`) plus a path field with autocomplete (`GET /api/fs/dirs`), then `POST /api/agents { cwd }`. Opening a session from a list calls `POST /api/agents { sessionFile }` and navigates to the agent (existing agent if already open).

## Shell and sidebar

`AppShell` wraps every route (offline banner, badge sync, service-worker messages) and switches on `(min-width: 1024px)` (`useIsDesktop`):

| | Desktop (≥1024px) | Phone (<1024px) |
|---|---|---|
| Sidebar | Docked left (280px), shown on load. One "Toggle sidebar" button, at the top of the sidebar while it is shown and alone in a collapsed rail while hidden; not persisted | Left sheet, opened from the "Conversations" button in the conversation header; closes when something is picked |
| `/` | "Pick a conversation or start a new one" | Home: agents from `live`, recent sessions from `GET /api/sessions` |
| Back chevron to Home | Hidden (conversation header, settings, sessions, "Conversation closed" and other placeholder screens) | Shown |
| Settings | Sidebar footer | Home header, sidebar sheet footer |
| Conversation column | Full content width | Capped at `max-w-3xl` |

Tree and diff keep their "Back to conversation" chevron on both. The sidebar ([`05-desktop.md`](05-desktop.md), "Sidebar") reads `live`:

- **Rows:** every agent in `live.agents`, exited included, plus window sessions no agent holds (matched by `sessionFile`), grouped by cwd; groups and rows most recent first. Group label: folder basename, with the parent's prepended when two groups share it; the branch from `live.branches` while the folder has a live agent.
- **Row:** a spinner while `isStreaming` or `starting` (or while its resume is in flight), a green dot while pi runs, nothing for exited agents; title; a compact attention icon (Home keeps text badges); relative activity time, refreshed every 60 s. The route's agent is highlighted.
- **Actions:** New conversation (project picker); per-group `+` → `POST /api/agents { cwd }`; `×` on live rows (labelled "Close {title} ({folder})") → `DELETE /api/agents/:id` then `drop`, after a confirmation when the agent is streaming or awaiting input, disabled while the request is in flight. A live row navigates to its agent; an exited agent's row restarts it (`POST /api/agents/:id/restart`) then navigates; a session row resumes it (`useOpenAgent`).
- **Search:** non-empty text, debounced 200 ms, queries `GET /api/sessions?q=`; the results replace the window rows, and agent rows are filtered client-side on their title and cwd. The previous results stay while the next query loads; clearing the field shows the window at once. A themed × button clears the field.

## Live registry

`LiveRegistry` (`src/store/live-registry.ts`) is created once in `App`, started and stopped with it, and provided by context (`useLiveRegistry`, `useLive`). It owns the tab's only EventSource on `GET /api/stream` and every opened conversation store; routes own no connection. See [`05-desktop.md`](05-desktop.md), "Live registry".

```ts
interface LiveOverview {                     // Zustand; read by the sidebar, Home, badge and share
  loaded: boolean;                           // false until the first baseline
  agents: Record<AgentId, AgentInfo>;        // every agent the server holds, exited included
  sessions: SessionSummary[];                // the 7-day window
  branches: Record<string, string>;          // cwd → branch
  connection: "connecting" | "live" | "reconnecting" | "offline";
}

class LiveRegistry {
  live: StoreApi<LiveOverview>;
  start(): void;                             // listeners on, stream opened
  stop(): void;                              // stream closed; opened stores stay
  open(agentId: AgentId): ConversationStore; // idempotent: created and loaded on first call
  show(agentId: AgentId): () => void;        // marks the conversation on screen and acks it
  drop(agentId: AgentId): void;              // forgets the store and marks it closed
}
```

- **Opening.** The `/agents/$agentId` layout (`ConversationRoot`, keyed by agent id) calls `open` and `show` on mount. `open` fetches `GET /snapshot`, hydrates, then reconnects the stream with every hydrated store at its `seq` in `open=`. One EventSource at a time: a reconnect detaches and closes the current one first. Opened stores keep streaming until dropped or the tab reloads, so switching back costs nothing.
- **Refetch.** A `resync` frame, and an `agent_status` event turning the agent `ready`, refetch that store the same way. While its snapshot is in flight it ignores its frames and is left out of reconnect URLs.
- **Frames.** `event` → that store's `apply`; `baseline` / `agent` / `catalog` / `branch` → `live`; `agent_closed`, a `baseline` without a hydrated store's agent, and a snapshot answering `agent_not_found` drop the store. A `catalog` frame invalidates the `sessions` and `projects` queries only when the listing changes (a session added or removed, or any field other than `updatedAt` changed).
- **Attention.** Snapshots don't clear attention. The registry acks (`POST /ack`) only the conversation on screen: on `show`, on `visibilitychange` to visible, on window `focus`, and when an `agent` frame raises its attention while the page is visible and focused. The ack leaves `input` while a dialog or the trust prompt is pending, so the badge stays until it is answered.
- **Liveness.** EventSource reconnects by itself with `Last-Event-ID`. When it gives up (`CLOSED`), or a snapshot fetch fails, the registry retries with backoff (1, 2, 5, 10 s). On visible, window `focus` or `online`, a closed stream or one silent (no message, no `ping`) for 35 s is reopened. `offline` marks the connection offline.

## Conversation store

One vanilla Zustand store per opened agent, created by the registry:

```ts
type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

interface ConversationState {
  agentId: AgentId;
  agent: AgentInfo;
  state: RpcSessionState | null;
  transcript: Transcript;
  stats: SessionStats | null;
  gitStatus: GitStatus | null;
  live: LiveState;
  seq: number;                                     // last applied event, or the snapshot's
  hydrated: boolean;                               // a snapshot has been applied
  connection: ConnectionState;
  closed: boolean;                                 // the agent is gone
  hydrate(snapshot: Snapshot): void;
  apply(event: ServerEvent, seq: number): void;    // reduceLive + committed caches; seq ≤ current ignored
  setConnection(connection: ConnectionState): void;
  markClosed(): void;
}
```

`connection` mirrors the stream's state, or `connecting` / `reconnecting` / `offline` while the store's own snapshot is loading or being retried. A closed store makes the route show "Conversation closed" with a New conversation button.

Components subscribe with selectors (`useConversation(s => s.live.streaming)`), so token deltas only re-render the streaming message.

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

Dialogs render as bottom sheets over this screen: on phone, modal; on desktop, non-modal and scoped to the conversation column (see Extension UI).

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

Markdown is untrusted (model output, fetched pages, extension messages), so it never loads remote resources on its own: `https:` images render as a placeholder (alt text + host) that loads the image on tap, inline `data:image/…` images render directly, and other image URLs never load. Raw HTML goes through Streamdown's sanitizer with `<picture>` / `<source>` removed, so `<img>` is the only resource-loading element left. Links rendered from tool or extension data are links only for `http(s)://` URLs (opened with `rel="noopener noreferrer"`), plain text otherwise.

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
- Image attach (camera or gallery, `accept="image/*"`, non-image files ignored), sent as `prompt.images`; hidden when the current model's `input` lacks `"image"`. Images over 2048 px on the long side, over 1.5 MB, or in formats other than PNG / JPEG / GIF / WebP are redrawn on a canvas (max 2048 px) and sent as JPEG (quality 0.85); anything still over 5 MB is rejected with a toast.
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
| `editor` | Full-screen textarea (full column height on desktop), prefilled |
| `notify` | Toast (info / warning / error) |
| `setStatus` | Chip in the status bar |
| `setWidget` | Monospace block above/below the composer |
| `setTitle` | `document.title` |
| `set_editor_text` | Composer text |

Dialog titles and messages are rendered with URLs linkified and a copy button next to each URL — this is the copy-paste flow for MCP OAuth (open the URL, approve, paste the redirect URL back into the input). Dialogs with `expiresAt` show a countdown; at 0 the dialog stays until the server's `ui_resolved` (the device clock may be skewed). An agent with `status: "awaiting_trust"` shows a trust sheet (project path, what trusting loads) answered with `POST /trust`.

On phone, dialogs and the trust sheet are modal bottom sheets; outside taps don't cancel them. On desktop they are non-modal sheets portalled into the conversation column (`container` prop) with a `ScopedOverlay` dimming only that column, so the sidebar stays usable: outside clicks and Escape pressed outside the sheet don't answer, and Tab can leave the sheet (`SheetContent loopFocus={false}`), skipping the covered column, which is `inert` while it's open. A dialog's Escape (inside it), Cancel and × answer `cancelled`; the trust sheet answers only through its buttons. User-initiated action sheets (rename, model, thinking, stats) stay page-modal. See [`05-desktop.md`](05-desktop.md), "Layout".

### Status bar

Mirrors the TUI status-bar extension: folder name · git branch + dirty dot · context bar (5 cells from `stats.contextUsage.percent`) · session name · model + thinking level · cost. Extension `setStatus` chips follow. Run state (running / compacting / retrying n/m) shows as a leading indicator.

## Tree screen

The store's transcript (all branches) and labels rendered as an indented tree of user and assistant entries (tool traffic collapsed), labels as badges, the current leaf highlighted. Actions on an entry:

- **Go here** → `POST /tree/navigate` with a "summarize the branch you're leaving?" choice (and optional instructions).
- **Fork from here** (user messages) → `fork`.

Disabled while a run is active.

## Diff screen

`GET /git/diff` on open and on refresh. File list with status and `+/−` counts; tapping a file shows its patch in the diff viewer. Handles `binary`, `tooLarge`, and `not_a_git_repo`.

`DiffViewer` measures its own width (`useWidthAtLeast`, a `ResizeObserver` on its container) and renders split at ≥1024px, unified below, whatever the viewport.

## PWA

**Manifest:** name "pi-code", standalone display, icons, theme colors, and

```json
"share_target": { "action": "/share", "method": "GET", "params": { "title": "title", "text": "text", "url": "url" } }
```

**Service worker** (`src/sw.ts`, injectManifest):

- Precaches the app shell; API requests always go to the network.
- `push`: parse `PushPayload`; `navigator.setAppBadge(badge)` (or `clearAppBadge` at 0); if a pi-code window is focused, don't show a notification; else `showNotification(title, { body, tag: agentId, renotify: true, data: { url } })`.
- `notificationclick`: focus an existing window and navigate it to `url`, else `openWindow(url)`.

While the app is visible and the stream is live, `useBadgeSync` keeps the badge equal to the agents in `live` needing attention, minus the one on screen.

**Notifications setup:** `/settings` has an "Enable notifications" button (permission must come from a user gesture) → `pushManager.subscribe` with the VAPID key → `POST /api/push/subscriptions`. The same flow works in desktop Chrome, which covers desktop notifications.

**Share target:** `/share` shows "Send to…" with open agents (from `live`), recent sessions and "New conversation in…". Choosing one navigates to the conversation with the composer prefilled with `title`, `text` and `url`.

**Offline:** app shell only; a banner shows when the server is unreachable.
