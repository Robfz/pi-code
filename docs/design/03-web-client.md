# Web client design

React SPA, mobile-first, installable PWA, with a desktop shell at ≥1024px. Source: `packages/web`. The live registry, desktop shell, sidebar and layout are specified in [`05-desktop.md`](05-desktop.md), listing groups and worktree actions in [`06-worktrees.md`](06-worktrees.md), the review panel, draft store and line references in [`07-code-review.md`](07-code-review.md), Stop and Delete in [`08-delete-sessions.md`](08-delete-sessions.md), and the look and feel (tokens, typography, motion, turns, tool rows, thinking, density, the composer and its model picker) in [`09-ui-overhaul.md`](09-ui-overhaul.md); this document summarizes them.

| Concern | Choice |
|---|---|
| Build | Vite, TypeScript |
| Routing | TanStack Router (code-based route tree) |
| Server data | TanStack Query (catalog, session search, models, commands, git diff, branches, file search and content, health) |
| Live state | `LiveRegistry`: one `GET /api/stream` EventSource per tab feeding a Zustand overview and one Zustand store per opened conversation, through the shared reducer |
| Client state | Zustand: composer drafts per conversation (`store/drafts.ts`), review state per conversation (`features/review/review-state.ts`), UI preferences |
| UI | Tailwind v4 + shadcn/ui on the tokens of [`09-ui-overhaul.md`](09-ui-overhaul.md); Geist Sans and Geist Mono, bundled and precached |
| Markdown / code | Streamdown + `@streamdown/code` (Shiki with the Vitesse themes, loaded on demand; grammars and themes are lazy chunks outside the precache) |
| Diffs | `@git-diff-view/react` (split when the viewer is ≥1024px wide, unified otherwise) |
| PWA | `vite-plugin-pwa`, `injectManifest` strategy (custom service worker) |
| API client | Typed `fetch` wrapper per route (`src/lib/api.ts`, types from `@pi-code/protocol`) + `EventSource` |

## Routes

| Path | Screen |
|---|---|
| `/` | Phone: Home (open agents with status badges, recent sessions, "New conversation"). Desktop: "Pick a conversation or start a new one" with a New conversation button |
| `/sessions` | All sessions, filterable by project (`?cwd=`), in listing groups |
| `/agents/$agentId` | Conversation |
| `/agents/$agentId/tree` | Session tree |
| `/agents/$agentId/diff` | Review page (phone): the review panel's Changes and Files tabs. On desktop it opens the review pane and replaces itself with `/agents/$agentId` |
| `/share` | Share-target landing (`?title&text&url`) |
| `/settings` | Notifications permission, transcript density, about |

"New conversation" opens the **project picker**: recent projects (`GET /api/projects`, in listing groups) plus a path field with autocomplete (`GET /api/fs/dirs`), then `POST /api/agents { cwd }`. Opening a session from a list calls `POST /api/agents { sessionFile }` and navigates to the agent (existing agent if already open).

## Shell and sidebar

`AppShell` wraps every route (offline banner, badge sync, service-worker messages, `WorktreeActionsProvider`, `StopOrDeleteProvider`) and switches on `(min-width: 1024px)` (`useIsDesktop`):

| | Desktop (≥1024px) | Phone (<1024px) |
|---|---|---|
| Sidebar | Docked left (280px), shown on load. One "Toggle sidebar" button, at the top of the sidebar while it is shown and alone in a collapsed rail while hidden; not persisted | Left sheet, opened from the "Conversations" button in the conversation header; closes when something is picked |
| `/` | "Pick a conversation or start a new one" | Home: agents from `live`, recent sessions from `GET /api/sessions` |
| Back chevron to Home | Hidden (conversation header, settings, sessions, "Conversation closed" and other placeholder screens) | Shown |
| Settings | Sidebar footer | Home header, sidebar sheet footer |
| Conversation column | Centred, `max-w-[46rem]` with `px-6`; fits the half beside the review pane while that is open | Centred, `max-w-[46rem]` with `px-4` |
| Review panel | Pane beside the conversation, toggled from the header or `/diff` | `/agents/$agentId/diff` page, from the header menu's Diff or `/diff` |

The tree screen (on both) and the phone review page keep their "Back to conversation" chevron. The sidebar ([`05-desktop.md`](05-desktop.md), "Sidebar") reads `live`:

- **Rows:** every agent in `live.agents`, exited included, plus window sessions no agent holds (matched by `sessionFile`), in listing groups (below); groups and rows most recent first. Group label: folder basename, with the parent's prepended when two top-level groups share it; the branch from `live.branches` on the header owning the cwd while the folder has a live agent.
- **Row:** a `StatusMark` (the status vocabulary, [`09-ui-overhaul.md`](09-ui-overhaul.md), "Status vocabulary"): a neutral spinner for Working, a dot coloured for Needs input, Failed, Finished or Idle, nothing for Closed (exited agents, session rows); title; relative activity time, refreshed every 60 s. The route's agent is highlighted.
- **Actions:** New conversation (project picker); per-group `+` → `POST /api/agents { cwd }` (none on missing worktrees); "New worktree" on repo headers, "Remove worktree" on linked and missing worktree headers; `×` on every row (the `×` rule below). A live row navigates to its agent; an exited agent's row restarts it (`POST /api/agents/:id/restart`) then navigates; a session row resumes it (`useOpenAgent`).
- **Search:** non-empty text, debounced 200 ms, queries `GET /api/sessions?q=`; the results replace the window rows, and agent rows are filtered client-side on their title and cwd. The previous results stay while the next query loads; clearing the field shows the window at once. A themed × button clears the field.

### Listing groups and worktrees

Every listing (sidebar, Home, `/sessions`, the picker's recent projects) goes through `groupListing` (`features/catalog/listing-groups.ts`): items without `layout` form folder groups by cwd; items of a `<repo>/main` layout repo form one repo group, with the container's own items under its header and one sub-group per checkout, `main` first. In a missing worktree, exited agents and the sessions no live agent holds are disabled.

`WorktreeActionsProvider` (`features/worktrees/worktree-actions.tsx`) owns the "New worktree" sheet (`POST /api/worktrees`, then navigate to the new agent) and the "Remove worktree" confirmations (`DELETE /api/worktrees`, a second confirmation and `force` on `worktree_dirty`); header buttons reach it through `useWorktreeActions`.

### Stop and Delete

`StopOrDeleteProvider` (`features/sessions/stop-or-delete.tsx`) owns the Stop-or-Delete dialog; the sidebar, Home ("Open conversations", "Recent sessions"), `/sessions` and the conversation header reach it through `useStopOrDelete`. The `×` rule, on every row of those lists (not the share screen):

- Live agent → dialog "Stop or delete {title}?" with Cancel, Stop and Delete; labelled "Stop or delete {title} ({folder})".
- Exited agent, or session no agent holds → deletes at once; labelled "Delete {title} ({folder})". It works in a missing worktree too, where the row is disabled for opening.
- Home or `/sessions` session held by an agent (in `live.agents`, by `sessionFile`) → that agent's rule.

Stop is `DELETE /api/agents/:id`; Delete is `deleteSession(file)` (`DELETE /api/sessions`), with the agent's `sessionFile` for an agent row (only Stop when it has none yet). Both `drop` the agent; a delete invalidates the `sessions` and `projects` queries. Stopping or deleting the conversation on screen navigates to `/`. A row's `×` is disabled while its own request runs; failures show a toast; success shows nothing.

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

Components subscribe with selectors (`useConversation(s => s.live.streaming)`), so token deltas only re-render the live turn.

The **active branch** is derived from `transcript`: walk `parentId` from `leafId` to the root, reverse. Memoized on `(entries.length, leafId)`.

## Conversation screen

```
┌ header: session name · project · changes (desktop) · density · ⋮ (tree, diff on phone, fork…, stop, delete) ┐
│ transcript: the active branch as turns, the live turn last, !cmd runs in flight                              │
│ queue display                                                                                                │
│ widgets (aboveEditor)                                                                                        │
│ composer                                                                                                     │
│ widgets (belowEditor)                                                                                        │
│ status bar                                                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The header spans the full width; the transcript and the composer area share one centred column, `mx-auto w-full max-w-[46rem]` with `px-4` below 1024px and `px-6` from 1024px, on phone and desktop alike. Dialogs render as bottom sheets over this screen: on phone, modal; on desktop, non-modal and scoped to the conversation column (see Extension UI). On desktop, the header's "Show changes" button (`aria-pressed`) and `/diff` toggle the review pane, which takes the right half of the content area ([`07-code-review.md`](07-code-review.md), "Desktop pane"), and the column fits the half left beside it; the header menu's Diff item exists only on phone.

### Transcript rendering

Specified in [`09-ui-overhaul.md`](09-ui-overhaul.md), "Transcript"; in short:

- **Turns.** `selectTurns` (`store/turns.ts`, memoized on the active branch) splits the active branch at each user message; entries before the first one form a turn without a user message. `TurnView` (`transcript/turn.tsx`) renders a turn as its user message, then its steps: non-empty assistant text blocks, thinking blocks, tool calls (each paired with its `toolResult` by `toolCallId` in `ToolCallSlot`), stop notices and the other entries below. Turns are 40px apart.
- **The live turn** is the last turn while a run is active, a message streams or a user message is pending: its steps continue with the streaming message's blocks and the orphan tool runs, and it ends with the live-status row. Only it subscribes to live state, so token deltas re-render only it. `!cmd` runs in flight render after the turns.
- **User message:** a full-column-width box (`--user-message` surface, hairline, 10px radius, 15px prose) with clickable line references and image thumbnails; leading `<file>` blocks (attached text files) are collapsed rows that expand to the content. A pending message is at 70% opacity.
- **Assistant text:** bare 15px prose (Streamdown, with clickable line references).
- **Rows.** `CollapsibleRow` (`components/collapsible-row.tsx`, on Radix Collapsible) is the only disclosure: a borderless 28px row (14px icon, label, and a tail with duration and chevron shown on hover, on focus and while open) whose body opens with a 150ms height animation. Tool calls are `ToolRow`s (Tool renderers, below).
- **Thinking:** a `Brain` row. Live: "Thinking" with a shimmer and, while collapsed, a one-line preview of the latest line. Done: "Thought for 12s" (from the block's `startedAt` / `endedAt`, else `live.thinkingMs`), "Thought" when the duration is unknown, "Thought (redacted)" without a body. The body is 13px muted text behind a left hairline.
- **Exploration groups** (Balanced and Compact): two or more consecutive `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, `source_check` and `get_search_content` calls, with the thinking between them, fold into one row (`groupSteps`, `transcript/grouping.ts`): "Explored 3 files, 2 searches", or "Exploring · Reading foo.ts" with a shimmer while a child runs. A failed call stays its own row.
- **Density:** one persisted preference, `density` (`store/ui-prefs.ts`), chosen from the header's density dropdown and in Settings:
  - **Compact:** a finished turn folds its thinking, tool calls and intermediate text into one "Worked for 2m 14s" row, followed by the final text; a live turn shows only its streaming text and the live-status row.
  - **Balanced** (default): every step, exploration grouped, every row collapsed; running `bash` and fallback-renderer rows are expanded while they run.
  - **Detailed:** every step, no grouping, every row expanded, thinking included.
  - Toggling a row by hand holds until the density changes.
- **Live-status row:** the live turn's last line, a shimmering phrase for the current activity ("Thinking", "Reading foo.ts", "Running pnpm test", "Compacting context", "Retrying 2/3 · reason", "Working") and a faint timer counting from `live.run.startedAt`. Compact always shows it; Balanced and Detailed only while no row above it shimmers. A run error shows its red alert box under it.
- **Turn footer:** one 12px faint line under each finished turn with an assistant message: the duration (not in Compact), the cost (the turn's assistant usage plus its `spawn` spend), a files chip ("4 files +120 −30", from the turn's successful `edit` and `write` calls) that opens the review pane's Changes tab on desktop and `/agents/$agentId/diff` on phone, and "Copy response" for the final text (shown on hover and focus where the pointer can hover, always on touch).

| Entry / role | Rendering |
|---|---|
| `user` message | The user message box |
| `assistant` message | Its text, thinking and tool-call blocks as steps of the turn |
| `bashExecution` | Row: command, output (collapsed if long), exit code; muted when `excludeFromContext` (`!!`) |
| `custom` message (`display: true`) | Markdown of `content`; known `customType`s from pi-web-access / pi-mcp-adapter get small cards; others generic |
| `compactionSummary` / `compaction` | Divider "Context compacted (N tokens)", expandable summary |
| `branchSummary` | Divider "Branch summary", expandable |
| `model_change`, `thinking_level_change` | Inline muted marker |
| `label` | Badge on the target entry's first step |
| `custom` entries (extension state), `session_info`, `usage` | Not shown |

Assistant errors (`stopReason: error`) show the error message as a stop step; `aborted` shows "Stopped".

**Line references.** `@path:N`, `@path:N-M`, `@"quoted path":N` and the version-named `@<sha>:./path:N` (syntax in [`07-code-review.md`](07-code-review.md), "References"; parsed by `findCodeRefs` from `@pi-code/protocol`) render clickable in the `link` colour: plain `text-link` text in user messages (`CodeRefText`, inline code included), and mono `text-link` chips on `bg-link/12` in assistant text blocks (the `rehypeCodeRefs` plugin, skipping code blocks and links). The pi-code extension asks the model to write them. A click or Enter opens the Files tab at those lines (`useOpenReference`): the pane on desktop, the review page on phone; a version-named reference opens the current file with a toast.

Markdown is untrusted (model output, fetched pages, extension messages), so it never loads remote resources on its own: `https:` images render as a placeholder (alt text + host) that loads the image on tap, inline `data:image/…` images render directly, and other image URLs never load. Raw HTML goes through Streamdown's sanitizer with `<picture>` / `<source>` removed, so `<img>` is the only resource-loading element left. Links rendered from tool or extension data are links only for `http(s)://` URLs (opened with `rel="noopener noreferrer"`), plain text otherwise.

### Tool renderers

A registry keyed by `toolName` (`tools/registry.ts`). Each renderer receives `ToolRendererProps` (`{ args, argsText, status, partialResult, result: { content, details }, isError, expanded, curatorUrl, durationMs, startedAt, … }`) and describes its row through `label()`; `Body` is the expanded content:

```ts
interface ToolRenderer {
  label(props: ToolRendererProps): ToolLabel; // { icon, verb, target?: { kind: "path" | "code" | "text"; text }, meta? }
  Body: ComponentType<ToolRendererProps>;
  expandWhileRunning?: boolean;               // Balanced: expanded while running (bash, the fallback)
}
```

`ToolRow` (`tools/tool-row.tsx`) renders every call, nested subagent calls included, as one line: `[icon] Verb target meta … 1.2s ›`. The verb is present tense with a shimmer while the call runs or streams, past tense when done, and on failure a red "… failed" next to a `CircleAlert` icon, with the error's first line appended to the meta. A path target is its basename followed by its faint directory; commands and patterns are mono. The tail shows the committed result's `durationMs`, the live run's, or the time elapsed since it started. The body sits in a bordered card, and whether it starts open follows the density; a collapsed call with a curator URL shows its Review button under the row. Icons, verbs, targets and meta per tool are in [`09-ui-overhaul.md`](09-ui-overhaul.md), "Tool rows".

| Tool | Row (done) | Body |
|---|---|---|
| `read` | Read path `:a-b` | highlighted content |
| `bash` | Ran command, `exit N` when non-zero | output (streams from `partialResult`) |
| `edit` | Edited path `+n −m` | `details.patch` in a selectable diff viewer (line numbers insert references) |
| `write` | Wrote path · N lines | content (new files as an all-added, selectable diff) |
| `grep` / `find` / `ls` | Searched /pattern/ · N matches; Found pattern · N files; Listed dir · N entries | result list |
| `spawn` | Ran N agents · progress | progress widget from `SubagentDetails`: per-agent cards (agent, task, status, duration, usage), markdown output, nested tool calls as body-less `ToolRow`s |
| `web_search` / `source_check` | Searched web "query" · N sources; Checked claim · N sources | results with links, summary; **Review in curator** button when a `curator` event exists for the call |
| `fetch_content` / `get_search_content` | Fetched title or URL; Got content | extracted content (markdown) |
| `mcp` and MCP namespace tools | Called server · tool | arguments, result content |
| anything else | tool name, first string argument | arguments (JSON), text result |

### Composer

Specified in [`09-ui-overhaul.md`](09-ui-overhaul.md), "Composer".

```
┌ composer ─────────────────────────────────────────────────────────┐
│ attachments                                                       │
│ textarea (15px, auto-growing)                                     │
│ (+)                          Opus 5 · High ⌄   Queue  (■)  (↑)    │
└───────────────────────────────────────────────────────────────────┘
```

- **Box:** a card with a strong hairline and 16px corners; focused, its border takes the ring colour with a 3px halo. Attachments, the textarea and a footer row sit inside it.
- **Footer:** "Attach file" (a round `+` button) on the left. On the right the model picker, then, idle, Send (round, solid foreground, `ArrowUp`). While running: Queue (a small outlined text button), Stop (round, raised surface, a square icon) and Steer (round, solid foreground); Stop is always there, Queue and Steer only while the draft has text or attachments.
- **Model picker** (`ModelPicker`, `model-picker.tsx`): one button reading "{model} · {level}" ("Opus 5 · High"; "No thinking" for `off`; the name alone for models without `reasoning`), 13px muted with a chevron, disabled until pi is ready. On desktop it opens a 300px popover: a searchable cmdk list of `get_available_models` grouped by provider, the current model checked (choosing one sends `set_model` and closes), and for reasoning models a "Thinking" segmented control of `get_available_thinking_levels` (choosing a level sends `set_thinking_level` and keeps it open). On phone it opens the model sheet, which shows the same control at its bottom for reasoning models.
- Text, caret and attachments live in the draft store (`store/drafts.ts`), one draft per conversation, so they survive navigation (tree, review page, other conversations) but not a reload. Sending clears the draft; a failed send restores it only into a still-empty draft.
- `ComposerInput` lays the textarea over a mirror that colours line references in `text-link`. A deletion that touches a reference without covering it removes the whole reference; typing inside one turns it plain. References selected in a diff or the file viewer are inserted at the saved caret (`insertReference`) and focus the composer ([`07-code-review.md`](07-code-review.md), "Composer").
- Enter/Send: idle → `prompt`. While running, two actions: **Steer** (`streamingBehavior: "steer"`) and **Queue** (`"followUp"`). **Stop** → `abort`. **Stop & edit** → `clear_queue` then `abort`, restoring queued text into the composer.
- Keys: Enter sends (steers while running), Alt+Enter queues, Shift+Enter is a newline; on touch devices Enter is a newline.
- Queue display (from `live.queue`) above the composer, with **Stop & edit** after the queued messages while the queue is non-empty.
- `!cmd` → `bash`; `!!cmd` → `bash { excludeFromContext: true }`.
- File attach (any file type). Images are sent as `prompt.images` and rejected with a toast when the current model's `input` lacks `"image"` (attached images are dropped when the model changes to one without it). Other files are read as UTF-8 text (max 512 KB each; binary — a NUL byte or invalid UTF-8 — and empty files are rejected with a toast) and prepended to `message` as `<file name="…" length="…">\n…\n</file>\n` blocks (pi's CLI convention for `@file` arguments, plus a content length; see the API contract). Images over 2048 px on the long side, over 1.5 MB, or in formats other than PNG / JPEG / GIF / WebP are redrawn on a canvas (max 2048 px) and sent as JPEG (quality 0.85); anything still over 5 MB is rejected with a toast.
- `set_editor_text` UI requests, fork and share replace the draft text.
- Slash autocomplete: built-in commands implemented by the client (below) + `get_commands` (extension, skill, template), excluding pi-code's own extension commands.

Built-in commands:

| Command | Action |
|---|---|
| `/new` | `new_session` |
| `/resume` | session list for this project |
| `/name <name>` | `set_session_name` |
| `/model [provider/id]` | model sheet / `set_model` |
| `/thinking [level]` | thinking sheet / `set_thinking_level` |
| `/compact [instructions]` | `compact` |
| `/tree` | tree screen |
| `/fork` | picker from `get_fork_messages` → `fork` |
| `/clone` | `clone` |
| `/session` | stats sheet (`get_session_stats`) |
| `/copy` | copy last assistant text |
| `/diff` | toggle the review pane (desktop); review page (phone) |
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

One 12px faint line under the composer: folder name (from 1024px) · git branch + dirty dot, then on the right the context bar (5 cells from `stats.contextUsage.percent`, with its percentage from 1024px) · cost, with `(sa $x)` once the conversation has a `spawn` call: the summed `usage.cost` of its results' details, from committed tool results on all branches (like the session cost) plus uncommitted calls in `live.tools` · "Working" with a spinner while the run is active, compacting or retrying. The context bar and cost open the stats sheet. Extension `setStatus` chips sit below. The session name is in the header; the model and its thinking level are in the composer's picker.

## Tree screen

The store's transcript (all branches) and labels rendered as an indented tree of user and assistant entries (tool traffic collapsed), labels as badges, the current leaf highlighted. Actions on an entry:

- **Go here** → `POST /tree/navigate` with a "summarize the branch you're leaving?" choice (and optional instructions).
- **Fork from here** (user messages) → `fork`.

Disabled while a run is active.

## Review panel

Specified in [`07-code-review.md`](07-code-review.md). `ReviewPanel` has two tabs, Refresh and the active tab, and renders as the desktop pane beside the conversation or as the phone's `/agents/$agentId/diff` page:

- **Changes**: `GET /git/diff` in uncommitted or branch mode (base from `GET /git/branches`, optional uncommitted changes). File list with status and `+/−` counts; expanding a file shows its patch in a selectable diff viewer. Handles `binary`, `tooLarge`, `not_a_git_repo` and branch-mode errors.
- **Files**: fuzzy search (`GET /files?q=`) and a file viewer (`GET /files/content`) with selectable lines.
- Selecting lines inserts a reference into the composer: on desktop on mouse release, on phone through the Add to chat bar, which returns to the conversation.
- Every `git_status` event and snapshot hydration invalidates the agent's review queries, so the diff and open file refresh after each turn.

`DiffViewer` measures its own width (`useWidthAtLeast`, a `ResizeObserver` on its container) and renders split at ≥1024px, unified below, whatever the viewport.

## PWA

**Manifest:** name "pi-code", standalone display, icons, theme colors, a `focus-existing` launch handler (launching focuses the open window and `useLaunchQueue` routes it in-app to the launch URL), a "New conversation" shortcut (`/?new=1`: `/` opens the project picker and strips the param), and

```json
"share_target": { "action": "/share", "method": "GET", "params": { "title": "title", "text": "text", "url": "url" } }
```

**Service worker** (`src/sw.ts`, injectManifest):

- Precaches the app shell; API requests always go to the network.
- `push`: parse `PushPayload`; `navigator.setAppBadge(badge)` (or `clearAppBadge` at 0); if a pi-code window is focused, don't show a notification; else `showNotification(title, { body, tag: agentId, renotify: true, data: { url }, icon, badge })`, without `icon` on macOS, which shows it as an attachment next to the app icon (pi-code's own with the browser's notification attribution).
- `notificationclick`: focus an existing window and navigate it to `url`, else `openWindow(url)`.

While the app is visible and the stream is live, `useBadgeSync` keeps the badge equal to the agents in `live` needing attention, minus the one on screen.

**Notifications setup:** `/settings` has an "Enable notifications" button (permission must come from a user gesture) → `pushManager.subscribe` with the VAPID key → `POST /api/push/subscriptions`. The same flow works in desktop Chromium browsers (Chrome, Edge), which covers desktop notifications.

**Share target:** `/share` shows "Send to…" with open agents (from `live`), recent sessions and "New conversation in…". Choosing one navigates to the conversation with the composer prefilled with `title`, `text` and `url`.

**Offline:** app shell only; a banner shows when the server is unreachable.
