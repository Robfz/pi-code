import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { SW_MESSAGE } from "@/sw/push-logic";
import { sendBaseline, sendFrame } from "@/test/fake-event-source";
import { makeAgent } from "@/test/fixtures";
import { installServiceWorkerContainer, uninstallPushEnv } from "@/test/push-env";
import { stubFetch } from "@/test/render";
import { agentIdFromPath, attentionCount } from "./badge";

function renderAt(path = "/", queryClient = createQueryClient()) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

afterEach(() => {
  uninstallPushEnv();
  Reflect.deleteProperty(navigator, "onLine");
  Reflect.deleteProperty(navigator, "setAppBadge");
  Reflect.deleteProperty(navigator, "clearAppBadge");
  Reflect.deleteProperty(window, "launchQueue");
});

describe("offline banner", () => {
  it("shows when the server is unreachable and hides after a successful retry", async () => {
    let reachable = false;
    stubFetch((call) => {
      if (call.url === "/api/health") {
        return reachable ? [200, { ok: true, piVersion: "1" }] : [502, { error: "bad gateway" }];
      }
      return [200, { sessions: [] }];
    });
    renderAt();
    const banner = await screen.findByTestId("offline-banner", {}, { timeout: 3_000 });
    expect(banner).toHaveTextContent("Can't reach the pi-code server");
    expect(banner).toHaveAttribute("data-state", "unreachable");

    reachable = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).toBeNull());
  });

  it("follows the browser's offline / online events", async () => {
    stubFetch();
    renderAt();
    sendBaseline([]);
    expect(await screen.findByText("No open conversations.")).toBeInTheDocument();
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    act(() => setOnline(false));
    expect(await screen.findByTestId("offline-banner")).toHaveTextContent("You're offline");
    act(() => setOnline(true));
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).toBeNull());
  });
});

describe("app badge", () => {
  it("counts attention, ignoring the conversation on screen", () => {
    const agents = [
      makeAgent({ id: "a1", attention: "finished" }),
      makeAgent({ id: "a2", attention: "input" }),
      makeAgent({ id: "a3", attention: "none" }),
    ];
    expect(attentionCount(agents)).toBe(2);
    expect(attentionCount(agents, "a1")).toBe(1);
    expect(agentIdFromPath("/agents/a%201/tree")).toBe("a 1");
    expect(agentIdFromPath("/sessions")).toBeUndefined();
  });

  it("syncs the badge from the live agents and clears it when nothing needs attention", async () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clearAppBadge });
    const { calls } = stubFetch();
    renderAt("/");
    // Nothing is applied before the stream is up.
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();

    sendBaseline([
      makeAgent({ id: "a1", cwd: "/home/me/alpha", attention: "finished" }),
      makeAgent({ id: "a2", cwd: "/home/me/beta", attention: "failed" }),
    ]);
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));

    sendFrame({ type: "agent", agent: makeAgent({ id: "a1", attention: "none" }) });
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1));
    sendFrame({ type: "agent_closed", agentId: "a2" });
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
    expect(calls.some((c) => c.url === "/api/agents")).toBe(false);
  });
});

describe("service worker messages", () => {
  it("routes to the URL of a clicked notification", async () => {
    const container = installServiceWorkerContainer();
    stubFetch();
    const router = renderAt("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    act(() => container.emit({ type: SW_MESSAGE.navigate, url: "/sessions" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
    // Only same-origin paths.
    act(() => container.emit({ type: SW_MESSAGE.navigate, url: "https://evil.example/" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("toasts a push received while focused, with an Open action", async () => {
    const container = installServiceWorkerContainer();
    stubFetch();
    const router = renderAt("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    act(() =>
      container.emit({
        type: SW_MESSAGE.push,
        payload: {
          kind: "input",
          agentId: "a9",
          title: "beta needs input",
          body: "Allow network?",
          badge: 1,
          url: "/sessions",
        },
      }),
    );
    expect(await screen.findByText("beta needs input")).toBeInTheDocument();
    expect(screen.getByText("Allow network?")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
  });
});

describe("launch queue", () => {
  /** A fake `window.launchQueue`; `launch(url)` delivers params to the consumer. */
  function installLaunchQueue() {
    let consumer: ((params: { targetURL?: string }) => void) | undefined;
    Object.defineProperty(window, "launchQueue", {
      configurable: true,
      value: { setConsumer: (next: typeof consumer) => (consumer = next) },
    });
    return {
      launch(targetURL: string) {
        if (!consumer) throw new Error("no launch consumer");
        consumer({ targetURL });
      },
    };
  }

  it("routes a same-origin launch in-app and ignores other origins", async () => {
    const queue = installLaunchQueue();
    stubFetch();
    const router = renderAt("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    act(() => queue.launch(`${window.location.origin}/sessions?cwd=%2Fhome#top`));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
    expect(router.state.location.search).toEqual({ cwd: "/home" });
    expect(router.state.location.hash).toBe("top");

    act(() => queue.launch("https://evil.example/settings"));
    await screen.findByRole("heading", { name: "Sessions" });
    expect(router.state.location.pathname).toBe("/sessions");
  });

  it("ignores the initial launch's params, already handled by the router", async () => {
    const queue = installLaunchQueue();
    stubFetch();
    const router = renderAt("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    // The document's URL (jsdom's, as the router runs on a memory history here).
    act(() => queue.launch(window.location.href));
    expect(router.state.location.pathname).toBe("/settings");
    // Later launches to the same URL route.
    act(() => queue.launch(window.location.href));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("does nothing without the Launch Handler API", async () => {
    stubFetch();
    const router = renderAt("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
  });
});
