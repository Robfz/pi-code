import type { ServerEvent } from "@pi-code/protocol";
import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationStore } from "@/store/conversation-store";
import { stubMatchMedia } from "@/test/dom-stubs";
import { fixtureEvents } from "@/test/fixtures";
import { hydratedStore, renderWithStore } from "@/test/render";
import { ConversationScreen } from "./conversation-screen";

/** Apply events one by one until `stop` returns true for the event just applied. */
function playUntil(
  store: ConversationStore,
  events: ServerEvent[],
  cursor: { i: number },
  stop: (event: ServerEvent) => boolean,
) {
  act(() => {
    while (cursor.i < events.length) {
      const event = events[cursor.i] as ServerEvent;
      cursor.i++;
      store.getState().apply(event, cursor.i);
      if (stop(event)) break;
    }
  });
}

const isPi = (type: string) => (e: ServerEvent) => e.type === "pi" && e.event.type === type;

describe("ConversationScreen live rendering", () => {
  it("streams text, runs tools and ends with the committed transcript (tool-calls)", async () => {
    const store = hydratedStore();
    await renderWithStore(<ConversationScreen />, store);
    const events = fixtureEvents("tool-calls");
    const cursor = { i: 0 };

    playUntil(store, events, cursor, isPi("agent_start"));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Steer or queue a message…",
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    // The user message shows as pending until its entry is committed.
    playUntil(
      store,
      events,
      cursor,
      (e) => e.type === "pi" && e.event.type === "message_end" && e.event.message.role === "user",
    );
    expect(within(screen.getByTestId("live")).getByTestId("user-message")).toBeInTheDocument();

    playUntil(store, events, cursor, isPi("tool_execution_start"));
    const liveTool = screen.getAllByTestId("tool-call").at(-1);
    expect(liveTool).toHaveAttribute("data-status", "running");

    playUntil(store, events, cursor, () => false);
    expect(screen.queryByTestId("streaming-message")).toBeNull();
    const transcript = screen.getByTestId("transcript");
    expect(
      within(transcript)
        .getAllByTestId("tool-call")
        .map((el) => el.dataset.tool),
    ).toEqual(["read", "edit"]);
    for (const el of within(transcript).getAllByTestId("tool-call")) {
      expect(el).toHaveAttribute("data-status", "done");
    }
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(screen.getByTestId("live")).queryByTestId("user-message")).toBeNull();
  });

  it("shows the streaming assistant text before it is committed (plain-answer)", async () => {
    const store = hydratedStore();
    await renderWithStore(<ConversationScreen />, store);
    const events = fixtureEvents("plain-answer");
    const cursor = { i: 0 };
    playUntil(
      store,
      events,
      cursor,
      (e) =>
        e.type === "pi" &&
        e.event.type === "message_update" &&
        e.event.assistantMessageEvent.type === "text_delta",
    );
    const streaming = screen.getByTestId("streaming-message");
    expect(streaming.textContent?.length).toBeGreaterThan(0);
    playUntil(store, events, cursor, () => false);
    expect(screen.queryByTestId("streaming-message")).toBeNull();
    expect(
      within(screen.getByTestId("transcript")).getAllByTestId("assistant-message"),
    ).toHaveLength(1);
  });

  it("shows queued steering / follow-up messages (steer-followup)", async () => {
    const store = hydratedStore();
    await renderWithStore(<ConversationScreen />, store);
    const events = fixtureEvents("steer-followup");
    const cursor = { i: 0 };
    playUntil(
      store,
      events,
      cursor,
      (e) =>
        e.type === "pi" &&
        e.event.type === "queue_update" &&
        e.event.steering.length + e.event.followUp.length > 0,
    );
    expect(screen.getByTestId("queue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop & edit/ })).toBeInTheDocument();
    playUntil(store, events, cursor, () => false);
    expect(screen.queryByTestId("queue")).toBeNull();
  });

  it("streams `!` command output until the entry is committed (bash-command)", async () => {
    const store = hydratedStore();
    await renderWithStore(<ConversationScreen />, store);
    const events = fixtureEvents("bash-command");
    const cursor = { i: 0 };
    playUntil(store, events, cursor, (e) => e.type === "bash_output");
    const live = screen.getByTestId("live");
    expect(within(live).getByTestId("bash-execution")).toHaveTextContent("running…");
    playUntil(store, events, cursor, () => false);
    expect(within(screen.getByTestId("live")).queryByTestId("bash-execution")).toBeNull();
    expect(within(screen.getByTestId("transcript")).getAllByTestId("bash-execution")).toHaveLength(
      3,
    );
  });

  it("shows extension dialogs from the stream as sheets (extension-dialog)", async () => {
    const store = hydratedStore();
    await renderWithStore(<ConversationScreen />, store);
    const events = fixtureEvents("extension-dialog");
    const cursor = { i: 0 };
    playUntil(
      store,
      events,
      cursor,
      (e) => e.type === "ui_request" && e.request.method === "select",
    );
    expect(screen.getByTestId("dialog-select")).toHaveTextContent("S0 pick a fruit");
    playUntil(store, events, cursor, (e) => e.type === "ui_resolved");
    expect(screen.queryByTestId("dialog-select")).toBeNull();
    playUntil(
      store,
      events,
      cursor,
      (e) => e.type === "ui_request" && e.request.method === "confirm",
    );
    expect(screen.getByTestId("dialog-confirm")).toHaveTextContent("You picked banana");
  });
});

describe("ConversationScreen width", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps the transcript and composer at max-w-3xl below 1024px", async () => {
    stubMatchMedia(() => false);
    await renderWithStore(<ConversationScreen />, hydratedStore());
    expect(screen.getByTestId("transcript-column")).toHaveClass("max-w-3xl");
    expect(screen.getByTestId("composer-column")).toHaveClass("max-w-3xl");
  });

  it("uses the full content width from 1024px", async () => {
    stubMatchMedia((query) => query === "(min-width: 1024px)");
    await renderWithStore(<ConversationScreen />, hydratedStore());
    expect(screen.getByTestId("transcript-column")).not.toHaveClass("max-w-3xl");
    expect(screen.getByTestId("composer-column")).not.toHaveClass("max-w-3xl");
  });
});
