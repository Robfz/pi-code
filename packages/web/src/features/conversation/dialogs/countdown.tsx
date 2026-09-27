import { TimerIcon } from "lucide-react";
import { useEffect, useState } from "react";

/** Whole seconds left until `expiresAt` (never negative). */
function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * Seconds left until `expiresAt` (server clock, ms since epoch), ticking once per second on
 * the second boundary. It only informs: the dialog stays until the server's `ui_resolved`, since
 * this device's clock may be off.
 */
export function CountdownBadge({ expiresAt }: { expiresAt: number | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  const seconds = expiresAt === undefined ? null : secondsLeft(expiresAt, now);
  useEffect(() => {
    if (expiresAt === undefined || seconds === 0) return;
    const untilNextSecond = (expiresAt - now) % 1000 || 1000;
    const timer = setTimeout(() => setNow(Date.now()), untilNextSecond);
    return () => clearTimeout(timer);
  }, [expiresAt, now, seconds]);
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
