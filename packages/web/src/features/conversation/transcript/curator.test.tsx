import type { ServerEvent } from "@pi-code/protocol";
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hydratedStore, renderWithStore } from "@/test/render";
import { ToolCallSlot } from "./tool-call-slot";

const CURATOR_URL = "https://mac.tailnet.ts.net:8443/?session=tok123";

describe("curator event", () => {
  it("shows 'Review in curator' on the matching search call, opening a new tab", async () => {
    const store = hydratedStore();
    await renderWithStore(
      <>
        <ToolCallSlot toolCallId="tc1" toolName="web_search" args={{ query: "vite pwa" }} />
        <ToolCallSlot toolCallId="tc2" toolName="web_search" args={{ query: "other" }} />
      </>,
      store,
    );
    const start = (toolCallId: string): ServerEvent =>
      ({
        type: "pi",
        event: {
          type: "tool_execution_start",
          toolCallId,
          toolName: "web_search",
          args: { query: "vite pwa" },
        },
      }) as ServerEvent;
    act(() => {
      store.getState().apply(start("tc1"), 1);
      store.getState().apply(start("tc2"), 2);
    });
    expect(screen.queryByRole("link", { name: /Review in curator/ })).toBeNull();

    act(() => store.getState().apply({ type: "curator", toolCallId: "tc1", url: CURATOR_URL }, 3));
    const links = await screen.findAllByRole("link", { name: /Review in curator/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", CURATOR_URL);
    expect(links[0]).toHaveAttribute("target", "_blank");
  });
});
