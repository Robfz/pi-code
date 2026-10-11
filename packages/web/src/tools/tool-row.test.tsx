import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTextIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolLabel, ToolStatus } from "./registry";
import { rowParts } from "./testing";
import { ToolRow } from "./tool-row";

const label: ToolLabel = {
  icon: FileTextIcon,
  verb: "Reading",
  target: { kind: "path", text: "src/foo.ts" },
  meta: ":1-10",
};
const row = () => screen.getByTestId("row");

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolRow", () => {
  it.each<[ToolStatus, boolean]>([
    ["streaming", true],
    ["running", true],
    ["done", false],
    ["error", false],
  ])("status %s: shimmer %s", (status, shimmer) => {
    render(<ToolRow data-testid="row" label={label} status={status} />);
    expect(rowParts(row()).shimmer).toBe(shimmer);
  });

  it("shows the label's icon, verb, target with its directory, and meta", () => {
    render(<ToolRow data-testid="row" label={label} status="done" />);
    expect(rowParts(row())).toMatchObject({
      icon: "file-text",
      verb: "Reading",
      target: "foo.tssrc",
      meta: ":1-10",
    });
    // The directory is faint and hidden below 1024px.
    expect(screen.getByText("src")).toHaveClass("text-faint-foreground", "hidden", "lg:inline");
  });

  it("a failed call: alert icon, red verb, the error's first line after the meta", () => {
    render(
      <ToolRow
        data-testid="row"
        label={{ ...label, verb: "Read failed" }}
        status="error"
        error="ENOENT: no such file"
      />,
    );
    expect(rowParts(row())).toMatchObject({
      icon: "circle-alert",
      verb: "Read failed",
      meta: ":1-10 · ENOENT: no such file",
    });
    expect(screen.getByText("Read failed")).toHaveClass("text-status-error");
    expect(row().querySelector("svg")).toHaveClass("text-status-error");
  });

  it("the duration from durationMs", () => {
    const { rerender } = render(
      <ToolRow data-testid="row" label={label} status="done" durationMs={1234} />,
    );
    expect(rowParts(row()).tail).toBe("1.2s");
    rerender(<ToolRow data-testid="row" label={label} status="done" durationMs={12} />);
    expect(rowParts(row()).tail).toBe("12ms");
    rerender(<ToolRow data-testid="row" label={label} status="done" durationMs={64_000} />);
    expect(rowParts(row()).tail).toBe("1m 4s");
    rerender(<ToolRow data-testid="row" label={label} status="done" />);
    expect(rowParts(row()).tail).toBeUndefined();
  });

  it("the elapsed time of a running call, ticking every second", () => {
    vi.useFakeTimers({ now: 100_000 });
    render(<ToolRow data-testid="row" label={label} status="running" startedAt={95_000} />);
    expect(rowParts(row()).tail).toBe("5s");
    act(() => vi.advanceTimersByTime(2000));
    expect(rowParts(row()).tail).toBe("7s");
  });

  it("the Review button under a collapsed row with a curator URL", async () => {
    render(
      <ToolRow
        data-testid="row"
        label={label}
        status="running"
        curatorUrl="https://host.ts.net:8443/?session=x"
      >
        <p>body</p>
      </ToolRow>,
    );
    expect(screen.getByRole("link", { name: /Review in curator/ })).toHaveAttribute(
      "href",
      "https://host.ts.net:8443/?session=x",
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /Reading/ }));
    expect(screen.queryByRole("link", { name: /Review in curator/ })).toBeNull();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});
