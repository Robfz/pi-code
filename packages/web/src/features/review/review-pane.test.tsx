import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { stubCanvas } from "@/components/diff/testing";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendBaseline } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";
import { fixtureEditPatch } from "@/tools/testing";
import { useReviewStore } from "./review-state";

beforeAll(stubCanvas);
afterEach(() => vi.unstubAllGlobals());

const gitPatch = () =>
  `diff --git a/notes.txt b/notes.txt\nindex 1..2 100644\n${fixtureEditPatch()}`;

/** The app at `path` with agent a1 open; one changed file, an empty file search. */
async function renderApp(path: string, { desktop }: { desktop: boolean }) {
  stubMatchMedia((query) => desktop && query === DESKTOP_QUERY);
  // cmdk's list measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const { calls } = stubFetch((call) => {
    if (call.url === "/api/agents/a1/snapshot")
      return [200, makeSnapshot({ agent: makeAgent({ id: "a1" }) })];
    if (call.url === "/api/agents/a1/git/diff")
      return [
        200,
        {
          oldRev: "abc1234",
          files: [
            {
              path: "notes.txt",
              status: "modified",
              binary: false,
              tooLarge: false,
              patch: gitPatch(),
            },
          ],
        },
      ];
    if (call.url === "/api/agents/a1/files") return [200, { files: [] }];
    return undefined;
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  sendBaseline([makeAgent({ id: "a1" })]);
  return { router, calls };
}

const box = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
const pane = () => screen.queryByRole("complementary", { name: "Review" });
const paneOpen = () => useReviewStore.getState().reviews.a1?.paneOpen ?? false;

/** Expands the Changes row of `notes.txt` under `root`. */
async function expand(root: HTMLElement) {
  const row = await within(root).findByTestId("diff-file");
  await userEvent.setup().click(within(row).getByRole("button"));
  return row;
}

/** A click or tap on new line `line`'s number under `root`, once the view has rendered it. */
async function tap(root: HTMLElement, line: number) {
  const span = await waitFor(
    () => {
      const found = root.querySelector<HTMLElement>(`[data-line-new-num="${line}"]`);
      if (!found) throw new Error(`no new line ${line}`);
      return found;
    },
    { timeout: 3000 },
  );
  fireEvent.mouseDown(span);
  fireEvent.mouseUp(span);
}

describe("review pane on desktop", () => {
  it("the header button toggles the pane beside the capped conversation column", async () => {
    await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const user = userEvent.setup();
    expect(pane()).toBeNull();
    expect(screen.getByTestId("transcript-column")).toHaveClass("max-w-[46rem]");

    await user.click(screen.getByRole("button", { name: "Show changes" }));
    const shown = await screen.findByRole("complementary", { name: "Review" });
    expect(within(shown).getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(shown).findByTestId("diff-file")).toHaveTextContent("notes.txt");
    expect(screen.getByRole("button", { name: "Hide changes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const column of ["transcript-column", "composer-column"]) {
      expect(screen.getByTestId(column)).toHaveClass("max-w-[46rem]", "lg:px-6");
    }

    await user.click(screen.getByRole("button", { name: "Hide changes" }));
    expect(pane()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show changes" }));
    await user.click(screen.getByRole("button", { name: "Close changes" }));
    expect(pane()).toBeNull();
    expect(screen.getByRole("button", { name: "Show changes" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // No Diff item in the menu on desktop.
    await user.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menuitem", { name: /Tree/ });
    expect(screen.queryByRole("menuitem", { name: /Diff/ })).toBeNull();
  });

  it("/diff toggles the pane", async () => {
    const { router } = await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const user = userEvent.setup();
    const run = async () => {
      await user.type(box(), "/diff");
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Send" }));
    };
    await run();
    expect(await screen.findByRole("complementary", { name: "Review" })).toBeInTheDocument();
    await run();
    await waitFor(() => expect(pane()).toBeNull());
    expect(router.state.location.pathname).toBe("/agents/a1");
  });

  it("the open pane and its tab survive a reload", async () => {
    await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show changes" }));
    await user.click(await screen.findByRole("tab", { name: "Files" }));
    cleanup();

    const saved = localStorage.getItem("pi-code:review") ?? "";
    useReviewStore.setState({ reviews: {} });
    localStorage.setItem("pi-code:review", saved);
    await act(() => useReviewStore.persist.rehydrate());

    await renderApp("/agents/a1", { desktop: true });
    const shown = await screen.findByRole("complementary", { name: "Review" });
    // Only `paneOpen` is persisted; the tab is back to Changes.
    expect(within(shown).getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("the tree route shows no pane", async () => {
    useReviewStore.getState().openPane("a1");
    const { router } = await renderApp("/agents/a1", { desktop: true });
    expect(await screen.findByRole("complementary", { name: "Review" })).toBeInTheDocument();
    await act(() => router.navigate({ to: "/agents/$agentId/tree", params: { agentId: "a1" } }));
    await screen.findByRole("link", { name: "Back to conversation" });
    expect(pane()).toBeNull();
  });

  it("the diff URL opens the pane and replaces itself with the conversation", async () => {
    const { router } = await renderApp("/agents/a1/diff", { desktop: true });
    expect(await screen.findByRole("complementary", { name: "Review" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agents/a1");
    expect(router.history.length).toBe(1);
    expect(paneOpen()).toBe(true);
  });

  it("a click on a line in the pane lands in the composer", async () => {
    useReviewStore.getState().openPane("a1");
    await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const shown = await screen.findByRole("complementary", { name: "Review" });
    await tap(await expand(shown), 2);
    expect(box()).toHaveValue("@notes.txt:2 ");
    expect(box()).toHaveFocus();
  });
});

describe("review page on phones", () => {
  it("shows no pane; the menu's Diff opens the page with its tabs", async () => {
    useReviewStore.getState().openPane("a1");
    const { router, calls } = await renderApp("/agents/a1", { desktop: false });
    await waitFor(() => expect(box()).toBeEnabled());
    expect(pane()).toBeNull();
    expect(screen.queryByRole("button", { name: /changes/ })).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: /Diff/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1/diff"));
    expect(await screen.findByTestId("diff-file")).toHaveTextContent("notes.txt");

    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Type to search files")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Search files" }), "notes");
    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/agents/a1/files")).toBe(true),
    );
    expect(pane()).toBeNull();
  });

  it("Add to chat returns to the conversation with the reference in the draft", async () => {
    const { router } = await renderApp("/agents/a1/diff", { desktop: false });
    const row = await expand(await screen.findByRole("tabpanel"));
    await tap(row, 1);
    expect(screen.getByRole("toolbar", { name: "Line selection" })).toHaveTextContent(
      "Tap the last line",
    );
    await tap(row, 2);
    const bar = screen.getByRole("toolbar", { name: "Line selection" });
    expect(bar).toHaveTextContent("@notes.txt:1-2");
    await userEvent.setup().click(within(bar).getByRole("button", { name: "Add to chat" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
    await waitFor(() => expect(box()).toHaveValue("@notes.txt:1-2 "));
    expect(useDrafts.getState().drafts.a1?.text).toBe("@notes.txt:1-2 ");
  });
});
