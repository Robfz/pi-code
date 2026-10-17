import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { HISTORY, SHORT_ANSWER } from "../harness/fixtures/generate.ts";
import { expect, test } from "../harness/test.ts";
import { composer, sendPrompt, sidebarRow } from "../harness/ui.ts";

/** The conversation id in the page's URL (`/agents/<id>`). */
function agentIdOf(page: Page): string {
  const id = /\/agents\/([^/?#]+)$/.exec(new URL(page.url()).pathname)?.[1];
  if (id === undefined) throw new Error(`not on a conversation: ${page.url()}`);
  return id;
}

/** The `history` reply's last sentence (the rest is rendered markdown). */
const HISTORY_END = HISTORY.text.slice(HISTORY.text.lastIndexOf("\n") + 1);

/** Waits for the conversation screen to show `prompt` answered with `reply` (a text it contains). */
async function expectTranscript(page: Page, prompt: string, reply: string): Promise<void> {
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  await expect(page.getByTestId("user-message")).toHaveText(prompt);
  await expect(page.getByTestId("assistant-text")).toContainText(reply);
}

/** Starts a conversation in `cwd` from the open New conversation sheet. */
async function startIn(page: Page, cwd: string): Promise<void> {
  const sheet = page.getByRole("dialog", { name: "New conversation" });
  await sheet.getByRole("textbox", { name: "Folder path" }).fill(cwd);
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(sheet).toBeHidden();
}

test("desktop: the sidebar opens, switches and follows conversations", async ({
  app,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the docked sidebar is desktop-only");
  const first = app.seedSession();
  const second = app.seedSession();
  // Replayed at half its pace, so its Working status lasts long enough to observe.
  const fresh = app.project({ kind: "short-answer", speed: 0.5 });

  await page.goto("/");
  const sidebar = page.getByRole("navigation", { name: "Conversations" });
  const row = (project: { name: string }) => sidebarRow(page, project);
  await expect(row(first).getByTestId("sidebar-row-title")).toHaveText(first.prompt);
  await expect(row(second).getByTestId("sidebar-row-title")).toHaveText(second.prompt);

  await row(first).getByTestId("sidebar-row-title").click();
  await expectTranscript(page, first.prompt, HISTORY_END);
  const firstId = agentIdOf(page);

  await row(second).getByTestId("sidebar-row-title").click();
  await expectTranscript(page, second.prompt, HISTORY_END);
  const secondId = agentIdOf(page);
  expect(secondId).not.toBe(firstId);

  // The first is now an open conversation: its row links to it.
  await row(first).getByRole("link").click();
  await expect(page).toHaveURL(`/agents/${firstId}`);
  await expectTranscript(page, first.prompt, HISTORY_END);
  await expect(row(first).getByRole("link")).toHaveAttribute("aria-current", "page");
  await expect(row(second).getByRole("link")).not.toHaveAttribute("aria-current", "page");

  await sidebar.getByRole("button", { name: "New conversation", exact: true }).click();
  await startIn(page, fresh.cwd);
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  expect(agentIdOf(page)).not.toBe(firstId);
  await expect(composer(page)).toBeEnabled();
  await sendPrompt(page, fresh.prompt);
  await expect(row(fresh).getByRole("img", { name: "Working" })).toBeVisible();
  await expectTranscript(page, fresh.prompt, SHORT_ANSWER.text);
  // Seen while it finished: Idle, not Finished.
  await expect(row(fresh).getByRole("img", { name: "Idle" })).toBeVisible();

  // A session written by another pi shows up through the catalog watcher.
  const added = app.seedSession();
  await expect(row(added).getByTestId("sidebar-row-title")).toHaveText(added.prompt);

  await row(second)
    .getByRole("button", { name: `Stop or delete ${second.prompt} (${second.name})`, exact: true })
    .click();
  const confirm = page.getByRole("dialog", { name: `Stop or delete ${second.prompt}?` });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => existsSync(second.sessionFile)).toBe(false);
  await expect(row(second)).toHaveCount(0);
  await expect(row(first)).toHaveCount(1);
});

test("mobile: Home and the sessions list open, switch and follow conversations", async ({
  app,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "desktop has the sidebar instead");
  const first = app.seedSession();
  const second = app.seedSession();
  const fresh = app.project({ kind: "short-answer" });

  const sessions = page.getByRole("list", { name: "Sessions" });
  // Opens `project`'s session (its only one) from the sessions list filtered to that project.
  const openFromSessions = async (project: { cwd: string; prompt: string }) => {
    await page.getByRole("link", { name: "Sessions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
    await page.getByRole("combobox", { name: "Project" }).selectOption(project.cwd);
    await expect(sessions.getByTestId("session-row")).toHaveCount(1);
    await expect(sessions.getByTestId("session-row")).toContainText(project.prompt);
    await sessions.getByTestId("session-row").click();
  };

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "pi-code", level: 1 })).toBeVisible();
  await openFromSessions(first);
  await expectTranscript(page, first.prompt, HISTORY_END);
  const firstId = agentIdOf(page);

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await openFromSessions(second);
  await expectTranscript(page, second.prompt, HISTORY_END);
  const secondId = agentIdOf(page);
  expect(secondId).not.toBe(firstId);

  await page.getByRole("link", { name: "Home", exact: true }).click();
  const open = page.getByRole("list", { name: "Open conversations" });
  for (const id of [firstId, secondId]) {
    await expect(open.locator(`a[href="/agents/${id}"]`)).toBeVisible();
  }
  await open.locator(`a[href="/agents/${firstId}"]`).click();
  await expectTranscript(page, first.prompt, HISTORY_END);

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await startIn(page, fresh.cwd);
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  const freshId = agentIdOf(page);
  await expect(composer(page)).toBeEnabled();
  await sendPrompt(page, fresh.prompt);
  await expectTranscript(page, fresh.prompt, SHORT_ANSWER.text);

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(open.locator(`a[href="/agents/${freshId}"]`)).toBeVisible();

  // A session written by another pi shows up in the sessions list; the open ones show their
  // conversation's status.
  const added = app.seedSession();
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  const folder = (project: { name: string }) =>
    sessions.getByRole("group", { name: project.name, exact: true });
  await expect(folder(added).getByTestId("session-row")).toContainText(added.prompt);
  await expect(folder(first).getByTestId("session-row")).toContainText("Idle");

  // A session no agent holds is deleted at once.
  await folder(added)
    .getByRole("button", { name: `Delete ${added.prompt} (${added.name})`, exact: true })
    .click();
  await expect.poll(() => existsSync(added.sessionFile)).toBe(false);
  await expect(folder(added)).toHaveCount(0);
  await expect(folder(first).getByTestId("session-row")).toBeVisible();
});
