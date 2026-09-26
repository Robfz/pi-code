# Plan — web client

`packages/web`. Design: `design/03-web-client.md`, contract: `design/02-api-contract.md`.

## Phase 1 — walking skeleton

### W1 — App skeleton
- Vite + React + TypeScript, Tailwind v4, shadcn/ui init, TanStack Router (code-based) and Query, Hono `hc` client typed from the server's routes, dev proxy to the server.
- Done when: `/` renders on the phone through `tailscale serve`, and a typed call to `/api/health` works.

### W2 — Conversation store and connection
- Zustand store per agent (`design/03-web-client.md`), snapshot → EventSource with `since` → `apply` through the shared reducer, `resync` handling, visibility reconnect, connection indicator.
- Done when: store tests feed a fixture's server events and match the reducer's output; manual: toggling airplane mode mid-run recovers without duplicated or missing text.

### W3 — Minimal conversation screen
- Active-branch derivation, user/assistant text rendering with Streamdown, streaming message, composer sending `prompt`.
- Done when: phone checklist item 1–3 pass.

## Phase 2 — conversation core

### W4 — Live tools and run controls
- Running tools with a generic renderer; queue display; Steer / Queue / Stop / Stop & edit; `streamingBehavior` handling.
- Done when: phone checklist item 4 (run controls part) passes.

### W5 — Extension UI
- Bottom sheets for select / confirm / input / editor with countdowns; toasts; status chips; widgets above/below the composer; `setTitle`; `set_editor_text`; URL linkify + copy.
- Done when: component tests per request type; manual MCP OAuth copy-paste flow works from the phone (`/mcp-auth <server>`).

### W6 — Full transcript rendering
- All entry kinds from the transcript table (bash executions, custom messages, compaction and branch summaries, markers, labels, errors / aborted).
- Done when: rendering tests over fixture transcripts; visual check against the TUI for the same session.

## Phase 3 — sessions & projects

### W7 — Home, sessions, project picker
- Home (open agents with attention, recent sessions), `/sessions` with project filter, picker with recent projects + debounced path autocomplete.
- Done when: a new conversation can be started in any folder under `~` from the phone, and an old session resumed.

### W8 — Agent lifecycle UI
- Starting state (incl. trust confirm), exited state with stderr tail and Restart, Close, `/new`, fork picker, clone, rename.
- Done when: phone checklist item 5 (resume + fork) passes.

### W9 — Tree screen
- `get_tree` view, labels, current leaf, Go here (summary choice + instructions), Fork from here.
- Done when: phone checklist item 5 (tree) passes.

## Phase 4 — rendering & controls

### W10 — Built-in tool renderers
- `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, collapsed/expanded with the global toggle.
- Done when: renderer tests over fixture tool calls, including errors and streaming `bash` output.

### W11 — Subagent progress widget
- From `SubagentDetails`: single / parallel / chain, per-agent cards, live updates from `partialResult`, markdown output, nested tool calls.
- Done when: the subagent fixture renders live and final states correctly.

### W12 — pi-web-access and MCP renderers
- `web_search`, `source_check`, `fetch_content`, `get_search_content`, `mcp` + namespace tools, custom message cards for their `customType`s.
- Done when: fixtures render; unknown MCP tools fall back to the generic renderer.

### W13 — Diffs
- `@git-diff-view/react` wrapper (unified on narrow, split on wide) used by the `edit` renderer, `write` new files, and the `/agents/$id/diff` screen with file list and edge states.
- Done when: phone checklist item 6 passes.

### W14 — Status bar and pickers
- Status bar (folder, branch/dirty, context bar, name, model + thinking, cost, extension chips, run state); model and thinking pickers; stats sheet.
- Done when: values match the TUI status bar for the same session.

### W15 — Composer completion
- Slash autocomplete (built-ins + `get_commands`), built-in command actions and "use the TUI" responses, `!` / `!!`, image attach gated on model input.
- Done when: each built-in command has a test; an image prompt works from the phone camera.

## Phase 5 — PWA

### W16 — Installable app
- `vite-plugin-pwa` (injectManifest), manifest with icons and share target, app-shell precache, offline banner.
- Done when: Chrome on Android offers install and the app launches standalone.

### W17 — Push and badge
- `/settings` enable-notifications flow, subscription upload, service worker `push` (focus check, badge) and `notificationclick`, `POST /ack` on visibility.
- Done when: phone checklist item 7 passes; desktop Chrome receives notifications too.

### W18 — Share target
- `/share` landing with destination picker and composer prefill.
- Done when: phone checklist item 8 passes.

## Phase 6 — curator & polish

### W19 — Curator and final polish
- "Review in curator" button on search tool calls (opens the URL from the `curator` event in a new tab); connection and error states reviewed on the phone.
- Done when: phone checklist item 9 passes, and the full checklist passes in one sitting.
