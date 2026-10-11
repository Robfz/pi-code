/**
 * Renderers for pi's `edit` and `write` tools: `+n −m` from the edit's `details.patch` and the
 * patch in the diff viewer; written content as an all-added diff. Selected lines become
 * references to the tool's path as shown, never versioned (`docs/design/07-code-review.md`).
 */

import type { EditToolDetails } from "@pi-code/protocol";
import { FilePenIcon, FilePlusIcon } from "lucide-react";
import { useMemo } from "react";
import { allAddedPatch, countPatchLines } from "@/components/diff";
import { SelectableDiff } from "@/features/review/selectable-diff";
import { lineCount, toolResultText } from "@/lib/content";
import { cwdRelative } from "@/lib/paths";
import { useConversation } from "@/store/context";
import {
  argPath,
  asRecord,
  ErrorOutput,
  isActive,
  Notice,
  Pending,
  plural,
  statusVerb,
  str,
} from "./common";
import {
  registerToolRenderer,
  type ToolLabel,
  type ToolRenderer,
  type ToolRendererProps,
} from "./registry";

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
    <span className="inline-flex gap-1 tabular-nums">
      <span className="text-diff-add">+{additions}</span>
      <span className="text-diff-del">−{deletions}</span>
    </span>
  );
}

function editLabel({ args, status, result, isError }: ToolRendererProps): ToolLabel {
  const path = argPath(args);
  const patch = isError ? undefined : editPatch(result);
  return {
    icon: FilePenIcon,
    verb: statusVerb(status, "Editing", "Edited", "Edit failed"),
    target: path ? { kind: "path", text: path } : undefined,
    meta: patch && <Counts {...countPatchLines(patch)} />,
  };
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

export const editRenderer: ToolRenderer = { label: editLabel, Body: EditBody };

function writeLabel({ args, status }: ToolRendererProps): ToolLabel {
  const path = argPath(args);
  const content = str(args, "content");
  return {
    icon: FilePlusIcon,
    verb: statusVerb(status, "Writing", "Wrote", "Write failed"),
    target: path ? { kind: "path", text: path } : undefined,
    meta: content !== undefined ? `· ${plural(lineCount(content), "line", "lines")}` : undefined,
  };
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
export const writeRenderer: ToolRenderer = { label: writeLabel, Body: WriteBody };

registerToolRenderer("edit", editRenderer);
registerToolRenderer("write", writeRenderer);
