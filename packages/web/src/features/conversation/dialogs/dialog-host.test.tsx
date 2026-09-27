import { initialLiveState, type PendingDialog } from "@pi-code/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { DialogHost } from "./dialog-host";

const base = { type: "extension_ui_request" as const };

function withDialogs(...dialogs: PendingDialog[]) {
  return hydratedStore({ live: { ...initialLiveState(), dialogs } });
}

const uiBodies = (calls: { url: string; body: unknown }[]) =>
  calls.filter((c) => c.url === "/api/agents/a1/ui-responses").map((c) => c.body);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DialogHost", () => {
  it("select: answers with the chosen option and hides", async () => {
    const { calls } = stubFetch(() => [204, null]);
    await renderWithStore(
      <DialogHost />,
      withDialogs({
        request: {
          ...base,
          id: "d1",
          method: "select",
          title: "Pick one",
          options: ["alpha", "beta"],
        },
        receivedAt: Date.now(),
      }),
    );
    const sheet = screen.getByTestId("dialog-select");
    expect(within(sheet).getByText("Pick one")).toBeInTheDocument();
    await userEvent.setup().click(within(sheet).getByRole("option", { name: "beta" }));
    await waitFor(() => expect(uiBodies(calls)).toEqual([{ id: "d1", value: "beta" }]));
    await waitFor(() => expect(screen.queryByTestId("dialog-select")).toBeNull());
  });

  it("confirm: Yes and No", async () => {
    const { calls } = stubFetch(() => [204, null]);
    await renderWithStore(
      <DialogHost />,
      withDialogs(
        {
          request: { ...base, id: "c1", method: "confirm", title: "Delete?", message: "Really?" },
          receivedAt: Date.now(),
        },
        {
          request: { ...base, id: "c2", method: "confirm", title: "Again?", message: "Sure?" },
          receivedAt: Date.now(),
        },
      ),
    );
    const user = userEvent.setup();
    expect(screen.getByText("Really?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes" }));
    // The next pending dialog shows once the first is answered.
    await screen.findByText("Sure?");
    await user.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() =>
      expect(uiBodies(calls)).toEqual([
        { id: "c1", confirmed: true },
        { id: "c2", confirmed: false },
      ]),
    );
  });

  it("input: submits the typed value; Cancel sends cancelled", async () => {
    const { calls } = stubFetch(() => [204, null]);
    await renderWithStore(
      <DialogHost />,
      withDialogs(
        {
          request: { ...base, id: "i1", method: "input", title: "Your name", placeholder: "name" },
          receivedAt: Date.now(),
        },
        {
          request: { ...base, id: "i2", method: "input", title: "Second" },
          receivedAt: Date.now(),
        },
      ),
    );
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Your name" });
    expect(field).toHaveAttribute("placeholder", "name");
    await user.type(field, "Ada{Enter}");
    await screen.findByRole("textbox", { name: "Second" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(uiBodies(calls)).toEqual([
        { id: "i1", value: "Ada" },
        { id: "i2", cancelled: true },
      ]),
    );
  });

  it("editor: full-screen textarea prefilled, submits the edited text", async () => {
    const { calls } = stubFetch(() => [204, null]);
    await renderWithStore(
      <DialogHost />,
      withDialogs({
        request: { ...base, id: "e1", method: "editor", title: "Edit plan", prefill: "step 1" },
        receivedAt: Date.now(),
      }),
    );
    const user = userEvent.setup();
    const area = screen.getByRole("textbox", { name: "Edit plan" });
    expect(area).toHaveValue("step 1");
    await user.type(area, "\nstep 2");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(uiBodies(calls)).toEqual([{ id: "e1", value: "step 1\nstep 2" }]));
  });

  it("closing the sheet cancels", async () => {
    const { calls } = stubFetch(() => [204, null]);
    await renderWithStore(
      <DialogHost />,
      withDialogs({
        request: { ...base, id: "x1", method: "select", title: "T", options: ["a"] },
        receivedAt: Date.now(),
      }),
    );
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(uiBodies(calls)).toEqual([{ id: "x1", cancelled: true }]));
  });

  it("shows a countdown; at 0 the dialog stays until the server's ui_resolved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const store = withDialogs({
      request: {
        ...base,
        id: "t1",
        method: "select",
        title: "Quick",
        options: ["x"],
        timeout: 3000,
      },
      receivedAt: now,
      expiresAt: now + 3000,
    });
    await renderWithStore(<DialogHost />, store);
    expect(screen.getByTestId("countdown")).toHaveTextContent("3s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(screen.getByTestId("countdown")).toHaveTextContent("2s");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(screen.getByTestId("countdown")).toHaveTextContent("0s");
    expect(screen.getByTestId("dialog-select")).toBeInTheDocument();
    act(() => store.getState().apply({ type: "ui_resolved", id: "t1" }, 1));
    await waitFor(() => expect(screen.queryByTestId("dialog-select")).toBeNull());
  });

  it("hides a dialog answered elsewhere (dialog_not_found)", async () => {
    stubFetch(() => [404, { error: { code: "dialog_not_found", message: "gone" } }]);
    await renderWithStore(
      <DialogHost />,
      withDialogs({
        request: { ...base, id: "g1", method: "confirm", title: "Old", message: "m" },
        receivedAt: Date.now(),
      }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.queryByTestId("dialog-confirm")).toBeNull());
  });

  it("removes the dialog on ui_resolved", async () => {
    const store = withDialogs({
      request: { ...base, id: "r1", method: "confirm", title: "T", message: "m" },
      receivedAt: Date.now(),
    });
    await renderWithStore(<DialogHost />, store);
    expect(screen.getByTestId("dialog-confirm")).toBeInTheDocument();
    act(() => store.getState().apply({ type: "ui_resolved", id: "r1" }, 1));
    await waitFor(() => expect(screen.queryByTestId("dialog-confirm")).toBeNull());
  });

  it("linkifies URLs in titles and messages, with copy buttons", async () => {
    const user = userEvent.setup(); // installs a clipboard stub
    await renderWithStore(
      <DialogHost />,
      withDialogs({
        request: {
          ...base,
          id: "o1",
          method: "input",
          title: "Open https://auth.example.com/authorize?x=1 then paste the redirect URL.",
        },
        receivedAt: Date.now(),
      }),
    );
    const link = screen.getByRole("link", { name: "https://auth.example.com/authorize?x=1" });
    expect(link).toHaveAttribute("href", "https://auth.example.com/authorize?x=1");
    expect(link).toHaveAttribute("target", "_blank");
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe("https://auth.example.com/authorize?x=1");
  });
});
