import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { createQueryClient } from "./lib/query-client.ts";
import { createAppRouter } from "./router.tsx";
import { FakeEventSource, sendBaseline } from "./test/fake-event-source.ts";
import { makeAgent, makeSnapshot } from "./test/fixtures.ts";
import { stubFetch } from "./test/render.tsx";

function renderApp(path = "/") {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("home lists open agents from the live stream", async () => {
    const { calls } = stubFetch();
    renderApp();
    expect(await screen.findByRole("heading", { name: "pi-code" })).toBeInTheDocument();
    sendBaseline([
      makeAgent({ id: "a1", cwd: "/home/me/alpha", attention: "finished" }),
      makeAgent({ id: "a2", cwd: "/home/me/beta", sessionName: "Refactor", isStreaming: true }),
    ]);
    // The folder's header and its agent's row (titled by the folder until it has a name).
    expect(await screen.findAllByText("alpha")).toHaveLength(2);
    expect(screen.getByText("Refactor")).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /alpha/ })).toHaveAttribute("href", "/agents/a1");
    expect(calls.some((c) => c.url === "/api/agents")).toBe(false);
    expect(calls.some((c) => c.url === "/api/sessions")).toBe(true);
  });

  it("doesn't show an empty home before the first baseline", async () => {
    stubFetch();
    renderApp();
    expect(await screen.findByRole("heading", { name: "pi-code" })).toBeInTheDocument();
    expect(screen.queryByText("No open conversations.")).toBeNull();
    act(() => FakeEventSource.latest().drop());
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("No open conversations.")).toBeNull();
    sendBaseline([]);
    expect(await screen.findByText("No open conversations.")).toBeInTheDocument();
  });

  it("starts a new conversation from a folder path and opens it", async () => {
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/agents" && call.method === "POST") {
        return [
          201,
          { agent: makeAgent({ id: "new1", status: "starting", cwd: "/home/me/gamma" }) },
        ];
      }
      if (call.url === "/api/agents/new1/snapshot") {
        return [200, makeSnapshot({ agent: makeAgent({ id: "new1", cwd: "/home/me/gamma" }) })];
      }
      return undefined;
    });
    const router = renderApp();
    const user = userEvent.setup();
    sendBaseline([]);
    expect(await screen.findByText("No open conversations.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    await user.type(await screen.findByLabelText("Folder path"), "/home/me/gamma");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/new1"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd: "/home/me/gamma" });
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(screen.getByTestId("breadcrumb-folder")).toHaveTextContent("gamma");
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("shows open errors inline", async () => {
    stubFetch((call) =>
      call.method === "POST"
        ? [400, { error: { code: "outside_home", message: "path is outside $HOME" } }]
        : undefined,
    );
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New conversation" }));
    await user.type(await screen.findByLabelText("Folder path"), "/etc");
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(
      await within(screen.getByTestId("project-picker")).findByText("path is outside $HOME"),
    ).toBeInTheDocument();
  });

  it("opens one stream and fetches each snapshot once under StrictMode", async () => {
    const { calls } = stubFetch((call) =>
      call.url === "/api/agents/a1/snapshot"
        ? [200, makeSnapshot({ agent: makeAgent({ id: "a1", cwd: "/home/me/alpha" }) })]
        : undefined,
    );
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/agents/a1"] }),
    });
    render(
      <StrictMode>
        <App router={router} queryClient={createQueryClient()} />
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.latest().cursors).toBe("a1:0"));
    expect(FakeEventSource.instances.filter((es) => !es.closed)).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/agents/a1/snapshot")).toHaveLength(1);
  });

  it("renders placeholder routes", async () => {
    stubFetch();
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
