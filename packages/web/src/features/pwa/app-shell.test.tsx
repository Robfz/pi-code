import type { AgentInfo } from "@pi-code/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendBaseline } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";
import { stubUserAgent, USER_AGENTS } from "@/test/user-agents";

const alpha = makeAgent({ id: "a1", cwd: "/home/me/alpha", sessionName: "Alpha work" });
const beta = makeAgent({ id: "a2", cwd: "/home/me/beta", sessionName: "Beta work" });

function renderApp(
  path: string,
  { desktop, agents = [alpha, beta] }: { desktop: boolean; agents?: AgentInfo[] },
) {
  stubMatchMedia((query) => desktop && query === DESKTOP_QUERY);
  stubFetch((call) => {
    const match = /^\/api\/agents\/(a\d)\/snapshot$/.exec(call.url);
    const agent = agents.find((a) => a.id === match?.[1]);
    if (agent) return [200, makeSnapshot({ agent })];
    return undefined;
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

const sidebar = () => screen.queryByRole("navigation", { name: "Conversations" });
const toggle = () => screen.getByRole("button", { name: "Toggle sidebar" });
/** The sidebar's Active section (live rows also show in their project groups). */
const active = (container: HTMLElement) =>
  within(container).findByRole("group", { name: "Active" });

/** A keydown on the focused element; whether it went through (wasn't `preventDefault`ed). */
const press = (init: KeyboardEventInit) =>
  fireEvent.keyDown(document.activeElement ?? document.body, init);
const leaderB = () => {
  press({ key: "j", code: "KeyJ", metaKey: true });
  return press({ key: "b", code: "KeyB" });
};
const cmdB = () => press({ key: "b", code: "KeyB", metaKey: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop shell (≥1024px)", () => {
  it("docks the sidebar on load and shows the pick-a-conversation screen at /", async () => {
    renderApp("/", { desktop: true });
    expect(
      await screen.findByRole("heading", { name: "Pick a conversation or start a new one" }),
    ).toBeInTheDocument();
    expect(sidebar()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "pi-code" })).toBeNull();
    const main = screen.getByRole("heading", { name: /Pick a conversation/ }).parentElement;
    await userEvent
      .setup()
      .click(within(main as HTMLElement).getByRole("button", { name: "New conversation" }));
    expect(await screen.findByTestId("project-picker")).toBeInTheDocument();
  });

  it("opens the project picker at /?new and strips the param", async () => {
    const router = renderApp("/?new=1", { desktop: true });
    expect(await screen.findByTestId("project-picker")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.searchStr).toBe(""));
    expect(router.state.location.pathname).toBe("/");
    // Replaced, not pushed: Back doesn't reopen the picker.
    expect(router.history.length).toBe(1);
    expect(
      screen.getByRole("heading", { name: /Pick a conversation/, hidden: true }),
    ).toBeInTheDocument();
  });

  it("opens the project picker when /?new is pushed onto an open /", async () => {
    const router = renderApp("/", { desktop: true });
    await screen.findByRole("heading", { name: /Pick a conversation/ });
    expect(screen.queryByTestId("project-picker")).toBeNull();
    act(() => router.history.push("/?new=1"));
    expect(await screen.findByTestId("project-picker")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.searchStr).toBe(""));
  });

  it("toggles the sidebar on a conversation route; the header has no back chevron", async () => {
    renderApp("/agents/a1", { desktop: true });
    const header = (await screen.findByRole("heading", { name: "Alpha work" })).closest("header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).queryByRole("link", { name: "Home" })).toBeNull();
    expect(
      within(header as HTMLElement).queryByRole("button", { name: "Conversations" }),
    ).toBeNull();

    const user = userEvent.setup();
    await user.click(toggle());
    expect(sidebar()).toBeNull();
    expect(screen.getByRole("heading", { name: "Alpha work" })).toBeInTheDocument();
    await user.click(toggle());
    expect(sidebar()).toBeInTheDocument();
  });

  it("toggles the sidebar on a non-conversation route", async () => {
    renderApp("/settings", { desktop: true });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(toggle());
    expect(sidebar()).toBeNull();
    await user.click(toggle());
    expect(sidebar()).toBeInTheDocument();
  });

  it("keeps focus on the toggle and reports the sidebar's state", async () => {
    renderApp("/settings", { desktop: true });
    await screen.findByRole("heading", { name: "Settings" });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveAttribute("aria-controls", "app-sidebar");
    expect(document.getElementById("app-sidebar")).toContainElement(sidebar());

    const user = userEvent.setup();
    toggle().focus();
    await user.keyboard("{Enter}");
    expect(sidebar()).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(sidebar()).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveFocus();
  });

  it("has the keyboard shortcuts button beside the toggle, docked and in the rail", async () => {
    renderApp("/settings", { desktop: true });
    await screen.findByRole("heading", { name: "Settings" });
    const shortcuts = () => screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(shortcuts()).toHaveAttribute("title", "Keyboard shortcuts");
    expect(shortcuts().parentElement).toBe(toggle().parentElement);
    expect(toggle().nextElementSibling).toBe(shortcuts());
    expect(shortcuts()).toHaveClass("ml-auto");

    const user = userEvent.setup();
    await user.click(toggle());
    expect(toggle().nextElementSibling).toBe(shortcuts());
    await user.click(shortcuts());
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  describe("sidebar shortcut", () => {
    beforeEach(() => stubUserAgent(USER_AGENTS.macChrome));

    it("hides and shows the sidebar with ⌘J B and ⌘B", async () => {
      renderApp("/settings", { desktop: true });
      await screen.findByRole("heading", { name: "Settings" });
      expect(leaderB()).toBe(false);
      expect(sidebar()).toBeNull();
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(leaderB()).toBe(false);
      expect(sidebar()).toBeInTheDocument();
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(cmdB()).toBe(false);
      expect(sidebar()).toBeNull();
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(cmdB()).toBe(false);
      expect(sidebar()).toBeInTheDocument();
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });

    it("leaves focus outside the sidebar where it is", async () => {
      renderApp("/", { desktop: true });
      const main = (await screen.findByRole("heading", { name: /Pick a conversation/ }))
        .parentElement as HTMLElement;
      const newConversation = within(main).getByRole("button", { name: "New conversation" });
      newConversation.focus();
      cmdB();
      expect(sidebar()).toBeNull();
      expect(newConversation).toHaveFocus();
      cmdB();
      expect(sidebar()).toBeInTheDocument();
      expect(newConversation).toHaveFocus();
    });

    it("moves focus inside the sidebar to the toggle", async () => {
      renderApp("/settings", { desktop: true });
      const nav = await screen.findByRole("navigation", { name: "Conversations" });
      within(nav).getByRole("link", { name: "Settings" }).focus();
      cmdB();
      expect(sidebar()).toBeNull();
      expect(toggle()).toHaveFocus();
      cmdB();
      expect(sidebar()).toBeInTheDocument();
      expect(toggle()).toHaveFocus();
    });
  });

  it("has no back-to-Home chevron on settings and sessions", async () => {
    renderApp("/settings", { desktop: true });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    cleanup();
    renderApp("/sessions", { desktop: true });
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
  });

  it("keeps the sidebar across routes and has settings in its footer", async () => {
    const router = renderApp("/", { desktop: true });
    sendBaseline([alpha]);
    const nav = await screen.findByRole("navigation", { name: "Conversations" });
    const user = userEvent.setup();
    await user.click(await within(await active(nav)).findByRole("link", { name: /Alpha work/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
    await user.click(within(nav).getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(sidebar()).toBe(nav);
  });

  it("keeps the sidebar usable, and lets Tab leave, while a trust prompt is pending", async () => {
    const untrusted = makeAgent({ ...alpha, status: "awaiting_trust" });
    const router = renderApp("/agents/a1", { desktop: true, agents: [untrusted, beta] });
    sendBaseline([untrusted, beta]);
    const prompt = await screen.findByTestId("trust-sheet");
    // Scoped to the conversation column, not the page.
    const column = screen
      .getByRole("heading", { name: "Alpha work" })
      .closest("header")?.parentElement;
    expect(column).toContainElement(prompt);

    const user = userEvent.setup();
    within(prompt).getByRole("button", { name: "Trust" }).focus();
    await user.tab();
    expect(prompt).not.toContainElement(document.activeElement as HTMLElement);

    const nav = await screen.findByRole("navigation", { name: "Conversations" });
    await user.click(await within(await active(nav)).findByRole("link", { name: /Beta work/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a2"));
    expect(await screen.findByRole("heading", { name: "Beta work" })).toBeInTheDocument();
    expect(screen.queryByTestId("trust-sheet")).toBeNull();
  });
});

describe("phone shell (<1024px)", () => {
  it("has no docked sidebar; / is Home", async () => {
    renderApp("/", { desktop: false });
    expect(await screen.findByRole("heading", { name: "pi-code" })).toBeInTheDocument();
    expect(sidebar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
  });

  it("opens the project picker at /?new and strips the param", async () => {
    const router = renderApp("/?new=1", { desktop: false });
    expect(await screen.findByTestId("project-picker")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.searchStr).toBe(""));
    expect(router.state.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "pi-code", hidden: true })).toBeInTheDocument();
  });

  it("has no sidebar toggle or keyboard shortcuts button on other routes", async () => {
    renderApp("/settings", { desktop: false });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(sidebar()).toBeNull();
    expect(screen.queryByRole("button", { name: /sidebar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("has no sidebar shortcut", async () => {
    stubUserAgent(USER_AGENTS.macChrome);
    renderApp("/settings", { desktop: false });
    await screen.findByRole("heading", { name: "Settings" });
    expect(cmdB()).toBe(true);
    expect(leaderB()).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("⌘J B: not a command");
  });

  it("has back-to-Home chevrons on settings and sessions", async () => {
    renderApp("/settings", { desktop: false });
    expect(await screen.findByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    cleanup();
    renderApp("/sessions", { desktop: false });
    expect(await screen.findByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("opens the sidebar sheet from the conversation header and closes it on selection", async () => {
    const router = renderApp("/agents/a1", { desktop: false });
    const header = (await screen.findByRole("heading", { name: "Alpha work" })).closest("header");
    expect(within(header as HTMLElement).getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/",
    );
    sendBaseline([alpha, beta]);
    const user = userEvent.setup();
    await user.click(within(header as HTMLElement).getByRole("button", { name: "Conversations" }));
    const sheet = await screen.findByRole("dialog", { name: "Conversations" });
    const current = await within(await active(sheet)).findByRole("link", { name: /Alpha work/ });
    expect(current).toHaveAttribute("aria-current", "page");

    await user.click(within(await active(sheet)).getByRole("link", { name: /Beta work/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Beta work" })).toBeInTheDocument();
  });

  it("closes the sheet from its close button", async () => {
    renderApp("/agents/a1", { desktop: false });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Conversations" }));
    const sheet = await screen.findByRole("dialog", { name: "Conversations" });
    expect(within(sheet).queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Close conversations" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
