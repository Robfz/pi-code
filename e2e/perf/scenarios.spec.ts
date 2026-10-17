/**
 * Timing scenarios. Each runs once per CPU rate per run (`perf-test.ts`) and attaches its
 * `Sample`; `reporter.ts` turns them into the report. Streams replay at speed 1, with the
 * fixtures' own spacing, so per-delta costs land as they do for a user.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { App, Conversation } from "../harness/app.ts";
import type { FixtureKind } from "../harness/fixtures/generate.ts";
import type { Server } from "../harness/server.ts";
import { composer, openReviewPane, sendPrompt } from "../harness/ui.ts";
import type { Metrics } from "./metrics.ts";
import { CPU_RATES, expect, RUNS, test } from "./perf-test.ts";
import type { Sample, ScenarioMetrics } from "./report.ts";

interface Run {
  app: App;
  page: Page;
  server: Server;
  metrics: Metrics;
  cpu: number;
}

interface Scenario {
  name: string;
  desktopOnly?: boolean;
  run(run: Run): Promise<ScenarioMetrics>;
}

/** Conversations the heap scenario visits. */
const VISITS = 20;
/** Agents streaming at once in the multi-agent scenario. */
const AGENTS = 3;

/**
 * Waits for the run the page shows to start, then for the first frame in which no run shows: no
 * live turn, and no Working agent (the sidebar's marks, the phone's status bar). Checked every
 * frame, so a stream window ends when the page shows the end, not on a poll's schedule.
 */
async function runsEndOnPage(page: Page): Promise<void> {
  await expect(page.getByTestId("live-turn")).toBeVisible();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="live-turn"], [role="img"][aria-label="Working"]'),
    undefined,
    { polling: "raf", timeout: 120_000 },
  );
}

/** After a window: the end the page showed was the runs' end on the server. */
async function expectRunsEnded(app: App, conversations: Conversation[]): Promise<void> {
  for (const c of conversations) await expect.poll(() => app.runEnded(c)).toBe(true);
}

/**
 * One prompt's run, from Send to the end of the run on screen. The git refresh the server
 * publishes 2 s after the turn falls after the window.
 */
async function streamed(
  { app, page, metrics, cpu }: Run,
  kind: FixtureKind,
): Promise<ScenarioMetrics> {
  const conversation = await app.conversation({ kind, speed: 1 });
  await app.open(conversation);
  await metrics.throttle(cpu);
  const start = await metrics.mark();
  await sendPrompt(page, conversation.prompt);
  await runsEndOnPage(page);
  const result = await metrics.collect(start);
  await expectRunsEnded(app, [conversation]);
  return result;
}

/** Resolves after the page has drawn two more frames: work queued before it has rendered. */
function twoFrames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * Milliseconds from navigation start until the composer is enabled and the history's code block
 * is highlighted, checked every frame from the page's first frames.
 */
async function readyAfterNavigation(page: Page): Promise<number> {
  const ready = await page.waitForFunction(
    () => {
      const enabled = document.querySelector('[aria-label="Message"]:not(:disabled)');
      const highlighted = document.querySelector(
        '[data-streamdown="code-block"] [style*="--sdm-c"]',
      );
      return enabled && highlighted ? performance.now() : false;
    },
    undefined,
    { polling: "raf" },
  );
  return (await ready.jsonValue()) as number;
}

const SCENARIOS: Scenario[] = [
  { name: "long-stream", run: (run) => streamed(run, "long-stream") },
  { name: "tool-storm", run: (run) => streamed(run, "tool-storm") },
  {
    name: "cold-load",
    async run({ app, page, metrics, cpu }) {
      const conversation = await app.conversation({ kind: "history" });
      // The window measures the page, not the agent's startup.
      await app.waitReady(conversation);
      await metrics.throttle(cpu);
      const start = await metrics.mark();
      // From the commit on, so `readyAfterNavigation` watches the load's first frames.
      await page.goto(`/agents/${conversation.id}`, { waitUntil: "commit" });
      const readyMs = await readyAfterNavigation(page);
      await page.waitForLoadState("load");
      return metrics.collectLoad(start, readyMs);
    },
  },
  {
    name: "multi-agent-review",
    desktopOnly: true,
    async run({ app, page, server, metrics, cpu }) {
      const [shown, ...background] = await Promise.all(
        Array.from({ length: AGENTS }, () => app.conversation({ kind: "long-stream", speed: 1 })),
      );
      if (!shown) throw new Error("no conversation");
      // The background agents are prompted inside the window: started, not starting.
      for (const c of background) await app.waitReady(c);
      // An uncommitted change, so the pane has a diff to show and to refresh after the turn.
      appendFileSync(join(shown.cwd, "src/app.ts"), "export const changed = true;\n");
      await app.open(shown);
      await expect((await openReviewPane(page)).getByTestId("diff-file")).toBeVisible();
      await metrics.throttle(cpu);
      const start = await metrics.mark();
      // The pane refetches its diff on the git refresh the server publishes 2 s after the shown
      // agent's turn (its only one): the window includes it.
      const refreshed = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/api/agents/${shown.id}/git/diff`,
        { timeout: 120_000 },
      );
      await Promise.all(
        background.map((c) =>
          server.api("POST", `/api/agents/${c.id}/rpc`, { type: "prompt", message: c.prompt }),
        ),
      );
      await sendPrompt(page, shown.prompt);
      await runsEndOnPage(page);
      await (await refreshed).finished();
      await twoFrames(page);
      const result = await metrics.collect(start);
      await expectRunsEnded(app, [shown, ...background]);
      return result;
    },
  },
  {
    name: "many-conversations-heap",
    desktopOnly: true,
    async run({ app, page, metrics, cpu }) {
      const conversations = [];
      for (let i = 0; i < VISITS; i++)
        conversations.push(await app.conversation({ kind: "history" }));
      // Startups would otherwise reach the sidebar, and compete for the CPU, inside the window.
      for (const c of conversations) await app.waitReady(c);
      const [first, ...rest] = conversations;
      if (!first) throw new Error("no conversation");
      await app.open(first);
      await expect(page.getByTestId("user-message")).toHaveText(first.prompt);
      await metrics.throttle(cpu);
      const start = await metrics.mark();
      const sidebar = page.getByRole("navigation", { name: "Conversations" });
      for (const c of rest) {
        // Through the sidebar (it lists the conversation under Active and under its folder): a
        // page load would start from an empty heap.
        await sidebar.locator(`a[href="/agents/${c.id}"]`).first().click();
        await expect(page.getByTestId("user-message")).toHaveText(c.prompt);
        await expect(composer(page)).toBeEnabled();
      }
      return metrics.collect(start);
    },
  },
];

// Runs outermost, so a burst of load on the machine spreads over scenarios instead of skewing
// every run of one.
for (let run = 1; run <= RUNS; run++) {
  for (const scenario of SCENARIOS) {
    test.describe(scenario.name, () => {
      if (scenario.desktopOnly) test.skip(({ isMobile }) => isMobile, "desktop only");
      for (const cpu of CPU_RATES) {
        test(`cpu ${cpu}x, run ${run}`, async ({ app, page, server, metrics, browser }, info) => {
          const sample: Sample = {
            scenario: scenario.name,
            project: info.project.name,
            cpu,
            run,
            chromium: browser.version(),
            metrics: await scenario.run({ app, page, server, metrics, cpu }),
          };
          await info.attach("metrics", {
            body: JSON.stringify(sample),
            contentType: "application/json",
          });
        });
      }
    });
  }
}
