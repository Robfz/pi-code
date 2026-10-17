import { defineConfig } from "@playwright/test";
import { PROJECTS } from "./projects.ts";

/** Timing scenarios (`perf/`): `pnpm e2e:perf`. One worker, so runs don't compete for the CPU. */
export default defineConfig({
  testDir: "./perf",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  // Throttled runs render behind the server.
  expect: { timeout: 30_000 },
  reporter: [["list"], ["./perf/reporter.ts"]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    trace: "off",
    reducedMotion: "no-preference",
    serviceWorkers: "block",
  },
  projects: PROJECTS,
});
