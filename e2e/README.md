# End-to-end tests

Playwright tests of pi-code in a real Chromium against the real server and the production web build, with the fake pi (`test/fake-pi.ts`) instead of a model. Two suites:

- **Regression** (`tests/`): what users do, on a desktop and a phone, asserted on the DOM and on the server's state.
- **Perf** (`perf/`): timings of the same flows (main-thread time, long tasks, frames, heap, load), for before/after comparisons. See [`perf/README.md`](perf/README.md).

Both stay out of `pnpm test`.

## Running

From the repo root:

```sh
pnpm --filter @pi-code/e2e exec playwright install chromium   # once, and after Playwright upgrades
pnpm e2e                               # regression, desktop and mobile
pnpm e2e --project=desktop             # one project (any `playwright test` argument works)
pnpm e2e tests/smoke.spec.ts --debug   # one file, with the inspector
pnpm e2e:perf                          # timing scenarios → e2e/results/
pnpm e2e:compare <before.json> <after.json>
```

Every run builds the web app first (`pnpm --filter @pi-code/web build`, a few seconds). A failed test keeps a trace: `pnpm --filter @pi-code/e2e exec playwright show-trace <path printed in the failure>`.

## How it works

```
global-setup ─ web build, temp root, shims, fixture check
  └─ worker ─ real server (packages/server, NODE_ENV=test)
       └─ agent ─ $E2E_ROOT/bin/pi ─ harness/pi-wrapper.ts ─ test/fake-pi.ts <fixture>
```

- **Global setup** (`global-setup.ts`, once per run) builds `packages/web/dist`, makes a temp root (`$TMPDIR/pi-code-e2e-*`, removed by `global-teardown.ts`) with two shell shims in `bin/` (`pi`, which runs the wrapper, and `trash`, see below), and checks one generated fixture of each kind with `checkFixture`.
- **One server per worker** (`harness/server.ts`, the worker-scoped `server` fixture): `node --import tsx src/main.ts` on two free ports, so tests in different workers never see each other's agents. Its environment drops every `PI_CODE_*` and `PI_AGENT_DIR` variable you have set and points everything into the worker's dir under the temp root: `HOME` (`home/`, with the test projects in `home/projects/`), `PI_AGENT_DIR` (`agent/`, sessions in `agent/sessions/`), `PI_CODE_DATA_DIR` (`data/`). Nothing reads or writes your `~/.pi` or `~/.config/pi-code`. Git, the harness's and the server's, runs without your global and system config, inherited `GIT_*` variables or background maintenance, and `trash` is a shim that deletes, so deleting a conversation doesn't move test files to your Trash. The browser opens `http://localhost:<port>`.
- **The pi wrapper** (`harness/pi-wrapper.ts`) is `PI_CODE_PI_BIN`. The server starts it in the conversation's project dir; it reads `control/<basename of the dir>.json` (`{ fixture, speed }`) and runs the fake pi on that fixture. Every project dir has a unique basename, so the project picks the fixture: `app.project()` and `app.conversation()` write the fixture and the control file together. Without a control file the agent exits and shows the wrapper's message in its stderr.
- **Fixtures** are generated per test by `harness/fixtures/generate.ts`, in the recorded format of `test/fixtures/*.jsonl` (see [`test/README.md`](../test/README.md)): the same event sequence, entry syncs and trailing `get_state` / `get_entries` / `get_session_stats` as real pi, with the test's cwd, session file and prompt. `get_state` reports the session file the test chose, so a seeded catalog row and its open conversation are the same session. Kinds, with the expectations each exports:

  | Kind | Run | Export |
  |---|---|---|
  | `short-answer` | Thinking, then about 30 text deltas 25 ms apart | `SHORT_ANSWER` |
  | `long-stream` | About 1,200 text deltas (4–6 characters, 25 ms apart, some in bursts): six sections, each a heading, prose and a fenced block (`ts`, `json`, `bash`, `python`, `css`, `diff`), three line references (`@src/app.ts:12`, …). About 30 s at speed 1 | `LONG_STREAM` |
  | `tool-storm` | 200 sequential tool calls, 20 blocks of 8 exploration calls (`read`, `grep`, `find`) then `bash` and `edit`, about 100 ms each, then a short answer. About 20 s at speed 1 | `TOOL_STORM` |
  | `history` | No run: a finished exchange (one prompt, an answer with a `ts` block and a reference) served from the start, as a resumed session | `HISTORY` |

  The fake answers commands in order, so a fixture takes exactly one `prompt` (`history` takes none). `speed` is fake-pi's: `0` (default) replays instantly, `1` with the generated spacing, `N` N× faster. A run you need to observe while it streams needs `speed` > 0.
- **`checkFixture`** (`harness/fixtures/check.ts`) checks what the server relies on: every query answered once, entries chained by `parentId` with `leafId` on the last, every message's entry after its `message_end` and keyed by a unique `role:timestamp`, deltas adding up to the final message, every tool call run to a result, the trailing queries reporting the test's session. A fixture breaking those would make the server fall back to a full transcript reset, which hides missing content instead of failing.
- **Projects**: `desktop` is Desktop Chrome at 1440×900 (docked sidebar, review pane); `mobile` is a Pixel 7 (touch, 412 px wide). Chromium only.
- **Service workers** are blocked (requests a service worker handles bypass `page.route`), except in specs that `test.use({ serviceWorkers: "allow" })`.

## Writing a test

Import `test` and `expect` from `harness/test.ts`, and set up through the `app` fixture (`harness/app.ts`):

```ts
import { LONG_STREAM } from "../harness/fixtures/generate.ts";
import { expect, test } from "../harness/test.ts";
import { sendPrompt } from "../harness/ui.ts";

test("a long reply ends with highlighted code", async ({ app, page }) => {
  const conversation = await app.conversation({ kind: "long-stream", speed: 4 });
  await app.open(conversation);
  await sendPrompt(page, conversation.prompt);
  await app.waitForRunEnd(conversation);
  await expect(page.locator('[data-streamdown="code-block"]')).toHaveCount(LONG_STREAM.codeBlocks);
});
```

| `app.` | |
|---|---|
| `conversation({ kind, speed?, prompt? })` | A git project (`README.md`, `src/app.ts` with 12 lines, `src/lib/util.ts`, in one commit) with the fixture, and an agent started on it (`POST /api/agents`). Returns `{ id, name, cwd, prompt, sessionFile, … }` |
| `project({ kind, speed?, prompt? })` | The same without starting the agent, for tests that start it from the UI (New conversation, Folder path = `cwd`) |
| `seedSession()` | A `history` project plus a session file in pi's sessions dir: the catalog lists it under its `prompt`, opening it shows the history |
| `open(conversation)` | Goes to `/agents/<id>` and waits for the composer to be enabled |
| `runEnded(conversation)` / `waitForRunEnd(conversation)` | The run is over on the server (snapshot); `waitForRunEnd` then waits for the page to show it (no Stop, no live turn) |
| `snapshot(conversation)` | The server's `GET /api/agents/<id>/snapshot` |

Page helpers are functions of the page in `harness/ui.ts`:

| | |
|---|---|
| `composer(page)` | The message textbox |
| `sendPrompt(page, text)` | Fills the composer and clicks Send (never Enter: on touch it's a newline) |
| `isPinned(page)` | Whether the transcript is scrolled to its bottom |
| `openReviewPane(page)` / `sidebarRow(page, project)` | Desktop: opens the review pane and returns it; a project's sidebar row |
| `replyBlocks(scope)` | The text of each top-level markdown block of a reply, live (`live-turn`) or committed |
| `transcriptDigest(page)` | User and assistant texts, code block languages, references and tool rows, once every code block is highlighted, for comparing two renderings |

`server` (worker fixture) has the dirs (`projectsDir`, `sessionsDir`, `controlDir`, `fixturesDir`) and `api(method, path, body?)` for direct API calls. `window.__e2e.dropStream()` closes the page's event stream as a failed network would; hold it down with `page.route("**/api/stream*", (r) => r.abort())`.

Rules:

- Wait on observable state (`expect(...)`, `expect.poll`), never on time.
- Assert on the DOM and on server state, not on screenshots.
- Locate by role and accessible name first (`getByRole("button", { name: "Send", exact: true })`, `getByRole("textbox", { name: "Message" })`), then by the app's `data-testid`s (`transcript`, `transcript-scroll`, `user-message`, `assistant-text`, `tool-call` with `data-tool` / `data-status`, `exploration-group`, `live-turn`, `connection` with `data-state`, `sidebar-row`, `session-row`, `diff-file`, …). Add a `data-testid` to the app only where nothing accessible identifies the element.
- Each conversation gets its own project: the project's basename selects its fixture.
- Desktop-only behaviour: `test.skip(testInfo.project.name !== "desktop", …)`, with the mobile counterpart in the same file where one exists.

## Regression tests

| Spec | Desktop | Mobile |
|---|---|---|
| `smoke` | A prompt streams a reply that ends committed | Same |
| `streamed-reply` | A long streamed reply renders fully, stays pinned to the bottom, ends with highlighted code blocks and reference chips | Same |
| `tool-storm` | 200 tool calls show in order; exploration groups collapse and expand | Same |
| `stream-drop` | Dropping and restoring the stream mid-run ends with the same transcript as an uninterrupted run | Same |
| `conversations` | Opening and switching conversations; the sidebar follows new, finished, added and deleted sessions | The same through Home and the sessions list |
| `cold-load` | Lazy chunks load, assets come precompressed, the service worker installs without the lazy assets and caches them on use, the shell works offline | Same |
| `multi-agent` | Two agents streaming at once in one tab end correct, with the right sidebar statuses | — |
| `review` | The review pane updates after a turn; selecting lines adds `@path:N` to the composer; the Files tab's viewer has one line-number column | The Diff page from the conversation menu |

## Perf

`pnpm e2e:perf` runs the timing scenarios (long stream, tool storm, cold load on both projects; several agents with the review pane, and heap after many conversations, on desktop) at 1× and 4× CPU throttling, `E2E_PERF_RUNS` times each (default 3), and writes medians to `e2e/results/` as JSON and a markdown table. `pnpm e2e:compare` diffs two reports. Metrics, scenarios and how to read them: [`perf/README.md`](perf/README.md).

## Limitations

- The mobile project is Chromium with a phone's viewport, touch and user agent, not a phone: no mobile Safari, no real device CPU, memory or network.
- Timings are relative: compare reports from the same machine, under similar load. CPU throttling scales this machine's speed; it doesn't model a phone.
- The fake pi replays; it doesn't act. It never writes files or session files: a fixture's `edit` changes nothing on disk (tests change files themselves), and a new conversation's session file doesn't exist until a test writes one.
- A fixture takes one prompt: a second prompt, or any other command (model change, compact, abort), gets an error from the fake.
- Offline behaviour and the service worker are covered by `cold-load` alone: every other spec, and every perf scenario, blocks service workers.
