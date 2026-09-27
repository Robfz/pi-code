# pi-code extension design

A small pi extension loaded **only** into server-spawned pi processes (`pi --mode rpc --extension <path>`). The TUI never loads it. Source: `packages/pi-extension/src/index.ts` (pi loads TypeScript directly).

It fills two gaps in pi's RPC mode using documented extension APIs. Behavior verified in `docs/spikes/e1-e2.md`.

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

## Non-goals

No tool registration, no rendering, no state. Anything that must also work in the TUI does not belong here.
