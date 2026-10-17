import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { affectsListing, throttle, watchSessions } from "./watcher.ts";

describe("throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into one trailing run", () => {
    const fn = vi.fn();
    const t = throttle(fn, 500);
    for (let i = 0; i < 50; i++) t.schedule();
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs at least every 500 ms under continuous calls", () => {
    const fn = vi.fn();
    const t = throttle(fn, 500);
    const runs: number[] = [];
    fn.mockImplementation(() => runs.push(Date.now()));
    const start = Date.now();
    for (let ms = 0; ms < 2_000; ms += 50) {
      t.schedule();
      vi.advanceTimersByTime(50);
    }
    expect(runs.map((at) => at - start)).toEqual([500, 1000, 1500, 2000]);
  });

  it("cancel drops the pending run", () => {
    const fn = vi.fn();
    const t = throttle(fn, 500);
    t.schedule();
    t.cancel();
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
    t.schedule();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("watchSessions", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-watcher-")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("calls back for session file writes, until closed", async () => {
    const sessions = join(root, "sessions");
    mkdirSync(join(sessions, "--project--"), { recursive: true });
    let calls = 0;
    const watcher = watchSessions(sessions, () => calls++, 20);
    expect(watcher).toBeDefined();
    // Rewritten until seen: a watch may miss changes made while it is still starting.
    await vi.waitFor(
      () => {
        writeFileSync(join(sessions, "--project--", "s.jsonl"), "{}\n");
        expect(calls).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 50 },
    );
    watcher?.close();
    const seen = calls;
    writeFileSync(join(sessions, "--project--", "t.jsonl"), "{}\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(seen);
  });

  it("ignores files the listing can't hold, not project dirs or session file deletions", async () => {
    const sessions = join(root, "sessions");
    const project = join(sessions, "--project--");
    mkdirSync(join(project, "run"), { recursive: true });
    writeFileSync(join(project, "s.jsonl"), "{}\n");
    let calls = 0;
    const watcher = watchSessions(sessions, () => calls++, 20);
    // Wait out events from the setup above, which a starting watch may still report.
    await vi.waitFor(
      () => {
        writeFileSync(join(project, "s.jsonl"), "{}\n");
        expect(calls).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 50 },
    );
    await new Promise((r) => setTimeout(r, 200));

    calls = 0;
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(project, "run", "sub.jsonl"), `${i}\n`);
      writeFileSync(join(project, "notes.txt"), `${i}\n`);
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0);

    rmSync(join(project, "s.jsonl"));
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 5_000 });
    calls = 0;
    mkdirSync(join(sessions, "--other--"));
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 5_000 });
    calls = 0;
    rmSync(project, { recursive: true });
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 5_000 });
    watcher?.close();
  });

  it("warns and doesn't watch a missing dir", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(watchSessions(join(root, "missing"), () => {})).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(root, "missing")));
  });
});

describe("affectsListing", () => {
  const path = (...parts: string[]) => parts.join(sep);

  it("keeps project dirs and their session files, and unknown paths", () => {
    expect(affectsListing(path("--p--"))).toBe(true);
    expect(affectsListing(path("--p--", "s.jsonl"))).toBe(true);
    expect(affectsListing("")).toBe(true);
    expect(affectsListing(null)).toBe(true);
  });

  it("drops other files in project dirs and anything deeper", () => {
    expect(affectsListing(path("--p--", "notes.txt"))).toBe(false);
    expect(affectsListing(path("--p--", "run"))).toBe(false);
    expect(affectsListing(path("--p--", "run", "sub.jsonl"))).toBe(false);
    expect(affectsListing(path("--p--", "a", "b", "c.jsonl"))).toBe(false);
  });
});
