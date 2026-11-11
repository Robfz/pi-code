import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { useReviewStore } from "@/features/review/review-state";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { type FetchCall, stubFetch } from "@/test/render";
import { stubUserAgent, USER_AGENTS } from "@/test/user-agents";

const URL_12 = "https://github.com/octo/repo/pull/12";
const reviewAgent = makeAgent({ id: "r1", cwd: "/home/me/repo/pr-12", sessionName: "PR 12" });

/**
 * The app at `path`; `startReview` answers `POST /api/pr-reviews` (default: the new agent).
 * Returns the router and the requests made.
 */
function renderApp(
  path: string,
  {
    desktop = true,
    startReview = () => [201, { agent: reviewAgent }],
  }: {
    desktop?: boolean;
    startReview?: () => [number, unknown] | Promise<[number, unknown]>;
  } = {},
) {
  stubMatchMedia((query) => desktop && query === DESKTOP_QUERY);
  const { calls } = stubFetch((call: FetchCall) => {
    if (call.url === "/api/pr-reviews") return startReview();
    if (call.url === "/api/agents/r1/snapshot") return [200, makeSnapshot({ agent: reviewAgent })];
    if (call.url === "/api/sessions") return [200, { sessions: [] }];
    return undefined;
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return { router, calls };
}

function baseline() {
  sendFrame({
    type: "baseline",
    agents: [],
    sessions: [],
    branches: {},
    sidebar: { pinned: [], collapsed: [], mains: {} },
    prs: {},
  });
}

const reviewRequests = (calls: FetchCall[]) => calls.filter((c) => c.url === "/api/pr-reviews");

async function openFromHome() {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Review PR" }));
  return screen.findByTestId("pr-review-dialog");
}

beforeEach(() => {
  stubUserAgent(USER_AGENTS.macChrome);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useReviewStore.setState({ reviews: {} });
});

describe("Review PR", () => {
  it("starts the review from the desktop Home and opens the conversation on its guide", async () => {
    const { router, calls } = renderApp("/");
    const dialog = await openFromHome();
    const field = within(dialog).getByLabelText("Pull request URL");
    expect(field).toHaveFocus();
    const submit = within(dialog).getByRole("button", { name: "Review" });
    expect(submit).toBeDisabled();
    // Pasted, with whitespace around it.
    fireEvent.change(field, { target: { value: `  ${URL_12}\n` } });
    await userEvent.setup().click(submit);

    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/r1"));
    expect(reviewRequests(calls)).toEqual([
      expect.objectContaining({ method: "POST", body: { url: URL_12 } }),
    ]);
    await waitFor(() => expect(screen.queryByTestId("pr-review-dialog")).toBeNull());
    expect(useReviewStore.getState().reviews.r1).toMatchObject({
      paneOpen: true,
      tab: "guide",
      diff: { mode: "pr" },
    });
  });

  it("opens from the phone's Home, on the Guide tab without a pane", async () => {
    const { router } = renderApp("/", { desktop: false });
    const dialog = await openFromHome();
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText("Pull request URL"), URL_12);
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/r1"));
    expect(useReviewStore.getState().reviews.r1).toMatchObject({ paneOpen: false, tab: "guide" });
  });

  it("opens with ⌘J R on any route, with the sidebar closed too", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    baseline();
    await userEvent.setup().click(screen.getByRole("button", { name: "Toggle sidebar" }));
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", metaKey: true });
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR" });
    const dialog = await screen.findByTestId("pr-review-dialog");
    expect(within(dialog).getByLabelText("Pull request URL")).toHaveFocus();
  });

  it("shows the server's error inline until the URL changes", async () => {
    const { router } = renderApp("/", {
      startReview: () => [
        404,
        {
          error: {
            code: "repo_not_found",
            message: "no <repo>/main checkout of octo/repo is known",
          },
        },
      ],
    });
    const dialog = await openFromHome();
    const user = userEvent.setup();
    const field = within(dialog).getByLabelText("Pull request URL");
    await user.type(field, URL_12);
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("no <repo>/main checkout of octo/repo is known");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(router.state.location.pathname).toBe("/");
    await user.type(field, "/files");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("can't be dismissed while the review is prepared", async () => {
    let answer: (value: [number, unknown]) => void = () => {};
    const { router } = renderApp("/", {
      startReview: () => new Promise((resolve) => (answer = resolve)),
    });
    const dialog = await openFromHome();
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText("Pull request URL"), URL_12);
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    const pending = await within(dialog).findByRole("button", { name: "Preparing…" });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByLabelText("Pull request URL")).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(screen.getByTestId("pr-review-dialog")).toBeInTheDocument();

    answer([201, { agent: reviewAgent }]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/r1"));
  });

  it("opens empty every time", async () => {
    renderApp("/");
    const dialog = await openFromHome();
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText("Pull request URL"), URL_12);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("pr-review-dialog")).toBeNull());
    const again = await openFromHome();
    expect(within(again).getByLabelText("Pull request URL")).toHaveValue("");
  });
});
