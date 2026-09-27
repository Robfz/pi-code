import type { SequencedEvent } from "@pi-code/protocol";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventLog } from "../agents/event-log.ts";

export interface SseOptions {
  /**
   * Interval of `ping` events (named, no `id:`, not logged), so clients can detect a dead
   * stream. Default 15 s.
   */
  pingMs?: number;
  /** Reconnection delay advertised to `EventSource`. Default 2 s. */
  retryMs?: number;
  /** A subscriber this far behind is disconnected (it reconnects and replays or resyncs). */
  maxBacklog?: number;
}

/** Where a stream starts: `Last-Event-ID` (EventSource reconnects) wins over `?since=`. */
function resumePoint(c: Context): string | undefined {
  const header = c.req.header("last-event-id");
  if (header !== undefined && header.trim() !== "") return header.trim();
  const query = c.req.query("since");
  return query !== undefined && query.trim() !== "" ? query.trim() : undefined;
}

/**
 * `GET /api/agents/:id/events`: replays the log after the resume point (or `resync` when it
 * can't), then streams live events. Without a resume point, only new events are sent.
 */
export function eventStream(c: Context, log: EventLog, opts: SseOptions = {}): Response {
  const pingMs = opts.pingMs ?? 15_000;
  const retryMs = opts.retryMs ?? 2_000;
  const maxBacklog = opts.maxBacklog ?? 20_000;
  const resume = resumePoint(c);

  return streamSSE(c, async (stream) => {
    const pending: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false; // client gone, or too far behind: end now
    let ending = false; // agent removed: flush, then end
    let pingDue = false;
    const notify = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const frame = ({ seq, event }: SequencedEvent) =>
      `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;

    // Replay and subscription happen in one synchronous block: publishing is synchronous too,
    // so no event can fall between them.
    const backlog = resume === undefined ? [] : log.since(Number(resume));
    if (backlog === undefined) pending.push(`data: ${JSON.stringify({ type: "resync" })}\n\n`);
    else for (const e of backlog) pending.push(frame(e));
    const unsubscribe = log.subscribe(
      (e) => {
        if (pending.length >= maxBacklog) stop = true;
        else pending.push(frame(e));
        notify();
      },
      () => {
        ending = true;
        notify();
      },
    );
    ending = log.closed;
    const abort = () => {
      stop = true;
      notify();
    };
    stream.onAbort(abort);
    c.req.raw.signal.addEventListener("abort", abort, { once: true });
    const ping = setInterval(() => {
      pingDue = true;
      notify();
    }, pingMs);

    try {
      await stream.write(`retry: ${retryMs}\n\n`);
      while (!stop && !stream.aborted) {
        if (pending.length > 0) {
          await stream.write(pending.splice(0, pending.length).join(""));
        } else if (ending) {
          break;
        } else if (pingDue) {
          pingDue = false;
          await stream.write("event: ping\ndata: {}\n\n");
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      clearInterval(ping);
      unsubscribe();
    }
  });
}
