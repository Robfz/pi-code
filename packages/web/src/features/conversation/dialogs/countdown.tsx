import { TimerIcon } from "lucide-react";
import { useEffect, useState } from "react";

/** Seconds left until `expiresAt` (server clock, ms since epoch); calls `onExpire` once at 0. */
export function useCountdown(expiresAt: number | undefined, onExpire: () => void): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const remaining =
    expiresAt === undefined ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  useEffect(() => {
    if (remaining === 0) onExpire();
  }, [remaining, onExpire]);
  return remaining;
}

export function CountdownBadge({ seconds }: { seconds: number | null }) {
  if (seconds === null) return null;
  return (
    <span
      data-testid="countdown"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
    >
      <TimerIcon className="size-3.5" />
      {seconds}s
    </span>
  );
}
