import { initialLiveState, type ServerEvent } from "@pi-code/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import type { ConversationStore } from "@/store/conversation-store";
import { stubMatchMedia } from "@/test/dom-stubs";
import { fixtureEvents, makeAgent } from "@/test/fixtures";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
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
    const pending = within(screen.getByTestId("live-turn")).getByTestId("user-message");
    expect(pending).toHaveClass("opacity-70");

    playUntil(store, events, cursor, isPi("tool_execution_start"));
    const liveTool = screen.getAllByTestId("tool-call").at(-1);
    expect(liveTool).toHaveAttribute("data-status", "running");

    playUntil(store, events, cursor, () => false);
    expect(screen.queryByTestId("live-turn")).toBeNull();
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
    expect(screen.getAllByTestId("user-message")).toHaveLength(1);
    expect(screen.getByTestId("user-message")).not.toHaveClass("opacity-70");
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
    const streaming = within(screen.getByTestId("live-turn")).getByTestId("assistant-text");
    expect(streaming.textContent?.length).toBeGreaterThan(0);
    playUntil(store, events, cursor, () => false);
    expect(screen.queryByTestId("live-turn")).toBeNull();
    expect(within(screen.getByTestId("transcript")).getAllByTestId("assistant-text")).toHaveLength(
      1,
    );
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

  const CAP = ["mx-auto", "w-full", "max-w-[46rem]", "px-4", "lg:px-6"];
  const expectCapped = () => {
    for (const id of ["transcript-column", "composer-column"]) {
      expect(screen.getByTestId(id)).toHaveClass(...CAP);
      expect(screen.getByTestId(id).className).not.toMatch(/lg:px-32/);
    }
  };

  it("caps the transcript and composer columns on phone", async () => {
    stubMatchMedia(() => false);
    await renderWithStore(<ConversationScreen />, hydratedStore());
    expectCapped();
  });

  it("caps them on desktop with the review pane closed and open", async () => {
    stubMatchMedia((query) => query === DESKTOP_QUERY);
    stubFetch((call) =>
      call.url === "/api/agents/a1/git/diff" ? [200, { oldRev: "abc1234", files: [] }] : undefined,
    );
    await renderWithStore(<ConversationScreen />, hydratedStore());
    expectCapped();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show changes" }));
    expect(await screen.findByRole("complementary", { name: "Review" })).toBeInTheDocument();
    expectCapped();
  });
});

/**
 * Where sequential focus navigation goes from `from`, as a browser does it: the next (or
 * previous) focusable element in document order, skipping inert subtrees (jsdom and user-event
 * don't) and Radix's focus guards.
 */
function tabStop(from: Element, shift = false): Element | undefined {
  const stops = [
    ...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]"),
  ].filter(
    (el) =>
      el === from ||
      (el instanceof HTMLElement &&
        el.tabIndex >= 0 &&
        !el.matches(":disabled, [data-radix-focus-guard]") &&
        !el.closest("[inert]")),
  );
  return stops[stops.indexOf(from) + (shift ? -1 : 1)];
}

describe("ConversationScreen desktop scoped sheets", () => {
  // Sidebar stand-ins, before and after the conversation in document order.
  let before: HTMLButtonElement;
  let after: HTMLButtonElement;
  const render = async (store: ReturnType<typeof hydratedStore>) => {
    stubMatchMedia((query) => query === DESKTOP_QUERY);
    await renderWithStore(<ConversationScreen />, store);
    before = document.createElement("button");
    before.textContent = "Before";
    after = document.createElement("button");
    after.textContent = "After";
    document.body.prepend(before);
    document.body.append(after);
  };
  afterEach(() => {
    before.remove();
    after.remove();
    vi.unstubAllGlobals();
  });

  /** The first and last focusable elements of `sheet`. */
  const edges = (sheet: HTMLElement) => {
    const inside = [...sheet.querySelectorAll<HTMLElement>("button, input, textarea")];
    return [inside[0] as HTMLElement, inside.at(-1) as HTMLElement] as const;
  };

  it("dialog: the covered column is inert; Escape outside the sheet doesn't answer", async () => {
    const { calls } = stubFetch(() => [204, null]);
    const uiBodies = () =>
      calls.filter((c) => c.url === "/api/agents/a1/ui-responses").map((c) => c.body);
    const store = hydratedStore({
      live: {
        ...initialLiveState(),
        dialogs: [
          {
            request: {
              type: "extension_ui_request",
              id: "d1",
              method: "confirm",
              title: "T",
              message: "m",
            },
            receivedAt: Date.now(),
          },
        ],
      },
    });
    await render(store);
    const sheet = await screen.findByTestId("dialog-confirm");
    const composer = screen.getByRole("textbox", { name: "Message" });
    for (const covered of [
      composer,
      screen.getByTestId("transcript-column"),
      screen.getByTestId("composer-column"),
      document.querySelector("header"),
    ]) {
      expect(covered?.closest("[inert]")).not.toBeNull();
    }
    expect(sheet.closest("[inert]")).toBeNull();

    // Focus leaving the sheet skips the covered controls, either way.
    const [first, last] = edges(sheet);
    expect(tabStop(last)).toBe(after);
    expect(tabStop(first, true)).toBe(before);

    // Escape where focus can't be in a browser (the inert composer), or outside, isn't for it.
    const user = userEvent.setup();
    composer.focus();
    await user.keyboard("{Escape}");
    before.focus();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("dialog-confirm")).toBeInTheDocument();
    expect(uiBodies()).toEqual([]);

    // Escape in the sheet cancels; the column is live again.
    first.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(uiBodies()).toEqual([{ id: "d1", cancelled: true }]));
    await waitFor(() => expect(screen.queryByTestId("dialog-confirm")).toBeNull());
    expect(composer.closest("[inert]")).toBeNull();
  });

  it("trust sheet: the covered column is inert and focus leaving the sheet skips it", async () => {
    stubFetch(() => [204, null]);
    const store = hydratedStore({ agent: makeAgent({ status: "awaiting_trust" }) });
    await render(store);
    const sheet = await screen.findByTestId("trust-sheet");
    expect(screen.getByTestId("composer-column")).toHaveAttribute("inert");
    const [first, last] = edges(sheet);
    expect(tabStop(last)).toBe(after);
    expect(tabStop(first, true)).toBe(before);
    act(() =>
      store.getState().apply({ type: "agent_status", agent: makeAgent({ status: "ready" }) }, 1),
    );
    await waitFor(() => expect(screen.queryByTestId("trust-sheet")).toBeNull());
    expect(screen.getByTestId("composer-column")).not.toHaveAttribute("inert");
  });
});
