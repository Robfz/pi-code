import type { SequencedEvent } from "@pi-code/protocol";
import type { Context } from "hono";
import type { EventLog } from "../agents/event-log.ts";
import { queuedSse, type SseOptions } from "./stream.ts";

/** Where a stream starts: `Last-Event-ID` (EventSource reconnects) wins over `?since=`. */
function resumePoint(c: Context): string | undefined {
  const header = c.req.header("last-event-id");
  if (header !== undefined && header.trim() !== "") return header.trim();
  const query = c.req.query("since");
  return query !== undefined && query.trim() !== "" ? query.trim() : undefined;
}

const frame = ({ seq, event }: SequencedEvent) => `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * `GET /api/agents/:id/events`: replays the log after the resume point (or `resync` when it
 * can't), then streams live events. Without a resume point, only new events are sent.
 */
export function eventStream(c: Context, log: EventLog, opts: SseOptions = {}): Response {
  const resume = resumePoint(c);
  return queuedSse(c, opts, (sink) => {
    // Replay and subscription happen in one synchronous block: publishing is synchronous too,
    // so no event can fall between them.
    const backlog = resume === undefined ? [] : log.since(Number(resume));
    const initial =
      backlog === undefined
        ? [`data: ${JSON.stringify({ type: "resync" })}\n\n`]
        : backlog.map(frame);
    const unsubscribe = log.subscribe(
      (e) => sink.send(frame(e)),
      () => sink.end(),
    );
    if (log.closed) sink.end();
    return { initial, unsubscribe };
  });
}
