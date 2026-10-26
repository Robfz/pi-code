import { useEffect, useState } from "react";

/** How often relative times ("2m ago") are refreshed. */
export const RELATIVE_TIME_TICK_MS = 60_000;

/** `Date.now()`, refreshed every `intervalMs`. */
export function useNow(intervalMs: number = RELATIVE_TIME_TICK_MS): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
