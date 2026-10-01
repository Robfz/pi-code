import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "@/test/fixtures";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { AgentStatePanel, TrustSheet } from "./agent-state";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent lifecycle states", () => {
  it("trust sheet posts the answer; the agent_status event moves the agent on", async () => {
    const { calls } = stubFetch((call) =>
      call.url === "/api/agents/a1/trust"
        ? [200, { agent: makeAgent({ status: "starting" }) }]
        : undefined,
    );
    const store = hydratedStore({
      agent: makeAgent({ status: "awaiting_trust", trustPrompt: { cwd: "/home/me/untrusted" } }),
    });
    await renderWithStore(<TrustSheet />, store);
    expect(screen.getByTestId("trust-sheet")).toHaveTextContent("/home/me/untrusted");
    await userEvent.setup().click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/agents/a1/trust")?.body).toEqual({ trusted: true }),
    );
    // The response alone doesn't change the store: SSE is authoritative.
    expect(store.getState().agent.status).toBe("awaiting_trust");
    act(() =>
      store.getState().apply({ type: "agent_status", agent: makeAgent({ status: "starting" }) }, 1),
    );
    await waitFor(() => expect(screen.queryByTestId("trust-sheet")).toBeNull());
  });

  it("trust sheet can decline", async () => {
    const { calls } = stubFetch(() => [200, { agent: makeAgent({ status: "starting" }) }]);
    await renderWithStore(
      <TrustSheet />,
      hydratedStore({ agent: makeAgent({ status: "awaiting_trust" }) }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Don't trust" }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ trusted: false }));
  });

  it("shows the starting state", async () => {
    await renderWithStore(
      <AgentStatePanel />,
      hydratedStore({ agent: makeAgent({ status: "starting" }) }),
    );
    expect(screen.getByTestId("agent-starting")).toHaveTextContent("Starting pi…");
  });

  it("exited: shows the stderr tail, restarts and closes", async () => {
    const { calls } = stubFetch((call) =>
      call.url === "/api/agents/a1/restart"
        ? [200, { agent: makeAgent({ status: "starting" }) }]
        : [204, null],
    );
    const store = hydratedStore({
      agent: makeAgent({ status: "exited", exitCode: 1, stderrTail: ["boom", "stack line"] }),
    });
    const { router } = await renderWithStore(<AgentStatePanel />, store);
    const panel = screen.getByTestId("agent-exited");
    expect(panel).toHaveTextContent("pi exited with code 1");
    expect(panel).toHaveTextContent("boom");
    expect(panel).toHaveTextContent("stack line");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Restart/ }));
    await waitFor(() =>
      expect(calls.map((c) => [c.method, c.url])).toContainEqual([
        "POST",
        "/api/agents/a1/restart",
      ]),
    );
    expect(store.getState().agent.status).toBe("exited");

    await user.click(await screen.findByRole("button", { name: /Close/ }));
    await waitFor(() =>
      expect(calls.map((c) => [c.method, c.url])).toContainEqual(["DELETE", "/api/agents/a1"]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
