import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { Toaster } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query-client";
import { makeAgent } from "@/test/fixtures";
import { type FetchCall, stubFetch } from "@/test/render";
import { NewWorktreeSheet } from "./new-worktree-sheet";
import { useWorktreeActions, WorktreeActionsProvider } from "./worktree-actions";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REPO = "/home/me/Dev/pi-code";
const WT = `${REPO}/spike`;
const DIRTY = `${REPO}/dirty-one`;
const DIRTY_TWO = `${REPO}/dirty-two`;

async function renderAt(ui: ReactNode) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <WorktreeActionsProvider>{ui}</WorktreeActionsProvider>
        <Toaster />
      </QueryClientProvider>
    ),
  });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router as never} />);
  return router;
}

function api(answer: (call: FetchCall) => [number, unknown] | undefined) {
  return stubFetch(answer).calls;
}

const failure = (status: number, code: string, message: string): [number, unknown] => [
  status,
  { error: { code, message } },
];

/** Stubs `fetch` with requests that hang until `release` answers them all. */
function hangingFetch(response: () => Response) {
  const waiting: Array<(r: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        waiting.push(resolve);
      }),
  );
  return () => {
    for (const resolve of waiting.splice(0)) resolve(response());
  };
}

describe("NewWorktreeSheet", () => {
  function SheetHarness() {
    const [open, setOpen] = useState(true);
    return (
      <NewWorktreeSheet
        repo={{ path: REPO, label: "pi-code" }}
        open={open}
        onOpenChange={setOpen}
      />
    );
  }

  const sheet = () => screen.getByTestId("new-worktree-sheet");
  const submit = () => within(sheet()).getByRole("button", { name: "Create worktree" });

  it("creates with the given fields, then closes and navigates to the agent", async () => {
    const calls = api((call) =>
      call.url === "/api/worktrees"
        ? [201, { agent: makeAgent({ id: "w1", status: "starting", cwd: `${REPO}/qa-wt` }) }]
        : undefined,
    );
    const router = await renderAt(<SheetHarness />);
    const user = userEvent.setup();
    expect(within(sheet()).getByRole("heading", { name: "New worktree in pi-code" })).toBeVisible();
    await user.type(within(sheet()).getByLabelText("Name"), " qa-wt ");
    expect(within(sheet()).getByLabelText("Branch")).toHaveAttribute("placeholder", "qa-wt");
    await user.type(within(sheet()).getByLabelText("Branch"), "qa/branch");
    await user.click(submit());
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/w1"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { repo: REPO, name: "qa-wt", branch: "qa/branch" },
    ]);
    await waitFor(() => expect(screen.queryByTestId("new-worktree-sheet")).toBeNull());
  });

  it("reads Fetching…, stays disabled and can't be dismissed while the request runs", async () => {
    const release = hangingFetch(
      () => new Response(JSON.stringify({ agent: makeAgent({ id: "w1" }) }), { status: 201 }),
    );
    const router = await renderAt(<SheetHarness />);
    const user = userEvent.setup();
    await user.type(within(sheet()).getByLabelText("Name"), "x");
    await user.click(submit());
    const pending = within(sheet()).getByRole("button", { name: "Fetching…" });
    expect(pending).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(within(sheet()).getByRole("button", { name: "Close" }));
    expect(sheet()).toBeVisible();
    release();
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/w1"));
    await waitFor(() => expect(screen.queryByTestId("new-worktree-sheet")).toBeNull());
  });

  it("starts with an empty form on every open", async () => {
    function Openers() {
      const { openNewWorktree } = useWorktreeActions();
      return (
        <>
          <button type="button" onClick={() => openNewWorktree({ path: REPO, label: "pi-code" })}>
            New in pi-code
          </button>
          <button
            type="button"
            onClick={() => openNewWorktree({ path: "/home/me/other", label: "other" })}
          >
            New in other
          </button>
        </>
      );
    }
    // As in a browser, the sheet's exit animation keeps it mounted while it closes, so reopening
    // then reuses the closing sheet.
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo);
      if (!(element instanceof HTMLElement) || element.dataset.slot !== "sheet-content") {
        return style;
      }
      return new Proxy(style, {
        get: (target, key) => {
          if (key === "animationName") return element.dataset.state === "closed" ? "exit" : "enter";
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    api(() => undefined);
    await renderAt(<Openers />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const name = () => within(sheet()).getByLabelText("Name");
    // By text: the closing sheet still hides the rest of the page from the accessibility tree.
    const opener = (label: string) => screen.getByText(label);
    await user.click(opener("New in pi-code"));
    await user.type(name(), "half-typed");
    await user.keyboard("{Escape}");
    expect(sheet()).toHaveAttribute("data-state", "closed");
    await user.click(opener("New in pi-code"));
    expect(sheet()).toHaveAttribute("data-state", "open");
    expect(name()).toHaveValue("");
    await user.type(name(), "half-typed");
    await user.keyboard("{Escape}");
    await user.click(opener("New in other"));
    expect(within(sheet()).getByRole("heading", { name: "New worktree in other" })).toBeVisible();
    expect(name()).toHaveValue("");
  });

  it("checks the name before sending: one segment, not starting with a dot", async () => {
    const calls = api(() => undefined);
    await renderAt(<SheetHarness />);
    const user = userEvent.setup();
    const name = within(sheet()).getByLabelText("Name");
    expect(submit()).toBeDisabled();
    await user.type(name, "a/b");
    expect(within(sheet()).getByRole("alert")).toHaveTextContent("no “/”");
    expect(name).toHaveAccessibleDescription("The name is a single folder: no “/”.");
    expect(submit()).toBeDisabled();
    await user.clear(name);
    await user.type(name, ".git{Enter}");
    expect(within(sheet()).getByRole("alert")).toHaveTextContent("can't start with “.”");
    expect(submit()).toBeDisabled();
    expect(calls.some((c) => c.url === "/api/worktrees")).toBe(false);
  });

  it.each([
    failure(409, "worktree_exists", `${REPO}/dup already exists`),
    failure(409, "branch_exists", "branch dup already exists"),
    failure(400, "invalid_body", "invalid branch name: 'a b'"),
    failure(502, "git_failed", "git fetch origin failed: could not resolve host"),
  ])("shows the server's %i error inline and clears it on edit", async (status, body) => {
    const message = (body as { error: { message: string } }).error.message;
    api((call) => (call.url === "/api/worktrees" ? [status, body] : undefined));
    const router = await renderAt(<SheetHarness />);
    const user = userEvent.setup();
    await user.type(within(sheet()).getByLabelText("Name"), "dup");
    await user.click(submit());
    expect(await within(sheet()).findByRole("alert")).toHaveTextContent(message);
    expect(router.state.location.pathname).toBe("/");
    await user.type(within(sheet()).getByLabelText("Base"), "x");
    expect(within(sheet()).queryByRole("alert")).toBeNull();
  });
});

describe("requestRemove", () => {
  // Toasts outlive a test, so tests that look for one use their own label.
  function RemoveHarness({ path = WT, label = "spike" }: { path?: string; label?: string }) {
    const { requestRemove, removing } = useWorktreeActions();
    return (
      <button
        type="button"
        disabled={removing !== undefined}
        onClick={() => requestRemove({ path, label })}
      >
        Remove {label}
      </button>
    );
  }

  const deletes = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === "DELETE" && c.url === "/api/worktrees").map((c) => c.body);

  it("confirms, removes, and toasts", async () => {
    const calls = api((call) => (call.method === "DELETE" ? [204, null] : undefined));
    await renderAt(<RemoveHarness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove spike" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove spike?" });
    expect(dialog).toHaveTextContent(`Deletes ${WT} and its conversations (moved to the Trash)`);
    expect(dialog).toHaveTextContent("the branch is kept");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed spike")).toBeInTheDocument();
    expect(deletes(calls)).toEqual([{ path: WT }]);
  });

  it("sends nothing when the first confirmation is cancelled", async () => {
    const calls = api(() => undefined);
    await renderAt(<RemoveHarness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove spike" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove spike?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)).toEqual([]);
  });

  it("asks again on worktree_dirty and retries with force", async () => {
    const calls = api((call) => {
      if (call.method !== "DELETE") return undefined;
      return (call.body as { force?: boolean }).force
        ? [204, null]
        : failure(409, "worktree_dirty", "dirty-one has uncommitted changes");
    });
    await renderAt(<RemoveHarness path={DIRTY} label="dirty-one" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove dirty-one" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove dirty-one?" })).getByRole("button", {
        name: "Remove",
      }),
    );
    const dirty = await screen.findByRole("dialog", { name: "Remove dirty-one anyway?" });
    expect(dirty).toHaveTextContent("dirty-one has uncommitted changes or submodules");
    expect(dirty).toHaveTextContent("Changes will be lost");
    await user.click(within(dirty).getByRole("button", { name: "Remove anyway" }));
    expect(await screen.findByText("Removed dirty-one")).toBeInTheDocument();
    expect(deletes(calls)).toEqual([{ path: DIRTY }, { path: DIRTY, force: true }]);
  });

  it("sends no forced request when the second confirmation is cancelled", async () => {
    const calls = api((call) =>
      call.method === "DELETE" ? failure(409, "worktree_dirty", "dirty") : undefined,
    );
    await renderAt(<RemoveHarness path={DIRTY_TWO} label="dirty-two" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove dirty-two" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove dirty-two?" })).getByRole("button", {
        name: "Remove",
      }),
    );
    const dirty = await screen.findByRole("dialog", { name: "Remove dirty-two anyway?" });
    await user.click(within(dirty).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes(calls)).toEqual([{ path: DIRTY_TWO }]);
    expect(screen.queryByText("Removed dirty-two")).toBeNull();
  });

  it("toasts a failure with the server's message", async () => {
    api((call) =>
      call.method === "DELETE"
        ? failure(502, "git_failed", "git worktree remove failed")
        : undefined,
    );
    await renderAt(<RemoveHarness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove spike" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove spike?" })).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(await screen.findByText("git worktree remove failed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs one removal at a time: no other can be asked for while one runs", async () => {
    const release = hangingFetch(() => new Response(null, { status: 204 }));
    function AskOther() {
      const { requestRemove } = useWorktreeActions();
      return (
        <button type="button" onClick={() => requestRemove({ path: DIRTY, label: "other" })}>
          Ask other
        </button>
      );
    }
    await renderAt(
      <>
        <RemoveHarness />
        <RemoveHarness path={DIRTY} label="other" />
        <AskOther />
      </>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Remove spike" });
    const other = screen.getByRole("button", { name: "Remove other" });
    await user.click(button);
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove spike?" })).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() => expect(button).toBeDisabled());
    expect(other).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Ask other" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    release();
    await waitFor(() => expect(other).toBeEnabled());
    expect(button).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Ask other" }));
    expect(await screen.findByRole("dialog", { name: "Remove other?" })).toBeInTheDocument();
  });

  it("asks again after the surface that started the removal unmounts", async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    function Surface() {
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown && <RemoveHarness path={DIRTY} label="gone-surface" />}
          <button type="button" onClick={() => setShown(false)}>
            Hide
          </button>
        </>
      );
    }
    await renderAt(<Surface />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove gone-surface" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove gone-surface?" })).getByRole(
        "button",
        { name: "Remove" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("button", { name: "Remove gone-surface" })).toBeNull();
    answer(
      new Response(JSON.stringify({ error: { code: "worktree_dirty", message: "dirty" } }), {
        status: 409,
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Remove gone-surface anyway?" }),
    ).toBeInTheDocument();
  });
});
