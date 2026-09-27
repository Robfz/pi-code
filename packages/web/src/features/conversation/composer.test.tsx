import { initialLiveState, type LiveState } from "@pi-code/protocol";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "@/test/fixtures";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { Composer } from "./composer";
import { QueueDisplay } from "./queue-display";

function live(patch: Partial<LiveState>): LiveState {
  return { ...initialLiveState(), ...patch };
}

const rpcBodies = (calls: { url: string; body: unknown }[]) =>
  calls.filter((c) => c.url === "/api/agents/a1/rpc").map((c) => c.body);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Composer", () => {
  it("sends a prompt when idle and clears the text", async () => {
    const { calls } = stubFetch(() => [200, { data: undefined }]);
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(box, "hello pi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "prompt", message: "hello pi" }]),
    );
    expect(box).toHaveValue("");
  });

  it("Enter sends on desktop, Shift+Enter inserts a newline", async () => {
    const { calls } = stubFetch();
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Message" });
    await user.type(box, "line 1{Shift>}{Enter}{/Shift}line 2");
    expect(box).toHaveValue("line 1\nline 2");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "prompt", message: "line 1\nline 2" }]),
    );
  });

  it("Enter inserts a newline on touch devices", async () => {
    const { calls } = stubFetch();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Message" });
    await user.type(box, "a{Enter}b");
    expect(box).toHaveValue("a\nb");
    expect(rpcBodies(calls)).toEqual([]);
  });

  it("restores the text when sending fails", async () => {
    stubFetch(() => [409, { error: { code: "agent_exited", message: "agent exited" } }]);
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Message" });
    await user.type(box, "keep me{Enter}");
    await waitFor(() => expect(box).toHaveValue("keep me"));
  });

  it("is disabled until pi is ready", async () => {
    await renderWithStore(
      <Composer />,
      hydratedStore({ agent: makeAgent({ status: "starting" }) }),
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
  });

  describe("while running", () => {
    const running = () => hydratedStore({ live: live({ run: { active: true } }) });

    it("steers and queues with streamingBehavior", async () => {
      const { calls } = stubFetch();
      await renderWithStore(<Composer />, running());
      const user = userEvent.setup();
      const box = screen.getByRole("textbox", { name: "Message" });
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

      await user.type(box, "go left");
      await user.click(screen.getByRole("button", { name: /Steer/ }));
      await user.type(box, "then this");
      await user.click(screen.getByRole("button", { name: /Queue/ }));
      await user.type(box, "enter steers{Enter}");
      await user.type(box, "alt queues{Alt>}{Enter}{/Alt}");
      await waitFor(() =>
        expect(rpcBodies(calls)).toEqual([
          { type: "prompt", message: "go left", streamingBehavior: "steer" },
          { type: "prompt", message: "then this", streamingBehavior: "followUp" },
          { type: "prompt", message: "enter steers", streamingBehavior: "steer" },
          { type: "prompt", message: "alt queues", streamingBehavior: "followUp" },
        ]),
      );
    });

    it("Stop aborts", async () => {
      const { calls } = stubFetch();
      await renderWithStore(<Composer />, running());
      await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "abort" }]));
      expect(screen.queryByRole("button", { name: /Stop & edit/ })).toBeNull();
    });

    it("Stop & edit clears the queue, aborts, and restores the queued texts", async () => {
      const { calls } = stubFetch((call) => {
        const body = call.body as { type?: string } | undefined;
        if (body?.type === "clear_queue") {
          return [200, { data: { steering: ["steer me"], followUp: ["later"] } }];
        }
        return undefined;
      });
      const store = hydratedStore({
        live: live({
          run: { active: true },
          queue: { steering: ["steer me"], followUp: ["later"] },
        }),
      });
      await renderWithStore(
        <>
          <QueueDisplay />
          <Composer />
        </>,
        store,
      );
      expect(screen.getByTestId("queue")).toHaveTextContent("Steersteer me");
      expect(screen.getByTestId("queue")).toHaveTextContent("Queuedlater");
      const user = userEvent.setup();
      const box = screen.getByRole("textbox", { name: "Message" });
      await user.type(box, "draft");
      await user.click(screen.getByRole("button", { name: /Stop & edit/ }));
      await waitFor(() =>
        expect(rpcBodies(calls)).toEqual([{ type: "clear_queue" }, { type: "abort" }]),
      );
      expect(box).toHaveValue("steer me\n\nlater\n\ndraft");
    });
  });

  it("applies set_editor_text requests that arrive after mount, not the one in the snapshot", async () => {
    const store = hydratedStore({ live: live({ editorText: { text: "old", nonce: 3 } }) });
    await renderWithStore(<Composer />, store);
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).toHaveValue("");
    act(() => {
      store.getState().apply(
        {
          type: "ui_request",
          request: {
            type: "extension_ui_request",
            id: "e1",
            method: "set_editor_text",
            text: "from pi",
          },
          receivedAt: 1,
        },
        1,
      );
    });
    expect(box).toHaveValue("from pi");
  });
});
