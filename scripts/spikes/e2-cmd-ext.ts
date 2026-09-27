// E2 spike extension: command completion timing.
export default function (pi: any) {
  pi.registerCommand("spike-wait", {
    description: "spike: wait 3s then notify",
    handler: async (_args: string, ctx: any) => {
      process.stderr.write(
        `[spike-e2] handler start t=${Date.now()} typeof navigateTree=${typeof ctx.navigateTree} typeof setStatus=${typeof ctx.ui?.setStatus}\n`,
      );
      ctx.ui.setStatus("pi-code:spike", "started");
      await new Promise((r) => setTimeout(r, 3000));
      ctx.ui.notify(`spike-wait done; typeof ctx.navigateTree=${typeof ctx.navigateTree}`, "info");
      process.stderr.write(`[spike-e2] handler end t=${Date.now()}\n`);
    },
  });
  pi.registerCommand("spike-throw", {
    description: "spike: throw after 1s",
    handler: async () => {
      await new Promise((r) => setTimeout(r, 1000));
      throw new Error("spike boom");
    },
  });
}
