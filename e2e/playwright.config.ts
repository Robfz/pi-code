import { defineConfig } from "@playwright/test";
import { PROJECTS } from "./projects.ts";

/** Regression specs (`tests/`): `pnpm e2e`. */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    // Only the cold-load spec lets the service worker in (`test.use({ serviceWorkers: "allow" })`):
    // requests it handles bypass `page.route`, and it would precache the whole build every test.
    serviceWorkers: "block",
  },
  projects: PROJECTS,
});
