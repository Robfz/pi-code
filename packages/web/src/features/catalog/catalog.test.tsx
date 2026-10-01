import type { SessionSummary } from "@pi-code/protocol";
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
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
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
          <Outlet />
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
                updatedAt: "2026-01-01T00:00:00.000Z",
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
  it("home shows open agents with attention and the 10 most recent sessions", async () => {
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

  it("/sessions filters by project and opens a session through POST /api/agents", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/projects") {
        return [
          200,
          {
            projects: [
              { cwd: "/home/me/alpha", sessionCount: 2, updatedAt: "", isGitRepo: true },
              { cwd: "/home/me/beta", sessionCount: 1, updatedAt: "", isGitRepo: false },
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
    expect(rows[0]).toHaveTextContent("Open");
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
});
