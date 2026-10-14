# pi-code extension design

A small pi extension loaded **only** into server-spawned pi processes (`pi --mode rpc --extension <path>`). The TUI never loads it. Source: `packages/pi-extension/src/index.ts` (pi loads TypeScript directly).

It fills two gaps in pi's RPC mode, adds one prompt guideline and names conversations, using documented extension APIs. Trust and tree navigation were verified in `docs/spikes/e1-e2.md`.

It is typed against `@earendil-works/pi-coding-agent` `1.1.0` (dev dependency, type-only imports), the installed pi's version, for `BeforeAgentStartEvent.systemPromptOptions` (section 3). The protocol package keeps its own pin.

## 1. Project trust decision

**Problem.** RPC mode can't show pi's trust prompt, and inside `project_trust` handlers `ctx.hasUI` is `false` in RPC mode, so an extension can't ask either.

**Mechanism.** The server asks the user *before* spawning pi (see `01-server.md`, Project trust) and passes the answer in the environment. The extension turns it into a remembered decision:

```ts
pi.on("project_trust", () => {
  const d = process.env.PI_CODE_TRUST;
  if (d === "yes" || d === "no") return { trusted: d, remember: true };
  return { trusted: "undecided" };
});
```

- `remember: true` makes pi write the decision into `~/.pi/agent/trust.json` under its own file lock, so it's shared with the TUI and asked only once.
- pi calls the handler only when the project has protected resources; it runs before saved decisions are consulted, which is why it returns `undecided` unless the server set the variable.

## 2. In-place tree navigation

**Problem.** RPC has `fork` and `clone` but no equivalent of the TUI's `/tree` (move the leaf within the same session file, optionally summarizing the abandoned branch).

**Mechanism.** A command, invoked by the server as a prompt. Extension commands run immediately, and pi's `prompt` response arrives only after the handler finishes:

```
/pi-code-tree {"entryId":"…","summarize":true,"customInstructions":"…"}
```

Handler:

1. Parse the JSON argument.
2. `await ctx.navigateTree(entryId, { summarize, customInstructions })`.
3. If the target entry is a user message, `ctx.ui.setEditorText(<its text>)` (the TUI puts it back into the editor for re-editing).

The server resolves `POST /tree/navigate` on the prompt response and reports `cancelled` when the leaf did not move. Before sending, it checks that `pi-code-tree` appears in `get_commands` — otherwise the text would go to the model as a normal prompt. It hides `pi-code-*` commands from `get_commands` results given to clients.

## 3. Line-reference guideline

**Problem.** The web client links `@path:N` and `@path:N-M` references in assistant replies ([`07-code-review.md`](07-code-review.md), "References"), but the model writes them only when asked. The TUI's `APPEND_SYSTEM.md` belongs to the user and must keep working unchanged.

**Mechanism.** A `before_agent_start` handler adds `REFERENCE_GUIDELINE` to the run's structured prompt options and returns nothing, so pi still builds the prompt from its sections:

```ts
export const REFERENCE_GUIDELINE =
  'When you point to specific lines of code, write the reference as `@path:N` for one line or `@path:N-M` for a range, with the path relative to the working directory. Quote paths that contain spaces: `@"dir name/file.ts":N`. The user can click these references to open those lines.';

pi.on("before_agent_start", (event) => {
  const options = event.systemPromptOptions;
  if (options.customPrompt) {
    if (!options.appendSystemPrompt.includes(REFERENCE_GUIDELINE))
      options.appendSystemPrompt = [options.appendSystemPrompt, REFERENCE_GUIDELINE].filter(Boolean).join("\n\n");
  } else if (!options.promptGuidelines.includes(REFERENCE_GUIDELINE)) {
    options.promptGuidelines.push(REFERENCE_GUIDELINE);
  }
});
```

- pi renders `promptGuidelines` only without a custom prompt (a user's `SYSTEM.md`); with one, the guideline joins `appendSystemPrompt`, after the loaded `APPEND_SYSTEM.md`.
- The guideline is added at most once per run.
- Since only server-spawned pi loads the extension, TUI sessions never get the guideline.

## 4. Automatic conversation names

**Problem.** Unnamed conversations show their first prompt as the title, which is often long or vague. pi names a session only on request (`/name`, Rename…).

**Mechanism.** An `agent_end` handler (`src/auto-name.ts`) names an unnamed session after its first reply:

1. Skip when the session has a name (`pi.getSessionName()`) or this session was already attempted.
2. Take the first exchange from `ctx.sessionManager.getBranch()`: the first user message and the first run's last assistant text. Until that reply has text, wait for the next `agent_end`. Each side is cut to 4,000 characters: the user side keeps its end, since attached `<file>` blocks come first, and the reply keeps its start.
3. Find `anthropic/claude-haiku-5-5` in `ctx.modelRegistry`. Without the model or configured auth, stop silently: that is a provider choice, not an error.
4. Ask it for a 3–6 word title through `ctx.modelRegistry.streamSimple()` (pi's auth, `reasoning: "low"`, the lightest level Haiku 5.5 allows), without awaiting it, so pi goes idle as usual.
5. Clean the reply (first line, no wrapping quotes or trailing punctuation, at most 80 characters) and call `pi.setSessionName()` unless a name was set meanwhile. pi emits `session_info_changed`, which the server and web client already handle.

- One attempt per session (reset on `session_start`), so a failure can't repeat. A failed request or empty reply shows one `warning` notice ("Couldn't auto-name this conversation: …") and the title stays the first prompt.
- `session_shutdown` aborts an in-flight request, so a title can't land on the session that replaced it.
- Sessions resumed without a name are named after their next run.
- The title request's cost isn't added to the session's usage.

## Non-goals

No tool registration, no rendering, no persisted state. Anything that must also work in the TUI does not belong here.
