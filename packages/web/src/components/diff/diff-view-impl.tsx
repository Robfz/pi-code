/**
 * The `@git-diff-view/react` view itself, in its own chunk: the library and its highlighter
 * (highlight.js via lowlight) are loaded on first use by `DiffViewer`.
 */

import "@git-diff-view/react/styles/diff-view-pure.css";
import {
  DiffModeEnum,
  DiffView,
  DiffViewWithMultiSelect,
  type DiffViewWithMultiSelectRef,
  type MultiSelectResult,
} from "@git-diff-view/react";
import { useEffect, useMemo, useRef } from "react";
import type { LineSelection } from "./diff-viewer";

/** Frames to wait for the view's rows before giving up on a selection or scroll target. */
const MAX_WAIT_FRAMES = 60;

/** Line number cells of either layout (unified spans, split cells). */
const ROWS_SELECTOR = "[data-line-new-num], [data-line-num]";

function newLineSelector(line: number): string {
  return `[data-line-new-num="${line}"], .diff-line-new-num [data-line-num="${line}"]`;
}

/**
 * Calls `apply` with the first match of `selector` under `root`, now or on a later frame once the
 * view has rendered its rows. Returns a cancel function.
 */
function whenRendered(
  root: HTMLElement,
  selector: string,
  apply: (element: HTMLElement) => void,
): () => void {
  let frames = 0;
  let id = 0;
  const attempt = () => {
    const element = root.querySelector<HTMLElement>(selector);
    if (element) apply(element);
    else if (frames++ < MAX_WAIT_FRAMES) id = requestAnimationFrame(attempt);
  };
  attempt();
  return () => cancelAnimationFrame(id);
}

// A new key per parsed patch remounts the selectable view, so its selection manager follows
// the patch's `DiffFile` (it keeps the one it was created with). The view also remounts on a
// layout change: switching to split swaps the library's row elements one render late, dropping
// the marks applied in between.
let nextViewKey = 0;

export interface DiffViewImplProps {
  oldName: string | null;
  newName: string | null;
  hunks: string[];
  split: boolean;
  dark: boolean;
  onSelectLines?: (selection: LineSelection) => void;
  selection?: LineSelection | null;
  scrollTo?: { line: number; nonce: number };
  /** Both sides' full text, for an all-context patch. */
  content?: string | undefined;
}

export default function DiffViewImpl({
  oldName,
  newName,
  hunks,
  split,
  dark,
  onSelectLines,
  selection,
  scrollTo,
  content,
}: DiffViewImplProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DiffViewWithMultiSelectRef>(null);

  // The library builds a new `DiffFile` (and clears the old one) whenever `data` is a new object.
  const view = useMemo(
    () => ({
      key: nextViewKey++,
      data: {
        oldFile: { fileName: oldName, content: content ?? null },
        newFile: { fileName: newName, content: content ?? null },
        hunks,
      },
    }),
    [oldName, newName, hunks, content],
  );

  // Applied in an effect: on mouseup the library marks the line just selected after calling
  // `onMultiSelectComplete`, which would overwrite a range set from inside that callback.
  const selectionSide = selection?.side;
  const selectionStart = selection?.start;
  const selectionEnd = selection?.end;
  const clearsSelection = selection === null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-applied when the view remounts on a new patch or changes layout
  useEffect(() => {
    const root = rootRef.current;
    if (!root || (selectionSide === undefined && !clearsSelection)) return;
    return whenRendered(root, ROWS_SELECTOR, () => {
      const view = viewRef.current;
      if (!view) return;
      view.clearSelection();
      const range =
        selectionStart === undefined || selectionEnd === undefined
          ? []
          : [selectionStart, selectionEnd];
      view.setPreselectedLines({
        old: selectionSide === "old" ? range : [],
        new: selectionSide === "new" ? range : [],
      });
    });
  }, [view, split, selectionSide, selectionStart, selectionEnd, clearsSelection]);

  const scrollLine = scrollTo?.line;
  const scrollNonce = scrollTo?.nonce;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce scrolls to the same line again
  useEffect(() => {
    const root = rootRef.current;
    if (!root || scrollLine === undefined) return;
    return whenRendered(root, newLineSelector(scrollLine), (cell) =>
      cell.scrollIntoView({ block: "center" }),
    );
  }, [scrollLine, scrollNonce]);

  const props = {
    data: view.data,
    diffViewMode: split ? DiffModeEnum.Split : DiffModeEnum.Unified,
    diffViewTheme: dark ? ("dark" as const) : ("light" as const),
    diffViewWrap: !split,
    diffViewFontSize: 12,
    diffViewHighlight: true,
  };
  return (
    <div ref={rootRef}>
      {onSelectLines ? (
        <DiffViewWithMultiSelect
          key={`${view.key}-${split}`}
          ref={viewRef}
          {...props}
          onMultiSelectComplete={({ range }: MultiSelectResult) =>
            onSelectLines({
              side: range.side,
              start: range.startLineNumber,
              end: range.endLineNumber,
            })
          }
        />
      ) : (
        <DiffView {...props} />
      )}
    </div>
  );
}
