# Server design

Hono on Node (latest LTS via mise). One process, started by hand. Source: `packages/server`.

```
src/
  main.ts            config, listeners, graceful shutdown
  http/              Hono app: middleware (host/origin guards), routes, the live stream, static SPA
  agents/            AgentHost (process + RPC client), AgentManager, event pipeline, event log, idle sweep
  live/              StreamHub: shared inputs of the live stream
  catalog/           projects, sessions, path autocomplete, session watcher
  git/               diff + status, folder branches
  push/              VAPID keys, subscriptions, triggers
  curator/           curator proxy listener
  store/             small JSON files in the data dir
```

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `PI_CODE_PORT` | `4180` | Main listener, `127.0.0.1` only |
| `PI_CODE_CURATOR_PORT` | `4181` | Curator proxy listener, `127.0.0.1` only |
| `PI_CODE_HOSTNAME` | required | Tailnet hostname, e.g. `mac.tail1234.ts.net`; used for the Host allowlist and origin checks |
| `PI_CODE_PI_BIN` | `pi` on `PATH` | pi executable |
| `PI_CODE_DATA_DIR` | `~/.config/pi-code` | VAPID keys, push subscriptions |
| `PI_AGENT_DIR` | `~/.pi/agent` | Read-only: sessions, trust.json |

Tailscale setup (documented in the README, not automated):

```
tailscale serve --bg --https=443  http://127.0.0.1:4180
tailscale serve --bg --https=8443 http://127.0.0.1:4181
```

## Agents

### AgentHost — one pi process

Spawns:

```
pi --mode rpc --extension <pi-code extension path> [--session <file>]
```

with `cwd` = the project directory and `PI_CODE_TRUST=yes|no` in the environment when the user just made a trust decision (see Project trust). Without `--session`, pi starts a new session in that cwd.

Responsibilities:

- **Framing.** Read stdout as UTF-8 and split on `\n` only (strip a trailing `\r`). Never use `readline`: it also splits on U+2028/U+2029, which are valid inside JSON strings. Write one JSON object + `\n` per command, honoring stdin backpressure.
- **Correlation.** Every command gets an `id`; a map of pending promises resolves on the matching `response`. `extension_ui_response` is the exception: pi sends no response, so it is written without a pending entry. `parse` errors (no id) are logged.
- **Routing.** stdout records are `response` → pending map; `extension_ui_request` → pipeline; everything else is a session event → pipeline.
- **stderr** is diagnostics only: kept in a bounded tail (last 200 lines) exposed on crash.
- **Lifecycle.** `status: awaiting_trust | starting | ready | exited`. The agent is registered before spawn; its pipeline runs from spawn; it becomes ready after the first successful `get_state`. On unexpected exit, the agent becomes `exited` with `exitCode` and stderr tail; it stays listed so the client can restart it (respawn with `--session <last file>`) until it is closed (by the user or the idle sweep). Closing: end stdin (pi disposes and exits), SIGTERM after 5 s, SIGKILL after 10 s.

The pi-code extension path resolves to `packages/pi-extension/src/index.ts` (pi loads TypeScript extensions directly).

### AgentManager — the registry

- `agents: Map<agentId, Agent>` and `owners: Map<sessionFile, agentId>`.
- `open({ cwd })` → new agent, new session.
- `open({ sessionFile })` → if already owned, return the existing agent; else spawn with `--session` and `cwd` read from the session header.
- `close(agentId)` → stop process, drop ownership (`DELETE /api/agents/:id` and the idle sweep).
- Emits `agent` on every `AgentInfo` change and `closed` when an agent is removed; the StreamHub turns them into frames.
- After any command that can change the session (`new_session`, `switch_session`, `fork`, `clone`, the tree-navigation command), refresh `get_state` and update `owners`. A `switch_session` to a file owned by another agent is rejected before reaching pi (`409`).
- `cwd` must resolve inside `$HOME` (realpath), else `400`.

### Project trust

RPC mode can't prompt for trust (`docs/spikes/e1-e2.md`), so the server decides whether to ask before spawning:

1. **Protected resources?** Any of `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` in the cwd, or `.agents/skills` in the cwd or an ancestor (excluding `~/.agents/skills`). Mirrors pi's `hasTrustRequiringProjectResources`; re-check on pi upgrades.
2. **Saved decision?** The closest entry for the cwd's realpath or a parent in `~/.pi/agent/trust.json` (read-only).
3. Resources and no saved decision → the agent is created with `status: "awaiting_trust"` and attention `input` (push notification). The client answers with `POST /api/agents/:id/trust`; the server then spawns pi with `PI_CODE_TRUST=yes|no`, and the pi-code extension returns it with `remember: true`, so pi saves it to `trust.json`.
4. Otherwise → spawn immediately without the variable.

### Event pipeline

All records from one agent flow through a single **sequential** async queue, so side effects (entry syncs) never reorder events. For each record:

1. **Side effects** (may await pi) produce the list of server events to publish:
   - `message_end`, `entry_appended`, `agent_settled`, and every non-query command response (many commands create entries without an event: names, model/thinking changes, labels, `bash`) → `get_entries { since: lastEntryId }` → emit `entries_appended { entries, leafId }` when non-empty. If the returned `leafId` is not the last appended entry, or `since` is unknown, fall back to a full `get_entries` and emit `transcript_reset`.
   - `compaction_end`, and completion of `new_session` / `switch_session` / `fork` / `clone` / tree navigation → full `get_entries` + `get_state` → `transcript_reset`.
   - `tool_execution_update|end` whose `details.curatorUrl` is set → register the curator session with the curator proxy and emit `curator { toolCallId, url }`.
   - `agent_settled`, dialog `extension_ui_request`, run failure → notification triggers (see Push).
   - `turn_end` → `get_session_stats` → emit `stats`; refresh git status (debounced) → emit `git_status`.
   - `bash` completion → emit `bash_done`, then sync entries (the `bashExecution` entry has no `message_end`).
2. **Publish**, synchronously per event: assign the next `seq`, reduce into `LiveState` with the shared reducer (`@pi-code/protocol`), update the cached transcript/state, append to the event log, fan out to the log's subscribers (live-stream connections that opened the agent). Nothing awaits inside this step, so state and `seq` always advance together.

`message_update` deltas are forwarded as-is (pi already strips cumulative partials on the wire).

### Event log

A ring buffer of the last 10,000 events per agent, each `{ seq, event }`. `seq` is per-agent and monotonic for the agent's lifetime. Replay from a live-stream cursor (from `open=` or `Last-Event-ID`) succeeds if `seq + 1` is still in the buffer (or the cursor is caught up); otherwise that agent gets a `resync` frame. When the agent is removed, the log closes and its subscribers stop.

### Snapshot

`GET /api/agents/:id/snapshot` returns `{ agent, state, transcript, live, seq }` where `transcript` is the server's cached entry list (kept current by the pipeline), `live` the reducer state, and `seq` the last event's seq. Built synchronously from memory, so it always reflects exactly the events up to `seq`. It has no side effects; in particular it leaves attention as it is.

## Live stream

`GET /api/stream` (contract in `02-api-contract.md`, design in [`05-desktop.md`](05-desktop.md)): one SSE connection per browser tab. `http/stream.ts` parses the cursors, replays and subscribes to each opened agent's event log in one synchronous block, and drains a per-connection frame queue to the socket with pings. `live/stream-hub.ts` (**StreamHub**) owns the inputs every connection shares: the manager's `agent` / `closed` events, the 7-day catalog window and the folder branch map, kept in memory so a baseline needs no I/O.

- **Session watcher** (`catalog/watcher.ts`): `fs.watch` on pi's sessions dir, recursive, TUI sessions included. Changes trigger a rescan (trailing throttle, 500 ms); the hub broadcasts `catalog` when the window differs.
- **Folder branches** (`git/branches.ts`): for each cwd with a live agent, the git dir is resolved once (worktree `.git` files included), watched non-recursively, and `HEAD` re-read on every event; changes go out as `branch` frames.
- **Idle sweep** (`agents/idle-sweep.ts`): hourly, recomputes the catalog window and closes every non-streaming agent, exited included, whose activity (the later of `startedAt` and its session's last entry) is at least 7 days old.

### Commands

`POST /api/agents/:id/rpc` forwards a pi `RpcCommand` (allowlisted, see the API contract) and returns pi's `RpcResponse.data`. The server:

- Rejects `prompt` while a run is active unless `streamingBehavior` is set (pi would reject it too; failing early gives a clear error).
- Serializes session-changing commands per agent.
- After state-mutating commands (`set_model`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, queue modes, auto compaction/retry, `set_session_name`) refreshes `get_state` and emits `state`.
- Runs `bash` without holding the HTTP request: returns `202 { id }`, streams pi's `bash_execution_update` as `bash_output`, emits `bash_done` with the result.
- Filters `pi-code-*` commands out of `get_commands` results.
- Never forwards `export_html` (writes files on the host; not in scope).

Dialog answers go through `POST /api/agents/:id/ui-responses`, written to pi as `extension_ui_response`, and remove the request from live state. Dialogs sent with a `timeout` get an `expiresAt`. pi resolves them itself on expiry without any event, so the server schedules a timer that removes the dialog, clears `input` attention and publishes `ui_resolved`.

## Catalog

Read-only over `~/.pi/agent/sessions`, parsing the documented session format.

- **Session summary** per file: header (`id`, `cwd`, `timestamp`, `parentSession`), latest `session_info` name, first user message text (truncated to 200 chars), last entry timestamp, file mtime, `ownedBy` (agentId if open in the web). Cached by `(path, mtime, size)`.
- **Search** — `GET /api/sessions?q=`: case-insensitive substring match on the session's `cwd` path and name, over all sessions whatever their age.
- **Projects** = distinct header `cwd`s, sorted by most recent session activity, with session counts. Directory names are not trusted (lossy); only header `cwd`s are used.
- **Path autocomplete** — `GET /api/fs/dirs?prefix=~/De`: expands `~`, lists directories only, requires the realpath to stay inside `$HOME`, hides dot-directories unless the typed segment starts with `.`, returns at most 50 entries, and flags which are git repos and which have pi sessions.

## Git

Runs `git` with `cwd` = the agent's cwd, 10 s timeout, no shell.

- **Diff** (explicit action): `git diff HEAD --patch --no-color --no-ext-diff` plus untracked files from `git ls-files --others --exclude-standard`, each rendered as a new-file patch (`git diff --no-index /dev/null <file>`). Returns per-file `{ path, oldPath?, status, patch, binary }`. Files over 1 MB are listed without patch. Non-repo → `404 not_a_git_repo`. Empty repo (no HEAD) → diff against the empty tree.
- **Status** (status bar): `git rev-parse --abbrev-ref HEAD` + `git status --porcelain=v1 -uno` → `{ branch, dirty }`.

## Push

- VAPID keys generated on first run, stored in `DATA_DIR/vapid.json`. Subscriptions in `DATA_DIR/push-subscriptions.json`, keyed by endpoint; removed on `404/410` from the push service.
- Uses the `web-push` library; TTL 1 h; urgency `high` for dialogs, `normal` otherwise.
- **Attention.** Each agent has `attention: none | finished | failed | input`. Set by the triggers below; `POST /ack` (the web client acks the conversation on screen) clears `finished` and `failed`, but leaves `input` while a dialog or the trust prompt is pending; `input` clears when the last pending dialog is answered or times out, the trust prompt is answered, or pi exits. Fetching a snapshot leaves it unchanged. The push payload carries the total count of agents needing attention for the badge.
- **Triggers:**

| Trigger | Detection | Payload |
|---|---|---|
| Run finished | `agent_settled` after a run whose last assistant message has `stopReason` `stop` / `length` | title: session name or project; body: last assistant text (first 140 chars) |
| Run failed | `agent_settled` after a run whose last assistant `stopReason` is `error` (retries exhausted) | body: `errorMessage` |
| Input needed | `extension_ui_request` with method `select` / `confirm` / `input` / `editor` | body: dialog title |

User aborts (`stopReason: aborted`) notify nothing. Payload: `{ kind, agentId, title, body, badge, url: "/agents/<id>" }`.

## Curator proxy

The pi-web-access search curator starts a server on `127.0.0.1:<random port>` and serves a page with root-relative URLs (`/events`, `/submit`, …) authenticated by a `session` token (query string on GETs, JSON body on POSTs).

- The pipeline extracts `port` and `token` from `details.curatorUrl` and registers `token → port` (expires with the curator's own lifetime, or 30 min).
- The curator listener (`127.0.0.1:4181`, same Host guard) routes each request by token: from the `session` query parameter, else from a `pi_code_curator` cookie set (HttpOnly, SameSite=Strict, Secure) when the page is first loaded. Unknown token → `404`.
- Proxies to `http://127.0.0.1:<port>` preserving path and query, streaming responses (SSE included).
- The client receives `curatorProxyUrl = https://<hostname>:8443/?session=<token>` and opens it in a new tab.

## Static SPA

Serves `packages/web/dist` with long-cache hashed assets, `index.html` fallback for client routes, `no-cache` for `index.html`, `sw.js` and `manifest.webmanifest`.

## Shutdown

SIGINT/SIGTERM → stop accepting requests, the session watcher and the idle sweep → close every agent (end stdin, same escalation as `close`) in parallel → close the branch watches and remaining connections → exit.
