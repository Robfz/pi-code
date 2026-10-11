/**
 * Watches pi's sessions dir (TUI sessions included) so the streamed session list follows it
 * (design/05-desktop.md, "Session watcher").
 */
import { existsSync, watch } from "node:fs";

/** Longest delay between a change in the sessions dir and the rescan it schedules. */
const MAX_WAIT_MS = 500;

interface Throttled {
  /** Runs the function `ms` after the first call since its last run. */
  schedule(): void;
  cancel(): void;
}

/**
 * Trailing throttle: calls within `ms` of the first one coalesce into one run at its end, so a
 * burst runs once and continuous calls run once every `ms`.
 */
export function throttle(fn: () => void, ms: number): Throttled {
  let timer: NodeJS.Timeout | undefined;
  return {
    schedule() {
      timer ??= setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export interface SessionWatcher {
  close(): void;
}

/**
 * Watches `sessionsDir` recursively and calls `onChange` through a trailing throttle on every
 * event, unfiltered. A missing dir logs a warning and returns `undefined`: pi-code never
 * creates it, since pi's agent dir belongs to pi.
 */
export function watchSessions(
  sessionsDir: string,
  onChange: () => void,
  maxWaitMs = MAX_WAIT_MS,
): SessionWatcher | undefined {
  const warn = (why: string) => console.warn(`[catalog] not watching ${sessionsDir}: ${why}`);
  if (!existsSync(sessionsDir)) {
    warn("no such directory");
    return undefined;
  }
  const rescan = throttle(onChange, maxWaitMs);
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(sessionsDir, { recursive: true }, () => rescan.schedule());
  } catch (e) {
    warn((e as Error).message);
    return undefined;
  }
  watcher.on("error", (e) => console.warn(`[catalog] session watcher: ${e.message}`));
  return {
    close() {
      watcher.close();
      rescan.cancel();
    },
  };
}
