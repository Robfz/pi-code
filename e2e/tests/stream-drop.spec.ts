import { LONG_STREAM } from "../harness/fixtures/generate.ts";
import { expect, test } from "../harness/test.ts";
import { replyBlocks, sendPrompt, transcriptDigest } from "../harness/ui.ts";

/** Same prompt for both conversations, so their transcripts are comparable as a whole. */
const prompt = "Walk me through the project";

/** Events the server must emit while the page is disconnected: the page has to catch up on them. */
const MISSED_EVENTS = 50;

/** How many of the reply's markdown blocks its first `length` characters reach into. */
function blocksReached(length: number): number {
  let count = 0;
  for (let start = 0; count < LONG_STREAM.blocks.length && start < length; count++) {
    start += (LONG_STREAM.blocks[count] ?? "").length + "\n\n".length;
  }
  return count;
}

test("dropping and restoring the stream mid-run ends with the uninterrupted transcript", async ({
  app,
  page,
}) => {
  const control = await app.conversation({ kind: "long-stream", prompt });
  await app.open(control);
  await sendPrompt(page, prompt);
  await app.waitForRunEnd(control);
  const expected = await transcriptDigest(page);
  expect(expected.codeBlocks).toHaveLength(LONG_STREAM.codeBlocks);
  const expectedBlocks = await replyBlocks(page.getByTestId("transcript"));

  const conversation = await app.conversation({ kind: "long-stream", speed: 2, prompt });
  await app.open(conversation);
  await sendPrompt(page, prompt);
  const liveTurn = page.getByTestId("live-turn");
  await expect(liveTurn.locator('[data-streamdown="code-block"]').first()).toBeVisible();

  const stream = "**/api/stream*";
  await page.route(stream, (route) => route.abort());
  const { seq } = await app.snapshot(conversation);
  await page.evaluate(() => window.__e2e.dropStream());
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "reconnecting");
  await expect
    .poll(async () => (await app.snapshot(conversation)).seq)
    .toBeGreaterThanOrEqual(seq + MISSED_EVENTS);
  expect(await app.runEnded(conversation)).toBe(false);

  await page.unroute(stream);
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");

  // Mid-run, the reply rebuilt from the catch-up: once the page has finished every block the
  // server had streamed when the page came back, those blocks match the uninterrupted reply. A
  // replayed or skipped event would show here; the committed reply at the end would hide it.
  const streamed = Object.values((await app.snapshot(conversation)).live.streaming?.blocks ?? {})
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const caughtUp = blocksReached(streamed.length);
  let finished: string[] = [];
  await expect
    .poll(
      async () => {
        finished = (await replyBlocks(liveTurn)).slice(0, -1);
        return finished.length;
      },
      { message: "the live reply finishes the blocks streamed during the outage" },
    )
    .toBeGreaterThanOrEqual(caughtUp);
  expect(finished).toEqual(expectedBlocks.slice(0, finished.length));

  await app.waitForRunEnd(conversation);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("assistant-text")).toHaveCount(1);
  expect(await transcriptDigest(page)).toEqual(expected);
});
