/**
 * Diffs two perf reports: `pnpm e2e:compare <before.json> <after.json> [--threshold=0.1]`.
 * Prints a markdown table per scenario row with each median's change, and marks the changes of at
 * least `threshold` (a fraction; any change from 0). Reports only: it always exits 0 on valid input.
 */
import { readFileSync } from "node:fs";
import { formatValue, type Report, type ReportRow, rowKey, unitOf } from "./report.ts";

const USAGE = "usage: compare.ts <before.json> <after.json> [--threshold=0.1]";

function parseArgs(argv: string[]): { before: string; after: string; threshold: number } {
  const files = argv.filter((a) => !a.startsWith("--"));
  const option = argv.find((a) => a.startsWith("--threshold="));
  const threshold = option ? Number(option.slice("--threshold=".length)) : 0.1;
  const [before, after] = files;
  if (files.length !== 2 || !before || !after || !(threshold > 0)) {
    console.error(USAGE);
    process.exit(1);
  }
  return { before, after, threshold };
}

function read(file: string): Report {
  return JSON.parse(readFileSync(file, "utf8")) as Report;
}

function percent(change: number): string {
  return `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
}

function compareRow(before: ReportRow, after: ReportRow, threshold: number): string[] {
  const keys = [...new Set([...Object.keys(before.median), ...Object.keys(after.median)])];
  const lines = ["| metric | before | after | Δ | Δ% | |", "| --- | --- | --- | --- | --- | --- |"];
  for (const key of keys) {
    const a = before.median[key];
    const b = after.median[key];
    const metric = unitOf(key) ? `${key} (${unitOf(key)})` : key;
    if (a === undefined || b === undefined) {
      lines.push(`| ${metric} | ${formatValue(key, a)} | ${formatValue(key, b)} | | | |`);
      continue;
    }
    const delta = b - a;
    const relative = a === 0 ? undefined : delta / a;
    const flagged = relative === undefined ? delta !== 0 : Math.abs(relative) >= threshold;
    const deltaText = `${delta > 0 ? "+" : ""}${formatValue(key, delta)}`;
    const relativeText = relative === undefined ? (delta === 0 ? "0%" : "new") : percent(relative);
    lines.push(
      `| ${metric} | ${formatValue(key, a)} | ${formatValue(key, b)} | ${deltaText} | ${relativeText} | ${flagged ? "⚠" : ""} |`,
    );
  }
  return lines;
}

const { before: beforeFile, after: afterFile, threshold } = parseArgs(process.argv.slice(2));
const before = read(beforeFile);
const after = read(afterFile);
const afterRows = new Map(after.rows.map((r) => [rowKey(r), r]));
const beforeKeys = new Set(before.rows.map(rowKey));

const out = [
  "# Perf comparison",
  "",
  `- Before: \`${beforeFile}\` (${before.meta.commit}, ${before.meta.date}, ${before.meta.runs} runs)`,
  `- After: \`${afterFile}\` (${after.meta.commit}, ${after.meta.date}, ${after.meta.runs} runs)`,
  `- ⚠ marks a median that changed by ${percent(threshold).slice(1)} or more. Lower is better for every metric.`,
];
if (before.meta.host !== after.meta.host) {
  out.push(`- The reports come from different machines (${before.meta.host}, ${after.meta.host}).`);
}
for (const row of before.rows) {
  const match = afterRows.get(rowKey(row));
  if (!match) continue;
  out.push("", `## ${rowKey(row)}`, "", ...compareRow(row, match, threshold));
}
const unmatched = [
  ...before.rows.filter((r) => !afterRows.has(rowKey(r))).map((r) => `${rowKey(r)} (before only)`),
  ...after.rows.filter((r) => !beforeKeys.has(rowKey(r))).map((r) => `${rowKey(r)} (after only)`),
];
if (unmatched.length) out.push("", "## Not compared", "", ...unmatched.map((r) => `- ${r}`));
console.log(out.join("\n"));
