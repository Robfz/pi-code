# Desktop and concurrent conversations

Comfortable desktop use with several conversations running at once: a sidebar of every conversation, one multiplexed event stream per browser tab, and a wider layout. Decisions and rationale: [`../../maps/2026-09-30-desktop.md`](../../maps/2026-09-30-desktop.md); ordering, collapse and pins: [`../../2026-10-10-side-panel.md`](../../2026-10-10-side-panel.md). Where this document overlaps `01`–`03`, it takes precedence; the look and feel (status vocabulary, transcript column, tokens) is specified in [`09-ui-overhaul.md`](09-ui-overhaul.md), which takes precedence over this one.

Desktop clients are the Mac and other laptops, in a browser tab over the tailnet URL (HTTP/2). One tab holds every conversation; phones use the same stream and keep their screens.

A **live** agent is one whose pi process is running (`starting`, `awaiting_trust`, `ready`). The server's registry (`manager.list()`) also keeps **exited** agents, whose pi died unexpectedly, until they are reopened (which restarts pi), closed or swept idle; they are not live.

## Live stream — `GET /api/stream`

One `text/event-stream` per tab. It carries agent status, the session catalog and the sidebar state for everyone, plus the full event stream of every conversation **opened** in this tab. There is no per-agent event endpoint.

### Request and resume

```
GET /api/stream?open=<agentId>:<seq>,<agentId>:<seq>
```

- `open` lists the tab's opened conversations, each with the last `seq` the client holds. Absent or empty: status and catalog only (phone Home). Agent ids are base64url, so `:` and `,` never occur in them. Pairs without `:` or without an id, and unknown agent ids, are ignored; the client sees the agent's absence in the baseline. A pair whose seq isn't a non-negative integer resyncs (below).
- `Last-Event-ID` carries the same `agentId:seq,…` format. The query decides which agents are streamed; for each, a cursor from `Last-Event-ID` wins over the query's. EventSource reconnects reuse the URL, so the header holds the fresher cursors; a client-initiated reconnect opens a new EventSource with no header and fresh query cursors.
- Per agent, with `oldest` the oldest `seq` in its ring buffer, the cursor replays when `oldest − 1 ≤ seq ≤` the log's `seq`; a caught-up cursor replays nothing. Otherwise (dropped, ahead of the log, not a non-negative integer) that agent gets `resync` and streams live from the log's current `seq`. The other agents are unaffected.

### Framing

Every frame is a default (`message`) event with `data: <StreamFrame JSON>` and `id: <cursor list>`: the connection's current `agentId:seq` pair for every streamed agent whose position is established, in `open` order, updated as each frame is queued, so whatever frame came last is a complete resume point. A resyncing agent joins the list with its `resync` frame (so a reconnect before that frame resyncs it again), and a closed agent leaves it. `retry: 2000`. Every 15 s a named `ping` event (`event: ping`, `data: {}`, no `id:`).

```ts
/** `agentId:seq` pairs joined by `,` — the `open` query value and every SSE `id:`. */
type CursorList = string;

type StreamFrame =
  | { type: "baseline"; agents: AgentInfo[]; sessions: StreamedSession[]; branches: Record<string, string>; sidebar: SidebarView }
  | { type: "event"; agentId: AgentId; seq: number; event: ServerEvent } // opened agents only
  | { type: "resync"; agentId: AgentId }                  // refetch that agent's snapshot
  | { type: "agent"; agent: AgentInfo }                   // any agent's info changed (or a new agent)
  | { type: "agent_closed"; agentId: AgentId }
  | { type: "catalog"; sessions: StreamedSession[] }      // every session, replaces the previous list
  | { type: "branch"; cwd: string; branch: string | null } // null: the folder is no longer tracked
  | { type: "sidebar"; sidebar: SidebarView };            // pins, collapsed groups and pinned mains, replaces the previous state
```

- `ServerEvent` is the union from `02-api-contract.md` without `resync`, which exists only as a frame. `AgentInfo` is unchanged.
- `baseline.sessions` and `catalog.sessions` hold every session, most recently prompted first (see Ordering), as `StreamedSession = Omit<SessionSummary, "ownedBy" | "updatedAt">`: `ownedBy` would go stale (clients match agents by `sessionFile`), and `updatedAt` moves on every write, so with it a turn would send a `catalog` frame on every rescan for nothing a client shows. `baseline.branches` maps cwd → branch for folders with a live agent inside a git work tree. `baseline.sidebar` is the sidebar state (see Sidebar state).
- `event.seq` duplicates the agent's pair in `id:` so the client never parses ids.

### Connection sequence

1. The server awaits the hub (ready after the startup scan, see Session watcher, and the sidebar state load).
2. In one synchronous block (publishing is synchronous, so nothing falls between replay and subscription): build the baseline from `manager.list()`, the session list, the branch map and the sidebar state; for each opened agent, replay from its cursor or mark it for `resync`; subscribe to every opened agent's `EventLog`, to the manager's `agent` / `closed` events, and to catalog, branch and sidebar changes.
3. Write `retry`, the `baseline`, then per opened agent (in `open` order) either its replayed `event` frames or its `resync`, each as its own write, then live frames from the connection's queue as they come.

A connection with 20,000 live frames queued is ended, which bounds memory for a stalled socket (replay isn't counted). EventSource reconnects with `Last-Event-ID` and replays or resyncs per agent. When an opened agent's log closes, its events stop; `agent_closed` tells the client.

## Server

### StreamHub

`http/stream.ts` holds the route and the per-connection writer (a frame queue drained to the socket, with pings); `live/stream-hub.ts` owns the shared inputs and turns them into frames:

| Source | Frames |
|---|---|
| Opened agents' `EventLog`s | `event`, `resync` |
| `AgentManager` `agent` event (any `AgentInfo` change) | `agent` |
| `AgentManager` `closed` event | `agent_closed` |
| Session watcher, hourly tick | `catalog` |
| Folder branches | `branch` |
| Sidebar state (`PATCH /api/sidebar`, pruning) | `sidebar` |

Every `AgentInfo` change reaches the manager's `agent` event: `publishStatus` reports status and attention, and `AgentPipeline.publish` reports `isStreaming`, `sessionName`, `sessionFile` and `sessionId` whenever an event (`state`, `transcript_reset`, pi events) makes them differ from the last reported info. The hub keeps the current session list, branch map and sidebar state in memory, so a baseline is built without I/O.

### Idle sweep

An agent's **activity** is the later of its `startedAt` and its session's `updatedAt` (the last entry's timestamp, written on human and agent turns alike), read from `SessionCatalog`'s cached summaries. `startedAt` is set whenever pi is spawned, restarts included, so reopening an exited agent starts a fresh 7-day clock. An hourly tick closes, through `AgentManager.close` (the `DELETE /api/agents/:id` path), every agent whose activity is at least 7 days old and that isn't streaming, exited agents included; close errors (e.g. `agent_not_found` after a concurrent `DELETE`) are ignored. The 7 days are `IDLE_AFTER_MS` in `agents/idle-sweep.ts`. The same tick refreshes the catalog, which keeps `catalog` frames coming when the session watcher is off. Closing stops pi only: the session stays listed.

### Session watcher

`catalog/watcher.ts` runs `fs.watch(<agentDir>/sessions, { recursive: true })` (FSEvents on macOS), which also sees sessions written by the TUI. Every event that can affect the listing (a project dir created or deleted, a `.jsonl` file in one written or deleted; not subagent files deeper down) schedules a rescan through a trailing throttle with a 500 ms maximum wait, so continuous writes still produce one every 500 ms. One rescan runs at a time; requests made during it share one follow-up rescan. The rescan calls `SessionCatalog.invalidate()`, rescans (unchanged files come from the per-file cache, grown ones have only their appended bytes parsed), and hands every session to the hub, which broadcasts `catalog` when the streamed list differs from the current one: a session added or deleted, a rename, a first message, a new prompt, a layout or `missing` change. Agent output alone changes only `updatedAt`, which the stream leaves out, so it sends nothing. The same routine produces the first list at startup. Each rescan also prunes the sidebar state (see Sidebar state). A missing sessions dir logs a warning and leaves the watcher off.

### Folder branches

`git/branches.ts` tracks the branch of each cwd that has at least one live agent, reading git's files directly instead of spawning `git`:

1. **Resolve the git dir once**, when the cwd gains its first live agent: walk up to the first `.git`. A directory is the git dir; a file (worktrees, submodules) holds `gitdir: <path>`, relative to the file's directory. No `.git` → no branch, no watch.
2. **Read `<gitDir>/HEAD`:** `ref: <ref>` → `<ref>` without `refs/heads/`; a bare commit id (detached HEAD) → its first 7 characters.
3. **Watch** `<gitDir>` non-recursively, since a directory watch survives git replacing `HEAD` by rename. Every event re-reads `HEAD`; a changed value → `branch` frame.
4. When the cwd has no live agent left, the watch stops and, if a branch had been reported, `branch { branch: null }` goes out.

Per-conversation `git_status` (branch + dirty, status bar) comes from `git` as described in `01-server.md`.

### Ordering

The only interaction that moves a conversation is a user prompt, from pi-code or the TUI: opening, resuming or restarting a conversation, agent output and acks move nothing. Every listing sorts the same way:

- **Items:** prompted first, by their last prompt, newest first; then the never-prompted, newest created first. The time shown on a row is the one it sorts by.
- **Groups** follow their first item, so groups with a prompt come before those without; within a repo group, the main checkout comes first, then the other checkouts by their first item.

`SessionSummary.lastPromptAt` is the timestamp of the last `message` entry with role `user`, found in the same parse as `updatedAt` by scanning the file from the end. `ProjectSummary` carries the latest `lastPromptAt` and `createdAt` of its sessions. Server and clients share the rule (`recencyOf` and `compareRecency`, `@pi-code/protocol`): the server sorts `GET /api/sessions`, `GET /api/projects` and the stream's session list with it, clients their groupings; an unparsable time counts as 0. An agent takes its session's recency; one whose session file isn't listed yet (no prompt) counts as created at its `startedAt`.

### Sidebar state

Pins and collapsed groups live on the server, shared by every client: `SidebarStateStore` (`store/sidebar-state.ts`) keeps `{ pinned: string[]; collapsed: string[] }` in memory and in `<dataDir>/sidebar.json` (atomic writes, `0600`). `pinned` holds layout repos (container paths); `collapsed` holds folder cwds, repo containers and linked worktree cwds.

- `PATCH /api/sidebar` (`http/sidebar-routes.ts`) sets flags path by path (`{ pinned?: Record<path, boolean>; collapsed?: Record<path, boolean> }`), so concurrent changes from two devices to different paths both stick, and a repeated request changes nothing. It answers the resulting state. Patches apply one at a time, in arrival order.
- An entry whose directory no longer exists is dropped: at load, on every catalog refresh, and a patch doesn't add one. This forgets removed worktrees, deleted folders and missing worktrees instead of keeping state for a path that may reappear. A folder left without conversations keeps its entry.
- Every change goes to every stream as a `sidebar` frame; the baseline carries the current state.
- What the server sends (`sidebar` frames, `baseline.sidebar`, the `PATCH` answer) is a `SidebarView`: the state plus `mains`, each pinned repo's main checkout keyed by container, resolved by `sidebarView` (`mainCheckoutIn`) as it sends it. A pinned path that no longer resolves has no entry. The client keeps `mains` across its own changes (`applySidebarPatch` keeps the rest of the object); until the next `sidebar` frame, a newly pinned repo takes its main checkout from its rows' `layout.main`.

### Catalog endpoint

`GET /api/sessions?cwd=&q=` — `q` (optional) is a case-insensitive substring match against the session's `cwd` path and `name`. It covers all sessions.

`GET /api/agents/:id/snapshot` has no side effects. `POST /ack` (see Live registry) clears `finished` and `failed`, and `input` only when no dialog or trust prompt is pending; `input` also clears when the last pending dialog is answered or times out, the trust prompt is answered, or pi exits.

## Web client

### Live registry

A long-lived `LiveRegistry` (`src/store/live-registry.ts`), created once in `App` and provided by context, owns the tab's single stream and every opened conversation store. Routes own no connection. Its injectable dependencies are `fetchSnapshot`, `ack`, `patchSidebar`, `document` and `window`; it constructs streams with the global `EventSource`, which tests replace with a fake.

```ts
interface LiveOverview {                     // Zustand, read by sidebar, Home, badge, share
  loaded: boolean;                           // false until the first baseline
  agents: Record<AgentId, AgentInfo>;
  sessions: SessionSummary[];                // every session
  branches: Record<string, string>;
  sidebar: SidebarView;
  connection: "connecting" | "live" | "reconnecting" | "offline";
}

interface LiveRegistry {
  live: StoreApi<LiveOverview>;
  start(): void;                             // App mount: listeners on, stream opened
  stop(): void;                              // App unmount: stream closed, opened stores kept
  open(agentId: AgentId): ConversationStore; // idempotent; the route calls it on mount
  show(agentId: AgentId): () => void;        // the route's conversation is on screen; acks it
  drop(agentId: AgentId): void;              // on agent_closed, or after DELETE
  setSidebar(patch: SidebarPatch): Promise<void>; // see Sidebar
  expand(paths: string[]): void;             // uncollapses the collapsed ones among `paths`
}
```

- **Opening.** `open` creates the `ConversationStore`, fetches `GET /snapshot`, hydrates, then reconnects the stream: a new EventSource whose `open` lists every hydrated store at its `seq` (the snapshot's, then each applied event's). The registry holds one EventSource at a time: a reconnect closes the current one, detaching its handlers, before opening the next, so frames never interleave across sources. Switching between opened conversations costs nothing.
- **Eviction.** The store on screen (`show`, while `ConversationRoot` is mounted) is never evicted. Released stores, the others, stay opened and keep streaming until a hydrate reconnects the stream anyway; then all but the 3 most recently opened or left are evicted, leaving the cursor list without an extra reconnect. Eviction isn't `drop`: the store isn't marked closed, and opening the agent again creates a new store from a snapshot.
- **Refetch.** `resync`, and an `agent_status` that turns an opened agent `ready`, run opening again for that store. Until it is hydrated again it ignores its frames and is left out of reconnect URLs, so a reconnect meanwhile doesn't resync it twice; what it missed replays after the reconnect that follows the hydrate.
- **Frames.** `event` frames are buffered per store and applied with one `applyBatch` per animation frame, or after 100 ms or on `visibilitychange` (a hidden tab gets no animation frames). Every other frame, a stream error or close, and a reconnect apply the buffers first, so effects keep the stream's order and reconnect cursors count every received event. Each event's side effects (`git_status` invalidation, the `ready` refetch) run as the batch reaches it; a refetch discards the rest of the store's buffer. `agent` / `agent_closed` / `catalog` / `branch` / `sidebar` / `baseline` → `live`. `agent_closed` also drops the store; if it was on screen, the route shows it as closed (see Sidebar). On `baseline`, a hydrated store whose agent is missing from `baseline.agents` (closed while disconnected, server restart) is handled as `agent_closed`, and so is a snapshot fetch answering `agent_not_found`; a store still fetching its snapshot is left to that snapshot. Every `catalog` frame invalidates the `sessions` and `projects` queries, keeping phone Home, `/sessions` and the project picker fresh and in order; the server sends one only when the streamed list changes (see Session watcher).
- **Attention.** Background stores re-snapshot too, so snapshots must not clear attention. The registry acks (`POST /ack`) only the conversation on screen (the one passed to `show`): when the route mounts, on `visibilitychange` to visible, on window `focus` (switching desktop windows fires no `visibilitychange`), and when an `agent` frame raises its attention while the page is visible and `document.hasFocus()`.
- **Liveness.** EventSource reconnects on its own with `Last-Event-ID`. When it gives up (`CLOSED`), or a snapshot fetch fails, the registry retries with backoff (1, 2, 5, 10 s). On visible, window `focus` or `online`, a closed stream or one silent (no frame, no ping) for 35 s is reopened. Each store's `connection` mirrors the stream's state, or `connecting` while its own snapshot is in flight (`reconnecting` / `offline` while it is retried).

### Shell and routes

`AppShell` switches on `(min-width: 1024px)`: laptops, every iPad in landscape and the 12.9" iPad Pro in portrait get the desktop shell; phones (landscape included) and other iPads in portrait get the phone shell.

| | Desktop (≥1024px) | Phone (<1024px) |
|---|---|---|
| Sidebar | Docked left (280px), shown on load, on every route. A single "Toggle sidebar" button sits at the top of the sidebar while it is shown and alone in a collapsed rail while it is hidden; not persisted | Left sheet (shadcn `Sheet side="left"`) opened from a button in the conversation header; closes on selection |
| `/` | Empty content: "Pick a conversation or start a new one" with a New conversation button | Home: agents from `live`, recent sessions from `GET /api/sessions` |
| Back chevron to Home | Hidden on the conversation header, settings, `/sessions`, "Conversation closed" and other placeholder screens | Shown |
| Settings | Icon beside the sidebar search | Home header, beside the sheet's search |

Share, settings and `/sessions` are routes rendered in the content area on desktop; the sidebar lists every conversation. The review panel (Changes, Files) and the session tree are tabs of a pane beside the conversation instead of routes: `/agents/$agentId/diff` and `/agents/$agentId/tree` open the pane and replace themselves with `/agents/$agentId` ([`07-code-review.md`](07-code-review.md), "Desktop pane").

### Sidebar

```
┌ [⊟]                               ┐  titlebar: toggle sidebar (the sheet's close)
│ [search…                 ] [+] [⚙]│  search · New conversation (project picker) · Settings
│ Active                            │  every live agent, any folder (hidden when none)
│   ● Desktop design… pi-code 2m [×]│  live row · its group's label
│   ◌ Fix flaky… pi-code/wt  now[×]│  a checkout's row: repo/checkout
│ pi-code   ⎇ main              [+] │  group: folder label · branch (live only) · new here
│   ● Desktop design doc      2m [×]│  live row: status dot · title · last prompt · stop or delete
│   ◌ Fix flaky test          now[×]│  working: a neutral spinner replaces the dot
│     Refactor catalog        3d [×]│  closed (on-disk session, exited agent): no mark · delete
│ Kepi/phoenix ◌ ● ›            [+] │  collapsed: hidden rows' marks · chevron
└ phoenix/phoenix               [+] ┘
```

- **Active** = every live agent (in `live.agents`, `status` not `exited`: Working, Needs input, Failed, Finished, Idle) in one flat list above the groups, ordered as rows are (see Ordering), each row followed by a muted project label: its group's label, `repo/checkout` for a checkout's rows (`activeRows`, taken from the displayed groups, so search filters it the same way). The rows look and act like the groups' (mark, title, time, `×`, highlight of the route's agent) and also stay in their groups. The section is hidden while no agent is live, and has no collapse or pin. A row goes when its agent exits (an `agent` frame with `exited`, e.g. pi crashed) or leaves the registry (`agent_closed`, or missing from a baseline): Stop, Delete (`DELETE /api/sessions` closes the agents holding the file) and Remove worktree (`DELETE /api/worktrees` closes the agents inside it) all close through `AgentManager.close`, which sends both. pi still running in a worktree deleted outside pi-code stays listed until stopped.
- **Rows** = every agent in `live.agents` (the registry, exited included) plus every session no agent holds (matched by `agent.sessionFile`). Title: agent `sessionName` / session `name`, else `firstMessage`, else "New conversation". Time = the last prompt, else the creation (see Ordering).
- **Groups** by cwd. Pinned repos come first, by their displayed label (`localeCompare` with base sensitivity and numeric collation: case-insensitive, `app9` before `app10`); the other groups and every group's rows follow Ordering. Label = folder basename, with the parent's basename prepended (`Kepi/phoenix`) when two displayed groups share a basename. The header shows `branches[cwd]` when the folder has a live row.
- **Collapse.** Repo groups, folder groups and linked worktree sub-groups collapse independently; the main checkout's sub-group only hides with its repo, and a missing worktree's or missing folder's keeps no state (it would be pruned), so it shows no toggle. A folder group is missing when one of its sessions has `missing` (its cwd was gone at the latest scan); an agent row takes its session's. Each group is a Radix Collapsible: the header's title (icon, label, branch, marks, chevron) is its trigger, a button with `aria-expanded`; the header's other buttons don't toggle it. The rows open and close with the app's collapsible animation (150 ms height, none under reduced motion; [`09-ui-overhaul.md`](09-ui-overhaul.md), "Motion"), and the chevron after the title points right while collapsed and turns down (rotating 90° in the same 150 ms) when expanded, where it shows only on hover or keyboard focus. Groups start expanded: `sidebar.collapsed` lists the collapsed paths. A collapsed header shows, from the rows it hides, `StatusMark`s (`hiddenMarks`): Working while one is streaming or starting, then the most urgent of Needs input, Failed and Finished, each row read through `agentStatus` (so, as on the rows, a working row's Failed or Finished doesn't count). While the search field has text every group shows expanded and doesn't toggle, the stored state untouched. Opening a conversation by any route (sidebar, search result, Home, notification, URL) uncollapses its groups: `ConversationRoot` calls `registry.expand([cwd, layout repo])` when the agent is first known, which patches only paths that are collapsed; later changes to the collapsed set don't rerun it, so the group can be collapsed again while its conversation is open.
- **Pins.** Every repo header has a pin toggle (`aria-pressed`, "Pin {label}") before New worktree, outlined while unpinned and filled while pinned; it behaves the same on every device. Only layout repos are pinnable. A pinned repo with no conversations still shows its header with its actions (`groupListing`'s `repos` option, so its label takes part in the collision rule), and its main checkout's empty sub-group (from `sidebar.mains`); search results don't add such empty groups.
- **Sidebar state changes** go through `registry.setSidebar(patch)`: applied to `live.sidebar` at once, then `PATCH /api/sidebar`; the answer's flags for the patched paths are adopted (the server skips a folder that is gone), and a failure puts them back and shows a toast. `sidebar` frames replace the state, so other tabs and devices follow live. Home, `/sessions` and the picker have neither pins nor collapse.
- **Row marks:** one `StatusMark` before the title, from the status vocabulary ([`09-ui-overhaul.md`](09-ui-overhaul.md), "Status vocabulary"; `agentStatus` in `lib/agent-status.ts`): a 7px dot in `status-input` for Needs input (a pending dialog or trust prompt), `status-error` for Failed, `status-done` for Finished and `status-idle` (muted) for Idle, while pi runs with nothing to report; a neutral spinner for Working (`isStreaming`, `starting`, or the row's resume or restart in flight); no mark for Closed (exited agents, session rows). The mark is labelled with the word for assistive tech and in its tooltip; it is the row's only status mark. Home shows the same states as icon-plus-word badges. Relative times refresh every 60 s. The row of the route's agent is highlighted.
- **Actions:** New conversation (project picker); search; per-group `+` → `POST /api/agents { cwd }`; `×` on every row, through `useStopOrDelete` ([`08-delete-sessions.md`](08-delete-sessions.md)): on a live row (labelled "Stop or delete {title} ({folder})") it opens the "Stop or delete {title}?" dialog (Cancel, Stop → `DELETE /api/agents/:id`, Delete → `DELETE /api/sessions`); on an exited agent's or a session row (labelled "Delete {title} ({folder})") it deletes at once. A stopped or deleted agent is then `drop`ped, and the `×` is disabled while its request is in flight. Stopping or deleting the route's agent navigates to `/`. Selecting a live row navigates to it; selecting an exited agent's row restarts it (`POST /api/agents/:id/restart`) and then navigates to it; selecting a session row resumes it (`useOpenAgent`). A failed restart or resume shows a toast.
- Home and `/sessions` rows follow the same `×` rule (a session held by an agent follows that agent's), and the conversation header's `⋮` offers Stop and Delete.
- **Search:** non-empty text (200 ms debounce) queries `GET /api/sessions?q=` and replaces the session rows with the results; agents in `live.agents` are filtered client-side on their row title and cwd path. The previous results stay on screen while the next query loads; clearing the field shows every session at once. While the field has text, a themed × button clears it and refocuses the field (the browser's native cancel button is hidden).
- A conversation closed while on screen by something other than its own Stop or Delete (the idle sweep, worktree removal, another tab) shows "Conversation closed" in the content area with New conversation, plus Reopen when its session is still listed with its folder on disk.

### Layout

- **Transcript width.** The transcript and the composer area share one centred column, `mx-auto w-full max-w-[46rem]` (736px), with `px-4` below 1024px and `px-6` from 1024px, on phone and desktop alike. The header spans the width up to the activity rail.
- **Review pane.** At ≥1024px an activity rail (44px) sits at the conversation screen's right edge, with Changes, Files and Tree buttons that open the pane on that tab or close it from the tab showing. With the pane open for the conversation (persisted per conversation, with its tab), the conversation and `ReviewPane` split the width the rail leaves in halves, each `h-dvh` with its own scroll; the column keeps its cap and padding and fits the half left to it. `/diff` toggles it on Changes, `/tree` opens it on Tree. Below 1024px the pane isn't rendered and the review panel is the `/agents/$agentId/diff` page. Details in [`07-code-review.md`](07-code-review.md).
- **Diff split.** `DiffViewer` measures its own width (`useWidthAtLeast`, a `ResizeObserver` on its container) and is split when it is ≥1024px, unified otherwise, whatever the viewport.
- **Conversation sheets.** On desktop, extension dialogs (`DialogHost`) and the trust prompt (`TrustSheet`) are non-modal sheets portalled into the conversation column (their `container` prop; all but the `editor` dialog are centred in it as a card, `sheetCenteredOnDesktop`) with a `ScopedOverlay` dimming only that column, so the sidebar and the rest of the page stay usable. Clicks outside the sheet don't answer it, and neither does Escape pressed outside it; Tab can leave the sheet (`SheetContent loopFocus={false}`), skipping the covered column, which is `inert` while it's open. Inside a dialog, Escape, Cancel and × answer `cancelled`; the trust prompt answers only through its buttons. User-initiated action sheets (rename, model, thinking, stats) stay page-modal. On phone, dialogs and the trust prompt are modal bottom sheets, and outside taps don't cancel them.

## Stream consumers

- **Web client.** The registry is the only stream client (`streamUrl(cursors)` in `lib/api.ts`). Home, the badge sync and the share screen read agents from `live`; the web client doesn't poll `GET /api/agents`, which stays for the harness and scripts. After `POST /api/agents`, `useOpenAgent` navigates and the registry opens the store; the `agent` frame updates the lists.
- **Server test harness** (`testing/http-harness.ts`). `harness.stream({ open?: [agentId, seq][], lastEventId? })` returns a `StreamClient` recording every frame, with `events(agentId)` yielding `{ seq, event }` for one agent in the shape tests assert on. Single-agent tests (`rpc`, `lifecycle`, `push`, `curator`) open one cursor and read `events(id)`.
- **`scripts/smoke.ts`.** Its `Sse` helper opens `/api/stream?open=<id>:<since>` and keeps that agent's `event` frames, taking `seq` from the frame. Scenario 3 asserts the first frame after `open=<id>:<snapshot seq>` has `seq = snapshot seq + 1`, and that `Last-Event-ID: <id>:<seq + 10000>` and `<id>:abc` produce a `resync` frame for the agent.
- **Tests.** `http/events.test.ts` covers the stream: baseline contents, query parsing, `Last-Event-ID` precedence per agent, per-agent `resync` alongside a replaying agent, `agent` frames per info field, `agent_closed`, backlog cutoff, pings. Unit tests: watcher throttle and list diffing, `lastPromptAt` parsing and prompt ordering, sidebar state (idempotent patches, ordering of concurrent patches, pruning) and `PATCH /api/sidebar`, HEAD reading (branch, detached, worktree `.git` file), idle sweep with a fake clock, `q` matching. Web: registry tests with a fake EventSource (refetch on `resync`, baseline-missing stores, attention acks, stale-stream reopen, sidebar frames, optimistic sidebar changes and `expand`); sidebar grouping, labeling, ordering, pins and collapse, and the Active section; diff mode from the viewer's width.

## Limitations

- The branch shows only for folders with a live conversation; pi records no branch (F8), so folders with only on-disk sessions show none.
- Sidebar search filters agent rows on their displayed title (the first message for unnamed sessions) and cwd, while the server's `q` matches session name and cwd only; unnamed on-disk sessions aren't found by their first message, only through their folder, and transcripts aren't searched.
- Opening or refetching a conversation reconnects the whole stream; the baseline is resent and every opened conversation replays from its cursor.
- `catalog` frames resend every session on each change.
- A prompt reorders the lists once pi has written it to the session file and the watcher has rescanned it, not when it is sent.
- A pinned path that stops being a layout repo while its folder stays (its `main` renamed, say) still shows as an empty repo group until unpinned.
- The opened set lives in the tab: after a reload only the conversation in the URL is opened; others are snapshotted when selected.
- Opened conversation stores stay in memory, and in the stream, for the tab's lifetime unless their agent is closed; navigating away doesn't release them, a reload does.
- The idle sweep closes a conversation with no new session entry for 7 days or more (counted from its start at the latest), even with a pending dialog; answering a dialog or trusting a folder writes no entry by itself. Committed entries stay in the session file.
- Without `<agentDir>/sessions` at startup there is no watcher until a restart; pi-code doesn't create pi's agent dir.
- The Mac uses the tailnet URL like other laptops. `localhost:4180` works too (one stream per tab, F11) but is HTTP/1.1.
