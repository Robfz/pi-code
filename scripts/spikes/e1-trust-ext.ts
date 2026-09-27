// E1 spike extension: project_trust handler over RPC.
// SPIKE_TRUST_MODE: "confirm" (default) | "env-yes" | "undecided" | "sleep" (3 s, then undecided)
export default function (pi: any) {
  pi.on("project_trust", async (event: any, ctx: any) => {
    const mode = process.env.SPIKE_TRUST_MODE ?? "confirm";
    process.stderr.write(
      `[spike-e1] project_trust fired cwd=${event.cwd} ctx.mode=${ctx.mode} ctx.hasUI=${ctx.hasUI} spikeMode=${mode} t=${Date.now()}\n`,
    );
    if (mode === "undecided") return { trusted: "undecided" };
    if (mode === "env-yes") return { trusted: "yes", remember: true };
    if (mode === "sleep") {
      await new Promise((r) => setTimeout(r, 3000));
      return { trusted: "undecided" };
    }
    const t0 = Date.now();
    const ok = await ctx.ui.confirm("Trust this project?", `${event.cwd} (spike)`);
    process.stderr.write(`[spike-e1] confirm resolved ok=${ok} after ${Date.now() - t0}ms\n`);
    return { trusted: ok ? "yes" : "no", remember: true };
  });
  pi.on("session_start", async (_e: any, ctx: any) => {
    process.stderr.write(
      `[spike-e1] session_start isProjectTrusted=${ctx.isProjectTrusted()} t=${Date.now()}\n`,
    );
  });
}
