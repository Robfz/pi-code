/**
 * Diff viewer (`docs/design/03-web-client.md`, "Diffs"): `@git-diff-view/react`, split once the
 * viewer itself is at least 1024px wide (unified below, whatever the viewport), following the
 * app theme. Large patches are guarded behind a "Show anyway" button; patches the library can't
 * render fall back to plain text. With `onSelectLines`, line numbers are selectable
 * (`docs/design/07-code-review.md`, "Diff viewer").
 */

import { useTheme } from "next-themes";
import { Component, lazy, memo, type ReactNode, Suspense, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parsePatch } from "./parse-patch";
import { useWidthAtLeast } from "./use-width-at-least";

/** Diff body lines above which rendering waits for an explicit "Show anyway". */
export const LARGE_DIFF_LINES = 1500;
const LARGE_DIFF_CHARS = 400_000;

/** Viewer width (px) from which the diff is split. */
const SPLIT_MIN_WIDTH = 1024;

const DiffViewImpl = lazy(() => import("./diff-view-impl"));

class DiffErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PlainPatch({ patch }: { patch: string }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre font-mono text-xs">
      {patch.split("\n").map((line, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static lines of a patch
          key={i}
          className={cn(
            "block",
            line.startsWith("+") && "bg-diff-add/10",
            line.startsWith("-") && "bg-diff-del/10",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

/** Lines of one side of a diff, 1-based and inclusive. */
export interface LineSelection {
  side: "old" | "new";
  start: number;
  end: number;
}

export interface DiffViewerProps {
  /** Unified patch text (one file). */
  patch: string;
  /** Name used for highlighting and headers when the patch has none. */
  fileName?: string;
  className?: string;
  /** Override the large-patch threshold (lines). */
  maxLines?: number;
  /** Makes line numbers selectable: a click selects a line, a drag a range on one side. */
  onSelectLines?: (selection: LineSelection) => void;
  /** Lines to mark; `null` clears the mark; `undefined` leaves the last selection marked. */
  selection?: LineSelection | null;
  /** New-side line to center; a new `nonce` scrolls to it again. */
  scrollTo?: { line: number; nonce: number };
  /** Unified whatever the width. */
  unified?: boolean;
  /**
   * The file's full text, the same on both sides: the library composes no lines from a patch
   * without changes, so an all-context patch (`fileAsPatch`) needs it.
   */
  content?: string;
}

export const DiffViewer = memo(function DiffViewer({
  patch,
  fileName,
  className,
  maxLines = LARGE_DIFF_LINES,
  onSelectLines,
  selection,
  scrollTo,
  unified = false,
  content,
}: DiffViewerProps) {
  const parsed = useMemo(() => parsePatch(patch, fileName), [patch, fileName]);
  const [widthRef, wide] = useWidthAtLeast<HTMLDivElement>(SPLIT_MIN_WIDTH);
  const { resolvedTheme, forcedTheme } = useTheme();
  const [force, setForce] = useState(false);

  if (parsed.binary && parsed.hunks.length === 0) {
    return <p className="text-xs text-muted-foreground">Binary file, no text diff.</p>;
  }
  if (parsed.hunks.length === 0) {
    return <p className="text-xs text-muted-foreground">No changes.</p>;
  }
  const large = parsed.lineCount > maxLines || patch.length > LARGE_DIFF_CHARS;
  if (large && !force) {
    return (
      <div
        data-testid="diff-too-large"
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <span>
          Large diff ({parsed.lineCount} lines, +{parsed.additions} −{parsed.deletions}).
        </span>
        <Button size="sm" variant="outline" onClick={() => setForce(true)}>
          Show anyway
        </Button>
      </div>
    );
  }

  const oldName = parsed.oldName ?? fileName ?? parsed.newName;
  const newName = parsed.newName ?? fileName ?? parsed.oldName;
  const split = wide && !unified;
  return (
    <div
      ref={widthRef}
      data-testid="diff-viewer"
      data-mode={split ? "split" : "unified"}
      className={cn("min-w-0 overflow-hidden rounded-md border text-xs", className)}
    >
      <DiffErrorBoundary fallback={<PlainPatch patch={patch} />}>
        <Suspense fallback={<p className="p-2 text-muted-foreground">Loading diff…</p>}>
          <DiffViewImpl
            oldName={oldName}
            newName={newName}
            hunks={parsed.hunks}
            split={split}
            dark={(forcedTheme ?? resolvedTheme) === "dark"}
            onSelectLines={onSelectLines}
            selection={selection}
            scrollTo={scrollTo}
            content={content}
          />
        </Suspense>
      </DiffErrorBoundary>
    </div>
  );
});
