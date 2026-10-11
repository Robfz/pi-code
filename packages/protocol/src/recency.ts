/**
 * Where a session or project sorts in every listing: only a user prompt moves it up, so opening,
 * restarting or agent output reorders nothing.
 */
export interface Recency {
  /** Has a user prompt. */
  prompted: boolean;
  /** Epoch ms of the last prompt, else of the creation; 0 when unparsable. Shown as the item's time. */
  at: number;
}

/** By the last prompt when there is one, else by creation. */
export function recencyOf(item: { lastPromptAt?: string; createdAt: string }): Recency {
  return item.lastPromptAt === undefined
    ? { prompted: false, at: epochMs(item.createdAt) }
    : { prompted: true, at: epochMs(item.lastPromptAt) };
}

/** Prompted first, newest prompt first; then the rest, newest created first. */
export function compareRecency(a: Recency, b: Recency): number {
  return Number(b.prompted) - Number(a.prompted) || b.at - a.at;
}

function epochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
