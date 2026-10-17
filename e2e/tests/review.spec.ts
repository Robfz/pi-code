import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../harness/test.ts";
import { composer, openReviewPane, sendPrompt } from "../harness/ui.ts";

/** Lines the test appends to the default project's 12-line `src/app.ts`, as pi's edit would. */
function editApp(cwd: string): void {
  appendFileSync(join(cwd, "src/app.ts"), "export const line13 = 13;\nexport const line14 = 14;\n");
}

/** The git status refresh runs a couple of seconds after a turn ends. */
const GIT_REFRESH = { timeout: 15_000 };

/** A new-side line number of a file's diff (split and unified views mark it differently). */
function newLine(file: Locator, line: number): Locator {
  return file
    .locator(`[data-line-new-num="${line}"], .diff-line-new-num [data-line-num="${line}"]`)
    .first();
}

function changedApp(page: Page): Locator {
  return page.locator('[data-testid="diff-file"][data-path="src/app.ts"]');
}

test("desktop: the review pane updates after a turn and adds selected lines to the composer", async ({
  app,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the review pane is desktop-only");
  const conversation = await app.conversation({ kind: "short-answer", speed: 1 });
  await app.open(conversation);

  const pane = await openReviewPane(page);
  await expect(pane.getByText("The working tree is clean.")).toBeVisible();

  editApp(conversation.cwd);
  await sendPrompt(page, conversation.prompt);
  await expect(page.getByTestId("live-turn")).toBeVisible();
  await app.waitForRunEnd(conversation);

  const file = changedApp(page);
  await expect(file).toBeVisible(GIT_REFRESH);
  await expect(pane).toBeVisible();
  await expect(page.getByTestId("rail-dirty")).toBeVisible();

  await newLine(file, 13).click();
  // One line, not a range.
  await expect(composer(page)).toHaveValue(/@src\/app\.ts:13(?![-\d])/);
});

test("mobile: the Diff page shows the turn's changes and adds a line range to the composer", async ({
  app,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "desktop has the review pane instead");
  const conversation = await app.conversation({ kind: "short-answer" });
  await app.open(conversation);
  editApp(conversation.cwd);
  await sendPrompt(page, conversation.prompt);
  await app.waitForRunEnd(conversation);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Diff" }).click();
  await expect(page).toHaveURL(`/agents/${conversation.id}/diff`);
  const file = changedApp(page);
  await expect(file).toBeVisible(GIT_REFRESH);

  // The diff selects on mouse events, which Playwright's `click` sends on touch devices too.
  await newLine(file, 13).click();
  const bar = page.getByRole("toolbar", { name: "Line selection" });
  await expect(bar).toContainText("Tap the last line");
  await newLine(file, 14).click();
  await expect(bar).toContainText("@src/app.ts:13-14");
  await bar.getByRole("button", { name: "Add to chat" }).click();

  await expect(page).toHaveURL(`/agents/${conversation.id}`);
  await expect(composer(page)).toHaveValue(/@src\/app\.ts:13-14\b/);
});
