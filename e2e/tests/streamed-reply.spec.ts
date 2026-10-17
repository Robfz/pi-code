import { LONG_STREAM } from "../harness/fixtures/generate.ts";
import { expect, test } from "../harness/test.ts";
import { isPinned, replyBlocks, sendPrompt } from "../harness/ui.ts";

test("a long streamed reply renders fully, stays pinned, and ends with highlighted code and references", async ({
  app,
  page,
}) => {
  const conversation = await app.conversation({ kind: "long-stream", speed: 2 });
  await app.open(conversation);
  await sendPrompt(page, conversation.prompt);

  // Mid-stream: each time the reply has grown by another screenful, the view has followed it, and
  // the reply's finished blocks are kept to compare with the committed reply.
  const liveTurn = page.getByTestId("live-turn");
  const scroller = page.getByTestId("transcript-scroll");
  const height = () => scroller.evaluate((el) => el.scrollHeight);
  const screen = await scroller.evaluate((el) => el.clientHeight);
  const samples: string[][] = [];
  for (let grown = 0; grown < 2; grown++) {
    const before = await height();
    await expect.poll(height).toBeGreaterThan(before + screen);
    await expect.poll(() => isPinned(page)).toBe(true);
    const finished = (await replyBlocks(liveTurn)).slice(0, -1);
    expect(finished.length, "the live reply has finished blocks").toBeGreaterThan(0);
    samples.push(finished);
  }

  await app.waitForRunEnd(conversation);
  await expect.poll(() => isPinned(page)).toBe(true);

  const reply = page.getByTestId("assistant-text");
  await expect(reply).toHaveCount(1);
  // Streaming rendered the same blocks as the committed reply: no delta lost or repeated.
  const final = await replyBlocks(page.getByTestId("transcript"));
  expect(final).toHaveLength(LONG_STREAM.blocks.length);
  for (const sample of samples) expect(sample).toEqual(final.slice(0, sample.length));
  // Its last words: the reply was rendered to its end.
  expect(await reply.textContent()).toContain(LONG_STREAM.text.slice(-40).trim());
  for (const heading of LONG_STREAM.headings) {
    await expect(reply.getByRole("heading", { name: heading })).toBeAttached();
  }

  const blocks = reply.locator('[data-streamdown="code-block"]');
  await expect(blocks).toHaveCount(LONG_STREAM.codeBlocks);
  expect(
    await blocks.evaluateAll((els) => els.map((el) => el.getAttribute("data-language"))),
  ).toEqual(LONG_STREAM.languages);
  // Shiki colours each block once its grammar chunk has loaded.
  for (const block of await blocks.all()) {
    await expect(block.locator('span[style*="--sdm-c"]').first()).toBeAttached();
  }

  for (const ref of LONG_STREAM.refs) {
    await expect(reply.getByRole("button", { name: ref, exact: true })).toBeAttached();
  }
});
