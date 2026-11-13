/**
 * The Files tab's viewer (`docs/design/07-code-review.md`, "Files tab"): a project file's
 * working-tree copy, or its content in a commit (a version-named reference), as an all-context
 * unified diff whose lines send `@path:N-M` references (`@rev:./path:N-M` for a commit's), with
 * an opened reference's lines highlighted and scrolled to.
 */

import { ChevronLeftIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { fileAsPatch, splitLines } from "@/components/diff";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiRequestError } from "@/lib/api";
import { useFileContent } from "./file-content";
import { LoadError, NotARepo } from "./query-states";
import type { FileTarget } from "./review-state";
import { SelectableDiff } from "./selectable-diff";

function Message({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

export function FileViewer({
  agentId,
  path,
  rev,
  target,
  onBack,
  onAdded,
}: {
  agentId: string;
  /** As opened: cwd-relative or absolute. */
  path: string;
  /** Show the file as committed here rather than its working-tree copy. */
  rev?: string;
  target?: FileTarget;
  onBack(): void;
  onAdded?(): void;
}) {
  const file = useFileContent(agentId, path, rev);
  const content = file.data?.content;
  const { patch, lines } = useMemo(
    () =>
      file.data && content !== undefined
        ? { patch: fileAsPatch(file.data.path, content), lines: splitLines(content).length }
        : { patch: "", lines: 0 },
    [file.data, content],
  );
  const pastTheEnd = target !== undefined && content !== undefined && target.end > lines;

  // Once per opened target, not again on refetches.
  const toasted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pastTheEnd || !target || toasted.current === target.nonce) return;
    toasted.current = target.nonce;
    toast(`${file.data?.path ?? path} has only ${lines} ${lines === 1 ? "line" : "lines"}`);
  }, [pastTheEnd, target, lines, file.data?.path, path]);

  let body: ReactNode;
  if (isApiRequestError(file.error, "not_a_git_repo")) {
    body = <NotARepo />;
  } else if (isApiRequestError(file.error, "file_not_found")) {
    body = (
      <Message>
        {rev === undefined ? "This file no longer exists." : `This file isn't in version ${rev}.`}
      </Message>
    );
  } else if (file.data) {
    const shown = file.data.path;
    if (file.data.binary) body = <Message>Binary file, not shown.</Message>;
    else if (file.data.tooLarge)
      body = <Message>This file is too large to show (over 1 MB).</Message>;
    else if (patch === "") body = <Message>This file is empty.</Message>;
    else {
      // Both sides number the same lines: one number column (`diff-theme.css`).
      body = (
        <div className="diff-single-number">
          <SelectableDiff
            patch={patch}
            fileName={shown}
            content={content}
            unified
            toReference={({ start, end }) => ({
              path: shown,
              start,
              end,
              ...(rev !== undefined && { rev }),
            })}
            {...(target && !pastTheEnd && { highlight: target })}
            {...(onAdded && { onAdded })}
          />
        </div>
      );
    }
  } else if (file.isError) {
    body = <LoadError what="the file" error={file.error} onRetry={() => void file.refetch()} />;
  } else {
    body = (
      <div data-testid="file-loading" className="flex flex-col gap-2">
        <Skeleton className="h-4" />
        <Skeleton className="h-4" />
        <Skeleton className="h-4" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Back to search" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <h3 title={path} className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.data?.path ?? path}
        </h3>
        {rev !== undefined && (
          <span
            title={`As committed in ${rev}`}
            className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
          >
            @{rev}
          </span>
        )}
      </div>
      {body}
    </div>
  );
}
