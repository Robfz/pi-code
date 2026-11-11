/**
 * A changed file's parts shared by the Changes and Guide tabs (`docs/design/07-code-review.md`,
 * "Changes tab"): the collapse limits, the references its lines send, the status badge, the path,
 * `+n −m` or why the file has no hunks, and the collapsible card holding a file's patch under a
 * sticky header.
 */

import type { CodeRef, GitDiffResponse, GitFileDiff, PrGuideNoHunks } from "@pi-code/protocol";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useRef } from "react";
import type { LineSelection } from "@/components/diff";
import { cn } from "@/lib/utils";
import { splitPath } from "./files-view";

/**
 * Every expanded file mounts a diff view, so past these totals (files, or added plus deleted
 * lines) the files start collapsed and open from the list or their header.
 */
export const EXPAND_MAX_FILES = 30;
export const EXPAND_MAX_LINES = 3000;

/**
 * The reference for lines of `file`: old-side lines name the old commit; new-side lines name the
 * new commit when it isn't on disk (`pinned`, a PR's head) or the working tree differs from it.
 */
export function changeReference(
  file: Pick<GitFileDiff, "path" | "oldPath" | "worktreeChanged">,
  { oldRev, newRev }: Pick<GitDiffResponse, "oldRev" | "newRev">,
  { side, start, end }: LineSelection,
  pinned = false,
): CodeRef {
  const ref: CodeRef =
    side === "old"
      ? { path: file.oldPath ?? file.path, start, end }
      : { path: file.path, start, end };
  const rev = side === "old" ? oldRev : pinned || file.worktreeChanged ? newRev : undefined;
  if (rev !== undefined) ref.rev = rev;
  return ref;
}

type FileStatus = GitFileDiff["status"];

const STATUS: Record<FileStatus, { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "Added", className: "bg-diff-add/12 text-diff-add" },
  untracked: { letter: "U", label: "Untracked", className: "bg-diff-add/12 text-diff-add" },
  modified: {
    letter: "M",
    label: "Modified",
    className: "bg-status-input/12 text-status-input",
  },
  deleted: { letter: "D", label: "Deleted", className: "bg-diff-del/12 text-diff-del" },
  renamed: { letter: "R", label: "Renamed", className: "bg-muted text-muted-foreground" },
};

export function StatusBadge({ status }: { status: FileStatus }) {
  const { letter, label, className } = STATUS[status] ?? STATUS.modified;
  return (
    <span
      title={label}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] leading-none font-semibold",
        className,
      )}
    >
      <span aria-hidden>{letter}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The directory muted and the basename in front; the basename is the last to truncate. */
export function FilePath({ file }: { file: Pick<GitFileDiff, "path" | "oldPath"> }) {
  const { dir, name } = splitPath(file.path);
  const renamed = file.oldPath !== undefined && file.oldPath !== file.path;
  return (
    <span
      title={renamed ? `${file.oldPath} → ${file.path}` : file.path}
      className="flex min-w-0 flex-1 font-mono text-xs"
    >
      {renamed && (
        <>
          <span className="min-w-0 truncate text-muted-foreground">{file.oldPath}</span>
          <span aria-hidden className="shrink-0 px-1 text-faint-foreground">
            →
          </span>
        </>
      )}
      {dir && <span className="min-w-0 truncate text-muted-foreground">{dir}/</span>}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

export function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-diff-add">+{additions}</span>{" "}
      <span className="text-diff-del">−{deletions}</span>
    </span>
  );
}

const NO_HUNKS: Record<PrGuideNoHunks, string> = {
  binary: "binary",
  tooLarge: "too large",
  noContent: "no content change",
};

/** Why a file shows no hunks, in place of its counts. */
export function NoHunks({ reason }: { reason: PrGuideNoHunks }) {
  return <span className="shrink-0 text-xs text-muted-foreground">{NO_HUNKS[reason]}</span>;
}

/**
 * A file's patch under a header that sticks to the top of the panel's scroll area (at
 * `headerClassName`'s `top`, `top-0` by default) and toggles the patch.
 */
export function FileCard({
  file,
  aside,
  open,
  onOpenChange,
  cardRef,
  className,
  headerClassName,
  children,
}: {
  file: Pick<GitFileDiff, "path" | "oldPath" | "status">;
  /** After the path: the counts. */
  aside: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  cardRef?(element: HTMLElement | null): void;
  className?: string;
  headerClassName?: string;
  /** The body, shown while open. */
  children: ReactNode;
}) {
  const section = useRef<HTMLElement | null>(null);
  const header = useRef<HTMLDivElement>(null);
  const toggle = () => {
    // Collapsing a file whose header is stuck would leave the view somewhere past it.
    const top = section.current?.getBoundingClientRect().top;
    const headerTop = header.current?.getBoundingClientRect().top;
    if (open && top !== undefined && headerTop !== undefined && headerTop > top) {
      section.current?.scrollIntoView({ block: "start" });
    }
    onOpenChange(!open);
  };
  return (
    <section
      ref={(element) => {
        section.current = element;
        cardRef?.(element);
      }}
      data-testid="diff-file"
      data-path={file.path}
      className={className}
    >
      <div
        ref={header}
        className={cn(
          "sticky top-0 z-20 flex h-9 items-center gap-2 bg-background pr-3 pl-2 in-data-[region=side]:bg-surface-side",
          open && "border-b",
          headerClassName,
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRightIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <StatusBadge status={file.status} />
          <FilePath file={file} />
        </button>
        {aside}
      </div>
      {open && children}
    </section>
  );
}
