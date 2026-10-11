/**
 * Renderers for pi's built-in `read`, `bash`, `grep`, `find` and `ls` tools
 * (`docs/design/03-web-client.md`, "Tool renderers").
 */

import type { BashToolDetails } from "@pi-code/protocol";
import {
  FileSearchIcon,
  FileTextIcon,
  FolderOpenIcon,
  SquareTerminalIcon,
  TextSearchIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toolResultText } from "@/lib/content";
import {
  argPath,
  CodeBlock,
  ErrorOutput,
  Images,
  isActive,
  langFromPath,
  Muted,
  Notice,
  num,
  Pending,
  plural,
  resultImages,
  splitNotice,
  statusVerb,
  str,
  truncate,
} from "./common";
import { OutputBlock } from "./generic";
import {
  registerToolRenderer,
  type ToolLabel,
  type ToolRenderer,
  type ToolRendererProps,
} from "./registry";

// ---------------------------------------------------------------------------
// read

/** `:start-end` of a read call, when it isn't the whole file from line 1. */
export function readRange(args: unknown): string | undefined {
  const offset = num(args, "offset");
  const limit = num(args, "limit");
  if ((offset === undefined || offset <= 1) && limit === undefined) return undefined;
  const start = offset ?? 1;
  return limit !== undefined ? `:${start}-${start + limit - 1}` : `:${start}-`;
}

function readLabel({ args, status }: ToolRendererProps): ToolLabel {
  const path = argPath(args);
  return {
    icon: FileTextIcon,
    verb: statusVerb(status, "Reading", "Read", "Read failed"),
    target: path ? { kind: "path", text: path } : undefined,
    meta: readRange(args),
  };
}

function ReadBody({ args, status, result, isError }: ToolRendererProps) {
  if (result === undefined) return isActive(status) ? <Pending label="Reading…" /> : null;
  if (isError) return <ErrorOutput result={result} />;
  const images = resultImages(result);
  const { body, notice } = splitNotice(toolResultText(result));
  return (
    <div className="flex flex-col gap-2">
      <Images images={images} />
      {body !== "" && (images.length === 0 || body.trim() !== "") && (
        <CodeBlock code={body} lang={langFromPath(argPath(args))} />
      )}
      {body === "" && images.length === 0 && <Notice>Empty file</Notice>}
      {notice && <Notice>{notice}</Notice>}
    </div>
  );
}

export const readRenderer: ToolRenderer = { label: readLabel, Body: ReadBody };

// ---------------------------------------------------------------------------
// bash

export type BashOutcome =
  | { kind: "exit"; code: number }
  | { kind: "aborted" }
  | { kind: "timeout"; seconds?: number };

const EXIT_STATUS = /\n*Command exited with code (\d+)\s*$/;
const ABORTED_STATUS = /\n*Command aborted\s*$/;
const TIMEOUT_STATUS = /\n*Command timed out after (\d+) seconds?\s*$/;

/**
 * Outcome and output of a finished bash call. pi reports failures by appending a status line
 * ("Command exited with code N", "Command aborted", "Command timed out after N seconds") to
 * the output of an error result; success has no status (exit 0).
 */
export function bashOutcome(
  text: string,
  isError: boolean,
): { outcome?: BashOutcome; output: string } {
  if (!isError) return { outcome: { kind: "exit", code: 0 }, output: text };
  let m = EXIT_STATUS.exec(text);
  if (m) return { outcome: { kind: "exit", code: Number(m[1]) }, output: text.slice(0, m.index) };
  m = ABORTED_STATUS.exec(text);
  if (m) return { outcome: { kind: "aborted" }, output: text.slice(0, m.index) };
  m = TIMEOUT_STATUS.exec(text);
  if (m) {
    return { outcome: { kind: "timeout", seconds: Number(m[1]) }, output: text.slice(0, m.index) };
  }
  return { output: text };
}

function OutcomeBadge({ outcome }: { outcome: BashOutcome }) {
  if (outcome.kind === "aborted") return <Badge variant="outline">aborted</Badge>;
  if (outcome.kind === "timeout") return <Badge variant="destructive">timed out</Badge>;
  return (
    <Badge variant={outcome.code === 0 ? "secondary" : "destructive"}>exit {outcome.code}</Badge>
  );
}

function bashLabel({ args, status, result, isError }: ToolRendererProps): ToolLabel {
  const command = str(args, "command");
  const outcome = result ? bashOutcome(toolResultText(result), isError).outcome : undefined;
  return {
    icon: SquareTerminalIcon,
    verb: statusVerb(status, "Running", "Ran", "Command failed"),
    target: command !== undefined ? { kind: "code", text: truncate(command, 200) } : undefined,
    meta: outcome?.kind === "exit" && outcome.code !== 0 ? `exit ${outcome.code}` : undefined,
  };
}

function BashBody({ args, status, partialResult, result, isError }: ToolRendererProps) {
  const command = str(args, "command") ?? "";
  const timeout = num(args, "timeout");
  const live = result === undefined;
  const text = live ? toolResultText(partialResult) : toolResultText(result);
  const { outcome, output } = live
    ? { outcome: undefined, output: text }
    : bashOutcome(text, isError);
  const details = (live ? undefined : result?.details) as BashToolDetails | undefined;
  const shown = output.replace(/\n$/, "");
  return (
    <div className="flex flex-col gap-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
        <Muted>$ </Muted>
        {command}
        {timeout !== undefined && <Muted> (timeout {timeout}s)</Muted>}
      </pre>
      {shown !== "" && (
        <OutputBlock text={shown} error={!live && isError && outcome === undefined} />
      )}
      {shown === "" && live && isActive(status) && <Pending label="Waiting for output…" />}
      {shown === "" && !live && <Notice>No output</Notice>}
      {outcome && (
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={outcome} />
          {outcome.kind === "timeout" && outcome.seconds !== undefined && (
            <Notice>after {outcome.seconds}s</Notice>
          )}
        </div>
      )}
      {details?.truncation?.truncated && (
        <Notice>
          Output truncated
          {details.fullOutputPath ? ` · full output in ${details.fullOutputPath}` : ""}
        </Notice>
      )}
    </div>
  );
}

export const bashRenderer: ToolRenderer = {
  label: bashLabel,
  Body: BashBody,
  expandWhileRunning: true,
};

// ---------------------------------------------------------------------------
// grep / find / ls

const EMPTY_RESULTS = new Set([
  "No matches found",
  "No files found matching pattern",
  "(empty directory)",
]);

/** Result lines of a grep / find / ls call (notice and "nothing found" messages removed). */
export function listResult(result: unknown): { items: string[]; notice?: string } {
  const { body, notice } = splitNotice(toolResultText(result));
  const trimmed = body.replace(/\n+$/, "");
  if (trimmed === "" || EMPTY_RESULTS.has(trimmed.trim())) return { items: [], notice };
  return { items: trimmed.split("\n"), notice };
}

const GREP_MATCH = /^.+?:\d+: /;

function listCount(toolName: string, items: string[]): string {
  if (toolName === "grep") {
    const matches = items.filter((line) => GREP_MATCH.test(line)).length || items.length;
    return plural(matches, "match", "matches");
  }
  if (toolName === "ls") return plural(items.length, "entry", "entries");
  return plural(items.length, "file", "files");
}

function searchLabel({ toolName, args, status, result, isError }: ToolRendererProps): ToolLabel {
  const pattern = str(args, "pattern");
  const count = result && !isError ? listCount(toolName, listResult(result).items) : undefined;
  const meta = count && `· ${count}`;
  if (toolName === "ls") {
    return {
      icon: FolderOpenIcon,
      verb: statusVerb(status, "Listing", "Listed", "List failed"),
      target: { kind: "path", text: argPath(args) ?? "." },
      meta,
    };
  }
  const grep = toolName === "grep";
  return {
    icon: grep ? TextSearchIcon : FileSearchIcon,
    verb: grep
      ? statusVerb(status, "Searching", "Searched", "Search failed")
      : statusVerb(status, "Finding", "Found", "Find failed"),
    target:
      pattern !== undefined ? { kind: "code", text: grep ? `/${pattern}/` : pattern } : undefined,
    meta,
  };
}

function SearchBody({ status, result, isError }: ToolRendererProps) {
  if (result === undefined) return isActive(status) ? <Pending label="Searching…" /> : null;
  if (isError) return <ErrorOutput result={result} />;
  const { items, notice } = listResult(result);
  return (
    <div className="flex flex-col gap-2">
      {items.length === 0 ? (
        <Notice>{toolResultText(result).trim() || "No results"}</Notice>
      ) : (
        <ul
          data-testid="result-list"
          className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs"
        >
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: result lines may repeat
            <li key={i} className="whitespace-pre-wrap break-all">
              {item}
            </li>
          ))}
        </ul>
      )}
      {notice && <Notice>{notice}</Notice>}
    </div>
  );
}

export const searchRenderer: ToolRenderer = { label: searchLabel, Body: SearchBody };

registerToolRenderer("read", readRenderer);
registerToolRenderer("bash", bashRenderer);
registerToolRenderer("grep", searchRenderer);
registerToolRenderer("find", searchRenderer);
registerToolRenderer("ls", searchRenderer);
