/**
 * Collects a scenario's metrics from Chromium: CDP for main-thread time, CPU throttling and the
 * heap; the page's own observers (`installPerfObservers`) for long tasks, frames and load timings.
 */
import type { CDPSession, Page } from "@playwright/test";
import { median, type ScenarioMetrics } from "./report.ts";

/** What `installPerfObservers` records in the page. Times are `performance.now()` values. */
interface PerfRecord {
  longTasks: { start: number; duration: number }[];
  /** `requestAnimationFrame` timestamps. */
  frames: number[];
  /** The latest largest-contentful-paint candidate. */
  lcp: number;
}

declare global {
  interface E2EHooks {
    perf: PerfRecord;
  }
}

/** One frame at 60 Hz, headless Chromium's frame rate. */
const FRAME_MS = 1000 / 60;

/**
 * Init script (self-contained, see `harness/init-scripts.ts`): records long tasks, the LCP
 * candidate and every animation frame from the document's start. The rAF loop is what measures
 * frames; it also keeps the page producing a frame every vsync, a constant cost in every scenario.
 */
export function installPerfObservers(): void {
  const perf: PerfRecord = { longTasks: [], frames: [], lcp: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      perf.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    const last = list.getEntries().at(-1);
    if (last) perf.lcp = last.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  const frame = (time: number) => {
    perf.frames.push(time);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__e2e = Object.assign(window.__e2e ?? {}, { perf });
}

/** The start of a measured window (`Metrics.mark`). */
export interface Mark {
  at: number;
  /** The document's `performance.timeOrigin`: a different one at the end means a navigation. */
  timeOrigin: number;
  pageNow: number;
  cdp: Record<string, number>;
}

/**
 * Runs in the page (`page.evaluate`, so self-contained): long tasks and frames since `since`, and
 * the document's load timings.
 */
function pageRecord(since: number) {
  const perf = window.__e2e.perf;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const js = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) =>
    new URL(r.name).pathname.endsWith(".js"),
  );
  return {
    timeOrigin: performance.timeOrigin,
    longTasks: perf.longTasks.filter((t) => t.start >= since).map((t) => t.duration),
    frames: perf.frames.filter((t) => t >= since),
    load: {
      ttfbMs: nav.responseStart,
      domContentLoadedMs: nav.domContentLoadedEventEnd,
      loadMs: nav.loadEventEnd,
      fcpMs: fcp?.startTime ?? 0,
      lcpMs: perf.lcp,
      js: {
        requests: js.length,
        transferBytes: js.reduce((sum, r) => sum + r.transferSize, 0),
        decodedBytes: js.reduce((sum, r) => sum + r.decodedBodySize, 0),
      },
    },
  };
}

function frameStats(timestamps: number[]): ScenarioMetrics["frames"] {
  const intervals = timestamps.slice(1).map((t, i) => t - (timestamps[i] ?? t));
  const sorted = [...intervals].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    p50Ms: median(intervals),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0,
    dropped: intervals.reduce((sum, i) => sum + Math.max(0, Math.round(i / FRAME_MS) - 1), 0),
  };
}

/** Measures one page through its own CDP session. */
export class Metrics {
  private readonly page: Page;
  private readonly cdp: CDPSession;

  private constructor(page: Page, cdp: CDPSession) {
    this.page = page;
    this.cdp = cdp;
  }

  static async attach(page: Page): Promise<Metrics> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    return new Metrics(page, cdp);
  }

  /** Slows the page's main thread `rate` times (1 = none). */
  async throttle(rate: number): Promise<void> {
    await this.cdp.send("Emulation.setCPUThrottlingRate", { rate });
  }

  /** Starts a window, after a GC so the heap baseline holds only live objects. */
  async mark(): Promise<Mark> {
    await this.cdp.send("HeapProfiler.collectGarbage");
    const cdp = await this.cdpMetrics();
    const { timeOrigin, pageNow } = await this.page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      pageNow: performance.now(),
    }));
    return { at: Date.now(), timeOrigin, pageNow, cdp };
  }

  /** Ends a window that stayed in one document. */
  async collect(start: Mark): Promise<ScenarioMetrics> {
    const { metrics, timeOrigin } = await this.end(start, start.pageNow, start.cdp);
    if (timeOrigin !== start.timeOrigin) {
      throw new Error("the page navigated during the window: measure loads with collectLoad");
    }
    return metrics;
  }

  /**
   * Ends a window that navigated to a new document, `readyMs` after its navigation start. Every
   * figure is the new document's: CDP's main-thread totals restart with each document, like the
   * page's own observers.
   */
  async collectLoad(start: Mark, readyMs: number): Promise<ScenarioMetrics> {
    // The observer reports the LCP candidate in a task of its own, late on a busy main thread.
    await this.page.waitForFunction(() => window.__e2e.perf.lcp > 0);
    const { metrics, timeOrigin, load } = await this.end(start, 0, {});
    if (timeOrigin === start.timeOrigin) throw new Error("the page did not navigate");
    return { ...metrics, load: { readyMs, ...load } };
  }

  /** `since` and `base`: the page time and CDP totals the window's figures count from. */
  private async end(start: Mark, since: number, base: Record<string, number>) {
    const durationMs = Date.now() - start.at;
    const cdp = await this.cdpMetrics();
    const record = await this.page.evaluate(pageRecord, since);
    await this.cdp.send("HeapProfiler.collectGarbage");
    const heapAfter = (await this.cdpMetrics()).JSHeapUsedSize ?? 0;
    const delta = (name: string) => ((cdp[name] ?? 0) - (base[name] ?? 0)) * 1000;
    const mainThread = {
      taskMs: delta("TaskDuration"),
      scriptMs: delta("ScriptDuration"),
      layoutMs: delta("LayoutDuration"),
      styleMs: delta("RecalcStyleDuration"),
    };
    const metrics: ScenarioMetrics = {
      durationMs,
      mainThread,
      longTasks: {
        count: record.longTasks.length,
        totalMs: record.longTasks.reduce((sum, d) => sum + d, 0),
        maxMs: Math.max(0, ...record.longTasks),
      },
      frames: frameStats(record.frames),
      heap: { beforeBytes: start.cdp.JSHeapUsedSize ?? 0, afterBytes: heapAfter },
    };
    return { metrics, timeOrigin: record.timeOrigin, load: record.load };
  }

  private async cdpMetrics(): Promise<Record<string, number>> {
    const { metrics } = await this.cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }
}
