import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LineSelection } from "@/components/diff";
import { stubCanvas } from "@/components/diff/testing";
import { Composer } from "@/features/conversation/composer";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { ConversationStoreProvider } from "@/store/context";
import { useDrafts } from "@/store/drafts";
import { useUiPrefs } from "@/store/ui-prefs";
import { stubMatchMedia } from "@/test/dom-stubs";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { fixtureToolCall, propsAt } from "@/tools/testing";
import { ToolCallView } from "@/tools/tool-call-view";
import { SelectableDiff } from "./selectable-diff";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { error: vi.fn() }) };
});

beforeAll(stubCanvas);
afterEach(() => {
  useUiPrefs.setState({ toolsExpanded: false });
  vi.unstubAllGlobals();
  vi.mocked(toast.error).mockClear();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const desktop = () => stubMatchMedia((query) => query === DESKTOP_QUERY);
const phone = () => stubMatchMedia(() => false);

/** Old lines 1–4, new lines 1–5: line 2 changed, line 4 added. */
const patch = [
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

const toA = ({ start, end }: LineSelection) => ({ path: "a.ts", start, end });

/** Render inside a conversation store (agent `a1`, cwd `/home/me/project`). */
function renderDiff(ui: ReactNode) {
  const store = hydratedStore();
  return render(ui, {
    wrapper: ({ children }) => (
      <ConversationStoreProvider store={store}>{children}</ConversationStoreProvider>
    ),
  });
}

const draftText = () => useDrafts.getState().drafts.a1?.text;
const bar = () => screen.queryByRole("toolbar", { name: "Line selection" });

/** The line-number span of a side's line under `root`, once the view has rendered its rows. */
function lineNumber(side: "old" | "new", line: number, root: ParentNode = document) {
  return waitFor(() => {
    const span = root.querySelector<HTMLElement>(`[data-line-${side}-num="${line}"]`);
    if (!span) throw new Error(`no ${side} line ${line}`);
    return span;
  });
}

async function tap(side: "old" | "new", line: number, root?: ParentNode) {
  const span = await lineNumber(side, line, root);
  fireEvent.mouseDown(span);
  fireEvent.mouseUp(span);
}

/**
 * One synchronous gesture once both lines are rendered: until the view's first frame, a pending
 * selection sync (`whenRendered`) would clear a drag still in progress.
 */
async function drag(side: "old" | "new", from: number, to: number) {
  const start = await lineNumber(side, from);
  const end = await lineNumber(side, to);
  fireEvent.mouseDown(start);
  fireEvent.mouseOver(end);
  fireEvent.mouseUp(end);
}

/** New-side numbers of the marked rows under `root` (old-side for deleted rows, as `old:N`). */
function marked(root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll(".diff-line-num.diff-multi-select-active")).map(
    (cell) =>
      cell.querySelector("[data-line-new-num]")?.getAttribute("data-line-new-num") ??
      `old:${cell.querySelector("[data-line-old-num]")?.getAttribute("data-line-old-num")}`,
  );
}

function editCall(path: string) {
  const call = fixtureToolCall("tool-calls", "edit");
  return { ...propsAt(call, "end"), args: { ...(call.args as object), path } };
}

describe("SelectableDiff on desktop", () => {
  it("inserts a clicked line of a tool diff and focuses the composer", async () => {
    desktop();
    stubFetch();
    useUiPrefs.setState({ toolsExpanded: true });
    await renderWithStore(
      <>
        <Composer />
        <ToolCallView {...editCall("notes.txt")} />
      </>,
      hydratedStore(),
    );
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).not.toHaveFocus();
    await tap("new", 2);
    expect(box).toHaveValue("@notes.txt:2 ");
    expect(box).toHaveFocus();
    expect(bar()).toBeNull();
  });

  it("inserts a dragged range", async () => {
    desktop();
    const onAdded = vi.fn();
    renderDiff(<SelectableDiff patch={patch} toReference={toA} onAdded={onAdded} />);
    await drag("new", 4, 1);
    expect(draftText()).toBe("@a.ts:1-4 ");
    expect(onAdded).toHaveBeenCalledOnce();
  });

  it("inserts an absolute tool path inside the cwd relative to it", async () => {
    desktop();
    useUiPrefs.setState({ toolsExpanded: true });
    renderDiff(<ToolCallView {...editCall("/home/me/project/src/notes.txt")} />);
    await tap("new", 1);
    expect(draftText()).toBe("@src/notes.txt:1 ");
  });

  it("shows a toast instead of inserting a path that can't be written", async () => {
    desktop();
    renderDiff(
      <SelectableDiff patch={patch} toReference={(s) => ({ ...toA(s), path: 'a"b.ts' })} />,
    );
    await tap("new", 1);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(draftText()).toBeUndefined();
  });
});

describe("SelectableDiff on phone", () => {
  it("selects a range with two taps and adds it to the chat", async () => {
    phone();
    const onAdded = vi.fn();
    renderDiff(<SelectableDiff patch={patch} toReference={toA} onAdded={onAdded} />);
    await tap("new", 3);
    expect(bar()).toHaveTextContent("Tap the last line");
    expect(within(bar() as HTMLElement).queryByRole("button", { name: "Add to chat" })).toBeNull();
    await waitFor(() => expect(marked()).toEqual(["3"]));

    await tap("new", 1);
    expect(bar()).toHaveTextContent("@a.ts:1-3");
    await waitFor(() => expect(marked()).toEqual(["1", "2", "3"]));
    expect(draftText()).toBeUndefined();

    await userEvent.setup().click(screen.getByRole("button", { name: "Add to chat" }));
    expect(draftText()).toBe("@a.ts:1-3 ");
    expect(onAdded).toHaveBeenCalledOnce();
    expect(bar()).toBeNull();
    await waitFor(() => expect(marked()).toEqual([]));
  });

  it("Cancel clears the bar and the mark", async () => {
    phone();
    renderDiff(<SelectableDiff patch={patch} toReference={toA} />);
    await tap("new", 2);
    await tap("new", 4);
    await waitFor(() => expect(marked()).toEqual(["2", "3", "4"]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(bar()).toBeNull();
    await waitFor(() => expect(marked()).toEqual([]));
    expect(draftText()).toBeUndefined();
  });

  it("restarts on a tap on the other side, and on a third tap", async () => {
    phone();
    renderDiff(<SelectableDiff patch={patch} toReference={toA} />);
    await tap("new", 1);
    await tap("old", 2);
    expect(bar()).toHaveTextContent("Tap the last line");
    await waitFor(() => expect(marked()).toEqual(["old:2"]));
    await tap("new", 3);
    expect(bar()).toHaveTextContent("Tap the last line");
    await tap("new", 5);
    expect(bar()).toHaveTextContent("@a.ts:3-5");
    await tap("new", 1);
    expect(bar()).toHaveTextContent("Tap the last line");
    await waitFor(() => expect(marked()).toEqual(["1"]));
    await tap("new", 1);
    expect(bar()).toHaveTextContent("@a.ts:1");
  });

  it("takes a drag as the range directly", async () => {
    phone();
    renderDiff(<SelectableDiff patch={patch} toReference={toA} />);
    await drag("new", 2, 4);
    expect(bar()).toHaveTextContent("@a.ts:2-4");
    await waitFor(() => expect(marked()).toEqual(["2", "3", "4"]));
  });

  it("keeps one pending selection across diffs", async () => {
    phone();
    renderDiff(
      <>
        <div data-testid="first">
          <SelectableDiff patch={patch} toReference={toA} />
        </div>
        <div data-testid="second">
          <SelectableDiff
            patch={patch.replaceAll("a.ts", "b.ts")}
            toReference={(s) => ({ ...toA(s), path: "b.ts" })}
          />
        </div>
      </>,
    );
    const first = screen.getByTestId("first");
    const second = screen.getByTestId("second");
    await tap("new", 1, first);
    await waitFor(() => expect(marked(first)).toEqual(["1"]));
    await tap("new", 3, second);
    await waitFor(() => expect(marked(first)).toEqual([]));
    expect(marked(second)).toEqual(["3"]);
    await tap("new", 5, second);
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
    expect(bar()).toHaveTextContent("@b.ts:3-5");
  });

  it("clears the pending selection on a new patch, and keeps selecting after re-renders", async () => {
    phone();
    const { rerender } = renderDiff(<SelectableDiff patch={patch} toReference={toA} />);
    await tap("new", 1);
    expect(bar()).not.toBeNull();
    const longer = patch.replace("@@ -1,4 +1,5 @@", "@@ -1,4 +1,6 @@").concat("+five\n");
    rerender(<SelectableDiff patch={longer} toReference={toA} />);
    await waitFor(() => expect(bar()).toBeNull());

    rerender(<SelectableDiff patch={longer} toReference={(s) => toA(s)} />);
    await tap("new", 6);
    await tap("new", 4);
    expect(bar()).toHaveTextContent("@a.ts:4-6");
    await waitFor(() => expect(marked()).toEqual(["4", "5", "6"]));
  });

  it("marks the highlight while nothing is pending", async () => {
    phone();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderDiff(
      <SelectableDiff patch={patch} toReference={toA} highlight={{ start: 4, end: 5, nonce: 1 }} />,
    );
    await waitFor(() => expect(marked()).toEqual(["4", "5"]));
    expect(scrollIntoView).toHaveBeenCalled();
    await tap("new", 1);
    await waitFor(() => expect(marked()).toEqual(["1"]));
    await act(() => userEvent.setup().click(screen.getByRole("button", { name: "Cancel" })));
    await waitFor(() => expect(marked()).toEqual(["4", "5"]));
  });
});
