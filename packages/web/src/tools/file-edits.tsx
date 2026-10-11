/**
 * Renderers for pi's `edit` and `write` tools: `+n −m` from the edit's `details.patch` and the
 * patch in the diff viewer; written content as an all-added diff. Selected lines become
 * references to the tool's path as shown, never versioned (`docs/design/07-code-review.md`).
 */

import type { EditToolDetails } from "@pi-code/protocol";
import { useMemo } from "react";
import { allAddedPatch, countPatchLines } from "@/components/diff";
import { SelectableDiff } from "@/features/review/selectable-diff";
import { toolResultText } from "@/lib/content";
import { cwdRelative } from "@/lib/paths";
import { useConversation } from "@/store/context";
import { argPath, asRecord, ErrorOutput, isActive, Muted, Notice, Pending, str } from "./common";
import { registerToolRenderer, type ToolRenderer, type ToolRendererProps } from "./registry";

function editPatch(result: ToolRendererProps["result"]): string | undefined {
  const patch = (result?.details as Partial<EditToolDetails> | undefined)?.patch;
  return typeof patch === "string" && patch !== "" ? patch : undefined;
}

/** A tool diff whose selections reference `path` (the tool's argument), made cwd-relative. */
function ToolDiff({ patch, path, fileName }: { patch: string; path: string; fileName?: string }) {
  const cwd = useConversation((s) => s.agent.cwd);
  const refPath = cwdRelative(path, cwd);
  return (
    <SelectableDiff
      patch={patch}
      fileName={fileName}
      toReference={({ start, end }) => ({ path: refPath, start, end })}
    />
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-sans tabular-nums">
      {" "}
      <span className="text-diff-add">+{additions}</span>{" "}
      <span className="text-diff-del">−{deletions}</span>
    </span>
  );
}

function EditSummary({ args, result, isError }: ToolRendererProps) {
  const path = argPath(args);
  const patch = isError ? undefined : editPatch(result);
  const counts = useMemo(() => (patch ? countPatchLines(patch) : undefined), [patch]);
  return (
    <span className="font-mono">
      {path}
      {counts && <Counts {...counts} />}
    </span>
  );
}

function editCount(args: unknown): number {
  const edits = asRecord(args)?.edits;
  if (Array.isArray(edits)) return edits.length;
  return str(args, "oldText") !== undefined || str(args, "old_string") !== undefined ? 1 : 0;
}

function EditBody({ args, status, result, isError }: ToolRendererProps) {
  const path = argPath(args);
  if (result === undefined) {
    if (!isActive(status)) return null;
    const n = editCount(args);
    return <Pending label={n > 0 ? `Applying ${n} edit${n === 1 ? "" : "s"}…` : "Editing…"} />;
  }
  if (isError) return <ErrorOutput result={result} />;
  const patch = editPatch(result);
  if (!patch) return <Notice>{toolResultText(result) || "Edited"}</Notice>;
  return <ToolDiff patch={patch} path={path ?? ""} fileName={path} />;
}

export const editRenderer: ToolRenderer = { Summary: EditSummary, Body: EditBody };

function lineCount(content: string): number {
  if (content === "") return 0;
  return content.replace(/\n$/, "").split("\n").length;
}

function WriteSummary({ args }: ToolRendererProps) {
  const path = argPath(args);
  const content = str(args, "content");
  return (
    <span className="font-mono">
      {path}
      {content !== undefined && (
        <Muted className="font-sans">
          {" "}
          · {lineCount(content)} {lineCount(content) === 1 ? "line" : "lines"}
        </Muted>
      )}
    </span>
  );
}

function WriteBody({ args, status, result, isError }: ToolRendererProps) {
  const path = argPath(args);
  const content = str(args, "content") ?? "";
  const patch = useMemo(() => allAddedPatch(path ?? "file", content), [path, content]);
  if (isError && result) return <ErrorOutput result={result} />;
  if (result === undefined && status === "streaming") return <Pending label="Writing…" />;
  if (content === "") return <Notice>Empty file</Notice>;
  return <ToolDiff patch={patch} path={path ?? ""} fileName={path ?? "file"} />;
}

/**
 * pi's write result carries no details, so a new file can't be told from an overwrite; the
 * content always shows as an all-added diff.
 */
export const writeRenderer: ToolRenderer = { Summary: WriteSummary, Body: WriteBody };

registerToolRenderer("edit", editRenderer);
registerToolRenderer("write", writeRenderer);
