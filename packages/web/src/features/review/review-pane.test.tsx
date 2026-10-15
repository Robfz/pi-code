import type { SessionEntry, Snapshot } from "@pi-code/protocol";
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
async function renderApp(
  path: string,
  { desktop, snapshot }: { desktop: boolean; snapshot?: Partial<Snapshot> },
) {
  stubMatchMedia((query) => desktop && query === DESKTOP_QUERY);
  const { calls } = stubFetch((call) => {
    if (call.url === "/api/agents/a1/snapshot")
      return [200, makeSnapshot({ agent: makeAgent({ id: "a1" }), ...snapshot })];
    if (call.url === "/api/agents/a1/rpc")
      return [200, { data: { text: "Build the thing", cancelled: false } }];
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
const rail = () => screen.getByRole("toolbar", { name: "Side panel" });
const railButton = (name: string) => within(rail()).getByRole("button", { name });
const pressed = () =>
  within(rail())
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);
const selectedTab = (root: HTMLElement) =>
  within(root)
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

/** The Changes section of `notes.txt` under `root`, expanded by default. */
function changedFile(root: HTMLElement) {
  return within(root).findByTestId("diff-file");
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
  it("the rail opens the pane on each tab and closes it from the tab showing", async () => {
    await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const user = userEvent.setup();
    expect(pane()).toBeNull();
    expect(pressed()).toEqual([]);
    expect(screen.getByTestId("transcript-column")).toHaveClass("max-w-[46rem]");

    await user.click(railButton("Changes panel"));
    const shown = await screen.findByRole("complementary", { name: "Review" });
    expect(selectedTab(shown)).toBe("Changes");
    expect(
      within(shown)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Changes", "Files", "Tree"]);
    expect(await within(shown).findByTestId("diff-file")).toHaveTextContent("notes.txt");
    expect(pressed()).toEqual(["Changes panel"]);
    for (const column of ["transcript-column", "composer-column"]) {
      expect(screen.getByTestId(column)).toHaveClass("max-w-[46rem]", "lg:px-6");
    }

    await user.click(railButton("Files panel"));
    expect(selectedTab(shown)).toBe("Files");
    expect(pressed()).toEqual(["Files panel"]);
    await user.click(railButton("Files panel"));
    expect(pane()).toBeNull();
    expect(pressed()).toEqual([]);

    await user.click(railButton("Tree panel"));
    const tree = await screen.findByRole("complementary", { name: "Review" });
    expect(selectedTab(tree)).toBe("Tree");
    expect(within(tree).getByText("No messages yet.")).toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: "Refresh" })).toBeNull();
    // The pane's tabs and the rail agree.
    await user.click(within(tree).getByRole("tab", { name: "Changes" }));
    expect(pressed()).toEqual(["Changes panel"]);

    await user.click(screen.getByRole("button", { name: "Close pane" }));
    expect(pane()).toBeNull();
    // Focus lands on the rail button that reopens the closed tab.
    expect(railButton("Changes panel")).toHaveFocus();

    // Neither Tree nor the changes toggle in the header; no Diff item in the menu.
    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("link", { name: "Tree" })).toBeNull();
    expect(within(header).queryByRole("button", { name: /changes/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menuitem", { name: /Clone/ });
    expect(screen.queryByRole("menuitem", { name: /Diff/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Tree/ })).toBeNull();
  });

  it("marks Changes while the working tree is dirty", async () => {
    await renderApp("/agents/a1", {
      desktop: true,
      snapshot: { gitStatus: { branch: "main", dirty: true } },
    });
    await waitFor(() => expect(box()).toBeEnabled());
    const changes = railButton("Changes panel, uncommitted changes");
    expect(within(changes).getByTestId("rail-dirty")).toBeInTheDocument();
  });

  it("/diff toggles the pane on Changes", async () => {
    const { router } = await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const user = userEvent.setup();
    const run = async (command: string) => {
      await user.type(box(), command);
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Send" }));
    };
    await run("/diff");
    expect(await screen.findByRole("complementary", { name: "Review" })).toBeInTheDocument();
    await run("/diff");
    await waitFor(() => expect(pane()).toBeNull());

    await run("/tree");
    const shown = await screen.findByRole("complementary", { name: "Review" });
    expect(selectedTab(shown)).toBe("Tree");
    await run("/diff");
    await waitFor(() => expect(selectedTab(shown)).toBe("Changes"));
    expect(router.state.location.pathname).toBe("/agents/a1");
  });

  it("the open pane and its tab survive a reload", async () => {
    await renderApp("/agents/a1", { desktop: true });
    await waitFor(() => expect(box()).toBeEnabled());
    const user = userEvent.setup();
    await user.click(railButton("Changes panel"));
    await user.click(await screen.findByRole("tab", { name: "Files" }));
    cleanup();

    const saved = localStorage.getItem("pi-code:review") ?? "";
    useReviewStore.setState({ reviews: {} });
    localStorage.setItem("pi-code:review", saved);
    await act(() => useReviewStore.persist.rehydrate());

    await renderApp("/agents/a1", { desktop: true });
    const shown = await screen.findByRole("complementary", { name: "Review" });
    expect(selectedTab(shown)).toBe("Files");
  });

  it("the tree URL opens the pane on Tree and replaces itself with the conversation", async () => {
    const { router } = await renderApp("/agents/a1/tree", { desktop: true });
    const shown = await screen.findByRole("complementary", { name: "Review" });
    expect(selectedTab(shown)).toBe("Tree");
    expect(router.state.location.pathname).toBe("/agents/a1");
    expect(router.history.length).toBe(1);
    expect(screen.queryByRole("link", { name: "Back to conversation" })).toBeNull();
  });

  it("forking from the pane's tree keeps the pane open", async () => {
    useReviewStore.getState().openPane("a1", "tree");
    const entry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: "user", content: "Build the thing", timestamp: 0 },
    } as unknown as SessionEntry;
    const { router } = await renderApp("/agents/a1", {
      desktop: true,
      snapshot: { transcript: { entries: [entry], leafId: "u1" } },
    });
    await waitFor(() => expect(box()).toBeEnabled());
    const shown = await screen.findByRole("complementary", { name: "Review" });
    const user = userEvent.setup();
    await user.click(await within(shown).findByText("Build the thing"));
    await user.click(within(shown).getByRole("button", { name: /Fork from here/ }));
    await waitFor(() => expect(box()).toHaveValue("Build the thing"));
    expect(router.state.location.pathname).toBe("/agents/a1");
    expect(pane()).toBe(shown);
    expect(selectedTab(shown)).toBe("Tree");
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
    await tap(await changedFile(shown), 2);
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
    expect(screen.queryByRole("toolbar", { name: "Side panel" })).toBeNull();

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

  it("the page offers Changes and Files, showing Changes for the pane's Tree", async () => {
    useReviewStore.getState().openPane("a1", "tree");
    await renderApp("/agents/a1/diff", { desktop: false });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Changes", "Files"]);
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("diff-file")).toHaveTextContent("notes.txt");
  });

  it("Add to chat returns to the conversation with the reference in the draft", async () => {
    const { router } = await renderApp("/agents/a1/diff", { desktop: false });
    const row = await changedFile(await screen.findByRole("tabpanel"));
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
