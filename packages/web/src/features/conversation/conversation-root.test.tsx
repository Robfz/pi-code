import type { StreamedSession } from "@pi-code/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { LiveRegistry } from "@/store/live-registry";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";

function renderAgent(snapshotStatus = 200) {
  const api = stubFetch((call) => {
    if (call.url === "/api/agents/a1/snapshot") {
      return snapshotStatus === 200
        ? [
            200,
            makeSnapshot({
              agent: makeAgent({ id: "a1", cwd: "/home/me/alpha", sessionFile: "/s/a1.jsonl" }),
            }),
          ]
        : [snapshotStatus, { error: { code: "agent_not_found", message: "no agent" } }];
    }
    if (call.url === "/api/agents" && call.method === "POST") {
      return [200, { agent: makeAgent({ id: "a2", cwd: "/home/me/alpha" }) }];
    }
    return undefined;
  });
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/agents/a1"] }),
  });
  render(<App router={router} queryClient={createQueryClient()} />);
  const acks = () => api.calls.filter((c) => c.method === "POST" && c.url === "/api/agents/a1/ack");
  const opens = () =>
    api.calls.filter((c) => c.method === "POST" && c.url === "/api/agents").map((c) => c.body);
  return { router, acks, opens };
}

function catalog(patch: Partial<StreamedSession> = {}) {
  sendFrame({
    type: "catalog",
    sessions: [
      {
        file: "/s/a1.jsonl",
        id: "s1",
        cwd: "/home/me/alpha",
        createdAt: "2026-01-01T00:00:00.000Z",
        ...patch,
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConversationRoot", () => {
  it("acks the conversation on mount, on visible, and on attention while focused", async () => {
    const { acks } = renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(acks()).toHaveLength(1);

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(acks()).toHaveLength(2);

    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    sendFrame({ type: "agent", agent: makeAgent({ id: "a1", attention: "finished" }) });
    await waitFor(() => expect(acks()).toHaveLength(3));
  });

  it("acks attention raised while unfocused once the window is focused", async () => {
    const { acks } = renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(acks()).toHaveLength(1);

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    sendFrame({ type: "agent", agent: makeAgent({ id: "a1", attention: "finished" }) });
    expect(acks()).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(acks()).toHaveLength(2);
  });

  it("shows its store while mounted", async () => {
    const shown: string[] = [];
    const show = LiveRegistry.prototype.show;
    vi.spyOn(LiveRegistry.prototype, "show").mockImplementation(function (
      this: LiveRegistry,
      agentId,
    ) {
      shown.push(agentId);
      const leave = show.call(this, agentId);
      return () => {
        shown.splice(shown.indexOf(agentId), 1);
        leave();
      };
    });
    const { router } = renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(shown).toEqual(["a1"]);
    await act(() => router.navigate({ to: "/" }));
    expect(shown).toEqual([]);
  });

  it("shows a conversation closed while on screen, with New conversation", async () => {
    renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    sendFrame({ type: "agent_closed", agentId: "a1" });
    expect(await screen.findByRole("heading", { name: "Conversation closed" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");

    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByLabelText("Folder path")).toBeInTheDocument();
  });

  it("reopens a closed conversation's session", async () => {
    const { router, opens } = renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    catalog();
    sendFrame({ type: "agent_closed", agentId: "a1" });

    await userEvent.setup().click(await screen.findByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a2"));
    expect(opens()).toEqual([{ sessionFile: "/s/a1.jsonl" }]);
  });

  it("offers no Reopen when the session's folder is missing", async () => {
    renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    catalog({ missing: true });
    sendFrame({ type: "agent_closed", agentId: "a1" });
    expect(await screen.findByRole("heading", { name: "Conversation closed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("shows an unknown conversation as closed", async () => {
    renderAgent(404);
    expect(await screen.findByRole("heading", { name: "Conversation closed" })).toBeInTheDocument();
  });
});
