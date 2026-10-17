import { TOOL_STORM } from "../harness/fixtures/generate.ts";
import { expect, test } from "../harness/test.ts";
import { sendPrompt } from "../harness/ui.ts";

const exploration = TOOL_STORM.perBlock.slice(0, TOOL_STORM.explorationPerGroup);
const direct = TOOL_STORM.perBlock.slice(TOOL_STORM.explorationPerGroup);
const STEPS = '[data-testid="exploration-group"], [data-testid="tool-call"]';
/** A finished block's steps: its exploration group, then its direct calls naming its module. */
const blockSteps = (block: number) => [
  `group done Explored ${TOOL_STORM.groupLabel}`,
  ...direct.map((tool) => `${tool} done module-${block}`),
];
/** Exploration groups the live turn shows before the test checks it mid-run. */
const LIVE_GROUPS = 5;

/**
 * Step rows as `group <status> <label>` or `<tool> <status> [<module it names>]`. Runs in the
 * page, so it is self-contained.
 */
function describeSteps(els: Element[]): string[] {
  return els.map((el) => {
    if (el.getAttribute("data-testid") === "exploration-group") {
      const label = [...el.querySelectorAll('[data-slot="row-verb"], [data-slot="row-meta"]')]
        .map((part) => part.textContent)
        .join(" ");
      return `group ${el.getAttribute("data-status")} ${label}`;
    }
    const module = /module-\d+/.exec(el.textContent ?? "")?.[0];
    return [el.getAttribute("data-tool"), el.getAttribute("data-status"), module]
      .filter((part) => part != null)
      .join(" ");
  });
}

test("a 200-tool-call turn shows its steps in order, with collapsible exploration groups", async ({
  app,
  page,
}) => {
  const conversation = await app.conversation({ kind: "tool-storm", speed: 4 });
  await app.open(conversation);
  await sendPrompt(page, conversation.prompt);

  // Mid-run, while a block's exploration runs: committed and live steps merge into one sequence,
  // every finished block grouped once with its direct calls once each, and the running group last.
  const liveTurn = page.getByTestId("live-turn");
  let steps: string[] = [];
  await expect
    .poll(
      async () => {
        steps = await liveTurn.locator(STEPS).evaluateAll(describeSteps);
        const groups = steps.filter((step) => step.startsWith("group ")).length;
        return groups >= LIVE_GROUPS && steps.at(-1)?.startsWith("group running");
      },
      { intervals: [50], message: `the live turn runs its exploration group ${LIVE_GROUPS}` },
    )
    .toBe(true);
  const finishedBlocks = (steps.length - 1) / (direct.length + 1);
  expect(steps.slice(0, -1)).toEqual(
    Array.from({ length: finishedBlocks }, (_, block) => blockSteps(block)).flat(),
  );
  expect(steps.at(-1)).toMatch(/^group running Exploring · /);

  await app.waitForRunEnd(conversation);
  const transcript = page.getByTestId("transcript");
  const groups = transcript.getByTestId("exploration-group");
  await expect(groups).toHaveCount(TOOL_STORM.blocks);
  await expect(transcript.getByTestId("assistant-text")).toHaveText(TOOL_STORM.text);

  // Collapsed groups hide their calls: the steps in DOM order are each block's group, then its
  // direct calls.
  expect(await transcript.locator(STEPS).evaluateAll(describeSteps)).toEqual(
    Array.from({ length: TOOL_STORM.blocks }, (_, block) => blockSteps(block)).flat(),
  );
  for (const trigger of await groups.getByRole("button").all()) {
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }

  for (const block of [0, TOOL_STORM.blocks - 1]) {
    const group = groups.nth(block);
    const trigger = group.getByRole("button", {
      name: `Explored ${TOOL_STORM.groupLabel}`,
      exact: true,
    });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const calls = group.getByTestId("tool-call");
    await expect(calls).toHaveCount(TOOL_STORM.explorationPerGroup);
    expect(await calls.evaluateAll(describeSteps)).toEqual(
      // grep and find rows show their pattern, not the module they search.
      exploration.map((tool) => (tool === "read" ? `read done module-${block}` : `${tool} done`)),
    );

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(calls).toHaveCount(0);
  }
});
