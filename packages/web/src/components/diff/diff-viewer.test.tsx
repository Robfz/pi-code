import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubElementWidth, stubMatchMedia } from "@/test/dom-stubs";
import { fixtureEditPatch } from "@/tools/testing";
import { DiffViewer, type LineSelection } from "./diff-viewer";
import { fileAsPatch } from "./parse-patch";
import { loadedDiff, stubCanvas } from "./testing";

const patch = fixtureEditPatch;

beforeAll(stubCanvas);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("renders a whole file from an all-context patch and its content", async () => {
    const content = "one\ntwo\nthree\n";
    const { container } = render(
      <DiffViewer patch={fileAsPatch("a.ts", content)} content={content} unified />,
    );
    await waitFor(() => expect(container.querySelectorAll("[data-line-new-num]")).toHaveLength(3));
    expect(container.textContent).toContain("three");
  });

  it("splits from 1024px of its own width, even on a narrow viewport", async () => {
    stubMatchMedia(() => false);
    stubElementWidth(1024);
    const { container } = render(<DiffViewer patch={patch()} />);
    expect(await loadedDiff()).toHaveAttribute("data-mode", "split");
    expect(container.querySelector(".split-diff-view")).not.toBeNull();
  });

  it("stays unified at 1023px of its own width, even on a wide viewport", async () => {
    stubMatchMedia(() => true);
    stubElementWidth(1023);
    const { container } = render(<DiffViewer patch={patch()} />);
    expect(await loadedDiff()).toHaveAttribute("data-mode", "unified");
    expect(container.querySelector(".unified-diff-view")).not.toBeNull();
  });

  it("follows its width as it resizes", async () => {
    const width = stubElementWidth(800);
    render(<DiffViewer patch={patch()} />);
    expect(await loadedDiff()).toHaveAttribute("data-mode", "unified");
    act(() => width.resize(1200));
    expect(await loadedDiff()).toHaveAttribute("data-mode", "split");
    act(() => width.resize(1000));
    expect(await loadedDiff()).toHaveAttribute("data-mode", "unified");
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

/** Old lines 1–4, new lines 1–5: line 2 changed, line 4 added. */
const editPatch = [
  "--- a.ts",
  "+++ a.ts",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "+three and a half",
  " four",
  "",
].join("\n");

/** The line-number span of a side's line, once the view has rendered its rows. */
function lineNumber(side: "old" | "new", line: number): Promise<HTMLElement> {
  return waitFor(() => {
    const span = document.querySelector<HTMLElement>(`[data-line-${side}-num="${line}"]`);
    if (!span) throw new Error(`no ${side} line ${line}`);
    return span;
  });
}

async function click(side: "old" | "new", line: number) {
  const span = await lineNumber(side, line);
  fireEvent.mouseDown(span);
  fireEvent.mouseUp(span);
}

/** New-side numbers of the marked rows (old-side for deleted rows, as `old:N`). */
function marked(): string[] {
  return Array.from(document.querySelectorAll(".diff-line-num.diff-multi-select-active")).map(
    (cell) => {
      const line = cell.querySelector("[data-line-new-num]")?.getAttribute("data-line-new-num");
      return (
        line ??
        `old:${cell.querySelector("[data-line-old-num]")?.getAttribute("data-line-old-num")}`
      );
    },
  );
}

/** New-side numbers of the marked rows, in either layout. */
function markedNew(): string[] {
  return Array.from(
    document.querySelectorAll(
      ".diff-line-num.diff-multi-select-active [data-line-new-num], .diff-line-new-num.diff-multi-select-active [data-line-num]",
    ),
  ).map(
    (span) => span.getAttribute("data-line-new-num") ?? span.getAttribute("data-line-num") ?? "",
  );
}

describe("DiffViewer line selection", () => {
  it("reports a click on a line number", async () => {
    const onSelectLines = vi.fn();
    render(<DiffViewer patch={editPatch} onSelectLines={onSelectLines} />);
    await click("new", 3);
    expect(onSelectLines).toHaveBeenLastCalledWith({ side: "new", start: 3, end: 3 });
    await click("old", 2);
    expect(onSelectLines).toHaveBeenLastCalledWith({ side: "old", start: 2, end: 2 });
  });

  it("reports a drag across line numbers as a range on the first side", async () => {
    const onSelectLines = vi.fn();
    render(<DiffViewer patch={editPatch} onSelectLines={onSelectLines} />);
    fireEvent.mouseDown(await lineNumber("new", 4));
    fireEvent.mouseOver(await lineNumber("new", 3));
    fireEvent.mouseOver(await lineNumber("new", 1));
    fireEvent.mouseUp(await lineNumber("new", 1));
    expect(onSelectLines).toHaveBeenCalledOnce();
    expect(onSelectLines).toHaveBeenCalledWith({ side: "new", start: 1, end: 4 });
    expect(marked()).toEqual(["1", "2", "3", "4"]);
  });

  it("keeps reporting after re-renders with a new callback, a theme change and the same patch", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = (onSelectLines: (s: LineSelection) => void, theme: string) => (
      <ThemeProvider attribute="class" forcedTheme={theme}>
        <DiffViewer patch={editPatch} onSelectLines={onSelectLines} />
      </ThemeProvider>
    );
    const { rerender, container } = render(view(first, "light"));
    await click("new", 1);
    rerender(view(second, "light"));
    await click("new", 2);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenLastCalledWith({ side: "new", start: 2, end: 2 });

    rerender(view(second, "dark"));
    await waitFor(() => expect(container.querySelector('[data-theme="dark"]')).not.toBeNull());
    await click("new", 5);
    expect(second).toHaveBeenLastCalledWith({ side: "new", start: 5, end: 5 });
    expect(marked()).toEqual(["5"]);
  });

  it("selects lines of a new patch", async () => {
    const onSelectLines = vi.fn();
    const { rerender } = render(<DiffViewer patch={editPatch} onSelectLines={onSelectLines} />);
    await click("new", 1);
    const longer = editPatch.replace("@@ -1,4 +1,5 @@", "@@ -1,4 +1,6 @@").concat("+five\n");
    rerender(<DiffViewer patch={longer} onSelectLines={onSelectLines} />);
    await click("new", 6);
    expect(onSelectLines).toHaveBeenLastCalledWith({ side: "new", start: 6, end: 6 });
    expect(marked()).toEqual(["6"]);
  });

  it("marks the given selection instead of the clicked line, and clears it with null", async () => {
    function Controlled() {
      const [selection, setSelection] = useState<LineSelection | null>();
      return (
        <>
          <DiffViewer
            patch={editPatch}
            selection={selection}
            onSelectLines={(s) => setSelection({ side: s.side, start: 1, end: s.end })}
          />
          <button type="button" onClick={() => setSelection(null)}>
            Clear
          </button>
        </>
      );
    }
    render(<Controlled />);
    await click("new", 3);
    await waitFor(() => expect(marked()).toEqual(["1", "2", "3"]));
    await click("old", 2);
    await waitFor(() => expect(marked()).toEqual(["1", "old:2"]));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(marked()).toEqual([]));
  });

  it("re-applies the selection after a layout switch", async () => {
    const width = stubElementWidth(800);
    render(
      <DiffViewer
        patch={editPatch}
        selection={{ side: "new", start: 2, end: 3 }}
        onSelectLines={() => {}}
      />,
    );
    await waitFor(() => expect(markedNew()).toEqual(["2", "3"]));
    act(() => width.resize(1200));
    // The split view's final (non-wrapping) rows.
    await waitFor(() => expect(document.querySelector(".split-diff-view-normal")).not.toBeNull());
    await waitFor(() => expect(markedNew()).toEqual(["2", "3"]));
    act(() => width.resize(800));
    expect(await loadedDiff()).toHaveAttribute("data-mode", "unified");
    await waitFor(() => expect(markedNew()).toEqual(["2", "3"]));
  });
});

describe("DiffViewer scrollTo", () => {
  let scrolled: Element[];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("scrolls the new-side line into view once it renders, and again on a new nonce", async () => {
    const { rerender } = render(<DiffViewer patch={editPatch} scrollTo={{ line: 4, nonce: 1 }} />);
    await waitFor(() =>
      expect(scrolled).toEqual([document.querySelector('[data-line-new-num="4"]')]),
    );
    rerender(<DiffViewer patch={editPatch} scrollTo={{ line: 4, nonce: 2 }} />);
    await waitFor(() => expect(scrolled).toHaveLength(2));
  });

  it("scrolls once a large patch is shown anyway", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`);
    const big = `--- /dev/null\n+++ big.txt\n@@ -0,0 +1,30 @@\n${lines.join("\n")}\n`;
    render(<DiffViewer patch={big} maxLines={10} scrollTo={{ line: 25, nonce: 1 }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show anyway" }));
    await waitFor(() =>
      expect(scrolled).toEqual([document.querySelector('[data-line-new-num="25"]')]),
    );
  });
});
