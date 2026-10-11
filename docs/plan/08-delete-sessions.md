# Plan — deleting sessions

Spans `packages/protocol`, `packages/server`, `packages/web`. Design: `design/08-delete-sessions.md`; decisions: `maps/2026-10-09-delete-sessions.md`. The route (X1–X2) lands before the web actions (X3), which the surfaces (X4–X6) build on; the doc update goes last.

## Test strategy

- **Server:** integration tests through `testing/http-harness.ts`: session files written under the harness's agent dir, agents on the fake pi, `harness.stream()` for `agent_closed` and `catalog` frames, a stub `trashCommand` as in `worktrees-routes.test.ts`.
- **Web:** component tests for the provider and every surface, with `lib/api.ts` mocked as in `catalog.test.tsx`.

## Server

### X1 — Protocol types
- `packages/protocol/src/types.ts`: `DeleteSessionBody { file: string }`.
- `packages/protocol/src/errors.ts`: `session_not_listed` (400).
- Done when: `pnpm check` passes.

### X2 — `DELETE /api/sessions`
- `http/sessions-routes.ts`, mounted in `app.ts`: the design's steps 1–8. Closing agents reuses the worktree route's close helper, extracted rather than duplicated; deletion goes through `deleteSessionFiles` with an injectable `trashCommand`; `hub.refreshCatalog()` in a `finally`.
- Done when: harness tests cover deleting a plain listed session (file gone, `catalog` frame without it), a live agent's session (`agent_closed` before the file goes), an exited agent's session, a file outside the sessions dir held by an agent (`400 session_not_listed`, agent stopped, file kept, message saying so), an unlisted existing file with no agent (`400 session_not_listed`, kept), a missing file (`204`), a symlinked path matching the realpath, a failing trash falling back to `unlink`, an undeletable file → `500`, `invalid_body` (missing, empty, relative `file`), and the guards (`forbidden_origin`, non-JSON).

## Web

### X3 — API and session actions
- `lib/api.ts`: `deleteSession(file)`.
- `features/sessions/stop-or-delete.tsx`: `StopOrDeleteProvider`, mounted in `AppShell`, owning the Stop-or-Delete dialog; `useStopOrDelete()` used by every surface. Stop and Delete as in the design: `drop` afterwards, `sessions` and `projects` invalidated after a delete, an agent without `sessionFile` only stopped, navigation to `/` when the route's agent is stopped or deleted, `toast.error` on failure, per-row pending state.
- Done when: component tests cover the dialog's Cancel, Stop and Delete for a live agent, immediate delete for an exited agent and a session, Stop-only for an agent without `sessionFile`, navigation to Home for the conversation on screen and none for another, a failure toast (`session_not_listed` included), and the pending row disabled while another stays usable.

### X4 — Sidebar
- `features/sidebar/sidebar.tsx` (desktop and mobile sheet): `×` on every row through `useStopOrDelete()`, the alignment spacer and the close confirmation removed; labels "Stop or delete {title} ({folder})" and "Delete {title} ({folder})"; the `×` usable on disabled rows in a missing worktree.
- Done when: sidebar tests cover the `×` and label per row kind, the dialog only on live rows, and deleting a session in a missing worktree.

### X5 — Home and `/sessions`
- `features/catalog/session-list.tsx` (`SessionRows`), `routes/home.tsx` and `features/catalog/sessions-screen.tsx`: a `×` beside each row's button (never inside it) on open conversations, recent sessions and `/sessions`; a held session (the live agent whose `sessionFile` it is) follows its agent's rule. None on the share screen.
- Done when: component tests cover the `×` on each list, a held session opening the dialog for a live agent and deleting for an exited one, no nested buttons, and no `×` on the share screen.

### X6 — Header menu
- `features/conversation/header.tsx`: the `⋮` menu's Stop and Delete (destructive, no dialog), both landing on Home.
- Done when: header tests cover Stop and Delete, each navigating to `/`.

## Docs

### X7 — Update the docs and README
- `docs/design/00-overview.md`, `01-server.md`, `06-worktrees.md`, `README.md` (`PI_AGENT_DIR` row, Known limitations): session deletion as the second write to the agent dir; the docblocks of `catalog/sessions.ts` and `catalog/session-files.ts`.
- `docs/design/02-api-contract.md`: `DELETE /api/sessions` and `session_not_listed`.
- `docs/design/03-web-client.md`, `05-desktop.md`: the `×` rule, Stop and Delete, the header menu.
- Done when: no doc calls the agent dir read-only except worktree removal, none offers "Close", and they link `08-delete-sessions.md`.

## End-to-end verification

On the Mac over the tailnet URL:

1. Delete a session row from the sidebar: it disappears, its file is in the Trash, and Home and `/sessions` on the phone no longer list it.
2. Start a conversation, send a message, then `×` its sidebar row: the dialog offers Stop and Delete. Stop keeps it listed as a session row; Delete removes it and, on screen, lands on Home.
3. Delete a brand-new conversation before any message: it is only stopped and drops out of the listings.
4. Kill a pi process to get an exited agent, then `×` its row: deleted without a dialog.
5. From the phone's `/sessions`, delete an old session and one held by a live agent (dialog) and by an exited agent (no dialog).
6. Resume a `.jsonl` outside `~/.pi/agent/sessions` and Delete it from the header: the conversation stops, the file stays, and an error toast says so.
7. Delete a session in a missing worktree from the sidebar.
