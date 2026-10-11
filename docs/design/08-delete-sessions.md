# Deleting sessions

pi-code deletes one conversation at a time from every listing surface except the share screen, to reduce clutter and free disk space. Decisions and rationale: [`../../maps/2026-10-09-delete-sessions.md`](../../maps/2026-10-09-delete-sessions.md). Where this document overlaps `01`–`07`, it takes precedence.

pi has no delete primitive (F1), so the server deletes the session's `.jsonl` itself. That and worktree removal ([`06-worktrees.md`](06-worktrees.md)) are pi-code's only writes to pi's agent dir. The user-facing actions on a conversation are **Stop** (`DELETE /api/agents/:id`: pi stops, the conversation stays listed) and **Delete**; there is no "Close".

## Server: `DELETE /api/sessions`

```ts
interface DeleteSessionBody { file: string }
```

The route (`http/sessions-routes.ts`) has the `Origin` and JSON guards of every mutation; its `trashCommand` is injectable for tests, as in the worktree routes.

1. `file` is a non-empty absolute string, else `400 invalid_body`.
2. Canonicalize: the realpath of `file` when it exists, else `file` normalized. Agents' `sessionFile`s and the catalog's `file`s are realpaths, so plain equality matches them.
3. Every agent, live or exited, whose `sessionFile` is that path is closed through `AgentManager.close` (`agent_not_found` ignored), as in worktree removal, before the file is touched: a running pi would recreate it (F2).
4. `catalog.invalidate()`, then the file is **listed** when `catalog.sessions()` has a summary with that `file`. Only listed files (`<agentDir>/sessions/<dir>/*.jsonl` with a session header) are ever deleted, never an arbitrary `.jsonl` under `$HOME`.
5. Listed → `deleteSessionFiles([file], trashCommand)` (`catalog/session-files.ts`): `trash`, else `unlink`, as in worktree removal. A file left over → `500 internal` "could not delete session file: <file>".
6. Not listed and on disk → `400 session_not_listed`, naming the file. When step 3 stopped an agent, the message says so: the conversation was stopped, but its file, outside pi's sessions folder or not a listed session, was kept (F9).
7. Not listed and not on disk → `204`: already gone, or a new conversation whose file pi hasn't written yet (F8).
8. `hub.refreshCatalog()` runs in a `finally`, failures included, so `catalog` drops the session; the closed agents produce `agent_closed` through the manager. → `204`.

## Web client

`deleteSession(file)` (`lib/api.ts`) sends the route. `StopOrDeleteProvider` (`features/sessions/stop-or-delete.tsx`), mounted once in `AppShell` like `WorktreeActionsProvider`, owns the one Stop-or-Delete dialog; every surface reaches it through `useStopOrDelete()`.

### The `×` rule

Every row of the sidebar (desktop and the mobile sheet), Home ("Open conversations" and "Recent sessions") and `/sessions` has a `×`:

| Row | `×` |
|---|---|
| Live agent (status not `exited`) | Dialog "Stop or delete {title}?": Cancel (outline), Stop, Delete (destructive); dismissible |
| Exited agent | Deletes, no dialog |
| Session no agent holds | Deletes, no dialog |
| Home or `/sessions` session held by an agent (the `live.agents` entry whose `sessionFile` is the row's file) | The holding agent's rule |

- Labels: "Stop or delete {title} ({folder})" on live rows, "Delete {title} ({folder})" on the others.
- On Home and `/sessions` the `×` is a sibling of the row's button, never nested in it. The share screen has none.
- A row's `×` is disabled while its own request runs; other rows stay usable.
- In a missing worktree, session rows and exited agents stay disabled for opening, but their `×` works.

### Header menu

The conversation header's `⋮` offers Stop and Delete (destructive, no dialog: choosing it is the decision).

### Stop and Delete

- **Stop**: `DELETE /api/agents/:id`, then the registry's `drop`.
- **Delete** of a session row: `deleteSession(file)`.
- **Delete** of an agent's conversation: `deleteSession(agent.sessionFile)`, the server stopping the agent; without a `sessionFile` yet (F8), only Stop. Then `drop`, as Stop does.
- After a delete, the `sessions` and `projects` queries are invalidated: Home and `/sessions` don't follow the `catalog` frame, which covers only the 7-day window.
- Stopping or deleting the conversation on screen (the route's agent), from any surface, navigates to Home (`/`).
- No success feedback: the row disappears. Every failure, `session_not_listed` included, shows `toast.error` with the server's message.

## Tests

The HTTP harness for the route (fake pi, `harness.stream()` for `agent_closed` and `catalog`, a stub `trashCommand`), component tests for the provider and every surface; coverage per task in [`../plan/08-delete-sessions.md`](../plan/08-delete-sessions.md).

## Limitations

- pi has no session locking: an agent opening the file between steps 3 and 5 races the delete, and a TUI pi holding it isn't stopped and recreates it on its next write.
- A conversation whose file is outside pi's sessions folder (opened from any `.jsonl` under `$HOME`) is only stopped; its file is kept, with an error toast (F9).
- Deleted files go to the macOS Trash of the server's user, recoverable only on the server machine (Finder → Put Back), not from the web UI; disk space is freed when the Trash is emptied.
- Where `trash` is missing (e.g. Linux without trash-cli), the `unlink` fallback is permanent.
- There is no confirmation outside the live-agent dialog: a mis-tap deletes, recoverable only from the Trash.
- Delete on an agent row removes only its current session; files it left through fork, new or switch are separate rows (F7). Forks and clones are self-contained, so deleting a parent loses nothing in them (F4).
