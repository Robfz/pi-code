# Plan — git worktrees

Spans `packages/protocol`, `packages/server`, `packages/web`. Design: `design/06-worktrees.md`; decisions: `maps/2026-09-30-worktrees.md`. Layout identity reaches every listing (T1–T3) before the git write paths (T4–T6). The web grouping model (T7) lands before the surfaces built on it (T8–T11), and the doc update goes last.

## Test strategy

- **Layout and git:** temp dirs with real `git` (as in `git/git.test.ts`): a bare repo as `origin`, cloned into `<container>/main`, linked worktrees added with `git worktree add`, plus hand-written `.git` files for the submodule and bare cases.
- **Server:** integration tests through `testing/http-harness.ts`, the layout repo created under `harness.home`, agents on the fake pi, `harness.stream()` for `agent_closed` and `catalog` frames.
- **Web:** pure tests for the grouping model; component tests for the sidebar, Home, `/sessions`, picker and the worktree dialogs, with `lib/api.ts` mocked as in `catalog.test.tsx`.

## Server

### T1 — Protocol types
- `packages/protocol/src/types.ts`: `RepoLayout`; optional `layout` on `AgentInfo`, `SessionSummary`, `ProjectSummary`; `CreateWorktreeBody`, `RemoveWorktreeBody`.
- `packages/protocol/src/errors.ts`: `not_in_layout` and `not_a_worktree` (400), `worktree_exists`, `branch_exists` and `worktree_dirty` (409), `git_failed` (502).
- Done when: `pnpm check` passes.

### T2 — Layout derivation
- `catalog/layout.ts`: `layoutOf(cwd): RepoLayout | undefined` per the design's table (main rule via `findGitDir` on the parent, both `main` and `master` → none, `gitdir:` → `commondir` for linked worktrees, container and missing rows), reading files only. Also `mainCheckoutIn(repo)`: the container's `main` or `master` checkout, none when both qualify.
- Done when: `catalog/layout.test.ts` covers the design's layout cases, `main` and `master` both present (none) included.

### T3 — Layout on every listing
- `catalog/sessions.ts`: `scanNow` computes a per-scan cwd → layout map over the distinct header cwds and attaches `layout` to the emitted `SessionSummary` and `ProjectSummary` copies. `ParsedSession`, the per-file cached value, stays layout-free.
- `agents/agent-manager.ts`: `Agent` stores `layoutOf(cwd)` at creation and `info()` includes it.
- `live/stream-hub.ts`: no change; the window carries `layout`, so its JSON diff makes a `missing` flip broadcast `catalog`.
- Done when: catalog tests show `layout` on sessions and projects of a layout repo and none on a plain clone's. After the worktree dir is deleted, the next `refreshCatalog` broadcasts `catalog` with `missing: true`. A harness test opens an agent in a linked worktree and its `agent` frame carries `layout`.

### T4 — Git runner and worktree operations
- `git/git.ts`: export `runGit` and `GitError`; `timeoutMs` (default 10 s) and `env` options.
- `paths.ts`: `canonicalPath(p, home)` (realpath, or realpath of the nearest existing ancestor plus the suffix; confined to real `$HOME`).
- `git/worktrees.ts`: `createWorktree({ home, repo, name, branch, base })` runs the design's create steps 1–6 (`fetch` and `worktree add` at `SLOW_GIT_TIMEOUT_MS`, 60 s; the fetch with `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` unless `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` is set). `assertClean(path)` runs remove step 2: `status --porcelain=v1 --untracked-files=normal` and the submodule check. `removeWorktree(main, path, force)` runs remove step 4 (10 min) from the main checkout `main`, `worktree_dirty` when git refuses a plain remove over changes or submodules.
- Done when: unit tests cover default base `origin/main`, the `origin/master`-only fallback, neither, explicit base, branch `feature/x`, upstream `origin/main` for a remote-tracking base and none for a local one, names `.git`, `.x` and with a control character, refs `@` and `@{-1}`, `worktree_exists`, `branch_exists`, `git_failed` on an unreachable `origin`, a set `core.sshCommand` used by the fetch, removal of a clean, a dirty (`worktree_dirty`, then forced), a submodule-holding, a missing and a pruned worktree, `assertClean` refusing exactly the submodules git refuses, canonicalization of a missing path under a symlinked parent, and the branch surviving removal.

### T5 — `POST /api/worktrees`
- `http/worktrees-routes.ts`: validator parsing `CreateWorktreeBody`; `createWorktree`, then `manager.open({ cwd })` → `201 { agent }`; an open failure returns its error, the message naming the created path. Mounted in `app.ts` with `manager`, `catalog` and `hub` from `AppDeps`.
- Done when: harness tests create a worktree and get a `starting` agent whose cwd is `<repo>/<name>` and whose `layout` has role `worktree`. They also cover `outside_home` (also through a symlink), `not_in_layout` on a plain clone and on `main`, `invalid_body`, an open failure after creation, and the guards (`forbidden_origin`, non-JSON).

### T6 — `DELETE /api/worktrees`
- `catalog/session-files.ts`: `deleteSessionFiles(files, trashCommand = "trash")`: per file, spawn without a shell and with a timeout; done on exit 0 or file gone, else `unlink`; after the first timeout, `unlink` only. Returns the files left.
- Route: the design's remove steps 1–6: `not_a_worktree` unless `mainCheckoutIn(layout.repo)` exists, `assertClean` before closing agents unless `force`, then `removeWorktree(main, path, force)`, ending with `hub.refreshCatalog()` and `204`.
- Done when: harness tests cover a clean removal (dir, admin dir and session files gone, branch kept, `agent_closed` for its live and exited agents, then a `catalog` frame without its sessions, with no watcher). They also cover a dirty one (`409`, agents still running, then `force`), an untracked-only dirty one, a submodule → `409`, a missing dir, a pruned record, `not_a_worktree` for `main` and the container, `outside_home`, a session of another cwd in a colliding encoded dir kept, a failing or hanging trash command falling back to `unlink` (no further `trash` after a hang), and an undeletable file → `500` with the others deleted.

## Web

### T7 — Grouping model
- `features/catalog/listing-groups.ts`: `groupListing<T>(items, { cwd, layout, activity })` → `ListingGroup<T>[]` per the design (folder and repo groups, container items, `main` pinned, worktrees by recency, collision labels over all top-level groups, a worktree missing when any item says so).
- Done when: unit tests cover nesting, ordering of groups, worktrees and items, container items under the header, a repo group made only of container items, collision labels between a repo group and a folder group, missing worktrees (one missing item suffices), and items without `layout` grouped exactly as `buildSidebarGroups`.

### T8 — Worktree API and dialogs
- `lib/api.ts`: `createWorktree(body)` → `AgentInfo`; `removeWorktree(path, force?)`.
- `features/worktrees/new-worktree-sheet.tsx`: name / branch / base form, empty on every open, client-side name check (non-empty, no `/`, no leading `.`), "Fetching…" and submit disabled while pending, the sheet not dismissible while pending, inline server errors. On success it closes and runs `useShowOpenedAgent` (split out of `useOpenAgent`): invalidate `sessions`, navigate.
- `features/worktrees/worktree-actions.tsx`: `WorktreeActionsProvider`, mounted in `AppShell`, owning the remove dialogs and the single `NewWorktreeSheet`; `useWorktreeActions()` (`openNewWorktree`, `requestRemove`, `removing`); the shared `NewWorktreeButton`, `RemoveWorktreeButton` and `MissingMark`. Removal: confirm, `DELETE`, on `worktree_dirty` a second confirm ("uncommitted changes or submodules") and retry with `force`; toast on success and failure; one removal at a time: every remove button and confirm disabled, and `requestRemove` a no-op, while one is pending.
- Done when: component tests cover create success (navigation), each inline error, the client-side name check, no dismissal while pending, an empty form on every open (same repo included), and removal clean, dirty → force, cancelled at either dialog (no request, or no forced request), failure toast, no other removal while one is pending, and the dirty dialog after the opening surface unmounts.

### T9 — Sidebar
- `features/sidebar/sidebar-model.ts`: `SidebarRow` carries `layout`; grouping builds on `groupListing`. `sidebar.tsx` renders repo headers ("New worktree", `+` in the container), worktree sub-group headers (branch chip, `+` except on missing ones, "Remove worktree" on linked and missing ones), missing marker with session rows and exited agents disabled. Search results use the same model.
- Done when: sidebar tests cover the nested rendering, header actions per role, `+` targets (container vs. worktree cwd), disabled rows and a usable live agent in a missing worktree, an agent in a session-less new worktree placed in its repo group, and search results grouped.

### T10 — Home and `/sessions`
- `routes/home.tsx` (open conversations, recent sessions) and `features/catalog/sessions-screen.tsx` render `groupListing` through `features/catalog/grouped-listing.tsx` with compact headers: "New worktree" on repo headers, "Remove worktree" on worktree sub-group headers; `/sessions?cwd=` filters before grouping. `session-list.tsx`'s `SessionRows` renders one group's items, disabling missing-worktree sessions no live agent holds on every list (the share screen's flat `SessionList` included) and only the row being opened while its request runs.
- Done when: component tests cover grouped Home sections and `/sessions`, the `cwd` filter, both header actions, disabled missing sessions on the share screen, and a held missing session left enabled.

### T11 — Project picker
- `features/catalog/project-picker.tsx`: recent projects through `groupListing`; "New worktree" on repo headers opens `NewWorktreeSheet`; missing worktrees marked and disabled.
- Done when: picker tests cover grouping, starting in the container, `main` and a worktree, the New worktree entry, and a disabled missing row.

## Docs

### T12 — Update the docs, README and backlog
- `docs/design/01-server.md`: `catalog/layout.ts`, the worktree routes, git write commands with their timeouts, session deletion as the one write to the agent dir.
- `docs/design/02-api-contract.md`: `RepoLayout` and the `layout` fields, `POST` / `DELETE /api/worktrees`, the codes.
- `docs/design/03-web-client.md`: grouping model on every listing, the new worktree sheet and remove flow.
- `docs/design/00-overview.md` (topology diagram's `sessions (read)`), `05-desktop.md` (Limitations) and `README.md` (`PI_AGENT_DIR` row): the agent dir is read-only except for worktree removal; the design's main limitations added to README's Known limitations.
- The read-only docblocks of `packages/server/src/catalog/sessions.ts` (file header) and `catalog/watcher.ts` (`watchSessions`); "Git worktree support" removed from `BACKLOG.md`.
- Done when: the docs mention `layout`, both endpoints and the codes, and link `06-worktrees.md`.

## End-to-end verification

On the Mac over the tailnet URL, with `~/Dev/pi-code` in the layout and `~/Dev/dotfiles` a plain clone:

1. The sidebar shows `pi-code` with its container sessions, `main` first, then the other worktrees by activity. `dotfiles` stays a flat group, and two folders sharing a basename get parent-prefixed labels.
2. "New worktree" from the repo header: name `qa-wt`, branch `qa/branch`, default base. pi-code fetches, creates `~/Dev/pi-code/qa-wt` tracking `origin/main`, and opens a conversation there, which appears under `pi-code` while still empty. Send a message: the session lists under `qa-wt` on the phone's Home and `/sessions` and in the picker.
3. Repeat the same name → "already exists"; name `.git` or a branch with a space → validation error; turn Wi-Fi off → creation fails on the fetch.
4. Create from the picker's repo header, then close that conversation before any message: the worktree drops out of the listings and the picker's path field still reaches it.
5. In `qa-wt`, leave an untracked file, then "Remove worktree" from the sidebar: confirm, see the dirty prompt, confirm again. The folder is gone, its conversations close and its sessions are in the Trash; `git branch` still lists `qa/branch`.
6. `rm -rf` another throwaway worktree outside pi-code, then write to any session: it shows as missing with disabled rows. Remove it from the phone's `/sessions`: its sessions disappear and `git worktree list` doesn't show it.
7. On the phone at <1024px: the sidebar sheet, Home and `/sessions` show the same grouping and actions.
