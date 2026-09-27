import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function renderHeader() {
  const store = hydratedStore({ agent: makeAgent({ sessionName: "Old name" }) });
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

  it("Close → DELETE and back home", async () => {
    const { calls } = stubFetch((call) => (call.method === "DELETE" ? [204, null] : undefined));
    const { user, router } = await renderHeader();
    await router.navigate({ to: "/agents/$agentId", params: { agentId: "a1" } });
    await menu(user, /Close conversation/);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
        "/api/agents/a1",
      ]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
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
    expect(screen.getByRole("menuitem", { name: /Close conversation/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});
