# Implementation plan — overview

One milestone containing every settled feature (see `maps/2026-09-26-origin.md`). Inside it, work is ordered so the load-bearing core — pi process ↔ event pipeline ↔ SSE ↔ reconnect — runs end-to-end before features are layered on.

Component plans:

| File | Component | Task prefix |
|---|---|---|
| `01-protocol.md` | Shared types + live-state reducer | `P` |
| `02-server.md` | Hono server | `S` |
| `03-web-client.md` | React PWA | `W` |
| `04-pi-extension.md` | pi-code pi extension | `E` |
| `05-desktop.md` | Desktop and concurrent conversations: multiplexed stream, sidebar, idle policy, wide layout | `D` |
| `06-worktrees.md` | Git worktrees: repo grouping on every listing, creating and removing worktrees | `T` |
| `07-delete-sessions.md` | Deleting sessions: `DELETE /api/sessions`, Stop and Delete on every listing and the header menu | `X` |

## Repository setup (task R1)

```
pi-code/
  .mise.toml              node = "lts", pnpm
  package.json            pnpm workspaces, root scripts (dev, build, test, check)
  pnpm-workspace.yaml     packages/*
  tsconfig.base.json      strict, ES2023, moduleResolution bundler
  biome.json              lint + format
  packages/protocol       TS source, consumed directly by server and web
  packages/server         run with tsx (dev: tsx watch)
  packages/web            Vite
  packages/pi-extension   TS source, loaded by pi
  test/fixtures/          recorded pi RPC transcripts
  docs/
```

- `@earendil-works/pi-coding-agent` as a dev dependency of `protocol` (type-only imports), version matching the installed `pi`.
- Tests: Vitest everywhere; `@testing-library/react` for web components.
- Done when: `pnpm install && pnpm check && pnpm test` pass on an empty skeleton.

Tooling choices made while drafting (open to veto): pnpm, Biome, Vitest, tsx, Node LTS as "latest stable".

## Test strategy

- **Recorded fixtures.** Real `pi --mode rpc` sessions captured to JSONL (commands in, records out) for: a plain answer, tool calls, parallel tools, steer/follow-up, abort, compaction, auto-retry, extension dialog, subagent run, web search with curator.
- **Fake pi** (`test/fake-pi.ts`): a Node script that speaks the RPC protocol and replays a fixture, so server and reducer tests are deterministic and cost nothing.
- **Reducer** tests: every fixture reduced end-to-end, snapshot of the final `LiveState`; plus "reduce prefix → snapshot → reduce rest" equals "reduce all" (the reconnect invariant).
- **Server** integration tests against fake pi through the real HTTP/SSE API.
- **Phone checklist** run manually on Android at the end of each phase.

## Phases

| Phase | Goal | Tasks |
|---|---|---|
| 0. Spikes | Verify the assumptions the design rests on | E1, E2, S0 |
| 1. Walking skeleton | Prompt from the phone, see streamed text, survive a reconnect | R1, P1, P2, S1–S5, W1–W3 |
| 2. Conversation core | Tools, queue, abort, dialogs, extension UI, entries sync, resync | P3, S6–S7, W4–W6 |
| 3. Sessions & projects | Catalog, picker, open/close/restart, new/fork/clone, tree, trust | E3, E4, S8–S10, W7–W9 |
| 4. Rendering & controls | All tool renderers, diffs, git diff, status bar, models, slash commands, bash, images | S11, W10–W15 |
| 5. PWA | Install, push, badge, share target | S12, W16–W18 |
| 6. Curator & hardening | Curator proxy, crash handling polish, README | S13, S14, W19 |
| 7. Git worktrees | Repo grouping on every listing, create and remove worktrees | T1–T12 |
| 8. Delete sessions | Delete one session at a time from every listing; Stop and Delete replace Close | X1–X7 |

Exit criterion per phase: its tasks' "done when" pass, plus the phone checklist for that phase.

## Spikes (phase 0) — done

Findings: `docs/spikes/e1-e2.md`, `docs/spikes/s0.md`; the design docs incorporate them. Each spike was a throwaway script against the real `pi --mode rpc`; its outcome is written back into the design docs.

- **E1 — trust over RPC.** Does `project_trust` fire in RPC mode with a working `ctx.ui.confirm` round trip at startup, and does `remember: true` write `trust.json`? If it doesn't work, stop and revisit the trust decision with the user before building E3.
- **E2 — command completion.** Does the `prompt` response for an extension command arrive after the handler finishes? Decides whether the `pi-code:` status channel is needed.
- **S0 — entries & protocol shape.** Confirm `get_entries` returns all entry types (compaction, branch_summary, custom_message, label…) with the documented fields; capture the first fixtures; confirm built-in slash commands sent via `prompt` are not executed (so the web client must implement them).

## Phone checklist (cumulative)

1. Open `https://<host>` on Android; start a conversation; watch text stream.
2. Lock the phone mid-run for a minute; unlock → the run's progress is intact and live.
3. Kill Chrome mid-run; reopen → same.
4. Answer an extension dialog; steer and queue while running; stop & edit.
5. Resume an older session; fork; navigate the tree with a summary.
6. See edit diffs inline; open the git diff.
7. Install to the home screen; receive notifications for finish, failure, dialog; badge count; tap opens the right conversation.
8. Share a link from another app into a new prompt.
9. Trigger a web search with the curator; review it from the phone.
