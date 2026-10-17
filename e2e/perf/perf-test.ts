/**
 * The perf `test`: the harness's (`harness/test.ts`) plus
 *
 * - `context`: with `installPerfObservers`, so every page records long tasks and frames.
 * - `metrics`: a CDP session on the test's page (`Metrics`).
 * - closing the test's conversations afterwards (auto): one server serves the whole run, and
 *   conversations left open would grow every later run's sidebar.
 */
import type { AgentInfo } from "@pi-code/protocol";
import { test as base } from "../harness/test.ts";
import { installPerfObservers, Metrics } from "./metrics.ts";

/** Runs of each scenario (`E2E_PERF_RUNS`); the report keeps their medians. */
export const RUNS = Number(process.env.E2E_PERF_RUNS ?? 3);
/** CPU throttling rates each scenario runs at. */
export const CPU_RATES = [1, 4];

if (!Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error(`E2E_PERF_RUNS must be a positive integer, got ${process.env.E2E_PERF_RUNS}`);
}

export const test = base.extend<{ metrics: Metrics; closeConversations: undefined }>({
  context: async ({ context }, use) => {
    await context.addInitScript(installPerfObservers);
    await use(context);
  },
  metrics: async ({ page }, use) => {
    const metrics = await Metrics.attach(page);
    await use(metrics);
  },
  closeConversations: [
    async ({ server }, use) => {
      await use(undefined);
      const { agents } = await server.api<{ agents: AgentInfo[] }>("GET", "/api/agents");
      await Promise.all(agents.map((a) => server.api("DELETE", `/api/agents/${a.id}`)));
    },
    { auto: true },
  ],
});

export { expect } from "../harness/test.ts";
