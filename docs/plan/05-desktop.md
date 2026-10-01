# Plan — desktop and concurrent conversations

Spans `packages/protocol`, `packages/server`, `packages/web`, `scripts/smoke.ts`. Design: `design/05-desktop.md`; decisions: `maps/2026-09-30-desktop.md`. The multiplexed stream, resume and the web registry (D1–D7) run end-to-end before the sidebar, watchers, idle policy and layout are layered on; the per-agent endpoint goes last, once nothing uses it, followed by the `02`/`03` doc update.

## Test strategy

- **Server:** integration tests through `testing/http-harness.ts` (real app, agents on the fake pi via `fakePiCommand`); `harness.stream()` records every frame, `events(id)` yields `{ seq, event }` per agent.
- **Watchers:** temp dirs for the sessions dir and git dirs (plain repo, worktree `.git` file, detached HEAD); the watcher throttle and the idle sweep under Vitest fake timers.
- **Web:** registry tests with a fake EventSource (as in `store/connection.test.ts`); component tests for the shell, sidebar and diff mode.

## Core

### D1 — Protocol types
- `packages/protocol/src/types.ts`: `CursorList`, `StreamFrame` (`baseline`, `event`, `resync { agentId }`, `agent`, `agent_closed`, `catalog`, `branch`).
- Done when: `pnpm check` passes.

### D2 — StreamHub and `GET /api/stream`
- `live/stream-hub.ts`: subscribes to the manager's `agent` / `closed` events, holds the catalog window (computed once at startup from `SessionCatalog`: sessions with `updatedAt` within 7 days, most recent first, `ownedBy` stripped) and an empty branch map; builds baselines without I/O.
- `agents/pipeline.ts`: `publish` reports the agent's info through `onAgentInfo` when an event changes `isStreaming`, `sessionName`, `sessionFile` or `sessionId` relative to the last reported info (`publishStatus` keeps reporting its own).
- `http/stream.ts`: parses `open=<id>:<seq>,…` (unparseable pairs and unknown ids ignored), awaits the first window, then in one synchronous block builds the baseline, replays each opened agent's `EventLog` from its cursor and subscribes to logs and hub; per-connection queue drained to the socket, `retry: 2000`, `id:` = current cursor list on every frame except `ping`, 15 s named `ping`.
- Wiring: route mounted in `app.ts` (`AppDeps` gains the hub), hub created in `server.ts` and the harness; `harness.stream({ open?, lastEventId? })` returning a `StreamClient`.
- Tests (`http/events.test.ts`): baseline lists agents and window without `ownedBy`; no `open` → baseline and `agent` frames only; `agent` frames on `agent_start` / `agent_settled` (`isStreaming`), `set_session_name`, and a session switch (`sessionFile`, `sessionId`); two opened agents interleave with correct `seq` and cursor ids; replay from a mid-log cursor equals an uninterrupted client; `agent_closed` on `DELETE`; garbage pairs in `open` ignored; ping.
- Done when: the tests pass with two agents on the fake pi streaming into one connection.

### D3 — Resume and per-agent resync
- `Last-Event-ID` parsed in the same format; the query decides the streamed set, a header cursor wins per agent.
- Per agent: replay when `oldest − 1 ≤ seq ≤ log.seq` (`EventLog.since` semantics); otherwise `resync` then live from `log.seq`. A queue past 20,000 live frames (replay not counted) ends the connection.
- Tests: header cursor wins per agent; one agent resyncs while another replays; a caught-up cursor replays nothing and gets no `resync`; `<id>:abc` and `<id>:<seq+10000>` → `resync` whose `id:` carries the log's `seq`; disconnect mid-run and reconnect with the last `id:` → concatenated events equal an uninterrupted client's for both agents; backlog cutoff with a small limit.
- Done when: the tests pass.

### D4 — Side-effect-free snapshot
- `GET /api/agents/:id/snapshot` in `http/agents-routes.ts` stops clearing attention; `POST /ack` and dialog answers still do.
- Done when: a test fetches the snapshot of a finished agent and attention stays `finished`, then `POST /ack` clears it; existing attention tests (`events.test.ts`, `push.test.ts`) pass with acks.

### D5 — LiveRegistry
- `store/live-registry.ts`: one EventSource on `streamUrl(cursors)` (`lib/api.ts`); `live` Zustand store (`agents`, `sessions`, `branches`, `connection`); `open(id)` (idempotent: create store, snapshot, hydrate, reconnect with every hydrated store at its `seq`) and `drop(id)`; frame routing to stores and `live`; opened stores missing from a `baseline` handled as `agent_closed`; `sessions` and `projects` queries invalidated on every `catalog` frame.
- Refetch: `resync` or `agent_status` turning an opened agent `ready` re-runs opening for that store; until re-hydrated it ignores its frames and is left out of reconnect URLs.
- Liveness: backoff 1/2/5/10 s after `CLOSED` or a failed snapshot; on visible or `online`, reopen when closed or silent 35 s; each store's `connection` mirrors the stream, `connecting` during its own snapshot.
- Tests (`store/live-registry.test.ts`): each hydrate reconnects with every hydrated cursor; switching opened stores → no reconnect; two stores, one resyncing while the other streams, then a stream error and reconnect via `Last-Event-ID` → both stores end with no gaps or duplicates; a reconnect during a refetch omits the refetching store; a store absent from a new `baseline` dropped; `catalog` invalidates both queries; stale-stream reopen; backoff.
- Done when: the tests pass.

### D6 — Conversation route on the registry
- Registry created in `App.tsx` and provided by context; `ConversationRoot` calls `registry.open` instead of owning a `ConversationConnection`; `store/connection.ts`, its test and `eventsUrl` removed.
- Attention: ack the on-screen conversation on route mount, on visible, and when an `agent` frame raises its attention while visible and `document.hasFocus()`.
- Done when: component tests cover the three acks, including no ack from an `agent` frame while the window is unfocused; manual: two conversations running in one tab, airplane mode mid-run, both recover without duplicated or missing text.

### D7 — Home, badge, share and closed state
- Home (`routes/home.tsx`), `features/pwa/badge.ts` and `features/share/share-screen.tsx` read agents from `live`; `listAgents` polling removed; Home keeps `listSessions()` for recent sessions.
- `agent_closed` drops the store; an on-screen closed agent shows "Conversation closed" with New conversation.
- Done when: component tests cover Home and badge from `live` (no `listAgents` call) and the closed state.

## Sidebar

### D8 — Desktop shell
- `features/pwa/app-shell.tsx` switches on `(min-width: 1024px)`: docked 280px sidebar shown on load and toggled (not persisted) from a button in the shell chrome, present on every route (`/tree`, `/diff`, `/settings` included); below, `Sheet side="left"` from the conversation header, closing on selection. Desktop `/` renders the "Pick a conversation or start a new one" screen; `features/conversation/header.tsx` drops the back chevron on desktop; settings icon in the sidebar footer.
- Done when: component tests at both widths cover sidebar presence, toggle on a conversation and a non-conversation route, sheet open/close, `/` content and header chrome.

### D9 — Sidebar rows and actions
- `features/sidebar/`: rows from `live.agents` plus window sessions no agent holds (by `agent.sessionFile`); titles; activity = session `updatedAt`, for agents the later of that and `startedAt`; groups by cwd with collision labels (`Kepi/phoenix`), branch from `live.branches` for folders with a live row; marks (green dot while the process runs, spinner while `isStreaming` or `starting`, none when exited), attention badges, highlighted current row.
- Actions: New conversation (project picker), per-group `+` (`POST /api/agents { cwd }`), `×` on live rows (`DELETE`, then `drop`), select live row → navigate, session row or exited agent's row → `useOpenAgent` (restarts an exited agent).
- Done when: tests cover grouping and ordering, basename collisions, row marks per status, session rows hidden when an agent holds the file, and each action's request.

### D10 — Search
- Server: `GET /api/sessions?q=` in `http/catalog-routes.ts` / `catalog/sessions.ts`, case-insensitive substring on cwd path and name, all ages, combinable with `cwd`.
- Sidebar: 200 ms debounced query replaces window rows with results; live agents filtered client-side on the same fields.
- Done when: server tests over fixture sessions (cwd match, name match, no match, older than 7 days found); sidebar test for debounce and the client-side filter.

## Server feeds

### D11 — Session watcher
- `catalog/watcher.ts`: recursive `fs.watch(<agentDir>/sessions)`; every event, unfiltered, schedules a rescan through a trailing throttle with 500 ms max wait → `invalidate()`, rescan, window → hub, which broadcasts `catalog` when it differs; the startup window uses the same routine; missing dir → warning, no watcher; closed on shutdown.
- Done when: unit tests cover burst coalescing, continuous writes still emitting at least every 500 ms, unchanged window → no frame, missing dir; a harness test writes a session file and a stream receives `catalog`; the watcher is closed on shutdown (`shutdown.test.ts` still passes).

### D12 — Folder branches
- `git/branches.ts`: git dir resolved once per cwd (walk up to `.git`; `gitdir:` file relative to its dir), `HEAD` read (ref without `refs/heads/`, 7-char commit), non-recursive watch of the git dir, `HEAD` re-read on every event, a frame only when the value changes; tracked while the cwd has a live agent, `branch null` when none is left; watches closed on shutdown. Hub feeds `baseline.branches` and `branch` frames.
- Done when: unit tests cover branch, detached, worktree `.git` file, non-repo, checkout via lock-file rename → one `branch` frame, unrelated git-dir events → none, last close → `null` and watch stopped; `shutdown.test.ts` still passes.

### D13 — Idle sweep
- `agents/agent-manager.ts`: `restart` resets `startedAt` (it is set only in the `Agent` constructor today).
- Hourly tick: activity = later of `startedAt` and the session's `updatedAt` (`SessionCatalog.sessions()`, matched by `agent.sessionFile`); closes agents with activity ≥ 7 days old through `AgentManager.close`, exited ones included, skipping streaming ones, ignoring close errors; recomputes the catalog window; stopped on shutdown.
- Done when: with a fake clock the sweep closes an agent whose session was last written 7 days ago, spares one at 6 days 23 h, one started or restarted today on an 8-day-old session and a streaming one at 8 days, closes an exited one, and drops an 8-day-old session from the window.

## Layout

### D14 — Wide transcript and width-based diffs
- `features/conversation/conversation-screen.tsx` applies `max-w-3xl` only below 1024px; `components/diff/diff-viewer.tsx` measures its container (`useElementWidth`, a `ResizeObserver`) and splits at ≥1024px instead of `WIDE_QUERY`.
- Done when: diff-viewer tests show split at 1024px viewer width and unified at 1023px regardless of viewport; the transcript class changes only at ≥1024px.

## Migration

### D15 — Server tests on the stream
- `rpc`, `lifecycle`, `push`, `curator` and `events` tests move from `harness.sse(id, …)` to `harness.stream({ open: [[id, seq]] }).events(id)`, opening at the snapshot `seq` where they had one. Live-only tests (no resume point, e.g. "streams only new events…") open at `agent.pipeline.log.seq`, read synchronously just before `harness.stream`. "Stream ends on close" asserts `agent_closed` instead. `harness.sse()` and `SseClient` removed.
- Done when: `pnpm test` passes with no reference to `/events` in `packages/server/src` outside the route.

### D16 — Remove the per-agent endpoint
- `GET /api/agents/:id/events` and `http/sse.ts` removed; `resync` removed from `ServerEvent` (protocol tests updated).
- `scripts/smoke.ts`: `Sse` opens `/api/stream?open=<id>:<since>` and keeps that agent's `event` frames with `seq` from the frame; scenario 3's resume asserts (~507–523) check `seq = snapshot seq + 1` after `open=<id>:<snapshot seq>` and `resync` for `Last-Event-ID: <id>:<seq+10000>` and `<id>:abc`; scenario 4's cursorless `new Sse(agentId)` opens at a snapshot `seq` fetched first; scenario 11 expects `agent_closed`.
- Done when: `pnpm check && pnpm test` pass; the smoke script passes against the real pi (README instructions).

### D17 — Update the API and web-client docs
- `docs/design/02-api-contract.md`: `/api/stream` and `StreamFrame` in place of `GET /api/agents/:id/events`; `resync` only as a frame; snapshot without side effects; `GET /api/sessions?q=`.
- `docs/design/03-web-client.md`: `LiveRegistry` in place of the per-route connection; desktop shell and sidebar; Home, badge and share fed by `live`; acks from the on-screen conversation.
- Done when: neither doc mentions the per-agent endpoint or snapshot-cleared attention, and both link `05-desktop.md`.

## End-to-end verification

On the Mac over the tailnet URL: open three conversations in different folders (two in one repo on different worktrees), prompt two at once and switch between them mid-run; the sidebar shows spinners, branches and attention marks. Turn Wi-Fi off for a minute mid-run, then back on: every opened conversation resumes without gaps or duplicates, and finished/failed marks on background conversations survive. Start a TUI session in another folder: it appears in the sidebar within a second. `git switch` in a live folder updates its branch. Repeat on the phone at <1024px: sheet sidebar, Home and Sessions as before.
