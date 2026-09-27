import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { createQueryClient } from "./lib/query-client.ts";
import { createAppRouter } from "./router.tsx";
import { makeAgent, makeSnapshot } from "./test/fixtures.ts";
import { stubFetch } from "./test/render.tsx";

class NoopEventSource {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

function renderApp(path = "/") {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("home lists open agents", async () => {
    stubFetch((call) =>
      call.url === "/api/agents"
        ? [
            200,
            {
              agents: [
                makeAgent({ id: "a1", cwd: "/home/me/alpha", attention: "finished" }),
                makeAgent({
                  id: "a2",
                  cwd: "/home/me/beta",
                  sessionName: "Refactor",
                  isStreaming: true,
                }),
              ],
            },
          ]
        : undefined,
    );
    renderApp();
    expect(await screen.findByRole("heading", { name: "pi-code" })).toBeInTheDocument();
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("Refactor")).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /alpha/ })).toHaveAttribute("href", "/agents/a1");
  });

  it("starts a new conversation from a folder path and opens it", async () => {
    vi.stubGlobal("EventSource", NoopEventSource);
    const { calls } = stubFetch((call) => {
      if (call.url === "/api/agents" && call.method === "GET") return [200, { agents: [] }];
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
    expect(await screen.findByText("No open conversations.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    await user.type(await screen.findByLabelText("Folder path"), "/home/me/gamma");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/new1"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd: "/home/me/gamma" });
    expect(await screen.findByRole("heading", { name: "gamma" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("shows open errors inline", async () => {
    stubFetch((call) =>
      call.method === "POST"
        ? [400, { error: { code: "outside_home", message: "path is outside $HOME" } }]
        : [200, { agents: [] }],
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

  it("renders placeholder routes", async () => {
    stubFetch();
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
