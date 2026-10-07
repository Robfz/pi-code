# Test fixtures and helpers

- `fixtures/*.jsonl`: real `pi --mode rpc` sessions (pi v0.87.1, `anthropic/claude-haiku-4-5`, thinking `low`), recorded by `scripts/record-fixture.ts`.
- `fake-pi.ts`: a Node script that speaks the pi RPC protocol and replays a fixture.
- `fake-pi.test.ts`: self-test for the fake.

## Fixture format

One JSON object per line:

```json
{"t": 498, "dir": "out", "line": {"type": "agent_start"}}
```

- `t`: milliseconds since pi was spawned.
- `dir`: `in` (a command written to pi's stdin), `out` (a stdout record), or `err` (a stderr line).
- `line`: the parsed JSON record, or the raw string when it isn't JSON (always the case for `err`).

The recorder behaves like the pi-code server. After every `message_end` and `entry_appended` it sends `get_entries {since: <last seen id>}`, with one request in flight at a time. Every fixture ends with `get_state`, `get_entries` and `get_session_stats`.

User-installed extensions and packages load in RPC mode, and they were active while recording: `pi-web-access`, `pi-mcp-adapter`, and `~/.pi/agent/extensions` (label, subagent, status-bar, …). So the fixtures contain their startup noise: a `setStatus` request for `mcp` whose text includes ANSI escapes, a stderr warning from pi-web-access, and extra tools in the system message. The system message also includes the user's `APPEND_SYSTEM.md` and skill list.

`subagent` was recorded with pi v1.0.4, where MCP is built into pi rather than provided by `pi-mcp-adapter`. It has no `mcp` status chip and no stderr warning. Instead it gets a `notify` warning listing MCP servers that need sign-in.

| Fixture | Scenario |
|---|---|
| `plain-answer` | One short question, answered with thinking + text |
| `tool-calls` | `read`, then `edit` (the edit result includes `details.diff`/`patch`) |
| `parallel-tools` | Two `read` calls in one assistant message |
| `steer-followup` | Multi-turn bash task; `steer`, `follow_up`, and `prompt` with `streamingBehavior: "steer"` sent mid-run |
| `abort` | Abort during text streaming, then abort during a running `bash` tool |
| `compaction` | `compact` on a tiny session (fails), 3 × `bash` bulk output, one turn, `compact` (succeeds), one more turn |
| `bash-command` | RPC `bash` (streamed, `excludeFromContext`, exit 3), then a prompt |
| `extension-dialog` | Throwaway extension: notify/setStatus/setWidget/setTitle/set_editor_text, then select/confirm/input/editor answered, plus a select left to time out |
| `slash-commands` | `/name foo` and `/compact` sent via `prompt`: both go to the LLM as plain text |
| `entry-types` | set_session_name, set_model ×2, set_thinking_level, `/label` (user extension), custom entry + custom message + label (throwaway extension), branch summary via `ctx.navigateTree`, get_tree, fork, clone, new_session |
| `subagent` | User subagent extension's `spawn` tool runs a project-local haiku agent; its `confirm` dialog arrives mid-tool |
| `web-search` | pi-web-access `web_search` (curator off); emits `entry_appended` (custom `web-search-results`) |

Re-record with (costs a few cents with haiku):

```sh
packages/server/node_modules/.bin/tsx scripts/record-fixture.ts --list
packages/server/node_modules/.bin/tsx scripts/record-fixture.ts plain-answer tool-calls   # or: all
```

Scratch repos live in `/tmp/pi-code-s0/work/<name>` and sessions in `/tmp/pi-code-s0/sessions/<name>`, both passed to pi with `--session-dir`. Re-recording changes ids, timestamps and model output, so tests should assert on structure, not text.

## Fake pi

```sh
node test/fake-pi.ts test/fixtures/plain-answer.jsonl [--speed=0|1|N]
```

```ts
import { spawnFakePi } from "../../test/fake-pi.ts";
const proc = spawnFakePi("plain-answer", { speed: 0 }); // fixture name or path
```

- **Gating commands** (anything that isn't `get_*`: prompt, steer, abort, bash, compact, set_*, fork, extension_ui_response, …) must arrive in the recorded order, matched by `type`. So `extension_ui_response`s match by order. When one arrives, the fake replays the recorded `out`/`err` lines up to the next gating command. It rewrites response ids (and `bash_execution_update` ids) to the id the client sent. Extension UI request ids are replayed verbatim, so answer with the id you received.
- **Queries** (`get_*`) never gate, and their recorded responses aren't replayed on their own. The fake answers any query immediately:
  - `get_entries [since]` is served from an entry list rebuilt from the recorded `get_entries` responses up to the current position. It also includes the next recorded one in the current segment, so a sync right after `message_end` sees the new entry. An unknown `since` gets `Entry not found: <id>`, as in real pi.
  - Other queries get the nearest recorded response of that type.
- A gating command that doesn't match the next recorded one gets a `success: false` response, and a `[fake-pi] unexpected command …` line on stderr.
- `--speed=0` (default) is instant. `1` keeps the recorded spacing, and `N` replays N× faster.
- The fake exits when stdin closes.

Before the first gating command, `get_entries` returns `{entries: [], leafId: null}`. Real pi already has `model_change` and `thinking_level_change` entries at startup.

Run the self-test: `pnpm vitest run --root test`. The root `vitest.config.ts` only lists `packages/*` as projects, so `pnpm vitest run test/fake-pi.test.ts` finds no files until `test` is added there.
