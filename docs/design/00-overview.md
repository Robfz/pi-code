# pi-code — System design overview

pi-code is a personal, mobile-first web client for the [pi](https://github.com/earendil-works/pi) coding agent. It drives the same pi installation, configuration, extensions and session files as the pi TUI; only the rendering layer differs.

Decisions and their rationale live in [`../../maps/2026-09-26-origin.md`](../../maps/2026-09-26-origin.md). This document set describes the resulting system:

| Document | Scope |
|---|---|
| `00-overview.md` | Goals, topology, components, cross-cutting flows, security |
| `01-server.md` | The Node server: pi process management, event pipeline, catalog, git, push, curator proxy |
| `02-api-contract.md` | HTTP + SSE contract between web client and server, shared protocol package |
| `03-web-client.md` | The React PWA |
| `04-pi-extension.md` | The pi-code pi extension (project trust, tree navigation) |
| `05-desktop.md` | Desktop and concurrent conversations: multiplexed stream, sidebar, idle policy, wide layout |

## Goals

- Feature parity with the pi TUI for a single conversation, usable from an Android phone.
- Agent runs keep going with no browser attached; reconnecting shows the exact live state, including in-flight streaming, running tools and pending dialogs.
- All installed extensions keep working; where RPC drops their TUI rendering, pi-code renders natively.
- Push notifications when a run finishes, fails, or waits for input.

## Non-goals (deferred in the map)

Multiple concurrent sessions as a first-class workflow, MCP Apps and MCP URL elicitation on mobile, an embedded terminal, tool-call approval, inline before/after for `write` overwrites, list virtualization, launchd service, editing pi settings / providers / packages from the web.

## Constraints

- Single user; reachable only over the owner's tailnet.
- pi runs on the host with the owner's full permissions (accepted risk).
- Integration is `pi --mode rpc` only — pi's documented, stable protocol. The server never imports pi internals; it imports pi's exported **types** only.
- Everything runs on one Mac. Server started by hand.

## Topology

```
 Android phone (PWA)                               Mac
┌──────────────────┐   tailnet HTTPS    ┌─────────────────────────────────────────────┐
│ React SPA        │ ── :443 ────────▶ │ tailscale serve ──▶ 127.0.0.1:4180  server  │
│ Service worker   │ ── :8443 ───────▶ │ tailscale serve ──▶ 127.0.0.1:4181  curator │
└──────────────────┘                    │                                  proxy      │
        ▲                               │  server ──stdin/stdout JSONL──▶ pi --mode rpc│
        │ Web Push (via FCM)            │         (one child per open session)        │
        └───────────────────────────────│  server ──▶ git, ~/.pi/agent/sessions (read)│
                                        └─────────────────────────────────────────────┘
```

## Components

| Component | Package | Responsibility |
|---|---|---|
| Server | `packages/server` | Hono on Node. Spawns and supervises pi RPC processes, owns live state and the event log, serves the API, SSE, SPA, push, curator proxy. |
| Protocol | `packages/protocol` | Shared TypeScript: API/SSE types and the **live-state reducer** used by both server (snapshots) and client (live UI). |
| Web client | `packages/web` | React + Vite SPA, installable PWA with service worker (push, badge, share target). |
| pi extension | `packages/pi-extension` | Loaded with `--extension` into server-spawned pi processes only: records the web's project-trust decision, in-place tree navigation command. |

## Core concepts

- **Agent** — one `pi --mode rpc` child process, owned by the server, bound to one session file at a time. Identified by a server-generated `agentId`. Lives until the user closes it (or the server stops).
- **Session** — a pi session file (`~/.pi/agent/sessions/--<cwd>--/*.jsonl`). An agent can move between sessions (new / fork / clone), as in the TUI.
- **Committed transcript** — session entries fetched from pi with `get_entries` (stable entry ids, tree via `parentId`). Source of truth for history.
- **Live state** — what is in flight and not yet committed: the streaming assistant message, running tools, pending dialogs, extension status/widgets, queue, compaction/retry status. Produced by one reducer over pi events.
- **Event log** — per-agent sequence-numbered log of server events (`seq`), kept in a bounded ring buffer so SSE clients resume with `Last-Event-ID`.

## Key flows

**Prompt.** Client POSTs a `prompt` command → server forwards to pi (with `streamingBehavior` when a run is active) → pi streams events → server reduces them into live state, appends them to the event log, fans them out over SSE → on each `message_end` the server fetches new entries (`get_entries {since}`) and emits `entries_appended` → client moves the message from live to committed.

**Reconnect.** Client fetches `GET /api/agents/:id/snapshot` (committed entries + live state + `seq`), then opens SSE with `Last-Event-ID: seq`. If the log no longer holds that `seq`, the server sends `resync` and the client refetches the snapshot.

**Extension dialog.** pi emits `extension_ui_request` (select/confirm/input/editor) → server records it in live state (so it survives reconnects), pushes a notification, fans it out → client answers via `POST /ui-responses` → server writes `extension_ui_response` to pi and clears it.

**Notification.** On run finished / run failed / dialog waiting, the server sends a Web Push to every subscription. The service worker skips showing it when a pi-code window is focused, and sets the app badge to the payload's attention count.

**TUI handoff.** Web-side ownership only: the server tracks which session files its agents hold and never opens one twice. Closing an agent in the web UI stops its pi process, which hands the session back to the TUI. The TUI is not prevented from opening a web-owned session (accepted).

## Security

pi is remote code execution by design, so the server is the security boundary for "only me":

- Binds `127.0.0.1` only; reachable from outside solely through `tailscale serve` (tailnet-only HTTPS).
- **Host allowlist** — requests must carry `Host` equal to the configured tailnet hostname or `localhost:<port>`. Prevents DNS-rebinding pages in a Mac browser from reaching the loopback port.
- **Same-origin mutations** — every non-GET request must have `Content-Type: application/json` and an `Origin` matching the server's own origin. Prevents drive-by cross-site requests from any page open on the phone (the phone is on the tailnet, so a malicious page could otherwise POST a prompt).
- No app login: nobody else is on the tailnet. If that changes, add a `Tailscale-User-Login` check in the same middleware.

## Known limitations

- Stopping the server kills all agents: in-flight runs and pending dialogs are lost; committed entries survive in the session files.
- When the search curator or MCP OAuth is triggered, pi also tries to open a browser on the Mac (shared config; left unchanged so the TUI keeps auto-opening).
- MCP Apps and MCP URL elicitation don't work from the web (deferred).
- Opening a web-owned session in the TUI at the same time corrupts the branch structure (pi has no session locking).

## Design choices made while drafting

Beyond the map, these were chosen while designing and are open to veto:

1. A shared reducer package (`protocol`) so server snapshots and client live state can never disagree.
2. The committed transcript comes from `get_entries`, not `get_messages`, to keep ids, compaction markers and the tree.
3. The curator proxy runs on its own port (4181 → tailnet :8443) because the curator page uses root-relative paths that would collide with the SPA.
4. Host allowlist + same-origin mutation checks (see Security).
5. In-place tree navigation via a pi-code extension command, since RPC lacks it.
6. Built-in slash commands (`/compact`, `/model`, `/tree`, …) are implemented by the web client as UI actions; only extension/skill/template commands are sent to pi as prompts.
