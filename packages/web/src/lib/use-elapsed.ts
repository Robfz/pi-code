import { useEffect, useState } from "react";

/**
 * Milliseconds since `startedAt` (a server timestamp), re-rendering every second; undefined
 * without `startedAt`. Clamped at 0 when the device's clock is behind the server's.
 */
export function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}
