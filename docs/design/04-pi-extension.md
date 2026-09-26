# pi-code extension design

A small pi extension loaded **only** into server-spawned pi processes (`pi --mode rpc --extension <path>`). The TUI never loads it. Source: `packages/pi-extension/src/index.ts` (pi loads TypeScript directly).

It fills two gaps in pi's RPC mode. Both are documented extension APIs.

## 1. Project trust prompt

**Problem.** RPC mode can't show pi's trust prompt. A never-trusted project opened from the web silently skips its `.pi/` resources.

**Mechanism.** A `project_trust` handler. Only user-level and command-line extensions receive this event, and it runs before project extensions load. pi fires it only when the project has protected resources, and asks extensions *before* consulting saved decisions.

```ts
pi.on("project_trust", async (event, ctx) => {
  if (ctx.mode !== "rpc" || !ctx.hasUI) return { trusted: "undecided" };
  if (hasSavedDecision(event.cwd)) return { trusted: "undecided" };   // let pi apply it
  const ok = await ctx.ui.confirm(
    "Trust this project?",
    `${event.cwd} contains pi settings, extensions, skills or prompts. Trusting it lets them load and run.`,
  );
  return { trusted: ok ? "yes" : "no", remember: true };
});
```

- `hasSavedDecision` reads `~/.pi/agent/trust.json` (canonical path → boolean) and checks `cwd` and its parents. On a missing or unparseable file it returns `false` (the user gets asked).
- `remember: true` makes pi save the decision in `trust.json`, so it's shared with the TUI and asked only once.
- The `confirm` travels over RPC as an `extension_ui_request`; the web client shows it while the agent is starting.

## 2. In-place tree navigation

**Problem.** RPC has `fork` and `clone` but no equivalent of the TUI's `/tree` (move the leaf within the same session file, optionally summarizing the abandoned branch).

**Mechanism.** A command, invoked by the server as a prompt (extension commands run immediately):

```
/pi-code-tree {"requestId":"…","entryId":"…","summarize":true,"customInstructions":"…"}
```

Handler:

1. Parse the JSON argument.
2. `await ctx.navigateTree(entryId, { summarize, customInstructions })`.
3. If the target entry is a user message, `ctx.ui.setEditorText(<its text>)` (the TUI puts it back into the editor for re-editing).
4. Report completion: `ctx.ui.setStatus("pi-code:tree", JSON.stringify({ requestId, cancelled }))`, then clear it.

The server treats `setStatus` keys prefixed with `pi-code:` as a private channel: it resolves the pending `POST /tree/navigate` request, triggers a transcript resync, and does not forward the status to clients. It also hides `pi-code-*` commands from `get_commands` results.

If the implementation spike (plan, task E2) shows that pi's `prompt` response already waits for the command handler to finish, the status channel is dropped and the server resolves on the prompt response.

## Non-goals

No tool registration, no rendering, no state. Anything that must also work in the TUI does not belong here.
