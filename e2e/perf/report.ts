/**
 * The perf report's shape, shared by the reporter (writes it) and `compare.ts` (reads two). Plain
 * TypeScript that Node runs as is: `compare.ts` runs without a build step.
 */

/** One scenario run. Times in milliseconds, sizes in bytes; lower is better for every metric. */
export interface ScenarioMetrics {
  /** Wall time of the measured window. */
  durationMs: number;
  /** Renderer main-thread time in the window (CDP `Performance.getMetrics`). */
  mainThread: { taskMs: number; scriptMs: number; layoutMs: number; styleMs: number };
  /** Tasks over 50 ms (`longtask` observer). */
  longTasks: { count: number; totalMs: number; maxMs: number };
  /** `requestAnimationFrame` intervals; `dropped` counts the 60 Hz frames they skipped. */
  frames: { p50Ms: number; p95Ms: number; maxMs: number; dropped: number };
  /** Used JS heap after a forced GC, at the window's start and end. */
  heap: { beforeBytes: number; afterBytes: number };
  /** Cold load only: the document's own timings, from navigation start. */
  load?: {
    /** The scenario's ready condition first held (checked every frame). */
    readyMs: number;
    ttfbMs: number;
    domContentLoadedMs: number;
    loadMs: number;
    fcpMs: number;
    lcpMs: number;
    js: { requests: number; transferBytes: number; decodedBytes: number };
  };
}

/** What each perf test attaches as `metrics`. */
export interface Sample {
  scenario: string;
  project: string;
  cpu: number;
  run: number;
  chromium: string;
  metrics: ScenarioMetrics;
}

/** Medians across runs, keyed by the metric's dotted path (`mainThread.taskMs`). */
export type Medians = Record<string, number>;

export interface ReportRow {
  scenario: string;
  project: string;
  cpu: number;
  runs: ScenarioMetrics[];
  median: Medians;
}

export interface Report {
  meta: {
    date: string;
    /** `git describe`-like: short HEAD, `+dirty` when the tree has uncommitted changes. */
    commit: string;
    /** Runs per scenario (`E2E_PERF_RUNS`); a row's `runs` has fewer if some failed. */
    runs: number;
    playwright: string;
    chromium: string;
    /** Timings only compare on the same machine. */
    host: string;
  };
  rows: ReportRow[];
}

export function rowKey(row: { scenario: string; project: string; cpu: number }): string {
  return `${row.scenario} · ${row.project} · ${row.cpu}x`;
}

/** Numeric leaves of `value` by dotted path. */
export function flatten(value: object, prefix = ""): Medians {
  const out: Medians = {};
  for (const [key, v] of Object.entries(value)) {
    const path = prefix + key;
    if (typeof v === "number") out[path] = v;
    else if (typeof v === "object" && v !== null) Object.assign(out, flatten(v, `${path}.`));
  }
  return out;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Per-metric medians over runs; a metric missing from some runs uses the runs that have it. */
export function medians(runs: ScenarioMetrics[]): Medians {
  const byKey = new Map<string, number[]>();
  for (const run of runs) {
    for (const [key, v] of Object.entries(flatten(run))) {
      byKey.set(key, [...(byKey.get(key) ?? []), v]);
    }
  }
  return Object.fromEntries([...byKey].map(([key, values]) => [key, median(values)]));
}

/** The unit a metric is shown in (`formatValue`): heap in MB, other sizes in KB, times in ms. */
export function unitOf(key: string): string {
  if (key.endsWith("Bytes")) return key.startsWith("heap.") ? "MB" : "KB";
  return key.endsWith("Ms") ? "ms" : "";
}

/** A metric value in its `unitOf` unit, for tables. */
export function formatValue(key: string, value: number | undefined): string {
  if (value === undefined) return "–";
  const unit = unitOf(key);
  const shown = unit === "MB" ? value / 1024 / 1024 : unit === "KB" ? value / 1024 : value;
  if (Number.isInteger(shown)) return String(shown);
  return Math.abs(shown) >= 100 ? shown.toFixed(0) : shown.toFixed(1);
}
