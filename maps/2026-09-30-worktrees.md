<!-- pi:map -->
# pi-code — Git worktree support: decision map

Builds on [2026-09-26-origin.md](2026-09-26-origin.md) and [2026-09-30-desktop.md](2026-09-30-desktop.md); picks up BACKLOG.md's "Git worktree support".

## Scope & context
- [settled] Worktree = `git worktree` only; no clones, jj workspaces or other isolation — user, for simplicity
- [settled] Goal: git projects shown in the session listing, with the ability to create a worktree from a project — user
- [settled] User's layout for worktree repos: `<somePath>/<repo>/main` plus sibling worktrees `<somePath>/<repo>/<name>` — user; new to worktrees
- [settled] Findings count as acknowledged at the user's next reply — standing call carried over from the desktop map

## Listing
- [settled] Git projects appear on every listing surface (sidebar, phone Home and /sessions, New-conversation picker) — user
- [settled] Shape: repo group → worktrees inside → conversations inside each worktree — user
- [settled] Repos not in the layout (every plain clone) keep today's flat folder group — user
- [settled] Container-folder sessions (e.g. `~/Dev/pi-code` itself) go inside the repo group — user
- [settled] Container-folder sessions sit directly under the repo header, above the worktrees — user
- [settled] Repo header label: container folder name (existing parent-prepend rule on collisions); worktree sub-groups labelled by folder name; `main` pinned first, the rest by most recent activity — user
- [settled] Worktrees deleted outside pi-code stay in their repo group (tied by parent folder, F15), marked as missing, for manual cleanup via "remove worktree" (sessions + git's record) — user
- [settled] Listings stay derived from session files plus live conversations; no git enumeration of worktrees — user, to avoid tracking repos alongside session files

## Creation
- [settled] First release: worktree creation only for repos already in the `<repo>/main` layout; detect the layout and gate the feature — user
- [deferred] Converting plain clones to the layout — user wants it eventually; not in the first release
- [settled] New worktree goes at `<repo>/<worktree name>`, sibling of `main` — follows from the layout
- [settled] Inputs: worktree name; branch name (defaults to worktree name); base ref (defaults to the repo's main branch) — user
- [settled] Base-ref default: `main` or `master` on origin, after a fetch — user; only those two names occur
- [settled] Creating a worktree opens a conversation in it right away — user, follows from listings staying session-derived (F8)
- [settled] A repo is "in the layout" when its main checkout's folder is named `main` or `master` and that folder's parent isn't inside a git repo — user, accepting the agent's challenge to drop "every linked worktree is a sibling" (one stray worktree elsewhere would silently disable the whole repo)
- [settled] "Create worktree" is offered from the repo group header and the New-conversation picker — user
- [settled] A failed fetch fails the creation — user
- [settled] Creation fails with an error if the branch or `<repo>/<name>` already exists — user
- [settled] When both exist, the base ref defaults to `origin/main` — user
- [settled] Worktree name is a single folder segment (no `/`); the branch name may contain `/` (e.g. `feature/x`) and must be a valid git ref — user
- [settled] New branch keeps git's default upstream (origin/<main>); the first push uses `-u origin <branch>` — user
- [settled] A new worktree whose conversation closes before any message drops out of every listing; accepted gap, the dir stays reachable via picker path autocomplete — user (F10 option c)

## Removal
- [settled] Removing a worktree from pi-code is in scope — user
- [settled] "Remove worktree" is offered on linked worktrees only; git refuses to remove the main one — follows from git
- [settled] Removal runs `git worktree remove` with git's defaults: deletes the worktree dir and its admin files, keeps the branch — user
- [settled] Dirty worktree (uncommitted or untracked changes): pi-code asks for confirmation, then removes with `--force` — user; unpushed commits need no guard, the branch is kept
- [deferred] Locked worktrees — user doesn't use `git worktree lock`; not planned for
- [settled] Removal deletes the worktree's session files (matched by header cwd, F12) — user; overrides the desktop map's read-only agent dir for this one operation (F11)
- [settled] Live conversations in the worktree are closed as part of the removal — user
- [settled] "Remove worktree" is offered from the worktree's sub-group header in the sidebar and on the phone screens, to start — user
- [settled] Session files are deleted like pi's TUI: `trash` CLI first, unlink as fallback — user

## Findings
- [settled] F1: each worktree is already a separate, unrelated folder (grouped by exact cwd); branch/dirty/diff already work inside a worktree; nothing links a worktree to its repo — acknowledged
- [settled] F2: deleting a worktree dir strands its sessions: still listed, but opening/resuming fails with "cwd does not exist"; nothing handles a vanished cwd — acknowledged
- [settled] F3: only pi-code uses the `<repo>/main` layout; the other 8 repos (~/Dev/{dotfiles,graphtask,mole,pi-extensions,server,todos}, ~/Kepi/{bbva,creditus}) are plain clones rooted at the folder itself — acknowledged
- [settled] F4: three listing surfaces: sidebar (desktop dock + phone sheet; groups by exact cwd, branch only with a live agent), phone Home and /sessions (flat lists), New-conversation picker (recent projects + path autocomplete); repo identity is available via `git rev-parse --git-common-dir` / `git worktree list --porcelain` — acknowledged
- [settled] F5: origin/HEAD is set in pi-code, mole, pi-extensions, server (main) and dotfiles (master); unset in graphtask, todos, Kepi/bbva, Kepi/creditus; bbva and dotfiles use master; local `main` can lag `origin/main` — acknowledged
- [settled] F6: pi has sessions recorded at the container `~/Dev/pi-code` itself (not a git repo), besides one dir per worktree — acknowledged
- [settled] F7: `git worktree add -b <b> <path> origin/main` makes `<b>` track origin/main (git's default); this worktree's branch already does, so plain `git push` refuses (push.default simple) and status compares against main; `--no-track` avoids it — acknowledged
- [settled] F8: every listing is derived from session files, so a freshly created worktree (no sessions yet) appears nowhere unless worktrees are also enumerated via git — acknowledged
- [settled] F9: pi writes no session file until the first user/assistant message; a new worktree whose conversation is closed before any message vanishes from every listing (the dir stays on disk) — acknowledged
- [settled] F10: pi flushes the session file only once a user/assistant message exists; custom entries, session name, `!!` bash and extension messages don't count. Session-file-based options: (a) the creation form takes the first prompt, so the file exists from the start; (b) closing an empty conversation in a worktree offers to remove the worktree (misses server stop/crash); (c) accept it, since the dir stays reachable via picker path autocomplete. Off the table: pi-code writing session files (agent dir is read-only to it) or synthetic messages polluting context — acknowledged
- [settled] F11: pi's agent dir is read-only to pi-code (desktop map), so removal can't delete a worktree's session files without revisiting that; leftover sessions stay listed but unopenable (F2) — acknowledged
- [settled] F12: session dirs use a lossy path encoding, so a worktree's sessions must be found by header `cwd`; subagent sessions nest under the session dirs — acknowledged
- [settled] F13: pi never purges sessions (no retention setting; 61 files / 30 MB here); the TUI's /resume picker deletes one session at a time, via the `trash` CLI (ships with macOS at /usr/bin/trash) with unlink as fallback — acknowledged
- [settled] F14: a new worktree is a new path for trust: it prompts only if it has `.pi`/`.agents` resources and no ancestor is trusted; the existing "Trust parent folder" option on `<repo>` covers every current and future sibling — acknowledged
- [settled] F15: a worktree dir deleted outside pi-code (rm -rf) can't be tied to its repo through its `.git` file anymore; its parent folder still can (`<repo>/main` is the layout). `git worktree remove` on the missing dir succeeds and prunes git's record — acknowledged
