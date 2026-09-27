import type { RpcExtensionUIRequest, ServerEvent } from "@pi-code/protocol";
import { act, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureEvents } from "@/test/fixtures";
import { hydratedStore, renderWithStore } from "@/test/render";
import {
  DocumentTitle,
  NoticeToaster,
  resetSeenNotices,
  StatusChips,
  Widgets,
} from "./extension-ui";

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

let seq = 0;
type UiRequestInput = RpcExtensionUIRequest extends infer R
  ? R extends RpcExtensionUIRequest
    ? Omit<R, "type">
    : never
  : never;

function ui(request: UiRequestInput): ServerEvent {
  return {
    type: "ui_request",
    request: { type: "extension_ui_request", ...request } as RpcExtensionUIRequest,
    receivedAt: 1,
  };
}

beforeEach(() => {
  resetSeenNotices();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  seq = 0;
  document.title = "pi-code";
});

afterEach(() => {
  document.title = "pi-code";
});

describe("extension UI", () => {
  it("renders the extension-dialog fixture's widgets, status chips (ANSI stripped) and title", async () => {
    const store = hydratedStore();
    await renderWithStore(
      <>
        <Widgets placement="aboveEditor" />
        <Widgets placement="belowEditor" />
        <StatusChips />
        <DocumentTitle />
        <NoticeToaster />
      </>,
      store,
    );
    const events = fixtureEvents("extension-dialog");
    // Up to (and including) the setTitle request, before the extension clears everything.
    const upTo = events.findIndex(
      (e) => e.type === "ui_request" && e.request.method === "set_editor_text",
    );
    act(() => {
      for (const event of events.slice(0, upTo)) store.getState().apply(event, ++seq);
    });

    expect(screen.getByTestId("widgets-aboveEditor")).toHaveTextContent(
      "s0 widget line 1 s0 widget line 2",
    );
    expect(screen.getByTestId("widgets-belowEditor")).toHaveTextContent("s0 below");
    const chips = screen.getByTestId("status-chips");
    expect(chips).toHaveTextContent("🔌 MCP: 2 servers enabled");
    expect(chips.textContent).not.toContain("\u001b");
    expect(chips).toHaveTextContent("s0 status text");
    expect(document.title).toBe("s0 title");
    expect(toast.info).toHaveBeenCalledWith("s0 notify info");
    expect(toast.warning).toHaveBeenCalledWith("s0 notify warning");

    // The rest of the fixture clears status and widgets.
    act(() => {
      for (const event of events.slice(upTo)) store.getState().apply(event, ++seq);
    });
    expect(screen.queryByTestId("widgets-aboveEditor")).toBeNull();
    expect(screen.queryByTestId("widgets-belowEditor")).toBeNull();
    expect(screen.getByTestId("status-chips")).not.toHaveTextContent("s0 status text");
  });

  it("strips ANSI from widget lines", async () => {
    const store = hydratedStore();
    await renderWithStore(<Widgets placement="aboveEditor" />, store);
    act(() =>
      store.getState().apply(
        ui({
          id: "w",
          method: "setWidget",
          widgetKey: "k",
          widgetLines: ["\u001b[31mred\u001b[0m"],
        }),
        1,
      ),
    );
    expect(screen.getByTestId("widgets-aboveEditor").textContent).toBe("red");
  });

  it("toasts each notice once, and not the ones already in the first snapshot", async () => {
    const store = hydratedStore({
      live: {
        ...hydratedStore().getState().live,
        notices: [{ id: "old", message: "old news", kind: "info", at: 0 }],
      },
    });
    const view = await renderWithStore(<NoticeToaster />, store);
    expect(toast.info).not.toHaveBeenCalled();

    act(() =>
      store
        .getState()
        .apply(ui({ id: "n1", method: "notify", message: "boom", notifyType: "error" }), 1),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    act(() => store.getState().apply({ type: "stats", stats: {} as never }, 2));
    expect(toast.error).toHaveBeenCalledTimes(1);

    // Remount (e.g. navigating away and back): nothing is toasted again.
    view.unmount();
    await renderWithStore(<NoticeToaster />, store);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a new store for the same agent (conversation reopened) doesn't replay its notices", async () => {
    const withNotices = () =>
      hydratedStore({
        live: {
          ...hydratedStore().getState().live,
          notices: [
            { id: "n1", message: "first", kind: "error", at: 0 },
            { id: "n2", message: "second", kind: "warning", at: 0 },
          ],
        },
      });
    const first = await renderWithStore(<NoticeToaster />, withNotices());
    first.unmount();
    await renderWithStore(<NoticeToaster />, withNotices());
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("uses pi's session name for the title once known", async () => {
    const store = hydratedStore();
    store.setState({
      state: { ...(store.getState().state ?? {}), sessionName: "Renamed" } as never,
    });
    await renderWithStore(<DocumentTitle />, store);
    expect(document.title).toBe("Renamed · pi-code");
  });

  it("falls back to the session name or folder for the title and restores it on unmount", async () => {
    const store = hydratedStore();
    const view = await renderWithStore(<DocumentTitle />, store);
    expect(document.title).toBe("project · pi-code");
    view.unmount();
    expect(document.title).toBe("pi-code");
  });
});
