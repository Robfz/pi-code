import { type AgentInfo, initialLiveState, type SessionSummary } from "@pi-code/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { type FetchCall, stubFetch } from "@/test/render";
import { RELATIVE_TIME_TICK_MS, SEARCH_DEBOUNCE_MS } from "./sidebar";

function session(patch: Partial<SessionSummary> & { file: string }): SessionSummary {
  return {
    id: patch.file,
    cwd: "/home/me/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

async function renderSidebar(
  path = "/",
  handler: (call: FetchCall) => [number, unknown] | undefined = () => undefined,
) {
  stubMatchMedia((query) => query === DESKTOP_QUERY);
  const fetchStub = stubFetch((call) => {
    const answer = handler(call);
    if (answer) return answer;
    const match = /^\/api\/agents\/([^/]+)\/snapshot$/.exec(call.url);
    if (match) return [200, makeSnapshot({ agent: makeAgent({ id: match[1] }) })];
    if (call.url === "/api/sessions") return [200, { sessions: [] }];
    return undefined;
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  await screen.findByRole("navigation", { name: "Conversations" });
  return { router, ...fetchStub };
}

function baseline(
  agents: AgentInfo[],
  sessions: SessionSummary[] = [],
  branches: Record<string, string> = {},
) {
  sendFrame({ type: "baseline", agents, sessions, branches });
}

/**
 * Hold the `fetch` calls `matches` picks until their release function (in call order) runs;
 * the others go through to the current stub.
 */
function holdFetch(
  matches: (input: RequestInfo | URL, init?: RequestInit) => boolean,
): Array<() => void> {
  const held: Array<() => void> = [];
  const stub = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    matches(input, init)
      ? new Promise<Response>((resolve) => held.push(() => resolve(stub(input, init))))
      : stub(input, init),
  );
  return held;
}

const nav = () => screen.getByRole("navigation", { name: "Conversations" });
const row = (name: RegExp | string) =>
  within(nav())
    .getAllByTestId("sidebar-row")
    .find((li) => within(li).queryByText(name) !== null) as HTMLElement;
const titles = (group: string) =>
  within(within(nav()).getByRole("group", { name: group }))
    .getAllByTestId("sidebar-row-title")
    .map((title) => title.textContent);

afterEach(() => vi.unstubAllGlobals());

describe("Sidebar", () => {
  it("lists agents and free sessions by folder, most recent first", async () => {
    await renderSidebar();
    baseline(
      [
        makeAgent({
          id: "a1",
          cwd: "/home/me/pi-code",
          sessionName: "Desktop design doc",
          startedAt: recent(2),
          sessionFile: "f1",
        }),
        makeAgent({
          id: "a2",
          cwd: "/home/me/Kepi/phoenix",
          sessionName: "Phoenix",
          startedAt: recent(90),
        }),
      ],
      [
        session({ file: "f1", cwd: "/home/me/pi-code", name: "Held", updatedAt: recent(1) }),
        session({
          file: "f2",
          cwd: "/home/me/pi-code",
          name: "Refactor catalog",
          updatedAt: recent(60 * 72),
        }),
        session({
          file: "f3",
          cwd: "/home/me/phoenix/phoenix",
          firstMessage: "Old phoenix",
          updatedAt: recent(60 * 24),
        }),
      ],
      { "/home/me/pi-code": "main", "/home/me/phoenix/phoenix": "stale" },
    );
    await within(nav()).findByText("Desktop design doc");
    const groups = within(nav())
      .getAllByRole("group")
      .map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);
    expect(groups).toEqual(["pi-code", "Kepi/phoenix", "phoenix/phoenix"]);
    expect(titles("pi-code")).toEqual(["Desktop design doc", "Refactor catalog"]);
    expect(within(nav()).queryByText("Held")).toBeNull();
    const piCode = within(nav()).getByRole("group", { name: "pi-code" });
    expect(within(piCode).getByText("main")).toBeInTheDocument();
    expect(within(nav()).queryByText("stale")).toBeNull();
    // The agent's activity is its session's last write, later than its start.
    expect(within(row("Desktop design doc")).getByText("1m ago")).toBeInTheDocument();
  });

  it("marks rows per status and shows attention", async () => {
    await renderSidebar("/agents/ready");
    baseline(
      [
        makeAgent({ id: "ready", sessionName: "Ready one", attention: "finished" }),
        makeAgent({ id: "trust", sessionName: "Trust one", status: "awaiting_trust" }),
        makeAgent({
          id: "streaming",
          sessionName: "Streaming one",
          isStreaming: true,
          attention: "input",
        }),
        makeAgent({ id: "starting", sessionName: "Starting one", status: "starting" }),
        makeAgent({
          id: "exited",
          sessionName: "Exited one",
          status: "exited",
          sessionFile: "fx",
          attention: "failed",
        }),
      ],
      [session({ file: "free", name: "Disk one" })],
    );
    await within(nav()).findByText("Ready one");
    const mark = (name: string) =>
      within(row(name))
        .queryAllByRole("img")
        .map((img) => img.getAttribute("aria-label"));
    // The status mark, then the attention icon.
    expect(mark("Ready one")).toEqual(["Live", "Finished"]);
    expect(mark("Trust one")).toEqual(["Live"]);
    expect(mark("Streaming one")).toEqual(["Working", "Needs input"]);
    expect(mark("Starting one")).toEqual(["Working"]);
    expect(mark("Exited one")).toEqual(["Failed"]);
    expect(mark("Disk one")).toEqual([]);
    expect(within(row("Ready one")).getByRole("img", { name: "Finished" })).toHaveAttribute(
      "title",
      "Finished",
    );
    expect(within(row("Ready one")).queryByText("Finished")).toBeNull();
    // Close only on live rows.
    expect(
      within(row("Ready one")).getByRole("button", { name: "Close Ready one (project)" }),
    ).toBeInTheDocument();
    expect(within(row("Starting one")).getByRole("button", { name: /Close/ })).toBeInTheDocument();
    expect(within(row("Exited one")).queryByRole("button", { name: /Close/ })).toBeNull();
    expect(within(row("Disk one")).queryByRole("button", { name: /Close/ })).toBeNull();
    // The route's agent is highlighted.
    expect(within(row("Ready one")).getByRole("link")).toHaveAttribute("aria-current", "page");
    expect(within(row("Trust one")).getByRole("link")).not.toHaveAttribute("aria-current");
  });

  it("navigates to a live row", async () => {
    const { router, calls } = await renderSidebar();
    baseline([makeAgent({ id: "a1", sessionName: "Live one" })]);
    await userEvent.setup().click(await within(nav()).findByRole("link", { name: /Live one/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/agents")).toBe(false);
  });

  it("resumes a session row through POST /api/agents", async () => {
    const { router, calls } = await renderSidebar("/", (call) =>
      call.url === "/api/agents" && call.method === "POST"
        ? [200, { agent: makeAgent({ id: "new" }) }]
        : undefined,
    );
    baseline([], [session({ file: "free", name: "Disk one" })]);
    await userEvent.setup().click(await within(nav()).findByRole("button", { name: /Disk one/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/new"));
    expect(
      calls.filter((c) => c.method === "POST" && c.url === "/api/agents").map((c) => c.body),
    ).toEqual([{ sessionFile: "free" }]);
  });

  it("restarts an exited agent's row and navigates to it", async () => {
    const { router, calls } = await renderSidebar("/", (call) =>
      call.url === "/api/agents/exited/restart"
        ? [200, { agent: makeAgent({ id: "exited", status: "starting" }) }]
        : undefined,
    );
    baseline([
      makeAgent({ id: "exited", sessionName: "Exited one", status: "exited", sessionFile: "fx" }),
    ]);
    await userEvent.setup().click(await within(nav()).findByRole("button", { name: /Exited one/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/exited"));
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toContain("/api/agents/exited/restart");
    expect(posts).not.toContain("/api/agents");
  });

  it("toasts a failed restart and stays put", async () => {
    const { router } = await renderSidebar("/", (call) =>
      call.url === "/api/agents/exited/restart"
        ? [500, { error: { code: "internal", message: "Restart broke" } }]
        : undefined,
    );
    baseline([makeAgent({ id: "exited", sessionName: "Exited one", status: "exited" })]);
    await userEvent.setup().click(await within(nav()).findByRole("button", { name: /Exited one/ }));
    expect(await screen.findByText("Restart broke")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps times aligned: rows without × reserve its slot", async () => {
    await renderSidebar();
    baseline(
      [makeAgent({ id: "a1", sessionName: "Live one" })],
      [session({ file: "free", name: "Disk one" })],
    );
    await within(nav()).findByText("Disk one");
    const lastChild = (name: string) => row(name).lastElementChild as HTMLElement;
    expect(lastChild("Live one").tagName).toBe("BUTTON");
    expect(lastChild("Disk one")).toHaveAttribute("aria-hidden", "true");
    expect(lastChild("Disk one")).toHaveClass("size-6");
  });

  it("clears the search from its clear button", async () => {
    await renderSidebar();
    baseline([]);
    const user = userEvent.setup();
    const box = within(nav()).getByRole("searchbox");
    expect(within(nav()).queryByRole("button", { name: "Clear search" })).toBeNull();
    await user.type(box, "abc");
    await user.click(within(nav()).getByRole("button", { name: "Clear search" }));
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
  });

  it("stays usable while a dialog is pending; the dialog shows again on return", async () => {
    const dialog = {
      request: {
        type: "extension_ui_request" as const,
        id: "d1",
        method: "confirm" as const,
        title: "Proceed?",
        message: "Sure?",
      },
      receivedAt: Date.now(),
    };
    const { router, calls } = await renderSidebar("/agents/a1", (call) =>
      call.url === "/api/agents/a1/snapshot"
        ? [
            200,
            makeSnapshot({
              agent: makeAgent({ id: "a1", sessionName: "Asking one" }),
              live: { ...initialLiveState(), dialogs: [dialog] },
            }),
          ]
        : undefined,
    );
    baseline([
      makeAgent({ id: "a1", sessionName: "Asking one" }),
      makeAgent({ id: "a2", sessionName: "Other one" }),
    ]);
    expect(await screen.findByTestId("dialog-confirm")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(nav()).getByRole("link", { name: /Other one/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a2"));
    expect(screen.queryByTestId("dialog-confirm")).toBeNull();
    await user.click(within(nav()).getByRole("link", { name: /Asking one/ }));
    expect(await screen.findByTestId("dialog-confirm")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/ui-responses"))).toBe(false);
  });

  it("starts a conversation in a folder from its +", async () => {
    const { router, calls } = await renderSidebar("/", (call) =>
      call.url === "/api/agents" && call.method === "POST"
        ? [201, { agent: makeAgent({ id: "n1", status: "starting", cwd: "/home/me/alpha" }) }]
        : undefined,
    );
    baseline([], [session({ file: "s", cwd: "/home/me/alpha", name: "Alpha session" })]);
    await userEvent
      .setup()
      .click(await within(nav()).findByRole("button", { name: "New conversation in alpha" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n1"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd: "/home/me/alpha" });
  });

  it("closes a live row with DELETE and drops its store", async () => {
    const { calls } = await renderSidebar("/agents/a1", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Live one" })]);
    await userEvent
      .setup()
      .click(await within(nav()).findByRole("button", { name: "Close Live one (project)" }));
    expect(await screen.findByRole("heading", { name: "Conversation closed" })).toBeInTheDocument();
    // The sidebar is there; no back-to-Home chevron.
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/agents/a1");
  });

  it("sends one DELETE however often × is clicked while it's in flight", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    const held = holdFetch((_input, init) => init?.method === "DELETE");
    baseline([makeAgent({ id: "a1", sessionName: "Live one" })]);
    const button = await within(nav()).findByRole("button", { name: "Close Live one (project)" });
    const user = userEvent.setup();
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(held).toHaveLength(1);
    held[0]?.();
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
  });

  it("asks before closing a working agent or one waiting for input", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([
      makeAgent({ id: "a1", sessionName: "Streaming one", isStreaming: true }),
      makeAgent({ id: "a2", sessionName: "Asking one", attention: "input" }),
    ]);
    const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    const user = userEvent.setup();

    await user.click(
      await within(nav()).findByRole("button", { name: "Close Streaming one (project)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Close Streaming one?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes()).toEqual([]);

    await user.click(within(nav()).getByRole("button", { name: "Close Asking one (project)" }));
    const confirm = await screen.findByRole("dialog", { name: "Close Asking one?" });
    await user.click(within(confirm).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(deletes()).toEqual(["/api/agents/a2"]));
  });

  it("opens the project picker from New conversation", async () => {
    await renderSidebar("/settings");
    await userEvent.setup().click(within(nav()).getByRole("button", { name: "New conversation" }));
    expect(await screen.findByTestId("project-picker")).toBeInTheDocument();
  });

  it("searches after the debounce: results replace window rows, agents filter locally", async () => {
    const searches: string[] = [];
    await renderSidebar("/", (call) => {
      if (call.url !== "/api/sessions" || call.search === "") return undefined;
      searches.push(new URLSearchParams(call.search).get("q") ?? "");
      return [
        200,
        {
          sessions: [
            session({
              file: "old",
              cwd: "/home/me/Kepi/phoenix",
              name: "Ancient phoenix",
              updatedAt: "2025-01-01T00:00:00.000Z",
            }),
            session({ file: "held", cwd: "/home/me/Kepi/phoenix", name: "Held by agent" }),
          ],
        },
      ];
    });
    baseline(
      [
        makeAgent({
          id: "a1",
          cwd: "/home/me/Kepi/phoenix",
          sessionName: "Phoenix agent",
          sessionFile: "held",
        }),
        makeAgent({ id: "a2", cwd: "/home/me/other", sessionName: "Rise from phoenix" }),
        makeAgent({ id: "a3", cwd: "/home/me/other", sessionName: "Unrelated" }),
      ],
      [session({ file: "recent", cwd: "/home/me/other", name: "Recent window row" })],
    );
    await within(nav()).findByText("Recent window row");

    const user = userEvent.setup();
    await user.type(within(nav()).getByRole("searchbox", { name: "Search conversations" }), "phoe");
    expect(searches).toEqual([]);
    await waitFor(() => expect(searches).toEqual(["phoe"]), { timeout: SEARCH_DEBOUNCE_MS * 5 });

    expect(await within(nav()).findByText("Ancient phoenix")).toBeInTheDocument();
    expect(within(nav()).getByText("Phoenix agent")).toBeInTheDocument();
    expect(within(nav()).getByText("Rise from phoenix")).toBeInTheDocument();
    expect(within(nav()).queryByText("Unrelated")).toBeNull();
    expect(within(nav()).queryByText("Recent window row")).toBeNull();
    expect(within(nav()).queryByText("Held by agent")).toBeNull();

    await user.clear(within(nav()).getByRole("searchbox"));
    expect(within(nav()).getByText("Recent window row")).toBeInTheDocument();
    expect(within(nav()).getByText("Unrelated")).toBeInTheDocument();
    expect(within(nav()).queryByText("Ancient phoenix")).toBeNull();
    expect(searches).toEqual(["phoe"]);
  });

  it("hides a found session held by an agent the search filters out", async () => {
    await renderSidebar("/", (call) =>
      call.url === "/api/sessions" && call.search !== ""
        ? [200, { sessions: [session({ file: "held", name: "Phoenix notes" })] }]
        : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Unrelated", sessionFile: "held" })]);
    await within(nav()).findByText("Unrelated");
    await userEvent.setup().type(within(nav()).getByRole("searchbox"), "phoenix");
    expect(await within(nav()).findByText("No matches.")).toBeInTheDocument();
    expect(within(nav()).queryByText("Phoenix notes")).toBeNull();
    expect(within(nav()).queryByText("Unrelated")).toBeNull();
  });

  it("shows a search error without 'No matches.'", async () => {
    await renderSidebar("/", (call) =>
      call.url === "/api/sessions" && call.search !== ""
        ? [500, { error: { code: "internal", message: "Search broke" } }]
        : undefined,
    );
    baseline([]);
    await within(nav()).findByText("No conversations yet.");
    await userEvent.setup().type(within(nav()).getByRole("searchbox"), "zzz");
    // One retry, a second apart, before the error shows.
    expect(await within(nav()).findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(
      "Search broke",
    );
    expect(within(nav()).queryByText("No matches.")).toBeNull();
  });

  it("keeps the previous results on screen while the next query loads", async () => {
    await renderSidebar("/", (call) =>
      call.url === "/api/sessions" && call.search !== ""
        ? [
            200,
            {
              sessions: [
                session({ file: new URLSearchParams(call.search).get("q") ?? "", name: "Found" }),
              ],
            },
          ]
        : undefined,
    );
    baseline([]);
    await within(nav()).findByText("No conversations yet.");
    const user = userEvent.setup();
    const box = within(nav()).getByRole("searchbox");
    await user.type(box, "ab");
    expect(await within(nav()).findByText("Found")).toBeInTheDocument();
    const held = holdFetch((input) => String(input).includes("q="));
    await user.type(box, "c");
    await waitFor(() => expect(held).toHaveLength(1), { timeout: SEARCH_DEBOUNCE_MS * 5 });
    expect(within(nav()).getByText("Found")).toBeInTheDocument();
    expect(within(nav()).queryByText("Searching…")).toBeNull();
    held[0]?.();
  });

  it("says when a search finds nothing", async () => {
    await renderSidebar("/", (call) =>
      call.url === "/api/sessions" && call.search !== "" ? [200, { sessions: [] }] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Live one" })]);
    await within(nav()).findByText("Live one");
    await userEvent.setup().type(within(nav()).getByRole("searchbox"), "zzz");
    expect(await within(nav()).findByText("No matches.")).toBeInTheDocument();
    expect(within(nav()).queryByText("Live one")).toBeNull();
  });

  it("refreshes relative times every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await renderSidebar();
      baseline([makeAgent({ id: "a1", sessionName: "Live one", startedAt: recent(1) })]);
      expect(await within(row("Live one")).findByText("1m ago")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(RELATIVE_TIME_TICK_MS));
      expect(within(row("Live one")).getByText("2m ago")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
