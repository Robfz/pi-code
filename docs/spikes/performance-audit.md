# Performance audit

A read-only review of the codebase for rendering, memory, CPU and network costs. Two independent reviewers then checked each finding against the code. Costs in the findings are estimates from reading the code; the measurements are in "Status" below, from the e2e perf suite (`e2e/perf/README.md`). Each finding is marked **confirmed** (the mechanism is visible in this repo), **verified externally** (checked against library or pi source outside this repo: Streamdown 2.6.0, the installed pi distribution) or **suspected**, and **resolved** or **partly resolved** where the code addresses it.

Ranking assumes how the app is used: a personal tool with one to three clients, used on desktop and mobile equally. The two layouts load the app differently. On mobile, one conversation is on screen at a time. On desktop, the sidebar is always docked, one tab follows every agent (several may stream at once), and the review pane stays open beside the conversation. Findings rank by their cost across both. Costs that scale with connection count rank lower.

Paths are relative to `packages/<pkg>/src`.

## Status

### Addressed

- **P1** (resolved): the registry buffers `event` frames per store and applies them once per animation frame, one store update per batch (`applyBatch`); a 100 ms timer and `visibilitychange` flush hidden tabs, and every other frame, stream error and reconnect flushes first.
- **P2** (resolved): a code fence still streaming renders unhighlighted until it closes or the message finishes, then Shiki highlights it a line at a time, yielding every 8 ms. Highlighted whole in one task, a closed fence would block the main thread for its language's grammar compile plus its length (a 12-line TypeScript block: about 90 ms at 1×, 370 ms at 4×). Text that mounts streaming stays in Streamdown's streaming mode once it finishes, with line references on throughout, so only changed blocks re-render; a live step's content check stops at the first non-space character (`/\S/`).
- **P3** (resolved): step rows and exploration groups are memoised (groups compare their steps by identity), streaming steps are cached per block object, and step labels come from committed steps only, so a delta re-renders the rows it changes.
- **P4** (partly resolved): changed session files are parsed incrementally from the cached byte offset, one rescan runs at a time, and the watcher ignores paths that can't change the listing; layout lookups per cwd and `sidebar.prune()` per rescan remain.
- **P5** (resolved): released stores beyond the three most recently used are evicted at the next hydrate, which reconnects the stream anyway.
- **P6** (partly resolved): the diff and file-content routes send a weak `ETag` and answer a matching `If-None-Match` with a bodiless 304, which the client resolves to its cached object; the per-file fallback runs at concurrency 8. Remaining: the server computes the full diff on every refresh, and each untracked file spawns a `git diff`.
- **P8** (resolved): Sessions, Tree, Diff, Share and Settings load lazily; vendor code sits in its own chunks; the server sends the build's precompressed `.br`/`.gz` files and gzips `/api` JSON (not `text/event-stream`); the precache leaves out Shiki, the diff viewer and non-Latin font subsets, which the service worker caches on first use.
- **P9** (partly resolved): the event log keeps each event as its JSON and bounds the kept events at 32 MB as well as 10,000; superseded tool updates and the 7-day idle limit remain.
- **P11** (resolved): sidebar rows are memoised on value props with stable callbacks and a precomputed time label, take their `×` target from the row instead of scanning agents, and both action contexts are memoised.
- **P15** (resolved): each event is serialised once, when appended, and every connection's frame is built around that JSON; the `id:` line stays per connection.
- **P18** (one item resolved): the thinking row finds its last line by scanning back from the end.

### Open

- **P7**, **P10**, **P12**, **P13** (no change recommended), **P14**, **P16**, **P17**, and the rest of **P18**.
- A language's first highlighted line compiles the grammar rules it meets in one task: about 50 ms at 1× and 150 ms at 4× for the TypeScript line that opens `long-stream`'s first code block (P2). The stream scenarios' longest tasks are that size: 140–153 ms at 4×, where every `long-stream` run has 5 long tasks, and at 1× one long task (50 ms) in 18 runs. Spreading it further would take highlighting off the main thread (a worker) or highlighting fences while they stream, a line at a time.
- P5's memory: an evicted store stays reachable for the 5 minutes react-query keeps an inactive query (`gcTime`). The composer's `commands` query for the agent holds it: its `queryFn` shares the composer's closure context, which holds the store.

### Measurements

Before: `e2e/results/baseline.json`, 3 runs per row. After: `e2e/results/report-2026-10-17T17-06-08-070Z.json` and `e2e/results/report-2026-10-17T17-20-18-812Z.json`, taken back to back, 3 runs per row each. A cell is the median of their 6 runs or, where the two reports' medians differ by at least the change, both medians (first / second). One machine (Apple M3 Max, Chromium 156); during the two after-reports a browser kept about 80% of one core busy, and the baseline's background load isn't recorded. `pnpm e2e:compare` prints every metric. Arrows read before → after.

| scenario | project | cpu | main thread (ms) | script (ms) | long tasks | longest task (ms) | dropped frames | heap after GC (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| long-stream | desktop | 1× | 4711 → 4746 / 4611 | 1993 → 2099 | 0 → 0 | 0 → 0 | 1 → 2 | 18.8 → 17.3 |
| long-stream | desktop | 4× | 6309 → 5368 | 2943 → 2458 | 6 → 5 | 145 → 145 / 144 | 25 → 25 / 23 | 18.8 → 17.3 |
| long-stream | mobile | 1× | 6487 → 6432 | 3284 → 3072 | 0 → 0 | 0 → 0 | 2 → 2 / 4 | 18.2 → 16.7 |
| long-stream | mobile | 4× | 4635 → 3905 | 2291 → 1844 | 4 → 5 | 142 → 142 | 23 → 22 / 24 | 18.2 → 16.7 |
| tool-storm | desktop | 1× | 4880 → 3795 | 2383 → 1511 | 0 → 0 | 0 → 0 | 0 → 0 | 12.1 → 12.0 |
| tool-storm | desktop | 4× | 9124 → 6350 | 5184 → 2700 | 0 → 0 | 0 → 0 | 1 → 1 | 12.1 → 12.1 |
| tool-storm | mobile | 1× | 4926 → 4064 | 2646 → 1728 | 0 → 0 | 0 → 0 | 0 → 0 | 11.5 → 11.4 |
| tool-storm | mobile | 4× | 7669 → 4613 | 4572 → 2025 | 0 → 0 | 0 → 0 | 1 → 1 | 11.5 → 11.4 |
| cold-load | desktop | 1× | 121 → 114 | 81.6 → 72.0 | 0 → 0 | 0 → 0 | 1 → 0 | 6.8 → 6.8 |
| cold-load | desktop | 4× | 461 → 405 | 309 → 262 | 3 → 3 | 135 → 99 | 17 → 14 | 6.7 → 6.7 |
| cold-load | mobile | 1× | 109 → 103 | 73.5 → 64.2 | 0 → 0 | 0 → 0 | 1 → 0 | 6.2 → 6.2 |
| cold-load | mobile | 4× | 416 → 367 | 279 → 236 | 3 → 3 | 133 → 86.5 | 14 → 12 | 6.2 → 6.2 / 6.1 |
| multi-agent-review | desktop | 1× | 6008 → 6381 | 2645 → 2761 | 0 → 0 | 0 → 0 | 1 → 2.5 | 22.6 → 21.1 |
| multi-agent-review | desktop | 4× | 6740 → 6007 | 3049 → 2600 | 6 → 5 | 144 → 142 / 145 | 28 → 25 | 22.6 → 21.1 |
| many-conversations-heap | desktop | 1× | 802 → 800 / 790 | 258 → 234 | 1 → 1 | 54 → 50 | 1 → 1 | 14.4 → 14.3 |
| many-conversations-heap | desktop | 4× | 1771 → 1719 | 879 → 813 | 2 → 2 / 1 | 224 → 207 | 16 → 13.5 | 14.2 → 14.1 |

| cold-load | cpu | ready (ms) | FCP (ms) | DCL (ms) | JS requests | JS transfer (KB) | JS decoded (KB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| desktop | 1× | 133 → 115 | 116 → 98 | 72.7 → 53.2 | 4 → 14 | 1260 → 336 | 1259 → 1258 |
| desktop | 4× | 436 → 382 | 336 → 288 | 191 → 146 | 4 → 14 | 1260 → 336 | 1259 → 1258 |
| mobile | 1× | 126 → 106 | 108 → 92 | 73.9 → 53.7 | 4 → 14 | 1260 → 336 | 1259 → 1258 |
| mobile | 4× | 382 → 340 | 320 → 272 | 200 → 147 | 4 → 14 | 1260 → 336 | 1259 → 1258 |

Run-to-run variance: within a row, the 6 runs' main-thread times spread by 1–6% in most rows, 5–9% for `cold-load`, 11% for `multi-agent-review` and `tool-storm` desktop at 4×, and 16% for `long-stream` desktop at 4× and `tool-storm` desktop at 1×; heap after GC varies under 1%; JS bytes and requests are exact. The two reports' main-thread medians agree within 3%, except `long-stream` desktop at 4× (5690 and 5132 ms), `tool-storm` desktop at 4× (5946 and 6599 ms) and `multi-agent-review` at 4× (5811 and 6109 ms). Beyond that noise: `tool-storm` (−17% to −40% main thread, −35% to −56% script), `long-stream` mobile at 4× (−16% main thread, the two reports within 0.3% of each other), the `cold-load` timings (ready −11% to −16%, FCP −14% to −16%, DCL −24% to −27%, main thread −12% at 4×), the JS transfer (−73%, from compression) and heap after GC (−1.5 MB in `long-stream` and `multi-agent-review`). At its edge: `long-stream` desktop at 4× (−15%) and `multi-agent-review` at 4× (−11%). Within it, run-to-run variance exceeding the change: `long-stream` and `cold-load` main thread at 1× (−1% and −6%), `multi-agent-review` at 1× (+6%), dropped frames in the stream scenarios, their longest task (unchanged), and `many-conversations-heap`'s main thread at 1× and long-task count at 4× (1 or 2 per run). Long-task counts otherwise repeat in every run, so the 6 → 5 of `long-stream` desktop and `multi-agent-review` and the 4 → 5 of `long-stream` mobile at 4× hold; the exceptions are one 50 ms task in one `multi-agent-review` run at 1× and one `cold-load` mobile run at 4× with 2 instead of 3. `many-conversations-heap` doesn't show P5: heap after GC doesn't change with eviction off (`KEEP_RELEASED` raised to 1000), to within 0.1%, though the stream's cursor list stops growing at four stores as it should. Its conversations are a 4 KB snapshot each, every visited store stays reachable through its `commands` query (see Open), and the heap grows by about 4.4 MB at the first conversation (Shiki, its TypeScript grammar, the conversation's code) and about 135 KB per conversation after it. Showing P5 takes conversations with large transcripts, measured after the stores are released.

## Tier 1: likely to be felt

### P1. One synchronous React render per streamed event (confirmed; resolved)

zustand's `useStore` renders through `useSyncExternalStore`, which can't be time-sliced, so every store update is a synchronous render, and P2 and P3 multiply by the update rate. On desktop, every agent streaming in the tab adds its own event rate, and a reconnect replays up to 10,000 events (P9, P10).

The registry (`web: store/live-registry.ts`) buffers `event` frames per store (`pending`) and applies each store's buffer with one `applyBatch` (`store/conversation-store.ts`), one `set()`, per animation frame. A batch folds its events through the same reducers as a single event, and only changed slices get new identities.

- `requestAnimationFrame` doesn't fire in hidden tabs, so a `FLUSH_TIMEOUT_MS` (100 ms) timer and `visibilitychange` flush too.
- Every non-`event` frame, stream error and `closeStream` flushes first, so effects keep the stream's order and reconnect cursors include buffered events.
- The per-event side effects run as each event is applied, through `applyBatch`'s visitor: the `git_status` review invalidation, and the ready transition, which stops the batch and refetches.
- A refetch discards the store's buffer; its snapshot supersedes it.

### P2. The streaming message is re-parsed as markdown on every delta (confirmed; Streamdown behaviour verified externally; resolved)

The streaming text grows by concatenation (`protocol: live.ts:396-407`) and `AssistantText` passes the full string to `Markdown` (`web: features/conversation/transcript/assistant-message.tsx`, `components/markdown.tsx`). On each change Streamdown runs remend over the whole string and re-splits it into blocks. Blocks are memoised by content, so only the trailing block goes through the remark/rehype pipeline again: O(L) per update for the split, plus the full cost of the last block. P1 bounds this to once per frame.

- A code fence still streaming renders unhighlighted: `CodeBlockPre` passes `PLAIN_THEMES` for an incomplete fence, and `lazyCodePlugin` returns plain lines for them without Shiki. The block highlights once when its fence closes or the message finishes, without remounting.
- `lazyCodePlugin` (`lib/code-highlighter.ts`) runs Shiki a line at a time, each line continuing from the grammar state the previous one ended in, and yields to the event loop every 8 ms (`SLICE_MS`). A grammar compiles its rules as it first meets them, so in one task a closed fence would block the main thread for its language's whole compile (a 12-line TypeScript block: about 90 ms at 1×, 370 ms at 4×, against 1–2 ms warm), and a long block for its length (400 lines of TypeScript: about 75 ms warm). Highlighting the growing fence on every delta would spread the compile over the deltas, but tokenise the block again on each one; slicing bounds a task to one slice plus the costliest line instead. The slice's deadline is shared by all highlights, so blocks that start highlighting together (a finished message with several code blocks) don't each take a slice in the same task.
- The plugin tokenises for the light theme only (Shiki tokenises once per theme; Streamdown's dark styles fall back to the light colours), and a language's aliases (`ts`, `typescript`) share one highlighter, so one grammar compile.
- Text that mounts streaming keeps Streamdown's streaming mode once it finishes (`Markdown` fixes `mode` at mount), and `AssistantText` keeps `codeRefs` on throughout, so finishing re-renders only the blocks that change. Static mode would render the whole text as one unmemoised tree, replacing its DOM and highlighting its code blocks again. A finished text with link reference or footnote definitions is the exception: `parseFinishedBlocks` keeps it as one block, rendered again once, because a reference resolves only against definitions in its own block.
- `streamingSteps` tests for content with `/\S/` (`transcript/live-steps.ts`), which stops at the first non-space character instead of copying the string.

### P3. Per-update work over every step of the live turn (confirmed; resolved)

Every update to the streaming message gives the last turn new live steps. `TurnView` (`transcript/turn.tsx`) then dedupes them against the committed steps, merges the two lists and runs `groupSteps`, which allocates new group objects: O(N) small work per update, N the step count of the turn, once per frame with P1.

What it doesn't do is re-render N rows:

- `streamingSteps` caches each block's step in a `WeakMap` keyed by the block object; `reduceLive` replaces only the block a delta touches, so the other steps keep their identity.
- `StepItem` is memoised, and `GroupItem` skips re-rendering when its group has the same steps by identity (`sameGroup`).
- Step labels are computed from the committed steps only, so the label context doesn't change on deltas.

### P4. Session catalog rescans (confirmed; partly resolved)

- `server: catalog/watcher.ts` watches `<agentDir>/sessions` recursively with a 500 ms trailing throttle, and `affectsListing` drops events that can't change the listing (`<sessions>/<project>/*.jsonl` only): deeper subagent files and other files don't schedule a rescan; project directories created or deleted, and events without a path, do.
- Each tick calls `StreamHub.refreshCatalog` (`live/stream-hub.ts`), which runs one rescan at a time: calls made during a rescan share one follow-up rescan. Each rescan calls `catalog.invalidate()`, bypassing the listing's 1 s TTL, and compares one `JSON.stringify` of the new list with the stored string.
- `scanNow` stats every session file. For a file whose `(inode, mtime, size)` changed, `summarize` (`catalog/sessions.ts`) resumes the parse from the cached byte offset when the file is the same inode, grew, and still has the last 64 bytes read right before that offset; otherwise (shrunk, rewritten in place by a format migration, replaced) it parses the whole file. The parse state carries what a full parse needs from anywhere in the file: the header, the last `session_info` name, the first and last user message and the last timestamp.

Remaining:

- Per distinct cwd, `layoutOf` (`catalog/layout.ts`) and `isDirectory` make several `statSync`/`readFileSync` calls on every scan; caching them per cwd is open.
- `sidebar.prune()` stats every pinned and collapsed path on each rescan (`stream-hub.ts:118`).

pi appends to the session file once per entry (a finished message or tool result), not per token, so a rescan runs about once per entry, at most every 500 ms, and reads only the appended bytes.

### P5. Opened conversations on the client (confirmed; resolved)

Each opened store holds its full transcript (all branches, tool results, diffs) and stays in the stream's cursor list, so the server sends its events, including background agents' deltas, and the client reduces them.

The registry keeps the conversation on screen and the `KEEP_RELEASED` (3) most recently used released stores; the rest are evicted (`evictReleased`) after each hydrate, just before the reconnect that hydrate makes anyway (P7), so eviction costs no extra reconnect. Eviction stops feeding the store without marking it closed; opening its agent again creates a new store from a snapshot.

### P6. Diffs are refetched after every turn (confirmed; partly resolved)

`server: agents/pipeline.ts:611-637` publishes `git_status` after a trailing 2 s debounce following each `turn_end` and bash command, whether or not anything changed; the contract at `:621-624` is that clients refetch diffs on it. The client invalidates review queries on each one, and an open Changes tab refetches the working-tree diff (`web: features/review/changes-view.tsx`) and the open file (`file-viewer.tsx`). On desktop the review pane stays open beside the conversation, so this runs on every turn.

- The diff and file-content routes (`server: http/review-routes.ts`) send `Cache-Control: no-store` and a weak `ETag`, a hash of the JSON body, and answer a request with a matching `If-None-Match` with a bodiless 304. The client (`web: lib/api.ts`, `getRevalidated`) sends the ETag of its cached response and, on a 304, returns that cached object, so react-query neither parses nor compares a new copy, and the diff view doesn't re-render. The tag is weak because `compress()` weakens the tag of each 200 it encodes, and the 304 must carry the same tag. The client reads the 304's empty body: Chromium reports a request finished only once its body is read, and cancelling the body aborts the request.
- The count-mismatch fallback runs its per-file `git diff`s at concurrency 8 (`FILE_DIFF_CONCURRENCY`, `server: git/git.ts`), like untracked files.

Remaining: the server runs the whole diff to hash it (`gitDiff` with a `git diff --no-index` spawn per untracked, non-ignored file; `runGit` buffering up to 64 MB per process, `git.ts:60-119`; `gitStatus` making 3-5 sequential spawns, `:148-162`). Publishing `git_status` only when it changes doesn't help: `GitStatus` is `{branch, dirty}`, computed with `-uno`, so further edits to an already dirty tree would never refresh the diffs. Generating untracked-file patches in-process is open.

## Tier 2: memory, load and server cost

### P7. Every hydrate reconnects the whole SSE stream (confirmed)

After each snapshot fetch, `refetch` calls `reconnect()` (`web: store/live-registry.ts:290`), which closes the `EventSource` and opens a new one listing every opened store's cursor (`:321-330`). Hydrates happen on open, on `resync` and when an agent becomes ready, so a new agent reconnects twice. Each connect makes the server rebuild the baseline (the full session list, and `sidebarView`, which runs sync `statSync`/`readFileSync` per pinned repo: `server: store/sidebar-state.ts:43-49`, `catalog/layout.ts:44-50`) and replay every opened store from its cursor. P5 bounds the replay set to the conversation on screen and three others.

The same path also invalidates review queries on every snapshot (`live-registry.ts:288`), so open diffs revalidate on each hydrate; with P6's ETags an unchanged diff costs a 304.

### P8. Cold start (confirmed; resolved)

- `router.tsx` keeps Home and the conversation, the screens a cold start opens, in the entry chunk; Sessions, Tree, Diff, Share and Settings load through `lazyRouteComponent`, preloaded on link hover (`defaultPreload: "intent"`). The diff viewer and Shiki are lazy as well.
- Vendor code sits in its own chunks (`VENDOR_CHUNKS` in `vite.config.ts`: React, Radix, TanStack, the markdown stack), so a deploy that changes only the app keeps their hashes and the caches of them.
- `pnpm build` writes Brotli and gzip variants of the build (`web: scripts/compress-dist.ts`), and `server: http/static.ts` sends the best variant the request's `Accept-Encoding` allows, with `Vary: Accept-Encoding`. Assets are served `immutable` for a year.
- `server: app.ts` compresses `/api` responses whose type is `application/json`, the conversation snapshot included; `text/event-stream` is excluded, because compressing it would buffer `/api/stream`'s frames.
- The service worker precaches the app shell without Shiki's chunks, the diff viewer's chunk (highlight.js through lowlight, about 1 MB) and the font subsets beyond basic Latin (`web: sw/lazy-assets.ts`); it caches those on first use (`CacheFirst`, keeping the 200 most recently used), so they work offline from then on.

The measured cold load fetches 14 JS files, 336 KB on the wire, 1,258 KB decoded (see "Measurements"). Parsing and compiling the entry chunk is paid on every cold start.

### P9. The replay log (confirmed; pi payloads verified externally; partly resolved)

`server: agents/event-log.ts` keeps, per agent, the last 10,000 events and at most 32 MB of them (`EVENT_LOG_MAX_BYTES`, measured as JSON length), evicting the oldest. Each event is held only as its JSON string (`LoggedEvent`), so the bound measures what the log keeps. pi's bash tool sends a cumulative output snapshot of up to 50 KB every 100 ms while a command runs; ordinary turns hit the count first, and such runs hit the byte bound, which still replays about a minute of them. A client further behind resyncs from a snapshot.

Remaining:

- Superseded `tool_execution_update` events for the same `toolCallId` could be dropped, since `reduceLive` keeps only the latest `partialResult` (`protocol: live.ts:298-306`), but `EventLog.since()` assumes contiguous seqs (`event-log.ts:90-96`) and would need a seq search first.
- `agents/idle-sweep.ts:9` closes agents after 7 days idle, so each opened conversation keeps a `pi` process, its transcript caches and this log for up to a week. Shortening the limit for agents that aren't streaming and have no pending dialog is open; restarting with `--session` already exists.

### P10. Reconnect replay is built in one synchronous block (confirmed)

For each opened agent, `server: http/stream.ts:95` slices the events after the client's cursor, and `:123` joins their frames into one string before writing. The frames are built around each event's cached JSON (P15), so nothing is stringified, but a resume after a long bash run still concatenates up to the log's 32 MB (P9) on the event loop. Replay is exempt from `maxBacklog`, and the backlog counts frames (20,000), not bytes (`:62`, `:78-82`).

Fix: build the replay incrementally and write it in chunks; send `resync` when it would exceed the snapshot's size; bound the backlog by bytes. The slice has to stay synchronous with the subscription, and queued live frames still follow the replay.

### P11. Sidebar row re-renders (confirmed; low frequency; resolved)

The desktop sidebar is always mounted and lists every conversation. `web: features/sidebar/sidebar.tsx` rebuilds the grouped model on agent, catalog, branch and sidebar frames (never on deltas). `Row` is memoised on value props (title, agent, session file, time label) with stable callbacks; the 60 s `useNow` tick computes each row's relative time label, so only rows whose label changes re-render. A row's `×` is a `DismissButton` given the target the row already knows, without a `useLive` selector scanning all agents. The `StopOrDelete` and `WorktreeActions` context values are memoised (`features/sessions/stop-or-delete.tsx`, `features/worktrees/worktree-actions.tsx`).

`StopOrDeleteButton`, used by Home and the Sessions list, scans agents for a row given only a session file: O(rows × agents) per live-store change on those screens.

## Tier 3: real, cheaper

### P12. Full re-render on hydrate, and no transcript virtualisation (confirmed)

Hydration (`web: store/conversation-store.ts:95-107`) replaces every entry object, so every `entrySteps` / `buildTurns` memo misses and every turn re-renders and recounts its stats; `Markdown`'s string memo prevents re-parsing. After the first open this only happens on `resync` and ready. The larger cost is mounting a long transcript the first time: every turn mounts (`transcript/transcript.tsx:24-33`), and `content-visibility: auto` (`turn.tsx:241`) skips layout and paint, not React or Streamdown.

Fix: reconcile snapshot entries by id and reuse unchanged objects; window long transcripts.

### P13. `message_end` and `turn_end` hold the event queue on pi RPC round-trips (confirmed)

`server: agents/pipeline.ts:213-219` processes events through one sequential queue. `message_end` awaits `get_entries` (`:391-394`, `:723-731`) and `turn_end` awaits `get_session_stats` (`:406-408`, `:791-794`) before later events publish. The events that wait are tool and `message_start` events, not text deltas, so this is a pause at boundaries. The ordering is load-bearing (`unsyncedMessages` gating at `:385-388`, `:739-745`). The stdout pipe can't be paused for backpressure either, because the awaited RPC responses arrive on it. No change recommended without a measured problem.

### P14. Live subscriptions in past turns (confirmed; low)

Every `TurnView` calls `useLiveSteps`, but past turns' selectors return constants (`transcript/live-steps.ts:85-122`), and selectors are O(1) through a WeakMap memo (`store/selectors.ts:19-29`). The real remainder is historical `ToolCallSlot` rows, which subscribe to live tool state (`transcript/tool-call-slot.tsx:35-38`) and run `toolStatus` (`store/tool-status.ts:71-81`) on every store change, once per frame with P1.

### P15. SSE frames are serialised per connection (confirmed; low; resolved)

`EventLog.append` (`server: agents/event-log.ts`) stringifies each event once, and `eventFrameData` (`http/stream.ts`) builds the `data:` of every connection's frame around that string. The `id:` cursor list is rebuilt per frame per connection, over every streamed agent: cheap at one to three clients. `EventLog` runs its listeners synchronously in `append`, so this is on the producer path.

### P16. File search spawns git and re-prepares the full list per query (confirmed)

`server: git/files.ts:40-64` runs a worktree check and `git ls-files --cached --others --exclude-standard` per request, then `fuzzysort.prepare` twice per path. The client debounces at 250 ms (`web: features/review/files-view.tsx:18`). Nothing is cached, to keep memory flat (`files.ts:47-48`). A cache would be bounded to one cwd with a short TTL; `.git/index` mtime can't invalidate it, because new untracked files don't touch the index.

### P17. Shimmer animates `background-position` (suspected; low)

`web: index.css:229-257` animates `background-position` on `background-clip: text`, which repaints rather than compositing. The shimmering elements are small and reduced motion is respected; the one that matters is in the header (`features/conversation/header.tsx:152`), under `backdrop-blur`.

### P18. Smaller items

- `lib/use-elapsed.ts:7-15`: one `setInterval` per running tool or subagent row; a shared ticker would do.
- `tools/file-edits.tsx:67` calls `countPatchLines` unmemoised per label; `features/review/changes-view.tsx:431` and `components/diff/diff-viewer.tsx:104` each parse the same patches.
- `transcript/thinking.tsx` (resolved): `lastLine` scans back from the end of the live thinking text instead of splitting it on every update.
- `protocol: caches.ts:39` and `server: agents/pipeline.ts:737` rebuild an id `Set` over the transcript on each append.
- `lib/query-client.ts:6`: `refetchOnWindowFocus: true` with a 5 s `staleTime` refetches SSE-backed lists on each focus.
- `server: catalog/sessions.ts:379` runs a sync `findGitDir` walk per project on each `/api/projects` request.
- `server: push/push-service.ts:27-45` passes no timeout to `web-push`; a hung endpoint keeps `deliver()` pending.
- `features/conversation/use-stick-to-bottom.ts:43-46` writes `scrollTop = scrollHeight` on each content resize, and `conversation-outline.tsx:50-77` reads layout on the same frame (suspected forced layout, once per render).

## Checked and fine

- Streamed `message_update` events are deltas: pi strips `partial` (`docs/design/01-server.md:91`, and the installed pi's `json-event.js`). Text deltas average about 360 B in fixtures; `tool_execution_update` is the large event (P9).
- Catalog frames don't fire per message: `StreamedSession` omits `updatedAt` and `ownedBy` (`server: live/stream-hub.ts:33`), so the comparison at `:127` only broadcasts on prompts, renames and new or removed sessions. The query invalidation they trigger refetches only active queries (Home, Sessions, Share, the project picker); the conversation screen has none. Writing the frame into the query cache instead would drop fields the HTTP summaries carry.
- `agents/jsonl.ts:31-48` collects fragments and joins once per line.
- Reducers share structure (`protocol: live.ts:9-11`); `turns.ts` memoises steps per entry; `TurnView` and `Markdown` are memoised.
- Listener and timer cleanup is correct in every place checked (`use-media-query`, `server-status`, `sw-messages`, `live-registry`, `DiffViewImpl`).
- Shiki loads lazily in its own chunks, is covered by the `immutable` HTTP cache and the service worker's on-first-use cache, and the CSS-variable theme means palette changes don't re-highlight.
- Sidebar and file search are debounced; file search returns at most 10 results.
- Only `/api/health` polls (30 s, 5 s on error).
- `review-state` persists only `{paneOpen, tab}` per agent.
- The curator proxy streams responses and tears down upstream on disconnect.
- The sidebar store writes only on change; push subscriptions rewrite a small file per add or remove.

## Suggested order

1. P7: avoid a full reconnect per hydrate.
2. P10: chunked replay and a byte-bounded backlog; P9's remaining items (superseded tool updates, shorter idle limit).
3. P4's remaining items: layout lookups cached per cwd, `sidebar.prune()` off the rescan path.
4. P6's remaining items: untracked-file patches in-process.
5. P12: reconcile snapshot entries by id; window long transcripts.
