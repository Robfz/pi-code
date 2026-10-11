/**
 * Exploration groups (`docs/design/09-ui-overhaul.md`, "Exploration groups"): consecutive
 * read-only calls folded into one row.
 */

import type { SessionEntry } from "@pi-code/protocol";
import { lastWorkIndex, type Step } from "@/store/turns";

type ToolStep = Extract<Step, { kind: "tool" }>;
type ThinkingStep = Extract<Step, { kind: "thinking" }>;

export interface ExplorationGroup {
  kind: "group";
  /** The first child's key, so the group keeps its open state while it grows. */
  key: string;
  /** Two or more exploration calls, with the thinking between them. */
  steps: (ToolStep | ThinkingStep)[];
}

export type Item = Step | ExplorationGroup;

/** What each exploration tool counts as in the group's label, in label order. */
const COUNTS = {
  read: "file",
  grep: "search",
  find: "search",
  ls: "listing",
  web_search: "web search",
  source_check: "web search",
  fetch_content: "page",
  get_search_content: "page",
} as const;

type Noun = (typeof COUNTS)[keyof typeof COUNTS];

const NOUNS: readonly [Noun, string][] = [
  ["file", "files"],
  ["search", "searches"],
  ["listing", "listings"],
  ["web search", "web searches"],
  ["page", "pages"],
];

export function isExplorationTool(toolName: string): toolName is keyof typeof COUNTS {
  return Object.hasOwn(COUNTS, toolName);
}

export const NO_FAILURES: ReadonlySet<string> = new Set();

/**
 * Fold runs of two or more exploration calls (with the thinking between them) into groups. A
 * lone call, thinking before the first call or after the last, and failed calls stay as they
 * are; anything else ends a run. Blank text steps are dropped.
 */
export function groupSteps(steps: readonly Step[], failed = NO_FAILURES): Item[] {
  const items: Item[] = [];
  let run: ExplorationGroup["steps"] = [];
  let calls = 0;
  // Thinking after the run's last call: inside the group only if another call follows.
  let trailing: ThinkingStep[] = [];

  const flush = () => {
    if (calls >= 2) items.push({ kind: "group", key: run[0]?.key ?? "", steps: run });
    else items.push(...run);
    items.push(...trailing);
    run = [];
    calls = 0;
    trailing = [];
  };

  for (const step of steps) {
    if (step.kind === "text" && step.text.trim() === "") continue;
    if (step.kind === "tool" && isExplorationTool(step.toolName) && !failed.has(step.toolCallId)) {
      run.push(...trailing, step);
      trailing = [];
      calls++;
    } else if (step.kind === "thinking" && calls > 0) {
      trailing.push(step);
    } else {
      flush();
      items.push(step);
    }
  }
  flush();
  return items;
}

/** "3 files, 2 searches, 1 web search": the group's calls by kind, zero counts left out. */
export function groupCountLabel(steps: readonly Step[]): string {
  const counts = new Map<Noun, number>();
  for (const step of steps) {
    if (step.kind === "tool" && isExplorationTool(step.toolName)) {
      const noun = COUNTS[step.toolName];
      counts.set(noun, (counts.get(noun) ?? 0) + 1);
    }
  }
  return NOUNS.flatMap(([one, many]) => {
    const n = counts.get(one) ?? 0;
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  }).join(", ");
}

/**
 * Compact's split of a finished turn: its thinking, tool and non-final text steps (`folded`, for
 * the "Worked" row) and the final text with every other step (`rest`), each in order.
 */
export function foldSteps(steps: readonly Step[]): { folded: Step[]; rest: Step[] } {
  const lastWork = lastWorkIndex(steps);
  const folded: Step[] = [];
  const rest: Step[] = [];
  steps.forEach((step, index) => {
    const work =
      step.kind === "thinking" ||
      step.kind === "tool" ||
      (step.kind === "text" && index < lastWork);
    (work ? folded : rest).push(step);
  });
  return { folded, rest };
}

/** Calls of a turn whose committed result is an error. */
export function failedToolCalls(entries: readonly SessionEntry[]): Set<string> {
  const failed = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError) {
      failed.add(entry.message.toolCallId);
    }
  }
  return failed;
}
