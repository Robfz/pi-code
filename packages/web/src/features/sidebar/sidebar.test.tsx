import {
  type AgentInfo,
  applySidebarPatch,
  initialLiveState,
  type RepoLayout,
  type SessionSummary,
  type SidebarPatch,
  type SidebarState,
} from "@pi-code/protocol";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { StopOrDeleteProvider } from "@/features/sessions/stop-or-delete";
import { WorktreeActionsProvider } from "@/features/worktrees/worktree-actions";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { LiveRegistry } from "@/store/live-registry";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { type FetchCall, stubFetch } from "@/test/render";
import { RELATIVE_TIME_TICK_MS, SEARCH_DEBOUNCE_MS, Sidebar } from "./sidebar";

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

/** The server's sidebar state, as `PATCH /api/sidebar` leaves it (every path exists). */
let serverSidebar: SidebarState = { pinned: [], collapsed: [] };

async function renderSidebar(
  path = "/",
  handler: (call: FetchCall) => [number, unknown] | undefined = () => undefined,
) {
  stubMatchMedia((query) => query === DESKTOP_QUERY);
  const fetchStub = stubFetch((call) => {
    const answer = handler(call);
    if (answer) return answer;
    if (call.url === "/api/sidebar" && call.method === "PATCH") {
      serverSidebar = applySidebarPatch(serverSidebar, call.body as SidebarPatch);
      return [200, { sidebar: serverSidebar }];
    }
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
  sidebar: SidebarState = { pinned: [], collapsed: [] },
) {
  serverSidebar = sidebar;
  sendFrame({ type: "baseline", agents, sessions, branches, sidebar });
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
  it("lists agents and free sessions by folder, most recently prompted first", async () => {
    await renderSidebar();
    baseline(
      [
        makeAgent({
          id: "a1",
          cwd: "/home/me/pi-code",
          sessionName: "Desktop design doc",
          startedAt: recent(0),
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
        session({
          file: "f1",
          cwd: "/home/me/pi-code",
          name: "Held",
          lastPromptAt: recent(3),
          updatedAt: recent(1),
        }),
        session({
          file: "f2",
          cwd: "/home/me/pi-code",
          name: "Refactor catalog",
          lastPromptAt: recent(60 * 72),
        }),
        session({
          file: "f3",
          cwd: "/home/me/phoenix/phoenix",
          firstMessage: "Old phoenix",
          lastPromptAt: recent(60 * 24),
        }),
      ],
      { "/home/me/pi-code": "main", "/home/me/phoenix/phoenix": "stale" },
    );
    await within(nav()).findByText("Desktop design doc");
    const groups = within(nav())
      .getAllByRole("group")
      .map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);
    // Kepi/phoenix holds only a never-prompted agent: it comes last.
    expect(groups).toEqual(["pi-code", "phoenix/phoenix", "Kepi/phoenix"]);
    expect(titles("pi-code")).toEqual(["Desktop design doc", "Refactor catalog"]);
    expect(within(nav()).queryByText("Held")).toBeNull();
    const piCode = within(nav()).getByRole("group", { name: "pi-code" });
    expect(within(piCode).getByText("main")).toBeInTheDocument();
    expect(within(nav()).queryByText("stale")).toBeNull();
    // The agent's time is its session's last prompt, not its start or the agent's output.
    expect(within(row("Desktop design doc")).getByText("3m ago")).toBeInTheDocument();
  });

  it("marks rows per status", async () => {
    await renderSidebar("/agents/ready");
    baseline(
      [
        makeAgent({ id: "ready", sessionName: "Ready one", attention: "finished" }),
        makeAgent({ id: "idle", sessionName: "Idle one" }),
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
        makeAgent({ id: "closed", sessionName: "Closed one", status: "exited", sessionFile: "fc" }),
      ],
      [session({ file: "free", name: "Disk one" })],
    );
    await within(nav()).findByText("Ready one");
    const mark = (name: string) =>
      within(row(name))
        .queryAllByRole("img")
        .map((img) => img.getAttribute("aria-label"));
    // One mark per row: the status.
    expect(mark("Ready one")).toEqual(["Finished"]);
    expect(mark("Idle one")).toEqual(["Idle"]);
    expect(mark("Trust one")).toEqual(["Needs input"]);
    expect(mark("Streaming one")).toEqual(["Needs input"]);
    expect(mark("Starting one")).toEqual(["Working"]);
    expect(mark("Exited one")).toEqual(["Failed"]);
    expect(mark("Closed one")).toEqual([]);
    expect(mark("Disk one")).toEqual([]);
    const working = within(row("Starting one")).getByRole("img", { name: "Working" });
    expect(working.querySelector("svg")).toHaveClass("animate-spin");
    const dots: Array<[string, string, string]> = [
      ["Ready one", "Finished", "bg-status-done"],
      ["Idle one", "Idle", "bg-status-idle"],
      ["Trust one", "Needs input", "bg-status-input"],
      ["Exited one", "Failed", "bg-status-error"],
    ];
    for (const [name, label, color] of dots) {
      const dot = within(row(name)).getByRole("img", { name: label });
      expect(dot).toHaveAttribute("title", label);
      expect(dot).toHaveClass("rounded-full", color);
      expect(within(row(name)).queryByText(label)).toBeNull();
    }
    // × on every row: live ones ask Stop or Delete, the others delete.
    expect(
      within(row("Ready one")).getByRole("button", { name: "Stop or delete Ready one (project)" }),
    ).toBeInTheDocument();
    expect(
      within(row("Starting one")).getByRole("button", { name: /^Stop or delete/ }),
    ).toBeInTheDocument();
    expect(
      within(row("Exited one")).getByRole("button", { name: "Delete Exited one (project)" }),
    ).toBeInTheDocument();
    expect(
      within(row("Disk one")).getByRole("button", { name: "Delete Disk one (project)" }),
    ).toBeInTheDocument();
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
    await userEvent.setup().click(await within(nav()).findByRole("button", { name: /^Disk one/ }));
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
    await userEvent
      .setup()
      .click(await within(nav()).findByRole("button", { name: /^Exited one/ }));
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
    await userEvent
      .setup()
      .click(await within(nav()).findByRole("button", { name: /^Exited one/ }));
    expect(await screen.findByText("Restart broke")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("ends every row with its ×", async () => {
    await renderSidebar();
    baseline(
      [makeAgent({ id: "a1", sessionName: "Live one" })],
      [session({ file: "free", name: "Disk one" })],
    );
    await within(nav()).findByText("Disk one");
    const lastChild = (name: string) => row(name).lastElementChild as HTMLElement;
    expect(lastChild("Live one")).toHaveAccessibleName("Stop or delete Live one (project)");
    expect(lastChild("Disk one")).toHaveAccessibleName("Delete Disk one (project)");
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

  const deletes = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === "DELETE").map((c) => ({ url: c.url, body: c.body }));

  it("asks Stop or Delete on a live row; Cancel does nothing", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Live one", sessionFile: "/s/a1.jsonl" })]);
    const user = userEvent.setup();
    const button = await within(nav()).findByRole("button", {
      name: "Stop or delete Live one (project)",
    });

    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Live one?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)).toEqual([]);

    await user.click(button);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/a1.jsonl" } }]),
    );
  });

  it("Stop on the conversation on screen: DELETE /api/agents/:id, then Home", async () => {
    const { router, calls } = await renderSidebar("/agents/a1", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Live one", sessionFile: "/s/a1.jsonl" })]);
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "Stop or delete Live one (project)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Live one?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(deletes(calls)).toEqual([{ url: "/api/agents/a1", body: undefined }]);
  });

  it("Delete on the conversation on screen goes Home", async () => {
    const { router, calls } = await renderSidebar("/agents/a1", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Live one", sessionFile: "/s/a1.jsonl" })]);
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "Stop or delete Live one (project)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Live one?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/a1.jsonl" } }]);
  });

  it("Stop and Delete on a conversation not on screen stay put and drop its store", async () => {
    const drop = vi.spyOn(LiveRegistry.prototype, "drop");
    const { router, calls } = await renderSidebar("/agents/a2", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([
      makeAgent({ id: "a1", sessionName: "Live one", sessionFile: "/s/a1.jsonl" }),
      makeAgent({ id: "a2", sessionName: "Shown one", sessionFile: "/s/a2.jsonl" }),
      makeAgent({ id: "a3", sessionName: "Third one", sessionFile: "/s/a3.jsonl" }),
    ]);
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "Stop or delete Live one (project)" }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Stop or delete Live one?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(drop).toHaveBeenCalledWith("a1"));

    await user.click(
      within(nav()).getByRole("button", { name: "Stop or delete Third one (project)" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Stop or delete Third one?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(drop).toHaveBeenCalledWith("a3"));
    expect(deletes(calls)).toEqual([
      { url: "/api/agents/a1", body: undefined },
      { url: "/api/sessions", body: { file: "/s/a3.jsonl" } },
    ]);
    expect(router.state.location.pathname).toBe("/agents/a2");
    expect(drop).not.toHaveBeenCalledWith("a2");
    drop.mockRestore();
  });

  it("Delete takes the session file the agent has when it's chosen", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Live one", sessionFile: "/s/old.jsonl" })]);
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "Stop or delete Live one (project)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Live one?" });
    sendFrame({
      type: "agent",
      agent: makeAgent({ id: "a1", sessionName: "Live one", sessionFile: "/s/new.jsonl" }),
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/new.jsonl" } }]),
    );
  });

  it("Delete on a live agent with no session file yet only stops it", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline([makeAgent({ id: "a1", sessionName: "Fresh one" })]);
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "Stop or delete Fresh one (project)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Fresh one?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/agents/a1", body: undefined }]),
    );
  });

  it("deletes exited and session rows at once", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    baseline(
      [
        makeAgent({
          id: "x1",
          sessionName: "Exited one",
          status: "exited",
          sessionFile: "/s/x1.jsonl",
        }),
      ],
      [session({ file: "/s/free.jsonl", name: "Disk one" })],
    );
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "Delete Exited one (project)" }),
    );
    await user.click(within(nav()).getByRole("button", { name: "Delete Disk one (project)" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([
        { url: "/api/sessions", body: { file: "/s/x1.jsonl" } },
        { url: "/api/sessions", body: { file: "/s/free.jsonl" } },
      ]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toasts a failed delete and stays put", async () => {
    const { router } = await renderSidebar("/settings", (call) =>
      call.method === "DELETE"
        ? [400, { error: { code: "session_not_listed", message: "Not a listed session" } }]
        : undefined,
    );
    baseline([], [session({ file: "/s/free.jsonl", name: "Disk one" })]);
    await userEvent
      .setup()
      .click(await within(nav()).findByRole("button", { name: "Delete Disk one (project)" }));
    expect(await screen.findByText("Not a listed session")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("sends one DELETE however often × is clicked while it's in flight; other rows stay usable", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.method === "DELETE" ? [204, null] : undefined,
    );
    const held = holdFetch((_input, init) => init?.method === "DELETE");
    baseline(
      [],
      [
        session({ file: "/s/a.jsonl", name: "Disk one" }),
        session({ file: "/s/b.jsonl", name: "Disk two" }),
      ],
    );
    const button = await within(nav()).findByRole("button", { name: "Delete Disk one (project)" });
    const user = userEvent.setup();
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(held).toHaveLength(1);
    expect(within(nav()).getByRole("button", { name: "Delete Disk two (project)" })).toBeEnabled();
    held[0]?.();
    await waitFor(() => expect(button).toBeEnabled());
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
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

describe("Sidebar with layout repos", () => {
  const R = "/home/me/Dev/pi-code";
  const layout = (role: RepoLayout["role"], missing = false): RepoLayout => ({
    repo: R,
    role,
    ...(missing ? { missing: true as const } : {}),
  });

  /** A layout repo with every kind of folder, plus a plain clone. */
  function layoutBaseline(sidebar?: SidebarState) {
    baseline(
      [
        makeAgent({
          id: "main-agent",
          cwd: `${R}/main`,
          sessionName: "Release checklist",
          sessionFile: "mf",
          layout: layout("main"),
        }),
        // A fresh worktree: no session file yet, so no prompt.
        makeAgent({
          id: "fresh-agent",
          cwd: `${R}/fresh`,
          startedAt: recent(1),
          layout: layout("worktree"),
        }),
        makeAgent({
          id: "gone-live",
          cwd: `${R}/old-spike`,
          sessionName: "Still running",
          sessionFile: "gl",
          isStreaming: true,
          layout: layout("worktree"),
        }),
        makeAgent({
          id: "gone-exited",
          cwd: `${R}/old-spike`,
          sessionName: "Exited there",
          status: "exited",
          attention: "failed",
          startedAt: recent(60 * 24 * 4),
          layout: layout("worktree"),
        }),
      ],
      [
        session({
          file: "mf",
          cwd: `${R}/main`,
          lastPromptAt: recent(5),
          layout: layout("main"),
        }),
        session({
          file: "c1",
          cwd: R,
          name: "Notes on the layout",
          lastPromptAt: recent(60 * 24),
          layout: layout("container"),
        }),
        session({
          file: "w1",
          cwd: `${R}/worktree-support`,
          name: "Design worktrees",
          lastPromptAt: recent(120),
          layout: layout("worktree"),
        }),
        session({
          file: "gl",
          cwd: `${R}/old-spike`,
          // A minute after "Try the thing", so the order doesn't hang on a millisecond.
          lastPromptAt: recent(60 * 24 * 3 - 1),
          layout: layout("worktree", true),
        }),
        session({
          file: "m1",
          cwd: `${R}/old-spike`,
          name: "Try the thing",
          lastPromptAt: recent(60 * 24 * 3),
          layout: layout("worktree", true),
        }),
        session({
          file: "d1",
          cwd: "/home/me/dotfiles",
          name: "Dotfiles",
          lastPromptAt: recent(60 * 24 * 5),
        }),
      ],
      { [`${R}/main`]: "main", [`${R}/worktree-support`]: "wt", [`${R}/fresh`]: "fresh" },
      sidebar,
    );
  }

  const groupName = (group: HTMLElement) =>
    document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent;
  const repo = () => within(nav()).getByRole("group", { name: "pi-code" });
  const worktree = (name: string) => within(repo()).getByRole("group", { name });
  /** Rows directly in `group`, not in a group nested in it. */
  const ownTitles = (group: HTMLElement) =>
    within(group)
      .getAllByTestId("sidebar-row")
      .filter((li) => li.closest("[role=group]") === group)
      .map((li) => within(li).getByTestId("sidebar-row-title").textContent);

  it("nests checkouts in the repo group, the container's rows under its header", async () => {
    await renderSidebar();
    layoutBaseline();
    await within(nav()).findByText("Release checklist");
    const topLevel = within(nav())
      .getAllByRole("group")
      .filter((g) => g.parentElement?.closest("[role=group]") === null);
    expect(topLevel.map(groupName)).toEqual(["pi-code", "dotfiles"]);
    // The worktree without a prompt yet comes last.
    expect(within(repo()).getAllByRole("group").map(groupName)).toEqual([
      "main",
      "worktree-support",
      "old-spike",
      "fresh",
    ]);
    expect(ownTitles(repo())).toEqual(["Notes on the layout"]);
    // The agent with no session yet is placed by its own layout.
    expect(ownTitles(worktree("fresh"))).toEqual(["New conversation"]);
    expect(ownTitles(worktree("old-spike"))).toEqual([
      "Still running",
      "Try the thing",
      "Exited there",
    ]);
    // Branches show on checkouts with a live agent.
    expect(within(worktree("main")).getByTitle("Branch")).toHaveTextContent("main");
    expect(within(worktree("fresh")).getByTitle("Branch")).toHaveTextContent("fresh");
    expect(within(worktree("worktree-support")).queryByTitle("Branch")).toBeNull();
  });

  it("offers per-role header actions", async () => {
    await renderSidebar();
    layoutBaseline();
    await within(nav()).findByText("Release checklist");
    const buttons = (group: HTMLElement) =>
      within(group)
        .getAllByRole("button")
        .filter((b) => b.closest("[role=group]") === group && b.closest("li") === null)
        .map((b) => b.getAttribute("aria-label"));
    // The collapse toggle (the header's title) first, unlabelled: it reads as the title.
    expect(buttons(repo())).toEqual([
      null,
      "Pin pi-code",
      "New worktree in pi-code",
      "New conversation in pi-code",
    ]);
    expect(buttons(worktree("main"))).toEqual(["New conversation in pi-code/main"]);
    expect(buttons(worktree("worktree-support"))).toEqual([
      null,
      "New conversation in pi-code/worktree-support",
      "Remove worktree pi-code/worktree-support",
    ]);
    expect(buttons(worktree("old-spike"))).toEqual(["Remove worktree pi-code/old-spike"]);
    expect(within(worktree("old-spike")).getByText("missing")).toBeInTheDocument();
    const dotfiles = within(nav()).getByRole("group", { name: "dotfiles" });
    expect(buttons(dotfiles)).toEqual([null, "New conversation in dotfiles"]);
  });

  it("disables session rows and exited agents in a missing worktree, not live agents", async () => {
    await renderSidebar();
    layoutBaseline();
    await within(nav()).findByText("Try the thing");
    expect(
      within(row("Try the thing")).getByRole("button", { name: /^Try the thing/ }),
    ).toBeDisabled();
    expect(
      // Its Failed mark leads the name.
      within(row("Exited there")).getByRole("button", { name: /^Failed\s*Exited there/ }),
    ).toBeDisabled();
    // Their × still deletes.
    expect(
      within(row("Try the thing")).getByRole("button", {
        name: "Delete Try the thing (pi-code/old-spike)",
      }),
    ).toBeEnabled();
    expect(
      within(row("Exited there")).getByRole("button", {
        name: "Delete Exited there (pi-code/old-spike)",
      }),
    ).toBeEnabled();
    expect(within(row("Still running")).getByRole("link")).toHaveAttribute(
      "href",
      "/agents/gone-live",
    );
    expect(
      within(row("Design worktrees")).getByRole("button", { name: /^Design worktrees/ }),
    ).toBeEnabled();
  });

  it("starts conversations in the container from the repo's + and in a checkout from its own", async () => {
    let n = 0;
    const { router, calls } = await renderSidebar("/", (call) =>
      call.url === "/api/agents" && call.method === "POST"
        ? [201, { agent: makeAgent({ id: `n${++n}`, status: "starting" }) }]
        : undefined,
    );
    layoutBaseline();
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", { name: "New conversation in pi-code" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n1"));
    await user.click(
      within(nav()).getByRole("button", { name: "New conversation in pi-code/main" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n2"));
    expect(
      calls.filter((c) => c.method === "POST" && c.url === "/api/agents").map((c) => c.body),
    ).toEqual([{ cwd: R }, { cwd: `${R}/main` }]);
  });

  it("creates a worktree from the repo header and navigates to its conversation", async () => {
    const { calls } = stubFetch((call) =>
      call.url === "/api/worktrees" && call.method === "POST"
        ? [201, { agent: makeAgent({ id: "w1", status: "starting", cwd: `${R}/qa-wt` }) }]
        : call.url === "/api/sessions"
          ? [200, { sessions: [] }]
          : undefined,
    );
    // The sidebar alone, to see `onSelect`.
    const onSelect = vi.fn();
    const rootRoute = createRootRoute({
      component: () => (
        <WorktreeActionsProvider>
          <StopOrDeleteProvider>
            <Sidebar onSelect={onSelect} />
          </StopOrDeleteProvider>
        </WorktreeActionsProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<App router={router as never} queryClient={createQueryClient()} />);
    await screen.findByRole("navigation", { name: "Conversations" });
    layoutBaseline();
    const user = userEvent.setup();
    await user.click(await within(nav()).findByRole("button", { name: "New worktree in pi-code" }));
    const sheet = await screen.findByTestId("new-worktree-sheet");
    expect(onSelect).not.toHaveBeenCalled();
    await user.type(within(sheet).getByLabelText("Name"), "qa-wt{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/w1"));
    expect(onSelect).toHaveBeenCalled();
    expect(calls.find((c) => c.url === "/api/worktrees")?.body).toEqual({
      repo: R,
      name: "qa-wt",
    });
  });

  it("removes a worktree from its header after confirming", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.url === "/api/worktrees" && call.method === "DELETE" ? [204, null] : undefined,
    );
    layoutBaseline();
    const user = userEvent.setup();
    await user.click(
      await within(nav()).findByRole("button", {
        name: "Remove worktree pi-code/worktree-support",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Remove worktree-support?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({
        path: `${R}/worktree-support`,
      }),
    );
  });

  it("groups search results the same way", async () => {
    await renderSidebar("/", (call) =>
      call.url === "/api/sessions" && call.search !== ""
        ? [
            200,
            {
              sessions: [
                session({
                  file: "found",
                  cwd: `${R}/worktree-support`,
                  name: "Old worktree talk",
                  layout: layout("worktree"),
                }),
              ],
            },
          ]
        : undefined,
    );
    baseline([]);
    await within(nav()).findByText("No conversations yet.");
    await userEvent.setup().type(within(nav()).getByRole("searchbox"), "worktree");
    expect(await within(nav()).findByText("Old worktree talk")).toBeInTheDocument();
    expect(ownTitles(worktree("worktree-support"))).toEqual(["Old worktree talk"]);
  });

  /** The group's collapse toggle: the button on its own header with `aria-expanded`. */
  const toggle = (group: HTMLElement) =>
    within(group)
      .queryAllByRole("button")
      .find((b) => b.closest("[role=group]") === group && b.hasAttribute("aria-expanded"));
  const patches = (calls: FetchCall[]) =>
    calls.filter((c) => c.url === "/api/sidebar").map((c) => c.body);
  const topLevelNames = () =>
    within(nav())
      .getAllByRole("group")
      .filter((g) => g.parentElement?.closest("[role=group]") === null)
      .map(groupName);

  it("collapses repo, folder and worktree groups from their headers, not from their actions", async () => {
    const { calls } = await renderSidebar();
    layoutBaseline();
    await within(nav()).findByText("Design worktrees");
    const user = userEvent.setup();
    expect(toggle(worktree("main"))).toBeUndefined();
    expect(toggle(worktree("old-spike"))).toBeUndefined();

    await user.click(within(repo()).getByRole("button", { name: "Pin pi-code" }));
    expect(toggle(repo())).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle(worktree("worktree-support")) as HTMLElement);
    await waitFor(() =>
      expect(toggle(worktree("worktree-support"))).toHaveAttribute("aria-expanded", "false"),
    );
    expect(within(nav()).queryByText("Design worktrees")).toBeNull();
    await user.click(toggle(worktree("worktree-support")) as HTMLElement);
    expect(await within(nav()).findByText("Design worktrees")).toBeInTheDocument();

    const dotfiles = within(nav()).getByRole("group", { name: "dotfiles" });
    await user.click(toggle(dotfiles) as HTMLElement);
    await waitFor(() => expect(within(nav()).queryByText("Dotfiles")).toBeNull());
    await user.click(toggle(repo()) as HTMLElement);
    await waitFor(() => expect(within(repo()).queryAllByRole("group")).toEqual([]));
    expect(patches(calls)).toEqual([
      { pinned: { [R]: true } },
      { collapsed: { [`${R}/worktree-support`]: true } },
      { collapsed: { [`${R}/worktree-support`]: false } },
      { collapsed: { "/home/me/dotfiles": true } },
      { collapsed: { [R]: true } },
    ]);
  });

  it("follows the sidebar state other clients set", async () => {
    await renderSidebar();
    layoutBaseline();
    await within(nav()).findByText("Dotfiles");
    sendFrame({ type: "sidebar", sidebar: { pinned: [], collapsed: ["/home/me/dotfiles"] } });
    expect(within(nav()).queryByText("Dotfiles")).toBeNull();
  });

  it("offers no collapse toggle on a folder that is gone", async () => {
    await renderSidebar();
    baseline(
      [makeAgent({ id: "gone-agent", cwd: "/home/me/gone", sessionFile: "g1" })],
      [
        session({ file: "g1", cwd: "/home/me/gone", name: "Held", missing: true }),
        session({ file: "g2", cwd: "/home/me/gone", name: "Gone folder", missing: true }),
        session({ file: "d1", cwd: "/home/me/dotfiles", name: "Dotfiles" }),
      ],
    );
    await within(nav()).findByText("Gone folder");
    expect(toggle(within(nav()).getByRole("group", { name: "gone" }))).toBeUndefined();
    expect(toggle(within(nav()).getByRole("group", { name: "dotfiles" }))).toBeDefined();
  });

  it("shows the hidden rows' spinner and most urgent attention on a collapsed header", async () => {
    await renderSidebar();
    layoutBaseline({ pinned: [], collapsed: [R, "/home/me/dotfiles"] });
    await within(nav()).findByRole("group", { name: "pi-code" });
    const marks = (group: HTMLElement) =>
      within(group)
        .queryAllByRole("img")
        .map((img) => img.getAttribute("aria-label"));
    expect(within(nav()).queryByText("Release checklist")).toBeNull();
    // "Still running" streams in old-spike; "Exited there" failed.
    expect(marks(repo())).toEqual(["Working", "Failed"]);
    expect(within(repo()).getByRole("img", { name: "Failed" })).toHaveClass(
      "rounded-full",
      "bg-status-error",
    );
    expect(marks(within(nav()).getByRole("group", { name: "dotfiles" }))).toEqual([]);
  });

  it("shows collapsed groups open, not collapsible, while searching, leaving the state as it was", async () => {
    const { calls } = await renderSidebar("/", (call) =>
      call.url === "/api/sessions" && call.search !== ""
        ? [
            200,
            {
              sessions: [
                session({
                  file: "w1",
                  cwd: `${R}/worktree-support`,
                  name: "Design worktrees",
                  layout: layout("worktree"),
                }),
              ],
            },
          ]
        : undefined,
    );
    layoutBaseline({ pinned: [], collapsed: [R, `${R}/worktree-support`] });
    await within(nav()).findByRole("group", { name: "pi-code" });
    expect(within(nav()).queryByText("Design worktrees")).toBeNull();
    const user = userEvent.setup();
    await user.type(within(nav()).getByRole("searchbox"), "design");
    expect(await within(nav()).findByText("Design worktrees")).toBeInTheDocument();
    expect(toggle(repo())).toBeUndefined();
    await user.clear(within(nav()).getByRole("searchbox"));
    expect(within(nav()).queryByText("Design worktrees")).toBeNull();
    expect(patches(calls)).toEqual([]);
  });

  it("uncollapses the groups of the conversation it opens", async () => {
    const { calls } = await renderSidebar("/agents/main-agent");
    layoutBaseline({ pinned: [], collapsed: [R, "/home/me/dotfiles"] });
    expect(await within(nav()).findByText("Release checklist")).toBeInTheDocument();
    expect(patches(calls)).toEqual([{ collapsed: { [R]: false } }]);
    expect(within(nav()).queryByText("Dotfiles")).toBeNull();
    // Collapsing it again while it's open sticks.
    await userEvent.setup().click(toggle(repo()) as HTMLElement);
    await waitFor(() => expect(within(nav()).queryByText("Release checklist")).toBeNull());
  });

  it("uncollapses the plain folder of the conversation it opens", async () => {
    const { calls } = await renderSidebar("/agents/dot-agent");
    const dotfiles = "/home/me/dotfiles";
    baseline(
      [makeAgent({ id: "dot-agent", cwd: dotfiles, sessionName: "Dotfiles", sessionFile: "d1" })],
      [session({ file: "d1", cwd: dotfiles, lastPromptAt: recent(5) })],
      {},
      { pinned: [], collapsed: [dotfiles] },
    );
    expect(await within(nav()).findByText("Dotfiles")).toBeInTheDocument();
    expect(patches(calls)).toEqual([{ collapsed: { [dotfiles]: false } }]);
  });

  it.each([
    ["its own layout", layout("worktree")],
    ["its session's layout", undefined],
  ])("uncollapses a linked worktree and its repo, the repo taken from %s", async (_, own) => {
    const { calls } = await renderSidebar("/agents/wt-agent");
    const wt = `${R}/worktree-support`;
    baseline(
      [
        makeAgent({
          id: "wt-agent",
          cwd: wt,
          sessionName: "Design worktrees",
          sessionFile: "w1",
          ...(own ? { layout: own } : {}),
        }),
      ],
      [session({ file: "w1", cwd: wt, lastPromptAt: recent(5), layout: layout("worktree") })],
      {},
      { pinned: [], collapsed: [R, wt] },
    );
    expect(await within(nav()).findByText("Design worktrees")).toBeInTheDocument();
    expect(patches(calls)).toEqual([{ collapsed: { [wt]: false, [R]: false } }]);
  });

  it("lists pinned repos first by label, empty ones with their header actions", async () => {
    const { calls } = await renderSidebar();
    const empty = "/home/me/Dev/empty-repo";
    baseline(
      [],
      [
        session({ file: "a", cwd: "/home/me/alpha", name: "Alpha", lastPromptAt: recent(1) }),
        session({
          file: "m",
          cwd: `${R}/main`,
          name: "Main talk",
          lastPromptAt: recent(60),
          layout: layout("main"),
        }),
      ],
      {},
      { pinned: [empty], collapsed: [] },
    );
    await within(nav()).findByText("Main talk");
    expect(topLevelNames()).toEqual(["empty-repo", "alpha", "pi-code"]);
    const emptyGroup = within(nav()).getByRole("group", { name: "empty-repo" });
    expect(within(emptyGroup).getByRole("button", { name: "Pin empty-repo" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(emptyGroup).getByRole("button", { name: "New worktree in empty-repo" }),
    ).toBeInTheDocument();
    expect(
      within(emptyGroup).getByRole("button", { name: "New conversation in empty-repo" }),
    ).toBeInTheDocument();

    const pin = within(repo()).getByRole("button", { name: "Pin pi-code" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(pin);
    await waitFor(() => expect(topLevelNames()).toEqual(["empty-repo", "pi-code", "alpha"]));
    expect(within(repo()).getByRole("button", { name: "Pin pi-code" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(patches(calls)).toEqual([{ pinned: { [R]: true } }]);
  });

  it("puts a pin back and toasts when the server refuses", async () => {
    await renderSidebar("/", (call) =>
      call.url === "/api/sidebar"
        ? [500, { error: { code: "internal", message: "Disk full" } }]
        : undefined,
    );
    layoutBaseline();
    await within(nav()).findByText("Release checklist");
    await userEvent.setup().click(within(repo()).getByRole("button", { name: "Pin pi-code" }));
    expect(await screen.findByText("Disk full")).toBeInTheDocument();
    expect(within(repo()).getByRole("button", { name: "Pin pi-code" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
