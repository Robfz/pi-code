import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { useDrafts } from "@/store/drafts";
import { sendBaseline } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { Composer } from "./composer";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { error: vi.fn() }) };
});

const box = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
const fileInput = () => screen.getByTestId("file-input") as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The app at `/agents/a1`, with agents a1 and a2 open; snapshots answer for any agent. */
async function renderApp() {
  stubFetch((call) => {
    const snapshot = /^\/api\/agents\/([^/]+)\/snapshot$/.exec(call.url);
    if (snapshot?.[1]) return [200, makeSnapshot({ agent: makeAgent({ id: snapshot[1] }) })];
    return undefined;
  });
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/agents/a1"] }),
  });
  render(<App router={router} queryClient={createQueryClient()} />);
  sendBaseline([makeAgent({ id: "a1" }), makeAgent({ id: "a2" })]);
  await waitFor(() => expect(box()).toBeEnabled());
  return router;
}

describe("Composer drafts across navigation", () => {
  it("keeps the text and attachments through the tree screen and back", async () => {
    const router = await renderApp();
    const user = userEvent.setup();
    await user.type(box(), "half a thought");
    await user.upload(fileInput(), new File(["notes"], "notes.txt"));
    await screen.findByRole("list", { name: "Attachments" });

    await act(() => router.navigate({ to: "/agents/$agentId/tree", params: { agentId: "a1" } }));
    await user.click(await screen.findByRole("link", { name: "Back to conversation" }));

    await waitFor(() => expect(box()).toHaveValue("half a thought"));
    expect(
      within(screen.getByRole("list", { name: "Attachments" })).getByText("notes.txt"),
    ).toBeInTheDocument();
  });

  it("keeps a draft per conversation", async () => {
    const router = await renderApp();
    const user = userEvent.setup();
    await user.type(box(), "for a1");

    await act(() => router.navigate({ to: "/agents/$agentId", params: { agentId: "a2" } }));
    await waitFor(() => expect(box()).toHaveValue(""));
    await user.type(box(), "for a2");

    await act(() => router.navigate({ to: "/agents/$agentId", params: { agentId: "a1" } }));
    await waitFor(() => expect(box()).toHaveValue("for a1"));
    await act(() => router.navigate({ to: "/agents/$agentId", params: { agentId: "a2" } }));
    await waitFor(() => expect(box()).toHaveValue("for a2"));
  });
});

/** The composer behind a toggle, standing in for navigating away and back. */
function Toggle() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown(!shown)}>
        Toggle composer
      </button>
      {shown && <Composer />}
    </>
  );
}

describe("Composer references", () => {
  it("inserts a reference at the caret of the mounted composer and focuses it", async () => {
    stubFetch();
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    await user.type(box(), "hello world");
    await user.keyboard("{ArrowLeft>6/}");
    expect(useDrafts.getState().drafts.a1?.selection).toEqual({ start: 5, end: 5 });
    act(() => box().blur());

    act(() => useDrafts.getState().insertReference("a1", "@a.ts:3"));

    expect(box()).toHaveValue("hello @a.ts:3 world");
    expect(box()).toHaveFocus();
    expect(box().selectionStart).toBe(13);
    expect(box().selectionEnd).toBe(13);
  });

  it("applies a reference inserted while unmounted once the composer remounts", async () => {
    stubFetch();
    await renderWithStore(<Toggle />, hydratedStore());
    const user = userEvent.setup();
    await user.type(box(), "look here please");
    await user.keyboard("{ArrowLeft>7/}");
    await user.click(screen.getByRole("button", { name: "Toggle composer" }));
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();

    act(() => useDrafts.getState().insertReference("a1", "@src/a.ts:4-6"));
    await user.click(screen.getByRole("button", { name: "Toggle composer" }));

    expect(box()).toHaveValue("look here @src/a.ts:4-6 please");
    expect(box()).toHaveFocus();
    expect(box().selectionStart).toBe(23);
  });

  it("doesn't refocus on a remount without outside changes", async () => {
    stubFetch();
    await renderWithStore(<Toggle />, hydratedStore());
    const user = userEvent.setup();
    act(() => useDrafts.getState().replace("a1", "from a fork"));
    expect(box()).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Toggle composer" }));
    await user.click(screen.getByRole("button", { name: "Toggle composer" }));
    expect(box()).toHaveValue("from a fork");
    expect(box()).not.toHaveFocus();
  });
});

describe("Composer send", () => {
  it("keeps text typed while a failed send was in flight", async () => {
    let fail: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      fail = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await pending;
        return new Response(JSON.stringify({ error: { code: "agent_busy", message: "busy" } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    await user.type(box(), "first{Enter}");
    expect(box()).toHaveValue("");
    await user.type(box(), "second");
    act(() => fail?.());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("busy"));
    expect(box()).toHaveValue("second");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
