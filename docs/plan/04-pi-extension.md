# Plan — pi-code extension

`packages/pi-extension`. Design: `design/04-pi-extension.md`.

## Phase 0

### E1 — Spike: trust over RPC
Minimal extension with a `project_trust` handler that calls `ctx.ui.confirm`; run `pi --mode rpc --extension …` in a scratch directory containing a `.pi/settings.json`; answer the UI request by hand.
- Done when: documented whether the handler fires, whether the confirm round-trips at startup, and whether `remember: true` writes `trust.json`. Design doc updated; fallback chosen if needed.

### E2 — Spike: command completion timing
Register a command whose handler awaits 3 s; send it via `prompt`; observe when the `response` arrives.
- Done when: documented; decides whether the `pi-code:` status channel stays.

## Phase 3

### E3 — Project trust handler
- `hasSavedDecision(cwd)` over `trust.json` (closest canonical parent), the handler from the design, mode guard.
- Done when: unit tests for `hasSavedDecision` (exact match, parent match, `false` decision, missing file, garbage file); manual test: a new project with `.pi/` prompts once in the web, is remembered, and the TUI doesn't prompt afterwards.

### E4 — Tree navigation command
- `/pi-code-tree <json>`: validate args, `navigateTree`, editor text for user-message targets, completion report (per E2).
- Done when: manual test via the web tree screen moves the leaf in place, with and without a branch summary, and the TUI shows the same tree afterwards.
