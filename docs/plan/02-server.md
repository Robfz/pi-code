# Plan — server

`packages/server`. Design: `design/01-server.md`, contract: `design/02-api-contract.md`.

## Phase 0

### S0 — Protocol spike and fixtures
- Script that spawns `pi --mode rpc`, sends commands from a scenario file, and records every stdin/stdout line with timestamps to `test/fixtures/*.jsonl`.
- Record the fixtures listed in `00-overview.md`; answer the S0 questions there.
- `test/fake-pi.ts`: replays a fixture — waits for each recorded command (matched by `type`), emits the recorded records with the recorded spacing (or instantly in tests).
- Done when: fixtures committed, fake pi passes a self-test, design docs updated with findings.

## Phase 1 — walking skeleton

### S1 — App shell
- Config from env (`design/01-server.md` table), `PI_CODE_HOSTNAME` required.
- Hono app on `127.0.0.1:PORT`; middleware: Host allowlist, JSON content type + same-origin `Origin` on non-GET, error envelope.
- Static SPA serving with the cache rules; `/api/health`.
- Done when: tests cover rejected Host, rejected cross-origin POST, rejected non-JSON POST, SPA fallback.

### S2 — AgentHost
- Spawn, LF-only JSONL reader (UTF-8 streaming decoder), writer with backpressure, id correlation with 60 s timeout, routing of responses / events / UI requests, stderr tail, status transitions, close escalation.
- Done when: tests with fake pi cover a JSON string containing U+2028, CRLF lines, interleaved responses and events, pi exiting mid-command (pending commands reject with `agent_exited`).

### S3 — AgentManager (minimal)
- `open({ cwd })` (cwd inside `$HOME`), `close`, `list`; `POST/DELETE/GET /api/agents`.
- Done when: integration test opens an agent against fake pi, lists it, closes it, and the child process is gone.

### S4 — Pipeline, event log, snapshot
- Sequential per-agent queue: side effects first, then synchronous publish (seq + reduce + log + fan-out); `message_end` / `entry_appended` → `get_entries {since}` → `entries_appended`; ring buffer (10,000); `GET /snapshot`. Agents are registered at spawn, before `ready`.
- Done when: after replaying the "plain answer" fixture, the snapshot's transcript contains the new entries and `live.streaming` is empty; events are strictly ordered even when the entry sync is slow (fake pi delays the `get_entries` response); a snapshot taken at any point plus replay from its `seq` equals the final state.

### S5 — SSE and prompt
- `GET /events` with `since` / `Last-Event-ID`, replay from the ring, `resync` when out of range, 15 s ping, cleanup on disconnect.
- `POST /rpc` with the allowlist (prompt path first).
- Done when: test disconnects a client mid-stream, reconnects with the last id, and the concatenated events equal an uninterrupted client's; an out-of-range id yields `resync`.

## Phase 2 — conversation core

### S6 — Command rules and dialogs
- Full allowlist; `streaming_behavior_required`; `state` refresh after mutating commands; `bash` → `202` + `bash_output` + `bash_done` + entry sync; `POST /ui-responses` (written without awaiting a pi response) with `dialog_not_found`; dialog timeout timers publishing `ui_resolved`.
- Done when: each rule has an integration test against fake pi; the dialog fixture round-trips through the API.

### S7 — Remaining pipeline side effects
- `transcript_reset` triggers (compaction, session-changing commands, leaf mismatch, unknown `since`), entry sync after non-query command responses and `agent_settled`, `stats` after `turn_end`, `get_commands` filtering.
- Done when: the compaction fixture produces a `transcript_reset` whose transcript contains the compaction entry.

## Phase 3 — sessions & projects

### S8 — Session catalog
- Parse headers, latest `session_info`, first user message, timestamps; cache by `(path, mtime, size)`; `ownedBy` from the manager; `GET /api/sessions`, `GET /api/projects`.
- Done when: tests over fixture session files (including v1/v2 formats pi migrates, a file with no assistant message, a malformed line) produce the expected summaries.

### S9 — Path autocomplete
- `GET /api/fs/dirs` rules (home confinement via realpath, dot-dirs, 50 cap, git/session flags).
- Done when: tests cover `~` expansion, a symlink escaping `$HOME` (rejected), dot-dir visibility.

### S10 — Full agent lifecycle
- `open({ sessionFile })` with ownership (existing agent returned), cwd from the header, `--session`; ownership refresh after session-changing commands; `409 session_owned` for `switch_session`; restart of exited agents; project-trust pre-check (protected resources + saved decision in `trust.json`) with `awaiting_trust` and `POST /trust`; `POST /tree/navigate` via the pi-code extension command (check `get_commands` first; `cancelled` when the leaf didn't move).
- Done when: integration tests cover double-open, fork updating `owners`, crash → `exited` with stderr tail → restart resumes the same session file; trust pre-check unit tests (exact/parent/false decisions, missing or garbage file, each protected-resource kind).

## Phase 4 — rendering support

### S11 — Git
- `GET /git/diff` (tracked + untracked, binary / too-large handling, empty repo) and `GET /git/status`; `git_status` after `turn_end` (debounced 2 s).
- Done when: tests against temporary repos cover modified, added, deleted, renamed, untracked, binary and no-HEAD cases, and a non-repo directory.

## Phase 5 — push

### S12 — Web Push
- VAPID key generation/persistence, subscription store with pruning on 404/410, attention state per agent, triggers (finished / failed / input), `POST /ack`, snapshot clearing attention.
- Done when: unit tests map fixtures to the expected pushes (abort → none, error after retries → failed, dialog → input); a manual send reaches the phone.

## Phase 6 — curator & hardening

### S13 — Curator proxy
- Register `token → port` from `details.curatorUrl`; `curator` event; second listener with Host guard; routing by `session` query or cookie; streaming proxy.
- Done when: the curator fixture plus a real curator run is fully usable from the phone (search, select, summarize, submit) and the tool call completes.

### S14 — Lifecycle polish and README
- Graceful shutdown; stderr tail in `agent_status`; README with setup (`mise install`, `pnpm install`, `PI_CODE_HOSTNAME`, the two `tailscale serve` commands, running the server).
- Done when: Ctrl-C with two running agents leaves no pi processes behind.
