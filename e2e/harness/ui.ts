/** Page-level helpers over the app's DOM. */
import { expect, type Locator, type Page } from "@playwright/test";

/** What a transcript shows, for comparing two renderings of the same conversation. */
export interface TranscriptDigest {
  /** `textContent` of each user message. */
  user: string[];
  /** `textContent` of each assistant text block. */
  assistant: string[];
  /** The language of each fenced code block. */
  codeBlocks: string[];
  /** Clickable line references (code-ref chips), in order. */
  refs: string[];
  /** Tool rows currently in the DOM (collapsed exploration groups hide theirs). */
  tools: { tool: string; status: string }[];
}

/** Within this many pixels of the bottom counts as pinned (the app's own threshold is looser). */
const PINNED_SLACK_PX = 80;

export function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message" });
}

/**
 * Fills the composer and clicks Send. Never Enter: on touch devices Enter inserts a newline.
 */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** Whether the transcript's scroll container is scrolled to (near) its bottom. */
export function isPinned(page: Page): Promise<boolean> {
  return page.getByTestId("transcript-scroll").evaluate((el, slack) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  }, PINNED_SLACK_PX);
}

/** Desktop: opens the review pane (Changes) from the side panel toolbar; returns the pane. */
export async function openReviewPane(page: Page): Promise<Locator> {
  await page
    .getByRole("toolbar", { name: "Side panel" })
    .getByRole("button", { name: /^Changes panel/ })
    .click();
  const pane = page.getByRole("complementary", { name: "Review" });
  await expect(pane).toBeVisible();
  return pane;
}

/** Desktop: the sidebar row of a project's conversation (each test project has one). */
export function sidebarRow(page: Page, project: { name: string }): Locator {
  return page
    .getByRole("navigation", { name: "Conversations" })
    .getByRole("group", { name: project.name, exact: true })
    .getByTestId("sidebar-row");
}

/**
 * `textContent` of each top-level markdown block (heading, paragraph, code block, …) of the last
 * `assistant-text` in `scope`; none when it has none. While a reply streams, every block but the
 * last is finished. Doesn't wait: polls can call it while the element comes and goes.
 */
export function replyBlocks(scope: Locator): Promise<string[]> {
  return scope
    .getByTestId("assistant-text")
    .evaluateAll((els) =>
      [...(els.at(-1)?.firstElementChild?.children ?? [])].map((el) => el.textContent ?? ""),
    );
}

/**
 * The transcript as text and structure, once Shiki has coloured every code block: highlighting
 * is asynchronous (lazy grammar chunks), and must not make two digests of the same transcript
 * differ. `textContent`, not `innerText`: finished turns use `content-visibility: auto`, and
 * off-screen ones have no rendered text. Assistant text leaves out the whitespace between its
 * top-level markdown blocks: Markdown that mounted streaming renders its blocks separately, one
 * that mounted finished as one tree with newlines between them, and neither shows.
 */
export async function transcriptDigest(page: Page): Promise<TranscriptDigest> {
  const transcript = page.getByTestId("transcript");
  await expect(
    transcript.locator('[data-streamdown="code-block"]:not(:has(span[style*="--sdm-c"]))'),
  ).toHaveCount(0);
  return transcript.evaluate((root) => {
    const all = (selector: string) => [...root.querySelectorAll(selector)];
    const text = (el: Element) => el.textContent ?? "";
    const prose = (el: Element) => {
      const copy = el.cloneNode(true) as Element;
      for (const markdown of copy.querySelectorAll(".markdown")) {
        for (const node of [...markdown.childNodes]) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === "") node.remove();
        }
      }
      return text(copy);
    };
    return {
      user: all('[data-testid="user-message"]').map(text),
      assistant: all('[data-testid="assistant-text"]').map(prose),
      codeBlocks: all('[data-streamdown="code-block"]').map(
        (el) => el.getAttribute("data-language") ?? "",
      ),
      refs: all('[data-testid="assistant-text"] [data-code-ref]').map(text),
      tools: all('[data-testid="tool-call"]').map((el) => ({
        tool: el.getAttribute("data-tool") ?? "",
        status: el.getAttribute("data-status") ?? "",
      })),
    };
  });
}
