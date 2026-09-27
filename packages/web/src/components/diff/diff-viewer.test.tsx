import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureEditPatch } from "@/tools/testing";
import { DiffViewer, WIDE_QUERY } from "./diff-viewer";
import { loadedDiff, stubCanvas, stubMatchMedia } from "./testing";

const patch = fixtureEditPatch;

beforeAll(stubCanvas);
afterEach(() => vi.unstubAllGlobals());

describe("DiffViewer", () => {
  it("renders the fixture patch unified on narrow screens", async () => {
    stubMatchMedia(() => false);
    const { container } = render(<DiffViewer patch={patch()} fileName="notes.txt" />);
    expect(await loadedDiff()).toHaveAttribute("data-mode", "unified");
    expect(container.querySelector(".unified-diff-view")).not.toBeNull();
    expect(container.textContent).toContain("I like apple pie.");
    expect(container.textContent).toContain("I like banana bread.");
    expect(container.querySelector('[data-theme="light"]')).not.toBeNull();
  });

  it("switches to split view on wide screens", async () => {
    stubMatchMedia((q) => q === WIDE_QUERY);
    const { container } = render(<DiffViewer patch={patch()} />);
    expect(await loadedDiff()).toHaveAttribute("data-mode", "split");
    expect(container.querySelector(".split-diff-view")).not.toBeNull();
  });

  it("follows the dark theme", async () => {
    stubMatchMedia(() => false);
    const { container } = render(
      <ThemeProvider attribute="class" forcedTheme="dark">
        <DiffViewer patch={patch()} />
      </ThemeProvider>,
    );
    await loadedDiff();
    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull();
  });

  it("guards large patches behind 'Show anyway'", async () => {
    stubMatchMedia(() => false);
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`);
    const big = `--- /dev/null\n+++ big.txt\n@@ -0,0 +1,30 @@\n${lines.join("\n")}\n`;
    render(<DiffViewer patch={big} maxLines={10} />);
    expect(screen.getByTestId("diff-too-large")).toHaveTextContent("Large diff (30 lines, +30 −0)");
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show anyway" }));
    expect(await loadedDiff()).toHaveTextContent("line 29");
  });

  it("handles binary and empty patches", () => {
    stubMatchMedia(() => false);
    const { rerender } = render(
      <DiffViewer patch={"diff --git a/x b/x\nBinary files a/x and b/x differ\n"} />,
    );
    expect(screen.getByText("Binary file, no text diff.")).toBeInTheDocument();
    rerender(<DiffViewer patch="" />);
    expect(screen.getByText("No changes.")).toBeInTheDocument();
  });
});
