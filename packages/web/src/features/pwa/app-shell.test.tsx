import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { createAppRouter } from "@/router";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendBaseline } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";

const alpha = makeAgent({ id: "a1", cwd: "/home/me/alpha", sessionName: "Alpha work" });
const beta = makeAgent({ id: "a2", cwd: "/home/me/beta", sessionName: "Beta work" });

function renderApp(path: string, { desktop }: { desktop: boolean }) {
  stubMatchMedia((query) => desktop && query === DESKTOP_QUERY);
  stubFetch((call) => {
    const match = /^\/api\/agents\/(a\d)\/snapshot$/.exec(call.url);
    if (match) return [200, makeSnapshot({ agent: match[1] === "a2" ? beta : alpha })];
    return undefined;
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

const sidebar = () => screen.queryByRole("navigation", { name: "Conversations" });
const toggle = () => screen.getByRole("button", { name: "Toggle sidebar" });

afterEach(() => vi.unstubAllGlobals());

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
    await user.click(await within(nav).findByRole("link", { name: /Alpha work/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
    await user.click(within(nav).getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(sidebar()).toBe(nav);
  });
});

describe("phone shell (<1024px)", () => {
  it("has no docked sidebar; / is Home", async () => {
    renderApp("/", { desktop: false });
    expect(await screen.findByRole("heading", { name: "pi-code" })).toBeInTheDocument();
    expect(sidebar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
  });

  it("has no sidebar toggle on other routes", async () => {
    renderApp("/settings", { desktop: false });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(sidebar()).toBeNull();
    expect(screen.queryByRole("button", { name: /sidebar/ })).toBeNull();
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
    const current = await within(sheet).findByRole("link", { name: /Alpha work/ });
    expect(current).toHaveAttribute("aria-current", "page");

    await user.click(within(sheet).getByRole("link", { name: /Beta work/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Beta work" })).toBeInTheDocument();
  });

  it("closes the sheet from its close button", async () => {
    renderApp("/agents/a1", { desktop: false });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Conversations" }));
    const sheet = await screen.findByRole("dialog", { name: "Conversations" });
    await user.click(within(sheet).getByRole("button", { name: "Close conversations" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
