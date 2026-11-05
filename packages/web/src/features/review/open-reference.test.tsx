import type { SessionEntry } from "@pi-code/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { stubCanvas } from "@/components/diff/testing";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendBaseline } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";
import { useReviewStore } from "./review-state";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { error: vi.fn() }) };
});

beforeAll(stubCanvas);
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast).mockClear();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const message = (id: string, parentId: string | null, body: Record<string, unknown>) =>
  ({
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    type: "message",
    message: { timestamp: 0, ...body },
  }) as unknown as SessionEntry;

const TRANSCRIPT = {
  entries: [
    message("u1", null, { role: "user", content: "Look at @src/a.ts:3-4 and `@b.ts:2`" }),
    message("a1", "u1", {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: "See @src/a.ts:2, `@3f2a9c1:./src/a.ts:4` and src/a.ts:3.\n\n```\n@src/a.ts:1\n```",
        },
      ],
    }),
  ],
  leafId: "a1",
};

/** The `rev` of each file read, `null` for a working-tree copy. */
let readRevs: (string | null)[] = [];

/** The app at `/agents/a1` with a transcript holding references; every file has 6 lines. */
async function renderApp({ desktop }: { desktop: boolean }) {
  stubMatchMedia((query) => desktop && query === DESKTOP_QUERY);
  readRevs = [];
  stubFetch((call) => {
    if (call.url === "/api/agents/a1/snapshot")
      return [200, makeSnapshot({ agent: makeAgent({ id: "a1" }), transcript: TRANSCRIPT })];
    if (call.url === "/api/agents/a1/files/content") {
      const params = new URLSearchParams(call.search);
      const path = params.get("path") ?? "";
      const rev = params.get("rev");
      readRevs.push(rev);
      return [
        200,
        {
          path,
          ...(rev !== null && { rev }),
          content: "1\n2\n3\n4\n5\n6\n",
          binary: false,
          tooLarge: false,
        },
      ];
    }
    return undefined;
  });
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/agents/a1"] }),
  });
  render(<App router={router} queryClient={createQueryClient()} />);
  sendBaseline([makeAgent({ id: "a1" })]);
  return { router };
}

const references = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-code-ref]"));

/** New-side numbers of the marked rows. */
function marked(): string[] {
  return Array.from(document.querySelectorAll(".diff-line-num.diff-multi-select-active")).map(
    (cell) => cell.querySelector("[data-line-new-num]")?.getAttribute("data-line-new-num") ?? "",
  );
}

/** The Files tab is selected and shows `path` with `lines` marked. */
async function expectFileOpen(root: HTMLElement, path: string, lines: string[]) {
  expect(await within(root).findByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await within(root).findByRole("heading", { name: path })).toBeInTheDocument();
  await waitFor(() => expect(marked()).toEqual(lines), { timeout: 5000 });
}

describe("references in messages", () => {
  it("colors references in user messages, inline code included", async () => {
    await renderApp({ desktop: true });
    const user = await screen.findByTestId("user-message");
    const buttons = within(user).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["@src/a.ts:3-4", "@b.ts:2"]);
    for (const button of buttons) expect(button).toHaveClass("text-link");
  });

  it("colors references in assistant text, not bare paths or code blocks", async () => {
    await renderApp({ desktop: true });
    const assistant = await screen.findByTestId("assistant-text");
    await waitFor(() =>
      expect(references(assistant).map((ref) => ref.textContent)).toEqual([
        "@src/a.ts:2",
        "@3f2a9c1:./src/a.ts:4",
      ]),
    );
    const [plain, inCode] = references(assistant);
    expect(plain).toHaveAttribute("role", "button");
    expect(plain).toHaveAttribute("tabindex", "0");
    expect(plain).toHaveClass("text-link");
    expect(inCode?.parentElement?.tagName).toBe("CODE");
    expect(assistant).toHaveTextContent("and src/a.ts:3.");
  });

  it("a click opens the pane's Files tab at those lines on desktop", async () => {
    const { router } = await renderApp({ desktop: true });
    const user = await screen.findByTestId("user-message");
    await userEvent.setup().click(within(user).getByRole("button", { name: "@src/a.ts:3-4" }));
    const pane = await screen.findByRole("complementary", { name: "Review" });
    await expectFileOpen(pane, "src/a.ts", ["3", "4"]);
    expect(router.state.location.pathname).toBe("/agents/a1");
    expect(toast).not.toHaveBeenCalled();
  });

  it("Enter on a reference in a reply opens it; a version-named one at its version", async () => {
    await renderApp({ desktop: true });
    const assistant = await screen.findByTestId("assistant-text");
    const versioned = await waitFor(() => {
      const ref = references(assistant)[1];
      if (!ref) throw new Error("no reference");
      return ref;
    });
    versioned.focus();
    fireEvent.keyDown(versioned, { key: "Enter" });
    const pane = await screen.findByRole("complementary", { name: "Review" });
    await expectFileOpen(pane, "src/a.ts", ["4"]);
    expect(within(pane).getByTitle("As committed in 3f2a9c1")).toHaveTextContent("@3f2a9c1");
    expect(readRevs).toEqual(["3f2a9c1"]);
    expect(toast).not.toHaveBeenCalled();
    expect(useReviewStore.getState().reviews.a1?.paneOpen).toBe(true);
  });

  it("a click navigates to the review page at those lines on phones", async () => {
    const { router } = await renderApp({ desktop: false });
    const assistant = await screen.findByTestId("assistant-text");
    const ref = await within(assistant).findByText("@src/a.ts:2");
    await userEvent.setup().click(ref);
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1/diff"));
    expect(screen.queryByRole("complementary", { name: "Review" })).toBeNull();
    await expectFileOpen(document.body, "src/a.ts", ["2"]);
  });
});
