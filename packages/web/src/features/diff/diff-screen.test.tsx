import type { GitFileDiff, PrAttachments } from "@pi-code/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadedDiff, stubCanvas } from "@/components/diff/testing";
import { useReviewStore } from "@/features/review/review-state";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { ConversationStoreProvider, LiveRegistryProvider } from "@/store/context";
import { LiveRegistry } from "@/store/live-registry";
import { stubMatchMedia } from "@/test/dom-stubs";
import { makeAgent, makePr } from "@/test/fixtures";
import { type FetchCall, hydratedStore, stubFetch } from "@/test/render";
import { fixtureEditPatch } from "@/tools/testing";
import { DiffScreen } from "./diff-screen";

const editPatch = fixtureEditPatch;

const gitPatch = () => `diff --git a/notes.txt b/notes.txt\nindex 1..2 100644\n${editPatch()}`;

/** The conversation's session file, which `prs` may attach to a PR. */
const SESSION_FILE = "/sessions/s.jsonl";

async function renderScreen(agentId = "a1", prs: PrAttachments = {}) {
  const store = hydratedStore({ agent: makeAgent({ id: agentId, sessionFile: SESSION_FILE }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const registry = new LiveRegistry(client);
  registry.live.setState({ prs });
  const rootRoute = createRootRoute({
    component: () => (
      <LiveRegistryProvider registry={registry}>
        <ConversationStoreProvider store={store}>
          <Outlet />
        </ConversationStoreProvider>
      </LiveRegistryProvider>
    ),
  });
  const conversation = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agentId",
    component: () => <p>conversation</p>,
  });
  const diff = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agentId/diff",
    component: DiffScreen,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([conversation, diff]),
    history: createMemoryHistory({ initialEntries: [`/agents/${agentId}/diff`] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return router;
}

const file = (patch: Partial<GitFileDiff>): GitFileDiff => ({
  path: "notes.txt",
  status: "modified",
  binary: false,
  tooLarge: false,
  ...patch,
});

const urls = (calls: FetchCall[]) => calls.map((call) => call.url);

beforeAll(stubCanvas);
beforeEach(() => {
  stubMatchMedia(() => false);
});
afterEach(() => vi.unstubAllGlobals());

describe("DiffScreen", () => {
  it("lists files with status and counts, every patch expanded", async () => {
    const { calls } = stubFetch(() => [
      200,
      {
        files: [
          file({ patch: gitPatch() }),
          file({
            path: "new.ts",
            status: "untracked",
            patch: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n",
          }),
          file({ path: "b.ts", oldPath: "a.ts", status: "renamed", patch: "" }),
        ],
      },
    ]);
    await renderScreen("agent-7");
    const rows = await screen.findAllByTestId("diff-file");
    expect(calls).toEqual([
      { url: "/api/agents/agent-7/git/diff", search: "", method: "GET", body: undefined },
    ]);
    expect(rows).toHaveLength(3);
    expect(screen.getByText("3 files")).toBeInTheDocument();
    const [notes, added, renamed] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(notes).getByTitle("Modified")).toHaveTextContent("M");
    expect(notes).toHaveTextContent("+1 −1");
    expect(within(added).getByTitle("Untracked")).toHaveTextContent("U");
    expect(added).toHaveTextContent("+2 −0");
    expect(within(renamed).getByTitle("a.ts → b.ts")).toBeInTheDocument();

    // Every file starts expanded.
    expect(await loadedDiff(notes)).toHaveTextContent("I like banana bread.");
    expect(within(renamed).getByText("No textual changes.")).toBeInTheDocument();
  });

  it("binary and too-large files", async () => {
    stubFetch(() => [
      200,
      {
        files: [
          file({ path: "logo.png", binary: true }),
          file({ path: "dump.sql", tooLarge: true }),
        ],
      },
    ]);
    await renderScreen();
    const [binary, large] = (await screen.findAllByTestId("diff-file")) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(binary).toHaveTextContent("binary");
    expect(large).toHaveTextContent("too large");
    expect(within(binary).getByText("Binary file, no text diff.")).toBeInTheDocument();
    expect(within(large).getByText(/too large to show here/)).toBeInTheDocument();
  });

  it("not a git repository", async () => {
    stubFetch(() => [404, { error: { code: "not_a_git_repo", message: "Not a git repository" } }]);
    await renderScreen();
    expect(await screen.findByText("This project isn't a git repository.")).toBeInTheDocument();
  });

  it("clean working tree, refresh refetches", async () => {
    let files: GitFileDiff[] = [];
    const { calls } = stubFetch(() => [200, { files }]);
    await renderScreen();
    expect(await screen.findByText(/No changes/)).toBeInTheDocument();
    files = [file({ patch: gitPatch() })];
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByTestId("diff-file")).toBeInTheDocument();
    expect(urls(calls).filter((url) => url.endsWith("/git/diff"))).toHaveLength(2);
  });

  it("refresh in branch mode refetches the branches and the diff", async () => {
    useReviewStore.getState().setDiffMode("a1", { mode: "branch" });
    const { calls } = stubFetch((call) =>
      call.url === "/api/agents/a1/git/branches"
        ? [200, { branches: ["main"], defaultBranch: "main" }]
        : [200, { files: [] }],
    );
    await renderScreen();
    expect(await screen.findByText("No changes against main")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(urls(calls).sort()).toEqual([
        "/api/agents/a1/git/branches",
        "/api/agents/a1/git/branches",
        "/api/agents/a1/git/diff",
        "/api/agents/a1/git/diff",
      ]),
    );
  });

  it("refresh on the Files tab refetches the open file, then the search", async () => {
    useReviewStore.getState().setFilesQuery("a1", "a");
    useReviewStore.getState().openFile("a1", "a.ts");
    const { calls } = stubFetch((call) =>
      call.url === "/api/agents/a1/files/content"
        ? [200, { path: "a.ts", content: "one\n", binary: false, tooLarge: false }]
        : [200, { files: ["a.ts"] }],
    );
    await renderScreen();
    const user = userEvent.setup();
    await waitFor(() => expect(urls(calls)).toEqual(["/api/agents/a1/files/content"]));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(urls(calls)).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Back to search" }));
    await screen.findByRole("option", { name: "a.ts" });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(urls(calls)).toEqual([
        "/api/agents/a1/files/content",
        "/api/agents/a1/files/content",
        "/api/agents/a1/files",
        "/api/agents/a1/files",
      ]),
    );
  });

  it("other errors offer a retry; back link goes to the conversation", async () => {
    let fail = true;
    stubFetch(() =>
      fail ? [500, { error: { code: "internal", message: "git crashed" } }] : [200, { files: [] }],
    );
    const router = await renderScreen("a9");
    // One automatic retry (after ~1s) before the error shows.
    expect(
      await screen.findByText(/Couldn't load the diff: git crashed/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    fail = false;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No changes/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Back to conversation" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a9"));
  });

  it("switches between the Changes and Files tabs", async () => {
    stubFetch(() => [200, { files: [] }]);
    await renderScreen();
    const user = userEvent.setup();
    expect(await screen.findByText(/No changes/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Search files" })).toBeInTheDocument();
    expect(useReviewStore.getState().reviews.a1?.tab).toBe("files");
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    expect(await screen.findByText(/No changes/)).toBeInTheDocument();
  });

  it("opens an attached conversation on its Guide, then Changes shows the PR diff", async () => {
    const pr = makePr();
    const { calls } = stubFetch((call) =>
      call.url.endsWith("/pr/guide")
        ? [200, { key: "o/r#12@a..b", state: "generating" }]
        : [200, { files: [file({ patch: gitPatch() })], oldRev: "aaaaaaa", newRev: "bbbbbbb" }],
    );
    await renderScreen("p1", { [SESSION_FILE]: pr });
    expect(await screen.findByText("Writing the review guide…")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Guide",
      "Changes",
      "Files",
    ]);
    expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute("aria-selected", "true");
    expect(
      within(screen.getByTestId("pr-header")).getByRole("link", { name: "#12" }),
    ).toBeVisible();

    await userEvent.setup().click(screen.getByRole("tab", { name: "Changes" }));
    expect(await screen.findByTestId("diff-file")).toBeInTheDocument();
    expect(calls.map((call) => call.url + call.search)).toEqual([
      "/api/agents/p1/pr/guide",
      "/api/agents/p1/git/diff?pr=1",
    ]);
    expect(screen.getByRole("radio", { name: "PR" })).toHaveAttribute("aria-checked", "true");
    const header = screen.getByTestId("pr-header");
    expect(within(header).getByRole("link", { name: "#12" })).toHaveAttribute("href", pr.url);
    expect(header).toHaveTextContent("Speed up the parser");
  });

  it("shows a stored Guide tab without an attachment as Changes", async () => {
    useReviewStore.getState().setTab("a1", "guide");
    stubFetch(() => [200, { files: [] }]);
    await renderScreen();
    expect(await screen.findByText(/No changes/)).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Changes", "Files"]);
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
  });

  it("on desktop opens the review pane and replaces itself with the conversation", async () => {
    stubMatchMedia((query) => query === DESKTOP_QUERY);
    const { calls } = stubFetch(() => [200, { files: [] }]);
    const router = await renderScreen("a3");
    expect(await screen.findByText("conversation")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agents/a3");
    expect(router.history.length).toBe(1);
    expect(useReviewStore.getState().reviews.a3?.paneOpen).toBe(true);
    expect(calls).toEqual([]);
  });

  it("on desktop opens the pane on Changes when the pane would show Tree", async () => {
    stubMatchMedia((query) => query === DESKTOP_QUERY);
    useReviewStore.getState().setTab("a3", "tree");
    stubFetch(() => [200, { files: [] }]);
    await renderScreen("a3");
    expect(await screen.findByText("conversation")).toBeInTheDocument();
    expect(useReviewStore.getState().reviews.a3).toMatchObject({ paneOpen: true, tab: "changes" });
  });
});
