/**
 * Playwright reporter of the perf config: gathers the `metrics` attachments of passed tests and
 * writes `results/report-<date>.json` and `.md` with each scenario's medians.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import {
  formatValue,
  medians,
  type Report,
  type ReportRow,
  type Sample,
  unitOf,
} from "./report.ts";

const RESULTS = fileURLToPath(new URL("../results/", import.meta.url));

/** Columns of the markdown tables: metric key, heading. */
const RUNTIME_COLUMNS: [string, string][] = [
  ["durationMs", "duration"],
  ["mainThread.taskMs", "task"],
  ["mainThread.scriptMs", "script"],
  ["mainThread.layoutMs", "layout"],
  ["mainThread.styleMs", "style"],
  ["longTasks.count", "long tasks"],
  ["longTasks.totalMs", "long total"],
  ["longTasks.maxMs", "long max"],
  ["frames.p50Ms", "frame p50"],
  ["frames.p95Ms", "frame p95"],
  ["frames.maxMs", "frame max"],
  ["frames.dropped", "dropped"],
  ["heap.beforeBytes", "heap before"],
  ["heap.afterBytes", "heap after"],
];
const LOAD_COLUMNS: [string, string][] = [
  ["load.readyMs", "ready"],
  ["load.ttfbMs", "TTFB"],
  ["load.domContentLoadedMs", "DCL"],
  ["load.loadMs", "load"],
  ["load.fcpMs", "FCP"],
  ["load.lcpMs", "LCP"],
  ["load.js.requests", "JS requests"],
  ["load.js.transferBytes", "JS transfer"],
  ["load.js.decodedBytes", "JS decoded"],
];

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function table(rows: ReportRow[], columns: [string, string][]): string {
  const heading = (key: string, label: string) =>
    unitOf(key) ? `${label} (${unitOf(key)})` : label;
  const head = ["scenario", "project", "cpu", "runs", ...columns.map(([k, l]) => heading(k, l))];
  const lines = [head, head.map(() => "---")].map((cells) => `| ${cells.join(" | ")} |`);
  for (const row of rows) {
    const cells = [row.scenario, row.project, `${row.cpu}x`, String(row.runs.length)];
    cells.push(...columns.map(([key]) => formatValue(key, row.median[key])));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function markdown(report: Report): string {
  const { meta, rows } = report;
  const load = rows.filter((r) => r.median["load.readyMs"] !== undefined);
  return [
    `# Perf report ${meta.date}`,
    "",
    `Commit ${meta.commit}, ${meta.runs} runs per row (medians), Playwright ${meta.playwright}, Chromium ${meta.chromium}, ${meta.host}.`,
    "",
    "## Runtime",
    "",
    table(rows, RUNTIME_COLUMNS),
    ...(load.length ? ["", "## Load (from navigation start)", "", table(load, LOAD_COLUMNS)] : []),
    "",
  ].join("\n");
}

export default class PerfReporter implements Reporter {
  private playwright = "";
  private readonly samples: Sample[] = [];

  onBegin(config: FullConfig): void {
    this.playwright = config.version;
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status !== "passed") return;
    const body = result.attachments.find((a) => a.name === "metrics")?.body;
    if (body) this.samples.push(JSON.parse(body.toString()) as Sample);
  }

  onEnd(): void {
    if (this.samples.length === 0) {
      console.log("perf: no passed scenario, no report written");
      return;
    }
    const groups = new Map<string, Sample[]>();
    for (const s of this.samples) {
      const key = `${s.scenario}|${s.project}|${s.cpu}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const scenarios = [...new Set(this.samples.map((s) => s.scenario))];
    const rows: ReportRow[] = [...groups.values()]
      .map((group) => {
        const { scenario, project, cpu } = group[0] as Sample;
        const runs = group.sort((a, b) => a.run - b.run).map((s) => s.metrics);
        return { scenario, project, cpu, runs, median: medians(runs) };
      })
      .sort(
        (a, b) =>
          scenarios.indexOf(a.scenario) - scenarios.indexOf(b.scenario) ||
          a.project.localeCompare(b.project) ||
          a.cpu - b.cpu,
      );
    const date = new Date().toISOString();
    const cpu = cpus();
    const report: Report = {
      meta: {
        date,
        commit: `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? "+dirty" : ""}`,
        runs: Math.max(...this.samples.map((s) => s.run)),
        playwright: this.playwright,
        chromium: this.samples[0]?.chromium ?? "",
        host: `${cpu[0]?.model ?? "unknown CPU"} ×${cpu.length}`,
      },
      rows,
    };
    mkdirSync(RESULTS, { recursive: true });
    const base = join(RESULTS, `report-${date.replace(/[:.]/g, "-")}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(`${base}.md`, markdown(report));
    console.log(`perf report: ${base}.json\n             ${base}.md`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
