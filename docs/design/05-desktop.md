# Desktop and concurrent conversations

Comfortable desktop use with several conversations running at once: a sidebar of live and recent conversations, one multiplexed event stream per browser tab, and a wider layout. Decisions and rationale: [`../../maps/2026-09-30-desktop.md`](../../maps/2026-09-30-desktop.md). Where this document overlaps `01`–`03`, it takes precedence.

Desktop clients are the Mac and other laptops, in a browser tab over the tailnet URL (HTTP/2). One tab holds every conversation; phones use the same stream and keep their screens.

A **live** agent is one whose pi process is running (`starting`, `awaiting_trust`, `ready`). The server's registry (`manager.list()`) also keeps **exited** agents, whose pi died unexpectedly, until they are reopened (which restarts pi) or swept idle; they are not live.

## Live stream — `GET /api/stream`

One `text/event-stream` per tab. It carries agent status and the session catalog for everyone, plus the full event stream of every conversation **opened** in this tab. There is no per-agent event endpoint.

### Request and resume

```
GET /api/stream?open=<agentId>:<seq>,<agentId>:<seq>
```

- `open` lists the tab's opened conversations, each with the last `seq` the client holds. Absent or empty: status and catalog only (phone Home). Agent ids are base64url, so `:` and `,` never occur in them. Unknown agent ids and unparseable pairs are ignored; the client sees the agent's absence in the baseline.
- `Last-Event-ID` carries the same `agentId:seq,…` format. The query decides which agents are streamed; for each, a cursor from `Last-Event-ID` wins over the query's. EventSource reconnects reuse the URL, so the header holds the fresher cursors; a client-initiated reconnect opens a new EventSource with no header and fresh query cursors.
- Per agent, with `oldest` the oldest `seq` in its ring buffer, the cursor replays when `oldest − 1 ≤ seq ≤` the log's `seq`; a caught-up cursor replays nothing. Otherwise (dropped, ahead of the log, not a non-negative integer) that agent gets `resync` and streams live from the log's current `seq`. The other agents are unaffected.

### Framing

Every frame is a default (`message`) event with `data: <StreamFrame JSON>` and `id: <cursor list>`: the connection's current `agentId:seq` pair for every streamed agent whose position is established, in `open` order, updated as each frame is queued, so whatever frame came last is a complete resume point. A resyncing agent joins the list with its `resync` frame (so a reconnect before that frame resyncs it again), and a closed agent leaves it. `retry: 2000`. Every 15 s a named `ping` event (`event: ping`, `data: {}`, no `id:`).

```ts
/** `agentId:seq` pairs joined by `,` — the `open` query value and every SSE `id:`. */
type CursorList = string;

type StreamFrame =
  | { type: "baseline"; agents: AgentInfo[]; sessions: SessionSummary[]; branches: Record<string, string> }
  | { type: "event"; agentId: AgentId; seq: number; event: ServerEvent } // opened agents only
  | { type: "resync"; agentId: AgentId }                  // refetch that agent's snapshot
  | { type: "agent"; agent: AgentInfo }                   // any agent's info changed (or a new agent)
  | { type: "agent_closed"; agentId: AgentId }
  | { type: "catalog"; sessions: SessionSummary[] }       // the 7-day window, replaces the previous one
  | { type: "branch"; cwd: string; branch: string | null }; // null: not tracked or not a repo
```

- `ServerEvent` is the union from `02-api-contract.md` without `resync`, which exists only as a frame. `AgentInfo` is unchanged.
- `baseline.sessions` and `catalog.sessions` hold every session whose `updatedAt` is within the last 7 days, most recent first, without `ownedBy` (it would go stale; clients match agents by `sessionFile`). `baseline.branches` maps cwd → branch for folders with a live agent inside a git work tree.
- `event.seq` duplicates the agent's pair in `id:` so the client never parses ids.

### Connection sequence

1. The server awaits the current catalog window (ready after the startup scan; see Session watcher).
2. In one synchronous block (publishing is synchronous, so nothing falls between replay and subscription): build the baseline from `manager.list()`, the catalog window and the branch map; for each opened agent, replay from its cursor or mark it for `resync`; subscribe to every opened agent's `EventLog`, to the manager's `agent` / `closed` events, and to catalog and branch changes.
3. Write `retry`, `baseline`, then per opened agent either its replayed `event` frames or its `resync`, then live frames as they come.

A connection whose queue exceeds 20,000 live frames is ended: like the per-agent limit in `http/sse.ts`, it bounds memory for a stalled socket (replay isn't counted). EventSource reconnects with `Last-Event-ID` and replays or resyncs per agent. When an opened agent's log closes, its events stop; `agent_closed` tells the client.

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

Every `AgentInfo` change reaches the manager's `agent` event: `publishStatus` reports status and attention, and `AgentPipeline.publish` reports `isStreaming`, `sessionName`, `sessionFile` and `sessionId` whenever an event (`state`, `transcript_reset`, pi events) makes them differ from the last reported info. The hub keeps the current catalog window and branch map in memory, so a baseline is built without I/O.

### Idle sweep

An agent's **activity** is the later of its `startedAt` and its session's `updatedAt` (the last entry's timestamp, written on human and agent turns alike), read from `SessionCatalog`'s cached summaries. `startedAt` is set whenever pi is spawned, restarts included, so reopening an exited agent starts a fresh 7-day clock. An hourly tick closes, through `AgentManager.close` (the `DELETE /api/agents/:id` path), every agent whose activity is at least 7 days old and that isn't streaming, exited agents included; close errors (e.g. `agent_not_found` after a concurrent `DELETE`) are ignored. The same tick recomputes the catalog window, so sessions past 7 days drop out.

### Session watcher

`catalog/watcher.ts` runs `fs.watch(<agentDir>/sessions, { recursive: true })` (FSEvents on macOS), which also sees sessions written by the TUI. Every event, unfiltered, schedules a rescan through a trailing throttle with a 500 ms maximum wait, so continuous writes still produce one every 500 ms. The rescan calls `SessionCatalog.invalidate()`, rescans (unchanged files come from the `(path, mtime, size)` cache), computes the 7-day window, and hands it to the hub, which broadcasts `catalog` when it differs from the current one. The same routine produces the first window at startup. A missing sessions dir logs a warning and leaves the watcher off.

### Folder branches

`git/branches.ts` tracks the branch of each cwd that has at least one live agent, reading git's files directly instead of spawning `git`:

1. **Resolve the git dir once**, when the cwd gains its first live agent: walk up to the first `.git`. A directory is the git dir; a file (worktrees, submodules) holds `gitdir: <path>`, relative to the file's directory. No `.git` → no branch, no watch.
2. **Read `<gitDir>/HEAD`:** `ref: <ref>` → `<ref>` without `refs/heads/`; a bare commit id (detached HEAD) → its first 7 characters.
3. **Watch** `<gitDir>` non-recursively, since a directory watch survives git replacing `HEAD` by rename. Every event re-reads `HEAD`; a changed value → `branch` frame.
4. When the cwd has no live agent left, the watch stops and `branch { branch: null }` goes out.

Per-conversation `git_status` (branch + dirty, status bar) comes from `git` as described in `01-server.md`.

### Catalog endpoint

`GET /api/sessions?cwd=&q=` — `q` (optional) is a case-insensitive substring match against the session's `cwd` path and `name`. It covers all sessions regardless of age; sessions older than the 7-day window are reached through it.

`GET /api/agents/:id/snapshot` has no side effects; attention is cleared only by `POST /ack` and dialog answers (see Live registry).

## Web client

### Live registry

A long-lived `LiveRegistry` (`src/store/live-registry.ts`), created once in `App` and provided by context, owns the tab's single stream and every opened conversation store. Routes own no connection.

```ts
interface LiveOverview {                     // Zustand, read by sidebar, Home, badge, share
  agents: Record<AgentId, AgentInfo>;
  sessions: SessionSummary[];                // 7-day window
  branches: Record<string, string>;
  connection: "connecting" | "live" | "reconnecting" | "offline";
}

interface LiveRegistry {
  live: StoreApi<LiveOverview>;
  open(agentId: AgentId): ConversationStore; // idempotent; the route calls it on mount
  drop(agentId: AgentId): void;              // on agent_closed, or after DELETE
}
```

- **Opening.** `open` creates the `ConversationStore`, fetches `GET /snapshot`, hydrates, then reconnects the stream: a new EventSource whose `open` lists every hydrated store at its `seq` (the snapshot's, then each applied event's). The registry holds one EventSource at a time: a reconnect closes the current one, detaching its handlers, before opening the next, so frames never interleave across sources. Switching between opened conversations costs nothing. Stores stay opened, and keep streaming, until dropped or the tab reloads.
- **Refetch.** `resync`, and an `agent_status` that turns an opened agent `ready`, run opening again for that store. Until it is hydrated again it ignores its frames and is left out of reconnect URLs, so a reconnect meanwhile doesn't resync it twice; what it missed replays after the reconnect that follows the hydrate.
- **Frames.** `event` → that store's `apply(event, seq)`; `agent` / `agent_closed` / `catalog` / `branch` / `baseline` → `live`. `agent_closed` also drops the store; if it was on screen, the route shows it as closed (see Sidebar). On `baseline`, an opened store whose agent is missing from `baseline.agents` (closed while disconnected, server restart) is handled as `agent_closed`. Every `catalog` frame invalidates the `sessions` and `projects` queries, keeping phone Home, `/sessions` and the project picker fresh.
- **Attention.** Background stores re-snapshot too, so snapshots must not clear attention. The registry acks (`POST /ack`) only the conversation on screen: when the route mounts, on `visibilitychange` to visible, and when an `agent` frame raises its attention while the page is visible and `document.hasFocus()`.
- **Liveness.** EventSource reconnects on its own with `Last-Event-ID`. When it gives up (`CLOSED`), or a snapshot fetch fails, the registry retries with backoff (1, 2, 5, 10 s). On visible, or `online`, a closed stream or one silent (no frame, no ping) for 35 s is reopened. Each store's `connection` mirrors the stream's state, or `connecting` while its own snapshot is in flight.

### Shell and routes

`AppShell` switches on `(min-width: 1024px)`: laptops, every iPad in landscape and the 12.9" iPad Pro in portrait get the desktop shell; phones (landscape included) and other iPads in portrait get the phone shell.

| | Desktop (≥1024px) | Phone (<1024px) |
|---|---|---|
| Sidebar | Docked left (280px), shown on load; toggled from a button in the shell chrome, on every route; not persisted | Left sheet (shadcn `Sheet side="left"`) opened from a button in the conversation header; closes on selection |
| `/` | Empty content: "Pick a conversation or start a new one" with a New conversation button | Home: agents from `live`, recent sessions from `GET /api/sessions` |
| Conversation header | No back chevron | Back chevron to Home |
| Settings | Icon in the sidebar footer | Home header |

Tree, diff, share, settings and `/sessions` are routes rendered in the content area on desktop; desktop reaches older sessions through sidebar search.

### Sidebar

```
┌ [+ New conversation]  [search…]   ┐
│ pi-code   ⎇ main              [+] │  group: folder label · branch (live only) · new here
│   ● Desktop design doc      2m [×]│  live row: mark · title · activity · close
│   ◌ Fix flaky test          now[×]│  working: spinner replaces the mark
│     Refactor catalog          3d  │  on-disk session
│ Kepi/phoenix                  [+] │
│ phoenix/phoenix               [+] │
└ ⚙                                 ┘
```

- **Rows** = every agent in `live.agents` (the registry, exited included) plus window sessions no agent holds (matched by `agent.sessionFile`). Title: agent `sessionName` / session `name`, else `firstMessage`, else "New conversation". Activity = the session's `updatedAt`; for an agent, the later of that and its `startedAt` (as in Idle sweep).
- **Groups** by cwd, ordered by their most recent row; rows by activity. Label = folder basename, with the parent's basename prepended (`Kepi/phoenix`) when two displayed groups share a basename. The header shows `branches[cwd]` when the folder has a live row.
- **Row marks:** green dot while the pi process runs; a spinner in its place while `isStreaming` or `starting`; exited agents show no mark. Attention badge beside it: finished, failed, needs input (same colors as Home). The row of the route's agent is highlighted.
- **Actions:** New conversation (project picker); search; per-group `+` → `POST /api/agents { cwd }`; `×` on live rows → `DELETE /api/agents/:id`. Selecting a live row navigates to it; selecting a session row or an exited agent's row resumes it (`useOpenAgent`, which restarts an exited agent).
- **Search:** non-empty text (200 ms debounce) queries `GET /api/sessions?q=` and replaces the window rows with the results; agents in `live.agents` are filtered client-side on the same fields (cwd path, name).
- A conversation closed while on screen shows "Conversation closed" in the content area with the New conversation button.

### Layout

- **Transcript width.** At ≥1024px the conversation column (transcript and composer area) uses the full content width with the standard padding; below 1024px it is capped at `max-w-3xl`.
- **Diff split.** `DiffViewer` measures its own width (`useElementWidth`, a `ResizeObserver` on its container) and is split when it is ≥1024px, unified otherwise, whatever the viewport.

## Stream consumers

- **Web client.** The registry is the only stream client (`streamUrl(cursors)` in `lib/api.ts`). Home, the badge sync and the share screen read agents from `live`; the web client doesn't poll `GET /api/agents`, which stays for the harness and scripts. After `POST /api/agents`, `useOpenAgent` navigates and the registry opens the store; the `agent` frame updates the lists.
- **Server test harness** (`testing/http-harness.ts`). `harness.stream({ open?: [agentId, seq][], lastEventId? })` returns a `StreamClient` recording every frame, with `events(agentId)` yielding `{ seq, event }` for one agent in the shape tests assert on. Single-agent tests (`rpc`, `lifecycle`, `push`, `curator`) open one cursor and read `events(id)`.
- **`scripts/smoke.ts`.** Its `Sse` helper opens `/api/stream?open=<id>:<since>` and keeps that agent's `event` frames, taking `seq` from the frame. Scenario 3 asserts the first frame after `open=<id>:<snapshot seq>` has `seq = snapshot seq + 1`, and that `Last-Event-ID: <id>:<seq + 10000>` and `<id>:abc` produce a `resync` frame for the agent.
- **Tests.** `http/events.test.ts` covers the stream: baseline contents, query parsing, `Last-Event-ID` precedence per agent, per-agent `resync` alongside a replaying agent, `agent` frames per info field, `agent_closed`, backlog cutoff, pings. Unit tests: watcher throttle and window diffing, HEAD reading (branch, detached, worktree `.git` file), idle sweep with a fake clock, `q` matching. Web: registry tests with a fake EventSource (refetch on `resync`, baseline-missing stores, attention acks, stale-stream reopen); sidebar grouping, labeling and ordering; diff mode from the viewer's width.

## Limitations

- The branch shows only for folders with a live conversation; pi records no branch (F8), so folders with only on-disk sessions show none.
- Search matches folder path and session name only; unnamed sessions are found through their folder, and transcripts aren't searched.
- Opening or refetching a conversation reconnects the whole stream; the baseline is resent and every opened conversation replays from its cursor.
- `catalog` frames resend the whole 7-day window on each change.
- The opened set lives in the tab: after a reload only the conversation in the URL is opened; others are snapshotted when selected.
- A conversation with no new session entry for 7 days (counted from its start at the latest) is closed, pending dialogs included; answering a dialog or trusting a folder writes no entry by itself. Committed entries stay in the session file.
- Without `<agentDir>/sessions` at startup there is no watcher until a restart; the agent dir is read-only to pi-code, so it isn't created.
- The Mac uses the tailnet URL like other laptops. `localhost:4180` works too (one stream per tab, F11) but is HTTP/1.1.
