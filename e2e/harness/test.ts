/**
 * The e2e `test`: every spec imports `test` and `expect` from here.
 *
 * - `server` (worker-scoped): one real pi-code server per Playwright worker, so a test sees only
 *   the agents of its own worker, on a fresh `$HOME`, pi agent dir and data dir.
 * - `baseURL`: that server.
 * - `context`: with `installStreamControl` (`window.__e2e.dropStream()`).
 * - `app`: projects and conversations, and their runs (`harness/app.ts`).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import { App } from "./app.ts";
import { installStreamControl } from "./init-scripts.ts";
import { e2eRoot, type Server, startServer } from "./server.ts";

export const test = base.extend<{ app: App }, { server: Server }>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its first parameter
    async ({}, use, workerInfo) => {
      const dir = join(e2eRoot(), `w${workerInfo.parallelIndex}-${randomBytes(3).toString("hex")}`);
      const server = await startServer(dir);
      await use(server);
      await server.stop();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  baseURL: async ({ server }, use) => {
    await use(server.url);
  },
  context: async ({ context }, use) => {
    await context.addInitScript(installStreamControl);
    await use(context);
  },
  app: async ({ server, page }, use) => {
    await use(new App(server, page));
  },
});

export { expect } from "@playwright/test";
