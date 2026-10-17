import { initialLiveState } from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { hydratedStore, renderWithStore } from "@/test/render";
import { Thinking } from "./thinking";

const row = () => screen.getByTestId("thinking");
const trigger = () => within(row()).getByRole("button");

async function view(ui: ReactNode, store = hydratedStore()) {
  return renderWithStore(ui, store);
}

describe("Thinking", () => {
  it("live: 'Thinking' with shimmer and the latest line as a preview while collapsed", async () => {
    await view(<Thinking live text={"First I'll read the file.\n\nThen run the tests…\n"} />);
    expect(within(row()).getByText("Thinking")).toHaveClass("shimmer");
    expect(screen.getByTestId("thinking-preview")).toHaveTextContent("Then run the tests…");
    expect(screen.getByTestId("thinking-preview")).toHaveClass("truncate");
    await userEvent.setup().click(trigger());
    expect(screen.queryByTestId("thinking-preview")).toBeNull();
    expect(within(row()).getByText(/First I'll read the file\./)).toBeInTheDocument();
  });

  it.each([
    ["first\r\n  second line  \r\n \n\t\n", "second line"],
    ["only", "only"],
    [" \n \n", null],
    ["", null],
  ])("live: previews the last non-blank line, trimmed (%j)", async (text, preview) => {
    await view(<Thinking live text={text} />);
    expect(screen.queryByTestId("thinking-preview")?.textContent ?? null).toBe(preview);
  });

  it("done: 'Thought for 12s' from startedAt / endedAt", async () => {
    await view(<Thinking text="pondering" startedAt={1_000} endedAt={13_400} />);
    expect(trigger()).toHaveTextContent("Thoughtfor 12s");
    expect(within(row()).getByText("Thought")).not.toHaveClass("shimmer");
    expect(screen.queryByTestId("thinking-preview")).toBeNull();
  });

  it("formats a minute or more as '1m 4s', and at least 1s", async () => {
    const { unmount } = await view(<Thinking text="long" startedAt={0} endedAt={64_000} />);
    expect(trigger()).toHaveTextContent("for 1m 4s");
    unmount();
    await view(<Thinking text="quick" startedAt={0} endedAt={200} />);
    expect(trigger()).toHaveTextContent("for 1s");
  });

  it("a committed block reads its duration from thinkingMs", async () => {
    const store = hydratedStore({ live: { ...initialLiveState(), thinkingMs: { "5:0": 3_000 } } });
    await view(<Thinking text="pondering" durationKey="5:0" />, store);
    expect(trigger()).toHaveTextContent("Thoughtfor 3s");
  });

  it("'Thought' without timing", async () => {
    await view(<Thinking text="pondering" durationKey="9:0" />);
    expect(trigger()).toHaveTextContent(/^Thought$/);
  });

  it("'Thought (redacted)' without chevron or body", async () => {
    await view(<Thinking text="" redacted />);
    expect(row()).toHaveTextContent("Thought (redacted)");
    expect(within(row()).queryByRole("button")).toBeNull();
    expect(row().querySelector('[data-slot="row-tail"]')).toBeNull();
  });

  it("an empty finished block renders nothing", async () => {
    await view(<Thinking text="  " />);
    expect(screen.queryByTestId("thinking")).toBeNull();
  });

  it("the expanded body is muted, not italic, behind a hairline", async () => {
    await view(<Thinking text="pondering deeply" />);
    await userEvent.setup().click(trigger());
    const body = within(row()).getByText("pondering deeply");
    expect(body).not.toHaveClass("italic");
    expect(body).toHaveClass("text-muted-foreground", "border-l", "border-input", "text-sm");
  });
});
