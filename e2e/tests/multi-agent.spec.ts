import { expect, test } from "../harness/test.ts";
import { composer, sendPrompt, sidebarRow, transcriptDigest } from "../harness/ui.ts";

const prompt = "Walk me through the project";

test("two agents streaming at once in one tab both end correct, with the right sidebar statuses", async ({
  app,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the docked sidebar is desktop-only");
  const control = await app.conversation({ kind: "long-stream", prompt });
  await app.open(control);
  await sendPrompt(page, prompt);
  await app.waitForRunEnd(control);
  const expected = await transcriptDigest(page);

  const a = await app.conversation({ kind: "long-stream", speed: 2, prompt });
  const b = await app.conversation({ kind: "long-stream", speed: 2, prompt });
  const row = (project: { name: string }) => sidebarRow(page, project);

  await app.open(a);
  await sendPrompt(page, prompt);
  await expect(page.getByTestId("live-turn")).toBeVisible();
  // In-app navigation: one page, one stream for both agents.
  await row(b).getByRole("link").click();
  await expect(page).toHaveURL(`/agents/${b.id}`);
  await expect(composer(page)).toBeEnabled();
  await sendPrompt(page, prompt);
  await expect(page.getByTestId("live-turn")).toBeVisible();
  await expect(row(a).getByRole("img", { name: "Working" })).toBeVisible();
  await expect(row(b).getByRole("img", { name: "Working" })).toBeVisible();
  expect(await app.runEnded(a)).toBe(false);

  await row(a).getByRole("link").click();
  await expect(page).toHaveURL(`/agents/${a.id}`);
  await app.waitForRunEnd(a);
  await expect.poll(() => app.runEnded(b), { timeout: 60_000 }).toBe(true);
  expect(await transcriptDigest(page)).toEqual(expected);
  // A finished on screen (seen); B finished out of sight.
  await expect(row(a).getByRole("img", { name: "Idle" })).toBeVisible();
  await expect(row(b).getByRole("img", { name: "Finished" })).toBeVisible();

  await row(b).getByRole("link").click();
  await expect(page).toHaveURL(`/agents/${b.id}`);
  await app.waitForRunEnd(b);
  expect(await transcriptDigest(page)).toEqual(expected);
  await expect(row(b).getByRole("img", { name: "Idle" })).toBeVisible();
});
