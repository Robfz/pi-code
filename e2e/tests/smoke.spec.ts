import { SHORT_ANSWER } from "../harness/fixtures/generate.ts";
import { expect, test } from "../harness/test.ts";
import { sendPrompt } from "../harness/ui.ts";

test("a prompt streams a reply that ends committed", async ({ app, page }) => {
  const conversation = await app.conversation({ kind: "short-answer", speed: 4 });
  await app.open(conversation);
  await sendPrompt(page, conversation.prompt);
  await app.waitForRunEnd(conversation);

  await expect(page.getByTestId("user-message")).toHaveText(conversation.prompt);
  await expect(page.getByTestId("assistant-text")).toHaveText(SHORT_ANSWER.text);
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
});
