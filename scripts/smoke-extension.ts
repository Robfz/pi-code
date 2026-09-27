/**
 * Throwaway pi extension for `scripts/smoke.ts`: a `/smoke-dialog` command that opens dialogs
 * without any LLM call. Loaded only through `scripts/smoke-pi.sh` (CLI `--extension`, which
 * needs no project trust and touches no pi config).
 */
interface SmokeUi {
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface SmokeApi {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: { ui: SmokeUi }) => Promise<void>;
    },
  ): void;
}

export default function smokeExtension(pi: SmokeApi): void {
  pi.registerCommand("smoke-dialog", {
    description: "pi-code smoke test: a select dialog, then a select that times out",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("smoke pick", ["alpha", "beta"]);
      const timed = await ctx.ui.select("smoke timeout", ["x", "y"], { timeout: 1500 });
      ctx.ui.notify(`smoke result ${JSON.stringify({ choice, timed: timed ?? null })}`, "info");
    },
  });
}
