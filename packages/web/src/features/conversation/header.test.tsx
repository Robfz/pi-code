import { initialLiveState, type RepoLayout } from "@pi-code/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { useUiPrefs } from "@/store/ui-prefs";
import { stubMatchMedia } from "@/test/dom-stubs";
import { makeAgent } from "@/test/fixtures";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ActionSheets } from "./action-sheets";
import { Composer } from "./composer";
import { useConversationUi } from "./conversation-ui";
import { ConversationHeader } from "./header";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

const rpcBodies = (calls: FetchCall[]) =>
  calls.filter((c) => c.url === "/api/agents/a1/rpc").map((c) => c.body);

function rpcHandler(call: FetchCall): [number, unknown] | undefined {
  if (call.url !== "/api/agents/a1/rpc") return undefined;
  const type = (call.body as { type: string }).type;
  switch (type) {
    case "clone":
    case "new_session":
      return [200, { data: { cancelled: false } }];
    case "get_fork_messages":
      return [
        200,
        {
          data: {
            messages: [
              { entryId: "u1", text: "first question" },
              { entryId: "u2", text: "second question" },
            ],
          },
        },
      ];
    case "fork":
      return [200, { data: { text: "second question", cancelled: false } }];
    case "compact":
      return [200, { data: { summary: "s", firstKeptEntryId: "x", tokensBefore: 10 } }];
    default:
      return [200, {}];
  }
}

async function renderHeader(agent = makeAgent({ sessionName: "Old name" })) {
  const store = hydratedStore({ agent });
  const result = await renderWithStore(
    <>
      <ConversationHeader />
      <Composer />
      <ActionSheets />
    </>,
    store,
  );
  return { ...result, store, user: userEvent.setup() };
}

async function menu(user: ReturnType<typeof userEvent.setup>, item: string | RegExp) {
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

beforeEach(() => {
  useConversationUi.getState().reset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConversationHeader menu", () => {
  it("links to the tree and diff screens", async () => {
    stubFetch();
    const { user } = await renderHeader();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: /Tree/ })).toHaveAttribute(
      "href",
      "/agents/a1/tree",
    );
    expect(screen.getByRole("menuitem", { name: /Diff/ })).toHaveAttribute(
      "href",
      "/agents/a1/diff",
    );
  });

  it("Clone → clone", async () => {
    const { calls } = stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await menu(user, /Clone/);
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "clone" }]));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Cloned the session"));
  });

  it("New session → new_session", async () => {
    const { calls } = stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await menu(user, /New session/);
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "new_session" }]));
  });

  it("reports a cancelled new session", async () => {
    stubFetch((call) =>
      call.url === "/api/agents/a1/rpc" ? [200, { data: { cancelled: true } }] : undefined,
    );
    const { user } = await renderHeader();
    await menu(user, /New session/);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("New session cancelled"));
  });

  it("Fork… lists get_fork_messages (latest first) and forks, putting the text in the composer", async () => {
    const { calls } = stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await menu(user, /Fork/);
    const sheet = await screen.findByTestId("fork-sheet");
    const options = await within(sheet).findAllByRole("button", { name: /question/ });
    expect(options.map((o) => o.textContent)).toEqual(["second question", "first question"]);
    await user.click(options[0] as HTMLElement);
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        { type: "get_fork_messages" },
        { type: "fork", entryId: "u2" },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("fork-sheet")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("second question");
  });

  it("Compact… sends optional instructions", async () => {
    const { calls } = stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await menu(user, /Compact/);
    const sheet = await screen.findByTestId("compact-sheet");
    await user.type(within(sheet).getByLabelText("Instructions (optional)"), "keep the API notes");
    await user.click(within(sheet).getByRole("button", { name: "Compact" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        { type: "compact", customInstructions: "keep the API notes" },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("compact-sheet")).toBeNull());
  });

  it("Compact… without instructions", async () => {
    const { calls } = stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await menu(user, /Compact/);
    const sheet = await screen.findByTestId("compact-sheet");
    await user.click(within(sheet).getByRole("button", { name: "Compact" }));
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "compact" }]));
  });

  it("Rename… → set_session_name", async () => {
    const { calls } = stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await menu(user, /Rename/);
    const input = within(await screen.findByTestId("rename-sheet")).getByLabelText("Session name");
    expect(input).toHaveValue("Old name");
    await user.clear(input);
    await user.type(input, "New name{Enter}");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "set_session_name", name: "New name" }]),
    );
    await waitFor(() => expect(screen.queryByTestId("rename-sheet")).toBeNull());
  });

  const deletes = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === "DELETE").map((c) => ({ url: c.url, body: c.body }));

  it("Stop → DELETE /api/agents/:id and back home", async () => {
    const { calls } = stubFetch((call) => (call.method === "DELETE" ? [204, null] : undefined));
    const { user, router } = await renderHeader();
    await router.navigate({ to: "/agents/$agentId", params: { agentId: "a1" } });
    await menu(user, /Stop/);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(deletes(calls)).toEqual([{ url: "/api/agents/a1", body: undefined }]);
  });

  it("Delete → DELETE /api/sessions with the agent's session file, without asking, and back home", async () => {
    const { calls } = stubFetch((call) => (call.method === "DELETE" ? [204, null] : undefined));
    const store = hydratedStore({ agent: makeAgent({ sessionFile: "/s/a1.jsonl" }) });
    const { router } = await renderWithStore(<ConversationHeader />, store);
    await router.navigate({ to: "/agents/$agentId", params: { agentId: "a1" } });
    await menu(userEvent.setup(), /Delete/);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/a1.jsonl" } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Delete takes the live overview's session file over the snapshot's", async () => {
    const { calls } = stubFetch((call) => (call.method === "DELETE" ? [204, null] : undefined));
    const store = hydratedStore({ agent: makeAgent({ sessionFile: "/s/old.jsonl" }) });
    const { registry } = await renderWithStore(<ConversationHeader />, store);
    registry.live.setState({ agents: { a1: makeAgent({ sessionFile: "/s/new.jsonl" }) } });
    await menu(userEvent.setup(), /Delete/);
    await waitFor(() =>
      expect(deletes(calls)).toEqual([{ url: "/api/sessions", body: { file: "/s/new.jsonl" } }]),
    );
  });

  it("toasts a failed Delete and stays", async () => {
    stubFetch((call) =>
      call.method === "DELETE"
        ? [400, { error: { code: "session_not_listed", message: "Kept the file" } }]
        : undefined,
    );
    const store = hydratedStore({ agent: makeAgent({ sessionFile: "/s/a1.jsonl" }) });
    const { router } = await renderWithStore(<ConversationHeader />, store);
    await router.navigate({ to: "/agents/$agentId", params: { agentId: "a1" } });
    await menu(userEvent.setup(), /Delete/);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Kept the file"));
    expect(router.state.location.pathname).toBe("/agents/a1");
  });

  it("session actions are disabled until the agent is ready", async () => {
    stubFetch();
    const store = hydratedStore({ agent: makeAgent({ status: "starting" }) });
    await renderWithStore(<ConversationHeader />, store);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: /Clone/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: /Stop/ })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("menuitem", { name: /Delete/ })).not.toHaveAttribute("aria-disabled");
  });
});

const menuItems = () =>
  screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");

describe("ConversationHeader on desktop", () => {
  beforeEach(() => stubMatchMedia((query) => query === DESKTOP_QUERY));

  it("promotes Fork… and Compact… out of the menu; Tree and changes live in the rail", async () => {
    stubFetch(rpcHandler);
    const { user } = await renderHeader();
    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("link", { name: "Tree" })).toBeNull();
    expect(within(header).queryByRole("button", { name: /changes/i })).toBeNull();
    const order = ["Fork", "Compact", "Transcript density", "More"].map((name) =>
      within(header).getByRole("button", { name }),
    );
    for (const [i, element] of order.slice(1).entries()) {
      expect(
        (order[i] as HTMLElement).compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    await user.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menu");
    expect(menuItems()).toEqual(["Clone", "Rename…", "New session", "Stop", "Delete"]);
  });

  it("Fork and Compact open their sheets", async () => {
    stubFetch(rpcHandler);
    const { user } = await renderHeader();
    await user.click(screen.getByRole("button", { name: "Fork" }));
    expect(await screen.findByTestId("fork-sheet")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("fork-sheet")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Compact" }));
    expect(await screen.findByTestId("compact-sheet")).toBeInTheDocument();
  });

  it("disables Fork and Compact until the agent is ready", async () => {
    stubFetch();
    await renderWithStore(
      <ConversationHeader />,
      hydratedStore({ agent: makeAgent({ status: "starting" }) }),
    );
    expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compact" })).toBeDisabled();
  });
});

describe("ConversationHeader on phones", () => {
  it("keeps Tree, Diff, Fork… and Compact… in the menu", async () => {
    stubFetch();
    const { user } = await renderHeader();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Tree" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menu");
    expect(menuItems()).toEqual([
      "Tree",
      "Diff",
      "Fork…",
      "Clone",
      "Compact…",
      "Rename…",
      "New session",
      "Stop",
      "Delete",
    ]);
  });
});

describe("ConversationHeader breadcrumb", () => {
  const folders = () => screen.queryAllByTestId("breadcrumb-folder").map((el) => el.textContent);

  it("shows folder › title outside a layout repo", async () => {
    stubFetch();
    await renderHeader(makeAgent({ cwd: "/home/me/notes", sessionName: "Plan the week" }));
    expect(folders()).toEqual(["notes"]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Plan the week");
  });

  it("shows repo › worktree › title in a layout repo", async () => {
    stubFetch();
    const layout: RepoLayout = {
      repo: "/home/me/pi-code",
      role: "worktree",
      main: "/home/me/pi-code/main",
    };
    await renderHeader(
      makeAgent({ cwd: "/home/me/pi-code/ui-overhaul", layout, sessionName: "Header" }),
    );
    expect(folders()).toEqual(["pi-code", "ui-overhaul"]);
    expect(screen.getAllByTestId("breadcrumb-folder")[0]).toHaveAttribute(
      "title",
      "/home/me/pi-code",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Header");
  });

  it("shows only the repo for its container", async () => {
    stubFetch();
    const layout: RepoLayout = {
      repo: "/home/me/pi-code",
      role: "container",
      main: "/home/me/pi-code/main",
    };
    await renderHeader(makeAgent({ cwd: "/home/me/pi-code", layout }));
    expect(folders()).toEqual(["pi-code"]);
  });

  it("titles an unnamed session by its first prompt, as the sidebar does", async () => {
    stubFetch();
    const { registry } = await renderHeader(makeAgent({ sessionFile: "/s/a1.jsonl" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("New conversation");
    act(() =>
      registry.live.setState({
        sessions: [
          {
            file: "/s/a1.jsonl",
            id: "s1",
            cwd: "/home/me/project",
            firstMessage: "Fix the flaky test",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Fix the flaky test");
  });

  it("shows the branch chip once the branch is known", async () => {
    stubFetch();
    await renderWithStore(
      <ConversationHeader />,
      hydratedStore({ gitStatus: { branch: "feat/header", dirty: false } }),
    );
    expect(screen.getByTestId("header-branch")).toHaveTextContent("feat/header");
  });

  it("shows no branch chip without one", async () => {
    stubFetch();
    await renderHeader();
    expect(screen.queryByTestId("header-branch")).toBeNull();
  });
});

describe("ConversationHeader run state", () => {
  it("reads Working with the run's elapsed time while it runs", async () => {
    stubFetch();
    const startedAt = Date.now() - 133_000;
    await renderWithStore(
      <ConversationHeader />,
      hydratedStore({ live: { ...initialLiveState(), run: { active: true, startedAt } } }),
    );
    const label = screen.getByTestId("header-run-state");
    expect(label).toHaveTextContent("Working · 2m 13s");
    expect(label).toHaveClass("shimmer");
  });

  it("is absent while idle", async () => {
    stubFetch();
    await renderWithStore(<ConversationHeader />, hydratedStore());
    expect(screen.queryByTestId("header-run-state")).toBeNull();
  });
});

describe("ConnectionIndicator", () => {
  it.each([
    ["live", "bg-status-online", false],
    ["connecting", "bg-status-idle", true],
    ["reconnecting", "bg-status-idle", true],
    ["offline", "bg-status-error", false],
  ] as const)("%s: a %s dot", async (connection, color, pulses) => {
    stubFetch();
    const store = hydratedStore();
    store.getState().setConnection(connection);
    await renderWithStore(<ConversationHeader />, store);
    const dot = screen.getByTestId("connection").firstElementChild;
    expect(dot).toHaveClass(color);
    expect(dot?.classList.contains("animate-pulse")).toBe(pulses);
  });
});

describe("ConversationHeader density", () => {
  it("lists the three levels, checks the current one and switches on choice", async () => {
    stubFetch();
    useUiPrefs.setState({ density: "balanced" });
    const { user } = await renderHeader();
    const button = screen.getByRole("button", { name: "Transcript density" });
    expect(button).toHaveTextContent("Balanced");
    await user.click(button);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Transcript density")).toBeInTheDocument();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "CompactFinished turns fold into ‘Worked for …’",
      "BalancedEvery step, exploration grouped",
      "DetailedNo grouping, everything expanded",
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(items[1]?.querySelector("svg.lucide-check")).not.toBeNull();
    expect(items[0]?.querySelector("svg.lucide-check")).toBeNull();

    await user.click(items[2] as HTMLElement);
    expect(useUiPrefs.getState().density).toBe("detailed");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(button).toHaveTextContent("Detailed");
  });
});
