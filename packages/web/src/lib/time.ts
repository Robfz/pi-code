/** Short relative time of an epoch-ms instant ("just now", "5m ago", "3h ago", "2d ago", then a date). */
export function formatRelative(then: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(new Date(then).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Dollar cost with precision that stays meaningful for small amounts. */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

/** Compact token count (1.2k, 34k, 1.1M). */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Whole seconds, at least 1s: "12s", "1m 4s". */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A tool call's duration: "12ms", "1.2s", then "1m 4s". */
export function formatDuration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded}ms`;
  if (rounded < 59_950) return `${(rounded / 1000).toFixed(1)}s`;
  return formatSeconds(rounded);
}
