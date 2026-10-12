import type { RepoLayout, SessionSummary } from "@pi-code/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopOrDeleteProvider } from "@/features/sessions/stop-or-delete";
import { WorktreeActionsProvider } from "@/features/worktrees/worktree-actions";
import { createQueryClient } from "@/lib/query-client";
import { HomeScreen } from "@/routes/home";
import { LiveRegistryProvider } from "@/store/context";
import { type LiveOverview, LiveRegistry } from "@/store/live-registry";
import { makeAgent } from "@/test/fixtures";
import { type FetchCall, stubFetch } from "@/test/render";
import { ProjectPicker } from "./project-picker";
import { SessionsScreen } from "./sessions-screen";

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(patch: Partial<SessionSummary> & { file: string }): SessionSummary {
  return {
    id: patch.file,
    cwd: "/home/me/alpha",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    lastPromptAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...patch,
  };
}

/**
 * Routes: `/` → `ui`, `/sessions` → SessionsScreen, anything else → empty; `live` seeds the live
 * registry (never started).
 */
async function renderRoutes(ui: React.ReactNode, path = "/", live: Partial<LiveOverview> = {}) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const registry = new LiveRegistry(queryClient);
  registry.live.setState(live);
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <LiveRegistryProvider registry={registry}>
          <WorktreeActionsProvider>
            <StopOrDeleteProvider>
              <Outlet />
            </StopOrDeleteProvider>
          </WorktreeActionsProvider>
        </LiveRegistryProvider>
      </QueryClientProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => ui });
  const sessions = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
    validateSearch: (search: Record<string, unknown>): { cwd?: string } =>
      typeof search.cwd === "string" ? { cwd: search.cwd } : {},
    component: function Sessions() {
      const { cwd } = sessions.useSearch();
      return <SessionsScreen {...(cwd ? { cwd } : {})} />;
    },
  });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => <p>elsewhere</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, sessions, catchAll]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(<RouterProvider router={router as never} />);
  return router;
}

describe("ProjectPicker", () => {
  function catalogHandler() {
    return (call: FetchCall): [number, unknown] | undefined => {
      if (call.url === "/api/projects") {
        return [
          200,
          {
            projects: [
              {
                cwd: "/home/me/alpha",
                sessionCount: 3,
                createdAt: "2026-01-01T00:00:00.000Z",
                isGitRepo: true,
              },
            ],
          },
        ];
      }
      if (call.url === "/api/agents" && call.method === "POST") {
        return [201, { agent: makeAgent({ id: "n1", status: "starting" }) }];
      }
      return undefined;
    };
  }

  /** Records the `prefix` of each `/api/fs/dirs` call and answers with its children. */
  function stubCatalog() {
    const prefixes: string[] = [];
    const fetchStub = stubFetch(catalogHandler());
    const inner = fetchStub.fetchMock.getMockImplementation();
    fetchStub.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.pathname === "/api/fs/dirs") {
        const prefix = url.searchParams.get("prefix") ?? "";
        prefixes.push(prefix);
        const dirs =
          prefix === "~/co"
            ? [
                { path: "/home/me/code", isGitRepo: false, hasSessions: false },
                { path: "/home/me/courses", isGitRepo: false, hasSessions: true },
              ]
            : prefix === "/home/me/code/"
              ? [{ path: "/home/me/code/pi-code", isGitRepo: true, hasSessions: true }]
              : prefix === "~/work"
                ? [{ path: "/home/me/work", isGitRepo: false, hasSessions: false }]
                : [{ path: "/home/me/docs", isGitRepo: false, hasSessions: false }];
        return new Response(JSON.stringify({ dirs }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return (inner as NonNullable<typeof inner>)(input, init);
    });
    return { ...fetchStub, prefixes };
  }

  it("lists recent projects and starts a conversation in one", async () => {
    const { calls } = stubCatalog();
    const router = await renderRoutes(<ProjectPicker open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    const recent = await screen.findByRole("list", { name: "Recent projects" });
    await user.click(within(recent).getByRole("button", { name: /alpha/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n1"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd: "/home/me/alpha" });
  });

  it("debounces the path autocomplete and drills into a suggestion", async () => {
    const { prefixes, calls } = stubCatalog();
    const router = await renderRoutes(<ProjectPicker open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    // Empty field: home directory suggestions.
    await waitFor(() => expect(prefixes).toEqual(["~/"]));
    await user.type(screen.getByLabelText("Folder path"), "~/co");
    const suggestions = await screen.findByRole("list", { name: "Folder suggestions" });
    await within(suggestions).findByText("courses");
    // One request for the settled value, none for the intermediate keystrokes.
    expect(prefixes).toEqual(["~/", "~/co"]);
    expect(within(suggestions).getByText("sessions")).toBeInTheDocument();

    await user.click(within(suggestions).getByRole("button", { name: /^code/ }));
    expect(screen.getByLabelText("Folder path")).toHaveValue("/home/me/code/");
    await screen.findByText("pi-code");
    expect(prefixes.at(-1)).toBe("/home/me/code/");

    await user.click(screen.getByRole("button", { name: "Start in pi-code" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n1"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      cwd: "/home/me/code/pi-code",
    });
  });

  it("resolves a typed ~ path to an absolute cwd before opening", async () => {
    const { calls } = stubCatalog();
    await renderRoutes(<ProjectPicker open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Folder path"), "~/work");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd: "/home/me/work" }),
    );
  });
});

describe("Sessions", () => {
  it("home shows open agents with their status and the 10 most recent sessions", async () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session({ file: `/s/${i}.jsonl`, firstMessage: `message ${i}` }),
    );
    const { calls } = stubFetch((call) =>
      call.url === "/api/sessions" ? [200, { sessions }] : undefined,
    );
    await renderRoutes(<HomeScreen />, "/", {
      loaded: true,
      agents: { a1: makeAgent({ id: "a1", attention: "input" }) },
      connection: "live",
    });
    expect(await screen.findByText("Needs input")).toBeInTheDocument();
    const recent = await screen.findByRole("list", { name: "Recent sessions" });
    expect(within(recent).getAllByTestId("session-row")).toHaveLength(10);
    expect(within(recent).getByText("message 0")).toBeInTheDocument();
    expect(within(recent).queryByText("message 10")).toBeNull();
    expect(calls.some((c) => c.url === "/api/agents")).toBe(false);
  });

  it("home's agent rows show one status badge each", async () => {
    stubFetch((call) => (call.url === "/api/sessions" ? [200, { sessions: [] }] : undefined));
    const agents = [
      makeAgent({ id: "a1", sessionName: "Asking", isStreaming: true, attention: "input" }),
      makeAgent({ id: "a2", sessionName: "Streaming", isStreaming: true }),
      makeAgent({ id: "a3", sessionName: "Broke", attention: "failed" }),
      makeAgent({ id: "a4", sessionName: "Done", attention: "finished" }),
      makeAgent({ id: "a5", sessionName: "Quiet" }),
      makeAgent({ id: "a6", sessionName: "Gone", status: "exited" }),
    ];
    await renderRoutes(<HomeScreen />, "/", {
      loaded: true,
      agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
      connection: "live",
    });
    const open = await screen.findByRole("list", { name: "Open conversations" });
    const badges = (name: string) => {
      const row = within(open).getByText(name).closest("li") as HTMLElement;
      return [...row.querySelectorAll("[data-slot=badge]")].map((badge) => badge.textContent);
    };
    expect(badges("Asking")).toEqual(["Needs input"]);
    expect(badges("Streaming")).toEqual(["Working"]);
    expect(badges("Broke")).toEqual(["Failed"]);
    expect(badges("Done")).toEqual(["Finished"]);
    expect(badges("Quiet")).toEqual(["Idle"]);
    expect(badges("Gone")).toEqual(["Closed"]);
    const working = within(open).getByText("Working").closest("[data-slot=badge]");
    expect(working?.querySelector("svg")).toHaveClass("animate-spin");
  });

  it("a recent session held by an agent shows that agent's badge", async () => {
    const sessions = [
      session({ file: "/s/held.jsonl", firstMessage: "held", ownedBy: "a1" }),
      session({ file: "/s/free.jsonl", firstMessage: "free" }),
    ];
    stubFetch((call) => (call.url === "/api/sessions" ? [200, { sessions }] : undefined));
    await renderRoutes(<HomeScreen />, "/", {
      loaded: true,
      agents: { a1: makeAgent({ id: "a1", sessionFile: "/s/held.jsonl", attention: "finished" }) },
      connection: "live",
    });
    const recent = await screen.findByRole("list", { name: "Recent sessions" });
    const [held, free] = within(recent).getAllByTestId("session-row") as HTMLElement[];
    expect(held?.querySelector("[data-slot=badge]")).toHaveTextContent("Finished");
    expect(free?.querySelector("[data-slot=badge]")).toBeNull();
  });

  it("orders Home's open conversations by their last prompt, not by when they started", async () => {
    stubFetch((call) => (call.url === "/api/sessions" ? [200, { sessions: [] }] : undefined));
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    await renderRoutes(<HomeScreen />, "/", {
      loaded: true,
      agents: {
        // Just restarted, last prompted two hours ago.
        a1: makeAgent({ id: "a1", cwd: "/home/me/alpha", startedAt: ago(0), sessionFile: "/s/a" }),
        b1: makeAgent({ id: "b1", cwd: "/home/me/beta", startedAt: ago(600), sessionFile: "/s/b" }),
        // Fresh: no session file, so no prompt yet.
        c1: makeAgent({ id: "c1", cwd: "/home/me/gamma", startedAt: ago(0) }),
      },
      sessions: [
        session({ file: "/s/b", cwd: "/home/me/beta", lastPromptAt: ago(1) }),
        session({ file: "/s/a", cwd: "/home/me/alpha", lastPromptAt: ago(120) }),
      ],
      connection: "live",
    });
    const open = screen.getByRole("list", { name: "Open conversations" });
    expect(
      within(open)
        .getAllByRole("group")
        .map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent),
    ).toEqual(["beta", "alpha", "gamma"]);
  });

  it("/sessions filters by project and opens a session through POST /api/agents", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/projects") {
        return [
          200,
          {
            projects: [
              { cwd: "/home/me/alpha", sessionCount: 2, createdAt: "", isGitRepo: true },
              { cwd: "/home/me/beta", sessionCount: 1, createdAt: "", isGitRepo: false },
            ],
          },
        ];
      }
      if (call.url === "/api/sessions") {
        return [
          200,
          {
            sessions: [
              session({
                file: "/s/named.jsonl",
                name: "Refactor",
                firstMessage: "please refactor",
                ownedBy: "a9",
              }),
              session({ file: "/s/plain.jsonl", firstMessage: "hello there" }),
            ],
          },
        ];
      }
      if (call.url === "/api/agents" && call.method === "POST") {
        return [200, { agent: makeAgent({ id: "a9" }) }];
      }
      return undefined;
    });
    const requested: string[] = [];
    const fetchMock = vi.mocked(globalThis.fetch);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.pathname === "/api/sessions") requested.push(url.search);
      return (original as NonNullable<typeof original>)(input, init);
    });

    const router = await renderRoutes(null, "/sessions?cwd=%2Fhome%2Fme%2Falpha");
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: "Sessions" });
    expect(requested).toContain("?cwd=%2Fhome%2Fme%2Falpha");
    const rows = within(list).getAllByTestId("session-row");
    expect(rows[0]).toHaveTextContent("Refactor");
    expect(rows[0]).toHaveTextContent("please refactor");
    // Held by an agent this tab doesn't know yet: pi runs, nothing to report.
    expect(rows[0]).toHaveTextContent("Idle");
    expect(rows[0]).toHaveTextContent("5m ago");
    expect(rows[1]).toHaveTextContent("hello there");

    // Filter: all projects.
    await screen.findByRole("option", { name: /beta/ });
    await user.selectOptions(screen.getByLabelText("Project"), "");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(requested).toContain(""));

    await user.click((await screen.findAllByTestId("session-row"))[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a9"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      sessionFile: "/s/named.jsonl",
    });
  });
  it("disables only the session being opened", async () => {
    const sessions = [
      session({ file: "/s/a.jsonl", firstMessage: "first" }),
      session({ file: "/s/b.jsonl", firstMessage: "second" }),
    ];
    stubFetch((call) => (call.url === "/api/sessions" ? [200, { sessions }] : undefined));
    const fetchMock = vi.mocked(globalThis.fetch);
    const original = fetchMock.getMockImplementation() as NonNullable<
      ReturnType<typeof fetchMock.getMockImplementation>
    >;
    // The open never answers.
    fetchMock.mockImplementation((input, init) =>
      init?.method === "POST" ? new Promise(() => {}) : original(input, init),
    );
    await renderRoutes(<HomeScreen />, "/", { loaded: true, agents: {}, connection: "live" });
    const recent = await screen.findByRole("list", { name: "Recent sessions" });
    const [first, second] = within(recent).getAllByTestId("session-row") as HTMLElement[];
    await userEvent.setup().click(first as HTMLElement);
    await waitFor(() => expect(first).toBeDisabled());
    expect(second).toBeEnabled();
  });
});

describe("Stop or delete from Home and /sessions", () => {
  const deletes = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === "DELETE").map((c) => ({ url: c.url, body: c.body }));
  const listings = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === "GET" && c.url === "/api/sessions").length;

  it("deletes a recent session at once and refetches the list", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/sessions" && call.method === "GET") {
        return [200, { sessions: [session({ file: "/s/a.jsonl", firstMessage: "first" })] }];
      }
      if (call.method === "DELETE") return [204, null];
      return undefined;
    });
    await renderRoutes(<HomeScreen />, "/", { loaded: true, agents: {}, connection: "live" });
    const recent = await screen.findByRole("list", { name: "Recent sessions" });
    await userEvent
      .setup()
      .click(within(recent).getByRole("button", { name: "Delete first (alpha)" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/a.jsonl" } }]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(listings(calls)).toBe(2));
  });

  it("follows the holding agent's rule on an Open session, and on its open conversation row", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/sessions" && call.method === "GET") {
        return [
          200,
          {
            sessions: [
              session({ file: "/s/live.jsonl", name: "Held live", ownedBy: "a1" }),
              session({ file: "/s/exited.jsonl", name: "Held exited", ownedBy: "a2" }),
            ],
          },
        ];
      }
      if (call.method === "DELETE") return [204, null];
      return undefined;
    });
    await renderRoutes(<HomeScreen />, "/", {
      loaded: true,
      agents: {
        a1: makeAgent({ id: "a1", sessionName: "Live agent", sessionFile: "/s/live.jsonl" }),
        a2: makeAgent({
          id: "a2",
          cwd: "/home/me/beta",
          sessionName: "Exited agent",
          status: "exited",
          sessionFile: "/s/exited.jsonl",
        }),
      },
      connection: "live",
    });
    const user = userEvent.setup();
    const recent = await screen.findByRole("list", { name: "Recent sessions" });

    await user.click(
      within(recent).getByRole("button", { name: "Stop or delete Held live (alpha)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Held live?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/agents/a1", body: undefined }]),
    );

    await user.click(within(recent).getByRole("button", { name: "Delete Held exited (alpha)" }));
    await waitFor(() =>
      expect(deletes(calls)).toContainEqual({
        url: "/api/sessions",
        body: { file: "/s/exited.jsonl" },
      }),
    );

    const open = screen.getByRole("list", { name: "Open conversations" });
    expect(within(open).getByRole("button", { name: "Delete Exited agent (beta)" })).toBeEnabled();
    await user.click(
      within(open).getByRole("button", { name: "Stop or delete Live agent (project)" }),
    );
    expect(await screen.findByRole("dialog", { name: "Stop or delete Live agent?" })).toBeVisible();
  });

  it("/sessions deletes a session held by an agent this tab doesn't know through its file", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/projects") return [200, { projects: [] }];
      if (call.url === "/api/sessions" && call.method === "GET") {
        return [200, { sessions: [session({ file: "/s/h.jsonl", name: "Held", ownedBy: "a9" })] }];
      }
      if (call.method === "DELETE") return [204, null];
      return undefined;
    });
    await renderRoutes(null, "/sessions");
    const list = await screen.findByRole("list", { name: "Sessions" });
    await userEvent
      .setup()
      .click(within(list).getByRole("button", { name: "Delete Held (alpha)" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/h.jsonl" } }]),
    );
  });

  it("/sessions follows a live agent holding a session the listing doesn't mark Open", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/projects") return [200, { projects: [] }];
      if (call.url === "/api/sessions" && call.method === "GET") {
        return [200, { sessions: [session({ file: "/s/h.jsonl", name: "Held" })] }];
      }
      if (call.method === "DELETE") return [204, null];
      return undefined;
    });
    await renderRoutes(null, "/sessions", {
      loaded: true,
      agents: { a1: makeAgent({ id: "a1", sessionFile: "/s/h.jsonl" }) },
      connection: "live",
    });
    const list = await screen.findByRole("list", { name: "Sessions" });
    const user = userEvent.setup();
    await user.click(within(list).getByRole("button", { name: "Stop or delete Held (alpha)" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop or delete Held?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/agents/a1", body: undefined }]),
    );
  });

  it("disables only the × whose request is in flight", async () => {
    const sessions = [
      session({ file: "/s/a.jsonl", firstMessage: "first" }),
      session({ file: "/s/b.jsonl", firstMessage: "second" }),
    ];
    const { calls } = stubFetch((call) =>
      call.url === "/api/sessions" && call.method === "GET" ? [200, { sessions }] : undefined,
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    const original = fetchMock.getMockImplementation() as NonNullable<
      ReturnType<typeof fetchMock.getMockImplementation>
    >;
    // The delete never answers.
    fetchMock.mockImplementation((input, init) => {
      const pending = original(input, init);
      return init?.method === "DELETE" ? new Promise(() => {}) : pending;
    });
    await renderRoutes(<HomeScreen />, "/", { loaded: true, agents: {}, connection: "live" });
    const recent = await screen.findByRole("list", { name: "Recent sessions" });
    const first = within(recent).getByRole("button", { name: "Delete first (alpha)" });
    const user = userEvent.setup();
    await user.click(first);
    await waitFor(() => expect(first).toBeDisabled());
    await user.click(first);
    expect(within(recent).getByRole("button", { name: "Delete second (alpha)" })).toBeEnabled();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("Layout repos on Home, /sessions and the picker", () => {
  const R = "/home/me/Dev/pi-code";
  const layout = (role: RepoLayout["role"], missing = false): RepoLayout => ({
    repo: R,
    role,
    main: `${R}/main`,
    ...(missing ? { missing: true as const } : {}),
  });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const layoutSessions = [
    session({ file: "/s/c.jsonl", cwd: R, name: "Container notes", layout: layout("container") }),
    session({
      file: "/s/m.jsonl",
      cwd: `${R}/main`,
      name: "On main",
      lastPromptAt: ago(1),
      layout: layout("main"),
    }),
    session({
      file: "/s/w.jsonl",
      cwd: `${R}/worktree-support`,
      name: "Design worktrees",
      lastPromptAt: ago(2),
      layout: layout("worktree"),
    }),
    session({
      file: "/s/g.jsonl",
      cwd: `${R}/old-spike`,
      name: "Try the thing",
      lastPromptAt: ago(30),
      layout: layout("worktree", true),
    }),
    session({
      file: "/s/a.jsonl",
      cwd: "/home/me/alpha",
      name: "Alpha work",
      lastPromptAt: ago(60),
    }),
  ];

  const groupName = (group: HTMLElement) =>
    document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent;
  const sessionRow = (name: string) =>
    screen.getAllByTestId("session-row").find((row) => row.textContent?.includes(name));

  it("groups Home's open conversations and recent sessions", async () => {
    stubFetch((call) =>
      call.url === "/api/sessions" ? [200, { sessions: layoutSessions }] : undefined,
    );
    await renderRoutes(<HomeScreen />, "/", {
      loaded: true,
      agents: {
        a1: makeAgent({
          id: "a1",
          cwd: `${R}/main`,
          sessionName: "Main agent",
          layout: layout("main"),
        }),
        // Opened before the folder was deleted; its session's scan knows it's gone.
        a2: makeAgent({
          id: "a2",
          cwd: `${R}/old-spike`,
          sessionName: "Exited in gone",
          status: "exited",
          sessionFile: "/s/g.jsonl",
          layout: layout("worktree"),
        }),
        a3: makeAgent({ id: "a3", cwd: "/home/me/beta", sessionName: "Beta agent" }),
      },
      sessions: layoutSessions,
      connection: "live",
    });
    const open = screen.getByRole("list", { name: "Open conversations" });
    const openRepo = within(open).getByRole("group", { name: "pi-code" });
    expect(within(openRepo).getAllByRole("group").map(groupName)).toEqual(["main", "old-spike"]);
    expect(within(open).getByRole("group", { name: "beta" })).toBeInTheDocument();
    expect(within(openRepo).getByRole("link", { name: /Main agent/ })).toHaveAttribute(
      "href",
      "/agents/a1",
    );
    // An exited agent in a missing worktree can't be restarted.
    expect(within(openRepo).queryByRole("link", { name: /Exited in gone/ })).toBeNull();
    expect(within(openRepo).getByText("Exited in gone")).toBeVisible();

    const recent = await screen.findByRole("list", { name: "Recent sessions" });
    const repo = within(recent).getByRole("group", { name: "pi-code" });
    expect(within(repo).getAllByRole("group").map(groupName)).toEqual([
      "main",
      "worktree-support",
      "old-spike",
    ]);
    expect(within(recent).getByRole("group", { name: "alpha" })).toHaveTextContent("Alpha work");
    expect(within(repo).getByRole("button", { name: "New worktree in pi-code" })).toBeVisible();
    expect(
      within(repo).getByRole("button", { name: "Remove worktree pi-code/worktree-support" }),
    ).toBeVisible();
    expect(
      within(repo).getByRole("button", { name: "Remove worktree pi-code/old-spike" }),
    ).toBeVisible();
    expect(
      within(repo).queryByRole("button", { name: /Remove worktree pi-code\/main/ }),
    ).toBeNull();
    expect(within(repo).getByRole("group", { name: "old-spike" })).toHaveTextContent("missing");
    expect(sessionRow("Try the thing")).toBeDisabled();
    expect(sessionRow("Design worktrees")).toBeEnabled();
    // Only opening is off in a missing worktree; its rows stay deletable.
    expect(
      within(recent).getByRole("button", { name: "Delete Try the thing (pi-code/old-spike)" }),
    ).toBeEnabled();
    expect(
      within(open).getByRole("button", { name: "Delete Exited in gone (pi-code/old-spike)" }),
    ).toBeEnabled();
  });

  it("/sessions groups the list, filtered by ?cwd= first", async () => {
    const requested: string[] = [];
    stubFetch((call) => {
      if (call.url === "/api/projects") return [200, { projects: [] }];
      if (call.url === "/api/sessions") {
        requested.push(call.search);
        const cwd = new URLSearchParams(call.search).get("cwd");
        return [200, { sessions: layoutSessions.filter((s) => cwd === null || s.cwd === cwd) }];
      }
      return undefined;
    });
    await renderRoutes(null, `/sessions?cwd=${encodeURIComponent(`${R}/worktree-support`)}`);
    const list = await screen.findByRole("list", { name: "Sessions" });
    expect(requested).toEqual([`?cwd=${encodeURIComponent(`${R}/worktree-support`)}`]);
    const repo = within(list).getByRole("group", { name: "pi-code" });
    expect(within(repo).getAllByRole("group").map(groupName)).toEqual(["worktree-support"]);
    expect(within(list).getAllByTestId("session-row")).toHaveLength(1);
  });

  it("/sessions keeps a missing folder's session that a live agent holds openable", async () => {
    stubFetch((call) => {
      if (call.url === "/api/projects") return [200, { projects: [] }];
      if (call.url === "/api/sessions") {
        const held = session({
          file: "/s/h.jsonl",
          cwd: `${R}/old-spike`,
          name: "Still held",
          lastPromptAt: ago(20),
          ownedBy: "a9",
          layout: layout("worktree", true),
        });
        return [200, { sessions: [...layoutSessions, held] }];
      }
      return undefined;
    });
    await renderRoutes(null, "/sessions");
    await screen.findByRole("list", { name: "Sessions" });
    expect(sessionRow("Still held")).toBeEnabled();
    expect(sessionRow("Try the thing")).toBeDisabled();
  });

  it("/sessions creates a worktree from a repo header", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/projects") return [200, { projects: [] }];
      if (call.url === "/api/sessions") return [200, { sessions: layoutSessions }];
      if (call.url === "/api/worktrees" && call.method === "POST") {
        return [201, { agent: makeAgent({ id: "w1", cwd: `${R}/qa-wt` }) }];
      }
      return undefined;
    });
    const router = await renderRoutes(null, "/sessions");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New worktree in pi-code" }));
    const sheet = await screen.findByTestId("new-worktree-sheet");
    await user.type(within(sheet).getByLabelText("Name"), "qa-wt");
    await user.type(within(sheet).getByLabelText("Base"), "origin/dev");
    await user.click(within(sheet).getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/w1"));
    expect(calls.find((c) => c.url === "/api/worktrees")?.body).toEqual({
      repo: R,
      name: "qa-wt",
      base: "origin/dev",
    });
  });

  it("/sessions removes a missing worktree from its header", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/projects") return [200, { projects: [] }];
      if (call.url === "/api/sessions") return [200, { sessions: layoutSessions }];
      if (call.url === "/api/worktrees" && call.method === "DELETE") return [204, null];
      return undefined;
    });
    await renderRoutes(null, "/sessions");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Remove worktree pi-code/old-spike" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Remove old-spike?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ path: `${R}/old-spike` }),
    );
  });

  describe("ProjectPicker", () => {
    const projects = [
      {
        cwd: R,
        sessionCount: 1,
        lastPromptAt: ago(50),
        createdAt: ago(50),
        isGitRepo: false,
        layout: layout("container"),
      },
      {
        cwd: `${R}/main`,
        sessionCount: 4,
        lastPromptAt: ago(5),
        createdAt: ago(5),
        isGitRepo: true,
        layout: layout("main"),
      },
      {
        cwd: `${R}/wt`,
        sessionCount: 2,
        lastPromptAt: ago(1),
        createdAt: ago(1),
        isGitRepo: true,
        layout: layout("worktree"),
      },
      {
        cwd: `${R}/gone`,
        sessionCount: 1,
        lastPromptAt: ago(90),
        createdAt: ago(90),
        isGitRepo: false,
        layout: layout("worktree", true),
      },
      {
        cwd: "/home/me/alpha",
        sessionCount: 3,
        lastPromptAt: ago(10),
        createdAt: ago(10),
        isGitRepo: true,
      },
    ];

    function stubPicker() {
      return stubFetch((call) => {
        if (call.url === "/api/projects") return [200, { projects }];
        if (call.url === "/api/fs/dirs") return [200, { dirs: [] }];
        if (call.url === "/api/agents" && call.method === "POST") {
          return [201, { agent: makeAgent({ id: "n1", status: "starting" }) }];
        }
        if (call.url === "/api/worktrees" && call.method === "POST") {
          return [201, { agent: makeAgent({ id: "w1", status: "starting" }) }];
        }
        return undefined;
      });
    }

    const recentList = () => screen.findByRole("list", { name: "Recent projects" });

    it("lists a repo's container, main and worktrees under its header", async () => {
      stubPicker();
      await renderRoutes(<ProjectPicker open onOpenChange={() => {}} />);
      const list = await recentList();
      const repo = within(list).getByRole("group", { name: "pi-code" });
      const rows = within(repo)
        .getAllByRole("listitem")
        .map((li) => li.querySelector(".font-medium")?.textContent);
      expect(rows).toEqual(["pi-code", "main", "wt", "gone"]);
      // Groups by most recent item: pi-code (wt, 1m ago) before alpha.
      expect(within(list).getAllByRole("button")[0]).toHaveAccessibleName(
        "New worktree in pi-code",
      );
      const gone = within(repo).getByRole("button", { name: /gone/ });
      expect(gone).toBeDisabled();
      expect(gone).toHaveTextContent("missing");
    });

    it.each([
      ["the container", /^pi-code/, R],
      ["main", /^main/, `${R}/main`],
      ["a worktree", /^wt/, `${R}/wt`],
    ])("starts a conversation in %s", async (_, name, cwd) => {
      const { calls } = stubPicker();
      const router = await renderRoutes(<ProjectPicker open onOpenChange={() => {}} />);
      const repo = within(await recentList()).getByRole("group", { name: "pi-code" });
      await userEvent.setup().click(within(repo).getByRole("button", { name }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n1"));
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd });
    });

    it("creates a worktree from the repo header, closing the picker", async () => {
      const { calls } = stubPicker();
      const onOpenChange = vi.fn();
      const router = await renderRoutes(<ProjectPicker open onOpenChange={onOpenChange} />);
      const user = userEvent.setup();
      await recentList();
      await user.click(screen.getByRole("button", { name: "New worktree in pi-code" }));
      const sheet = await screen.findByTestId("new-worktree-sheet");
      expect(onOpenChange).not.toHaveBeenCalled();
      await user.type(within(sheet).getByLabelText("Name"), "from-picker{Enter}");
      await waitFor(() => expect(router.state.location.pathname).toBe("/agents/w1"));
      expect(calls.find((c) => c.url === "/api/worktrees")?.body).toEqual({
        repo: R,
        name: "from-picker",
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
