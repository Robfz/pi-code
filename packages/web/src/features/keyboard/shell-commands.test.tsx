import type { AgentInfo, ProjectSummary } from "@pi-code/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";
import { stubUserAgent, USER_AGENTS } from "@/test/user-agents";
import { APP_QUERY } from "./keymap";

// Active order: prompted first by last prompt, then the rest newest started first.
const alpha = makeAgent({
  id: "a1",
  cwd: "/home/me/alpha",
  sessionName: "Alpha work",
  sessionFile: "/s/alpha.jsonl",
  startedAt: "2026-01-01T08:00:00.000Z",
});
const beta = makeAgent({
  id: "a2",
  cwd: "/home/me/beta",
  sessionName: "Beta work",
  startedAt: "2026-01-01T12:00:00.000Z",
});
const gamma = makeAgent({
  id: "a3",
  cwd: "/home/me/gamma",
  sessionName: "Gamma work",
  startedAt: "2026-01-01T09:00:00.000Z",
});
const exited = makeAgent({
  id: "a4",
  cwd: "/home/me/delta",
  sessionName: "Delta work",
  status: "exited",
  startedAt: "2026-01-01T13:00:00.000Z",
});
const everyAgent = [alpha, beta, gamma, exited];

const repoProject: ProjectSummary = {
  cwd: "/home/me/repo/main",
  sessionCount: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  isGitRepo: true,
  layout: { repo: "/home/me/repo", role: "main", main: "/home/me/repo/main" },
};

function renderApp(path: string, { desktop = true }: { desktop?: boolean } = {}) {
  stubMatchMedia((query) => (desktop && query === DESKTOP_QUERY) || app(query));
  stubFetch((call) => {
    const match = /^\/api\/agents\/(a\d)\/snapshot$/.exec(call.url);
    const agent = everyAgent.find((a) => a.id === match?.[1]);
    if (agent) return [200, makeSnapshot({ agent })];
    if (/^\/api\/agents\/a\d\/git\/diff$/.test(call.url)) return [200, { files: [] }];
    if (call.url === "/api/projects") return [200, { projects: [repoProject] }];
    if (call.url === "/api/fs/dirs") return [200, { dirs: [] }];
    if (call.url === "/api/sessions") return [200, { sessions: [] }];
    return undefined;
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

let app = (_query: string) => false;

function baseline(agents: AgentInfo[] = everyAgent) {
  sendFrame({
    type: "baseline",
    agents,
    sessions: [
      {
        file: "/s/alpha.jsonl",
        id: "alpha",
        cwd: alpha.cwd,
        createdAt: "2026-01-01T08:00:00.000Z",
        lastPromptAt: "2026-01-01T10:00:00.000Z",
      },
    ],
    branches: {},
    sidebar: { pinned: [], collapsed: [], mains: {} },
  });
}

const press = (init: KeyboardEventInit) =>
  fireEvent.keyDown(document.activeElement ?? document.body, init);
const leader = (key: string, code = `Key${key.toUpperCase()}`) => {
  press({ key: "j", code: "KeyJ", metaKey: true });
  press({ key, code });
};
const digit = (n: number) => leader(String(n), `Digit${n}`);

async function at(router: ReturnType<typeof renderApp>, pathname: string) {
  await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
}

beforeEach(() => {
  stubUserAgent(USER_AGENTS.macChrome);
  app = () => false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("go to conversation", () => {
  it("opens the Active row at a position; an empty one does nothing", async () => {
    const router = renderApp("/");
    await screen.findByRole("navigation", { name: "Conversations" });
    baseline();
    digit(2);
    await at(router, "/agents/a2");
    digit(1);
    await at(router, "/agents/a1");
    digit(3);
    await at(router, "/agents/a3");
    digit(4);
    expect(router.history.location.pathname).toBe("/agents/a3");
  });

  it("takes ⌘1–9 directly in the Chrome app window", async () => {
    app = (query) => query === APP_QUERY;
    const router = renderApp("/");
    await screen.findByRole("navigation", { name: "Conversations" });
    baseline();
    press({ key: "3", code: "Digit3", metaKey: true });
    await at(router, "/agents/a3");
  });

  it("ignores the sidebar search", async () => {
    const router = renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Conversations" });
    baseline();
    const user = userEvent.setup();
    await user.type(within(nav).getByRole("searchbox", { name: "Search conversations" }), "Gamma");
    await waitFor(() =>
      expect(
        within(within(nav).getByRole("group", { name: "Active" })).getAllByRole("link"),
      ).toHaveLength(1),
    );
    digit(1);
    await at(router, "/agents/a1");
  });
});

describe("previous and next", () => {
  it("step through the Active list, wrapping at both ends", async () => {
    const router = renderApp("/agents/a3");
    await screen.findByRole("heading", { name: "Gamma work" });
    baseline();
    leader("n");
    await at(router, "/agents/a1");
    leader("n");
    await at(router, "/agents/a2");
    leader("p");
    await at(router, "/agents/a1");
    leader("p");
    await at(router, "/agents/a3");
  });

  it.each(["tree", "diff"])("step from the %s route's conversation", async (page) => {
    // At phone sizes, where the route has a page rather than opening the desktop review pane.
    const router = renderApp(`/agents/a2/${page}`, { desktop: false });
    await screen.findByRole("link", { name: "Back to conversation" });
    expect(router.state.location.pathname).toBe(`/agents/a2/${page}`);
    baseline();
    leader("n");
    await at(router, "/agents/a3");
  });

  it.each([
    ["Home", "/"],
    ["Settings", "/settings"],
    ["an exited conversation", "/agents/a4"],
  ])("step in from %s: next opens the first row, previous the last", async (_, path) => {
    const router = renderApp(path);
    await screen.findByRole("navigation", { name: "Conversations" });
    baseline();
    leader("n");
    await at(router, "/agents/a1");
    await router.navigate({ to: path });
    leader("p");
    await at(router, "/agents/a3");
  });

  it("do nothing with no live agent", async () => {
    const router = renderApp("/settings");
    await screen.findByRole("navigation", { name: "Conversations" });
    baseline([exited]);
    leader("n");
    leader("p");
    digit(1);
    // With no blocker, a navigation reaches the history synchronously; the router state lags.
    expect(router.history.location.pathname).toBe("/settings");
  });
});

describe("new conversation", () => {
  it("opens the project picker in place with the sidebar closed", async () => {
    const router = renderApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(screen.queryByRole("navigation", { name: "Conversations" })).toBeNull();
    leader("c");
    const picker = await screen.findByTestId("project-picker");
    // Every repo project's group has New worktree, which needs the worktree provider.
    expect(
      await within(picker).findByRole("button", { name: "New worktree in repo" }),
    ).toBeInTheDocument();
    press({ key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("project-picker")).toBeNull());
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("opens the project picker at phone sizes", async () => {
    renderApp("/settings", { desktop: false });
    await screen.findByRole("heading", { name: "Settings" });
    leader("c");
    expect(await screen.findByTestId("project-picker")).toBeInTheDocument();
  });
});
