import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { stubFetch } from "@/test/render";

function renderAgent(snapshotStatus = 200) {
  const api = stubFetch((call) => {
    if (call.url === "/api/agents/a1/snapshot") {
      return snapshotStatus === 200
        ? [200, makeSnapshot({ agent: makeAgent({ id: "a1", cwd: "/home/me/alpha" }) })]
        : [snapshotStatus, { error: { code: "agent_not_found", message: "no agent" } }];
    }
    return undefined;
  });
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/agents/a1"] }),
  });
  render(<App router={router} queryClient={createQueryClient()} />);
  const acks = () => api.calls.filter((c) => c.method === "POST" && c.url === "/api/agents/a1/ack");
  return { acks };
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

  it("shows a conversation closed while on screen, with New conversation", async () => {
    renderAgent();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    sendFrame({ type: "agent_closed", agentId: "a1" });
    expect(await screen.findByRole("heading", { name: "Conversation closed" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");

    await userEvent.setup().click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByLabelText("Folder path")).toBeInTheDocument();
  });

  it("shows an unknown conversation as closed", async () => {
    renderAgent(404);
    expect(await screen.findByRole("heading", { name: "Conversation closed" })).toBeInTheDocument();
  });
});
