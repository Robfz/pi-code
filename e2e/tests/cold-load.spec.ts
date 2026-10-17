import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";
import { expect, test } from "../harness/test.ts";
import { openReviewPane } from "../harness/ui.ts";

test.use({ serviceWorkers: "allow" });

/** Every response the page gets from now on. */
function recordResponses(page: Page): Response[] {
  const responses: Response[] = [];
  page.on("response", (response) => responses.push(response));
  return responses;
}

/** Waits for a successful response for a URL path matching `path`. */
async function expectLoaded(responses: Response[], path: RegExp): Promise<void> {
  await expect
    .poll(() => responses.some((r) => path.test(new URL(r.url()).pathname) && r.status() === 200))
    .toBe(true);
}

test("a cold load fetches the lazy chunks, installs the service worker and works offline", async ({
  app,
  page,
  context,
}, testInfo) => {
  const desktop = testInfo.project.name === "desktop";
  const conversation = await app.conversation({ kind: "history" });
  // An uncommitted change for the review pane to show.
  appendFileSync(join(conversation.cwd, "src/app.ts"), "export const added = 13;\n");

  const responses = recordResponses(page);
  await app.open(conversation);
  await expectLoaded(responses, /^\/assets\/index-[\w-]+\.js$/);
  // Built assets come precompressed.
  const entry = responses.find((r) =>
    /^\/assets\/index-[\w-]+\.js$/.test(new URL(r.url()).pathname),
  );
  expect(["br", "gzip"]).toContain(await entry?.headerValue("content-encoding"));
  // The reply's code block: Shiki and its grammar are lazy chunks.
  const code = page.getByTestId("assistant-text").locator('[data-streamdown="code-block"]');
  await expect(code.locator('span[style*="--sdm-c"]').first()).toBeAttached();
  await expectLoaded(responses, /^\/assets\/shiki\/[\w-]+\.js$/);

  if (desktop) {
    await expect((await openReviewPane(page)).getByTestId("diff-viewer").first()).toBeVisible();
    await expectLoaded(responses, /^\/assets\/diff-view-impl-[\w-]+\.js$/);
  }

  // The service worker activates and takes the page over (`clientsClaim`), with the build
  // precached.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe(
    "activated",
  );
  const precached = await page.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith("workbox-precache-v2-"));
    const requests = name === undefined ? [] : await (await caches.open(name)).keys();
    return requests.map((request) => new URL(request.url).pathname);
  });
  expect(precached).toContain("/index.html");
  expect(precached).toContainEqual(expect.stringMatching(/^\/assets\/index-[\w-]+\.js$/));
  // Shiki's hundreds of chunks, the diff viewer and the non-Latin font subsets load on demand,
  // not at install.
  expect(precached.filter((path) => path.startsWith("/assets/shiki/"))).toEqual([]);
  expect(precached.filter((path) => path.includes("/diff-view-impl-"))).toEqual([]);
  const fonts = precached.filter((path) => path.endsWith(".woff2")).sort();
  expect(fonts).toEqual([
    expect.stringMatching(/^\/assets\/geist-latin-wght-/),
    expect.stringMatching(/^\/assets\/geist-mono-latin-wght-/),
  ]);

  // Once the service worker controls the page, a lazy chunk it loads is cached for offline use.
  await page.reload();
  await expect(code.locator('span[style*="--sdm-c"]').first()).toBeAttached();
  const lazyCached = () =>
    page.evaluate(async () =>
      (await (await caches.open("lazy-assets")).keys()).map((r) => new URL(r.url).pathname),
    );
  await expect.poll(lazyCached).toContainEqual(expect.stringMatching(/^\/assets\/shiki\//));
  const shikiChunk = (await lazyCached()).find((path) => path.startsWith("/assets/shiki/"));

  await context.setOffline(true);
  const offline = await page.goto("/");
  expect(offline?.fromServiceWorker()).toBe(true);
  expect(await page.evaluate(async (path) => (await fetch(path)).ok, shikiChunk as string)).toBe(
    true,
  );
  await expect(
    page.getByRole("heading", {
      name: desktop ? "Pick a conversation or start a new one" : "pi-code",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("offline-banner")).toHaveAttribute("data-state", "offline");
  await expect(page.getByTestId("offline-banner")).toContainText("You're offline");
  await context.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toBeHidden();
});
