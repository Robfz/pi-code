# Git worktrees

Repos laid out as `<repo>/main`, with their linked worktrees, appear on every listing surface as one repo group, and pi-code creates and removes their worktrees. Decisions and rationale: [`../../maps/2026-09-30-worktrees.md`](../../maps/2026-09-30-worktrees.md). Where this document overlaps `01`–`05`, it takes precedence.

Terms, for a repo at `~/Dev/pi-code`:

- **Container**: `~/Dev/pi-code`, a plain folder holding the checkouts; it may have sessions of its own (F6).
- **Main checkout**: `~/Dev/pi-code/main` (or `master`), the folder whose `.git` is a directory.
- **Linked worktree**: a checkout made by `git worktree add`, whose `.git` is a file; normally a sibling of `main`.
- **Layout repo**: a repo whose main checkout's folder is named `main` or `master` and whose container isn't inside a git work tree. Plain clones are not layout repos and get the flat folder group of `05`.

## Layout identity

Every listing is derived from session files and live agents (F8): pi-code never enumerates worktrees through git. Each cwd is classified on its own, from files only, by `layoutOf(cwd)` in `catalog/layout.ts`.

### Derivation

The **main rule** for a folder `M`: `M/.git` is a directory, `basename(M)` is `main` or `master`, and `findGitDir(dirname(M))` (`git/branches.ts`) finds nothing. When `<X>/main` and `<X>/master` both meet it, neither passes: `X` is not a layout repo.

| The cwd | Check | `layout` |
|---|---|---|
| has a `.git` directory | the cwd passes the main rule | `{ repo: dirname(cwd), role: "main" }` |
| has a `.git` file | `gitdir: <g>` (relative to the cwd) → `<g>/commondir` (relative to `<g>`) → common dir `<M>/.git`; `M` passes the main rule | `{ repo: dirname(M), role: "worktree" }` |
| exists, no `.git` | `<cwd>/main` or `<cwd>/master` passes the main rule | `{ repo: cwd, role: "container" }` |
| doesn't exist | `<dirname(cwd)>/main` or `/master` passes the main rule | `{ repo: dirname(cwd), role: "worktree", missing: true }` |
| anything else | | none |

- Linked worktrees are tied to their repo through `commondir`, not through their position, so one outside the container joins its repo too. A `.git` file without `commondir` (a submodule) or with a common dir not named `.git` (a bare repo) gets none.
- A worktree deleted outside pi-code has lost its `.git` file, so only its parent ties it to the repo (F15).
- Only checkout roots and the container are classified: a session started in `<repo>/main/packages/server` is a flat folder group.
- Classification costs a few `stat`s and two small reads per cwd, no `git`. `SessionCatalog.scanNow` builds a per-scan cwd → layout map and attaches `layout` to copies of the `SessionSummary` and `ProjectSummary` values it emits. `ParsedSession`, the per-file `(path, mtime, size)` cached value, stays layout-free: a file's layout changes without the file changing. A worktree deleted outside pi-code thus turns `missing` at the next rescan. `AgentManager` classifies an agent's cwd once at creation.

### On the wire

```ts
/** A folder's place in a `<repo>/main` layout. */
interface RepoLayout {
  repo: string;                                // the container folder
  role: "container" | "main" | "worktree";
  missing?: true;                              // worktree folder not on disk
}

interface AgentInfo      { /* … */ layout?: RepoLayout }   // absent outside a layout repo
interface SessionSummary { /* … */ layout?: RepoLayout }
interface ProjectSummary { /* … */ layout?: RepoLayout }
```

These three types feed every listing surface (frames, `GET /api/sessions`, `GET /api/projects`), so a field on each needs no new frame or query; an agent in a fresh worktree, with no session file yet (F9), is placed by its own `AgentInfo`. The hub's session list diff covers `layout`, so a worktree turning `missing` sends `catalog`, and the registry refetches `sessions` and `projects`.

## Server

Both routes canonicalize their path with `canonicalPath` (`paths.ts`): its realpath, or for a missing path the realpath of its nearest existing ancestor plus the remaining suffix (normally `realpath(dirname) + basename`). It must be inside `realpath($HOME)`, else `400 outside_home`; every later step uses it.

### `POST /api/worktrees` — create

```ts
interface CreateWorktreeBody {
  repo: string;      // container, absolute
  name: string;      // folder name: one segment
  branch?: string;   // default: name; may contain "/"
  base?: string;     // default: origin/main, else origin/master
}
```

`worktrees-routes.ts` validates the body (pattern of `agents-routes.ts`; the guards cover `Origin` and JSON), then `createWorktree` (`git/worktrees.ts`) runs these steps on the canonical `repo`, from its main checkout (`mainCheckoutIn(repo)`, `catalog/layout.ts`):

1. `repo` canonicalizes inside `$HOME`; `layoutOf(repo)` has role `container`, else `400 not_in_layout`.
2. `name` is one non-empty segment: no `/`, no control characters or NUL, and not starting with `.` (so no `.`, `..` or `.git` in any case). `git check-ref-format --branch <branch>` succeeds and prints exactly `<branch>` (rejecting expansions such as `@{-1}`), and `branch` isn't `@`. `base` is non-empty and doesn't start with `-`. Otherwise `400 invalid_body`.
3. `<repo>/<name>` exists (`lstat`) → `409 worktree_exists`; `git show-ref --verify --quiet refs/heads/<branch>` succeeds → `409 branch_exists`.
4. `git fetch origin`; failure → `502 git_failed` with git's stderr. Unless the server's environment sets `GIT_SSH_COMMAND` or `GIT_SSH`, or the main checkout's `git config --get core.sshCommand` prints one, the fetch runs with `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, so a passphrase prompt fails instead of waiting for the timeout.
5. The base: the given ref, or `origin/main` when `refs/remotes/origin/main` exists, else `origin/master`; neither exists → `400 invalid_body` "origin has no main or master branch; pass a base". `git rev-parse --verify --quiet --end-of-options <base>^{commit}` failing → `400 invalid_body`.
6. `git worktree add -b <branch> <repo>/<name> <base>`; failure → `502 git_failed`. The branch tracks the base only when that is a remote-tracking branch, as the defaults are (F7); its first push needs `-u origin <branch>`, since plain `git push` refuses under `push.default=simple`.
7. `manager.open({ cwd: <repo>/<name> })` → `201 { agent: AgentInfo }`, the response of `POST /api/agents { cwd }`. The agent may come back `awaiting_trust` (F14).

Step 3 runs before the fetch so a doomed request spends no network. If step 7 fails, the response is the open's error, its message stating that the worktree was created at `<repo>/<name>`. Two creations with the same name: the second fails at step 3, or in git (`git_failed`).

### `DELETE /api/worktrees` — remove

```ts
interface RemoveWorktreeBody { path: string; force?: boolean }
```

1. `path` is absolute and canonicalizes inside `$HOME`. `layoutOf(path)` has role `worktree` and its repo has a main checkout (`mainCheckoutIn(layout.repo)`), else `400 not_a_worktree`, which also covers the main checkout and the container.
2. Without `force`, `assertClean(path)` (`git/worktrees.ts`), for a folder still present: any output of `git status --porcelain=v1 --untracked-files=normal`, or a submodule (a `<gitdir>/modules` directory, or a mode-160000 gitlink whose folder has a `.git`), → `409 worktree_dirty` "uncommitted changes or submodules". These are what make plain `git worktree remove` refuse; checking first keeps conversations running if the user cancels.
3. Every agent whose cwd is inside `path`, exited ones included, is closed through `AgentManager.close`, which waits for pi to exit. A running pi would recreate its session file after step 5.
4. `removeWorktree(main, path, force)`: `git worktree remove [--force] <path>`, run from the main checkout of step 1. A missing folder's record is pruned (F15). Git saying the path "is not a working tree" when the folder is missing counts as done, so a retry after a failed step 5 or a manual `git worktree prune` still deletes the sessions, and a repeated remove answers `204`. Without `force`, git refusing over changes or submodules (made after step 2) → `409 worktree_dirty`, with the agents of step 3 already closed; any other failure → `502 git_failed`. The branch is kept.
5. The sessions whose header `cwd` is inside `path`, from `SessionCatalog.sessions()` after `invalidate()` and never from directory names (F12), are deleted by `deleteSessionFiles` (`catalog/session-files.ts`) one at a time like pi's TUI: `trash <file>` (no shell, 10 s timeout), counted as done when it exits 0 or the file is gone, else `unlink`. After the first `trash` timeout, the remaining files are unlinked directly. A file failing both fails the request with `500 internal` naming it, after the others are attempted. The encoded session dir is kept.
6. `hub.refreshCatalog()`, also after a failed step 5, sends `catalog` without the deleted sessions, with or without the session watcher; the closed agents produce `agent_closed`. → `204`.

With session deletion ([`08-delete-sessions.md`](08-delete-sessions.md)), this is one of pi-code's two writes to pi's agent dir (F11).

### Git runs

`git/git.ts` exports `runGit` with `timeoutMs` (default 10 s) and `env` options (no shell, `GIT_TERMINAL_PROMPT=0`). `fetch` and `worktree add` get `SLOW_GIT_TIMEOUT_MS`, 60 s. `worktree remove` gets 10 min: deleting `node_modules` can take minutes, and a kill mid-delete can leave a folder without its `.git` file, which pi-code can't remove.

### Errors

Codes in `API_ERROR_STATUS`:

| Status | Codes |
|---|---|
| 400 | `not_in_layout` (create: `repo` isn't a layout container), `not_a_worktree` (remove: `path` isn't a linked or missing worktree) |
| 409 | `worktree_exists`, `branch_exists`, `worktree_dirty` (remove without `force`: uncommitted changes, untracked files or submodules) |
| 502 | `git_failed` (message: the git command and its stderr) |

## Web client

### Grouping model

`features/catalog/listing-groups.ts` groups any items with a `cwd`, an optional `layout` and a `Recency` (`@pi-code/protocol`, `{ prompted, at }`: the last prompt's time, else the creation's; [`05-desktop.md`](05-desktop.md), "Ordering"). The sidebar (`SidebarRow`, which carries `layout`), Home (`AgentInfo`, `SessionSummary`), `/sessions` (`SessionSummary`) and the picker (`ProjectSummary`) all use it:

```ts
type ListingGroup<T> =
  | { kind: "folder"; cwd: string; label: string; missing: boolean; items: T[] } // missing: any item's `ListingKeys.missing`
  | { kind: "repo"; repo: string; label: string; items: T[]; worktrees: WorktreeGroup<T>[] };

interface WorktreeGroup<T> {
  cwd: string;
  label: string;                               // folder basename
  role: "main" | "worktree";
  missing: boolean;                            // any item's layout says missing
  items: T[];
}
```

- An agent's `layout` (`agentLayout`) is its session's from the latest catalog scan, which turns `missing` when the folder goes, else its own from creation.
- Items with `layout` group under `layout.repo`. `role: "container"` items go in the repo group's own `items`, directly under its header. The others go in one `WorktreeGroup` per cwd: the main checkout first, then the rest by their first item. Items without `layout` form folder groups by cwd, as in `05`; the optional `missing` key marks a folder group gone (the sidebar passes its rows' `missing`, from `SessionSummary.missing`).
- Items are ordered by `compareRecency` (prompted first, newest prompt first; then the rest, newest created first), and groups by their first item, so groups without any prompt come last. Top-level labels follow the collision rule of `05` over all top-level groups, using the container's basename for repo groups.
- The `repos` option adds an empty repo group, after the others, for each listed container without items; the sidebar passes its pinned repos, so a pinned repo with no conversations keeps its header and its label still takes part in the collision rule.
- In a missing worktree, session rows and exited agents are disabled: resuming would fail with `cwd does not exist` (F2). Their `×` still deletes them ([`08-delete-sessions.md`](08-delete-sessions.md)). A live agent stays usable. `SessionRows` disables a session with `layout.missing` on every list, the share screen's included, unless a live agent holds it (`ownedBy`).
- Every repo group header, on every surface, offers "New worktree" (`NewWorktreeButton`); worktree sub-group headers of linked and missing worktrees offer "Remove worktree" (`RemoveWorktreeButton`), and missing ones show `MissingMark`. All three live in `features/worktrees/worktree-actions.tsx`.

### Sidebar

```
┌ [+ New conversation]  [search…]   ┐
│ pi-code                 [⚲][⑂+][+]│  repo: container name · pin · new worktree · new here
│     Notes on the layout    1d [×] │  container-folder session
│   main  ⎇ main                [+] │  main checkout: branch (live only) · new here
│   ● Release checklist      5m [×] │
│   worktree-support  ⎇ wt   [+][🗑] │  linked worktree: new here · remove
│     Design worktrees       2h [×] │
│   old-spike  missing          [🗑] │  missing: remove only; rows disabled but deletable
│     Try the thing          3d [×] │
│ dotfiles                      [+] │  plain clone: flat folder group
└ ⚙                                 ┘
```

- The branch chip sits on whichever header owns the cwd (folder group or worktree sub-group), shown only while that folder has a live row. Every `+` starts a conversation in its own header's folder; the repo header's folder is the container.
- The repo group and each linked worktree sub-group collapse on their own; the main checkout's sub-group hides only with its repo, and a missing worktree's doesn't collapse. Collapsed state is kept by path (the container, the worktree's cwd) and forgotten when the folder goes. Only repo groups have the pin toggle; pinned repos sort first, by label ([`05-desktop.md`](05-desktop.md), "Sidebar").
- Search results go through the same model; agent rows are filtered as in `05`.

### Home and `/sessions`

Home's "Open conversations" and "Recent sessions", and the `/sessions` list, render the model through `GroupedListing` (`features/catalog/grouped-listing.tsx`) with compact headers, the `?cwd=` filter of `/sessions` applied before grouping. A session row is disabled while its own open request runs.

### Project picker

Recent projects render through the model. A repo group's container (when it has sessions), main checkout and worktrees are rows that start a conversation there; a missing worktree's row is marked and disabled.

### Worktree actions

`WorktreeActionsProvider` (`features/worktrees/worktree-actions.tsx`), mounted once in `AppShell`, owns the remove dialogs and the one `NewWorktreeSheet`, so they outlive the surface that opened them (a list that empties, a closed sidebar sheet). Header buttons reach it through `useWorktreeActions()`: `openNewWorktree(repo, onOpened?)`, `requestRemove({ path, label })` and `removing`, the path whose removal is in flight.

### New worktree

`NewWorktreeSheet` (`features/worktrees/new-worktree-sheet.tsx`) has three fields, empty on every open: Name (required, no `/`, not starting with `.`), Branch (placeholder: the name), Base (placeholder: `origin/main`, with a hint that `origin/master` is the fallback). Submit → `POST /api/worktrees`. While the request runs the button reads "Fetching…" and is disabled, and the sheet can't be dismissed. Errors show inline with the server's message and clear on the next edit. On success the sheet closes and `useShowOpenedAgent` (shared with `useOpenAgent`) runs `onOpened`, invalidates `sessions` and navigates to the agent, which the registry opens.

### Remove worktree

`requestRemove` backs every "Remove worktree" button. One removal runs at a time: while it does, every button is disabled (its own shows a spinner) and `requestRemove` does nothing, so the dirty dialog of step 2 can't replace another confirmation.

1. Confirm: "Remove {label}? Deletes {path} and its conversations (moved to the Trash) and closes the live ones; the branch is kept." Asked on every removal because a phone mis-tap would otherwise lose session files, which `unlink` deletes for good when `trash` fails.
2. `DELETE /api/worktrees { path }`. On `409 worktree_dirty` a second dialog follows: "Remove {label} anyway? {label} has uncommitted changes or submodules. Changes will be lost." Confirming retries with `force: true`. Both confirm buttons are disabled while a removal runs.
3. Success → toast, and the `sessions` and `projects` queries are invalidated. Listings follow through `agent_closed` and `catalog` frames; a conversation on screen shows "Conversation closed". Failures → toast with the server's message.

## Tests

Real `git` in temp dirs for layout and git operations, the HTTP harness for the routes, component tests for every surface; coverage per task in [`../plan/06-worktrees.md`](../plan/06-worktrees.md).

## Limitations

- A new worktree whose conversation closes before any message drops out of every listing (F9); the folder is left on disk, reachable through the picker's path field.
- A layout repo with no session and no open conversation in any of its folders appears nowhere: the picker and `/sessions` list only session-derived entries. The picker's path field doesn't offer "New worktree": start a conversation in `<repo>/main` from the path field, and its repo group, with the action, appears.
- An open, resume, restart or trust request racing a removal of the same worktree can spawn pi in a folder being deleted; single-user, not guarded.
- Concurrent creates or removes on one repo can surface git's own lock error as `502 git_failed`; the client runs one removal at a time and one create per sheet.
- Locked worktrees aren't handled: git refuses to remove them, which surfaces as `git_failed`.
- Plain clones aren't converted to the layout; creation is offered only in layout repos.
- pi has no session locking: a TUI process in a removed worktree isn't closed, and its next write recreates its session file under a missing worktree.
- A worktree deleted outside pi-code shows as missing only after the next rescan.
- Sessions in subfolders of a checkout are listed as flat folder groups (removal deletes them too). Subagent session files nested under the session dirs (F12) aren't listed and aren't deleted.
- Each new worktree with project resources asks for trust unless an ancestor is trusted (F14); pi-code's trust prompt trusts the folder itself, so trusting the container is done from the TUI.
